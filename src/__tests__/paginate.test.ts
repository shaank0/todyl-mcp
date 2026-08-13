import { describe, it, expect, vi } from 'vitest';
import { sweep } from '../todyl/paginate.js';
import type { TodylClient } from '../todyl/client.js';

function clientReturning(pages: { data: unknown[]; meta: { has_more: boolean; next_cursor?: string } }[]) {
  const calls: (Record<string, unknown> | undefined)[] = [];
  let i = 0;
  const client = {
    get: vi.fn(async (_path: string, query?: Record<string, unknown>) => {
      calls.push(query);
      return pages[i++];
    }),
  } as unknown as TodylClient;
  return { client, calls };
}

describe('sweep', () => {
  it('returns a single page without asking for more', async () => {
    const { client, calls } = clientReturning([{ data: [{ id: 'a' }], meta: { has_more: false } }]);
    const result = await sweep(client, '/v1/devices', 20);
    expect(result.items).toEqual([{ id: 'a' }]);
    expect(result.truncated).toBe(false);
    expect(result.pages).toBe(1);
    expect(calls[0]).toMatchObject({ limit: 1000 });
    expect(calls[0]?.cursor).toBeUndefined();
  });

  it('follows next_cursor and concatenates in order', async () => {
    const { client, calls } = clientReturning([
      { data: [{ id: 'a' }], meta: { has_more: true, next_cursor: 'CUR1' } },
      { data: [{ id: 'b' }], meta: { has_more: false } },
    ]);
    const result = await sweep(client, '/v1/devices', 20);
    expect(result.items.map((i: any) => i.id)).toEqual(['a', 'b']);
    expect(calls[1]).toMatchObject({ cursor: 'CUR1' });
    expect(result.truncated).toBe(false);
  });

  it('stops at the cap and reports truncation', async () => {
    const pages = [
      { data: [{ id: 'a' }], meta: { has_more: true, next_cursor: 'C1' } },
      { data: [{ id: 'b' }], meta: { has_more: true, next_cursor: 'C2' } },
      { data: [{ id: 'c' }], meta: { has_more: true, next_cursor: 'C3' } },
    ];
    const { client } = clientReturning(pages);
    const result = await sweep(client, '/v1/devices', 2);
    expect(result.items).toHaveLength(2);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('does NOT report truncation when the last page exactly fills the cap', async () => {
    const { client } = clientReturning([
      { data: [{ id: 'a' }], meta: { has_more: true, next_cursor: 'C1' } },
      { data: [{ id: 'b' }], meta: { has_more: false } },
    ]);
    const result = await sweep(client, '/v1/devices', 2);
    expect(result.truncated).toBe(false);
  });

  it('stops if has_more is true but next_cursor is missing', async () => {
    const { client } = clientReturning([{ data: [{ id: 'a' }], meta: { has_more: true } }]);
    const result = await sweep(client, '/v1/devices', 20);
    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});
