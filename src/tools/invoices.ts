import { z } from 'zod';
import { matchesTenant } from '../filters.js';
import type { TodylRepository } from '../todyl/repository.js';
import { ambiguousTenantError, ok, toolError, warningFor, type TodylTool } from './result.js';

const MONTH = /^\d{4}-\d{2}$/;

export const listInvoicesTool: TodylTool = {
  name: 'list-invoices',
  title: 'List Todyl invoices',
  description:
    'List invoices issued to your Todyl partner tenant within a month window. Both dates are YYYY-MM and ' +
    'inclusive; they default to the current month, and Todyl only retains 12 months. Returns status, period, ' +
    'subtotal, currency and the tenant (plus subtenants) each invoice covers.',
  inputSchema: {
    start_date: z.string().optional().describe('First month of the window, YYYY-MM. At most 12 months ago.'),
    end_date: z.string().optional().describe('Last month of the window, YYYY-MM. Must not be before start_date.'),
    tenant: z.string().optional().describe('Restrict to one tenant, by name (case-insensitive) or exact id.'),
  },
  readOnly: true,
  async execute(args, repo: TodylRepository) {
    const { start_date: start, end_date: end, tenant } = args as {
      start_date?: string; end_date?: string; tenant?: string;
    };

    for (const [label, value] of [['start_date', start], ['end_date', end]] as const) {
      if (value && !MONTH.test(value)) {
        return toolError(`${label} must be in YYYY-MM format (e.g. 2026-04). Got "${value}".`);
      }
    }
    if (start && end && end < start) {
      return toolError(`end_date (${end}) must not be before start_date (${start}).`);
    }

    const dataset = await repo.invoices(start, end);

    if (tenant) {
      const clash = ambiguousTenantError(dataset.items, tenant, (i) => i.tenant);
      if (clash) return clash;
    }

    const invoices = tenant ? dataset.items.filter((i) => matchesTenant(i.tenant, tenant)) : dataset.items;

    return ok({
      window: { start_date: start ?? 'current month', end_date: end ?? 'current month' },
      matched: invoices.length,
      invoices,
      ...(warningFor(dataset) ? { warning: warningFor(dataset) } : {}),
    });
  },
};
