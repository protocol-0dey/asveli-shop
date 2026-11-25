import { describe, it, expect } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useApp } from './state';
import { renderApp, mockFetch } from './test/utils';

function Probe() {
  const { money, lang, setLang, consent, setConsent, t } = useApp();
  return <div><span data-testid="m">{money(12345)}</span><span data-testid="l">{lang}</span><span data-testid="c">{String(consent)}</span><span data-testid="t">{t('common.home')}</span>
    <button onClick={() => setLang('de')}>de</button><button onClick={() => setConsent('essential')}>ess</button></div>;
}
describe('AppProvider', () => {
  it('formats money using the currency from /api/store/config', async () => {
    mockFetch({ '/api/store/config': { currency: 'PLN', countries: ['PL'] } }); localStorage.setItem('asv_lang', 'pl');
    renderApp(<Probe />);
    await waitFor(() => expect(screen.getByTestId('m').textContent).toMatch(/123,45/)); expect(screen.getByTestId('m').textContent).toMatch(/zł|PLN/);
  });
  it('persists the language and changes copy', async () => {
    mockFetch({ '/api/store/config': { currency: 'EUR', countries: ['PL'] } }); localStorage.setItem('asv_lang', 'en');
    renderApp(<Probe />); const before = screen.getByTestId('t').textContent;
    await userEvent.click(screen.getByText('de'));
    expect(screen.getByTestId('l')).toHaveTextContent('de'); expect(localStorage.getItem('asv_lang')).toBe('de'); expect(screen.getByTestId('t').textContent).not.toBe(before);
  });
  it('withdrawing consent deletes the pseudonymous id', async () => {
    mockFetch({ '/api/store/config': { currency: 'EUR', countries: ['PL'] } });
    localStorage.setItem('asv_consent', 'all'); localStorage.setItem('asv_anon', 'x'.repeat(24));
    renderApp(<Probe />); await userEvent.click(screen.getByText('ess'));
    expect(localStorage.getItem('asv_anon')).toBeNull(); expect(screen.getByTestId('c')).toHaveTextContent('essential');
  });
  it('survives a failing config request', async () => { globalThis.fetch = (async () => { throw new Error('x'); }) as any; await act(async () => { renderApp(<Probe />); }); expect(screen.getByTestId('m')).toBeInTheDocument(); });
});
