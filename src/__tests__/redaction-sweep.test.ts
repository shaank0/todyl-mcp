import { describe, it, expect } from 'vitest';
import { TODYL_TOOLS } from '../tools/index.js';
import { createRepository } from '../todyl/repository.js';
import type { TodylClient } from '../todyl/client.js';
import type { TodylConfig } from '../config.js';

const SECRET = 'SUPER-SECRET-DEPLOY-KEY';
const TEMP_SECRET = 'TEMP-SECRET-KEY';

const config: TodylConfig = {
  baseUrl: 'https://api.todyl.test', clientId: 'C', accessToken: 'T',
  cacheTtlSeconds: 300, maxPages: 20, port: 8080,
};

/** Every dataset carries the secrets, so any tool that leaks them will fail. */
const client = {
  get: async (path: string) => {
    if (path.startsWith('/v1/deployment-groups')) {
      return {
        data: [{
          id: 'g1', name: 'Default', tenant: { id: 't1', name: 'Acme' }, device_count: 1,
          credentials: {
            deploy_key: SECRET,
            temporary_deploy_key: TEMP_SECRET,
            temporary_deploy_key_expires_at: '2026-01-01T00:00:00Z',
          },
        }],
        meta: { has_more: false },
      };
    }
    if (path.startsWith('/v1/devices')) {
      return {
        data: [{ id: 'd1', name: 'LAPTOP', tenant: { id: 't1', name: 'Acme' },
          last_checkin_at: new Date().toISOString() }],
        meta: { has_more: false },
      };
    }
    return { data: [{ id: 'inv1', tenant: { id: 't1', name: 'Acme' } }], meta: { has_more: false } };
  },
} as unknown as TodylClient;

/**
 * Arguments chosen to genuinely SUCCEED against the fixture above, per tool —
 * deliberately NOT one shared bag. A shared bag risks satisfying some tools
 * while erroring others (since Task 11, an unmatched tenant is an ERROR, not
 * an empty result), and an error result trivially contains no secret — which
 * would let this sweep go green having exercised nothing. This exact failure
 * mode has recurred seven times in this project; see `isError` assertion below
 * for the other half of the fix.
 */
const ARGS_FOR: Record<string, unknown> = {
  'list-devices': { tenant: 'Acme' },
  'get-device': { identifier: 'LAPTOP' },
  'device-posture-summary': { tenant: 'Acme' },
  'list-deployment-groups': { tenant: 'Acme' },
  'list-invoices': { tenant: 'Acme' },
  'tenant-report': { tenant: 'Acme' },
};

/**
 * Tools whose success payload actually surfaces a deployment group. Only
 * these can prove the scrub ran on real, secret-bearing data — asserting
 * "no secret substring" on a device or invoice payload proves nothing, since
 * those datasets never carried one to begin with.
 */
const CARRIES_DEPLOYMENT_GROUP = new Set(['list-deployment-groups', 'tenant-report']);

describe('no tool may ever leak a deploy key', () => {
  it.each(TODYL_TOOLS.map((t) => [t.name, t] as const))(
    '%s output contains no enrollment secret',
    async (name, tool) => {
      const args = ARGS_FOR[name];
      if (args === undefined) {
        throw new Error(`No success-case arguments defined in ARGS_FOR for tool "${name}" — add one.`);
      }

      const repo = createRepository(client, config);
      const result = await tool.execute(args, repo);
      const serialized = JSON.stringify(result);

      // Prove the tool actually succeeded and returned a real payload — an
      // error result would trivially pass every assertion below without
      // having serialized anything.
      expect(result.isError).toBeFalsy();

      if (CARRIES_DEPLOYMENT_GROUP.has(name)) {
        // Prove a real deployment group (with its secrets scrubbed) was
        // serialized and found clean — not merely that nothing relevant
        // appeared in the payload at all.
        expect(serialized).toContain('g1');
      }

      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain(TEMP_SECRET);
      expect(serialized).not.toContain('deploy_key');
      expect(serialized).not.toContain('credentials');
    }
  );
});
