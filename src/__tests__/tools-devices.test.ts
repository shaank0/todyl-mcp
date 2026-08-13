import { describe, it, expect } from 'vitest';
import { getDeviceTool, listDevicesTool } from '../tools/devices.js';
import type { TodylRepository } from '../todyl/repository.js';
import type { Device } from '../todyl/types.js';

const DEVICES: Device[] = [
  { id: 'd1', name: 'LAPTOP-1', serial_number: 'SN-1', tenant: { id: 't1', name: 'Acme' },
    last_checkin_at: new Date().toISOString(), tamper_protection: { enabled: true } },
  { id: 'd2', name: 'LAPTOP-2', serial_number: 'SN-2', tenant: { id: 't2', name: 'Beta' },
    last_checkin_at: '2020-01-01T00:00:00Z', tamper_protection: { enabled: false } },
];

const repo = (over: Partial<Awaited<ReturnType<TodylRepository['devices']>>> = {}) =>
  ({ devices: async () => ({ items: DEVICES, truncated: false, ...over }) }) as unknown as TodylRepository;

const payload = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);

describe('list-devices', () => {
  it('returns compact rows and a matched-of-total count', async () => {
    const out = payload(await listDevicesTool.execute({}, repo()));
    expect(out.matched).toBe(2);
    expect(out.total).toBe(2);
    expect(out.devices[0].session).toBeUndefined();
  });

  it('applies filters', async () => {
    const out = payload(await listDevicesTool.execute({ stale_days: 30 }, repo()));
    expect(out.matched).toBe(1);
    expect(out.devices[0].id).toBe('d2');
    expect(out.total).toBe(2);
  });

  it('caps returned rows with limit and says so', async () => {
    const out = payload(await listDevicesTool.execute({ limit: 1 }, repo()));
    expect(out.devices).toHaveLength(1);
    expect(out.matched).toBe(2);
    expect(out.note).toMatch(/showing 1 of 2/i);
  });

  it('surfaces the truncation warning from the sweep', async () => {
    const out = payload(await listDevicesTool.execute({}, repo({ truncated: true })));
    expect(out.warning).toMatch(/not all devices/i);
  });

  it('refuses an ambiguous tenant name instead of merging two clients', async () => {
    const clash = [
      { id: 'x', name: 'A', tenant: { id: 't1', name: 'Smith & Co' } },
      { id: 'y', name: 'B', tenant: { id: 't9', name: 'Smith & Co' } },
    ] as Device[];
    const r = { devices: async () => ({ items: clash, truncated: false }) } as unknown as TodylRepository;
    const result = await listDevicesTool.execute({ tenant: 'Smith & Co' }, r);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/t1/);
    expect(result.content[0].text).toMatch(/t9/);
  });

  it('accepts a tenant id even when names clash', async () => {
    const clash = [
      { id: 'x', name: 'A', tenant: { id: 't1', name: 'Smith & Co' } },
      { id: 'y', name: 'B', tenant: { id: 't9', name: 'Smith & Co' } },
    ] as Device[];
    const r = { devices: async () => ({ items: clash, truncated: false }) } as unknown as TodylRepository;
    const out = payload(await listDevicesTool.execute({ tenant: 't9' }, r));
    expect(out.devices.map((d: { id: string }) => d.id)).toEqual(['y']);
  });

  it('surfaces a staleness warning', async () => {
    const out = payload(
      await listDevicesTool.execute({}, repo({ staleWarning: 'Todyl could not be refreshed (503)' }))
    );
    expect(out.warning).toMatch(/503/);
  });
});

describe('get-device', () => {
  it('finds by id and returns the FULL record', async () => {
    const out = payload(await getDeviceTool.execute({ identifier: 'd2' }, repo()));
    expect(out.device.id).toBe('d2');
    expect(out.device.tamper_protection).toEqual({ enabled: false });
  });

  it('finds by name and serial, case-insensitively', async () => {
    expect(payload(await getDeviceTool.execute({ identifier: 'laptop-1' }, repo())).device.id).toBe('d1');
    expect(payload(await getDeviceTool.execute({ identifier: 'sn-2' }, repo())).device.id).toBe('d2');
  });

  it('errors with candidates when ambiguous, rather than guessing', async () => {
    const dupes = [
      { id: 'x1', name: 'SHARED', tenant: { id: 't1', name: 'Acme' } },
      { id: 'x2', name: 'SHARED', tenant: { id: 't2', name: 'Beta' } },
    ] as Device[];
    const r = { devices: async () => ({ items: dupes, truncated: false }) } as unknown as TodylRepository;
    const result = await getDeviceTool.execute({ identifier: 'shared' }, r);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/x1/);
    expect(result.content[0].text).toMatch(/x2/);
  });

  it('errors clearly when nothing matches', async () => {
    const result = await getDeviceTool.execute({ identifier: 'nope' }, repo());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no device/i);
  });
});
