/**
 * Turns raw errors into owner-safe diagnostics: what happened, what to do next, and whether a retry can help.
 * Nothing returned from here may contain credentials, message content, or provider response bodies.
 */
export interface Diagnosis {
  code: string;
  message: string;
  action: string;
  retryable: boolean;
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{10,}/g, '[redacted-key]'],
  [/\bya29\.[A-Za-z0-9._-]+/g, '[redacted-token]'],
  [/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[redacted-token]'],
  [/\b(access_token|refresh_token|id_token|client_secret|api[_-]?key|authorization|password)(["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi, '$1$2[redacted]'],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[redacted-bot-token]'],
  [/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]']
];

/** Strips anything that looks like a credential. Safe to call on any string headed for logs or the UI. */
export function redact(value: string, maxLength = 400): string {
  let output = value;
  for (const [pattern, replacement] of REDACTIONS) output = output.replace(pattern, replacement);
  output = output.replace(/\s+/g, ' ').trim();
  return output.length > maxLength ? `${output.slice(0, maxLength)}…` : output;
}

const RULES: Array<{ test: RegExp; diagnosis: Diagnosis }> = [
  {
    test: /insufficient authentication scopes|missing the gmail\.(readonly|compose) scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i,
    diagnosis: { code: 'gmail_scope', message: 'Gmail permission is incomplete for this action.', action: 'Open Connections, choose the Gmail access level you want, and approve the Google consent screen again.', retryable: false }
  },
  {
    test: /invalid_grant|unauthorized_client|invalid_client|token has been expired or revoked/i,
    diagnosis: { code: 'gmail_auth', message: 'Google no longer accepts this connection.', action: 'Open Connections, disconnect the account, and connect it again.', retryable: false }
  },
  {
    test: /quota exceeded|rate limit|user-rate-limit|too many requests|\b429\b/i,
    diagnosis: { code: 'rate_limited', message: 'The provider temporarily limited requests.', action: 'Orbit will retry automatically. If this repeats, lower Messages per sync in Settings.', retryable: true }
  },
  {
    test: /AI provider|ChatGPT|OpenAI|Anthropic|model .* not|inference failed/i,
    diagnosis: { code: 'ai_provider', message: 'The selected AI provider could not complete the request.', action: 'Check Settings → Intelligence engine, verify the provider, or switch to Private rules.', retryable: true }
  },
  {
    test: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i,
    diagnosis: { code: 'network', message: 'A network call failed.', action: 'Orbit will retry automatically. If it keeps failing, check the provider status page and your hosting network.', retryable: true }
  },
  {
    test: /database|postgres|connection terminated|too many clients|deadlock/i,
    diagnosis: { code: 'database', message: 'The database was unavailable or rejected the operation.', action: 'Check the Postgres service on your host. Orbit will retry automatically.', retryable: true }
  },
  {
    test: /not found|404/i,
    diagnosis: { code: 'not_found', message: 'The item no longer exists at the provider.', action: 'Refresh the source and try again; the original item may have been deleted or moved.', retryable: false }
  }
];

export class ActionableError extends Error {
  constructor(
    message: string,
    readonly options: { action?: string; retryable?: boolean; code?: string } = {}
  ) {
    super(message);
    this.name = 'ActionableError';
  }
}

export function diagnose(error: unknown): Diagnosis {
  if (error instanceof ActionableError) {
    return {
      code: error.options.code ?? 'action_failed',
      message: redact(error.message),
      action: error.options.action ?? 'Review the details and try again.',
      retryable: error.options.retryable ?? false
    };
  }
  const text = error instanceof Error ? `${error.name} ${error.message}` : typeof error === 'string' ? error : '';
  const hit = RULES.find((rule) => rule.test.test(text));
  if (hit) return hit.diagnosis;
  return { code: 'unexpected', message: 'Something unexpected went wrong.', action: 'Open Runs for the sanitized details. If it repeats, check your deployment logs.', retryable: true };
}

/** Logs an error with credentials removed. Use instead of console.error(error) near provider code. */
export function logSafe(label: string, error: unknown): void {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[orbit] ${label}: ${redact(text, 600)}`);
}
