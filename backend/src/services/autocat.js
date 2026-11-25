'use strict';
/* AI placement of the catalogue into the category tree. Products whose category was never chosen by a person are sent in small batches
   (title + brand only: no prices, no seller data) to the AI provider configured in the admin; the answer is a node slug per product,
   validated against the live tree. Only ordinary shop nodes are allowed: the AI never puts a product into a licence-only or contact-only
   category (that would hide it from the cart) — those stay a person's choice. In mock mode (no provider) the title-keyword rules answer. */
const { db } = require('../db');
const cats = require('./categories');
const ai = require('./ai');

const BATCH = 40;
function targets() {
  const t = cats.tree(), out = [];
  for (const n of t.byId.values()) {
    const e = cats.effective(n.id); if (e.kind !== 'shop' || e.restricted !== 'none') continue;
    out.push({ slug: n.slug, path: cats.path(n.id, 'en').map(x => x.name).join(' > '), leaf: !n.children.length });
  }
  return out;
}
const SYSTEM = list => `You file marketplace products into a category tree. For every product return the single most specific category slug from the list, `
  + `or null if none fits. Prefer leaf categories. Judge by what the product IS, not by words like "B2B", "wholesale" or "pack". `
  + `Answer JSON only: {"items":[{"id":<product id>,"slug":"<slug>"|null}]}.\nCategories (slug: path):\n${list.map(c => `${c.slug}: ${c.path}`).join('\n')}`;

// products nobody placed by hand; `all` also re-checks earlier AI answers (after the tree changed)
const pending = (limit, all) => db.prepare(`SELECT id, title, brand FROM m_products WHERE ${all ? "(category_id IS NULL OR category_source='ai')" : 'category_id IS NULL'} ORDER BY id LIMIT ?`).all(limit);

async function classify(rows, list) {
  const allowed = new Set(list.map(c => c.slug));
  const mock = () => ({ items: rows.map(r => { const id = cats.place({ title: r.title }); return { id: r.id, slug: id ? cats.tree().byId.get(id).slug : null }; }) });
  const user = JSON.stringify({ products: rows.map(r => ({ id: r.id, title: String(r.title).slice(0, 200), brand: r.brand || undefined })) });
  const out = await ai.json('categorize', SYSTEM(list), user, mock);
  const items = Array.isArray(out?.items) ? out.items : [];
  const ids = new Set(rows.map(r => r.id)), res = new Map();
  for (const x of items) { const id = Number(x?.id); if (ids.has(id) && typeof x.slug === 'string' && allowed.has(x.slug)) res.set(id, x.slug); }   // unknown ids and invented slugs are dropped
  return res;
}

async function run({ limit = 400, all = false, dry = false } = {}) {
  limit = Math.max(1, Math.min(Number(limit) || 400, 5000));
  const list = targets(), rows = pending(limit, !!all), t = cats.tree();
  const upd = db.prepare("UPDATE m_products SET category_id=?, category_source='ai', updated_at=? WHERE id=? AND (category_id IS NULL OR category_source='ai')");
  let placed = 0, failed = 0; const sample = [], by = {};
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    let res; try { res = await classify(chunk, list); } catch (e) { if (e.status === 429) break; failed += chunk.length; continue; }   // quota: stop; provider error: skip the batch, keep going
    for (const r of chunk) {
      const slug = res.get(r.id); if (!slug) continue;
      placed++; by[slug] = (by[slug] || 0) + 1;
      if (sample.length < 15) sample.push({ id: r.id, title: r.title, slug });
      if (!dry) upd.run(t.bySlug.get(slug).id, Date.now(), r.id);
    }
  }
  if (!dry && placed) try { require('../store/catalog').invalidate(); } catch { /* storefront not loaded */ }
  return { checked: rows.length, placed, unplaced: rows.length - placed - failed, failed, dry: !!dry, mock: ai.isMock(), by, sample,
    left: db.prepare('SELECT COUNT(*) n FROM m_products WHERE category_id IS NULL').get().n };
}

module.exports = { run, targets, classify };
