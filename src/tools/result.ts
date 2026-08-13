import type { z } from 'zod';
import { distinctTenantsMatching } from '../filters.js';
import type { TodylRepository } from '../todyl/repository.js';
import type { TenantRef } from '../todyl/types.js';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface TodylTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  readOnly: true;
  execute(args: any, repo: TodylRepository): Promise<ToolResult>;
}

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/**
 * Refuse an ambiguous tenant name rather than merging two clients' data into
 * one answer. Returns an error result to return directly, or undefined when
 * the name is unambiguous. Every tool accepting `tenant` must call this.
 */
export function ambiguousTenantError<T>(
  items: T[],
  tenant: string,
  pick: (item: T) => TenantRef | undefined
): ToolResult | undefined {
  const matches = distinctTenantsMatching(items, tenant, pick);
  if (matches.length <= 1) return undefined;
  const candidates = matches.map((t) => `${t.name} (${t.id})`).join('; ');
  return toolError(
    `More than one tenant matches "${tenant}" — pass the tenant id instead. Candidates: ${candidates}`
  );
}

/** Combine the sweep-truncation and cache-staleness warnings into one field. */
export function warningFor(dataset: { truncated: boolean; staleWarning?: string }): string | undefined {
  const parts: string[] = [];
  if (dataset.truncated) {
    parts.push(
      'Not all devices were read — the page cap was reached, so these results are incomplete. ' +
        'Raise TODYL_MAX_PAGES if this persists.'
    );
  }
  if (dataset.staleWarning) parts.push(dataset.staleWarning);
  return parts.length ? parts.join(' ') : undefined;
}
