import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import App from './App';
import { renderApp, mockFetch } from './test/utils';

const cfg = { '/api/store/config': { currency: 'EUR', countries: ['PL', 'DE'] } };
describe('routing', () => {
  it('unknown routes show the 404 page with a way home', async () => {
    mockFetch(cfg); renderApp(<App />, '/definitely/not/here');
    expect(await screen.findByText('404')).toBeInTheDocument(); expect(screen.getByRole('link', { name: /home|start|główna/i })).toHaveAttribute('href', '/');
  });
  it('login page renders a form with e-mail and password', async () => {
    mockFetch(cfg); renderApp(<App />, '/login');
    await waitFor(() => expect(document.querySelector('input[type=password]')).toBeInTheDocument()); expect(document.querySelector('input[type=email]')).toBeInTheDocument();
  });
});
