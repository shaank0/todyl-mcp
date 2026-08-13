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
 * The distinct tenants a name or id matches. Two different clients can share
 * a display name, and silently merging their devices into one answer would be
 * worse than refusing — so tools use this to detect ambiguity and ask for an id.
 */
export function distinctTenantsMatching<T>(
  items: T[],
  needle: string,
  pick: (item: T) => TenantRef | undefined
): TenantRef[] {
  const byId = new Map<string, TenantRef>();
  for (const item of items) {
    const ref = pick(item);
    if (ref && matchesTenant(ref, needle)) byId.set(ref.id, ref);
  }
  return [...byId.values()];
}

export interface DeviceFilters {
  tenant?: string;
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
