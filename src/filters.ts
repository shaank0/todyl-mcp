import type { Device, TenantRef } from './todyl/types.js';

const DAY_MS = 86_400_000;

/** A device that has NEVER checked in is stale, not excluded. */
export function isStale(device: Device, days: number, now: Date = new Date()): boolean {
  if (!device.last_checkin_at) return true;
  const seen = Date.parse(device.last_checkin_at);
  if (Number.isNaN(seen)) return true;
  return now.getTime() - seen > days * DAY_MS;
}

export function needsReboot(device: Device, now: Date = new Date()): boolean {
  if (!device.reboot_required_at) return false;
  const due = Date.parse(device.reboot_required_at);
  return !Number.isNaN(due) && due <= now.getTime();
}

/** Unknown counts as OFF — a posture check should fail safe. */
export function tamperOff(device: Device): boolean {
  return device.tamper_protection?.enabled !== true;
}

/** Both versions must be present; if we cannot compare, we do not claim drift. */
export function agentOutdated(device: Device): boolean {
  const os = device.operating_system;
  if (!os?.agent_version || !os?.latest_available_agent_version) return false;
  return os.agent_version !== os.latest_available_agent_version;
}

export function matchesTenant(ref: TenantRef | undefined, needle: string): boolean {
  if (!ref) return false;
  const wanted = needle.trim().toLowerCase();
  return ref.id === needle.trim() || (ref.name ?? '').toLowerCase() === wanted;
}

/**
 * Strict identity against an ALREADY-RESOLVED tenant id — the only comparison a
 * post-resolution filter may use.
 *
 * `matchesTenant` is a symmetric id-OR-name check, which is right for
 * interpreting a human's search string but wrong for filtering by a resolved
 * id: feeding a resolved id back through it would still match any OTHER tenant
 * whose *name* happened to equal that id, re-opening the cross-client merge by
 * the mirror image of the route this whole resolve-then-filter design closes.
 * Once the caller's string has been interpreted exactly once, only `id === id`
 * may decide which records belong to that tenant.
 */
export function isTenantId(ref: TenantRef | undefined, tenantId: string): boolean {
  return ref?.id === tenantId;
}

/**
 * Resolve which tenant(s) in a candidate set match a search string, preferring
 * exact NAME matches and falling back to id equality only when no name matches
 * exist. Todyl tenant ids are opaque 28-character strings; a human types a
 * recognizable company NAME and pastes an id only when they explicitly mean to
 * disambiguate. Without this precedence, an unrelated tenant whose opaque id
 * happens to equal the search string would compete with a clean, unique name
 * match and force a spurious refusal (or, worse, get silently folded into a
 * filtered result) — see docs/superpowers/plans task-11 fix rounds 1–2.
 *
 * This is a SET-level policy — it must be applied over the WHOLE candidate set
 * at once, never one ref at a time. A single ref evaluated in isolation always
 * "looks like" the entire set, so an id-only match tested alone would win where
 * a name match elsewhere in the true candidate set should have taken precedence
 * and the id-only match should have been ignored entirely. Every caller
 * (`distinctTenantsMatching`, `ambiguousTenantErrorMultiRef`) must collect every
 * candidate ref FIRST and call this once over the complete list.
 *
 * `matchesTenant` remains the plain per-ref boolean primitive used by per-item
 * filters (e.g. `applyDeviceFilters`) where no such precedence is wanted — only
 * resolution and ambiguity detection go through this function.
 */
export function resolveTenantMatches(refs: TenantRef[], needle: string): TenantRef[] {
  const wanted = needle.trim().toLowerCase();
  const byName = new Map<string, TenantRef>();
  for (const ref of refs) {
    if (ref && (ref.name ?? '').toLowerCase() === wanted) byName.set(ref.id, ref);
  }
  if (byName.size > 0) return [...byName.values()];

  const trimmed = needle.trim();
  const byId = new Map<string, TenantRef>();
  for (const ref of refs) {
    if (ref && ref.id === trimmed) byId.set(ref.id, ref);
  }
  return [...byId.values()];
}

/**
 * The distinct tenants a name or id matches. Two different clients can share
 * a display name, and silently merging their devices into one answer would be
 * worse than refusing — so tools use this to detect ambiguity and ask for an id.
 *
 * Collects every item's ref FIRST (regardless of whether it matches) and applies
 * `resolveTenantMatches` once over the complete candidate set — see that
 * function's docs for why this must not be done ref-by-ref.
 */
export function distinctTenantsMatching<T>(
  items: T[],
  needle: string,
  pick: (item: T) => TenantRef | undefined
): TenantRef[] {
  const candidates: TenantRef[] = [];
  for (const item of items) {
    const ref = pick(item);
    if (ref) candidates.push(ref);
  }
  return resolveTenantMatches(candidates, needle);
}

export interface DeviceFilters {
  /**
   * A RAW, un-interpreted search string (id or name). Tools must NOT pass this
   * — they resolve the caller's string once against the full candidate set and
   * pass `tenant_id` instead. Kept for direct/unit use of this function.
   */
  tenant?: string;
  /** An already-resolved tenant id, compared strictly (see `isTenantId`). */
  tenant_id?: string;
  search?: string;
  stale_days?: number;
  needs_reboot?: boolean;
  tamper_protection?: 'on' | 'off';
  agent_outdated?: boolean;
  billing_status?: string;
  device_type?: string;
  os_type?: string;
}

const eq = (value: string | undefined, wanted: string) =>
  (value ?? '').toLowerCase() === wanted.trim().toLowerCase();

export function applyDeviceFilters(
  devices: Device[],
  filters: DeviceFilters,
  now: Date = new Date()
): Device[] {
  return devices.filter((d) => {
    if (filters.tenant_id && !isTenantId(d.tenant, filters.tenant_id)) return false;
    if (filters.tenant && !matchesTenant(d.tenant, filters.tenant)) return false;

    if (filters.search) {
      const needle = filters.search.trim().toLowerCase();
      const haystack = [d.name, d.serial_number, d.udid].map((v) => (v ?? '').toLowerCase());
      if (!haystack.some((v) => v.includes(needle))) return false;
    }

    if (filters.stale_days !== undefined && !isStale(d, filters.stale_days, now)) return false;
    if (filters.needs_reboot !== undefined && needsReboot(d, now) !== filters.needs_reboot) return false;
    if (filters.tamper_protection !== undefined) {
      const off = tamperOff(d);
      if (filters.tamper_protection === 'off' ? !off : off) return false;
    }
    if (filters.agent_outdated !== undefined && agentOutdated(d) !== filters.agent_outdated) return false;
    if (filters.billing_status && !eq(d.billing_status, filters.billing_status)) return false;
    if (filters.device_type && !eq(d.device_type, filters.device_type)) return false;
    if (filters.os_type && !eq(d.operating_system?.type, filters.os_type)) return false;

    return true;
  });
}

/** Compact row for list output — the full record comes from get-device. */
export function projectDevice(device: Device): Record<string, unknown> {
  const os = device.operating_system;
  return {
    id: device.id,
    name: device.name,
    tenant: device.tenant?.name,
    os: [os?.type, os?.version].filter(Boolean).join(' ') || undefined,
    agent_version: os?.agent_version,
    latest_agent_version: os?.latest_available_agent_version,
    agent_outdated: agentOutdated(device),
    tamper_protection_off: tamperOff(device),
    needs_reboot: needsReboot(device),
    last_checkin_at: device.last_checkin_at,
    billing_status: device.billing_status,
  };
}
