'use strict';
/* Trust & safety for a GLOBAL marketplace: who may sell, what may be sold, and where.
   One base check for every seller (KYB, modelled on the strictest rule we serve: EU DSA art. 30), then per-REGION product readiness:
   a listing is visible / buyable in a buyer's country only when the product carries what that region needs (manufacturer,
   responsible person / importer, safety info, own photos, brand proof). Regions are opened by staff, after a lawyer confirms local rules.
   Who is gated: sellers that signed up through Seller Central (origin = 'portal') always; the house catalogue (origin = 'admin') only when
   the owner switches "enforce for all" on — so the existing catalogue keeps working while it is being brought up to standard. */
const { db, getSetting, setSetting } = require('../db');
const pii = require('../iam/pii');

const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
// responsible: which product field names the local responsible person / importer (null = the region has no such field yet)
const REGIONS = {
  EU: { label: 'Европейский союз', countries: EU, responsible: 'responsible_eu', rule: 'GPSR + DSA' },
  UK: { label: 'Великобритания', countries: ['GB'], responsible: 'responsible_uk', rule: 'UK GPSR / PRaM Act 2025' },
  US: { label: 'США', countries: ['US'], responsible: 'responsible_us', rule: 'INFORM Consumers Act' },
  CH: { label: 'Швейцария', countries: ['CH'], responsible: null, rule: 'local' },
  NO: { label: 'Норвегия', countries: ['NO'], responsible: null, rule: 'local' },
  CA: { label: 'Канада', countries: ['CA'], responsible: null, rule: 'local' }
};
const regionOf = cc => { for (const [k, r] of Object.entries(REGIONS)) if (r.countries.includes(cc)) return k; return null; };
const parseList = s => String(s || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);

/* ---------- settings ---------- */
const DEFAULTS = { enforce_all: false, open_regions: ['EU'], recert_days: 365, grace_days: 10 };
const CFG = 'trust.config';
function config() { try { return { ...DEFAULTS, ...JSON.parse(getSetting(CFG) || '{}') }; } catch { return { ...DEFAULTS }; } }
function saveConfig(b) {
  const c = config();
  if (b.enforce_all !== undefined) c.enforce_all = !!b.enforce_all;
  if (b.open_regions !== undefined) {
    if (!Array.isArray(b.open_regions) || b.open_regions.some(r => !REGIONS[r])) throw Object.assign(new Error('invalid_open_regions'), { code: 'invalid_open_regions' });
    c.open_regions = [...new Set(b.open_regions)];
  }
  for (const [k, lo, hi] of [['recert_days', 30, 730], ['grace_days', 1, 60]]) if (b[k] !== undefined) {
    const n = Number(b[k]); if (!Number.isInteger(n) || n < lo || n > hi) throw Object.assign(new Error('invalid_' + k), { code: 'invalid_' + k }); c[k] = n;
  }
  setSetting(CFG, JSON.stringify(c)); return c;
}
const refreshStore = () => { try { require('../store/catalog').invalidate(); } catch { /* storefront not loaded */ } };   // offers change visibility at once
const enforced = seller => !!seller && (seller.origin === 'portal' || config().enforce_all);

/* ---------- seller (KYB) ---------- */
const KYB_FIELDS = ['legal_name', 'email', 'phone', 'address', 'tax_id', 'passport_no', 'bank_iban'];
function sellerKyb(s) {
  const missing = KYB_FIELDS.filter(k => !s[k]);
  if (!s.self_cert_at) missing.push('self_certification');
  const overdue = !!(s.recert_due_at && s.recert_due_at < Date.now());
  return { complete: !missing.length, missing, verified: s.kyc_status === 'approved' && !!s.kyb_verified_at, recert_due_at: s.recert_due_at || null, recert_overdue: overdue };
}
// DSA art. 30(7): name, address, trade register number and the self-certification are shown to buyers on the listing
function publicTrader(s) {
  const open = c => { if (!s[c]) return null; try { return pii.open(s[c], pii.aad('m_sellers', c, s.id)); } catch { return null; } };
  return { name: open('legal_name') || s.name, address: open('address'), country: s.country, registry: s.registry_name || null, registration_no: s.registration_no || null,
    vat_no: s.vat_no || null, self_certified: !!s.self_cert_at };
}

/* ---------- product ---------- */
// photos copied from other marketplaces: copyright problem + a sign the seller doesn't hold the goods
const FOREIGN_IMG = [/(^|\.)media-amazon\.com\//i, /(^|\.)ssl-images-amazon\.com\//i, /_AC_(S[LXY]|U[LXY])\d+/i, /(^|\.)alicdn\.com\//i, /(^|\.)kwcdn\.com\//i, /(^|\.)ebayimg\.com\//i, /(^|\.)temu\.com\//i];
function foreignImages(images) {
  let a = []; try { a = Array.isArray(images) ? images : JSON.parse(images || '[]'); } catch { a = []; }
  return a.filter(u => typeof u === 'string' && FOREIGN_IMG.some(re => re.test(u.replace(/^https?:\/\//, ''))));
}
function parseParty(s) { if (!s) return null; try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch { return null; } }
const partyOk = o => !!(o && typeof o.name === 'string' && o.name.trim() && typeof o.address === 'string' && o.address.trim() && typeof o.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email));
const ownBrand = (seller, brand) => !brand || parseList(seller.own_brands).includes(String(brand).trim().toUpperCase()) || String(brand).trim().toUpperCase() === String(seller.name || '').trim().toUpperCase();
const needsBrandProof = (p, seller) => !!p.brand && !ownBrand(seller, p.brand);

// per region: ok + what is missing. A region the seller is blocked in, or that is not opened yet, is never ok.
function productRegions(p, seller) {
  const cfg = config(), wanted = parseList(p.sale_regions).filter(r => REGIONS[r]);
  const common = [];
  if (!p.manufacturer_name) common.push('manufacturer_name');
  if (!p.manufacturer_address) common.push('manufacturer_address');
  if (!p.manufacturer_email) common.push('manufacturer_email');
  if (!p.barcode && !p.external_id) common.push('identifier');              // EAN/GTIN or the manufacturer's model/article number
  let imgs = []; try { imgs = JSON.parse(p.images || '[]'); } catch { imgs = []; }
  if (!Array.isArray(imgs) || !imgs.length) common.push('photo');
  if (foreignImages(p.images).length) common.push('foreign_photos');
  if (needsBrandProof(p, seller) && p.brand_proof_status !== 'verified') common.push(p.brand_proof ? 'brand_proof_unverified' : 'brand_proof');
  const blocked = parseList(seller.blocked_regions), out = {};
  for (const r of wanted) {
    const miss = [...common], R = REGIONS[r];
    if (!cfg.open_regions.includes(r)) miss.push('region_closed');
    if (blocked.includes(r)) miss.push('seller_blocked_in_region');
    // a responsible person / importer is needed when neither the manufacturer nor the seller is established in the region
    const local = R.countries.includes(String(p.manufacturer_country || '').toUpperCase()) || R.countries.includes(seller.country);
    if (R.responsible && !local && !partyOk(parseParty(p[R.responsible]))) miss.push(R.responsible);
    if (r === 'EU' && !p.safety_info && /zabawk|toy|игруш|dzieci|child|kid|elektr|electr|battery|bater|kosmet|cosmet|bhp|ochron/i.test(`${p.category} ${p.title}`)) miss.push('safety_info');
    out[r] = { ok: !miss.length, missing: miss };
  }
  return { regions: out, ready: Object.keys(out).filter(r => out[r].ok), requested: wanted, common };
}
// can THIS offer be sold to a buyer in `cc`? Ungated (house) sellers: yes, unless they chose regions and cc is outside them.
function canSell(p, seller, cc) {
  const r = regionOf(cc);
  if (!enforced(seller)) { const wanted = parseList(p.sale_regions); return !wanted.length || (r ? wanted.includes(r) : false); }
  if (!r) return false;                                                      // a country of no opened region: not sold there yet
  const st = productRegions(p, seller).regions[r];
  return !!(st && st.ok);
}

/* ---------- strikes: the sanctions ladder ---------- */
// 1 warning + listing removed · 2 no new listings for 30 days · 3 sales suspended in a region · 4 account blocked, payouts held
function strike({ sellerId, level, reason, region, productId, by }) {
  const now = Date.now(), s = db.prepare('SELECT * FROM m_sellers WHERE id=?').get(sellerId);
  if (!s) throw Object.assign(new Error('not_found'), { code: 'not_found' });
  db.prepare('INSERT INTO m_seller_strikes(seller_id,level,reason,region,product_id,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?)').run(sellerId, level, reason, region || null, productId || null, now, now, by || 'staff');
  const patch = { strikes: (s.strikes || 0) + 1 };
  if (productId && level >= 1) db.prepare("UPDATE m_products SET status='delisted', moderation_note=?, updated_at=? WHERE id=? AND seller_id=?").run(('strike: ' + reason).slice(0, 200), now, productId, sellerId);
  if (level === 2) patch.listing_ban_until = now + 30 * 864e5;
  if (level === 3) { if (!region || !REGIONS[region]) throw Object.assign(new Error('region_required'), { code: 'region_required' }); patch.blocked_regions = [...new Set([...parseList(s.blocked_regions), region])].join(','); }
  if (level === 4) {
    patch.status = 'suspended'; patch.payouts_hold = 1;
    db.prepare("UPDATE m_products SET status='delisted', updated_at=? WHERE seller_id=? AND status IN ('approved','pending_review')").run(now, sellerId);
  }
  const cols = Object.keys(patch);
  db.prepare(`UPDATE m_sellers SET ${cols.map(c => c + '=?').join(', ')}, updated_at=? WHERE id=?`).run(...cols.map(c => patch[c]), now, sellerId);
  refreshStore();
  return { level, ...patch };
}

/* ---------- yearly re-certification (DSA keeps data current; INFORM asks for it every year) ---------- */
function recertScan(t = Date.now()) {
  const c = config(); let warned = 0, suspended = 0;
  for (const s of db.prepare("SELECT * FROM m_sellers WHERE status='active' AND recert_due_at IS NOT NULL AND recert_due_at < ?").all(t)) {
    if (!enforced(s)) continue;
    if (s.recert_due_at + c.grace_days * 864e5 < t) {
      db.prepare("UPDATE m_sellers SET status='suspended', kyc_note=?, updated_at=? WHERE id=?").run('recertification overdue', t, s.id);
      db.prepare("UPDATE m_products SET status='delisted', updated_at=? WHERE seller_id=? AND status IN ('approved','pending_review')").run(t, s.id);
      suspended++;
    } else {
      const n = db.prepare("INSERT OR IGNORE INTO m_alerts(kind,severity,title,detail,status,dedupe,created_at,updated_at,created_by) VALUES('trust','medium',?,?,'open',?,?,?,'trust')")
        .run(`Продавец #${s.id}: просрочено ежегодное подтверждение данных`, `${c.grace_days} дн. до приостановки продаж`, 'recert:' + s.id + ':' + s.recert_due_at, t, t).changes;
      warned += n;
    }
  }
  if (suspended) refreshStore();
  return { warned, suspended };
}
let timer = null;
function start() { if (timer) return; timer = setInterval(() => { try { recertScan(); } catch (e) { console.error('trust scan:', e.message); } }, 6 * 3600e3); timer.unref(); }

module.exports = { REGIONS, EU, regionOf, parseList, config, saveConfig, enforced, sellerKyb, publicTrader, foreignImages, needsBrandProof, productRegions, canSell, strike, recertScan, start, partyOk, parseParty };
