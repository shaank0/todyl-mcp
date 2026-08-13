import { deepScrub, REDACTED_KEYS } from './parse.js';

export class TodylError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
    readonly param?: string
  ) {
    super(message);
    this.name = 'TodylError';
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; request_id?: string; param?: string };
}

/** Upstream text is free-form; cap it so a body dump can't ride out in an error. */
const MAX_UPSTREAM_TEXT = 200;

/**
 * Sanitise ANY upstream-controlled text before repeating it to the caller.
 *
 * The invariant is not "scrub the message" — it is **no upstream-controlled
 * text reaches a caller unscrubbed**. Stating it as a field-specific rule is
 * what let this leak twice: the first fix covered the response *body*, and
 * `error.message` turned out to be one of four such channels (`message`,
 * `param`, `request_id`, and the response's `content-type`). Every one of them
 * lands in the LLM's context, in a tool's `warning` field via `staleWarning`,
 * and durably in the gateway's audit log. So this is a single funnel that every
 * such value must pass through, rather than a check applied per site.
 *
 * Three jobs, in order:
 *  1. Coerce. Todyl's JSON is untrusted shape as well as untrusted content —
 *     `{"error":{"message":42}}` is well-formed JSON, and calling `.trim()` on
 *     a number threw a TypeError *out of* this mapper, turning a clean 400 into
 *     a status-0 section error.
 *  2. Withhold. `deepScrub` handles structured secrets, but these are free
 *     text and key-based scrubbing cannot reach inside `"deploy_key=ABC123"`.
 *     If the text so much as mentions a redacted field name, the whole value is
 *     dropped: the status-derived guidance is what makes these errors
 *     actionable anyway, and losing a vendor sentence costs far less than
 *     leaking a live enrollment key.
 *  3. Cap. A 100 KB `param` is a body dump wearing a different field name.
 */
export function safeUpstreamText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const lowered = text.toLowerCase();
  if (REDACTED_KEYS.some((key) => lowered.includes(key))) {
    return '(withheld — referenced credential fields)';
  }
  return text.length > MAX_UPSTREAM_TEXT
    ? `${text.slice(0, MAX_UPSTREAM_TEXT)}… (truncated)`
    : text;
}

/**
 * Map a non-2xx Todyl response to an actionable error. 403 names BOTH of its
 * causes: a generic "forbidden" sends an operator to debug the wrong one.
 */
export function toTodylError(status: number, bodyText: string): TodylError {
  let envelope: ErrorEnvelope = {};
  try {
    // deepScrub first: if Todyl's error envelope echoes back a resource that
    // carries enrollment secrets, they are gone before any field is read.
    //
    // Honest scope: this is defence-in-depth, NOT load-bearing today, and no
    // test can currently distinguish its presence — every field this function
    // reads is separately funnelled through `safeUpstreamText`, which is what
    // actually holds the boundary. This line matters the moment anyone reads a
    // field that isn't, so that change is safe by default. Removing it does not
    // fail the suite; see the fix-wave report.
    envelope = deepScrub(JSON.parse(bodyText)) as ErrorEnvelope;
  } catch {
    // Non-JSON body; fall through with an empty envelope.
  }

  // EVERY upstream-controlled field this function echoes is listed here, and
  // every one goes through `safeUpstreamText` — `message` in the 400/default
  // branches, `param` in the 400 branch, `request_id` in the trailing support
  // hint. `code` is not echoed into the text but is sanitised anyway, because
  // it is stored on the error and the next person to echo a field should not
  // have to notice this distinction. If you add a field to this destructure,
  // it goes through the funnel too.
  const raw = envelope.error ?? {};
  const code = safeUpstreamText(raw.code);
  const requestId = safeUpstreamText(raw.request_id);
  const param = safeUpstreamText(raw.param);
  const message = safeUpstreamText(raw.message);

  let text: string;
  if (status === 401) {
    text =
      'Todyl rejected the credentials (401). The token may be wrong, deactivated, ' +
      'or past its expiry — check it in the Todyl portal under Account → Developer APIs.';
  } else if (status === 403) {
    text =
      'Todyl refused the request (403). There are two possible causes: (1) this ' +
      "server's source IP is not on the allowed-source-IPs list, or (2) the token's " +
      'ACL does not grant read on this resource. Both are fixed in the Todyl portal ' +
      'under Account → Developer APIs — check Manage Allowed Source IPs first, then ' +
      "the token's ACL entries.";
  } else if (status === 400) {
    text = `Todyl rejected the request as invalid (400)${param ? ` — parameter "${param}"` : ''}${
      message ? `: ${message}` : '.'
    }`;
  } else {
    text = `Todyl returned ${status}${message ? `: ${message}` : '.'}`;
  }

  if (requestId) text += ` (Todyl request_id ${requestId} — quote this to Todyl support.)`;
  return new TodylError(text, status, code, requestId, param);
}
