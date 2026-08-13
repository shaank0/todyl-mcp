import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../todyl/client.js';
import { TodylError } from '../todyl/errors.js';
import type { TodylConfig } from '../config.js';

const config: TodylConfig = {
  baseUrl: 'https://api.todyl.test',
  clientId: 'CID',
  accessToken: 'TOK',
  cacheTtlSeconds: 300,
  maxPages: 20,
  port: 8080,
};

function respond(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) };
}

const OK = { data: [{ id: 'd1' }], meta: { has_more: false } };

describe('createClient', () => {
  it('sends both auth headers with exact-case values', async () => {
    const fetchFn = vi.fn(async () => respond(200, OK));
    const client = createClient(config, fetchFn as never);
    await client.get('/v1/devices');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.todyl.test/v1/devices');
    expect(init.headers['X-Todyl-Client-Id']).toBe('CID');
    expect(init.headers['X-Todyl-Access-Token']).toBe('TOK');
  });

  it('encodes query params and omits undefined ones', async () => {
    const fetchFn = vi.fn(async () => respond(200, OK));
    const client = createClient(config, fetchFn as never);
    await client.get('/v1/devices', { limit: 1000, cursor: undefined });
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://api.todyl.test/v1/devices?limit=1000'
    );
  });

  it('returns the parsed envelope', async () => {
    const client = createClient(config, (async () => respond(200, OK)) as never);
    const result = await client.get<{ id: string }>('/v1/devices');
    expect(result.data).toEqual([{ id: 'd1' }]);
    expect(result.meta.has_more).toBe(false);
  });

  it('maps 401 to an actionable message', async () => {
    const body = { error: { code: 'unauthorized', message: 'nope', request_id: 'req_1' } };
    const client = createClient(config, (async () => respond(401, body)) as never);
    await expect(client.get('/v1/devices')).rejects.toMatchObject({
      status: 401,
      requestId: 'req_1',
    });
    await expect(client.get('/v1/devices')).rejects.toThrow(/token.*Todyl portal/i);
  });

  it('names BOTH causes on 403', async () => {
    const fetchFn = vi.fn(async () => respond(403, { error: { code: 'forbidden', message: 'no', request_id: 'req_2' } }));
    const client = createClient(config, fetchFn as never);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/allowed source ip/i);
    expect(err.message).toMatch(/ACL/i);
    expect(err.requestId).toBe('req_2');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('surfaces error.param on 400', async () => {
    const fetchFn = vi.fn(async () => respond(400, { error: { code: 'invalid_request', message: 'bad', param: 'cursor' } }));
    const client = createClient(config, fetchFn as never);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err.param).toBe('cursor');
    expect(err.message).toMatch(/cursor/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx exactly once, then succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(respond(500, { error: { code: 'server_error' } }))
      .mockResolvedValueOnce(respond(200, OK));
    const client = createClient(config, fetchFn as never);
    const result = await client.get('/v1/devices');
    expect(result.data).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second 5xx', async () => {
    const fetchFn = vi.fn(async () => respond(503, { error: { code: 'unavailable' } }));
    const client = createClient(config, fetchFn as never);
    await expect(client.get('/v1/devices')).rejects.toMatchObject({ status: 503 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 401', async () => {
    const fetchFn = vi.fn(async () => respond(401, { error: { code: 'unauthorized' } }));
    const client = createClient(config, fetchFn as never);
    await expect(client.get('/v1/devices')).rejects.toBeInstanceOf(TodylError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('wraps non-JSON 200 response in a TodylError, WITHOUT echoing the body', async () => {
    // CHANGED ASSERTION (final review, Critical 2). This used to require the
    // body in the message (`/502 Bad Gateway/`). The common cause of a non-JSON
    // 200 is a truncated response, and a deployment-group body cut mid-JSON
    // starts `{"data":[{...,"credentials":{"deploy_key":"…` — so echoing it puts
    // a live enrollment key in the LLM's context and the audit log. An
    // unparseable body cannot be scrubbed structurally, so no preview is safe.
    // What replaces it is what actually diagnoses a truncation: status, byte
    // length, content-type.
    const body = '<html>502 Bad Gateway</html>';
    const fetchFn = vi.fn(async () => ({
      status: 200,
      text: async () => body,
      headers: { get: (name: string) => (name === 'content-type' ? 'text/html' : null) },
    }));
    const client = createClient(config, fetchFn as never);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err).toBeInstanceOf(TodylError);
    expect(err.status).toBe(200);
    expect(err.message).toMatch(/non-JSON/i);
    expect(err.message).not.toContain('502 Bad Gateway');
    expect(err.message).toContain(`${body.length} bytes`);
    expect(err.message).toMatch(/text\/html/);
  });

  it('retries a rejected fetch once, then succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(respond(200, OK));
    const client = createClient(config, fetchFn as never);
    const result = await client.get('/v1/devices');
    expect(result.data).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('wraps twice-rejected fetch in a TodylError with status 0', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('DNS lookup failed');
    });
    const client = createClient(config, fetchFn as never);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err).toBeInstanceOf(TodylError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/DNS lookup failed/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('interleaving: reject then 5xx throws 5xx error with exactly 2 calls', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(respond(503, { error: { code: 'unavailable' } }));
    const client = createClient(config, fetchFn as never);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err.status).toBe(503);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('interleaving: 5xx then reject throws status 0 with exactly 2 calls', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(respond(500, { error: { code: 'server_error' } }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = createClient(config, fetchFn as never);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err).toBeInstanceOf(TodylError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/ECONNREFUSED/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('interleaving: 5xx then 5xx throws 5xx error with exactly 2 calls', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(respond(500, { error: { code: 'server_error' } }))
      .mockResolvedValueOnce(respond(503, { error: { code: 'unavailable' } }));
    const client = createClient(config, fetchFn as never);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err.status).toBe(503);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
