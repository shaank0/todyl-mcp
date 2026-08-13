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
});
