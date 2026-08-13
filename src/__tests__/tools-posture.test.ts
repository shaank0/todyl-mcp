import { describe, it, expect } from 'vitest';
import { devicePostureSummaryTool } from '../tools/posture.js';
import type { TodylRepository } from '../todyl/repository.js';
import type { Device } from '../todyl/types.js';

const fresh = new Date().toISOString();
const DEVICES: Device[] = [
  { id: 'a', tenant: { id: 't1', name: 'Acme' }, last_checkin_at: fresh, tamper_protection: { enabled: true },
    operating_system: { agent_version: '2.0', latest_available_agent_version: '2.0' } },
  { id: 'b', tenant: { id: 't1', name: 'Acme' }, last_checkin_at: '2020-01-01T00:00:00Z',
    tamper_protection: { enabled: false },
    operating_system: { agent_version: '1.0', latest_available_agent_version: '2.0' } },
  { id: 'c', tenant: { id: 't2', name: 'Beta' }, last_checkin_at: fresh, tamper_protection: { enabled: true },
    reboot_required_at: '2020-01-01T00:00:00Z',
    operating_system: { agent_version: '2.0', latest_available_agent_version: '2.0' } },
];

const repo = { devices: async () => ({ items: DEVICES, truncated: false }) } as unknown as TodylRepository;
const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe('device-posture-summary', () => {
  it('counts each posture issue across all tenants', async () => {
    const out = payload(await devicePostureSummaryTool.execute({}, repo));
    expect(out.totals).toMatchObject({
      devices: 3, stale: 1, tamper_protection_off: 1, agent_outdated: 1, needs_reboot: 1,
    });
  });

  it('breaks the counts down per tenant', async () => {
    const out = payload(await devicePostureSummaryTool.execute({}, repo));
    const acme = out.by_tenant.find((t: { tenant: string }) => t.tenant === 'Acme');
    expect(acme).toMatchObject({ devices: 2, stale: 1, tamper_protection_off: 1, agent_outdated: 1 });
    const beta = out.by_tenant.find((t: { tenant: string }) => t.tenant === 'Beta');
    expect(beta).toMatchObject({ devices: 1, needs_reboot: 1, stale: 0 });
  });

  it('restricts to one tenant when asked', async () => {
    const out = payload(await devicePostureSummaryTool.execute({ tenant: 'beta' }, repo));
    expect(out.totals.devices).toBe(1);
    expect(out.by_tenant).toHaveLength(1);
  });

  it('honours a custom stale_days threshold', async () => {
    const out = payload(await devicePostureSummaryTool.execute({ stale_days: 100000 }, repo));
    expect(out.totals.stale).toBe(0);
  });

  it('reports the threshold it used, so the number is interpretable', async () => {
    const out = payload(await devicePostureSummaryTool.execute({}, repo));
    expect(out.stale_days).toBe(30);
  });

  it('refuses an ambiguous tenant name instead of merging two clients', async () => {
    const clash = [
      { id: 'x', tenant: { id: 't1', name: 'Shared' }, last_checkin_at: fresh },
      { id: 'y', tenant: { id: 't9', name: 'Shared' }, last_checkin_at: fresh },
    ] as Device[];
    const r = { devices: async () => ({ items: clash, truncated: false }) } as unknown as TodylRepository;
    const result = await devicePostureSummaryTool.execute({ tenant: 'Shared' }, r);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/t1/);
    expect(result.content[0].text).toMatch(/t9/);
  });

  it('does not leak an unrelated tenant into the breakdown OR the totals when that tenant\'s id equals the search string', async () => {
    // The leak this tool still had after fix round 3: it checked ambiguity with
    // the resolver (so no refusal) and then filtered on the RAW string, so
    // "Randoco" — whose opaque tenant id happens to be the literal "Acme" —
    // merged into Acme's answer. Assert the totals too, not just the breakdown:
    // a merged total is a wrong number with no visible cause.
    const collision = [
      { id: 'acme-1', tenant: { id: 't1', name: 'Acme' }, last_checkin_at: fresh,
        tamper_protection: { enabled: true },
        operating_system: { agent_version: '2.0', latest_available_agent_version: '2.0' } },
      { id: 'rand-1', tenant: { id: 'Acme', name: 'Randoco' }, last_checkin_at: '2020-01-01T00:00:00Z',
        tamper_protection: { enabled: false },
        operating_system: { agent_version: '1.0', latest_available_agent_version: '2.0' } },
      { id: 'rand-2', tenant: { id: 'Acme', name: 'Randoco' }, last_checkin_at: '2020-01-01T00:00:00Z',
        tamper_protection: { enabled: false },
        reboot_required_at: '2020-01-01T00:00:00Z',
        operating_system: { agent_version: '1.0', latest_available_agent_version: '2.0' } },
    ] as Device[];
    const r = { devices: async () => ({ items: collision, truncated: false }) } as unknown as TodylRepository;
    const result = await devicePostureSummaryTool.execute({ tenant: 'Acme' }, r);
    expect(result.isError).toBeFalsy();
    const out = payload(result);

    // Totals: Acme's one clean device only. Merged, this would read 3 devices,
    // 2 stale, 2 tamper-off, 2 outdated, 1 needing reboot.
    expect(out.totals).toEqual({
      devices: 1, stale: 0, needs_reboot: 0, tamper_protection_off: 0, agent_outdated: 0,
    });
    // Breakdown: one bucket, Acme's, keyed on the resolved id.
    expect(out.by_tenant).toHaveLength(1);
    expect(out.by_tenant[0]).toMatchObject({ tenant: 'Acme', tenant_id: 't1', devices: 1 });

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('Randoco');
    expect(serialized).not.toContain('rand-1');
    expect(serialized).not.toContain('rand-2');
  });

  it('errors, naming the known tenants, when the tenant resolves to nothing', async () => {
    const result = await devicePostureSummaryTool.execute({ tenant: 'Nope Ltd' }, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no todyl tenant matches/i);
    expect(result.content[0].text).toMatch(/Acme/);
    expect(result.content[0].text).toMatch(/Beta/);
  });

  it('accepts stale_days: 0 and rejects a negative, like every other tool', () => {
    const schema = devicePostureSummaryTool.inputSchema.stale_days!;
    expect(schema.safeParse(0).success).toBe(true);
    expect(schema.safeParse(-1).success).toBe(false);
  });
});
