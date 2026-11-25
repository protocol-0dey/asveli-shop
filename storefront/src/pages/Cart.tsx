import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { post } from '../api';
import { useApp, useAuth, useCart } from '../state';
import type { Quote } from '../lib/types';
import { ProductArt } from '../components/ProductArt';
import { Empty, Qty, errText } from '../components/ui';
import { assetUrl } from '../api';

export function useQuote(country: string, coupon: string) {
  const cart = useCart(); const [q, setQ] = useState<Quote | null>(null); const [loading, setLoading] = useState(false); const [error, setError] = useState<any>(null);
  const key = cart.items.map(i => i.product_id + ':' + i.qty).join(',') + '|' + country + '|' + coupon;
  useEffect(() => {
    if (!cart.items.length) { setQ(null); return; }
    let alive = true; setLoading(true);
    const id = setTimeout(() => {
      post<Quote>('/api/store/quote', { items: cart.items.map(i => ({ product_id: i.product_id, qty: i.qty })), country, coupon: coupon || undefined })
        .then(r => { if (alive) { setQ(r); setError(null); } }).catch(e => { if (alive) setError(e); }).finally(() => alive && setLoading(false));
    }, 200);
    return () => { alive = false; clearTimeout(id); };
  }, [key]);
  return { q, loading, error };
}

export function Totals({ q }: { q: Quote }) {
  const { t, money } = useApp();
  return (
    <div className="sum">
      <span>{t('cart.subtotal')}</span><span>{money(q.subtotal)}</span>
      {q.discount > 0 && <><span className="stock-ok">{t('cart.discount')}{q.coupon ? ` (${q.coupon.code})` : ''}</span><span className="stock-ok">−{money(q.discount)}</span></>}
      <span>{t('cart.tax')} ({(q.tax_rate_bps / 100).toFixed(0)}%)</span><span>{money(q.tax)}</span>
      <span>{t('cart.shipping')}</span><span>{q.shipments === 0 ? t('pdp.free') : money(q.shipping)}</span>
      <span className="total">{t('cart.total')}</span><span className="total">{money(q.total)}</span>
    </div>
  );
}

export default function Cart() {
  const { t, money, country } = useApp(); const { profile } = useAuth(); const cart = useCart(); const nav = useNavigate();
  const [coupon, setCoupon] = useState(''); const [applied, setApplied] = useState('');
  const dest = profile?.address?.country || country;
  const { q, loading, error } = useQuote(dest, applied);
  document.title = t('menu.cart') + ' — ASVELI';
  if (!cart.items.length) return <Empty icon="🛒" title={t('cart.empty')}><Link className="btn btn-primary" to="/search">{t('home.cta')}</Link></Empty>;
  const lineOf = (id: number) => q?.lines.find(l => l.product_id === id);
  const issue = (id: number) => q?.issues.find(i => i.product_id === id);
  return (
    <>
      <h1 className="mt">{t('menu.cart')}</h1>
      <div className="two-col">
        <div className="card">
          {cart.items.map(i => {
            const l = lineOf(i.product_id), is = issue(i.product_id), unit = l ? l.unit_price : i.price, img = assetUrl(i.image);
            return (
              <div className="line" key={i.product_id}>
                <Link to={'/p/' + i.slug} className="thumb">{img ? <img src={img} alt="" /> : <ProductArt seed={i.slug} category="" />}</Link>
                <div><Link to={'/p/' + i.slug} style={{ color: 'inherit', fontWeight: 600 }}>{i.title}</Link><div className="small muted">{t('pdp.soldBy')} {i.seller}</div>
                  {l && l.unit_price !== i.price && <div className="small stock-low">{t('cart.priceChanged', { old: money(i.price), now: money(l.unit_price) })}</div>}
                  {is && <div className="small err">{t('cart.issue.' + is.code)}</div>}
                  <button className="btn btn-sm btn-ghost mt-s" onClick={() => cart.remove(i.product_id)}>{t('cart.remove')}</button></div>
                <div style={{ textAlign: 'right' }}><div className="price">{money(unit * i.qty)}</div>{l?.digital ? <span className="badge">{t('common.digital')}</span> : <Qty value={i.qty} onChange={n => cart.setQty(i.product_id, n)} />}</div>
              </div>
            );
          })}
        </div>
        <aside className="card sticky">
          <h3>{t('cart.summary')}</h3>
          {error && <div className="err">{errText(t, error)}</div>}
          {q ? <Totals q={q} /> : <div className="skeleton" style={{ height: 120 }} />}
          <form className="row mt" onSubmit={e => { e.preventDefault(); setApplied(coupon.trim().toUpperCase()); }} style={{ flexWrap: 'nowrap' }}>
            <input className="input" value={coupon} onChange={e => setCoupon(e.target.value)} placeholder={t('cart.coupon')} aria-label={t('cart.coupon')} maxLength={30} />
            <button className="btn btn-ghost">{t('search.apply')}</button>
          </form>
          {q?.coupon_error && <div className="err small mt-s">{t('err.' + q.coupon_error)}</div>}
          <div className="small muted mt-s">{t('cart.deliverTo', { c: dest })}</div>
          <button className="btn btn-primary btn-block btn-lg mt" disabled={!q?.ok || loading} onClick={() => (profile ? nav('/checkout' + (applied ? '?coupon=' + applied : '')) : nav('/login?next=/checkout' + encodeURIComponent(applied ? '?coupon=' + applied : '')))}>{t('cart.checkout')}</button>
          {q && !q.ok && q.lines.length > 0 && <div className="notice warn mt-s small">{t('cart.issues')}</div>}
        </aside>
      </div>
    </>
  );
}
