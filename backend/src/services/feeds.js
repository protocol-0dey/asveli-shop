'use strict';
// Product feeds for sales channels that import a catalogue by URL: Google Merchant Center (also used by Meta Commerce, Pinterest,
// TikTok catalog, Bing), Ceneo (PL price comparison) and a plain CSV. Only products that are on sale (approved, seller active,
// price > 0) appear; stock decides "in stock". The URL carries a secret token so the feed can be rotated if it leaks.
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');
const cfg = require('../config');
const { modelSlugOf, parseImages } = require('../store/catalog');

const KEY = 'feeds.config';
const stored = () => { try { return { token: null, link_base: '', brand_default: '', ...JSON.parse(getSetting(KEY) || '{}') }; } catch { return { token: null, link_base: '', brand_default: '' }; } };
function rotate() { const c = stored(); c.token = crypto.randomBytes(18).toString('base64url'); setSetting(KEY, JSON.stringify(c)); return c; }
function save(b) {
  const c = stored();
  if (b.link_base !== undefined) { const v = String(b.link_base).trim().replace(/\/+$/, ''); if (v && !/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/.test(v)) throw Object.assign(new Error('invalid_link_base'), { code: 'invalid_link_base' }); c.link_base = v; }
  if (b.brand_default !== undefined) c.brand_default = String(b.brand_default).slice(0, 60);
  if (!c.token) c.token = crypto.randomBytes(18).toString('base64url');
  setSetting(KEY, JSON.stringify(c)); return c;
}
const okToken = t => { const c = stored(); return !!c.token && typeof t === 'string' && t.length === c.token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(c.token)); };

function items() {
  const c = stored(), base = c.link_base || cfg.storeOrigins.find(o => o.startsWith('https://')) || cfg.storeOrigins[0] || cfg.baseUrl;
  return db.prepare(`SELECT p.*, s.name seller_name, COALESCE((SELECT SUM(st.qty - st.reserved) FROM m_stock st JOIN m_warehouses w ON w.id=st.warehouse_id WHERE st.product_id=p.id AND w.active=1),0) free
    FROM m_products p JOIN m_sellers s ON s.id=p.seller_id WHERE p.status='approved' AND s.status='active' AND p.price>0 ORDER BY p.id`).all().map(p => ({
    id: p.sku, title: p.title, description: (p.seo_description || p.description || p.title).slice(0, 5000), link: `${base}/p/${encodeURIComponent(modelSlugOf(p))}`,
    images: parseImages(p.images), price: p.price, brand: p.brand || c.brand_default || p.seller_name, gtin: p.barcode || null, category: p.category, in_stock: p.digital ? true : p.free > 0, weight_g: p.weight_g, qty: p.free
  }));
}
const x = s => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = c => (c / 100).toFixed(2);
function google() {
  const list = items();
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>Asveli</title><link>${x(stored().link_base || cfg.baseUrl)}</link><description>Asveli product feed</description>\n` +
    list.map(i => `<item><g:id>${x(i.id)}</g:id><title>${x(i.title.slice(0, 150))}</title><description>${x(i.description)}</description><link>${x(i.link)}</link>` +
      (i.images[0] ? `<g:image_link>${x(i.images[0])}</g:image_link>` : '') + i.images.slice(1, 10).map(u => `<g:additional_image_link>${x(u)}</g:additional_image_link>`).join('') +
      `<g:availability>${i.in_stock ? 'in_stock' : 'out_of_stock'}</g:availability><g:price>${money(i.price)} ${cfg.currency}</g:price><g:condition>new</g:condition>` +
      (i.brand ? `<g:brand>${x(i.brand)}</g:brand>` : '') + (i.gtin ? `<g:gtin>${x(i.gtin)}</g:gtin>` : '<g:identifier_exists>no</g:identifier_exists>') +
      (i.category ? `<g:product_type>${x(i.category)}</g:product_type>` : '') + (i.weight_g ? `<g:shipping_weight>${i.weight_g} g</g:shipping_weight>` : '') + '</item>').join('\n') + '\n</channel></rss>\n';
}
function ceneo() {
  const list = items();
  return `<?xml version="1.0" encoding="UTF-8"?>\n<offers xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="1"><group name="other">\n` +
    list.map(i => `<o id="${x(i.id)}" url="${x(i.link)}" price="${money(i.price)}" avail="${i.in_stock ? 1 : 99}" stock="${Math.max(0, i.qty)}"${i.weight_g ? ` weight="${(i.weight_g / 1000).toFixed(3)}"` : ''}>` +
      `<cat><![CDATA[${String(i.category || '').replace(/]]>/g, '')}]]></cat><name><![CDATA[${i.title.replace(/]]>/g, '')}]]></name>` +
      (i.images[0] ? `<imgs><main url="${x(i.images[0])}"/>${i.images.slice(1, 10).map(u => `<i url="${x(u)}"/>`).join('')}</imgs>` : '') +
      `<desc><![CDATA[${i.description.replace(/]]>/g, '')}]]></desc><attrs>${i.brand ? `<a name="Producent"><![CDATA[${i.brand.replace(/]]>/g, '')}]]></a>` : ''}${i.gtin ? `<a name="EAN"><![CDATA[${i.gtin}]]></a>` : ''}</attrs></o>`).join('\n') + '\n</group></offers>\n';
}
function csv() {
  const q = v => { const s = String(v ?? ''); return /[",\n;]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };   // also defuses spreadsheet formulas
  return ['id,title,description,link,image_link,price,currency,availability,brand,gtin,category', ...items().map(i => [i.id, i.title, i.description.replace(/\s+/g, ' ').slice(0, 1000), i.link, i.images[0] || '', money(i.price), cfg.currency, i.in_stock ? 'in stock' : 'out of stock', i.brand || '', i.gtin || '', i.category || ''].map(q).join(','))].join('\n') + '\n';
}
function view() { const c = stored(); return { token: c.token, link_base: c.link_base, brand_default: c.brand_default, count: items().length, public_base: cfg.baseUrl, currency: cfg.currency }; }
module.exports = { google, ceneo, csv, okToken, view, save, rotate };
