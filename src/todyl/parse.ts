import type { Device, DeploymentGroup, Invoice } from './types.js';

/**
 * Field names that must never leave this server. Todyl's deployment-group
 * response carries live enrollment secrets; returning them would put working
 * credentials into an LLM's context, the gateway's audit log and the MCP
 * client's conversation history.
 *
 * Redaction happens HERE, at the single parse boundary, rather than at each
 * call site — so a tool added later cannot reintroduce the leak by forgetting.
 *
 * Includes both the parent `credentials` block and the individual secret keys
 * it contains, so that even if a response shape evolves or nests these keys
 * differently, they remain scrubbed at any depth.
 */
export const REDACTED_KEYS = ['credentials', 'deploy_key', 'temporary_deploy_key'] as const;

export function parseDevice(raw: unknown): Device {
  return raw as Device;
}

export function parseInvoice(raw: unknown): Invoice {
  return raw as Invoice;
}

/**
 * Deep-scrub the deployment group response: recursively walk the whole structure,
 * remove any key in REDACTED_KEYS at any depth, and return a deep copy.
 *
 * DeploymentGroup is scrubbed but Device and Invoice are not: neither carries
 * secrets, and deep-cloning thousands of devices on every refresh would be
 * wasteful. This asymmetry is deliberate.
 *
 * Input is assumed acyclic (JSON-derived) and requires no cycle detection.
 */
function deepScrub(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepScrub(item));
  }

  const scrubbed: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (!REDACTED_KEYS.includes(key as any)) {
      scrubbed[key] = deepScrub(val);
    }
  }
  return scrubbed;
}

export function parseDeploymentGroup(raw: unknown): DeploymentGroup {
  return deepScrub(raw) as unknown as DeploymentGroup;
}
