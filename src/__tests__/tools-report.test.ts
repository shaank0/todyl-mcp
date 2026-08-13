import { describe, it, expect } from 'vitest';
import { tenantReportTool } from '../tools/report.js';
import { parseDeploymentGroup } from '../todyl/parse.js';
import { TodylError } from '../todyl/errors.js';
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
    // Ids deliberately don't collide with the default GROUPS/INVOICES fixtures' t1/t2 —
    // the union dedupes by id, so reusing t1 here would let the default fixtures'
    // "Acme" silently overwrite this test's "Shared" ref for that id.
    const clash = repo({
      devicesOverride: {
        items: [
          { id: 'x', tenant: { id: 'ts1', name: 'Shared' }, last_checkin_at: fresh },
          { id: 'y', tenant: { id: 'ts9', name: 'Shared' }, last_checkin_at: fresh },
        ] as any,
      },
    });
    const result = await tenantReportTool.execute({ tenant: 'Shared' }, clash);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ts1/);
    expect(result.content[0].text).toMatch(/ts9/);
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

  // --- Fix round 1: per-dataset failure tolerance ------------------------------

  it('reports incomplete: false when every dataset succeeds', async () => {
    const out = payload(await tenantReportTool.execute({ tenant: 'Acme' }, repo()));
    expect(out.incomplete).toBe(false);
  });

  it('a 403 on invoices alone still returns devices and groups, with invoices marked as an explicit error', async () => {
    const failing = {
      devices: async () => ({ items: DEVICES, truncated: false }),
      deploymentGroups: async () => ({ items: GROUPS, truncated: false }),
      invoices: async () => {
        throw new TodylError('Todyl refused the request (403): billing.invoices:read missing.', 403);
      },
    } as unknown as TodylRepository;

    const out = payload(await tenantReportTool.execute({ tenant: 'Acme' }, failing));
    expect(out.incomplete).toBe(true);
    // Devices and groups are untouched by the invoices failure.
    expect(out.posture).toEqual({ devices: 2, stale: 1, needs_reboot: 1, tamper_protection_off: 1, agent_outdated: 1 });
    expect(out.deployment_groups).toHaveLength(1);
    // Invoices must be an explicit error object naming the dataset and reason —
    // never an empty array, which would read as "this client owes nothing".
    expect(Array.isArray(out.invoices)).toBe(false);
    expect(out.invoices.error).toBe(true);
    expect(out.invoices.dataset).toBe('invoices');
    expect(out.invoices.status).toBe(403);
    expect(out.invoices.message).toMatch(/billing.invoices:read/);
  });

  it('a 403 on devices alone still returns groups and invoices, with posture marked as an explicit error', async () => {
    const failing = {
      devices: async () => {
        throw new TodylError('Todyl refused the request (403).', 403);
      },
      deploymentGroups: async () => ({ items: GROUPS, truncated: false }),
      invoices: async () => ({ items: INVOICES, truncated: false }),
    } as unknown as TodylRepository;

    const out = payload(await tenantReportTool.execute({ tenant: 'Acme' }, failing));
    expect(out.incomplete).toBe(true);
    expect(Array.isArray(out.posture)).toBe(false);
    expect(out.posture.error).toBe(true);
    expect(out.posture.dataset).toBe('devices');
    expect(out.posture.status).toBe(403);
    expect(out.deployment_groups).toHaveLength(1);
    expect(out.invoices).toHaveLength(1);
  });

  it('never represents a failed dataset as an empty array', async () => {
    // The specific wrong-number failure mode this exists to prevent: someone reading
    // `invoices: []` would conclude the client was billed nothing, which is false —
    // Todyl was simply never asked. This locks the shape so a future refactor can't
    // "simplify" a failed section back down to [].
    const failing = {
      devices: async () => ({ items: DEVICES, truncated: false }),
      deploymentGroups: async () => ({ items: GROUPS, truncated: false }),
      invoices: async () => {
        throw new TodylError('server error', 500);
      },
    } as unknown as TodylRepository;
    const out = payload(await tenantReportTool.execute({ tenant: 'Acme' }, failing));
    expect(out.invoices).not.toEqual([]);
    expect(typeof out.invoices).toBe('object');
    expect('length' in out.invoices).toBe(false);
  });

  it('returns a toolError when all three datasets fail — there is no report to give', async () => {
    const allFail = {
      devices: async () => { throw new TodylError('devices down', 500); },
      deploymentGroups: async () => { throw new TodylError('groups down', 500); },
      invoices: async () => { throw new TodylError('invoices down', 500); },
    } as unknown as TodylRepository;

    const result = await tenantReportTool.execute({ tenant: 'Acme' }, allFail);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/devices/);
    expect(result.content[0].text).toMatch(/deployment groups/);
    expect(result.content[0].text).toMatch(/invoices/);
  });

  // --- Fix round 1: resolve tenant identity once, then filter by resolved id --

  it('succeeds for a name unambiguous in devices even when it equals an unrelated tenant\'s id in groups', async () => {
    // t1 ("Acme") is the real, unique NAME match in devices. Separately, and
    // unrelated to Acme, "randoco" tenant's OWN group happens to carry the literal
    // id "Acme" while its real name is "Randoco" — under naive id-or-name OR
    // matching this would look like a second candidate and force a refusal. Since
    // Acme's own group here ALSO exists (matches by name), a per-dataset groups-only
    // check would see two distinct ids ("t1" via name, "Acme" via id) and refuse —
    // exactly what fix-round-1 ruled must not happen for a legitimate query.
    const collision = repo({
      groupsOverride: {
        items: [
          { id: 'g1', name: 'Default', tenant: { id: 't1', name: 'Acme' }, device_count: 2 },
          { id: 'g-collide', name: 'Unrelated', tenant: { id: 'Acme', name: 'Randoco' }, device_count: 1 },
        ] as any,
      },
    });
    const out = payload(await tenantReportTool.execute({ tenant: 'Acme' }, collision));
    expect(out.tenant).toBe('Acme');
    expect(out.tenant_id).toBe('t1');
    // Only Acme's own group is in the report — Randoco's coincidental-id group is not.
    expect(out.deployment_groups).toHaveLength(1);
    expect(out.deployment_groups[0].id).toBe('g1');
  });

  it('resolves a tenant that appears only in invoices (no devices, no groups) instead of reading as unknown', async () => {
    const invoiceOnly = {
      devices: async () => ({ items: [], truncated: false }),
      deploymentGroups: async () => ({ items: [], truncated: false }),
      invoices: async () => ({
        items: [{ id: 'inv1', subtotal: 99, currency: 'USD', tenant: { id: 'new1', name: 'Brand New Co' } }],
        truncated: false,
      }),
    } as unknown as TodylRepository;

    const out = payload(await tenantReportTool.execute({ tenant: 'Brand New Co' }, invoiceOnly));
    expect(out.tenant).toBe('Brand New Co');
    expect(out.tenant_id).toBe('new1');
    expect(out.posture).toEqual({ devices: 0, stale: 0, needs_reboot: 0, tamper_protection_off: 0, agent_outdated: 0 });
    expect(out.invoices).toHaveLength(1);
  });

  it('a not-found answer says the search was incomplete when a dataset that might have held the tenant failed to load (fix round 3)', async () => {
    // Devices 403s. If "Ghost Co" only exists in devices (e.g. an endpoint-only
    // client with no groups/invoices yet), a plain "no tenant matches" would
    // state as fact something we never actually checked — the dataset that
    // would have contained it never loaded.
    const devicesDown = {
      devices: async () => { throw new TodylError('forbidden', 403); },
      deploymentGroups: async () => ({ items: GROUPS, truncated: false }),
      invoices: async () => ({ items: INVOICES, truncated: false }),
    } as unknown as TodylRepository;

    const result = await tenantReportTool.execute({ tenant: 'Ghost Co' }, devicesDown);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/incomplete/i);
    expect(result.content[0].text).toMatch(/devices/);
    expect(result.content[0].text).not.toMatch(/deployment groups/);
    expect(result.content[0].text).not.toMatch(/invoices could not be read/);
  });

  it('does not merge an unrelated tenant\'s devices into the posture counts when its id equals the search string', async () => {
    // The report's groups-side version of this is covered above; this is the
    // devices side, where the damage is a wrong NUMBER rather than an extra row.
    // "Randoco"'s tenant id is the literal string "Acme"; its two devices are
    // stale and tamper-off, so a raw-string filter would report Acme as
    // devices: 3, stale: 2 instead of devices: 1, stale: 0.
    const collision = repo({
      devicesOverride: {
        items: [
          { id: 'acme-1', tenant: { id: 't1', name: 'Acme' }, last_checkin_at: fresh,
            tamper_protection: { enabled: true },
            operating_system: { agent_version: '2.0', latest_available_agent_version: '2.0' } },
          { id: 'rand-1', tenant: { id: 'Acme', name: 'Randoco' }, last_checkin_at: '2020-01-01T00:00:00Z',
            tamper_protection: { enabled: false } },
          { id: 'rand-2', tenant: { id: 'Acme', name: 'Randoco' }, last_checkin_at: '2020-01-01T00:00:00Z',
            tamper_protection: { enabled: false } },
        ] as any,
      },
    });
    const out = payload(await tenantReportTool.execute({ tenant: 'Acme' }, collision));
    expect(out.tenant_id).toBe('t1');
    expect(out.posture).toEqual({
      devices: 1, stale: 0, needs_reboot: 0, tamper_protection_off: 0, agent_outdated: 0,
    });
    expect(JSON.stringify(out)).not.toContain('Randoco');
  });

  it('a not-found answer says so when a dataset loaded but was TRUNCATED, not only when one failed', async () => {
    // A dataset that hit the page cap is just as capable of not having reached
    // this tenant as one that 403'd — the tenant may simply be on an unread page.
    const result = await tenantReportTool.execute(
      { tenant: 'Ghost Co' },
      repo({ devicesOverride: { truncated: true } })
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no todyl tenant matches/i);
    expect(result.content[0].text).toMatch(/not all devices were read/i);
  });

  it('a not-found answer omits the incomplete note when every dataset loaded', async () => {
    const result = await tenantReportTool.execute({ tenant: 'Ghost Co' }, repo());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/incomplete/i);
  });
});
