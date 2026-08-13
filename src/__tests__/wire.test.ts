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

  it('caps a very long upstream message rather than relaying a body dump', async () => {
    const body = JSON.stringify({ error: { code: 'invalid_request', message: 'x'.repeat(5000) } });
    const fetchFn = (async () => ({ status: 400, text: async () => body })) as unknown as FetchFn;
    const client = createClient(config, fetchFn);
    const err = await client.get('/v1/devices').catch((e) => e as TodylError);
    expect(err.message.length).toBeLessThan(500);
    expect(err.message).toMatch(/truncated/i);
  });
});
