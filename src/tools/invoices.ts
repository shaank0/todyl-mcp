import { z } from 'zod';
import { isTenantId } from '../filters.js';
import type { TodylRepository } from '../todyl/repository.js';
import type { Invoice, TenantRef } from '../todyl/types.js';
import { ok, resolveTenantOrProblem, toolError, warningFor, type TodylTool } from './result.js';

const MONTH = /^\d{4}-\d{2}$/;

type InvoiceLike = { tenant?: TenantRef; subtenants?: TenantRef[] };

/**
 * Check if an invoice belongs to an ALREADY-RESOLVED tenant id, either as primary
 * tenant or via subtenants. Returns { matched, viaTenant } to track whether the
 * match came via a subtenant.
 *
 * Takes an id, not a search string, and compares it strictly: the caller's string
 * is interpreted once, up front, against the whole tenant namespace (see
 * `resolveTenantOrProblem`). Exported because the exact "primary vs. subtenant"
 * distinction here is what drives `covers_multiple_tenants` — a report tool asking
 * "what does client X owe" must use the same rule list-invoices does, or the same
 * question gets two different answers.
 */
export function invoiceMatchesTenantId(
  invoice: InvoiceLike,
  tenantId: string
): { matched: boolean; viaTenant: boolean } {
  if (isTenantId(invoice.tenant, tenantId)) return { matched: true, viaTenant: true };
  if (invoice.subtenants?.some((st) => isTenantId(st, tenantId))) return { matched: true, viaTenant: false };
  return { matched: false, viaTenant: false };
}

/**
 * Every tenant ref an invoice carries — its primary tenant plus any subtenants —
 * regardless of whether any of them match a search string. This is the
 * UNFILTERED candidate picker for `ambiguousTenantErrorMultiRef`: the shared
 * `resolveTenantMatches` resolver needs the full candidate set to apply its
 * name-first/id-fallback precedence, so pre-filtering here (as this function
 * used to) would defeat that policy before it ever ran. Exported for reuse by
 * other tools that need every tenant an invoice touches (e.g. tenant-report).
 */
export function invoiceTenantRefs(invoice: InvoiceLike): TenantRef[] {
  const refs: TenantRef[] = [];
  if (invoice.tenant) refs.push(invoice.tenant);
  if (invoice.subtenants) refs.push(...invoice.subtenants);
  return refs;
}

/**
 * Filter a list of invoices down to those belonging to a RESOLVED tenant id (by
 * primary tenant or subtenant), marking `covers_multiple_tenants: true` when the
 * match came via a subtenant — its subtotal spans the parent tenant and all its
 * subtenants, not just the one that matched. The single source of truth for this
 * rule; reused by both list-invoices and tenant-report so the same question gets
 * the same answer.
 */
export function filterInvoicesForTenantId<T extends InvoiceLike>(
  items: T[],
  tenantId: string
): (T & { covers_multiple_tenants?: true })[] {
  const marked: (T & { covers_multiple_tenants?: true })[] = [];
  for (const item of items) {
    const { matched, viaTenant } = invoiceMatchesTenantId(item, tenantId);
    if (!matched) continue;
    marked.push(viaTenant ? item : { ...item, covers_multiple_tenants: true });
  }
  return marked;
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
    'all its subtenants—not the subtenant alone. An unrecognized "tenant" is an error naming the known ' +
    'tenants, not an empty result.',
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

    let invoices: (Invoice & { covers_multiple_tenants?: true })[] = dataset.items;
    if (tenant) {
      const candidates = dataset.items.flatMap((inv) => invoiceTenantRefs(inv));
      // The warning goes with the not-found answer — denying that a client
      // exists on the strength of a read that stopped early is the same
      // unsupported confidence as reporting a wrong total.
      const resolved = resolveTenantOrProblem(candidates, tenant, warningFor(dataset, 'invoices'));
      if (!resolved.ok) return resolved.problem;
      // Filter (and mark covers_multiple_tenants) by the RESOLVED id, never by
      // re-matching the raw search string — an unrelated tenant whose opaque id
      // happens to equal the search string must not be folded into this client's
      // invoice list. Someone else's bill inside this client's is the worst
      // version of this bug.
      invoices = filterInvoicesForTenantId(dataset.items, resolved.ref.id);
    }

    return ok({
      window: { start_date: start ?? 'current month', end_date: end ?? 'current month' },
      matched: invoices.length,
      invoices,
      ...(warningFor(dataset, 'invoices') ? { warning: warningFor(dataset, 'invoices') } : {}),
    });
  },
};
