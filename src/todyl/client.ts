import type { TodylConfig } from '../config.js';
import { TodylError, toTodylError } from './errors.js';
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

      let response: { status: number; text(): Promise<string> };
      let fetchError: Error | null = null;

      // First attempt
      try {
        response = await attempt(url);
      } catch (err) {
        fetchError = err instanceof Error ? err : new Error(String(err));
        // Retry on fetch rejection
        try {
          response = await attempt(url);
          fetchError = null; // Clear error on successful retry
        } catch (retryErr) {
          // Both attempts failed — throw TodylError with status 0
          const cause = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new TodylError(
            `Todyl API request failed: ${cause}`,
            0,
            'network_error',
            undefined,
            undefined
          );
        }
      }

      // Retry 5xx after first success
      if (response.status >= 500) {
        try {
          response = await attempt(url);
        } catch (err) {
          // Retry rejection on 5xx — treat as another 5xx
          const cause = err instanceof Error ? err.message : String(err);
          throw new TodylError(
            `Todyl API request failed: ${cause}`,
            0,
            'network_error',
            undefined,
            undefined
          );
        }
      }

      const body = await response.text();
      if (response.status < 200 || response.status >= 300) {
        throw toTodylError(response.status, body);
      }

      // Parse response body
      try {
        return JSON.parse(body) as TodylEnvelope<T>;
      } catch (err) {
        // Non-JSON 2xx response — wrap in TodylError
        const preview = body.substring(0, 120);
        throw new TodylError(
          `Todyl returned a non-JSON response (200): ${preview}`,
          response.status,
          'non_json_response',
          undefined,
          undefined
        );
      }
    },
  };
}
