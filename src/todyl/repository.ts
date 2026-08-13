import type { TodylConfig } from '../config.js';
import { createCache } from '../cache.js';
import type { TodylClient } from './client.js';
import { TodylError } from './errors.js';
import { sweep } from './paginate.js';
import { parseDevice, parseDeploymentGroup, parseInvoice } from './parse.js';
import type { Device, DeploymentGroup, Invoice } from './types.js';

export interface Dataset<T> {
  items: T[];
  truncated: boolean;
  staleWarning?: string;
}

interface Swept<T> {
  items: T[];
  truncated: boolean;
}

export function createRepository(client: TodylClient, config: TodylConfig) {
  const devicesCache = createCache<Swept<Device>>(config.cacheTtlSeconds);
  const groupsCache = createCache<Swept<DeploymentGroup>>(config.cacheTtlSeconds);
  const invoicesCache = createCache<Swept<Invoice>>(config.cacheTtlSeconds);

  /**
   * Load through the cache, applying the stale rule as an allowlist:
   *   Only network/server errors (5xx, status 0) serve stale data WITH warning.
   *   Everything else rethrows immediately: 4xx, auth, parsing errors, bugs.
   *
   * This is an allowlist (not a denylist) so future unknown error types fail
   * loudly by default. A 400 (bad cursor/date) or a TypeError in our sweep/parse
   * code must surface immediately — stale data would hide broken integrations.
   * Serving cached data on a 401/403 would silently un-break the integration
   * for as long as the cache stays warm.
   */
  async function load<T>(
    cache: ReturnType<typeof createCache<Swept<T>>>,
    key: string,
    fetcher: () => Promise<Swept<T>>
  ): Promise<Dataset<T>> {
    try {
      const { value } = await cache.get(key, fetcher);
      return { items: value.items, truncated: value.truncated };
    } catch (err) {
      // Allowlist: only TodylError with 5xx or network (0) falls through to stale-tolerance.
      const isStaleTolerable =
        err instanceof TodylError && (err.status >= 500 || err.status === 0);

      if (!isStaleTolerable) throw err;

      const stale = cache.peek(key);
      if (!stale) throw err;

      const detail = err instanceof Error ? err.message : String(err);
      const status = err instanceof TodylError ? err.status : 0;
      return {
        items: stale.value.items,
        truncated: stale.value.truncated,
        staleWarning:
          `Todyl could not be refreshed (${status || 'error'}); showing data cached ` +
          `${Math.max(0, stale.ageSeconds)}s ago. Underlying error: ${detail}`,
      };
    }
  }

  return {
    devices: () =>
      load(devicesCache, 'devices', async () => {
        const { items, truncated } = await sweep<unknown>(client, '/v1/devices', config.maxPages);
        return { items: items.map(parseDevice), truncated };
      }),

    deploymentGroups: () =>
      load(groupsCache, 'groups', async () => {
        const { items, truncated } = await sweep<unknown>(
          client,
          '/v1/deployment-groups',
          config.maxPages
        );
        return { items: items.map(parseDeploymentGroup), truncated };
      }),

    invoices: (startDate?: string, endDate?: string) => {
      const key = `${startDate ?? ''}..${endDate ?? ''}`;
      return load(invoicesCache, key, async () => {
        const params = new URLSearchParams();
        if (startDate) params.set('start_date', startDate);
        if (endDate) params.set('end_date', endDate);
        const qs = params.toString();
        const { items, truncated } = await sweep<unknown>(
          client,
          `/v1/billing/invoices${qs ? `?${qs}` : ''}`,
          config.maxPages
        );
        return { items: items.map(parseInvoice), truncated };
      });
    },
  };
}

export type TodylRepository = ReturnType<typeof createRepository>;
