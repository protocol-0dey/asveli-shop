#!/usr/bin/env python3
"""termux-mcp — a tiny MCP server (Streamable HTTP, JSON responses) that lets Claude run shell commands in Termux.

Start:   python termux-mcp.py            (listens on 127.0.0.1:8765, prints the secret path)
Tunnel:  cloudflared tunnel --url http://127.0.0.1:8765
Connector URL for Claude:  https://<name>.trycloudflare.com/<secret>/mcp

Safety
  * Anyone who knows the full URL can run commands on this phone. The secret part is 43 random characters,
    kept in ~/.termux-mcp-secret. New secret: delete that file and restart.
  * It listens only on 127.0.0.1; the only way in is the tunnel you start yourself. Stop both with Ctrl+C when done.
  * Every command is written to ~/termux-mcp.log with its time.
  * Each command has a time limit (default 120 s, max 900 s) and its output is cut at 60 000 characters.
Only the Python standard library is used.
"""
import json, os, secrets, subprocess, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", int(os.environ.get("TERMUX_MCP_PORT", "8765"))
HOME = os.path.expanduser("~")
SECRET_FILE = os.path.join(HOME, ".termux-mcp-secret")
LOG_FILE = os.path.join(HOME, "termux-mcp.log")
MAX_OUT = 60_000
PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")


def secret():
    if os.path.exists(SECRET_FILE):
        return open(SECRET_FILE).read().strip()
    s = secrets.token_urlsafe(32)
    with open(SECRET_FILE, "w") as f:
        f.write(s)
    os.chmod(SECRET_FILE, 0o600)
    return s


SECRET = secret()


def log(line):
    with open(LOG_FILE, "a") as f:
        f.write(time.strftime("%F %T ") + line.replace("\n", "\\n")[:2000] + "\n")


def cut(s):
    return s if len(s) <= MAX_OUT else s[: MAX_OUT // 2] + f"\n…[{len(s) - MAX_OUT} characters cut]…\n" + s[-MAX_OUT // 2 :]


def run(args):
    cmd = str(args.get("command", "")).strip()
    if not cmd:
        raise ValueError("command is empty")
    timeout = max(1, min(int(args.get("timeout", 120)), 900))
    cwd = os.path.expanduser(str(args.get("cwd") or "~"))
    log(f"run cwd={cwd} timeout={timeout}: {cmd}")
    try:
        p = subprocess.run(["bash", "-lc", cmd], cwd=cwd, capture_output=True, text=True, timeout=timeout,
                           stdin=subprocess.DEVNULL, errors="replace")
        out = f"exit code: {p.returncode}\n--- stdout ---\n{cut(p.stdout)}"
        if p.stderr:
            out += f"\n--- stderr ---\n{cut(p.stderr)}"
        return out, p.returncode != 0
    except subprocess.TimeoutExpired as e:
        so = e.stdout.decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return f"stopped after {timeout} s (time limit). For long jobs use tmux on the server.\n--- stdout so far ---\n{cut(so)}", True


def read_file(args):
    path = os.path.expanduser(str(args.get("path", "")))
    log(f"read {path}")
    with open(path, "r", errors="replace") as f:
        return cut(f.read()), False


def write_file(args):
    path = os.path.expanduser(str(args.get("path", "")))
    content = str(args.get("content", ""))
    log(f"write {path} ({len(content)} chars)")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        f.write(content)
    if args.get("executable"):
        os.chmod(path, 0o755)
    return f"written {len(content)} characters to {path}", False


TOOLS = {
    "run": (run, "Run a bash command in Termux on the owner's phone and return exit code, stdout and stderr. "
                 "Non-interactive: no password prompts (use SSH keys). For jobs longer than a few minutes start them in tmux.",
            {"type": "object", "properties": {
                "command": {"type": "string", "description": "bash command line"},
                "cwd": {"type": "string", "description": "working folder, default ~"},
                "timeout": {"type": "integer", "description": "seconds, 1–900, default 120"}},
             "required": ["command"]}),
    "read_file": (read_file, "Read a text file on the phone (Termux paths, ~ allowed).",
                  {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
    "write_file": (write_file, "Write a text file on the phone (creates folders). Set executable for scripts.",
                   {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"},
                                                     "executable": {"type": "boolean"}}, "required": ["path", "content"]}),
}


def handle(msg):
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if mid is None:                                   # notification: nothing to answer
        return None
    if method == "initialize":
        want = params.get("protocolVersion")
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": want if want in PROTOCOLS else PROTOCOLS[0],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "termux-mcp", "version": "1.0"},
            "instructions": "Shell on the owner's Android phone (Termux). Use it to reach the owner's servers over SSH. "
                            "Never print or store passwords, tokens or keys."}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": [
            {"name": n, "description": d, "inputSchema": s} for n, (_, d, s) in TOOLS.items()]}}
    if method == "tools/call":
        name = params.get("name")
        if name not in TOOLS:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"unknown tool {name}"}}
        try:
            text, is_err = TOOLS[name][0](params.get("arguments") or {})
        except Exception as e:                        # tool errors go back to the model as a result, not a protocol error
            text, is_err = f"error: {e}", True
        return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}], "isError": is_err}}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}}


class H(BaseHTTPRequestHandler):
    server_version = "termux-mcp"

    def log_message(self, *a):
        pass

    def _send(self, code, body=None, ctype="application/json"):
        data = b"" if body is None else (json.dumps(body) if not isinstance(body, (bytes, str)) else body)
        data = data.encode() if isinstance(data, str) else data
        self.send_response(code)
        if data:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if data:
            self.wfile.write(data)

    def _ok_path(self):
        return self.path.split("?")[0].rstrip("/") == f"/{SECRET}/mcp"

    def do_GET(self):                                 # no server-initiated stream
        self._send(405 if self._ok_path() else 404)

    def do_DELETE(self):
        self._send(200 if self._ok_path() else 404)

    def do_POST(self):
        if not self._ok_path():
            log(f"refused {self.client_address[0]} wrong path")
            return self._send(404)
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n > 2_000_000:
                return self._send(413)
            msg = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
        if isinstance(msg, list):
            out = [r for r in (handle(m) for m in msg) if r]
            return self._send(200, out) if out else self._send(202)
        r = handle(msg)
        return self._send(200, r) if r else self._send(202)


if __name__ == "__main__":
    print(f"termux-mcp on http://{HOST}:{PORT}")
    print(f"secret path: /{SECRET}/mcp")
    print("Now, in a second Termux session:  cloudflared tunnel --url http://127.0.0.1:%d" % PORT)
    print("Connector URL = the https://….trycloudflare.com address it prints + /%s/mcp" % SECRET)
    print("Stop with Ctrl+C. Log: " + LOG_FILE)
    sys.stdout.flush()
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
