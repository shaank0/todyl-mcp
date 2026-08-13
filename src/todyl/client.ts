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

      let response: { status: number; text(): Promise<string> } | null = null;
      let lastError: Error | null = null;

      // Single retry loop: up to 2 attempts, handling both rejections and 5xx responses
      for (let attemptNum = 0; attemptNum < 2; attemptNum++) {
        try {
          response = await attempt(url);
          lastError = null;

          // If we got a successful response (not 5xx), stop immediately — no retry needed
          if (response.status < 500) {
            break;
          }
          // If 5xx, continue to next iteration to retry (or exit if this was attempt 1)
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          // Continue to next iteration to retry (or exit if this was attempt 1)
        }
      }

      // After the loop: exactly two outcomes at this point
      if (lastError) {
        // Last attempt rejected — throw TodylError with status 0
        throw new TodylError(
          `Todyl API request failed: ${lastError.message}`,
          0,
          'network_error',
          undefined,
          undefined
        );
      }

      // response is guaranteed to be non-null here (we exited the loop with a response)
      if (response!.status >= 500) {
        // Last attempt was 5xx — consume body and throw via toTodylError
        const body = await response!.text();
        throw toTodylError(response!.status, body);
      }

      // Success: 2xx or 4xx response (non-error status)
      const body = await response!.text();
      if (response!.status < 200 || response!.status >= 300) {
        throw toTodylError(response!.status, body);
      }

      // Parse response body
      try {
        return JSON.parse(body) as TodylEnvelope<T>;
      } catch (err) {
        // Non-JSON 2xx response — wrap in TodylError
        const preview = body.substring(0, 120);
        throw new TodylError(
          `Todyl returned a non-JSON response (${response!.status}): ${preview}`,
          response!.status,
          'non_json_response',
          undefined,
          undefined
        );
      }
    },
  };
}
