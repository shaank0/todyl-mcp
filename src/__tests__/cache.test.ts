import { describe, it, expect, vi } from 'vitest';
import { createCache } from '../cache.js';

describe('createCache', () => {
  it('loads on miss and serves the cached value within the TTL', async () => {
    let clock = 1_000_000;
    const cache = createCache<number>(300, () => clock);
    const load = vi.fn(async () => 42);

    const first = await cache.get('k', load);
    expect(first.value).toBe(42);
    expect(first.fromCache).toBe(false);

    clock += 100_000; // 100s later, inside the 300s TTL
    const second = await cache.get('k', load);
    expect(second.value).toBe(42);
    expect(second.fromCache).toBe(true);
    expect(second.ageSeconds).toBe(100);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads once the TTL expires', async () => {
    let clock = 0;
    const cache = createCache<number>(300, () => clock);
    const load = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);

    expect((await cache.get('k', load)).value).toBe(1);
    clock += 301_000;
    expect((await cache.get('k', load)).value).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent misses into ONE load', async () => {
    const cache = createCache<number>(300, () => 0);
    let resolve!: (v: number) => void;
    const load = vi.fn(() => new Promise<number>((r) => (resolve = r)));

    const a = cache.get('k', load);
    const b = cache.get('k', load);
    resolve(7);
    expect((await a).value).toBe(7);
    expect((await b).value).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed load, and lets the next call retry', async () => {
    const cache = createCache<number>(300, () => 0);
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(5);

    await expect(cache.get('k', load)).rejects.toThrow('boom');
    expect((await cache.get('k', load)).value).toBe(5);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('peek returns a stale entry with its age, without loading', () => {
    let clock = 0;
    const cache = createCache<number>(300, () => clock);
    cache.set('k', 9);
    clock += 900_000; // 900s — well past the TTL
    expect(cache.peek('k')).toEqual({ value: 9, ageSeconds: 900 });
  });

  it('peek returns undefined for an unknown key', () => {
    expect(createCache<number>(300, () => 0).peek('nope')).toBeUndefined();
  });
});
