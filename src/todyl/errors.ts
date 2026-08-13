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

/**
 * Map a non-2xx Todyl response to an actionable error. 403 names BOTH of its
 * causes: a generic "forbidden" sends an operator to debug the wrong one.
 */
export function toTodylError(status: number, bodyText: string): TodylError {
  let envelope: ErrorEnvelope = {};
  try {
    envelope = JSON.parse(bodyText) as ErrorEnvelope;
  } catch {
    // Non-JSON body; fall through with an empty envelope.
  }
  const { code, message, request_id: requestId, param } = envelope.error ?? {};

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
