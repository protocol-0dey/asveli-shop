import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, get, post, tokens } from '../api';
import { useApp } from '../state';
import { Logo } from '../components/Logo';
import { Empty, Field, Spinner, errText } from '../components/ui';
import { Inbox } from '../components/Inbox';
import { LANGS, LANG_NAMES, Lang } from '../i18n';

/* ------------ shared ------------ */
const useS = () => { const a = useApp(); return { ...a, s: (k: string, v?: Record<string, string | number>) => a.t('seller.' + k, v) }; };
function useLoad<T>(path: string) {
  const [d, setD] = useState<T | null>(null); const [err, setErr] = useState(false);
  const load = useCallback(() => { get<T>(path).then(x => { setD(x); setErr(false); }).catch(() => setErr(true)); }, [path]);
  useEffect(() => { load(); }, [load]);
  return { d, err, load };
}
const Table = ({ children }: { children: ReactNode }) => <div style={{ overflowX: 'auto' }}><table className="table">{children}</table></div>;
const stBadge = (st: string) => (['approved', 'active', 'paid', 'delivered', 'received'].includes(st) ? 'ok' : ['rejected', 'delisted', 'closed', 'failed'].includes(st) ? 'err' : ['draft', 'paused'].includes(st) ? '' : 'warn');
const Badge = ({ st }: { st: string }) => { const { s } = useS(); return <span className={'badge ' + stBadge(st)}>{s('st.' + st)}</span>; };

interface Strike { level: number; reason: string; region: string | null; product_id: number | null; created_at: number }
interface Me { id: number; name: string; country: string; status: string; kyc_status: string; kyc_note: string | null; commission_bps: number; profile: Record<string, string | null>; balance: number; pending_payouts: number; currency: string;
  trust?: { kyb: { complete: boolean; missing: string[]; verified: boolean; recert_due_at: number | null; recert_overdue: boolean }; open_regions: string[]; blocked_regions: string[]; listing_ban_until: number | null; payouts_hold: boolean; strikes: Strike[] } }
const REGIONS = ['EU', 'UK', 'US', 'CH', 'NO', 'CA'] as const;
type PartyF = { name: string; address: string; email: string };
const emptyParty: PartyF = { name: '', address: '', email: '' };

/* ------------ auth ------------ */
function SellerAuth({ register }: { register?: boolean }) {
  const { s, t, toast, countries, countryName } = useS(); const nav = useNavigate(); const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ email: '', password: '', store_name: '', country: 'PL' }); const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { const r = await post(register ? '/api/seller/auth/register' : '/api/seller/auth/login', register ? f : { email: f.email, password: f.password }, { auth: null }); tokens.setSeller(r.token); nav('/seller'); }
    catch (x) { toast(errText(t, x), 'err'); }
    setBusy(false);
  };
  return (
    <div className="center" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form className="card stack" style={{ width: 'min(440px,100%)' }} onSubmit={submit}>
        <Logo /><h1 style={{ fontSize: '1.5rem' }}>{register ? s('auth.register') : s('auth.login')}</h1>
        {register && <Field label={s('auth.storeName')}><input className="input" value={f.store_name} onChange={set('store_name')} required minLength={2} maxLength={120} /></Field>}
        {register && <Field label={t('f.country')}><select className="input" value={f.country} onChange={set('country')}>{countries.map(c => <option key={c} value={c}>{countryName(c)}</option>)}</select></Field>}
        <Field label={t('f.email')}><input className="input" type="email" value={f.email} onChange={set('email')} required autoComplete="email" /></Field>
        <Field label={t('f.password')} hint={register ? t('auth.pwHint') : undefined}><input className="input" type="password" value={f.password} onChange={set('password')} required minLength={register ? 10 : 1} autoComplete={register ? 'new-password' : 'current-password'} /></Field>
        <button className="btn btn-primary btn-block" disabled={busy}>{register ? s('auth.create') : s('auth.login')}</button>
        <div className="small muted">{register ? <Link to="/seller/login">{s('auth.login')}</Link> : <Link to="/seller/register">{s('auth.register')}</Link>} · <Link to="/">← {t('common.home')}</Link></div>
      </form>
    </div>
  );
}

/* ------------ dashboard ------------ */
interface An { days: number; totals: { orders: number; units: number; revenue: number }; daily: { d: string; revenue: number }[]; top: { id: number; title: string; units: number; revenue: number; views: number; conversion: number | null }[]; rating: { avg: number; count: number } | null; returns: number; low_stock: { id: number; title: string; available: number; days_left: number | null }[] }
function Dashboard({ me }: { me: Me }) {
  const { s, money } = useS(); const { d } = useLoad<An>('/api/seller/analytics?days=30');
  if (!d) return <Spinner />;
  const max = Math.max(1, ...d.daily.map(x => x.revenue)), W = 600, H = 200, bw = Math.min(28, d.daily.length ? W / d.daily.length : 28), x0 = W - bw * d.daily.length;
  return (
    <div className="stack">
      {me.status !== 'active' && <div className="notice warn">{s('dash.notActive')} <Link to="/seller/settings">{s('nav.settings')}</Link></div>}
      <div className="grid-3">{[[s('dash.revenue'), money(d.totals.revenue)], [s('dash.orders'), String(d.totals.orders)], [s('dash.units'), String(d.totals.units)], [s('dash.balance'), money(me.balance)], [s('dash.rating'), d.rating ? `${d.rating.avg} ★ (${d.rating.count})` : '—'], [s('dash.returns'), String(d.returns)]].map(([k, v]) =>
        <div className="card" key={k}><div className="muted small">{k}</div><div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{v}</div></div>)}</div>
      <section className="card"><h3>{s('dash.last30')}</h3>
        {d.daily.length ? <svg className="chart bars" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMinYMax meet" role="img" aria-label={s('dash.last30')}>
          <defs><linearGradient id="bargrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4fe3d0" /><stop offset="1" stopColor="#7c5cff" /></linearGradient></defs>
          {d.daily.map((x, i) => { const h = (x.revenue / max) * (H - 10); return <rect key={x.d} x={x0 + i * bw + 2} y={H - h} width={Math.max(2, bw - 4)} height={h} rx="3"><title>{x.d}: {money(x.revenue)}</title></rect>; })}
        </svg> : <div className="muted">{s('dash.noSales')}</div>}</section>
      <div className="grid-2">
        <section className="card"><h3>{s('dash.top')}</h3>{d.top.length ? <Table><thead><tr><th>{s('p.title')}</th><th>{s('dash.units')}</th><th>{s('dash.revenue')}</th><th>{s('dash.conv')}</th></tr></thead><tbody>{d.top.map(r => <tr key={r.id}><td>{r.title}</td><td>{r.units}</td><td>{money(r.revenue)}</td><td>{r.conversion == null ? '—' : r.conversion + '%'}</td></tr>)}</tbody></Table> : <div className="muted">—</div>}</section>
        <section className="card"><h3>{s('dash.low')}</h3>{d.low_stock.length ? <Table><thead><tr><th>{s('p.title')}</th><th>{s('p.available')}</th><th>{s('dash.daysLeft')}</th></tr></thead><tbody>{d.low_stock.map(r => <tr key={r.id}><td>{r.title}</td><td>{r.available}</td><td>{r.days_left ?? '—'}</td></tr>)}</tbody></Table> : <div className="muted">{s('dash.stockOk')}</div>}</section>
      </div>
    </div>
  );
}

/* ------------ products ------------ */
interface Prod { id: number; sku: string; title: string; category: string | null; description: string | null; brand: string | null; model_slug: string | null; images: string[]; price: number; cost: number | null; min_price: number | null; max_price: number | null; auto_reprice: boolean; weight_g: number | null; hs_code: string | null; origin_country: string | null; digital: boolean; digital_file: boolean; status: string; moderation_note: string | null; compliance_flags: string | null; stock: { qty: number; reserved: number; available: number; inbound: number };
  barcode?: string | null; external_id?: string | null; sale_regions?: string[]; manufacturer_name?: string | null; manufacturer_address?: string | null; manufacturer_email?: string | null; manufacturer_country?: string | null;
  responsible_eu?: PartyF | null; responsible_uk?: PartyF | null; responsible_us?: PartyF | null; safety_info?: string | null; brand_proof?: string | null; brand_proof_status?: string }
interface Readiness { regions: Record<string, { ok: boolean; missing: string[] }>; ready: string[]; requested: string[]; open_regions: string[] }
const cents = (v: string) => Math.round(parseFloat(v.replace(',', '.')) * 100);
const eur = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2));

function ProductForm({ p, onDone, onCancel }: { p: Prod | null; onDone: () => void; onCancel: () => void }) {
  const { s, t, toast } = useS(); const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ sku: p?.sku.replace(/^\d+-/, '') || '', title: p?.title || '', category: p?.category || '', brand: p?.brand || '', description: p?.description || '', price: eur(p?.price ?? null), cost: eur(p?.cost ?? null),
    weight_g: String(p?.weight_g ?? ''), origin_country: p?.origin_country || '', hs_code: p?.hs_code || '', model_slug: p?.model_slug || '', images: (p?.images || []).join('\n'), digital: !!p?.digital,
    barcode: p?.barcode || '', external_id: p?.external_id || '', manufacturer_name: p?.manufacturer_name || '', manufacturer_address: p?.manufacturer_address || '', manufacturer_email: p?.manufacturer_email || '',
    manufacturer_country: p?.manufacturer_country || '', safety_info: p?.safety_info || '', brand_proof: p?.brand_proof || '' });
  const [regions, setRegions] = useState<string[]>(p?.sale_regions || []);
  const [resp, setResp] = useState<Record<string, PartyF>>({ responsible_eu: p?.responsible_eu || emptyParty, responsible_uk: p?.responsible_uk || emptyParty, responsible_us: p?.responsible_us || emptyParty });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const setR = (k: string, part: keyof PartyF) => (e: { target: { value: string } }) => setResp({ ...resp, [k]: { ...resp[k], [part]: e.target.value } });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    const body: any = { title: f.title, category: f.category || undefined, brand: f.brand || undefined, description: f.description || undefined, price: cents(f.price), digital: f.digital ? 1 : 0,
      images: f.images.split('\n').map(x => x.trim()).filter(Boolean), model_slug: f.model_slug || '' };
    if (f.cost) body.cost = cents(f.cost); if (f.weight_g) body.weight_g = parseInt(f.weight_g, 10); if (f.origin_country) body.origin_country = f.origin_country.toUpperCase(); if (f.hs_code) body.hs_code = f.hs_code;
    for (const k of ['barcode', 'external_id', 'manufacturer_name', 'manufacturer_address', 'manufacturer_email', 'safety_info', 'brand_proof'] as const) if (f[k]) body[k] = f[k];
    if (f.manufacturer_country) body.manufacturer_country = f.manufacturer_country.toUpperCase();
    if (regions.length) body.sale_regions = regions;
    for (const [k, v] of Object.entries(resp)) if (v.name || v.address || v.email) body[k] = v;      // a half-filled party is refused by the server with a clear error
    try { if (p) await api('PATCH', '/api/seller/products/' + p.id, body); else await post('/api/seller/products', { ...body, sku: f.sku }); toast(t('common.saved')); onDone(); }
    catch (x) { toast(errText(t, x), 'err'); }
    setBusy(false);
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <h3>{p ? s('p.edit') : s('p.new')}</h3>
      <div className="grid-2">
        {!p && <Field label="SKU"><input className="input" value={f.sku} onChange={set('sku')} required maxLength={40} /></Field>}
        <Field label={s('p.title')}><input className="input" value={f.title} onChange={set('title')} required maxLength={160} /></Field>
        <Field label={t('search.category')}><input className="input" value={f.category} onChange={set('category')} maxLength={60} /></Field>
        <Field label={t('search.brand')}><input className="input" value={f.brand} onChange={set('brand')} maxLength={60} /></Field>
        <Field label={s('p.price')}><input className="input" inputMode="decimal" value={f.price} onChange={set('price')} required /></Field>
        <Field label={s('p.cost')}><input className="input" inputMode="decimal" value={f.cost} onChange={set('cost')} /></Field>
        <Field label={s('p.weight')}><input className="input" inputMode="numeric" value={f.weight_g} onChange={set('weight_g')} /></Field>
        <Field label={s('p.origin')}><input className="input" value={f.origin_country} onChange={set('origin_country')} maxLength={2} placeholder="PL" /></Field>
        <Field label="HS code"><input className="input" value={f.hs_code} onChange={set('hs_code')} maxLength={12} /></Field>
        <Field label={s('p.model')} hint={s('p.modelHint')}><input className="input" value={f.model_slug} onChange={set('model_slug')} maxLength={80} /></Field>
      </div>
      <Field label={s('p.desc')}><textarea className="input" rows={4} value={f.description} onChange={set('description')} maxLength={2000} /></Field>
      <Field label={s('p.images')} hint={s('p.imagesHint')}><textarea className="input" rows={3} value={f.images} onChange={set('images')} /></Field>
      <label className="row"><input type="checkbox" checked={f.digital} onChange={e => setF({ ...f, digital: e.target.checked })} /> {s('p.digital')}</label>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}><legend><h3>{s('tr.title')}</h3></legend>
        <div className="row" role="group" aria-label={s('tr.regions')} style={{ flexWrap: 'wrap' }}>{REGIONS.map(r => <label key={r} className={'chip ' + (regions.includes(r) ? 'on' : '')}>
          <input type="checkbox" checked={regions.includes(r)} onChange={e => setRegions(e.target.checked ? [...regions, r] : regions.filter(x => x !== r))} style={{ marginRight: 6 }} />{r}</label>)}</div>
        <div className="grid-2">
          <Field label={s('tr.barcode')}><input className="input" value={f.barcode} onChange={set('barcode')} inputMode="numeric" pattern="\d{8,14}" maxLength={14} /></Field>
          <Field label={s('tr.article')}><input className="input" value={f.external_id} onChange={set('external_id')} maxLength={120} /></Field>
          <Field label={s('tr.mName')}><input className="input" value={f.manufacturer_name} onChange={set('manufacturer_name')} maxLength={120} /></Field>
          <Field label={s('tr.mEmail')}><input className="input" type="email" value={f.manufacturer_email} onChange={set('manufacturer_email')} maxLength={120} /></Field>
          <Field label={s('tr.mAddress')}><input className="input" value={f.manufacturer_address} onChange={set('manufacturer_address')} maxLength={200} /></Field>
          <Field label={s('tr.mCountry')}><input className="input" value={f.manufacturer_country} onChange={set('manufacturer_country')} maxLength={2} placeholder="CN" /></Field>
        </div>
        {(['EU', 'UK', 'US'] as const).filter(r => regions.includes(r)).map(r => { const k = 'responsible_' + r.toLowerCase(); return (
          <div key={r} className="stack"><b>{s('tr.respTitle')} — {r}</b><div className="small muted">{s('tr.respHint')}</div>
            <div className="grid-3"><Field label={s('tr.rName')}><input className="input" value={resp[k].name} onChange={setR(k, 'name')} maxLength={120} /></Field>
              <Field label={s('tr.rAddress')}><input className="input" value={resp[k].address} onChange={setR(k, 'address')} maxLength={200} /></Field>
              <Field label={s('tr.rEmail')}><input className="input" type="email" value={resp[k].email} onChange={setR(k, 'email')} maxLength={120} /></Field></div></div>); })}
        <Field label={s('tr.safety')}><textarea className="input" rows={3} value={f.safety_info} onChange={set('safety_info')} maxLength={3000} /></Field>
        <Field label={s('tr.brandProof')} hint={p?.brand_proof_status && p.brand_proof_status !== 'none' ? s('tr.brand.' + p.brand_proof_status) : s('tr.brandProofHint')}><input className="input" value={f.brand_proof} onChange={set('brand_proof')} maxLength={300} placeholder="https://" /></Field>
      </fieldset>
      {f.digital && <div className="small muted">{s('p.digitalHint')}</div>}
      <div className="row"><button className="btn btn-primary" disabled={busy}>{t('common.save')}</button><button type="button" className="btn btn-ghost" onClick={onCancel}>{t('common.cancel')}</button></div>
    </form>
  );
}

function Inbound({ p, onDone, onCancel }: { p: Prod; onDone: () => void; onCancel: () => void }) {
  const { s, t, toast } = useS(); const { d: w } = useLoad<{ items: { id: number; name: string; country: string }[] }>('/api/seller/warehouses'); const [wh, setWh] = useState(''); const [qty, setQty] = useState('1');
  const go = async (e: FormEvent) => { e.preventDefault(); try { await post(`/api/seller/products/${p.id}/inbound`, { warehouse_id: +wh, qty: +qty }); toast(s('p.inboundSent')); onDone(); } catch (x) { toast(errText(t, x), 'err'); } };
  return <form className="card stack" onSubmit={go}><h3>{s('p.inbound')}: {p.title}</h3><div className="small muted">{s('p.inboundHint')}</div>
    <div className="grid-2"><Field label={s('p.warehouse')}><select className="input" value={wh} onChange={e => setWh(e.target.value)} required><option value="">—</option>{w?.items.map(x => <option key={x.id} value={x.id}>{x.name} ({x.country})</option>)}</select></Field>
      <Field label={t('f.qty')}><input className="input" type="number" min={1} max={100000} value={qty} onChange={e => setQty(e.target.value)} required /></Field></div>
    <div className="row"><button className="btn btn-primary">{s('p.inboundSend')}</button><button type="button" className="btn btn-ghost" onClick={onCancel}>{t('common.cancel')}</button></div></form>;
}

function ReadinessPanel({ p, onClose }: { p: Prod; onClose: () => void }) {
  const { s } = useS(); const { d } = useLoad<Readiness>(`/api/seller/products/${p.id}/readiness`);
  return <section className="card stack" aria-live="polite"><div className="row between"><h3>{s('tr.check')}: {p.title}</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>×</button></div>
    {!d ? <Spinner /> : !d.requested.length ? <div className="muted">{s('tr.none')}</div> : <Table><tbody>{d.requested.map(r => { const st = d.regions[r]; return <tr key={r}><td><b>{r}</b></td>
      <td>{st.ok ? <span className="badge ok">{s('tr.ready')}</span> : <span className="badge warn">{s('tr.notReady')}</span>}</td><td className="small">{st.missing.map(m => s('miss.' + m)).join(' · ')}</td></tr>; })}</tbody></Table>}</section>;
}

function Products() {
  const { s, t, money, toast } = useS(); const { d, load } = useLoad<{ items: Prod[] }>('/api/seller/products'); const { d: inb, load: loadInb } = useLoad<{ items: { id: number; title: string; warehouse: string; qty: number; status: string; created_at: number }[] }>('/api/seller/inbound');
  const [mode, setMode] = useState<{ k: 'form' | 'inbound'; p: Prod | null } | null>(null); const [check, setCheck] = useState<Prod | null>(null);
  const act = async (p: Prod, a: 'submit' | 'delist') => { try { await post(`/api/seller/products/${p.id}/${a}`); toast(t('common.saved')); load(); } catch (x) { toast(errText(t, x), 'err'); } };
  const done = () => { setMode(null); load(); loadInb(); };
  if (!d) return <Spinner />;
  if (mode?.k === 'form') return <ProductForm p={mode.p} onDone={done} onCancel={() => setMode(null)} />;
  if (mode?.k === 'inbound' && mode.p) return <Inbound p={mode.p} onDone={done} onCancel={() => setMode(null)} />;
  return (
    <div className="stack">
      <div><button className="btn btn-primary" onClick={() => setMode({ k: 'form', p: null })}>+ {s('p.new')}</button></div>
      {check && <ReadinessPanel key={check.id} p={check} onClose={() => setCheck(null)} />}
      {!d.items.length ? <Empty title={s('p.none')} /> : <section className="card"><Table><thead><tr><th>{s('p.title')}</th><th>{s('p.price')}</th><th>{s('p.stock')}</th><th>{s('p.status')}</th><th /></tr></thead><tbody>
        {d.items.map(p => <tr key={p.id}><td><b>{p.title}</b><div className="small muted">{p.sku.replace(/^\d+-/, '')}{p.digital ? ' · ' + t('common.digital') : ''}</div>{p.moderation_note && <div className="small err">{p.moderation_note}</div>}{p.compliance_flags && <div className="small muted">{p.compliance_flags}</div>}</td>
          <td>{money(p.price)}</td><td>{p.digital ? '∞' : `${p.stock.available}${p.stock.inbound ? ` (+${p.stock.inbound})` : ''}`}</td><td><Badge st={p.status} /></td>
          <td className="row" style={{ flexWrap: 'wrap' }}>
            {p.status !== 'delisted' && <button className="btn btn-ghost btn-sm" onClick={() => setMode({ k: 'form', p })}>{s('p.edit')}</button>}
            {['draft', 'rejected'].includes(p.status) && <button className="btn btn-primary btn-sm" onClick={() => act(p, 'submit')}>{s('p.submit')}</button>}
            {!p.digital && p.status !== 'delisted' && <button className="btn btn-ghost btn-sm" onClick={() => setCheck(p)}>{s('tr.check')}</button>}
            {!p.digital && p.status === 'approved' && <button className="btn btn-ghost btn-sm" onClick={() => setMode({ k: 'inbound', p })}>{s('p.inbound')}</button>}
            {['approved', 'pending_review'].includes(p.status) && <button className="btn btn-ghost btn-sm" onClick={() => act(p, 'delist')}>{s('p.delist')}</button>}
          </td></tr>)}</tbody></Table></section>}
      {inb && inb.items.length > 0 && <section className="card"><h3>{s('p.inboundList')}</h3><Table><thead><tr><th>{s('p.title')}</th><th>{s('p.warehouse')}</th><th>{t('f.qty')}</th><th>{s('p.status')}</th></tr></thead><tbody>{inb.items.map(i => <tr key={i.id}><td>{i.title}</td><td>{i.warehouse}</td><td>{i.qty}</td><td><Badge st={i.status} /></td></tr>)}</tbody></Table></section>}
    </div>
  );
}

/* ------------ orders ------------ */
function Orders() {
  const { s, t, money, date } = useS(); const { d } = useLoad<{ items: { code: string; status: string; country: string; created_at: number; title: string; qty: number; unit_price: number; gross: number; net: number; shipment: string | null; returned_qty: number }[] }>('/api/seller/orders');
  if (!d) return <Spinner />; if (!d.items.length) return <Empty title={s('o.none')} />;
  return <section className="card"><div className="small muted" style={{ marginBottom: 8 }}>{s('o.privacy')}</div><Table><thead><tr><th>{s('o.order')}</th><th>{s('p.title')}</th><th>{t('f.qty')}</th><th>{s('o.gross')}</th><th>{s('o.net')}</th><th>{s('p.status')}</th></tr></thead><tbody>
    {d.items.map((r, i) => <tr key={r.code + i}><td>{r.code}<div className="small muted">{date(r.created_at)} · {r.country}</div></td><td>{r.title}</td><td>{r.qty}{r.returned_qty ? ` (−${r.returned_qty})` : ''}</td><td>{money(r.gross)}</td><td>{money(r.net)}</td><td><span className="badge cyan">{t('order.s.' + r.status)}</span>{r.shipment && <div className="small muted">{t('ship.' + r.shipment)}</div>}</td></tr>)}</tbody></Table></section>;
}

/* ------------ ads ------------ */
interface Camp { id: number; name: string; product: string | null; budget: number; cpc: number; spent: number; impressions: number; clicks: number; orders: number; status: string; ctr: number | null; roas: number | null }
function Ads() {
  const { s, t, money, toast } = useS(); const { d, load } = useLoad<{ items: Camp[] }>('/api/seller/campaigns'); const { d: pr } = useLoad<{ items: Prod[] }>('/api/seller/products?status=approved');
  const [f, setF] = useState({ name: '', product_id: '', budget: '', cpc: '' });
  const create = async (e: FormEvent) => { e.preventDefault(); try { await post('/api/seller/campaigns', { name: f.name, product_id: +f.product_id, budget: cents(f.budget), cpc: cents(f.cpc) }); toast(s('ads.created')); setF({ name: '', product_id: '', budget: '', cpc: '' }); load(); } catch (x) { toast(errText(t, x), 'err'); } };
  const act = async (c: Camp, a: 'pause' | 'resume') => { try { await post(`/api/seller/campaigns/${c.id}/${a}`); load(); } catch (x) { toast(errText(t, x), 'err'); } };
  if (!d) return <Spinner />;
  return (
    <div className="stack">
      <form className="card stack" onSubmit={create}><h3>{s('ads.new')}</h3><div className="small muted">{s('ads.hint')}</div>
        <div className="grid-2"><Field label={s('ads.name')}><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required maxLength={80} /></Field>
          <Field label={s('ads.product')}><select className="input" value={f.product_id} onChange={e => setF({ ...f, product_id: e.target.value })} required><option value="">—</option>{pr?.items.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field>
          <Field label={s('ads.budget')}><input className="input" inputMode="decimal" value={f.budget} onChange={e => setF({ ...f, budget: e.target.value })} required /></Field>
          <Field label={s('ads.cpc')}><input className="input" inputMode="decimal" value={f.cpc} onChange={e => setF({ ...f, cpc: e.target.value })} required /></Field></div>
        <div><button className="btn btn-primary">{s('ads.create')}</button></div></form>
      {d.items.length > 0 && <section className="card"><Table><thead><tr><th>{s('ads.name')}</th><th>{s('ads.budget')}</th><th>{s('ads.spent')}</th><th>{s('ads.clicks')}</th><th>CTR</th><th>ROAS</th><th>{s('p.status')}</th><th /></tr></thead><tbody>
        {d.items.map(c => <tr key={c.id}><td><b>{c.name}</b><div className="small muted">{c.product}</div></td><td>{money(c.budget)}</td><td>{money(c.spent)}</td><td>{c.clicks}/{c.impressions}</td><td>{c.ctr == null ? '—' : c.ctr + '%'}</td><td>{c.roas ?? '—'}</td><td><Badge st={c.status} /></td>
          <td>{c.status === 'active' && <button className="btn btn-ghost btn-sm" onClick={() => act(c, 'pause')}>{s('ads.pause')}</button>}{c.status === 'paused' && <button className="btn btn-ghost btn-sm" onClick={() => act(c, 'resume')}>{s('ads.resume')}</button>}</td></tr>)}</tbody></Table></section>}
    </div>
  );
}

/* ------------ finance ------------ */
function Finance({ me, reload }: { me: Me; reload: () => void }) {
  const { s, t, money, date, toast } = useS(); const { d, load } = useLoad<{ balance: number; pending_payouts: number; ledger: { id: number; kind: string; amount: number; note: string | null; created_at: number }[]; payouts: { id: number; amount: number; status: string; created_at: number }[] }>('/api/seller/finance'); const [amt, setAmt] = useState('');
  const req = async (e: FormEvent) => { e.preventDefault(); try { await post('/api/seller/payouts', { amount: cents(amt) }); toast(s('f.requested')); setAmt(''); load(); reload(); } catch (x) { toast(errText(t, x), 'err'); } };
  if (!d) return <Spinner />;
  return (
    <div className="stack">
      <div className="grid-2"><div className="card"><div className="muted small">{s('dash.balance')}</div><div style={{ fontSize: '1.8rem', fontWeight: 800 }}>{money(d.balance)}</div><div className="small muted">{s('f.pending')}: {money(d.pending_payouts)}</div></div>
        <form className="card stack" onSubmit={req}><h3>{s('f.request')}</h3><Field label={s('f.amount')}><input className="input" inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} required /></Field><div className="small muted">{s('f.hint')}</div><div><button className="btn btn-primary" disabled={me.kyc_status !== 'approved'}>{s('f.requestBtn')}</button></div></form></div>
      <div className="grid-2">
        <section className="card"><h3>{s('f.payouts')}</h3><Table><tbody>{d.payouts.map(p => <tr key={p.id}><td>{date(p.created_at)}</td><td>{money(p.amount)}</td><td><Badge st={p.status} /></td></tr>)}</tbody></Table></section>
        <section className="card"><h3>{s('f.ledger')}</h3><Table><tbody>{d.ledger.map(l => <tr key={l.id}><td>{date(l.created_at)}</td><td>{s('led.' + l.kind)}</td><td style={{ textAlign: 'right' }}>{money(l.amount)}</td></tr>)}</tbody></Table></section>
      </div>
    </div>
  );
}

/* ------------ settings / KYC ------------ */
function Settings({ me, reload }: { me: Me; reload: () => void }) {
  const { s, t, toast } = useS(); const locked = ['pending', 'approved'].includes(me.kyc_status);
  const [f, setF] = useState({ name: me.name, legal_name: '', phone: '', address: '', tax_id: '', passport_no: '', bank_iban: '', registry_name: '', registration_no: '', vat_no: '', own_brands: me.profile.own_brands || '' }); const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const [cert, setCert] = useState(false); const [same, setSame] = useState(false); const tr = me.trust; const { date } = useS();
  const recert = async () => { try { await post('/api/seller/kyc/recertify', { confirm_unchanged: same, self_certification: cert }); toast(s('kyc.recertDone')); setCert(false); setSame(false); reload(); } catch (x) { toast(errText(t, x), 'err'); } };
  const save = async (e: FormEvent) => { e.preventDefault(); try { await api('PUT', '/api/seller/profile', f); toast(t('common.saved')); setF({ ...f, legal_name: '', tax_id: '', passport_no: '', bank_iban: '', registry_name: '', registration_no: '', vat_no: '' }); reload(); } catch (x) { toast(errText(t, x), 'err'); } };
  const submit = async () => { try { await post('/api/seller/kyc/submit', { self_certification: cert }); toast(s('kyc.submitted')); setCert(false); reload(); } catch (x) { toast(errText(t, x), 'err'); } };
  const certBox = <label className="row small" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={cert} onChange={e => setCert(e.target.checked)} style={{ marginTop: 3 }} /><span>{s('kyc.selfCert')}</span></label>;
  const mask = (k: string) => me.profile[k] || s('kyc.empty');
  return (
    <div className="stack">
      <section className="card stack"><h3>{s('kyc.title')}</h3>
        <div className="row"><span>{s('kyc.status')}:</span><span className={'badge ' + (me.kyc_status === 'approved' ? 'ok' : me.kyc_status === 'rejected' ? 'err' : 'warn')}>{s('kyc.' + me.kyc_status)}</span><span className="muted small">· {s('st.' + me.status)}</span></div>
        {me.kyc_note && <div className="notice warn small">{me.kyc_note}</div>}
        <div className="small muted">{s('kyc.hint')}</div>
        {['not_submitted', 'rejected'].includes(me.kyc_status) && <>{certBox}<div><button className="btn btn-primary" onClick={submit} disabled={!cert}>{s('kyc.submit')}</button></div></>}
      </section>
      {tr && me.kyc_status === 'approved' && tr.kyb.recert_due_at && (tr.kyb.recert_overdue || tr.kyb.recert_due_at - Date.now() < 30 * 864e5) && (
        <section className={'card stack ' + (tr.kyb.recert_overdue ? 'notice err' : '')}><h3>{s('kyc.recertTitle')}</h3>
          <div className="small">{tr.kyb.recert_overdue ? s('kyc.recertOverdue') : s('kyc.recertDue', { date: date(tr.kyb.recert_due_at) })}</div>
          <label className="row small"><input type="checkbox" checked={same} onChange={e => setSame(e.target.checked)} /> {s('kyc.recertUnchanged')}</label>{certBox}
          <div><button className="btn btn-primary" onClick={recert} disabled={!cert || !same}>{s('kyc.recertBtn')}</button></div></section>)}
      {tr && (tr.strikes.length > 0 || tr.blocked_regions.length > 0 || tr.payouts_hold) && (
        <section className="card stack"><h3>{s('kyc.sanctions')}</h3>
          {tr.blocked_regions.length > 0 && <div className="notice warn small">{s('kyc.blocked', { regions: tr.blocked_regions.join(', ') })}</div>}
          {tr.payouts_hold && <div className="notice warn small">{s('kyc.hold')}</div>}
          {tr.strikes.length > 0 && <Table><tbody>{tr.strikes.map((x, i) => <tr key={i}><td className="small">{date(x.created_at)}</td><td><span className="badge warn">{s('kyc.level', { n: x.level })}</span></td><td>{x.reason}{x.region ? ` · ${x.region}` : ''}</td></tr>)}</tbody></Table>}
        </section>)}
      <form className="card stack" onSubmit={save}><h3>{s('kyc.profile')}</h3>
        <div className="grid-2">
          <Field label={s('auth.storeName')}><input className="input" value={f.name} onChange={set('name')} maxLength={120} /></Field>
          <Field label={t('f.phone')} hint={me.profile.phone || undefined}><input className="input" value={f.phone} onChange={set('phone')} maxLength={30} /></Field>
          <Field label={t('f.line1')} hint={me.profile.address || undefined}><input className="input" value={f.address} onChange={set('address')} maxLength={160} /></Field>
          <Field label={s('kyc.legalName')} hint={mask('legal_name')}><input className="input" value={f.legal_name} onChange={set('legal_name')} disabled={locked} /></Field>
          <Field label={s('kyc.taxId')} hint={mask('tax_id')}><input className="input" value={f.tax_id} onChange={set('tax_id')} disabled={locked} /></Field>
          <Field label={s('kyc.passport')} hint={mask('passport_no')}><input className="input" value={f.passport_no} onChange={set('passport_no')} disabled={locked} /></Field>
          <Field label="IBAN" hint={mask('bank_iban')}><input className="input" value={f.bank_iban} onChange={set('bank_iban')} disabled={locked} autoComplete="off" /></Field>
          <Field label={s('kyc.registry')} hint={me.profile.registry_name || undefined}><input className="input" value={f.registry_name} onChange={set('registry_name')} disabled={locked} maxLength={80} /></Field>
          <Field label={s('kyc.regNo')} hint={me.profile.registration_no || undefined}><input className="input" value={f.registration_no} onChange={set('registration_no')} disabled={locked} maxLength={40} /></Field>
          <Field label={s('kyc.vat')} hint={me.profile.vat_no || undefined}><input className="input" value={f.vat_no} onChange={set('vat_no')} maxLength={20} /></Field>
          <Field label={s('kyc.brands')}><input className="input" value={f.own_brands} onChange={set('own_brands')} maxLength={300} /></Field>
        </div>
        <div className="small muted">{s('kyc.masked')}</div><div><button className="btn btn-primary">{t('common.save')}</button></div></form>
    </div>
  );
}

function Reviews() {
  const { s, date } = useS(); const { d } = useLoad<{ items: { id: number; rating: number; body: string; created_at: number; title: string }[] }>('/api/seller/reviews');
  if (!d) return <Spinner />; if (!d.items.length) return <Empty title={s('rv.none')} />;
  return <div className="stack">{d.items.map(r => <div className="card" key={r.id}><div className="row between"><b>{r.title}</b><span>{'★'.repeat(r.rating)}<span className="muted">{'★'.repeat(5 - r.rating)}</span></span></div><p style={{ margin: '6px 0' }}>{r.body}</p><div className="small muted">{date(r.created_at)}</div></div>)}</div>;
}

function Messages() {
  const { s } = useS(); const [id, setId] = useState<number | null>(null);
  return <div className="stack"><p className="muted small">{s('m.privacy')}</p><Inbox base="/api/seller/inquiries" me="seller" id={id} open={setId} empty={s('m.none')} /></div>;
}

/* ------------ shell ------------ */
const NAV: [string, string][] = [['', 'dashboard'], ['products', 'products'], ['orders', 'orders'], ['ads', 'ads'], ['finance', 'finance'], ['reviews', 'reviews'], ['messages', 'messages'], ['settings', 'settings']];
function Shell() {
  const { s, lang, setLang } = useS(); const nav = useNavigate(); const [open, setOpen] = useState(false); const [me, setMe] = useState<Me | null>(null); const [bad, setBad] = useState(false);
  const reload = useCallback(() => { get<Me>('/api/seller/me').then(setMe).catch(() => setBad(true)); }, []);
  useEffect(() => { reload(); }, [reload]);
  document.title = 'Seller Central — ASVELI';
  if (!tokens.seller() || bad) return <Navigate to="/seller/login" replace />;
  const logout = async () => { try { await api('POST', '/api/seller/auth/logout', {}); } catch { /* ignore */ } tokens.setSeller(null); nav('/seller/login'); };
  return (
    <div className="seller">
      <aside className={open ? 'open' : ''} onClick={() => setOpen(false)}>
        <div className="logo"><Logo /></div>
        <nav>{NAV.map(([p, k]) => <NavLink key={k} to={'/seller' + (p ? '/' + p : '')} end={!p} className={({ isActive }) => (isActive ? 'on' : '')}>{s('nav.' + k)}</NavLink>)}</nav>
        <div style={{ padding: '20px 8px 0' }} className="stack"><select className="input" aria-label="Language" value={lang} onClick={e => e.stopPropagation()} onChange={e => setLang(e.target.value as Lang)}>{LANGS.map(l => <option key={l} value={l}>{LANG_NAMES[l]}</option>)}</select>
          <Link className="small" to="/">← {s('nav.shop')}</Link><button className="btn btn-ghost btn-sm" onClick={logout}>{s('nav.logout')}</button></div>
      </aside>
      <main>
        <div className="seller-top"><button className="btn btn-ghost seller-menu-btn" onClick={() => setOpen(o => !o)} aria-label="Menu">☰</button><h1 style={{ fontSize: '1.5rem', margin: 0 }}>{me?.name || '…'}</h1></div>
        {!me ? <Spinner /> : (
          <Routes>
            <Route index element={<Dashboard me={me} />} /><Route path="products" element={<Products />} /><Route path="orders" element={<Orders />} /><Route path="ads" element={<Ads />} />
            <Route path="finance" element={<Finance me={me} reload={reload} />} /><Route path="reviews" element={<Reviews />} /><Route path="messages" element={<Messages />} /><Route path="settings" element={<Settings me={me} reload={reload} />} /><Route path="*" element={<Navigate to="/seller" replace />} />
          </Routes>)}
      </main>
    </div>
  );
}

export default function SellerApp() {
  return <Routes><Route path="login" element={<SellerAuth />} /><Route path="register" element={<SellerAuth register />} /><Route path="*" element={<Shell />} /></Routes>;
}
