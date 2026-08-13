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

// NOTE: there is deliberately no single-ref `ambiguousTenantError(items, tenant,
// pick)` helper any more. It made "check for ambiguity, then filter however you
// like" the path of least resistance, and `device-posture-summary` took it: it
// checked ambiguity correctly and then filtered on the RAW string, merging an
// unrelated tenant's devices into both the per-tenant breakdown and the totals.
// Resolution and filtering are one step now — `resolveTenantOrProblem` below.

/**
 * "No such tenant" — naming the tenants we actually know about, so the caller
 * can correct a typo instead of reading an empty result as "this client has
 * nothing". `note` appends a caveat when the search itself was incomplete
 * (e.g. a dataset that might have held the tenant failed to load).
 */
export function unknownTenantError(refs: TenantRef[], tenant: string, note = ''): ToolResult {
  const known = [...new Set(refs.map((r) => r.name).filter(Boolean))].sort();
  return toolError(
    `No Todyl tenant matches "${tenant}". Known tenants: ${known.join(', ') || '(none)'}.${note}`
  );
}

/**
 * Resolve a caller-supplied tenant string to exactly ONE tenant ref, against
 * the complete candidate set, exactly once. This is the single entry point for
 * every tool that accepts a `tenant` argument.
 *
 * Returns either `{ ref }` — resolved, and the ONLY thing a filter may key off
 * is `ref.id` (see `isTenantId`) — or `{ problem }`, an error ToolResult to
 * return directly. There is deliberately no third "nothing matched, carry on"
 * outcome: an earlier design returned `{}` there and left callers writing
 * `resolvedId ?? tenant`, which fell back to filtering by the RAW string. That
 * was harmless only while resolution and raw matching happened to agree on the
 * empty case, and it re-opened the cross-client merge the moment they diverged.
 * A tenant argument that resolves to nothing is now an explicit error, which is
 * also a more useful answer than a bare `matched: 0`.
 *
 * Why this must see the whole candidate set: `resolveTenantMatches`'s
 * name-first/id-fallback precedence is a SET-level policy (see its docs).
 * Callers collect every ref every item carries — unconditionally, unfiltered —
 * and call this once.
 */
export function resolveTenantOrProblem(
  refs: TenantRef[],
  tenant: string,
  notFoundNote = ''
): { ref?: TenantRef; problem?: ToolResult } {
  const matches = resolveTenantMatches(refs, tenant);
  if (matches.length === 0) return { problem: unknownTenantError(refs, tenant, notFoundNote) };
  if (matches.length > 1) {
    return {
      problem:
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
