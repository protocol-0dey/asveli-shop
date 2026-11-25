import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api';
import { useApp } from '../state';
import type { Inquiry } from '../lib/types';
import { Empty, Spinner, errText } from './ui';

/* Messages that go through the platform. The same inbox serves buyers (/api/store/inquiries) and sellers (/api/seller/inquiries). */
export function Inbox({ base, me, id, open, empty }: { base: string; me: 'buyer' | 'seller'; id: number | null; open: (id: number | null) => void; empty?: string }) {
  const { t, date } = useApp(); const [list, setList] = useState<Inquiry[] | null>(null);
  const loadList = useCallback(() => { get<{ items: Inquiry[] }>(base).then(r => setList(r.items)).catch(() => setList([])); }, [base]);
  useEffect(() => { loadList(); }, [loadList]);
  if (!list) return <Spinner />;
  if (!list.length) return <Empty title={empty || t('msg.none')} />;
  const peer = (q: Inquiry) => (me === 'seller' ? q.buyer || t('msg.seller') : q.with === 'ASVELI' ? t('msg.staff') : q.with);
  return (
    <div className="inbox">
      <div className="inbox-list" style={id != null ? undefined : undefined}>
        {list.map(q => (
          <button key={q.id} className={q.id === id ? 'on' : ''} onClick={() => open(q.id)}>
            <span className="row between"><b style={{ fontSize: '.92rem' }}>{q.subject}</b><span className="small muted">{date(q.last_message_at || q.created_at || Date.now())}</span></span>
            <span className="small muted">{t('msg.kind.' + q.kind)} · {t('msg.with', { w: peer(q) })}</span>
            <span className="small"><span className={'badge ' + (q.status === 'answered' ? 'ok' : q.status === 'closed' ? '' : 'warn')}>{t('msg.status.' + q.status)}</span></span>
            {q.last && <span className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.last.body}</span>}
          </button>))}
      </div>
      {id != null ? <Thread key={id} base={base} me={me} id={id} onSent={loadList} peer={peer} /> : <div className="muted small" style={{ alignSelf: 'center' }}>←</div>}
    </div>
  );
}

function Thread({ base, me, id, onSent, peer }: { base: string; me: 'buyer' | 'seller'; id: number; onSent: () => void; peer: (q: Inquiry) => string }) {
  const { t, date } = useApp(); const [q, setQ] = useState<Inquiry | null>(null); const [body, setBody] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { get<Inquiry>(`${base}/${id}`).then(setQ).catch(() => setErr(t('err.load'))); }, [base, id, t]);
  useEffect(() => { load(); }, [load]);
  const send = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await post(`${base}/${id}/messages`, { body }); setBody(''); load(); onSent(); } catch (x) { setErr(errText(t, x)); } finally { setBusy(false); }
  };
  if (!q) return err ? <div className="notice err">{err}</div> : <Spinner />;
  const who = (a: string) => (a === me ? t('msg.you') : a === 'staff' ? t('msg.staff') : peer(q));
  return (
    <section className="card thread" aria-label={q.subject}>
      <div><b>{q.subject}</b><div className="small muted">{t('msg.kind.' + q.kind)}{q.product && <> · <Link to={'/p/' + q.product.slug}>{q.product.title}</Link></>}{q.quantity && <> · {q.quantity}</>}{q.location && <> · {q.location}</>}{q.company && <> · {q.company}</>}</div></div>
      {(q.messages || []).map((m, i) => <div key={i} className={'bubble' + (m.author === me ? ' me' : '')}><small>{who(m.author)} · {date(m.at)}</small>{m.body}</div>)}
      {q.status !== 'closed' && (
        <form className="stack" onSubmit={send}>
          <textarea className="input" rows={3} value={body} onChange={e => setBody(e.target.value)} minLength={1} maxLength={2000} required aria-label={t('msg.send')} />
          {err && <div className="err small" role="alert">{err}</div>}
          <div><button className="btn btn-primary btn-sm" disabled={busy}>{t('msg.send')}</button></div>
        </form>)}
    </section>
  );
}
