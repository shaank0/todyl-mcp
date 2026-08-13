import { describe, it, expect } from 'vitest';
import { tenantReportTool } from '../tools/report.js';
import { parseDeploymentGroup } from '../todyl/parse.js';
import type { TodylRepository } from '../todyl/repository.js';

const fresh = new Date().toISOString();

const DEVICES = [
  { id: 'a', tenant: { id: 't1', name: 'Acme' }, last_checkin_at: fresh, tamper_protection: { enabled: true },
    operating_system: { agent_version: '2.0', latest_available_agent_version: '2.0' } },
  { id: 'b', tenant: { id: 't1', name: 'Acme' }, last_checkin_at: '2020-01-01T00:00:00Z',
    tamper_protection: { enabled: false },
    operating_system: { agent_version: '1.0', latest_available_agent_version: '2.0' },
    reboot_required_at: '2020-01-01T00:00:00Z' },
  { id: 'c', tenant: { id: 't2', name: 'Beta' }, last_checkin_at: fresh, tamper_protection: { enabled: true } },
];

const GROUPS = [
  { id: 'g1', name: 'Default', tenant: { id: 't1', name: 'Acme' }, device_count: 2 },
  { id: 'g2', name: 'Other', tenant: { id: 't2', name: 'Beta' }, device_count: 1 },
];

const INVOICES = [
  { id: 'inv1', subtotal: 14250, currency: 'USD', tenant: { id: 't1', name: 'Acme' } },
  { id: 'inv2', subtotal: 500, currency: 'USD', tenant: { id: 't2', name: 'Beta' } },
];

const repo = ({
  devicesOverride, groupsOverride, invoicesOverride,
}: {
  devicesOverride?: Partial<{ items: typeof DEVICES; truncated: boolean }>;
  groupsOverride?: Partial<{ items: typeof GROUPS; truncated: boolean }>;
  invoicesOverride?: Partial<{ items: typeof INVOICES; truncated: boolean }>;
} = {}) =>
  ({
    devices: async () => ({ items: DEVICES, truncated: false, ...devicesOverride }),
    deploymentGroups: async () => ({ items: GROUPS, truncated: false, ...groupsOverride }),
    invoices: async () => ({ items: INVOICES, truncated: false, ...invoicesOverride }),
  }) as unknown as TodylRepository;

const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe('tenant-report', () => {
  it('assembles devices, posture, groups and invoices for one tenant', async () => {
    const out = payload(await tenantReportTool.execute({ tenant: 'Acme' }, repo()));
    expect(out.tenant).toBe('Acme');
    expect(out.posture).toMatchObject({ devices: 2, stale: 1, tamper_protection_off: 1 });
    expect(out.deployment_groups).toHaveLength(1);
    expect(out.invoices).toHaveLength(1);
  });

  it('excludes other tenants entirely', async () => {
    const out = JSON.stringify(payload(await tenantReportTool.execute({ tenant: 'Acme' }, repo())));
    expect(out).not.toContain('Beta');
    expect(out).not.toContain('inv2');
  });

  it('errors when the tenant is unknown, listing what exists', async () => {
    const result = await tenantReportTool.execute({ tenant: 'Nope Ltd' }, repo());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Acme/);
    expect(result.content[0].text).toMatch(/Beta/);
  });

  it('counts every posture predicate with a fixture where each has a distinct count', async () => {
    // DEVICES' 'b' triggers all four flags at once, so stale/reboot/tamper/outdated
    // all land on count 1 there — a predicate aliased to the wrong one (e.g.
    // needs_reboot silently computed via tamperOff) would still read "1" and hide.
    // This fixture gives each flag a DIFFERENT count so aliasing cannot go unnoticed.
    const base = { tenant: { id: 't1', name: 'Acme' }, last_checkin_at: fresh,
      tamper_protection: { enabled: true },
      operating_system: { agent_version: '2.0', latest_available_agent_version: '2.0' } };
    const posture = [
      { ...base, id: 'p-clean' }, // no flags
      { ...base, id: 'p-stale', last_checkin_at: '2020-01-01T00:00:00Z' }, // stale: 1
      { ...base, id: 'p-reboot-1', reboot_required_at: '2020-01-01T00:00:00Z' },
      { ...base, id: 'p-reboot-2', reboot_required_at: '2020-01-01T00:00:00Z' }, // needs_reboot: 2
      { ...base, id: 'p-tamper-1', tamper_protection: { enabled: false } },
      { ...base, id: 'p-tamper-2', tamper_protection: { enabled: false } },
      { ...base, id: 'p-tamper-3', tamper_protection: { enabled: false } }, // tamper_protection_off: 3
      { ...base, id: 'p-outdated-1', operating_system: { agent_version: '1.0', latest_available_agent_version: '2.0' } },
      { ...base, id: 'p-outdated-2', operating_system: { agent_version: '1.0', latest_available_agent_version: '2.0' } },
      { ...base, id: 'p-outdated-3', operating_system: { agent_version: '1.0', latest_available_agent_version: '2.0' } },
      { ...base, id: 'p-outdated-4', operating_system: { agent_version: '1.0', latest_available_agent_version: '2.0' } }, // agent_outdated: 4
    ];
    const out = payload(
      await tenantReportTool.execute({ tenant: 'Acme' }, repo({ devicesOverride: { items: posture as any } }))
    );
    expect(out.posture).toEqual({
      devices: 11, stale: 1, needs_reboot: 2, tamper_protection_off: 3, agent_outdated: 4,
    });
  });

  it('refuses an ambiguous tenant name', async () => {
    const clash = repo({
      devicesOverride: {
        items: [
          { id: 'x', tenant: { id: 't1', name: 'Shared' }, last_checkin_at: fresh },
          { id: 'y', tenant: { id: 't9', name: 'Shared' }, last_checkin_at: fresh },
        ] as any,
      },
    });
    const result = await tenantReportTool.execute({ tenant: 'Shared' }, clash);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/t1/);
    expect(result.content[0].text).toMatch(/t9/);
  });

  it('refuses when the name is unambiguous among devices but clashes via an invoice subtenant', async () => {
    // 'Acme' alone matches only tenant t1 in devices/groups, but a second, unrelated
    // tenant (t2) has an invoice subtenant also named 'Acme'. A report must not silently
    // pick one — this is exactly the scenario correction #2 exists to catch.
    const clash = repo({
      invoicesOverride: {
        items: [
          ...INVOICES,
          { id: 'inv3', subtotal: 100, currency: 'USD', tenant: { id: 't2', name: 'Beta' },
            subtenants: [{ id: 't3', name: 'Acme' }] } as any,
        ],
      },
    });
    const result = await tenantReportTool.execute({ tenant: 'Acme' }, clash);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/t1/);
    expect(result.content[0].text).toMatch(/t3/);
  });

  it('marks an invoice covers_multiple_tenants when matched only via a subtenant, like list-invoices does', async () => {
    const withSubtenant = repo({
      invoicesOverride: {
        items: [
          { id: 'inv1', subtotal: 14250, currency: 'USD', tenant: { id: 't9', name: 'Parent Co' },
            subtenants: [{ id: 't1', name: 'Acme' }] } as any,
        ],
      },
    });
    const out = payload(await tenantReportTool.execute({ tenant: 'Acme' }, withSubtenant));
    expect(out.invoices).toHaveLength(1);
    expect(out.invoices[0].covers_multiple_tenants).toBe(true);
  });

  it('does not mark an invoice covers_multiple_tenants when matched via the primary tenant', async () => {
    const out = payload(await tenantReportTool.execute({ tenant: 'Acme' }, repo()));
    expect(out.invoices[0].covers_multiple_tenants).toBeUndefined();
  });

  it('surfaces a warning naming devices when the device sweep was truncated', async () => {
    const out = payload(
      await tenantReportTool.execute({ tenant: 'Acme' }, repo({ devicesOverride: { truncated: true } }))
    );
    expect(out.warning).toMatch(/not all devices/i);
    expect(out.warning).not.toMatch(/deployment groups/i);
    expect(out.warning).not.toMatch(/not all invoices/i);
  });

  it('surfaces a warning naming deployment groups when that sweep was truncated', async () => {
    const out = payload(
      await tenantReportTool.execute({ tenant: 'Acme' }, repo({ groupsOverride: { truncated: true } }))
    );
    expect(out.warning).toMatch(/not all deployment groups/i);
    expect(out.warning).not.toMatch(/not all devices/i);
  });

  it('surfaces a warning naming invoices when that sweep was truncated', async () => {
    const out = payload(
      await tenantReportTool.execute({ tenant: 'Acme' }, repo({ invoicesOverride: { truncated: true } }))
    );
    expect(out.warning).toMatch(/not all invoices/i);
    expect(out.warning).not.toMatch(/not all devices/i);
  });

  it('combines warnings from more than one truncated dataset', async () => {
    const out = payload(
      await tenantReportTool.execute(
        { tenant: 'Acme' },
        repo({ devicesOverride: { truncated: true }, invoicesOverride: { truncated: true } })
      )
    );
    expect(out.warning).toMatch(/not all devices/i);
    expect(out.warning).toMatch(/not all invoices/i);
  });

  it('produces no warning field when nothing was truncated or stale', async () => {
    const out = payload(await tenantReportTool.execute({ tenant: 'Acme' }, repo()));
    expect(out.warning).toBeUndefined();
  });

  it('cannot surface a deploy-key credential through the report', async () => {
    // Run a raw deployment-group payload through the real parse boundary (as the
    // repository would), then through tenant-report end to end. This proves the
    // whole pipeline for this tool — not just parse.ts in isolation — never lets
    // a live enrollment secret reach the report output.
    const rawGroup = {
      id: 'g1',
      name: 'Default',
      tenant: { id: 't1', name: 'Acme' },
      device_count: 2,
      credentials: { deploy_key: 'sk-super-secret', temporary_deploy_key: 'tmp-super-secret' },
    };
    const scrubbedGroup = parseDeploymentGroup(rawGroup);
    const withSecret = repo({ groupsOverride: { items: [scrubbedGroup] as any } });
    const out = JSON.stringify(payload(await tenantReportTool.execute({ tenant: 'Acme' }, withSecret)));
    expect(out).not.toContain('sk-super-secret');
    expect(out).not.toContain('tmp-super-secret');
    expect(out).not.toContain('deploy_key');
    expect(out).not.toContain('credentials');
  });

  it('accepts stale_days: 0 as a meaningful value (missed check-in today counts as stale)', () => {
    const schema = tenantReportTool.inputSchema.stale_days!;
    expect(schema.safeParse(0).success).toBe(true);
  });

  it('rejects a negative stale_days', () => {
    const schema = tenantReportTool.inputSchema.stale_days!;
    expect(schema.safeParse(-1).success).toBe(false);
  });
});
