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
});

describe('list-invoices', () => {
  it('passes the date window through to the repository', async () => {
    const invoices = vi.fn(async () => ({ items: INVOICES, truncated: false }));
    const repo = { invoices } as unknown as TodylRepository;
    await listInvoicesTool.execute({ start_date: '2026-01', end_date: '2026-03' }, repo);
    expect(invoices).toHaveBeenCalledWith('2026-01', '2026-03');
  });

  it('rejects a malformed month before calling Todyl', async () => {
    const invoices = vi.fn();
    const repo = { invoices } as unknown as TodylRepository;
    const result = await listInvoicesTool.execute({ start_date: '2026-1' }, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/YYYY-MM/);
    expect(invoices).not.toHaveBeenCalled();
  });

  it('filters by tenant', async () => {
    const repo = {
      invoices: async () => ({ items: INVOICES, truncated: false }),
    } as unknown as TodylRepository;
    const none = payload(await listInvoicesTool.execute({ tenant: 'Beta' }, repo));
    expect(none.invoices).toHaveLength(0);
    const some = payload(await listInvoicesTool.execute({ tenant: 'Acme' }, repo));
    expect(some.invoices).toHaveLength(1);
  });
});
