import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Qty, Stars, Empty } from './ui';
import { renderApp, mockFetch } from '../test/utils';

describe('ui components', () => {
  it('Qty respects min and max', async () => {
    mockFetch({ '/api/store/config': { currency: 'EUR', countries: ['PL'] } });
    const on = vi.fn(); const { rerender } = renderApp(<Qty value={1} onChange={on} min={1} max={3} />);
    await userEvent.click(screen.getByLabelText('−')); expect(on).toHaveBeenLastCalledWith(1);
    await userEvent.click(screen.getByLabelText('+')); expect(on).toHaveBeenLastCalledWith(2);
    rerender(<Qty value={3} onChange={on} min={1} max={3} />);
  });
  it('Stars shows the rating and a placeholder when unrated', async () => {
    mockFetch({ '/api/store/config': { currency: 'EUR', countries: ['PL'] } });
    renderApp(<><Stars value={4.4} count={12} /><Stars value={null} /></>);
    expect(screen.getByLabelText('4.4 / 5')).toHaveTextContent('4.4 (12)');
    await waitFor(() => expect(document.querySelector('.faint')).toBeInTheDocument());
  });
  it('Empty renders title and children', () => { renderApp(<Empty title="Nothing"><button>Go</button></Empty>); expect(screen.getByText('Nothing')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument(); });
});
