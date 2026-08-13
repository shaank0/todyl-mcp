import type { Device, DeploymentGroup, Invoice } from './types.js';

/**
 * Field names that must never leave this server. Todyl's deployment-group
 * response carries live enrollment secrets; returning them would put working
 * credentials into an LLM's context, the gateway's audit log and the MCP
 * client's conversation history.
 *
 * Redaction happens HERE, at the single parse boundary, rather than at each
 * call site — so a tool added later cannot reintroduce the leak by forgetting.
 */
export const REDACTED_KEYS = ['credentials'] as const;

export function parseDevice(raw: unknown): Device {
  return raw as Device;
}

export function parseInvoice(raw: unknown): Invoice {
  return raw as Invoice;
}

export function parseDeploymentGroup(raw: unknown): DeploymentGroup {
  const source = { ...(raw as Record<string, unknown>) };
  for (const key of REDACTED_KEYS) delete source[key];
  return source as unknown as DeploymentGroup;
}
