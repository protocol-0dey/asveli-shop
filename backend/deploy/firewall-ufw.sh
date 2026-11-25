#!/usr/bin/env bash
# Host firewall for the Asveli server: only SSH, HTTP and HTTPS are reachable from the internet.
# Ports 3000/3001 are published on 127.0.0.1 only (docker-compose.yml) and are additionally blocked here.
#
#   sudo SSH_PORT=22 ./firewall-ufw.sh
#
# SAFETY: SSH is allowed BEFORE the firewall is switched on, so you cannot lock yourself out as long as SSH_PORT
# is the port you really use. Check with:  sudo ss -tlnp | grep sshd
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }
command -v ufw >/dev/null || { echo "ufw not installed: apt install ufw"; exit 1; }
SSH_PORT="${SSH_PORT:-22}"

ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw limit "${SSH_PORT}/tcp" comment 'ssh (rate limited)'
ufw allow 80/tcp  comment 'http (certbot + redirect)'
ufw allow 443/tcp comment 'https'
ufw deny 3000/tcp comment 'app public port: nginx only, via loopback'
ufw deny 3001/tcp comment 'admin panel: ssh tunnel only'
ufw --force enable
ufw status verbose

cat <<'MSG'

NOTE (Docker): published container ports go around ufw rules. That is why docker-compose.yml publishes them as
"127.0.0.1:PORT:PORT". Never change that to "PORT:PORT" or "0.0.0.0:PORT:PORT".
Verify from ANOTHER machine:   nmap -Pn -p 22,80,443,3000,3001 <server-ip>
Expected: only 22, 80 and 443 open.
MSG
