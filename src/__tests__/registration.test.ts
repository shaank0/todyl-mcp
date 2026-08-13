import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TODYL_TOOLS } from '../tools/index.js';
import { createServer } from '../server.js';
import { createRepository } from '../todyl/repository.js';
import type { TodylClient } from '../todyl/client.js';
import type { TodylConfig } from '../config.js';
import { TodylError } from '../todyl/errors.js';

describe('tool registry', () => {
  it('registers exactly the six designed tools', () => {
    expect(TODYL_TOOLS.map((t) => t.name).sort()).toEqual([
      'device-posture-summary',
      'get-device',
      'list-deployment-groups',
      'list-devices',
      'list-invoices',
      'tenant-report',
    ]);
  });

  it('has no duplicate names', () => {
    const names = TODYL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('marks every tool read-only — this API has no writes', () => {
    for (const tool of TODYL_TOOLS) expect(tool.readOnly).toBe(true);
  });

  it('gives every tool a description long enough to route on', () => {
    for (const tool of TODYL_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(80);
      expect(typeof tool.inputSchema).toBe('object');
    }
  });

  it('exposes no raw-request or arbitrary-endpoint tool', () => {
    for (const tool of TODYL_TOOLS) {
      expect(tool.name).not.toMatch(/raw|request|execute|proxy|batch/i);
    }
  });
});

/**
 * Task 12 is the FIRST time any tool runs through the MCP SDK's zod argument
 * validation — every prior test called `tool.execute` directly, bypassing it
 * entirely. These tests connect a real `Client` to `createServer(repo)` over
 * an in-memory transport so a schema mismatch (wrong zod shape, a tool that
 * silently expects a field its `inputSchema` never declares, etc.) surfaces
 * here rather than in production.
 */
describe('registered server (through the SDK zod validation, not tool.execute directly)', () => {
  const config: TodylConfig = {
    baseUrl: 'https://api.todyl.test',
    clientId: 'C',
    accessToken: 'T',
    cacheTtlSeconds: 300,
    maxPages: 20,
    port: 8080,
  };

  const fixtureClient = {
    get: async (path: string) => {
      if (path.startsWith('/v1/devices')) {
        return {
          data: [{ id: 'd1', name: 'LAPTOP', tenant: { id: 't1', name: 'Acme' } }],
          meta: { has_more: false },
        };
      }
      return { data: [], meta: { has_more: false } };
    },
  } as unknown as TodylClient;

  async function connectedClient() {
    const repo = createRepository(fixtureClient, config);
    const server = createServer(repo);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return client;
  }

  it('lists all six tools with readOnlyHint true, matching each tool.readOnly', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TODYL_TOOLS.map((t) => t.name).sort());
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('accepts valid arguments and returns real data through zod validation', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'list-devices', arguments: { tenant: 'Acme' } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text).matched).toBe(1);
  });

  it('rejects a call missing tenant-report\'s required "tenant" argument via zod', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'tenant-report', arguments: {} });
    // The SDK catches the zod validation failure itself (before our handler
    // ever runs) and reports it as a normal tool error, not a protocol-level
    // rejection — proving the schema, not just our own code, rejected this.
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toMatch(/invalid arguments.*tenant-report/i);
  });

  /**
   * Fix round 1: nothing previously pinned `toCallToolResult` forwarding
   * `isError` across the adapter — `registration.test.ts`'s only error case
   * goes through zod rejection (never reaches the adapter), and
   * `redaction-sweep.test.ts` checks `isError` via `tool.execute()` directly
   * (bypasses the adapter entirely). Every "fail loudly" guarantee in this
   * server — an ambiguous-tenant refusal, a 401/403 — routes through that one
   * boolean crossing into the MCP protocol; if it silently dropped, a refusal
   * would arrive at the client as a SUCCESSFUL result whose content happens
   * to read like an error, and a calling model would reasonably treat it as
   * the answer.
   */
  it('surfaces a tool-returned toolError(...) with isError true through the adapter', async () => {
    const client = await connectedClient();
    // get-device's own execute() returns toolError(...) directly (no throw)
    // when nothing matches — this exercises the ADAPTER's normal (non-catch)
    // path, which redaction-sweep.test.ts never does (it calls execute()
    // directly, skipping the adapter).
    const result = await client.callTool({ name: 'get-device', arguments: { identifier: 'NO-SUCH-DEVICE' } });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toMatch(/no device matches/i);
  });

  it('surfaces a thrown TodylError as a tool error (not a transport failure), with no credential in the message', async () => {
    const secretToken = 'SECRET-ACCESS-TOKEN-DO-NOT-LEAK';
    const throwingConfig: TodylConfig = { ...config, accessToken: secretToken };
    const throwingClient = {
      get: async () => {
        // Mirrors what createClient actually throws on a real 401 — see
        // toTodylError in todyl/errors.ts. Never embeds the access token.
        throw new TodylError(
          'Todyl rejected the credentials (401). The token may be wrong, deactivated, ' +
            'or past its expiry — check it in the Todyl portal under Account → Developer APIs.',
          401,
          'unauthorized'
        );
      },
    } as unknown as TodylClient;

    const repo = createRepository(throwingClient, throwingConfig);
    const server = createServer(repo);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Resolves (not rejects) — the throw must be caught and turned into a
    // normal tool result, not surfaced as a JSON-RPC/transport-level failure.
    const result = await client.callTool({ name: 'list-devices', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toMatch(/todyl rejected the credentials/i);
    expect(text).not.toContain(secretToken);
  });
});
