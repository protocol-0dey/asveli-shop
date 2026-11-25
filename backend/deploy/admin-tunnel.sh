#!/usr/bin/env bash
# Opens the Asveli admin panel on YOUR computer through an encrypted SSH tunnel.
# The panel itself is not reachable from the internet; this is the only way in.
#
#   ./admin-tunnel.sh user@your-server            # then open http://localhost:3001/admin/
#   ./admin-tunnel.sh user@your-server 8443       # use another local port: http://localhost:8443/admin/
#
# Press Ctrl+C to close the tunnel (the panel is unreachable again).
set -euo pipefail

target="${1:?usage: $0 user@server [local-port]}"
local_port="${2:-3001}"
remote_port=3001

echo "Admin panel → http://localhost:${local_port}/admin/   (Ctrl+C to close)"
# -N: no remote command · ExitOnForwardFailure: fail loudly if the port is taken
# The local side is bound to 127.0.0.1 so nobody else on your network can use your tunnel.
exec ssh -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -L "127.0.0.1:${local_port}:127.0.0.1:${remote_port}" \
  "$target"
