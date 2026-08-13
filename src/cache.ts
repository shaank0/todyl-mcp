interface Entry<T> {
  value: T;
  storedAt: number;
}

/**
 * TTL cache with in-flight dedupe: concurrent misses share one load rather
 * than each hitting the upstream. `peek` deliberately ignores the TTL so
 * callers can decide to serve stale data on an upstream failure.
 */
export function createCache<T>(
  ttlSeconds: number,
  now: () => number = Date.now,
) {
  const entries = new Map<string, Entry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  function age(entry: Entry<T>): number {
    return Math.floor((now() - entry.storedAt) / 1000);
  }

  return {
    peek(key: string) {
      const entry = entries.get(key);
      return entry ? { value: entry.value, ageSeconds: age(entry) } : undefined;
    },

    /**
     * Seed an entry directly. No production caller — `get` is the only writer
     * the repository uses — and it is kept deliberately, for `peek`'s test:
     * seeding lets that test construct a known-stale entry without routing
     * through `get`, so it verifies `peek` alone rather than `peek` composed
     * with `get`'s write path. Removing it would make the one test that pins
     * stale-read behaviour depend on the correctness of a second function.
     */
    set(key: string, value: T) {
      entries.set(key, { value, storedAt: now() });
    },

    async get(key: string, load: () => Promise<T>) {
      const entry = entries.get(key);
      if (entry && age(entry) < ttlSeconds) {
        return { value: entry.value, ageSeconds: age(entry), fromCache: true };
      }

      let pending = inFlight.get(key);
      if (!pending) {
        pending = load();
        inFlight.set(key, pending);
        // A failed load must not be cached: clear the slot either way.
        pending.finally(() => inFlight.delete(key)).catch(() => undefined);
      }

      const value = await pending;
      entries.set(key, { value, storedAt: now() });
      return { value, ageSeconds: 0, fromCache: false };
    },
  };
}
