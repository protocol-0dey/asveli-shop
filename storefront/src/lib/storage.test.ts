import { describe, it, expect, vi } from 'vitest';
import { store } from './storage';

describe('store', () => {
  it('round-trips values and JSON', () => {
    store.set('a', '1'); expect(store.get('a')).toBe('1');
    localStorage.setItem('j', '{"x":2}'); expect(store.json('j', { x: 0 })).toEqual({ x: 2 });
    store.del('a'); expect(store.get('a')).toBeNull();
  });
  it('returns the default for corrupt JSON', () => { localStorage.setItem('bad', '{oops'); expect(store.json('bad', [1])).toEqual([1]); });
  it('never throws when storage is blocked (private mode)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(store.get('x')).toBeNull(); expect(() => store.set('x', '1')).not.toThrow(); expect(store.json('x', 5)).toBe(5);
    spy.mockRestore(); set.mockRestore();
  });
});
