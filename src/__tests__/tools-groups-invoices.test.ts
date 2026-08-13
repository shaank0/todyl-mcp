import { describe, it, expect, vi } from 'vitest';
import { listDeploymentGroupsTool } from '../tools/groups.js';
import { listInvoicesTool } from '../tools/invoices.js';
import type { TodylRepository } from '../todyl/repository.js';

const GROUPS = [
  { id: 'g1', name: 'Default', tenant: { id: 't1', name: 'Acme' }, device_count: 10 },
  { id: 'g2', name: 'Servers', tenant: { id: 't2', name: 'Beta' }, device_count: 3 },
];
const INVOICES = [
  { id: 'inv1', status: 'paid', subtotal: 14250, currency: 'USD', tenant: { id: 't1', name: 'Acme' } },
  {
    id: 'inv2',
    status: 'pending',
    subtotal: 8500,
    currency: 'USD',
    tenant: { id: 't1', name: 'Acme' },
    subtenants: [
      { id: 'ts1', name: 'Acme UK' },
      { id: 'ts2', name: 'Acme EU' },
    ],
  },
];

const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe('list-deployment-groups', () => {
  const repo = {
    deploymentGroups: async () => ({ items: GROUPS, truncated: false }),
  } as unknown as TodylRepository;

  it('returns all groups', async () => {
    const out = payload(await listDeploymentGroupsTool.execute({}, repo));
    expect(out.groups).toHaveLength(2);
    expect(out.matched).toBe(2);
  });

  it('filters by tenant', async () => {
    const out = payload(await listDeploymentGroupsTool.execute({ tenant: 'beta' }, repo));
    expect(out.groups.map((g: { id: string }) => g.id)).toEqual(['g2']);
  });

  it('refuses an ambiguous tenant name', async () => {
    const clash = [
      { id: 'g1', name: 'Default', tenant: { id: 't1', name: 'Shared' }, device_count: 10 },
      { id: 'g2', name: 'Servers', tenant: { id: 't2', name: 'Shared' }, device_count: 3 },
    ];
    const r = { deploymentGroups: async () => ({ items: clash, truncated: false }) } as unknown as TodylRepository;
    const result = await listDeploymentGroupsTool.execute({ tenant: 'Shared' }, r);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/matches.*\\"Shared/);
    expect(result.content[0].text).toMatch(/t1/);
    expect(result.content[0].text).toMatch(/t2/);
  });

  it('names "deployment groups" (not "devices") in its own truncation warning', async () => {
    const r = {
      deploymentGroups: async () => ({ items: GROUPS, truncated: true }),
    } as unknown as TodylRepository;
    const out = payload(await listDeploymentGroupsTool.execute({}, r));
    expect(out.warning).toMatch(/not all deployment groups were read/i);
    expect(out.warning).not.toMatch(/not all devices/i);
  });

  it('does not refuse, and does not leak an unrelated tenant\'s group, when that tenant\'s id equals the search string (fix round 2+3)', async () => {
    // Round 3: the ambiguity check alone resolving cleanly isn't enough — the
    // FILTER step must also key off the resolved id, or Randoco's group (whose
    // id is literally "Acme") merges into Acme's list. Assert both no-refusal
    // AND that Randoco's group/id is absent.
    const collision = [
      { id: 'g1', name: 'Default', tenant: { id: 't1', name: 'Acme' }, device_count: 10 },
      { id: 'g2', name: 'Unrelated', tenant: { id: 'Acme', name: 'Randoco' }, device_count: 1 },
    ];
    const r = { deploymentGroups: async () => ({ items: collision, truncated: false }) } as unknown as TodylRepository;
    const result = await listDeploymentGroupsTool.execute({ tenant: 'Acme' }, r);
    expect(result.isError).toBeFalsy();
    const out = payload(result);
    expect(out.matched).toBe(1);
    expect(out.groups.map((g: { id: string }) => g.id)).toEqual(['g1']);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('Randoco');
    expect(serialized).not.toContain('"g2"');
  });

  it('errors, naming the known tenants, when the tenant resolves to nothing', async () => {
    const result = await listDeploymentGroupsTool.execute({ tenant: 'Nope Ltd' }, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no todyl tenant matches/i);
    expect(result.content[0].text).toMatch(/Acme/);
    expect(result.content[0].text).toMatch(/Beta/);
  });

  it('says the read was incomplete when denying a tenant on a TRUNCATED sweep', async () => {
    const truncated = {
      deploymentGroups: async () => ({ items: GROUPS, truncated: true }),
    } as unknown as TodylRepository;
    const result = await listDeploymentGroupsTool.execute({ tenant: 'Nope Ltd' }, truncated);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no todyl tenant matches/i);
    expect(result.content[0].text).toMatch(/not all deployment groups were read/i);
  });

  it('carries no incomplete caveat when the read was complete', async () => {
    const result = await listDeploymentGroupsTool.execute({ tenant: 'Nope Ltd' }, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/incomplete/i);
  });
});

describe('list-invoices', () => {
  it('passes the date window through to the repository', async () => {
    const invoices = vi.fn(async () => ({ items: INVOICES, truncated: false }));
    const repo = { invoices } as unknown as TodylRepository;
    await listInvoicesTool.execute({ start_date: '2026-01', end_date: '2026-03' }, repo);
    expect(invoices).toHaveBeenCalledWith('2026-01', '2026-03');
  });

  it('passes undefined for missing dates to the repository', async () => {
    const invoices = vi.fn(async () => ({ items: INVOICES, truncated: false }));
    const repo = { invoices } as unknown as TodylRepository;
    await listInvoicesTool.execute({ end_date: '2026-03' }, repo);
    expect(invoices).toHaveBeenCalledWith(undefined, '2026-03');
  });

  it('rejects a malformed month before calling Todyl', async () => {
    const invoices = vi.fn();
    const repo = { invoices } as unknown as TodylRepository;
    const result = await listInvoicesTool.execute({ start_date: '2026-1' }, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/YYYY-MM/);
    expect(invoices).not.toHaveBeenCalled();
  });

  it('rejects month 00 before calling Todyl', async () => {
    const invoices = vi.fn();
    const repo = { invoices } as unknown as TodylRepository;
    const result = await listInvoicesTool.execute({ start_date: '2026-00' }, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/valid month \(01-12\)/);
    expect(invoices).not.toHaveBeenCalled();
  });

  it('rejects month 13 before calling Todyl', async () => {
    const invoices = vi.fn();
    const repo = { invoices } as unknown as TodylRepository;
    const result = await listInvoicesTool.execute({ end_date: '2026-13' }, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/valid month \(01-12\)/);
    expect(invoices).not.toHaveBeenCalled();
  });

  it('rejects end_date before start_date', async () => {
    const invoices = vi.fn();
    const repo = { invoices } as unknown as TodylRepository;
    const result = await listInvoicesTool.execute({ start_date: '2026-03', end_date: '2026-01' }, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must not be before/);
    expect(invoices).not.toHaveBeenCalled();
  });

  it('normalizes empty-string dates to undefined and echoes current month', async () => {
    const invoices = vi.fn(async () => ({ items: INVOICES, truncated: false }));
    const repo = { invoices } as unknown as TodylRepository;
    const out = payload(await listInvoicesTool.execute({ start_date: '', end_date: '' }, repo));
    expect(invoices).toHaveBeenCalledWith(undefined, undefined);
    expect(out.window.start_date).toBe('current month');
    expect(out.window.end_date).toBe('current month');
  });

  it('filters by tenant', async () => {
    const repo = {
      invoices: async () => ({ items: INVOICES, truncated: false }),
    } as unknown as TodylRepository;
    const some = payload(await listInvoicesTool.execute({ tenant: 'Acme' }, repo));
    expect(some.invoices).toHaveLength(2);
  });

  it('errors, rather than returning an empty list, for a tenant that resolves to nothing', async () => {
    // CHANGED BEHAVIOUR (task-11 final pass). This used to assert
    // `invoices: []` for an unknown tenant. That empty list was produced by
    // falling through to a raw-string filter (`resolvedId ?? tenant`) that
    // happened to match nothing — the trapdoor that re-opens the cross-client
    // merge the moment resolution and raw matching diverge. Resolution now has
    // no "nothing matched, carry on" outcome, and naming the known tenants is a
    // more useful answer for a billing question than a silent zero.
    const repo = {
      invoices: async () => ({ items: INVOICES, truncated: false }),
    } as unknown as TodylRepository;
    const result = await listInvoicesTool.execute({ tenant: 'Beta' }, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no todyl tenant matches/i);
    expect(result.content[0].text).toMatch(/Acme/);
  });

  it('says the read was incomplete when denying a tenant on a TRUNCATED sweep', async () => {
    // Worst case for a billing tool: an unread page holds the client, and we
    // answer that no such client exists.
    const truncated = {
      invoices: async () => ({ items: INVOICES, truncated: true }),
    } as unknown as TodylRepository;
    const result = await listInvoicesTool.execute({ tenant: 'Beta' }, truncated);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no todyl tenant matches/i);
    expect(result.content[0].text).toMatch(/not all invoices were read/i);
  });

  it('carries no incomplete caveat when the read was complete', async () => {
    const repo = {
      invoices: async () => ({ items: INVOICES, truncated: false }),
    } as unknown as TodylRepository;
    const result = await listInvoicesTool.execute({ tenant: 'Beta' }, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/incomplete/i);
  });

  it('filters by subtenant name and marks as covering multiple tenants', async () => {
    const repo = {
      invoices: async () => ({ items: INVOICES, truncated: false }),
    } as unknown as TodylRepository;
    const out = payload(await listInvoicesTool.execute({ tenant: 'acme uk' }, repo));
    expect(out.invoices).toHaveLength(1);
    expect(out.invoices[0].covers_multiple_tenants).toBe(true);
  });

  it('filters by primary tenant name without marking as covering multiple tenants', async () => {
    const repo = {
      invoices: async () => ({ items: INVOICES, truncated: false }),
    } as unknown as TodylRepository;
    const out = payload(await listInvoicesTool.execute({ tenant: 'Acme' }, repo));
    const withSubtenants = out.invoices.find((i: { id: string }) => i.id === 'inv2');
    expect(withSubtenants).toBeDefined();
    expect(withSubtenants.covers_multiple_tenants).toBeUndefined();
  });

  it('refuses an ambiguous tenant name spanning tenant and subtenant', async () => {
    const clash = [
      {
        id: 'inv1',
        status: 'paid',
        subtotal: 5000,
        currency: 'USD',
        tenant: { id: 't1', name: 'Acme' },
      },
      {
        id: 'inv2',
        status: 'paid',
        subtotal: 8000,
        currency: 'USD',
        tenant: { id: 't2', name: 'Beta' },
        subtenants: [{ id: 't3', name: 'Acme' }],
      },
    ];
    const r = { invoices: async () => ({ items: clash, truncated: false }) } as unknown as TodylRepository;
    const result = await listInvoicesTool.execute({ tenant: 'Acme' }, r);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/matches.*\\"Acme/);
    expect(result.content[0].text).toMatch(/t1/);
    expect(result.content[0].text).toMatch(/t3/);
  });

  it('names "invoices" (not "devices") in its own truncation warning', async () => {
    const r = { invoices: async () => ({ items: INVOICES, truncated: true }) } as unknown as TodylRepository;
    const out = payload(await listInvoicesTool.execute({}, r));
    expect(out.warning).toMatch(/not all invoices were read/i);
    expect(out.warning).not.toMatch(/not all devices/i);
  });

  it('does not refuse, and does not leak an unrelated tenant\'s invoice, when that tenant\'s id equals the search string (fix round 2+3)', async () => {
    // The worst-case version of this bug for a billing tool: an unrelated
    // client's invoice presented as part of Acme's bill. Round 3 requires the
    // filter step (not just the ambiguity check) to key off the resolved id.
    const collision = [
      { id: 'inv1', status: 'paid', subtotal: 100, currency: 'USD', tenant: { id: 't1', name: 'Acme' } },
      { id: 'inv2', status: 'paid', subtotal: 200, currency: 'USD', tenant: { id: 'Acme', name: 'Randoco' } },
    ];
    const r = { invoices: async () => ({ items: collision, truncated: false }) } as unknown as TodylRepository;
    const result = await listInvoicesTool.execute({ tenant: 'Acme' }, r);
    expect(result.isError).toBeFalsy();
    const out = payload(result);
    expect(out.matched).toBe(1);
    expect(out.invoices.map((i: { id: string }) => i.id)).toEqual(['inv1']);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('Randoco');
    expect(serialized).not.toContain('inv2');
  });

  it('does not leak via the SUBTENANT path when an unrelated subtenant\'s id equals the search string', async () => {
    // The subtenant rule is a second, independent way a raw-string filter can
    // pull in another client: inv2 belongs to "Other Co", and one of its
    // subtenants carries the literal id "Acme". Matching the raw string would
    // attach Other Co's whole bill to Acme, marked covers_multiple_tenants —
    // wrong money, presented as if explained.
    const collision = [
      { id: 'inv1', status: 'paid', subtotal: 100, currency: 'USD', tenant: { id: 't1', name: 'Acme' } },
      { id: 'inv2', status: 'paid', subtotal: 999, currency: 'USD', tenant: { id: 't9', name: 'Other Co' },
        subtenants: [{ id: 'Acme', name: 'Randoco' }] },
    ];
    const r = { invoices: async () => ({ items: collision, truncated: false }) } as unknown as TodylRepository;
    const result = await listInvoicesTool.execute({ tenant: 'Acme' }, r);
    expect(result.isError).toBeFalsy();
    const out = payload(result);
    expect(out.matched).toBe(1);
    expect(out.invoices.map((i: { id: string }) => i.id)).toEqual(['inv1']);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('Randoco');
    expect(serialized).not.toContain('Other Co');
    expect(serialized).not.toContain('999');
  });
});
