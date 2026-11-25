# HANDOFF — how Claude and Argon work together

## 1. The idea
- This repository is the single source of the asveli-shop code (backend admin + storefront).
- **Claude** writes platform code, the Shopify theme, collections and menus. Claude pushes to branches `claude/*` and merges to `main` after tests pass.
- **Argon** runs the server 3.125.234.105, works with products through MCP (see ARGON.md) and pulls `main` to deploy.
- Code changes from Argon go to a branch `argon/<short-name>` with a pull request. Claude reviews and merges.
- Tasks and decisions live in `TASKS.md`. Each agent writes a short entry in the log below at the end of a session.
- Never commit keys, passwords, `.env*`, databases (`data/`, `*.db`) or customer data.

## 2. Argon: first set-up on the server (once)
The owner adds the access, not the agent:
1. On the server, as user `admin`: `ssh-keygen -t ed25519 -f ~/.ssh/asveli_deploy -N ""` and show the owner `~/.ssh/asveli_deploy.pub`.
2. The owner: GitHub → asveli-shop → Settings → Deploy keys → Add key → paste it → tick **Allow write access** (so Argon can push `argon/*` branches).
3. On the server:
```bash
cat >> ~/.ssh/config <<'CFG'
Host github-asveli
  HostName github.com
  User git
  IdentityFile ~/.ssh/asveli_deploy
CFG
cd ~ && git clone git@github-asveli:protocol-0dey/asveli-shop.git
cd asveli-shop/backend && npm ci && npm test
```
4. Keep the running admin's `backend/.env.local` and `backend/data/` where they are now. If the admin already runs from another folder, copy those two into `~/asveli-shop/backend/` (do not commit them; `.gitignore` blocks them).

## 3. Argon: every update
```bash
cd ~/asveli-shop && git pull --ff-only
cd backend && npm ci && npm test && (restart the admin service the way it was started)
```
If tests fail: do not restart, write it in TASKS.md as BLOCKED and tell the owner.

## 4. Session log (newest first, 3–6 lines each)
### Claude — v17 upload
- Uploaded asveli-shop v17 (137 tests: 135 pass, 2 skipped).
- Shopify: B2B page /pages/dla-firm, 6 B2B collections, menus. Theme "Asveli" committed, NOT published.
- Waiting for the owner: parcel cost + minimum profit; Express 65 zł; return shipping.
