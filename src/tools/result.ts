import type { z } from 'zod';
import { resolveTenantMatches } from '../filters.js';
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
 *
 * Collects EVERY candidate ref from EVERY item first — regardless of whether it
 * matches — then resolves the whole set once via `resolveTenantMatches`. This
 * must not test refs one at a time: `resolveTenantMatches`'s name-first/id-
 * fallback precedence is a SET-level policy, and a single ref evaluated alone
 * always looks like the entire candidate set, which would let an id-only match
 * win in isolation even when a name match elsewhere in the true set should have
 * beaten it. Callers' `pick` should therefore return every ref an item carries
 * unconditionally (e.g. an invoice's primary tenant AND its subtenants), not a
 * pre-filtered subset.
 */
export function ambiguousTenantErrorMultiRef<T>(
  items: T[],
  tenant: string,
  pick: (item: T) => TenantRef[]
): ToolResult | undefined {
  const candidates: TenantRef[] = [];
  for (const item of items) {
    for (const ref of pick(item)) {
      if (ref) candidates.push(ref);
    }
  }
  const matches = resolveTenantMatches(candidates, tenant);
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
 * Resolve a tenant search string against a candidate ref set exactly ONCE —
 * the shared "resolve, then filter by the resolved id" step every tool that
 * accepts a `tenant` string must use for its FILTER, not just its ambiguity
 * check (fix-round-3 ruling: resolving cleanly at the ambiguity step but then
 * re-matching the raw string in the filter step lets an unrelated tenant whose
 * opaque id equals the search string slip back in and merge into the result —
 * exactly the cross-client leak `distinctTenantsMatching`'s ambiguity check
 * exists to prevent).
 *
 * Returns:
 *  - `{}` when nothing matches — not a new error condition; callers should
 *    filter to nothing exactly as before (resolving no candidates means the
 *    raw-string filter would also have matched nothing).
 *  - `{ clash }` when more than one distinct tenant matches — return this
 *    directly.
 *  - `{ ref }` on a clean, unambiguous resolution — filter by `ref.id`, never
 *    by the original search string.
 */
export function resolveTenantOrClash(
  refs: TenantRef[],
  tenant: string
): { ref?: TenantRef; clash?: ToolResult } {
  const matches = resolveTenantMatches(refs, tenant);
  if (matches.length === 0) return {};
  if (matches.length > 1) {
    return {
      clash:
        ambiguousTenantErrorMultiRef(matches, tenant, (ref) => [ref]) ??
        toolError(`More than one tenant matches "${tenant}".`),
    };
  }
  return { ref: matches[0] };
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
