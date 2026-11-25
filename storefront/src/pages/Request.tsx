import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get } from '../api';
import { useApp } from '../state';
import type { CatNode } from '../lib/types';
import { InquiryForm } from '../components/Inquiry';

// every node whose effective kind is "rfq" (construction work, rental, logistics…), flattened with its parent's name
const rfqNodes = (ns: CatNode[], parent = ''): { slug: string; name: string }[] =>
  ns.flatMap(n => [...(n.kind === 'rfq' ? [{ slug: n.slug, name: parent ? parent + ' › ' + n.name : n.name }] : []), ...rfqNodes(n.children, n.name)]);

export default function Request() {
  const { t, lang } = useApp(); const [sp, setSp] = useSearchParams();
  const [opts, setOpts] = useState<{ slug: string; name: string }[]>([]);
  useEffect(() => { get<{ tree: CatNode[] }>('/api/store/categories/tree?lang=' + lang, { auth: null }).then(r => setOpts(rfqNodes(r.tree))).catch(() => {}); }, [lang]);
  const cat = sp.get('cat') || opts[0]?.slug || '';
  useEffect(() => { document.title = t('rfq.title') + ' — ASVELI'; }, [t]);
  return (
    <div style={{ maxWidth: 760, margin: '28px auto' }}>
      <h1>{t('rfq.title')}</h1>
      <p className="muted">{t('rfq.ctaText')}</p>
      <div className="card mt stack">
        <label className="field"><span>{t('rfq.category')}</span>
          <select className="input" value={cat} onChange={e => setSp({ cat: e.target.value }, { replace: true })}>{opts.map(o => <option key={o.slug} value={o.slug}>{o.name}</option>)}</select></label>
        {cat && <InquiryForm key={cat} kind="rfq" category={cat} />}
      </div>
    </div>
  );
}
