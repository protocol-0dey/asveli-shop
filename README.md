# ASVELI

| Folder | What | Tests |
|---|---|---|
| `backend/` | Node/Express API, **two-way Shopify product sync** (Интеграции → Shopify), operator console (admin, loopback + SSH tunnel only), multi-tenancy, AI layer with direct Gemini/OpenAI/Ollama providers (key and models are set in the admin, no code edits) | `cd backend && npm test` (102) |
| `storefront/` | React/TS shop + Seller Central | `cd storefront && npm run check` (types, i18n, 26 unit) · `npm run test:e2e` (Playwright, real backend, desktop + mobile) |
| `.github/` | CI (all of the above + Docker smoke + secret scan) and tag-triggered deploy with health-check rollback | `actionlint` clean |

Deploy secrets expected by `deploy.yml` (GitHub environment `production`): `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` (output of `ssh-keyscan`, so the host key is pinned). Optional variable `API_URL`. On the server: `/opt/asveli` with `docker-compose.yml` and `.env`; the storefront goes to `/var/www/asveli`.

## AI: connect in two minutes
Admin (SSH tunnel) → **Интеграции → Подключения AI** (owner only) → choose **Google Gemini** → paste the key from aistudio.google.com/apikey → **Сохранить** → **Проверить подключение**. Applies immediately, no restart. One request sends the product photo and its data and returns the card JSON (title, SEO text, bullets, keywords, facts with sources); the same key powers semantic search and Canvas images. Every card still goes through human verification before it can be sold.

## Admin on your own computer
AI agents (Argon in Antigravity and others): see `ARGON.md` — set-up, MCP tools, import, categories, checks, store rules.

Windows: double-click `start-local.bat`. macOS/Linux: `./start-local.sh`. Needs Node.js 20.6+. First run installs dependencies, creates `backend/.env.local` with fresh secrets, asks for the owner login and opens http://localhost:3001/admin/. Then **Интеграции → Shopify** connects the store (see `backend/README.md`, section 6).
