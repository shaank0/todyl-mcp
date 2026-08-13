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
 * nothing".
 *
 * `note` MUST carry every caveat about how complete the search was: a dataset
 * that failed to load, a sweep that hit the page cap, a stale cached read.
 * "No such tenant" reads as authoritative — far more so than a `matched: 0` —
 * and someone acting on it may conclude a client was never onboarded. If we
 * stopped reading before reaching them, the denial has to say so in the same
 * breath. Callers pass `warningFor(dataset, noun)` (and, for multi-dataset
 * tools, their load-failure note) here.
 */
export function unknownTenantError(
  refs: TenantRef[],
  tenant: string,
  scope: string,
  note?: string
): ToolResult {
  const known = [...new Set(refs.map((r) => r.name).filter(Boolean))].sort();
  const caveat = note?.trim() ? ` ${note.trim()}` : '';
  return toolError(
    `No Todyl tenant matches "${tenant}" among ${scope}. ` +
      `That list is what this tool can see, not every client in Todyl — a client with no ` +
      `such records yet will be absent here while still existing. Found: ` +
      `${known.join(', ') || '(none)'}.${caveat}`
  );
}

/**
 * What a tool's tenant namespace is actually built from. Passed to
 * `unknownTenantError` so the denial states its own scope.
 *
 * Each list tool knows only its own dataset: a newly-onboarded client with
 * deployment groups and invoices but no agents deployed yet is genuinely absent
 * from the devices namespace, on the happy path, with nothing truncated. Saying
 * "No Todyl tenant matches X. Known tenants: …" there states a dataset-local
 * fact as a global one, and someone acting on it concludes the client was never
 * onboarded. (The list tools must NOT union all three datasets to fix this —
 * that would make `list-devices` fail for a token lacking `billing.invoices:read`,
 * which is the coupling Task 11's per-section failure tolerance removed.)
 */
export const TENANT_SCOPE = {
  devices: 'tenants that own at least one device',
  groups: 'tenants that have a deployment group',
  invoices: 'tenants appearing on an invoice in this window',
  allReadable: 'the tenants visible in the datasets this report could read',
} as const;

/**
 * The outcome of resolving a tenant string: either a resolved ref, or an error
 * ToolResult to return as-is.
 *
 * Deliberately a DISCRIMINATED union on `ok` rather than `{ref?, problem?}`.
 * With optional fields, a caller who forgets the guard writes `result.ref!.id`
 * and gets a runtime crash; here `ref` does not exist on the type until `ok`
 * has been narrowed, so `tsc` rejects it. The specific oversight this encodes —
 * "resolve, then use the result without handling the failure branch" — has
 * recurred four times in this file's history, which is enough evidence that
 * convention is not holding it and the compiler should.
 */
export type TenantResolution =
  | { ok: true; ref: TenantRef }
  | { ok: false; problem: ToolResult };

/**
 * Resolve a caller-supplied tenant string to exactly ONE tenant ref, against
 * the complete candidate set, exactly once. This is the single entry point for
 * every tool that accepts a `tenant` argument.
 *
 * Returns either `{ ok: true, ref }` — resolved, and the ONLY thing a filter
 * may key off is `ref.id` (see `isTenantId`) — or `{ ok: false, problem }`, an
 * error ToolResult to return directly. There is deliberately no third "nothing
 * matched, carry on" outcome: an earlier design returned `{}` there and left callers writing
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
 *
 * `scope` names the namespace these refs came from (see `TENANT_SCOPE`) and
 * `notFoundNote` carries how complete the underlying read was — see
 * `unknownTenantError`. Every caller must pass both.
 */
export function resolveTenantOrProblem(
  refs: TenantRef[],
  tenant: string,
  scope: string,
  notFoundNote?: string
): TenantResolution {
  const matches = resolveTenantMatches(refs, tenant);
  if (matches.length === 0) {
    return { ok: false, problem: unknownTenantError(refs, tenant, scope, notFoundNote) };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      problem:
        ambiguousTenantErrorMultiRef(matches, tenant, (ref) => [ref]) ??
        toolError(`More than one tenant matches "${tenant}".`),
    };
  }
  return { ok: true, ref: matches[0] };
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
