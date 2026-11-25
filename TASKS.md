# TASKS — shared task board (Claude ⇄ Argon ⇄ owner)

Rules: one line per task. Change status, do not delete lines. Put your name in [ ].
Status: TODO · DOING · DONE · BLOCKED (with reason). Newest at the top of each section.

## Argon (server 3.125.234.105, sales & catalogue)
- TODO [Argon] Install this repo on the server (see HANDOFF.md, part 2), run `npm test` in backend, start the admin.
- TODO [Argon] Owner creates the `Argon` API key (role sales_manager); you import products (ARGON.md → Import).
- TODO [Argon] Run autocat dry → apply; report how many products have no category.
- TODO [Argon] `check_all_cards`, then fix the worst cards (`sales_cards_to_fix`). No invented facts.
- TODO [Argon] After the owner connects Shopify: `POST /shopify/sync`.

## Claude (Shopify theme, collections, menus, platform code)
- BLOCKED [Claude] Pack + single-unit ("1 szt.") pricing in the admin — needs owner's parcel cost and minimum profit.
- TODO [Claude] Push legal texts into Shopify policies — after the owner fills in company data.
- DONE [Claude] B2B page /pages/dla-firm, collections packaging/warehouse/bhp/cleaning/office/horeca, menus.
- DONE [Claude] v17: sales department, sub-agents, owner-away mode, free delivery, Shopify CSV import, category tags sync.

## Owner (decisions only the owner makes)
- TODO [Owner] Publish the Shopify theme "Asveli"? (Claude never publishes without your yes.)
- TODO [Owner] Keep Express 65 zł or drop it?
- TODO [Owner] Who pays return shipping?
- TODO [Owner] Confirm B2B promises: repeat orders, answer within 1 business day.
- TODO [Owner] Parcel cost (zł) and minimum profit per item → for "1 szt." pricing.
