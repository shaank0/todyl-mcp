import { describe, it, expect, vi } from 'vitest';
import { createRepository } from '../todyl/repository.js';
import { TodylError } from '../todyl/errors.js';
import type { TodylClient } from '../todyl/client.js';
import type { TodylConfig } from '../config.js';

const config: TodylConfig = {
  baseUrl: 'https://api.todyl.test',
  clientId: 'CID',
  accessToken: 'TOK',
  cacheTtlSeconds: 300,
  maxPages: 20,
  port: 8080,
};

const onePage = (data: unknown[]) => ({ data, meta: { has_more: false } });

describe('repository', () => {
  it('sweeps and caches devices', async () => {
    const get = vi.fn(async () => onePage([{ id: 'd1' }]));
    const repo = createRepository({ get } as unknown as TodylClient, config);
    expect((await repo.devices()).items).toHaveLength(1);
    await repo.devices();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('strips credentials from deployment groups', async () => {
    const get = vi.fn(async () =>
      onePage([{ id: 'g1', credentials: { deploy_key: 'LEAK' } }])
    );
    const repo = createRepository({ get } as unknown as TodylClient, config);
    const result = await repo.deploymentGroups();
    expect(JSON.stringify(result.items)).not.toContain('LEAK');
  });

  it('caches invoices per date window, not globally', async () => {
    const get = vi.fn(async () => onePage([{ id: 'inv' }]));
    const repo = createRepository({ get } as unknown as TodylClient, config);
    await repo.invoices('2026-01', '2026-02');
    await repo.invoices('2026-01', '2026-02');
    await repo.invoices('2026-03', '2026-04');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('serves stale data WITH a warning when a refresh 5xxs', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const get = vi.fn(async () => {
      if (mode === 'fail') throw new TodylError('down', 503);
      return onePage([{ id: 'd1' }]);
    });
    const repo = createRepository({ get } as unknown as TodylClient, {
      ...config,
      cacheTtlSeconds: 0,
    });

    await repo.devices();
    mode = 'fail';
    const result = await repo.devices();
    expect(result.items).toHaveLength(1);
    expect(result.staleWarning).toMatch(/could not be refreshed/i);
    expect(result.staleWarning).toMatch(/503/);
  });

  it.each([401, 403])('FAILS on %i even with a warm cache', async (status) => {
    let mode: 'ok' | 'fail' = 'ok';
    const get = vi.fn(async () => {
      if (mode === 'fail') throw new TodylError('nope', status);
      return onePage([{ id: 'd1' }]);
    });
    const repo = createRepository({ get } as unknown as TodylClient, {
      ...config,
      cacheTtlSeconds: 0,
    });

    // Populate the cache
    await repo.devices();
    mode = 'fail';
    // Verify the client IS called (refresh attempted) and the error is rethrown
    // despite a usable cache existing.
    await expect(repo.devices()).rejects.toMatchObject({ status });
    expect(get).toHaveBeenCalledTimes(2); // Proves refresh was attempted
  });

  it('rethrows 400 even with a warm cache', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const get = vi.fn(async () => {
      if (mode === 'fail') throw new TodylError('bad cursor', 400);
      return onePage([{ id: 'd1' }]);
    });
    const repo = createRepository({ get } as unknown as TodylClient, {
      ...config,
      cacheTtlSeconds: 0,
    });

    // Populate cache
    await repo.devices();
    mode = 'fail';
    // 400 is NOT a transient error; a bad cursor means our code is broken.
    // Must rethrow despite cache being warm.
    await expect(repo.devices()).rejects.toMatchObject({ status: 400 });
    expect(get).toHaveBeenCalledTimes(2); // Proves refresh was attempted
  });

  it('rethrows bare Error even with a warm cache', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const get = vi.fn(async () => {
      if (mode === 'fail') throw new Error('TypeError in parseDevice');
      return onePage([{ id: 'd1' }]);
    });
    const repo = createRepository({ get } as unknown as TodylClient, {
      ...config,
      cacheTtlSeconds: 0,
    });

    // Populate cache
    await repo.devices();
    mode = 'fail';
    // A bug in our own code (not a TodylError) is NOT transient.
    // Must fail loudly so we notice the broken integration, not serve stale silently.
    await expect(repo.devices()).rejects.toThrow(/TypeError in parseDevice/);
    expect(get).toHaveBeenCalledTimes(2); // Proves refresh was attempted
  });

  it('propagates a 5xx when there is no cache to fall back on', async () => {
    const get = vi.fn(async () => {
      throw new TodylError('down', 500);
    });
    const repo = createRepository({ get } as unknown as TodylClient, config);
    await expect(repo.devices()).rejects.toMatchObject({ status: 500 });
  });

  it('propagates the truncated flag from the sweep', async () => {
    const get = vi.fn(async () => ({ data: [{ id: 'd1' }], meta: { has_more: true, next_cursor: 'C' } }));
    const repo = createRepository({ get } as unknown as TodylClient, { ...config, maxPages: 1 });
    expect((await repo.devices()).truncated).toBe(true);
  });
});
