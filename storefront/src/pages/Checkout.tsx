import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, post } from '../api';
import { useApp, useAuth, useCart } from '../state';
import type { Address } from '../lib/types';
import { Field, errText } from '../components/ui';
import { Totals, useQuote } from './Cart';

const PAYMENTS = ['pay_on_delivery', 'bank_transfer'];
export default function Checkout() {
  const { t, money, countries, countryName, country, toast } = useApp(); const { profile, ready, refresh } = useAuth(); const cart = useCart(); const nav = useNavigate(); const [sp] = useSearchParams();
  const [a, setA] = useState<Address & { name: string; phone: string }>({ name: '', phone: '', line1: '', postal: '', city: '', country });
  const [payment, setPayment] = useState('pay_on_delivery'); const [save, setSave] = useState(true); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const coupon = sp.get('coupon') || ''; const idem = useRef('ck' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  useEffect(() => { if (profile) setA(x => ({ name: profile.name || x.name, phone: profile.phone || x.phone, line1: profile.address?.line1 || '', postal: profile.address?.postal || '', city: profile.address?.city || '', country: profile.address?.country || profile.country || country })); }, [profile?.id]);
  const { q, loading } = useQuote(a.country, coupon);
  document.title = t('checkout.title') + ' — ASVELI';
  if (!ready) return null;
  if (!profile) return <Navigate to="/login?next=/checkout" replace />;
  if (!cart.items.length) return <Navigate to="/cart" replace />;
  const set = (k: keyof typeof a) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setA({ ...a, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!q || !q.ok) return; setBusy(true); setMsg(null);
    try {
      const o = await post('/api/store/checkout', { items: cart.items.map(i => ({ product_id: i.product_id, qty: i.qty })), address: a, payment, coupon: coupon || undefined, expected_total: q.total, save_address: save }, { headers: { 'Idempotency-Key': idem.current } });
      cart.clear(); refresh(); nav('/order/' + o.code + '?new=1');
    } catch (er) {
      const x = er as ApiError;
      if (x.code === 'price_changed') { setMsg(t('err.price_changed')); idem.current = 'ck' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
      else setMsg(errText(t, x));
      toast(t('checkout.failed'), 'err');
    }
    setBusy(false);
  };
  return (
    <>
      <h1 className="mt">{t('checkout.title')}</h1>
      <div className="steps" aria-hidden><div>1 · {t('menu.cart')}</div><div className="on">2 · {t('checkout.delivery')}</div><div>3 · {t('checkout.done')}</div></div>
      <form className="two-col" onSubmit={submit}>
        <div className="stack">
          <section className="card">
            <h3>{t('checkout.address')}</h3>
            <div className="form-grid">
              <Field label={t('f.name')}><input className="input" required value={a.name} onChange={set('name')} autoComplete="name" maxLength={80} /></Field>
              <Field label={t('f.phone')}><input className="input" value={a.phone} onChange={set('phone')} autoComplete="tel" inputMode="tel" maxLength={30} /></Field>
              <Field label={t('f.line1')} className="full"><input className="input" required value={a.line1} onChange={set('line1')} autoComplete="address-line1" maxLength={120} /></Field>
              <Field label={t('f.postal')}><input className="input" required value={a.postal} onChange={set('postal')} autoComplete="postal-code" maxLength={12} /></Field>
              <Field label={t('f.city')}><input className="input" required value={a.city} onChange={set('city')} autoComplete="address-level2" maxLength={60} /></Field>
              <Field label={t('f.country')} className="full"><select className="input" value={a.country} onChange={set('country')} autoComplete="country">{countries.map(c => <option key={c} value={c}>{countryName(c)}</option>)}</select></Field>
            </div>
            <label className="check mt-s"><input type="checkbox" checked={save} onChange={e => setSave(e.target.checked)} />{t('checkout.saveAddr')}</label>
          </section>
          <section className="card">
            <h3>{t('checkout.payment')}</h3>
            <div className="stack">{PAYMENTS.map(p => <label key={p} className="check"><input type="radio" name="pay" checked={payment === p} onChange={() => setPayment(p)} /><span><b>{t('pay.' + p)}</b><div className="small muted">{t('pay.' + p + '.hint')}</div></span></label>)}</div>
            <div className="notice mt-s small">{t('checkout.noCard')}</div>
          </section>
          <section className="card">
            <h3>{t('checkout.items')}</h3>
            {q?.lines.map(l => <div key={l.product_id} className="row between small" style={{ padding: '6px 0' }}><span>{l.qty} × {l.title} <span className="muted">· {l.seller}</span></span><b>{money(l.line_total)}</b></div>)}
          </section>
        </div>
        <aside className="card neon sticky">
          <h3>{t('cart.summary')}</h3>
          {q ? <Totals q={q} /> : <div className="skeleton" style={{ height: 120 }} />}
          {q && q.issues.length > 0 && <div className="notice warn mt-s small">{t('cart.issues')} <Link to="/cart">{t('menu.cart')}</Link></div>}
          {msg && <div className="err mt-s">{msg}</div>}
          <button className="btn btn-primary btn-block btn-lg mt" disabled={busy || loading || !q?.ok}>{busy ? '…' : t('checkout.place', { total: q ? money(q.total) : '' })}</button>
          <p className="small faint mt-s">{t('checkout.terms')} <Link to="/info/terms">{t('footer.terms')}</Link></p>
        </aside>
      </form>
    </>
  );
}
