import { z } from 'zod';
import { agentOutdated, isStale, isTenantId, needsReboot, tamperOff } from '../filters.js';
import type { TodylRepository } from '../todyl/repository.js';
import type { Device, TenantRef } from '../todyl/types.js';
import { ok, resolveTenantOrProblem, warningFor, type TodylTool } from './result.js';

interface Counts {
  devices: number;
  stale: number;
  needs_reboot: number;
  tamper_protection_off: number;
  agent_outdated: number;
}

const empty = (): Counts => ({
  devices: 0, stale: 0, needs_reboot: 0, tamper_protection_off: 0, agent_outdated: 0,
});

function tally(counts: Counts, device: Device, staleDays: number, now: Date): void {
  counts.devices += 1;
  if (isStale(device, staleDays, now)) counts.stale += 1;
  if (needsReboot(device, now)) counts.needs_reboot += 1;
  if (tamperOff(device)) counts.tamper_protection_off += 1;
  if (agentOutdated(device)) counts.agent_outdated += 1;
}

export const devicePostureSummaryTool: TodylTool = {
  name: 'device-posture-summary',
  title: 'Todyl device posture summary',
  description:
    'Roll up Todyl device security posture: how many devices are stale (no recent check-in), need a reboot, ' +
    'have tamper protection off, or are behind on agent version — in total and broken down per tenant. ' +
    'Use this to answer "how are we doing" or to see which clients need attention. ' +
    'The per-tenant breakdown also serves as the list of tenants and their device counts.',
  inputSchema: {
    tenant: z.string().optional().describe('Restrict to one tenant, by name (case-insensitive) or exact id.'),
    stale_days: z.number().int().nonnegative().optional()
      .describe('Days without a check-in before a device counts as stale. 0 means "stale if it missed today\'s check-in". Default 30.'),
  },
  readOnly: true,
  async execute(args, repo: TodylRepository) {
    const { tenant, stale_days: staleDays = 30 } = args as { tenant?: string; stale_days?: number };
    const now = new Date();
    const dataset = await repo.devices();

    let scoped = dataset.items;
    if (tenant) {
      const candidates = dataset.items.map((d) => d.tenant).filter((t): t is TenantRef => Boolean(t));
      // The warning goes with the not-found answer — a truncated or stale sweep
      // must not report a client as nonexistent when we stopped reading early.
      const resolved = resolveTenantOrProblem(candidates, tenant, warningFor(dataset));
      if (!resolved.ok) return resolved.problem;
      // Filter by the RESOLVED id, never by re-matching the raw search string.
      // A summary is where this matters most: an unrelated tenant folded in here
      // corrupts BOTH the per-tenant breakdown and the totals, and a wrong total
      // has no visible cause — it just reads as a number.
      scoped = dataset.items.filter((d) => isTenantId(d.tenant, resolved.ref.id));
    }

    const totals = empty();
    const perTenant = new Map<string, Counts & { tenant: string; tenant_id: string }>();

    for (const device of scoped) {
      tally(totals, device, staleDays, now);
      const id = device.tenant?.id ?? 'unknown';
      let bucket = perTenant.get(id);
      if (!bucket) {
        bucket = { tenant: device.tenant?.name ?? 'unknown', tenant_id: id, ...empty() };
        perTenant.set(id, bucket);
      }
      tally(bucket, device, staleDays, now);
    }

    const byTenant = [...perTenant.values()].sort((a, b) => b.devices - a.devices);

    return ok({
      stale_days: staleDays,
      totals,
      by_tenant: byTenant,
      ...(warningFor(dataset) ? { warning: warningFor(dataset) } : {}),
    });
  },
};
