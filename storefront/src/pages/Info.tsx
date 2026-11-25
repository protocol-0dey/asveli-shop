import { Link, useParams } from 'react-router-dom';
import { useApp } from '../state';
import NotFound from './NotFound';

// Plain-language operating terms. These are a starting point and MUST be reviewed by a lawyer before launch.
const PAGES = ['about', 'shipping', 'returns', 'terms', 'privacy'];
export default function Info() {
  const { page = '' } = useParams(); const { t } = useApp();
  if (!PAGES.includes(page)) return <NotFound />;
  const n = Number(t(`info.${page}.n`)) || 4;
  document.title = t(`info.${page}.title`) + ' — ASVELI';
  return (
    <article className="prose mt">
      <h1>{t(`info.${page}.title`)}</h1>
      {Array.from({ length: n }, (_, i) => <div key={i}><h3>{t(`info.${page}.h${i + 1}`)}</h3><p>{t(`info.${page}.p${i + 1}`)}</p></div>)}
      <p className="small muted">{t('info.contact')} <a href="mailto:info@asveli.org">info@asveli.org</a> · <Link to="/">← {t('common.home')}</Link></p>
    </article>
  );
}
