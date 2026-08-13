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
   * Load through the cache, applying the stale rule:
   *   5xx      → serve cached data WITH a warning, if any exists
   *   401/403  → always fail, even with a warm cache
   * Serving stale data on an auth error would hide a broken integration for
   * as long as anyone kept asking questions.
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
      const status = err instanceof TodylError ? err.status : 0;
      if (status === 401 || status === 403) throw err;

      const stale = cache.peek(key);
      if (!stale) throw err;

      const detail = err instanceof Error ? err.message : String(err);
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
