import { FormEvent, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { post } from '../api';
import { useApp, useAuth } from '../state';
import { errText } from './ui';

type Kind = 'contact_seller' | 'b2b_order' | 'broker_order' | 'rfq';
/* One form for every conversation that goes through the platform. Contact details are never asked for or shown. */
export function InquiryForm({ kind, productId, offerId, category, compact }: { kind: Kind; productId?: number; offerId?: number; category?: string; compact?: boolean }) {
  const { t } = useApp(); const { profile } = useAuth(); const loc = useLocation();
  const [f, setF] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [sent, setSent] = useState<number | null>(null);
  const v = (k: string) => f[k] || ''; const on = (k: string) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }));
  if (!profile) return <Link className="btn btn-primary" to={'/login?next=' + encodeURIComponent(loc.pathname + loc.search)}>{t(kind === 'rfq' ? 'rfq.login' : 'pdp.loginToContact')}</Link>;
  if (sent) return <div className="notice" role="status">{t(kind === 'rfq' ? 'rfq.sent' : 'pdp.contactSent')} <Link to={'/account/messages/' + sent}>{t('menu.messages')} →</Link></div>;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = { kind, message: v('message') };
      if (productId) body.product_id = productId; if (offerId) body.external_offer_id = offerId; if (category) body.category = category;
      for (const k of ['subject', 'quantity', 'location', 'deadline', 'company', 'vat_no', 'licence_no']) if (v(k)) body[k] = v(k);
      if (v('budget')) body.budget = Math.round(+v('budget') * 100);
      const r = await post<{ id: number }>('/api/store/inquiries', body); setSent(r.id);
    } catch (er) { setErr(errText(t, er)); } finally { setBusy(false); }
  };
  const b2b = kind === 'b2b_order' || kind === 'broker_order';
  return (
    <form className="stack" onSubmit={submit}>
      {kind === 'rfq' && <label className="field"><span>{t('rfq.subject')}</span><input className="input" value={v('subject')} onChange={on('subject')} maxLength={160} /></label>}
      {(kind === 'rfq' || b2b) && <div className="form-grid">
        <label className="field"><span>{t(kind === 'rfq' ? 'rfq.quantity' : 'pdp.quantity')}</span><input className="input" value={v('quantity')} onChange={on('quantity')} maxLength={80} required={kind === 'b2b_order'} /></label>
        <label className="field"><span>{t('rfq.location')}</span><input className="input" value={v('location')} onChange={on('location')} maxLength={160} /></label>
        {kind === 'rfq' && <><label className="field"><span>{t('rfq.deadline')}</span><input className="input" type="date" value={v('deadline')} onChange={on('deadline')} /></label>
          <label className="field"><span>{t('rfq.budget')}</span><input className="input" inputMode="decimal" value={v('budget')} onChange={e => setF(x => ({ ...x, budget: e.target.value.replace(/[^\d.]/g, '') }))} /></label></>}
      </div>}
      {b2b && <div className="form-grid">
        <label className="field"><span>{t('pdp.company')}</span><input className="input" value={v('company')} onChange={on('company')} maxLength={160} required={kind === 'b2b_order'} /></label>
        <label className="field"><span>{t('pdp.vat')}</span><input className="input" value={v('vat_no')} onChange={on('vat_no')} maxLength={20} required={kind === 'b2b_order'} /></label>
        {kind === 'b2b_order' && <label className="field"><span>{t('pdp.licence')}</span><input className="input" value={v('licence_no')} onChange={on('licence_no')} maxLength={60} required /></label>}
      </div>}
      <label className="field"><span>{t(kind === 'rfq' ? 'rfq.message' : 'pdp.message')}</span><textarea className="input" rows={compact ? 3 : 5} value={v('message')} onChange={on('message')} minLength={10} maxLength={2000} required /></label>
      {err && <div className="err small" role="alert">{err}</div>}
      <p className="muted small" style={{ margin: 0 }}>{t('pdp.contactHint')}</p>
      <button className="btn btn-primary" disabled={busy}>{t(kind === 'rfq' ? 'rfq.send' : kind === 'contact_seller' ? 'pdp.contactSend' : 'rfq.send')}</button>
    </form>
  );
}
