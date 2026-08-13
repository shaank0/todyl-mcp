import { z } from 'zod';
import { applyDeviceFilters, projectDevice, type DeviceFilters } from '../filters.js';
import type { TodylRepository } from '../todyl/repository.js';
import { ambiguousTenantError, ok, toolError, warningFor, type TodylTool } from './result.js';

const FILTER_SHAPE = {
  tenant: z.string().optional().describe('Tenant name (case-insensitive) or exact tenant id.'),
  search: z.string().optional().describe('Substring matched against device name, serial number and UDID.'),
  stale_days: z.number().int().positive().optional()
    .describe('Only devices whose last check-in is older than this many days. Devices that have never checked in are included.'),
  needs_reboot: z.boolean().optional().describe('Only devices with a reboot pending.'),
  tamper_protection: z.enum(['on', 'off']).optional()
    .describe('Filter by tamper protection. "off" also matches devices where the state is unknown.'),
  agent_outdated: z.boolean().optional()
    .describe('Only devices whose agent version differs from the latest available.'),
  billing_status: z.string().optional().describe('Exact billing status, e.g. "billing" or "not_billing".'),
  device_type: z.string().optional().describe('Exact device type.'),
  os_type: z.string().optional().describe('Exact OS type, e.g. "Windows" or "macOS".'),
  limit: z.number().int().positive().max(500).optional().describe('Maximum rows to return. Default 50.'),
};

export const listDevicesTool: TodylTool = {
  name: 'list-devices',
  title: 'List Todyl devices',
  description:
    'List devices across all Todyl tenants with security-posture filters. Returns a compact row per device ' +
    '(name, tenant, OS, agent version, posture flags, last check-in) plus how many matched out of the total. ' +
    'Use this for questions like "which machines have not checked in for 30 days", "which are behind on agent ' +
    'version", or "which have tamper protection off". For the full record of one device, use get-device.',
  inputSchema: FILTER_SHAPE,
  readOnly: true,
  async execute(args, repo: TodylRepository) {
    const { limit = 50, ...filters } = args as DeviceFilters & { limit?: number };
    const dataset = await repo.devices();

    if (filters.tenant) {
      const clash = ambiguousTenantError(dataset.items, filters.tenant, (d) => d.tenant);
      if (clash) return clash;
    }

    const matched = applyDeviceFilters(dataset.items, filters);
    const rows = matched.slice(0, limit).map(projectDevice);

    return ok({
      matched: matched.length,
      total: dataset.items.length,
      devices: rows,
      ...(matched.length > rows.length
        ? { note: `Showing ${rows.length} of ${matched.length} matches — raise "limit" to see more.` }
        : {}),
      ...(warningFor(dataset) ? { warning: warningFor(dataset) } : {}),
    });
  },
};

export const getDeviceTool: TodylTool = {
  name: 'get-device',
  title: 'Get one Todyl device',
  description:
    'Return the complete record for a single device, looked up by id, name, serial number or UDID. ' +
    'Includes OS and agent detail, deployment group, tenant, SASE session and tamper-protection state. ' +
    'If more than one device matches, the candidates are returned rather than an arbitrary pick.',
  inputSchema: {
    identifier: z.string().describe('Device id, name, serial number or UDID. Case-insensitive.'),
  },
  readOnly: true,
  async execute(args, repo: TodylRepository) {
    const identifier = String((args as { identifier: string }).identifier ?? '').trim();
    const needle = identifier.toLowerCase();
    if (!needle) return toolError('identifier is required.');

    const dataset = await repo.devices();
    const matches = dataset.items.filter((d) =>
      [d.id, d.name, d.serial_number, d.udid].some((v) => (v ?? '').toLowerCase() === needle)
    );

    if (matches.length === 0) {
      return toolError(
        `No device matches "${identifier}" by id, name, serial number or UDID. ` +
          'Use list-devices with the "search" filter for a substring match.'
      );
    }
    if (matches.length > 1) {
      const candidates = matches
        .map((d) => `${d.name ?? '(unnamed)'} [id ${d.id}, tenant ${d.tenant?.name ?? 'unknown'}]`)
        .join('; ');
      return toolError(`More than one device matches "${identifier}" — pass the id instead. Candidates: ${candidates}`);
    }

    return ok({
      device: matches[0],
      ...(warningFor(dataset) ? { warning: warningFor(dataset) } : {}),
    });
  },
};
