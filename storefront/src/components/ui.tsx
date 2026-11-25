import { ReactNode } from 'react';
import { useApp } from '../state';

export function Stars({ value, count, size = 15 }: { value: number | null; count?: number; size?: number }) {
  const { t } = useApp();
  if (value == null) return <span className="stars faint">{t('common.noReviews')}</span>;
  const full = Math.round(value);
  return (
    <span className="stars" aria-label={`${value} / 5`}>
      <span className="s">{[1, 2, 3, 4, 5].map(i => (
        <svg key={i} viewBox="0 0 20 20" width={size} height={size} aria-hidden><path d="M10 1.8l2.5 5.3 5.8.8-4.2 4.1 1 5.8L10 15l-5.1 2.8 1-5.8L1.7 7.9l5.8-.8z" fill={i <= full ? '#fbbf24' : 'none'} stroke={i <= full ? '#fbbf24' : '#566'} strokeWidth="1.2" /></svg>))}
      </span>
      <span>{value.toFixed(1)}{count != null ? ` (${count})` : ''}</span>
    </span>
  );
}
export function Empty({ icon = '✦', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return <div className="empty"><div className="big" aria-hidden>{icon}</div><h3>{title}</h3>{children}</div>;
}
export function Qty({ value, onChange, min = 1, max = 100 }: { value: number; onChange: (n: number) => void; min?: number; max?: number }) {
  return (
    <div className="qty" role="group">
      <button type="button" aria-label="−" onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <span>{value}</span>
      <button type="button" aria-label="+" onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </div>
  );
}
export function Spinner() { return <div className="center muted" style={{ padding: 40 }} role="status">…</div>; }
export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <label className={'field ' + (className || '')}><span>{label}</span>{children}{hint && <div className="hint">{hint}</div>}</label>;
}
export const errText = (t: (k: string, v?: any) => string, e: any) => {
  const code = e?.code || 'error';
  const k = 'err.' + code; const s = t(k);
  return s === k ? t('err.generic') + (code && code !== 'error' ? ` (${code})` : '') : s;
};
