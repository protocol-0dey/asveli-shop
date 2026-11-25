import { FormEvent, useEffect, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, assetUrl, get, post } from '../api';
import { useApp, useAuth } from '../state';
import type { Order } from '../lib/types';
import { ProductArt } from '../components/ProductArt';
import { Field, Spinner, errText } from '../components/ui';

const STAGES = ['confirmed', 'shipped', 'delivered'];
export const statusBadge = (s: string) => (['delivered'].includes(s) ? 'ok' : ['cancelled', 'refunded'].includes(s) ? 'err' : ['held'].includes(s) ? 'warn' : 'cyan');

export function OrderTimeline({ status }: { status: string }) {
  const { t } = useApp(); const idx = STAGES.indexOf(status);
  if (['cancelled', 'refunded', 'held', 'new'].includes(status)) return <span className={'badge ' + statusBadge(status)}>{t('order.s.' + status)}</span>;
  return <div className="timeline" role="list">{STAGES.map((s, i) => <div key={s} role="listitem" className={'st ' + (i <= idx ? 'done' : '')}>{t('order.s.' + s)}</div>)}</div>;
}

export default function OrderPage() {
  const { code = '' } = useParams(); const [sp] = useSearchParams(); const { t, money, date, toast } = useApp(); const { profile, ready } = useAuth();
  const [o, setO] = useState<Order | null>(null); const [err, setErr] = useState<number | null>(null); const [ret, setRet] = useState<{ pid: number; qty: number; reason: string; note: string } | null>(null); const [busy, setBusy] = useState(false);
  const load = () => get<Order>('/api/store/orders/' + code).then(setO).catch(e => setErr(e instanceof ApiError ? e.status : 0));
  useEffect(() => { if (profile) load(); }, [code, profile?.id]);
  document.title = code + ' — ASVELI';
  if (ready && !profile) return <Navigate to={'/login?next=/order/' + code} replace />;
  if (err) return <div className="notice err mt">{err === 404 ? t('order.notFound') : t('err.load')}</div>;
  if (!o) return <Spinner />;
  const cancel = async () => { if (!confirm(t('order.cancelConfirm'))) return; setBusy(true); try { setO(await post<Order>(`/api/store/orders/${code}/cancel`)); toast(t('order.cancelled')); } catch (e) { toast(errText(t, e), 'err'); } setBusy(false); };
  const sendReturn = async (e: FormEvent) => { e.preventDefault(); if (!ret) return; setBusy(true); try { setO(await post<Order>(`/api/store/orders/${code}/return`, { product_id: ret.pid, qty: ret.qty, reason: ret.reason, note: ret.note || undefined })); setRet(null); toast(t('order.returnSent')); } catch (x) { toast(errText(t, x), 'err'); } setBusy(false); };
  return (
    <>
      {sp.get('new') && <div className="card neon mt"><h1 style={{ fontSize: '1.6rem' }}>✓ {t('order.thanks')}</h1><p className="muted" style={{ margin: 0 }}>{t('order.thanksSub')}</p></div>}
      <div className="row between mt"><h1 style={{ fontSize: '1.6rem', margin: 0 }}>{t('order.title', { code: o.code })}</h1><span className="muted">{date(o.created_at)}</span></div>
      <div className="two-col">
        <div className="stack">
          <section className="card"><OrderTimeline status={o.status} />
            {o.status === 'held' && <div className="notice warn small">{t('order.heldHint')}</div>}
            {o.shipments.map(s => <div key={s.id} className="row between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 10 }}>
              <span>{t('order.parcel')} #{s.id} · <span className={'badge ' + (s.status === 'delivered' ? 'ok' : 'cyan')}>{t('ship.' + s.status)}</span>{s.carrier && <span className="muted"> · {s.carrier}</span>}</span>
              {s.tracking_no ? (s.tracking_url ? <a href={s.tracking_url} target="_blank" rel="noopener noreferrer">{t('order.track')}: {s.tracking_no} ↗</a> : <span>{t('order.track')}: <b>{s.tracking_no}</b></span>) : <span className="muted">{t('order.noTracking')}</span>}</div>)}
          </section>
          <section className="card">
            <h3>{t('checkout.items')}</h3>
            {o.items.map(i => { const img = assetUrl(i.image); return (
              <div className="line" key={i.product_id}>
                <Link to={'/p/' + i.slug} className="thumb">{img ? <img src={img} alt="" /> : <ProductArt seed={i.slug} category="" />}</Link>
                <div><Link to={'/p/' + i.slug} style={{ color: 'inherit', fontWeight: 600 }}>{i.title}</Link><div className="small muted">{i.qty} × {money(i.unit_price)} · {i.seller}</div>
                  {i.download && <a className="btn btn-neon btn-sm mt-s" href={i.download.url} download>⬇ {i.download.name}</a>}
                  {i.returned_qty > 0 && <div className="small stock-low">{t('order.returned', { n: i.returned_qty })}</div>}
                  {o.status === 'delivered' && <div className="row mt-s"><Link className="small" to={`/p/${i.slug}#reviews`}>{t('order.review')}</Link></div>}</div>
                <b>{money(i.unit_price * i.qty)}</b>
              </div>); })}
          </section>
          {o.returns.length > 0 && <section className="card"><h3>{t('order.returns')}</h3>{o.returns.map(r => <div key={r.id} className="row between small"><span>#{r.id} · {r.qty} × · {t('ret.' + r.reason)}</span><span className="badge cyan">{t('ret.s.' + r.status)}{r.refund_amount ? ` · ${money(r.refund_amount)}` : ''}</span></div>)}</section>}
        </div>
        <aside className="card sticky">
          <h3>{t('cart.summary')}</h3>
          <div className="sum"><span>{t('cart.subtotal')}</span><span>{money(o.subtotal)}</span>{o.discount > 0 && <><span>{t('cart.discount')}{o.coupon ? ` (${o.coupon})` : ''}</span><span>−{money(o.discount)}</span></>}<span>{t('cart.tax')}</span><span>{money(o.tax)}</span><span>{t('cart.shipping')}</span><span>{money(o.shipping)}</span><span className="total">{t('cart.total')}</span><span className="total">{money(o.total)}</span></div>
          <div className="stack mt">
            {o.can_cancel && <button className="btn btn-danger btn-block" onClick={cancel} disabled={busy}>{t('order.cancel')}</button>}
            {o.can_return && !ret && <button className="btn btn-ghost btn-block" onClick={() => setRet({ pid: o.items[0].product_id, qty: 1, reason: 'changed_mind', note: '' })}>{t('order.return')}</button>}
          </div>
          {ret && (
            <form className="stack mt" onSubmit={sendReturn}>
              <Field label={t('order.returnItem')}><select className="input" value={ret.pid} onChange={e => setRet({ ...ret, pid: +e.target.value })}>{o.items.map(i => <option key={i.product_id} value={i.product_id}>{i.title}</option>)}</select></Field>
              <Field label={t('f.qty')}><input className="input" type="number" min={1} max={100} value={ret.qty} onChange={e => setRet({ ...ret, qty: Math.max(1, +e.target.value || 1) })} /></Field>
              <Field label={t('order.reason')}><select className="input" value={ret.reason} onChange={e => setRet({ ...ret, reason: e.target.value })}>{['defective', 'not_as_described', 'changed_mind', 'damaged_in_transit', 'other'].map(r => <option key={r} value={r}>{t('ret.' + r)}</option>)}</select></Field>
              <Field label={t('f.note')}><textarea className="input" value={ret.note} maxLength={200} onChange={e => setRet({ ...ret, note: e.target.value })} /></Field>
              <div className="row"><button className="btn btn-primary btn-sm" disabled={busy}>{t('order.sendReturn')}</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setRet(null)}>{t('common.cancel')}</button></div>
            </form>)}
        </aside>
      </div>
    </>
  );
}
