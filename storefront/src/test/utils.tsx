import { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider, AuthProvider, CartProvider } from '../state';

// the config endpoint is the only call AppProvider makes on mount
export function mockFetch(routes: Record<string, unknown | ((init?: RequestInit) => unknown)> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(routes).find(k => String(url).includes(k));
    const body = key ? (typeof routes[key] === 'function' ? (routes[key] as any)(init) : routes[key]) : { error: 'not_found' };
    const status = key ? ((body as any)?.__status ?? 200) : 404;
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}
export const renderApp = (ui: ReactElement, route = '/') => render(<MemoryRouter initialEntries={[route]}><AppProvider><AuthProvider><CartProvider>{ui}</CartProvider></AuthProvider></AppProvider></MemoryRouter>);
