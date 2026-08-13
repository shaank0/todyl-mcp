import { z } from 'zod';
import { agentOutdated, isStale, matchesTenant, needsReboot, tamperOff } from '../filters.js';
import type { TodylRepository } from '../todyl/repository.js';
import type { TenantRef } from '../todyl/types.js';
import { allTenantRefsMatching, filterInvoicesForTenant } from './invoices.js';
import { ambiguousTenantError, ambiguousTenantErrorMultiRef, ok, toolError, warningFor, type TodylTool } from './result.js';

export const tenantReportTool: TodylTool = {
  name: 'tenant-report',
  title: 'Todyl report for one client',
  description:
    'Everything Todyl knows about one client in a single call: device count and security posture, deployment ' +
    'groups with their products, and recent invoices. Intended for a QBR or a client summary — use this ' +
    'instead of calling the individual list tools three times.',
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

    // Fetch all three datasets up front: a client can have invoices or a deployment
    // group with zero devices, and deciding "unknown tenant" from devices alone
    // would misreport that client as not found.
    const [devices, groups, invoices] = await Promise.all([
      repo.devices(),
      repo.deploymentGroups(),
      repo.invoices(start, end),
    ]);

    // Ambiguity checks per dataset, each using that dataset's own matching rule —
    // invoices must use the primary-tenant-or-subtenant picker so a name that's
    // unambiguous among devices but clashes via an invoice subtenant is still caught.
    const deviceClash = ambiguousTenantError(devices.items, tenant, (d) => d.tenant);
    if (deviceClash) return deviceClash;
    const groupClash = ambiguousTenantError(groups.items, tenant, (g) => g.tenant);
    if (groupClash) return groupClash;
    const invoiceClash = ambiguousTenantErrorMultiRef(invoices.items, tenant, (inv) =>
      allTenantRefsMatching(inv, tenant)
    );
    if (invoiceClash) return invoiceClash;

    const mineDevices = devices.items.filter((d) => matchesTenant(d.tenant, tenant));
    const mineGroups = groups.items.filter((g) => matchesTenant(g.tenant, tenant));
    // Reuses list-invoices' own matching + covers_multiple_tenants marking so the
    // same question ("what does client X owe") gets the same answer either way.
    const mineInvoices = filterInvoicesForTenant(invoices.items, tenant);

    if (mineDevices.length === 0 && mineGroups.length === 0 && mineInvoices.length === 0) {
      const known = new Set<string>();
      const collect = (ref: TenantRef | undefined) => {
        if (ref?.name) known.add(ref.name);
      };
      for (const d of devices.items) collect(d.tenant);
      for (const g of groups.items) collect(g.tenant);
      for (const i of invoices.items) {
        collect(i.tenant);
        for (const st of i.subtenants ?? []) collect(st);
      }
      return toolError(
        `No Todyl tenant matches "${tenant}". Known tenants: ${[...known].sort().join(', ') || '(none)'}.`
      );
    }

    const tenantRef: TenantRef | undefined =
      mineDevices[0]?.tenant ?? mineGroups[0]?.tenant ?? mineInvoices[0]?.tenant;

    // Surface truncation/staleness per dataset — a device sweep that hit the page cap
    // is a different problem from an incomplete invoice window, and each warning
    // names which one it is (via warningFor's noun) rather than always saying "devices".
    const warnings = [
      warningFor(devices, 'devices'),
      warningFor(groups, 'deployment groups'),
      warningFor(invoices, 'invoices'),
    ].filter((w): w is string => Boolean(w));

    return ok({
      tenant: tenantRef?.name ?? tenant,
      tenant_id: tenantRef?.id,
      stale_days: staleDays,
      posture: {
        devices: mineDevices.length,
        stale: mineDevices.filter((d) => isStale(d, staleDays, now)).length,
        needs_reboot: mineDevices.filter((d) => needsReboot(d, now)).length,
        tamper_protection_off: mineDevices.filter(tamperOff).length,
        agent_outdated: mineDevices.filter(agentOutdated).length,
      },
      deployment_groups: mineGroups,
      invoices: mineInvoices,
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    });
  },
};
