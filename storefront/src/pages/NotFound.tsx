import { Link } from 'react-router-dom';
import { useApp } from '../state';
import { Empty } from '../components/ui';
export default function NotFound() { const { t } = useApp(); return <Empty icon="404" title={t('err.404')}><Link className="btn btn-primary mt" to="/">{t('common.home')}</Link></Empty>; }
