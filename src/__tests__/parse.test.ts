import { describe, it, expect } from 'vitest';
import { parseDeploymentGroup, parseDevice, parseInvoice } from '../todyl/parse.js';

const RAW_GROUP = {
  id: 'g1',
  name: 'Default License Group',
  note: 'n',
  bundle: { id: 'b1', name: 'Bundle' },
  credentials: {
    deploy_key: 'SUPER-SECRET-DEPLOY-KEY',
    temporary_deploy_key: 'TEMP-SECRET',
    temporary_deploy_key_expires_at: '2026-01-01T00:00:00Z',
  },
  tenant: { id: 't1', name: 'company-613' },
  products: [{ id: 'p1', type: 'edr', display_name: 'EDR', is_tenant_wide: true }],
  device_count: 4,
};

describe('parseDeploymentGroup', () => {
  it('strips the entire credentials block', () => {
    const group = parseDeploymentGroup(RAW_GROUP) as Record<string, unknown>;
    expect(group.credentials).toBeUndefined();
    expect(JSON.stringify(group)).not.toContain('SUPER-SECRET-DEPLOY-KEY');
    expect(JSON.stringify(group)).not.toContain('TEMP-SECRET');
    expect(JSON.stringify(group)).not.toContain('deploy_key');
  });

  it('keeps every non-secret field', () => {
    const group = parseDeploymentGroup(RAW_GROUP);
    expect(group.id).toBe('g1');
    expect(group.name).toBe('Default License Group');
    expect(group.bundle).toEqual({ id: 'b1', name: 'Bundle' });
    expect(group.tenant).toEqual({ id: 't1', name: 'company-613' });
    expect(group.products).toHaveLength(1);
    expect(group.device_count).toBe(4);
  });

  it('strips credentials even under an unexpected shape', () => {
    const odd = { id: 'g2', credentials: 'a-bare-string-key' };
    expect(JSON.stringify(parseDeploymentGroup(odd))).not.toContain('a-bare-string-key');
  });

  it('does not fail when credentials is absent', () => {
    expect(parseDeploymentGroup({ id: 'g3' }).id).toBe('g3');
  });
});

describe('parseDevice / parseInvoice', () => {
  it('passes device fields through unchanged', () => {
    const d = parseDevice({ id: 'd1', name: 'laptop', tamper_protection: { enabled: false } });
    expect(d.id).toBe('d1');
    expect(d.tamper_protection).toEqual({ enabled: false });
  });

  it('passes invoice fields through unchanged', () => {
    const i = parseInvoice({ id: 'inv-1', subtotal: 14250, currency: 'USD' });
    expect(i.subtotal).toBe(14250);
    expect(i.currency).toBe('USD');
  });
});
