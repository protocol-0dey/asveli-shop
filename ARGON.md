# ASVELI — guide for the AI manager (Argon in Antigravity)

This is how you work with the ASVELI admin: import products, check them, put them in categories and send them to Shopify.
The owner sets it up once (part 1). After that you work only through MCP (part 2).

## 1. Set-up (owner, once, about 10 minutes)

1. Start the admin on the computer where Antigravity runs:
   - Windows: double-click `start-local.bat` in the project folder.
   - macOS / Linux: run `./start-local.sh`.
   It needs Node.js 20.6 or newer. The first start installs everything, makes `backend/.env.local` with new secrets, asks for the owner login and opens http://localhost:3001/admin/.
2. In the admin, open **Интеграции → API и AI-агенты** and create a key:
   - name: `Argon`
   - role: `sales_manager` (sales & marketing department: products, cards, categories, prices, stock, coupons, campaigns, SEO, analytics; no money out, no staff, no secrets)
   - days: 90
   Copy the key (`asv_…`). It is shown only once.
3. Paste the key into the Antigravity MCP settings (`mcp_config.json`). The owner pastes it, not the agent:

```json
{
  "mcpServers": {
    "asveli": {
      "serverUrl": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer asv_PASTE_THE_KEY_HERE" }
    }
  }
}
```

   If your Antigravity version uses `url` instead of `serverUrl`, use `url`.
4. Optional, for AI checks and AI categories: **Интеграции → Подключения AI** → choose a provider → paste its key → **Проверить подключение**.
5. Optional, to send products to Shopify: **Интеграции → Shopify** → Client ID and Client secret of the store app (see `backend/README.md`, section 6).

The admin must be running while you work. If MCP does not answer, start it again (step 1).

## 2. Tools you have (MCP server `asveli`)

| Tool | Use it for |
|---|---|
| `shop_overview` | Start here: counts of products, orders, queues |
| `list_records`, `get_record` | Read products (`products`), categories (`categories`), sellers (`sellers`) and other lists |
| `create_record`, `update_record`, `record_action` | Make or change one record; run an action such as `submit` (send for moderation) |
| `check_all_cards` | AI check of product cards that wait for checking |
| `admin_api` | Any other admin call: method + path after `/api/admin` |

## 3. Tasks

### Import products from a Shopify CSV

The import reads a Shopify product export as it is (Handle, Title, Body (HTML), Vendor, Type, Tags, Variant SKU, Variant Grams, Variant Price, Variant Barcode, Image Src).
It also reads a simple CSV with the columns `sku,title,category,price` (and optional `brand,description,barcode,weight_g,images`).

1. Find the seller id: `list_records` with resource `sellers`.
2. Send the CSV in parts. One call takes at most 500 products and at most 1 MB of text:

```
admin_api  method: POST  path: /ai/import
body: { "seller_id": 1, "csv": "<the CSV text>" }
```

3. Read the answer: `imported`, `failed` and `errors` (row number and reason). A SKU that already exists is refused. Do not send the same part again.

Category: a tag `cat-<slug>` (for example `cat-packaging-film`) puts the product in that category. Without a tag the title decides.

### Put products into categories

- Check first, without saving: `admin_api POST /catalog/autocat` with body `{ "dry": true, "limit": 400 }`.
- Then save: the same call with `{ "limit": 400 }`. Repeat until `left` stops falling.
- A category that a person chose is never changed. Products that fit nowhere stay without a category. Do not guess for them.

### Check products

- `check_all_cards` checks cards that wait for a check.
- Before a product can be sold it needs: a real title and description, a price, photos, the manufacturer, and for the EU the responsible person and safety information. `record_action` with resource `products`, the product id and action `readiness` shows what is missing for each region.
- Do not invent facts, certificates, reviews or "verified" labels. If a fact is not in the source, leave it out.

Approving a product for sale is a moderator's job (the owner or a moderator), not yours: your key cannot approve. Send the product with `submit` and tell the owner.

### Send products to Shopify

After the owner connects Shopify (part 1, step 5): `admin_api POST /shopify/sync`. Only approved and checked products go to Shopify as Active.

### Sales & marketing department (your daily work)

Start every session with `sales_whoami`: it says your mode and your limits. Then:

| Tool | What for |
|---|---|
| `sales_dashboard` | Revenue and orders for 1/7/30 days, top products, card quality, stock, queues |
| `sales_cards_to_fix` | Worst cards first (score 0–100 and the list of problems). Fix with `update_record` (title, description, seo_description, images, category_id) or rewrite with `record_action` `ai_generate` |
| `sales_price_plan` | Prices: `rule: competitor` (just under the cheapest checked competitor) or `rule: percent`. Shows the plan first; `apply: true` applies it |
| `sales_stock` | What has run out but sells, what runs out soon, what does not sell |
| `sales_promo_ideas` | Slow movers (markdown, bundle, ads) and best sellers (push with ads). Coupons: `create_record` `coupons` (percent in basis points: 1000 = 10 %) |

Limits for you, checked by the server in every mode:
- never a price below the purchase price (cost) or the minimum price;
- at most the owner's limit per price change (default 15 %);
- coupons at most the owner's discount limit (default 30 %);
- a discount is shown only from a real earlier price (the lowest price of the last 30 days, the Omnibus rule).

### Sub-agents (your own helpers)

You can make helpers for narrow jobs, each with its own key, role and written brief:

| Role | Job |
|---|---|
| `copywriter` | rewrite titles, descriptions, SEO of cards |
| `pricing_analyst` | look at prices and competitors, changes nothing |
| `content_checker` | check cards before sale |
| `ads_manager` | campaigns, coupons, banners, A/B tests |
| `stock_keeper` | stock and deliveries in |
| `marketing`, `analyst`, `catalog_manager` | wider jobs inside your own rights |

1. `agents_list` shows which roles you can give (never wider than your own).
2. `agents_create` with `name`, `role`, `brief` (what to do, what not to do, how to judge good work; at least 20 characters), `days` (1–90).
3. The answer has the key once. Put it only into the helper's MCP settings in Antigravity. Never in chat, files or commits.
4. The helper calls `agent_brief` first and works only inside its brief.
5. `agents_revoke` switches a helper off. At most 10 active helpers. Helpers cannot make helpers.
   If the owner revokes your key, all your helpers stop too. The owner sees every helper and its brief.

### When the owner is away

The owner can press **«Передать управление»** in the admin (Отдел продаж) for a set time. Until it ends, `sales_whoami` says `owner_away: true` and your key also may:
approve products, moderate reviews, handle orders, shipments and returns of goods, answer customer tickets.
Never, also in this mode: returning money, payouts, staff, keys, security settings, KYC decisions. Leave those for the owner with a short note.
Everything you do is in the owner's report. You cannot switch this mode on or off yourself.

## 4. Store rules (decided by the owner)

- **Delivery is free on every order, even one item, with no minimum.** Never write "free from … zł". (Shopify: rate 0 zł; admin: setting `store.free_shipping`, on by default.)
- Launch niche: supplies for companies (packaging, warehouse, workwear/BHP, cleaning, office, HoReCa). Car classifieds, alcohol and hotels are switched off for now.
- No claims that cannot be proven (Polish consumer law, UOKiK): no fake discounts, no fake counters, no "verified" without a check.
- Do not publish the Shopify theme without the owner's yes.
- Never put keys, passwords or customer data in chat, files or commits.

## 5. Who does what

To avoid two agents changing the same thing:
- **Argon:** sales and marketing: products, cards, prices, stock, promotions, product checks, import; the whole store while the owner is away.
- **Claude:** Shopify theme, collections and menus, the asveli-shop platform code.

Before you change a theme, a menu or a collection, ask the owner.
