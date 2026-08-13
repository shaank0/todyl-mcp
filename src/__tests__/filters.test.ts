import { describe, it, expect } from 'vitest';
import {
  agentOutdated,
  applyDeviceFilters,
  distinctTenantsMatching,
  isStale,
  needsReboot,
  projectDevice,
  resolveTenantMatches,
  tamperOff,
} from '../filters.js';
import type { Device } from '../todyl/types.js';

const NOW = new Date('2026-08-13T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('isStale', () => {
  it('is true past the threshold', () => {
    expect(isStale({ id: 'd', last_checkin_at: daysAgo(31) }, 30, NOW)).toBe(true);
  });
  it('is false inside the threshold', () => {
    expect(isStale({ id: 'd', last_checkin_at: daysAgo(3) }, 30, NOW)).toBe(false);
  });
  it('treats a device that has NEVER checked in as stale', () => {
    expect(isStale({ id: 'd' }, 30, NOW)).toBe(true);
  });
});

describe('needsReboot', () => {
  it('is true when reboot_required_at is in the past', () => {
    expect(needsReboot({ id: 'd', reboot_required_at: daysAgo(1) }, NOW)).toBe(true);
  });
  it('is false when absent', () => {
    expect(needsReboot({ id: 'd' }, NOW)).toBe(false);
  });
  it('is false when set in the future', () => {
    expect(needsReboot({ id: 'd', reboot_required_at: '2027-01-01T00:00:00Z' }, NOW)).toBe(false);
  });
});

describe('tamperOff', () => {
  it('is false when protection is enabled', () => {
    expect(tamperOff({ id: 'd', tamper_protection: { enabled: true } })).toBe(false);
  });
  it('is true when explicitly disabled', () => {
    expect(tamperOff({ id: 'd', tamper_protection: { enabled: false } })).toBe(true);
  });
  it('is true when unknown — a posture check fails safe', () => {
    expect(tamperOff({ id: 'd' })).toBe(true);
  });
});

describe('agentOutdated', () => {
  it('is true when versions differ', () => {
    expect(
      agentOutdated({ id: 'd', operating_system: { agent_version: '1.0', latest_available_agent_version: '1.1' } })
    ).toBe(true);
  });
  it('is false when versions match', () => {
    expect(
      agentOutdated({ id: 'd', operating_system: { agent_version: '1.1', latest_available_agent_version: '1.1' } })
    ).toBe(false);
  });
  it('is false when either version is missing — we cannot know', () => {
    expect(agentOutdated({ id: 'd', operating_system: { agent_version: '1.0' } })).toBe(false);
    expect(agentOutdated({ id: 'd' })).toBe(false);
  });
});

const DEVICES: Device[] = [
  {
    id: 'd1',
    name: 'LAPTOP-1',
    serial_number: 'SN-1',
    udid: 'U-1',
    billing_status: 'billing',
    device_type: 'workstation',
    last_checkin_at: daysAgo(1),
    tamper_protection: { enabled: true },
    operating_system: { type: 'Windows', version: '11', agent_version: '2.0', latest_available_agent_version: '2.0' },
    tenant: { id: 't1', name: 'Acme Corp' },
  },
  {
    id: 'd2',
    name: 'LAPTOP-2',
    serial_number: 'SN-2',
    udid: 'U-2',
    billing_status: 'not_billing',
    device_type: 'server',
    last_checkin_at: daysAgo(90),
    tamper_protection: { enabled: false },
    operating_system: { type: 'macOS', version: '15', agent_version: '1.0', latest_available_agent_version: '2.0' },
    tenant: { id: 't2', name: 'Beta LLC' },
  },
];

describe('applyDeviceFilters', () => {
  it('returns everything with no filters', () => {
    expect(applyDeviceFilters(DEVICES, {}, NOW)).toHaveLength(2);
  });

  it('filters by tenant name, case-insensitively', () => {
    expect(applyDeviceFilters(DEVICES, { tenant: 'acme corp' }, NOW).map((d) => d.id)).toEqual(['d1']);
  });

  it('filters by tenant id exactly', () => {
    expect(applyDeviceFilters(DEVICES, { tenant: 't2' }, NOW).map((d) => d.id)).toEqual(['d2']);
  });

  it('searches name, serial and udid', () => {
    expect(applyDeviceFilters(DEVICES, { search: 'sn-2' }, NOW).map((d) => d.id)).toEqual(['d2']);
    expect(applyDeviceFilters(DEVICES, { search: 'u-1' }, NOW).map((d) => d.id)).toEqual(['d1']);
  });

  it('filters by stale_days', () => {
    expect(applyDeviceFilters(DEVICES, { stale_days: 30 }, NOW).map((d) => d.id)).toEqual(['d2']);
  });

  it('filters by tamper_protection off', () => {
    expect(applyDeviceFilters(DEVICES, { tamper_protection: 'off' }, NOW).map((d) => d.id)).toEqual(['d2']);
  });

  it('filters by agent_outdated', () => {
    expect(applyDeviceFilters(DEVICES, { agent_outdated: true }, NOW).map((d) => d.id)).toEqual(['d2']);
  });

  it('filters by billing_status, device_type and os_type', () => {
    expect(applyDeviceFilters(DEVICES, { billing_status: 'BILLING' }, NOW).map((d) => d.id)).toEqual(['d1']);
    expect(applyDeviceFilters(DEVICES, { device_type: 'server' }, NOW).map((d) => d.id)).toEqual(['d2']);
    expect(applyDeviceFilters(DEVICES, { os_type: 'windows' }, NOW).map((d) => d.id)).toEqual(['d1']);
  });

  it('ANDs multiple filters', () => {
    expect(applyDeviceFilters(DEVICES, { stale_days: 30, billing_status: 'billing' }, NOW)).toHaveLength(0);
    expect(applyDeviceFilters(DEVICES, { stale_days: 30, billing_status: 'not_billing' }, NOW)).toHaveLength(1);
  });
});

describe('distinctTenantsMatching', () => {
  it('returns one tenant for an unambiguous name', () => {
    expect(distinctTenantsMatching(DEVICES, 'Acme Corp', (d) => d.tenant)).toHaveLength(1);
  });

  it('returns BOTH when two different clients share a name', () => {
    const clash = [
      { id: 'x', tenant: { id: 't1', name: 'Smith & Co' } },
      { id: 'y', tenant: { id: 't9', name: 'Smith & Co' } },
    ] as Device[];
    const found = distinctTenantsMatching(clash, 'smith & co', (d) => d.tenant);
    expect(found.map((t) => t.id).sort()).toEqual(['t1', 't9']);
  });

  it('returns exactly one when matched by id, even if names clash', () => {
    const clash = [
      { id: 'x', tenant: { id: 't1', name: 'Smith & Co' } },
      { id: 'y', tenant: { id: 't9', name: 'Smith & Co' } },
    ] as Device[];
    expect(distinctTenantsMatching(clash, 't9', (d) => d.tenant)).toHaveLength(1);
  });

  it('returns nothing when no tenant matches', () => {
    expect(distinctTenantsMatching(DEVICES, 'Nope', (d) => d.tenant)).toHaveLength(0);
  });
});

describe('resolveTenantMatches', () => {
  it('prefers a clean NAME match over an unrelated tenant whose id equals the search string', () => {
    // Real, unique name match: t1/"Acme". Unrelated: a tenant literally id'd "Acme".
    // Fed the FULL candidate set (as every caller must), the resolver must pick
    // only the name match — this is the set-level policy fix round 2 lifted from
    // tenant-report into the shared helper.
    const refs = [
      { id: 't1', name: 'Acme' },
      { id: 'Acme', name: 'Randoco' },
    ];
    const matches = resolveTenantMatches(refs, 'Acme');
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('t1');
  });

  it('falls back to id matching only when no name matches exist', () => {
    const refs = [
      { id: 't1', name: 'Acme' },
      { id: 't9', name: 'Beta' },
    ];
    expect(resolveTenantMatches(refs, 't9')).toEqual([{ id: 't9', name: 'Beta' }]);
  });

  it('still reports a genuine ambiguity when two tenants share a NAME', () => {
    const refs = [
      { id: 't1', name: 'Shared' },
      { id: 't9', name: 'Shared' },
    ];
    expect(resolveTenantMatches(refs, 'Shared')).toHaveLength(2);
  });
});

describe('projectDevice', () => {
  it('returns a compact record, not the full nested object', () => {
    const p = projectDevice(DEVICES[1]);
    expect(p).toMatchObject({
      id: 'd2',
      name: 'LAPTOP-2',
      tenant: 'Beta LLC',
      os: 'macOS 15',
      agent_version: '1.0',
      latest_agent_version: '2.0',
      agent_outdated: true,
      tamper_protection_off: true,
    });
    expect(Object.keys(p).length).toBeLessThanOrEqual(12);
    expect((p as Record<string, unknown>).session).toBeUndefined();
  });
});
