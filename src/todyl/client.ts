import type { TodylConfig } from '../config.js';
import { toTodylError } from './errors.js';
import type { TodylEnvelope } from './types.js';

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string> }
) => Promise<{ status: number; text(): Promise<string> }>;

export interface TodylClient {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<TodylEnvelope<T>>;
}

/** Reads are retry-safe per Todyl's docs, so a 5xx is retried exactly once. */
export function createClient(
  config: TodylConfig,
  fetchFn: FetchFn = globalThis.fetch as unknown as FetchFn
): TodylClient {
  async function attempt(url: string) {
    return fetchFn(url, {
      method: 'GET',
      headers: {
        'X-Todyl-Client-Id': config.clientId,
        'X-Todyl-Access-Token': config.accessToken,
        Accept: 'application/json',
      },
    });
  }

  return {
    async get<T>(path: string, query = {}) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') params.set(key, String(value));
      }
      const qs = params.toString();
      const url = `${config.baseUrl}${path}${qs ? `?${qs}` : ''}`;

      let response = await attempt(url);
      if (response.status >= 500) response = await attempt(url);

      const body = await response.text();
      if (response.status < 200 || response.status >= 300) {
        throw toTodylError(response.status, body);
      }
      return JSON.parse(body) as TodylEnvelope<T>;
    },
  };
}
