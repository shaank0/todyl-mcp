import { z } from 'zod';
import { matchesTenant } from '../filters.js';
import type { TodylRepository } from '../todyl/repository.js';
import { ambiguousTenantError, ok, warningFor, type TodylTool } from './result.js';

export const listDeploymentGroupsTool: TodylTool = {
  name: 'list-deployment-groups',
  title: 'List Todyl deployment groups',
  description:
    'List Todyl deployment groups (licensing groups) with their bundle, enabled products, device count and ' +
    'tenant. Enrollment credentials are never returned — get a deploy key from the Todyl portal if you need one.',
  inputSchema: {
    tenant: z.string().optional().describe('Restrict to one tenant, by name (case-insensitive) or exact id.'),
  },
  readOnly: true,
  async execute(args, repo: TodylRepository) {
    const { tenant } = args as { tenant?: string };
    const dataset = await repo.deploymentGroups();

    if (tenant) {
      const clash = ambiguousTenantError(dataset.items, tenant, (g) => g.tenant);
      if (clash) return clash;
    }

    const groups = tenant ? dataset.items.filter((g) => matchesTenant(g.tenant, tenant)) : dataset.items;

    return ok({
      matched: groups.length,
      total: dataset.items.length,
      groups,
      ...(warningFor(dataset) ? { warning: warningFor(dataset) } : {}),
    });
  },
};
