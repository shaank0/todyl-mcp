import { describe, it, expect } from 'vitest';
import { listDevicesTool } from '../tools/devices.js';
import { listDeploymentGroupsTool } from '../tools/groups.js';
import { listInvoicesTool } from '../tools/invoices.js';
import { devicePostureSummaryTool } from '../tools/posture.js';
import { tenantReportTool } from '../tools/report.js';
import type { TodylRepository } from '../todyl/repository.js';

const fresh = new Date().toISOString();
const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

/**
 * Two Todyl tenants sharing a display name — a migrated or duplicated tenant,
 * ordinary in an MSP estate. Devices live on t-AAA; the invoice is billed to
 * t-BBB. Neither list tool can see the other's dataset, and they must NOT start
 * unioning all three (that would make list-devices fail for a token without
 * `billing.invoices:read`, the coupling Task 11 deliberately removed). So the
 * defence is disclosure: each answer names the id it actually bound.
 */
const SPLIT_REPO = {
  devices: async () => ({
    items: [{ id: 'd1', tenant: { id: 't-AAA', name: 'Acme Corp' }, last_checkin_at: fresh }],
    truncated: false,
  }),
  deploymentGroups: async () => ({
    items: [{ id: 'g1', name: 'Default', tenant: { id: 't-AAA', name: 'Acme Corp' } }],
    truncated: false,
  }),
  invoices: async () => ({
    items: [{ id: 'inv1', subtotal: 100, currency: 'USD', tenant: { id: 't-BBB', name: 'Acme Corp' } }],
    truncated: false,
  }),
} as unknown as TodylRepository;

describe('a tenant-scoped answer names the tenant it bound', () => {
  it('list-devices echoes the resolved tenant id', async () => {
    const out = payload(await listDevicesTool.execute({ tenant: 'Acme Corp' }, SPLIT_REPO));
    expect(out.tenant).toBe('Acme Corp');
    expect(out.tenant_id).toBe('t-AAA');
  });

  it('list-deployment-groups echoes the resolved tenant id', async () => {
    const out = payload(await listDeploymentGroupsTool.execute({ tenant: 'Acme Corp' }, SPLIT_REPO));
    expect(out.tenant_id).toBe('t-AAA');
  });

  it('list-invoices echoes the resolved tenant id', async () => {
    const out = payload(await listInvoicesTool.execute({ tenant: 'Acme Corp' }, SPLIT_REPO));
    expect(out.tenant_id).toBe('t-BBB');
  });

  it('device-posture-summary echoes the resolved tenant id', async () => {
    const out = payload(await devicePostureSummaryTool.execute({ tenant: 'Acme Corp' }, SPLIT_REPO));
    expect(out.tenant_id).toBe('t-AAA');
  });

  it('omits the echo when no tenant was asked for, so it always means "this is what I bound"', async () => {
    const out = payload(await listDevicesTool.execute({}, SPLIT_REPO));
    expect(out.tenant_id).toBeUndefined();
    expect(out.tenant).toBeUndefined();
  });

  it('two tools answering about the SAME name visibly disagree on the id instead of silently', async () => {
    // The defect: list-devices returns t-AAA's fleet and list-invoices returns
    // t-BBB's bill, both captioned "Acme Corp", neither warning. They still
    // return different clients' records — that is inherent to two tenants
    // sharing a name — but the disagreement is now on the face of both answers.
    const devices = payload(await listDevicesTool.execute({ tenant: 'Acme Corp' }, SPLIT_REPO));
    const invoices = payload(await listInvoicesTool.execute({ tenant: 'Acme Corp' }, SPLIT_REPO));
    expect(devices.tenant_id).not.toBe(invoices.tenant_id);
    expect(devices.tenant_id).toBe('t-AAA');
    expect(invoices.tenant_id).toBe('t-BBB');
  });

  it('tenant-report still REFUSES the same string, because it alone sees all three namespaces', async () => {
    // Unchanged, and the reason the list tools only disclose: the report unions
    // the namespaces, so it can see the collision and must not pick one.
    const result = await tenantReportTool.execute({ tenant: 'Acme Corp' }, SPLIT_REPO);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/t-AAA/);
    expect(result.content[0].text).toMatch(/t-BBB/);
  });

  it('tools that CAN see the same tenant agree on its id', async () => {
    const oneTenant = {
      devices: async () => ({
        items: [{ id: 'd1', tenant: { id: 't1', name: 'Acme' }, last_checkin_at: fresh }],
        truncated: false,
      }),
      deploymentGroups: async () => ({
        items: [{ id: 'g1', tenant: { id: 't1', name: 'Acme' } }],
        truncated: false,
      }),
      invoices: async () => ({
        items: [{ id: 'inv1', tenant: { id: 't1', name: 'Acme' } }],
        truncated: false,
      }),
    } as unknown as TodylRepository;

    const ids = await Promise.all(
      [listDevicesTool, listDeploymentGroupsTool, listInvoicesTool, devicePostureSummaryTool].map(
        async (tool) => payload(await tool.execute({ tenant: 'Acme' }, oneTenant)).tenant_id
      )
    );
    const report = payload(await tenantReportTool.execute({ tenant: 'Acme' }, oneTenant));
    expect(new Set([...ids, report.tenant_id])).toEqual(new Set(['t1']));
  });
});

describe('a not-found answer states the scope it actually searched', () => {
  // A newly-onboarded client with groups and invoices but no agents deployed
  // yet is genuinely absent from the devices namespace — on the happy path,
  // nothing truncated. "No Todyl tenant matches X. Known tenants: …" states
  // that dataset-local fact as a global one.
  it('list-devices names the device scope and says the list is not every client', async () => {
    const result = await listDevicesTool.execute({ tenant: 'Beta LLC' }, SPLIT_REPO);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/own at least one device/i);
    expect(text).toMatch(/not every client in Todyl/i);
  });

  it('list-deployment-groups names the deployment-group scope', async () => {
    const result = await listDeploymentGroupsTool.execute({ tenant: 'Beta LLC' }, SPLIT_REPO);
    expect(result.content[0].text).toMatch(/have a deployment group/i);
  });

  it('list-invoices names the invoice-window scope', async () => {
    const result = await listInvoicesTool.execute({ tenant: 'Beta LLC' }, SPLIT_REPO);
    expect(result.content[0].text).toMatch(/appearing on an invoice/i);
  });

  it('device-posture-summary names the device scope', async () => {
    const result = await devicePostureSummaryTool.execute({ tenant: 'Beta LLC' }, SPLIT_REPO);
    expect(result.content[0].text).toMatch(/own at least one device/i);
  });

  it('tenant-report names its union scope, not one dataset', async () => {
    const result = await tenantReportTool.execute({ tenant: 'Beta LLC' }, SPLIT_REPO);
    expect(result.content[0].text).toMatch(/datasets this report could read/i);
  });

  it('still names the tenants it DID find, so a typo is still correctable', async () => {
    const result = await listDevicesTool.execute({ tenant: 'Beta LLC' }, SPLIT_REPO);
    expect(result.content[0].text).toMatch(/Acme Corp/);
  });
});
