#!/usr/bin/env sh
# Asveli: локальная админка на этом компьютере (Linux / macOS). Нужен Node.js 20.6+.
cd "$(dirname "$0")/backend" && exec node scripts/local.js
