import { z } from 'zod';
import { isTenantId } from '../filters.js';
import type { TodylRepository } from '../todyl/repository.js';
import type { TenantRef } from '../todyl/types.js';
import { ok, resolveTenantOrProblem, warningFor, type TodylTool } from './result.js';

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

    let groups = dataset.items;
    if (tenant) {
      const candidates = dataset.items.map((g) => g.tenant).filter((t): t is TenantRef => Boolean(t));
      const { ref, problem } = resolveTenantOrProblem(candidates, tenant);
      if (problem) return problem;
      // Filter by the RESOLVED id, never by re-matching the raw search string —
      // an unrelated tenant whose opaque id happens to equal the search string
      // must not be folded into this client's group list.
      groups = dataset.items.filter((g) => isTenantId(g.tenant, ref!.id));
    }

    return ok({
      matched: groups.length,
      total: dataset.items.length,
      groups,
      ...(warningFor(dataset, 'deployment groups') ? { warning: warningFor(dataset, 'deployment groups') } : {}),
    });
  },
};
