import { z } from 'zod';
import { matchesTenant } from '../filters.js';
import type { TodylRepository } from '../todyl/repository.js';
import { ambiguousTenantErrorMultiRef, ok, toolError, warningFor, type TodylTool } from './result.js';

const MONTH = /^\d{4}-\d{2}$/;

/**
 * Check if an invoice matches a tenant, either as primary tenant or via subtenants.
 * Returns { matched: boolean, viaTenant: boolean } to track if the match came via a subtenant.
 */
function invoiceMatchesTenant(
  invoice: { tenant?: { id: string; name: string }; subtenants?: { id: string; name: string }[] },
  tenant: string
): { matched: boolean; viaTenant: boolean } {
  if (matchesTenant(invoice.tenant, tenant)) return { matched: true, viaTenant: true };
  if (invoice.subtenants?.some((st) => matchesTenant(st, tenant))) return { matched: true, viaTenant: false };
  return { matched: false, viaTenant: false };
}

/**
 * Extract all tenants that match a search string, including both primary tenant and subtenants.
 */
function allTenantRefsMatching(
  invoice: { tenant?: { id: string; name: string }; subtenants?: { id: string; name: string }[] },
  needle: string
): { id: string; name: string }[] {
  const matches: { id: string; name: string }[] = [];
  if (matchesTenant(invoice.tenant, needle)) matches.push(invoice.tenant!);
  if (invoice.subtenants) {
    for (const st of invoice.subtenants) {
      if (matchesTenant(st, needle) && !matches.some((m) => m.id === st.id)) {
        matches.push(st);
      }
    }
  }
  return matches;
}

/**
 * Helper for building a picker for ambiguousTenantErrorMultiRef.
 */
function pickAllInvoiceTenants(
  invoice: { tenant?: { id: string; name: string }; subtenants?: { id: string; name: string }[] },
  needle: string
): { id: string; name: string }[] {
  return allTenantRefsMatching(invoice, needle);
}

export const listInvoicesTool: TodylTool = {
  name: 'list-invoices',
  title: 'List Todyl invoices',
  description:
    'List invoices issued to your Todyl partner tenant within a month window. Both dates are YYYY-MM and ' +
    'inclusive; they default to the current month, and Todyl only retains 12 months. Returns status, period, ' +
    'subtotal, currency and the tenant (plus subtenants) each invoice covers. When filtering by tenant, ' +
    'invoices matching via the primary tenant are returned without flags. If a match comes via a subtenant, ' +
    'the invoice is marked `covers_multiple_tenants: true` because its subtotal spans the parent tenant and ' +
    'all its subtenants—not the subtenant alone.',
  inputSchema: {
    start_date: z.string().optional().describe('First month of the window, YYYY-MM. At most 12 months ago.'),
    end_date: z.string().optional().describe('Last month of the window, YYYY-MM. Must not be before start_date.'),
    tenant: z.string().optional().describe('Restrict to one tenant, by name (case-insensitive) or exact id.'),
  },
  readOnly: true,
  async execute(args, repo: TodylRepository) {
    let { start_date: start, end_date: end, tenant } = args as {
      start_date?: string; end_date?: string; tenant?: string;
    };

    // Normalize empty strings to undefined
    if (start === '') start = undefined;
    if (end === '') end = undefined;
    if (tenant === '') tenant = undefined;

    for (const [label, value] of [['start_date', start], ['end_date', end]] as const) {
      if (value && !MONTH.test(value)) {
        return toolError(`${label} must be in YYYY-MM format (e.g. 2026-04). Got "${value}".`);
      }
      if (value) {
        const month = parseInt(value.split('-')[1], 10);
        if (month < 1 || month > 12) {
          return toolError(`${label} must have a valid month (01-12) in YYYY-MM format. Got "${value}".`);
        }
      }
    }
    if (start && end && end < start) {
      return toolError(`end_date (${end}) must not be before start_date (${start}).`);
    }

    const dataset = await repo.invoices(start, end);

    if (tenant) {
      const clash = ambiguousTenantErrorMultiRef(dataset.items, tenant, (inv) =>
        pickAllInvoiceTenants(inv, tenant)
      );
      if (clash) return clash;
    }

    const invoicesWithMarking = dataset.items.map((i) => {
      if (!tenant) return i;
      const { matched, viaTenant } = invoiceMatchesTenant(i, tenant);
      if (!matched) return null;
      // Only flag when matched via subtenant: the primary tenant legitimately owns the full subtotal.
      // When the subtenant matches, the subtotal spans parent + all subtenants, not that subtenant alone.
      return {
        ...i,
        ...(viaTenant ? {} : { covers_multiple_tenants: true }),
      };
    }).filter((i) => i !== null);

    const invoices = tenant ? invoicesWithMarking : dataset.items;

    return ok({
      window: { start_date: start ?? 'current month', end_date: end ?? 'current month' },
      matched: invoices.length,
      invoices,
      ...(warningFor(dataset) ? { warning: warningFor(dataset) } : {}),
    });
  },
};
