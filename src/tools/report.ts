import { z } from 'zod';
import { agentOutdated, isStale, matchesTenant, needsReboot, resolveTenantMatches, tamperOff } from '../filters.js';
import { TodylError } from '../todyl/errors.js';
import type { Dataset, TodylRepository } from '../todyl/repository.js';
import type { DeploymentGroup, Device, Invoice, TenantRef } from '../todyl/types.js';
import { filterInvoicesForTenant, invoiceTenantRefs } from './invoices.js';
import { ambiguousTenantErrorMultiRef, ok, toolError, warningFor, type TodylTool } from './result.js';

/** One dataset's outcome: either its usual `Dataset<T>`, or the error that stopped it. */
type SectionResult<T> =
  | { ok: true; dataset: Dataset<T> }
  | { ok: false; error: { status: number; message: string } };

/**
 * Fetch one dataset, converting a thrown error into a section-local failure
 * instead of letting it abort the whole report. A 403 on invoices (e.g. a
 * token whose ACL lacks billing:read) must not also discard devices and
 * groups that succeeded — see the fix-round-1 ruling. This does NOT relax
 * the repository's own "never mask a config error with stale data" rule:
 * `repo.devices()` etc. still only swallow 5xx/network errors internally
 * (see repository.ts's `load`); anything that reaches here (4xx, auth,
 * parsing) is a real failure that must be reported, not hidden.
 */
async function loadSection<T>(fetcher: () => Promise<Dataset<T>>): Promise<SectionResult<T>> {
  try {
    return { ok: true, dataset: await fetcher() };
  } catch (err) {
    const status = err instanceof TodylError ? err.status : 0;
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { status, message } };
  }
}

/** Shape of a failed section as it appears in the tool payload — never an empty array. */
function sectionError(datasetLabel: string, error: { status: number; message: string }) {
  return {
    error: true as const,
    dataset: datasetLabel,
    status: error.status || undefined,
    message: error.message,
  };
}

export const tenantReportTool: TodylTool = {
  name: 'tenant-report',
  title: 'Todyl report for one client',
  description:
    'Everything Todyl knows about one client in a single call: device count and security posture, deployment ' +
    'groups with their products, and recent invoices. Intended for a QBR or a client summary — use this ' +
    'instead of calling the individual list tools three times. If Todyl refuses one of the three underlying ' +
    'reads (e.g. an API token missing billing access), the other two are still returned, and the failed ' +
    'section is marked with an explicit error rather than an empty list — check `incomplete` before treating ' +
    'any zero as a real count.',
  inputSchema: {
    tenant: z.string().describe('Tenant name (case-insensitive) or exact tenant id.'),
    stale_days: z.number().int().nonnegative().optional()
      .describe('Days without a check-in before a device counts as stale. 0 means "stale if it missed today\'s check-in". Default 30.'),
    start_date: z.string().optional().describe('First invoice month, YYYY-MM. Defaults to the current month.'),
    end_date: z.string().optional().describe('Last invoice month, YYYY-MM.'),
  },
  readOnly: true,
  async execute(args, repo: TodylRepository) {
    const { tenant, stale_days: staleDays = 30, start_date: start, end_date: end } = args as {
      tenant: string; stale_days?: number; start_date?: string; end_date?: string;
    };
    const now = new Date();

    // Each dataset fails or succeeds independently — see loadSection.
    const [devicesResult, groupsResult, invoicesResult] = await Promise.all([
      loadSection<Device>(() => repo.devices()),
      loadSection<DeploymentGroup>(() => repo.deploymentGroups()),
      loadSection<Invoice>(() => repo.invoices(start, end)),
    ]);

    if (!devicesResult.ok && !groupsResult.ok && !invoicesResult.ok) {
      const parts = [
        `devices (${devicesResult.error.status || 'error'}: ${devicesResult.error.message})`,
        `deployment groups (${groupsResult.error.status || 'error'}: ${groupsResult.error.message})`,
        `invoices (${invoicesResult.error.status || 'error'}: ${invoicesResult.error.message})`,
      ];
      return toolError(`Todyl could not be reached for any dataset — ${parts.join('; ')}`);
    }

    // Build the tenant namespace from every dataset that succeeded, and resolve
    // identity exactly once against it (see resolveTenantMatches).
    const allRefs = new Map<string, TenantRef>();
    const note = (ref: TenantRef | undefined) => {
      if (ref?.id) allRefs.set(ref.id, ref);
    };
    if (devicesResult.ok) for (const d of devicesResult.dataset.items) note(d.tenant);
    if (groupsResult.ok) for (const g of groupsResult.dataset.items) note(g.tenant);
    if (invoicesResult.ok) {
      for (const i of invoicesResult.dataset.items) {
        for (const ref of invoiceTenantRefs(i)) note(ref);
      }
    }

    const matches = resolveTenantMatches([...allRefs.values()], tenant);

    if (matches.length === 0) {
      const known = [...new Set([...allRefs.values()].map((r) => r.name).filter(Boolean))].sort();
      return toolError(
        `No Todyl tenant matches "${tenant}". Known tenants: ${known.join(', ') || '(none)'}.`
      );
    }
    if (matches.length > 1) {
      // Reuses the existing ambiguity-message formatting rather than a new copy.
      // Re-running resolveTenantMatches over exactly `matches` is idempotent (they
      // were already selected by the same name-first/id-fallback rule), so this is
      // guaranteed to return an error — the fallback exists only to keep the
      // return type sound for TypeScript.
      return (
        ambiguousTenantErrorMultiRef(matches, tenant, (ref) => [ref]) ??
        toolError(`More than one tenant matches "${tenant}".`)
      );
    }

    const tenantRef = matches[0];

    // From here on, every dataset is filtered by the RESOLVED id, not by
    // re-matching the user's original string — the string was interpreted once.
    const posture = devicesResult.ok
      ? (() => {
          const mine = devicesResult.dataset.items.filter((d) => matchesTenant(d.tenant, tenantRef.id));
          return {
            devices: mine.length,
            stale: mine.filter((d) => isStale(d, staleDays, now)).length,
            needs_reboot: mine.filter((d) => needsReboot(d, now)).length,
            tamper_protection_off: mine.filter(tamperOff).length,
            agent_outdated: mine.filter(agentOutdated).length,
          };
        })()
      : sectionError('devices', devicesResult.error);

    const deploymentGroups = groupsResult.ok
      ? groupsResult.dataset.items.filter((g) => matchesTenant(g.tenant, tenantRef.id))
      : sectionError('deployment groups', groupsResult.error);

    // Reuses list-invoices' own matching + covers_multiple_tenants marking (now
    // keyed on the resolved id) so the same question gets the same answer either way.
    const invoicesSection = invoicesResult.ok
      ? filterInvoicesForTenant(invoicesResult.dataset.items, tenantRef.id)
      : sectionError('invoices', invoicesResult.error);

    const warnings = [
      devicesResult.ok ? warningFor(devicesResult.dataset, 'devices') : undefined,
      groupsResult.ok ? warningFor(groupsResult.dataset, 'deployment groups') : undefined,
      invoicesResult.ok ? warningFor(invoicesResult.dataset, 'invoices') : undefined,
    ].filter((w): w is string => Boolean(w));

    const incomplete = !devicesResult.ok || !groupsResult.ok || !invoicesResult.ok;

    return ok({
      tenant: tenantRef.name ?? tenant,
      tenant_id: tenantRef.id,
      incomplete,
      stale_days: staleDays,
      posture,
      deployment_groups: deploymentGroups,
      invoices: invoicesSection,
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    });
  },
};
