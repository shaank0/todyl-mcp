import type { TodylConfig } from '../config.js';
import { safeUpstreamText, TodylError, toTodylError } from './errors.js';
import type { TodylEnvelope } from './types.js';

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string> }
) => Promise<{
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}>;

export interface TodylClient {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<TodylEnvelope<T>>;
}

/**
 * The client is the ONLY place a query string is composed. A caller that bakes
 * its own `?a=b` into `path` would produce `…?a=b?limit=1000` — a second `?`,
 * which is not a separator: the previous parameter swallows `?limit=1000` as
 * part of its value and `limit` is never sent. That shipped once (dated invoice
 * queries), and it is invisible in output — the tool still labels the window the
 * caller asked for while the wire carried a different one, plus the page size
 * silently dropped to Todyl's default. Structured params only; a path carrying
 * `?` is a programming error and fails loudly rather than reaching the network.
 */
function assertNoQueryInPath(path: string): void {
  // `#` too: a fragment would swallow the entire query string that follows it.
  // Unreachable today (every path is a literal in repository.ts) — it is one
  // character next to a check that already exists, and the cost of being wrong
  // about "unreachable" here is a silently unfiltered request.
  const offender = ['?', '#'].find((char) => path.includes(char));
  if (offender) {
    throw new Error(
      `Todyl client: path must not contain a query string or fragment — found ` +
        `"${offender}" in "${path}". Pass parameters as the \`query\` argument ` +
        'so they are encoded exactly once.'
    );
  }
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
      assertNoQueryInPath(path);
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') params.set(key, String(value));
      }
      const qs = params.toString();
      const url = `${config.baseUrl}${path}${qs ? `?${qs}` : ''}`;

      let response: Awaited<ReturnType<FetchFn>> | null = null;
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
      } catch {
        // Non-JSON 2xx response — wrap in TodylError.
        //
        // The body is NEVER echoed. A truncated 200 (chunked response cut by a
        // proxy) is the common cause, and a deployment-group body cut mid-JSON
        // begins `{"data":[{"id":"g1",…,"credentials":{"deploy_key":"…` — so a
        // preview here hands a live enrollment key to the caller, into the LLM's
        // context and durably into the gateway's audit log. `parse.ts`'s scrub
        // never runs on this path (it operates on parsed objects), and an
        // unparseable body cannot be scrubbed structurally at all: there is no
        // safe preview to take, only a guess. Report what actually helps
        // diagnose a truncated response instead — status, size, content type.
        // The header is upstream-controlled text like any other, so it goes
        // through the same funnel — an attacker-influenced proxy could return
        // a 100 KB content-type, and this string reaches the same places the
        // body would have.
        const contentType = safeUpstreamText(response!.headers?.get('content-type')) ?? 'unknown';
        // byteLength, not .length: the latter counts UTF-16 code units, which
        // understates any multi-byte body — and the number's whole purpose is
        // to be compared against a Content-Length or a proxy's cutoff.
        const byteCount = Buffer.byteLength(body);
        throw new TodylError(
          `Todyl returned a non-JSON response (status ${response!.status}, ` +
            `${byteCount} bytes, content-type ${contentType}). The body is not echoed ` +
            'because an unparseable response cannot be scrubbed of enrollment secrets. ' +
            'A truncated or proxy-mangled response is the usual cause.',
          response!.status,
          'non_json_response',
          undefined,
          undefined
        );
      }
    },
  };
}
