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
const MAX_UPSTREAM_MESSAGE = 200;

/**
 * Sanitise a message string that came from Todyl before repeating it to the
 * caller. It reaches the LLM's context, the tool's `warning` field and the
 * gateway's audit log, so it is a secret boundary exactly like a success payload.
 *
 * `deepScrub` handles the structured case (a credentials object embedded in the
 * error envelope), but a message is free text: key-based scrubbing cannot reach
 * inside `"deploy_key=ABC123 is invalid"`. So if the text so much as mentions a
 * redacted field name, the whole message is withheld rather than echoed — the
 * status-derived guidance below is what makes these errors actionable anyway,
 * and losing a vendor sentence costs far less than leaking a live key.
 */
function safeUpstreamMessage(message: string | undefined): string | undefined {
  const text = message?.trim();
  if (!text) return undefined;
  const lowered = text.toLowerCase();
  if (REDACTED_KEYS.some((key) => lowered.includes(key))) {
    return '(message withheld — it referenced credential fields)';
  }
  return text.length > MAX_UPSTREAM_MESSAGE
    ? `${text.slice(0, MAX_UPSTREAM_MESSAGE)}… (truncated)`
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
    // test can currently distinguish its presence. The only upstream-controlled
    // text this function echoes is `error.message`, and that is free text —
    // key-based scrubbing cannot reach inside it, which is why
    // `safeUpstreamMessage` exists and is what actually holds the boundary. This
    // line matters the moment anyone echoes another envelope field; it is kept
    // so that change is safe by default rather than requiring the author to
    // remember. Removing it would not fail the suite — see the fix-wave report.
    envelope = deepScrub(JSON.parse(bodyText)) as ErrorEnvelope;
  } catch {
    // Non-JSON body; fall through with an empty envelope.
  }
  const { code, request_id: requestId, param } = envelope.error ?? {};
  const message = safeUpstreamMessage(envelope.error?.message);

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
