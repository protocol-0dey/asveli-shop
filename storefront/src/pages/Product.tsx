import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, assetUrl, get, post } from '../api';
import { useApp, useAuth, useCart } from '../state';
import type { ModelFull, Offer, OtherOffer, Quote, Review, ReviewSummary } from '../lib/types';
import { InquiryForm } from '../components/Inquiry';
import { ProductArt } from '../components/ProductArt';
import { ProductCard } from '../components/ProductCard';
import { Empty, Qty, Spinner, Stars, errText } from '../components/ui';

function Gallery({ m }: { m: ModelFull }) {
  const [i, setI] = useState(0); const imgs = m.images.map(assetUrl).filter(Boolean) as string[];
  useEffect(() => setI(0), [m.slug]);
  return (
    <div className="gallery">
      <div className="main">{imgs.length ? <img src={imgs[i]} alt={m.title} /> : <ProductArt seed={m.slug} category={m.category} title={m.title} />}</div>
      {imgs.length > 1 && <div className="thumbs">{imgs.map((u, k) => <button key={u} className={k === i ? 'on' : ''} onClick={() => setI(k)} aria-label={`${k + 1}`}><img src={u} alt="" /></button>)}</div>}
    </div>
  );
}

function Delivery({ o }: { o: Offer }) {
  const { t } = useApp();
  if (o.sold_in_country === false) return <span className="stock-out">{t('pdp.notSoldHere')}</span>;
  if (o.digital) return <span>{t('pdp.instant')}</span>;
  if (!o.delivery) return <span className="stock-out">{t('pdp.noShip')}</span>;
  return <span>{t('pdp.days', { a: o.delivery.min, b: o.delivery.max })}</span>;
}

function BuyBox({ m, offer, onPick }: { m: ModelFull; offer: Offer; onPick?: () => void }) {
  const { t, money, country, countryName, toast } = useApp(); const { profile } = useAuth(); const cart = useCart(); const nav = useNavigate();
  const [qty, setQty] = useState(1); const [oc, setOc] = useState<Quote | null>(null); const [busy, setBusy] = useState(false);
  const can = offer.in_stock && offer.ships_to_country;
  const item = { product_id: offer.product_id, qty, slug: m.slug, title: m.title, image: m.image, price: offer.price, seller: offer.seller.name };
  const add = () => { cart.add(item); toast(t('pdp.added')); };
  const buy = () => { cart.add(item); nav('/checkout'); };
  const startOneClick = async () => {
    if (!profile) { nav('/login?next=' + encodeURIComponent(location.pathname)); return; }
    if (!profile.address) { toast(t('pdp.needAddress'), 'err'); nav('/account/profile'); return; }
    setBusy(true);
    try { setOc(await post<Quote>('/api/store/quote', { items: [{ product_id: offer.product_id, qty }], country: profile.address.country })); } catch (e) { toast(errText(t, e), 'err'); }
    setBusy(false);
  };
  const confirmOneClick = async () => {
    if (!oc) return; setBusy(true);
    try {
      const o = await post('/api/store/checkout/one-click', { product_id: offer.product_id, qty, expected_total: oc.total }, { headers: { 'Idempotency-Key': 'oc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) } });
      nav('/order/' + o.code);
    } catch (e) { const er = e as ApiError; toast(er.code === 'price_changed' ? t('err.price_changed') : errText(t, er), 'err'); setOc(null); }
    setBusy(false);
  };
  return (
    <div className="card neon buybox">
      <div className="big">{money(offer.price)}</div>
      {offer.shipping != null && offer.shipping > 0 && <div className="small muted">+ {money(offer.shipping)} {t('pdp.shipping')}</div>}
      {offer.shipping === 0 && !offer.digital && <div className="small stock-ok">{t('pdp.freeShip')}</div>}
      <dl>
        <dt>{t('pdp.deliverTo')}</dt><dd>{countryName(country)}</dd>
        <dt>{t('pdp.delivery')}</dt><dd><Delivery o={offer} /></dd>
        <dt>{t('pdp.soldBy')}</dt><dd>{offer.seller.name} {offer.seller.rating != null && <span className="muted">· ★ {offer.seller.rating}</span>}</dd>
      </dl>
      <div className="mb" style={{ marginBottom: 14 }}>
        {!offer.in_stock ? <span className="stock-out">{t('common.outOfStock')}</span> : offer.low_stock ? <span className="stock-low">{t('pdp.low', { n: offer.low_stock })}</span> : <span className="stock-ok">{t('common.inStock')}</span>}
      </div>
      {can ? (
        <div className="stack">
          {!offer.digital && <div className="row"><Qty value={qty} onChange={setQty} max={Math.min(offer.low_stock || 100, 100)} /></div>}
          <button className="btn btn-primary btn-block btn-lg" onClick={buy}>{t('pdp.buyNow')}</button>
          <button className="btn btn-ghost btn-block" onClick={add}>{t('pdp.addToCart')}</button>
          {!oc && <button className="btn btn-neon btn-block" onClick={startOneClick} disabled={busy}>⚡ {t('pdp.oneClick')}</button>}
          {oc && (
            <div className="notice">
              <b>{t('pdp.confirmOne')}</b>
              <div className="sum mt-s small"><span>{t('cart.subtotal')}</span><span>{money(oc.subtotal)}</span><span>{t('cart.tax')}</span><span>{money(oc.tax)}</span><span>{t('cart.shipping')}</span><span>{money(oc.shipping)}</span><span className="total">{t('cart.total')}</span><span className="total">{money(oc.total)}</span></div>
              <div className="small muted mt-s">{t('pdp.toAddress')}: {profile?.address?.line1}, {profile?.address?.postal} {profile?.address?.city}</div>
              <div className="row mt-s"><button className="btn btn-primary btn-sm grow" onClick={confirmOneClick} disabled={busy || !oc.ok}>{t('pdp.pay', { total: money(oc.total) })}</button><button className="btn btn-ghost btn-sm" onClick={() => setOc(null)}>{t('common.cancel')}</button></div>
              {!oc.ok && <div className="err small mt-s">{t('cart.issues')}</div>}
            </div>
          )}
        </div>
      ) : <div className="notice warn">{offer.sold_in_country === false ? t('pdp.notSoldHere') : !offer.ships_to_country ? t('pdp.noShip') : t('common.outOfStock')}</div>}
      {onPick && <button className="btn btn-ghost btn-sm mt-s" onClick={onPick}>{t('pdp.otherSellers')}</button>}
    </div>
  );
}

// what the law asks a listing to show: who sells (DSA art. 30) and who answers for the product (GPSR) — plus a way to report it
const partyLine = (p: { name: string; address: string | null; email: string | null }) => [p.name, p.address, p.email].filter(Boolean).join(' · ');
function TrustInfo({ offer }: { offer: Offer }) {
  const { t, countryName } = useApp(); const tr = offer.seller.trader, ps = offer.product_safety;
  if (!tr && !ps) return null;
  return (
    <section className="section two-col trust-info" aria-label={t('pdp.trader')}>
      {tr && <div className="card"><h3>{t('pdp.trader')}</h3><dl className="small">
        <dt>{t('pdp.soldBy')}</dt><dd>{tr.name}{tr.address ? ` · ${tr.address}` : ''} · {countryName(tr.country)}</dd>
        {tr.registration_no && <><dt>{t('pdp.traderReg')}</dt><dd>{tr.registry ? tr.registry + ' ' : ''}{tr.registration_no}</dd></>}
        {tr.vat_no && <><dt>{t('pdp.vat')}</dt><dd>{tr.vat_no}</dd></>}
      </dl>{tr.self_certified && <p className="small muted">{t('pdp.selfCert')}</p>}</div>}
      {ps && (ps.manufacturer || ps.responsible_person || ps.identifier || ps.safety_info) && <div className="card"><h3>{t('pdp.safety')}</h3><dl className="small">
        {ps.manufacturer && <><dt>{t('pdp.manufacturer')}</dt><dd>{partyLine(ps.manufacturer)}</dd></>}
        {ps.responsible_person && <><dt>{t('pdp.responsible')}</dt><dd>{partyLine(ps.responsible_person)}</dd></>}
        {ps.identifier && <><dt>{t('pdp.identifier')}</dt><dd>{ps.identifier}</dd></>}
      </dl>{ps.safety_info && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{ps.safety_info}</p>}</div>}
    </section>
  );
}
const REASONS = ['counterfeit', 'unsafe', 'illegal', 'misleading', 'ip', 'other'] as const;
function ReportListing({ productId }: { productId: number }) {
  const { t } = useApp();
  const [reason, setReason] = useState<string>('counterfeit'); const [details, setDetails] = useState(''); const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle'); const [msg, setMsg] = useState<string | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault(); setState('busy'); setMsg(null);
    try { await post('/api/store/report', { product_id: productId, reason, details, email: email || undefined }); setState('sent'); }
    catch (er) { setMsg(errText(t, er)); setState('idle'); }
  };
  return (
    <details className="report mt">
      <summary className="small muted">⚑ {t('pdp.report')}</summary>
      {state === 'sent' ? <p className="notice mt-s" role="status">{t('rep.sent')}</p> : (
        <form className="stack mt-s" onSubmit={send}>
          <label className="small">{t('rep.reason')}
            <select className="input" value={reason} onChange={e => setReason(e.target.value)}>{REASONS.map(r => <option key={r} value={r}>{t('rep.' + r)}</option>)}</select></label>
          <label className="small">{t('rep.details')}<textarea className="input" value={details} onChange={e => setDetails(e.target.value)} minLength={10} maxLength={2000} required /></label>
          <label className="small">{t('rep.email')}<input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={200} /></label>
          {msg && <div className="err small">{msg}</div>}
          <button className="btn btn-ghost btn-sm" disabled={state === 'busy'}>{t('rep.send')}</button>
        </form>)}
    </details>
  );
}

function Reviews({ slug, summary, onChange }: { slug: string; summary: ReviewSummary; onChange: () => void }) {
  const { t, date, toast } = useApp(); const { profile } = useAuth();
  const [items, setItems] = useState<Review[]>([]); const [page, setPage] = useState(1); const [more, setMore] = useState(false);
  const [rating, setRating] = useState(5); const [body, setBody] = useState(''); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const load = (pg: number, replace: boolean) => get(`/api/store/models/${slug}/reviews?page=${pg}`, { auth: null }).then(r => { setItems(x => (replace ? r.items : [...x, ...r.items])); setMore(r.items.length === 10); setPage(pg); }).catch(() => {});
  useEffect(() => { load(1, true); }, [slug]);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { const r = await post(`/api/store/models/${slug}/reviews`, { rating, body }); setBody(''); toast(r.status === 'published' ? t('rev.published') : t('rev.pending')); load(1, true); onChange(); }
    catch (er) { setMsg(errText(t, er)); }
    setBusy(false);
  };
  return (
    <section className="section" id="reviews">
      <h2>{t('rev.title')}</h2>
      <div className="two-col" style={{ gridTemplateColumns: 'minmax(0,320px) minmax(0,1fr)' }}>
        <div className="card">
          <div className="row"><b style={{ fontSize: '2.4rem', fontFamily: 'var(--font-d)' }}>{summary.avg ?? '–'}</b><Stars value={summary.avg} count={summary.count} size={18} /></div>
          <div className="stack mt-s">{[5, 4, 3, 2, 1].map(n => <div key={n} className="hist"><span>{n} ★</span><div className="bar"><i style={{ width: summary.count ? (summary.histogram[n] / summary.count) * 100 + '%' : 0 }} /></div><span>{summary.histogram[n]}</span></div>)}</div>
          <hr className="sep" />
          {profile ? (
            <form onSubmit={submit} className="stack">
              <b>{t('rev.write')}</b>
              <div className="row" role="radiogroup" aria-label={t('rev.rating')}>{[1, 2, 3, 4, 5].map(n => <button type="button" key={n} onClick={() => setRating(n)} aria-checked={rating === n} role="radio" className={'chip ' + (rating === n ? 'on' : '')}>{n} ★</button>)}</div>
              <textarea className="input" value={body} onChange={e => setBody(e.target.value)} placeholder={t('rev.placeholder')} minLength={5} maxLength={3000} required />
              {msg && <div className="err">{msg}</div>}
              <button className="btn btn-primary" disabled={busy}>{t('rev.submit')}</button>
              <div className="small faint">{t('rev.verifiedOnly')}</div>
            </form>
          ) : <Link className="btn btn-ghost btn-block" to={'/login?next=' + encodeURIComponent(location.pathname)}>{t('rev.loginToWrite')}</Link>}
        </div>
        <div>
          {items.length === 0 && <p className="muted">{t('rev.none')}</p>}
          {items.map(r => (
            <article key={r.id} className="review">
              <div className="row between"><Stars value={r.rating} /><span className="small faint">{date(r.created_at)}</span></div>
              <p style={{ margin: '8px 0 6px', whiteSpace: 'pre-wrap' }}>{r.body}</p>
              <div className="small muted">{r.author} {r.verified && <span className="badge ok" style={{ marginLeft: 6 }}>{t('rev.verified')}</span>}</div>
            </article>))}
          {more && <button className="btn btn-ghost mt-s" onClick={() => load(page + 1, false)}>{t('rev.more')}</button>}
        </div>
      </div>
    </section>
  );
}

function ContactBox({ m, offer }: { m: ModelFull; offer: Offer | undefined }) {
  const { t, money } = useApp(); const b2b = m.restricted === 'b2b_licence';
  return (
    <div className="card neon buybox">
      <h3 style={{ marginTop: 0 }}>{t(b2b ? 'pdp.b2bTitle' : 'pdp.contactTitle')}</h3>
      {offer && <div className="big">{money(offer.price)}</div>}
      {offer && <p className="small muted">{offer.seller.name}</p>}
      {b2b && <p className="small muted">{t('pdp.b2bHint')}</p>}
      {offer ? <InquiryForm kind={b2b ? 'b2b_order' : 'contact_seller'} productId={offer.product_id} compact /> : <div className="notice warn">{t('common.outOfStock')}</div>}
    </div>
  );
}

function OtherOffers({ list }: { list: OtherOffer[] }) {
  const { t, money, date } = useApp(); const [broker, setBroker] = useState<number | null>(null);
  return (
    <section className="section" id="other-offers">
      <h2>{t('pdp.other')}</h2><p className="muted small">{t('pdp.otherHint')}</p>
      <div className="table-wrap"><table className="other-offers">
        <thead><tr><th>{t('pdp.source')}</th><th className="hide-m">{t('pdp.delivery')}</th><th>{t('pdp.price')}</th><th /></tr></thead>
        <tbody>{list.map(o => (
          <tr key={o.id}>
            <td><b>{o.source_name}</b>{o.affiliate && <> <small className="tag">{t('pdp.affiliate')}</small></>}<div className="muted small">{t('pdp.checked', { d: date(o.checked_at) })}</div></td>
            <td className="hide-m">{o.delivery_days != null ? t('pdp.inDays', { n: o.delivery_days }) : '—'}</td>
            <td><b>{money(o.landed)}</b>{o.shipping ? <div className="muted small">{money(o.price)} + {money(o.shipping)}</div> : null}</td>
            <td className="num">{o.mode === 'broker'
              ? <button className="btn btn-primary btn-sm" onClick={() => setBroker(b => b === o.id ? null : o.id)}>{t('pdp.viaAsveli')}</button>
              : <a className="btn btn-ghost btn-sm" href={o.url} target="_blank" rel="nofollow sponsored noopener noreferrer">{t('pdp.go')} ↗</a>}</td>
          </tr>))}</tbody>
      </table></div>
      {broker != null && <div className="card mt"><p className="small muted">{t('pdp.brokerHint')}</p><InquiryForm key={broker} kind="broker_order" offerId={broker} compact /></div>}
    </section>
  );
}

export default function Product() {
  const { slug = '' } = useParams(); const { t, money, country, consent, countryName, lang } = useApp(); const { profile } = useAuth();
  const [m, setM] = useState<ModelFull | null>(null); const [err, setErr] = useState<number | null>(null); const [sel, setSel] = useState<number | null>(null);
  const load = () => get<ModelFull>(`/api/store/models/${slug}?country=${country}&lang=${lang}`).then(x => { setM(x); setErr(null); }).catch(e => setErr(e instanceof ApiError ? e.status : 0));
  useEffect(() => { setM(null); setSel(null); load(); }, [slug, country, lang]);
  const bbId = m?.buybox?.product_id;
  useEffect(() => { if (bbId && consent === 'all') post('/api/store/track', { type: 'view', product_id: bbId }).catch(() => {}); }, [bbId, consent, profile?.id]);
  useEffect(() => { if (m) document.title = (m.seo?.title_tag || m.title) + ' — ASVELI'; }, [m]);
  if (err === 404) return <Empty icon="∅" title={t('pdp.notFound')}><Link className="btn btn-primary" to="/search">{t('search.reset')}</Link></Empty>;
  if (err !== null) return <div className="notice err mt">{t('err.load')}</div>;
  if (!m) return <Spinner />;
  const offers = m.offers, win = offers.find(o => o.buybox) || offers[0];
  const shown = (sel != null && offers.find(o => o.product_id === sel)) || win;
  return (
    <>
      <nav className="crumbs" aria-label="breadcrumb"><Link to="/">{t('nav.home')}</Link>{m.category_path && m.category_path.length
        ? m.category_path.map(c => <span key={c.slug}> / <Link to={'/search?cat=' + c.slug}>{c.name}</Link></span>)
        : <> / <Link to={'/search?category=' + encodeURIComponent(m.category)}>{m.category}</Link></>} / <span>{m.title}</span></nav>
      <div className="pdp">
        <Gallery m={m} />
        <div>
          {m.brand && <Link className="small muted" to={'/search?brand=' + encodeURIComponent(m.brand)} style={{ textTransform: 'uppercase', letterSpacing: '.08em' }}>{m.brand}</Link>}
          <h1 style={{ fontSize: 'clamp(1.6rem,3vw,2.2rem)' }}>{m.title}</h1>
          <a href="#reviews" style={{ color: 'inherit', textDecoration: 'none' }}><Stars value={m.reviews_summary.avg} count={m.reviews_summary.count} size={17} /></a>
          <div className="row mt-s">{m.digital && <span className="badge">{t('common.digital')}</span>}{m.offers.length > 1 && <span className="badge cyan">{t('common.nOffers', { n: offers.length })}</span>}</div>
          <p className="muted mt" style={{ whiteSpace: 'pre-wrap' }}>{m.description}</p>
          {shown && <ReportListing productId={shown.product_id} />}
        </div>
        {(m.kind && m.kind !== 'shop') || m.restricted === 'b2b_licence' ? <ContactBox m={m} offer={shown} /> : shown ? <BuyBox m={m} offer={shown} onPick={offers.length > 1 ? () => document.getElementById('offers')?.scrollIntoView({ behavior: 'smooth' }) : undefined} /> : <div className="notice warn">{t('common.outOfStock')}</div>}
      </div>

      {offers.length > 1 && (
        <section className="section" id="offers">
          <h2>{t('pdp.allOffers', { n: offers.length })}</h2>
          <div className="table-wrap"><table className="offers-table">
            <thead><tr><th>{t('pdp.soldBy')}</th><th>{t('pdp.delivery')}</th><th className="num">{t('pdp.price')}</th><th className="num">{t('pdp.shipping')}</th><th /></tr></thead>
            <tbody>{offers.map(o => (
              <tr key={o.product_id} className={o.buybox ? 'win' : ''}>
                <td><b>{o.seller.name}</b> <span className="muted small">· {countryName(o.seller.country)}</span>{o.seller.rating != null && <span className="muted small"> · ★ {o.seller.rating} ({o.seller.reviews})</span>}{o.buybox && <> <span className="badge cyan">{t('pdp.bestOffer')}</span></>}</td>
                <td><Delivery o={o} /></td>
                <td className="num"><b>{money(o.price)}</b></td>
                <td className="num">{o.shipping == null ? '—' : o.shipping === 0 ? t('pdp.free') : money(o.shipping)}</td>
                <td className="num"><button className="btn btn-ghost btn-sm" onClick={() => { setSel(o.product_id); window.scrollTo({ top: 0, behavior: 'smooth' }); }} disabled={!o.in_stock || !o.ships_to_country}>{o.sold_in_country === false ? t('pdp.notSoldHere') : o.in_stock ? t('pdp.choose') : t('common.outOfStock')}</button></td>
              </tr>))}</tbody>
          </table></div>
        </section>
      )}

      {m.other_offers && m.other_offers.length > 0 && <OtherOffers list={m.other_offers} />}
      {shown && <TrustInfo offer={shown} />}
      {m.also_bought.length > 0 && <section className="section"><div className="section-head"><h2>{t('pdp.alsoBought')}</h2></div><div className="rail">{m.also_bought.map(c => <ProductCard key={c.slug} c={c} />)}</div></section>}
      <Reviews slug={m.slug} summary={m.reviews_summary} onChange={load} />
    </>
  );
}
