import type { z } from 'zod';
import { distinctTenantsMatching } from '../filters.js';
import type { TodylRepository } from '../todyl/repository.js';
import type { TenantRef } from '../todyl/types.js';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface TodylTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  readOnly: true;
  execute(args: any, repo: TodylRepository): Promise<ToolResult>;
}

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/**
 * Format an ambiguity error when multiple tenants match a search string.
 */
function ambiguityMessage(tenant: string, matches: TenantRef[]): string {
  const candidates = matches.map((t) => `${t.name} (${t.id})`).join('; ');
  return `More than one tenant matches "${tenant}" — pass the tenant id instead. Candidates: ${candidates}`;
}

/**
 * Check for ambiguous tenant matches across a picker that returns multiple refs.
 * Deduplicates by tenant id and returns error if more than one distinct tenant matches.
 */
export function ambiguousTenantErrorMultiRef<T>(
  items: T[],
  tenant: string,
  pick: (item: T) => TenantRef[]
): ToolResult | undefined {
  const byId = new Map<string, TenantRef>();
  for (const item of items) {
    const refs = pick(item);
    for (const ref of refs) {
      if (ref && distinctTenantsMatching([ref], tenant, (r) => r).length > 0) {
        byId.set(ref.id, ref);
      }
    }
  }
  const matches = [...byId.values()];
  if (matches.length <= 1) return undefined;
  return toolError(ambiguityMessage(tenant, matches));
}

/**
 * Refuse an ambiguous tenant name rather than merging two clients' data into
 * one answer. Returns an error result to return directly, or undefined when
 * the name is unambiguous. Every tool accepting `tenant` must call this.
 */
export function ambiguousTenantError<T>(
  items: T[],
  tenant: string,
  pick: (item: T) => TenantRef | undefined
): ToolResult | undefined {
  return ambiguousTenantErrorMultiRef(items, tenant, (item) => {
    const ref = pick(item);
    return ref ? [ref] : [];
  });
}

/**
 * Combine the sweep-truncation and cache-staleness warnings into one field.
 *
 * `noun` names what was being read (plural — "devices", "deployment groups",
 * "invoices") so the message says which dataset was incomplete rather than
 * always claiming it was devices. Defaults to "devices" to match every
 * pre-existing call site's wording.
 */
export function warningFor(
  dataset: { truncated: boolean; staleWarning?: string },
  noun: string = 'devices'
): string | undefined {
  const parts: string[] = [];
  if (dataset.truncated) {
    parts.push(
      `Not all ${noun} were read — the page cap was reached, so these results are incomplete. ` +
        'Raise TODYL_MAX_PAGES if this persists.'
    );
  }
  if (dataset.staleWarning) parts.push(dataset.staleWarning);
  return parts.length ? parts.join(' ') : undefined;
}
