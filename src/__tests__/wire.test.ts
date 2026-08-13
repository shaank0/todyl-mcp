import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createClient, type FetchFn } from '../todyl/client.js';
import { createRepository } from '../todyl/repository.js';
import { createServer } from '../server.js';
import { TodylError } from '../todyl/errors.js';
import type { TodylConfig } from '../config.js';

/**
 * Everything here composes the REAL client with the REAL repository, because
 * both defects this file pins live in the seam between two files that each
 * looked correct alone:
 *
 *  - `client.test.ts` never passed a query-bearing path, and
 *    `repository.test.ts` asserts on the cache key, never the wire. The
 *    repository baked `?start_date=…` into the path while the client appended
 *    its own `?limit=1000`, producing a second `?` — which is not a separator.
 *  - `redaction-sweep.test.ts` sweeps only SUCCESS payloads, so the error path
 *    was never treated as a secret boundary at all.
 *
 * A test that stubs either half cannot see either bug.
 */

const config: TodylConfig = {
  baseUrl: 'https://api.todyl.test',
  clientId: 'CID',
  accessToken: 'TOK',
  cacheTtlSeconds: 300,
  maxPages: 20,
  port: 8080,
};

const emptyPage = JSON.stringify({ data: [], meta: { has_more: false } });

/** Records every URL the client actually hands to fetch. */
function recordingFetch(bodies: string[] = [emptyPage]) {
  const urls: string[] = [];
  let call = 0;
  const fetchFn = vi.fn(async (url: string) => {
    urls.push(url);
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return {
      status: 200,
      text: async () => body,
      headers: { get: () => 'application/json' },
    };
  });
  return { urls, fetchFn: fetchFn as unknown as FetchFn };
}

describe('the URL actually sent upstream', () => {
  it('puts the invoice date window and the page size in ONE query string', async () => {
    const { urls, fetchFn } = recordingFetch();
    const repo = createRepository(createClient(config, fetchFn), config);
    await repo.invoices('2026-01', '2026-03');

    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(
      'https://api.todyl.test/v1/billing/invoices?start_date=2026-01&end_date=2026-03&limit=1000'
    );
  });

  it('sends a window a server would parse back EXACTLY as asked', async () => {
    // The decisive assertion, and the one the old bug fails: with a second `?`
    // the previous parameter swallows it, so `end_date` parsed as
    // "2026-03?limit=1000" and `limit` came back null. An operator asking for
    // Q1 billing then gets a different period than `list-invoices` labels the
    // window — a confidently wrong billing number — and the sweep silently
    // drops to Todyl's default page size, truncating ~20x earlier.
    const { urls, fetchFn } = recordingFetch();
    const repo = createRepository(createClient(config, fetchFn), config);
    await repo.invoices('2026-01', '2026-03');

    const parsed = new URL(urls[0]).searchParams;
    expect(parsed.get('start_date')).toBe('2026-01');
    expect(parsed.get('end_date')).toBe('2026-03');
    expect(parsed.get('limit')).toBe('1000');
    expect(urls[0].split('?')).toHaveLength(2);
  });

  it('keeps the window on EVERY page of a paginated sweep, alongside the cursor', async () => {
    const page1 = JSON.stringify({ data: [{ id: 'inv1' }], meta: { has_more: true, next_cursor: 'C2' } });
    const { urls, fetchFn } = recordingFetch([page1, emptyPage]);
    const repo = createRepository(createClient(config, fetchFn), config);
    await repo.invoices('2026-01', '2026-03');

    expect(urls).toHaveLength(2);
    const second = new URL(urls[1]).searchParams;
    expect(second.get('cursor')).toBe('C2');
    expect(second.get('start_date')).toBe('2026-01');
    expect(second.get('end_date')).toBe('2026-03');
    expect(second.get('limit')).toBe('1000');
  });

  it('omits the window entirely when no dates are given', async () => {
    const { urls, fetchFn } = recordingFetch();
    const repo = createRepository(createClient(config, fetchFn), config);
    await repo.invoices();
    expect(urls[0]).toBe('https://api.todyl.test/v1/billing/invoices?limit=1000');
  });

  it('sends the page size on devices and deployment groups too', async () => {
    const { urls, fetchFn } = recordingFetch();
    const repo = createRepository(createClient(config, fetchFn), config);
    await repo.devices();
    await repo.deploymentGroups();
    expect(urls[0]).toBe('https://api.todyl.test/v1/devices?limit=1000');
    expect(urls[1]).toBe('https://api.todyl.test/v1/deployment-groups?limit=1000');
  });

  it('refuses a path that already contains a query string, rather than double-encoding it', async () => {
    // Makes the class of bug unrepresentable instead of merely fixed once.
    const { fetchFn } = recordingFetch();
    const client = createClient(config, fetchFn);
    await expect(client.get('/v1/billing/invoices?start_date=2026-01')).rejects.toThrow(
      /must not contain a query string/i
    );
  });
});

describe('the error path is a secret boundary', () => {
  // A deployment-group response cut mid-JSON by a proxy: valid-looking prefix,
  // live enrollment key, unparseable. This is the realistic shape of a non-JSON
  // 200 from this API, not a contrived one.
  const TRUNCATED_WITH_SECRET =
    '{"data":[{"id":"g1","name":"Default","credentials":{"deploy_key":"SUPER-SECRET-DEPLOY-KEY","temporary_deploy_key":"TEMP';

  function truncatedFetch() {
    return (async () => ({
      status: 200,
      text: async () => TRUNCATED_WITH_SECRET,
      headers: { get: (n: string) => (n === 'content-type' ? 'application/json' : null) },
    })) as unknown as FetchFn;
  }

  it('never echoes the body of a non-JSON 200, so a truncated deploy key cannot ride out', async () => {
    const client = createClient(config, truncatedFetch());
    const err = await client.get('/v1/deployment-groups').catch((e) => e as TodylError);

    expect(err).toBeInstanceOf(TodylError);
    expect(err.message).not.toContain('SUPER-SECRET-DEPLOY-KEY');
    expect(err.message).not.toContain('TEMP');
    expect(err.message).not.toContain('deploy_key');
    expect(err.message).not.toContain('credentials');
    // What replaces it is what actually diagnoses a truncated response.
    expect(err.message).toMatch(/non-JSON/i);
    expect(err.message).toContain(`${TRUNCATED_WITH_SECRET.length} bytes`);
    expect(err.message).toMatch(/application\/json/);
  });

  it('keeps the secret out of the tool result the MCP client receives, end to end', async () => {
    // The full production path: client → repository (which rethrows, since 200
    // is not stale-tolerable) → tool → server.ts's catch → toolError(err.message)
    // → the LLM's context and the gateway's audit log. parse.ts's scrub never
    // runs on this path, so nothing upstream of here can save it.
    const repo = createRepository(createClient(config, truncatedFetch()), config);
    const server = createServer(repo);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result = await client.callTool({ name: 'list-deployment-groups', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).not.toContain('SUPER-SECRET-DEPLOY-KEY');
    expect(text).not.toContain('deploy_key');
    expect(text).toMatch(/non-JSON/i);
  });

  it('withholds an upstream error message that references credential fields', async () => {
    // toTodylError echoes Todyl's own `error.message`. It is free text, so
    // key-based scrubbing cannot reach inside it — the whole message goes.
    const body = JSON.stringify({
      error: { code: 'invalid_request', message: 'deploy_key SUPER-SECRET-DEPLOY-KEY is malformed', param: 'x' },
    });
    const fetchFn = (async () => ({ status: 400, text: async () => body })) as unknown as FetchFn;
    const client = createClient(config, fetchFn);
    const err = await client.get('/v1/deployment-groups').catch((e) => e as TodylError);

    expect(err.message).not.toContain('SUPER-SECRET-DEPLOY-KEY');
    expect(err.message).not.toContain('deploy_key');
    expect(err.message).toMatch(/withheld/i);
    // Still actionable: the status-derived guidance and param survive.
    expect(err.message).toMatch(/400/);
    expect(err.param).toBe('x');
  });

  it('echoes ONLY the sanitised message from an error body, never any other field', async () => {
    // NOTE ON WHAT THIS DOES AND DOESN'T PIN: `toTodylError` also runs the
    // parsed envelope through `deepScrub`, but that is defence-in-depth for
    // fields nobody echoes yet — removing it does NOT fail this test, because
    // the secret here sits in a field the function never reads. The property
    // actually pinned is the stronger, more durable one: whatever else an error
    // body carries, only the sanitised `error.message` ever reaches the caller.
    const body = JSON.stringify({
      error: { code: 'conflict', message: 'group in use' },
      credentials: { deploy_key: 'SUPER-SECRET-DEPLOY-KEY' },
      internal_note: 'DO-NOT-RELAY',
    });
    const fetchFn = (async () => ({ status: 409, text: async () => body })) as unknown as FetchFn;
    const client = createClient(config, fetchFn);
    const err = await client.get('/v1/deployment-groups').catch((e) => e as TodylError);
    expect(err.message).not.toContain('SUPER-SECRET-DEPLOY-KEY');
    expect(err.message).not.toContain('DO-NOT-RELAY');
    expect(err.message).toMatch(/group in use/);
  });

  it('coerces a non-string message instead of throwing out of the mapper', async () => {
    // `{"error":{"message":42}}` is well-formed JSON. Calling .trim() on it threw
    // a TypeError out of toTodylError, turning a clean 400 into a status-0
    // section error — a real 400 misreported as a network failure.
    const body = JSON.stringify({ error: { code: 'invalid_request', message: 42 } });
    const fetchFn = (async () => ({ status: 400, text: async () => body })) as unknown as FetchFn;
    const client = createClient(config, fetchFn);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err).toBeInstanceOf(TodylError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/42/);
  });

  it('coerces an object message instead of throwing out of the mapper', async () => {
    const body = JSON.stringify({ error: { message: { nested: 'detail' } } });
    const fetchFn = (async () => ({ status: 400, text: async () => body })) as unknown as FetchFn;
    const client = createClient(config, fetchFn);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err).toBeInstanceOf(TodylError);
    expect(err.status).toBe(400);
  });

  it('caps a very long upstream message rather than relaying a body dump', async () => {
    const body = JSON.stringify({ error: { code: 'invalid_request', message: 'x'.repeat(5000) } });
    const fetchFn = (async () => ({ status: 400, text: async () => body })) as unknown as FetchFn;
    const client = createClient(config, fetchFn);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err.message.length).toBeLessThan(500);
    expect(err.message).toMatch(/truncated/i);
  });
});

/**
 * The invariant is NOT "the message is scrubbed" — it is that **no
 * upstream-controlled text reaches a caller unscrubbed**. Stating it per-field
 * is what let the same leak through twice: the body was fixed, then
 * `error.message` was fixed, while `param`, `request_id` and the echoed
 * `content-type` carried it out unchanged.
 *
 * So these tests are parameterised over the CHANNEL, not written once for one
 * field: the same secret is planted in each in turn and must be absent from what
 * a caller actually receives. Adding a fifth channel means adding a row here.
 */
describe('no upstream-controlled text reaches a caller unscrubbed', () => {
  const SECRET = 'deploy_key=SUPER-SECRET-DEPLOY-KEY';

  const CHANNELS: [field: string, envelope: Record<string, unknown>][] = [
    ['error.message', { code: 'invalid_request', message: `${SECRET}: bad window` }],
    ['error.param', { code: 'invalid_request', param: SECRET }],
    ['error.request_id', { code: 'invalid_request', request_id: SECRET }],
    ['error.code', { code: SECRET, message: 'bad window' }],
  ];

  it.each(CHANNELS)('a secret planted in %s never reaches the thrown error', async (_field, error) => {
    const body = JSON.stringify({ error });
    const fetchFn = (async () => ({ status: 400, text: async () => body })) as unknown as FetchFn;
    const client = createClient(config, fetchFn);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);

    expect(err.message).not.toContain('SUPER-SECRET-DEPLOY-KEY');
    expect(err.message).not.toContain('deploy_key');
    // Also absent from the structured fields, so a future echo of them is safe
    // by default rather than by the next author remembering.
    expect(JSON.stringify({ p: err.param, r: err.requestId, c: err.code })).not.toContain(
      'SUPER-SECRET-DEPLOY-KEY'
    );
  });

  it.each(CHANNELS)(
    'a secret planted in %s never reaches the MCP client on the ERROR path',
    async (_field, error) => {
      const body = JSON.stringify({ error });
      const fetchFn = (async () => ({ status: 400, text: async () => body })) as unknown as FetchFn;
      const repo = createRepository(createClient(config, fetchFn), config);
      const server = createServer(repo);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '1.0' });
      await Promise.all([client.connect(ct), server.connect(st)]);

      const result = await client.callTool({ name: 'list-devices', arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).not.toContain('SUPER-SECRET-DEPLOY-KEY');
      expect(text).not.toContain('deploy_key');
    }
  );

  it.each(CHANNELS)(
    'a secret planted in %s never reaches a SUCCESSFUL result via staleWarning → warning',
    async (_field, error) => {
      // The nastier route: a 5xx after a warm cache produces a SUCCESS result
      // whose `warning` embeds "Underlying error: <err.message>". A caller
      // treating isError as the security boundary would never look here.
      let calls = 0;
      const fetchFn = (async () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 200,
            text: async () =>
              JSON.stringify({
                data: [{ id: 'd1', tenant: { id: 't1', name: 'Acme' } }],
                meta: { has_more: false },
              }),
            headers: { get: () => 'application/json' },
          };
        }
        return { status: 503, text: async () => JSON.stringify({ error }) };
      }) as unknown as FetchFn;

      // TTL 0 forces a refresh on the second call, which 5xxs and falls back to
      // the warm cache — the only path that produces a staleWarning.
      const repo = createRepository(createClient(config, fetchFn), { ...config, cacheTtlSeconds: 0 });
      const server = createServer(repo);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '1.0' });
      await Promise.all([client.connect(ct), server.connect(st)]);

      await client.callTool({ name: 'list-devices', arguments: {} });
      const result = await client.callTool({ name: 'list-devices', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      // Prove this is the path described: a successful result carrying a warning.
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(text).warning).toMatch(/could not be refreshed/i);
      expect(text).not.toContain('SUPER-SECRET-DEPLOY-KEY');
      expect(text).not.toContain('deploy_key');
    }
  );

  it('caps an oversized param, so MAX_UPSTREAM_TEXT cannot be defeated by field choice', async () => {
    const body = JSON.stringify({ error: { code: 'invalid_request', param: 'p'.repeat(100_000) } });
    const fetchFn = (async () => ({ status: 400, text: async () => body })) as unknown as FetchFn;
    const client = createClient(config, fetchFn);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err.message.length).toBeLessThan(500);
    expect(err.message).toMatch(/truncated/i);
  });

  it('caps an oversized request_id too', async () => {
    const body = JSON.stringify({ error: { request_id: 'r'.repeat(100_000) } });
    const fetchFn = (async () => ({ status: 500, text: async () => body })) as unknown as FetchFn;
    const client = createClient(config, fetchFn);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err.message.length).toBeLessThan(500);
  });

  it('sanitises the echoed content-type header on a non-JSON 200', async () => {
    const fetchFn = (async () => ({
      status: 200,
      text: async () => 'not json',
      headers: { get: () => `text/html; charset=${SECRET}` },
    })) as unknown as FetchFn;
    const client = createClient(config, fetchFn);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err.message).not.toContain('SUPER-SECRET-DEPLOY-KEY');
    expect(err.message).not.toContain('deploy_key');
  });

  it('caps an oversized content-type header', async () => {
    const fetchFn = (async () => ({
      status: 200,
      text: async () => 'not json',
      headers: { get: () => 'x'.repeat(100_000) },
    })) as unknown as FetchFn;
    const client = createClient(config, fetchFn);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err.message.length).toBeLessThan(600);
  });

  it('counts BYTES, not UTF-16 code units, when reporting a non-JSON body size', async () => {
    // A multi-byte body is exactly when this number matters — it gets compared
    // against a Content-Length or a proxy's cutoff.
    const body = '☃'.repeat(10); // 10 chars, 30 bytes
    const fetchFn = (async () => ({
      status: 200,
      text: async () => body,
      headers: { get: () => 'text/plain' },
    })) as unknown as FetchFn;
    const client = createClient(config, fetchFn);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err.message).toContain('30 bytes');
    expect(err.message).not.toContain('10 bytes');
  });

  it('refuses a path containing a fragment, which would swallow the query string', async () => {
    const { fetchFn } = recordingFetch();
    const client = createClient(config, fetchFn);
    await expect(client.get('/v1/devices#frag')).rejects.toThrow(/must not contain a query string/i);
  });
});
