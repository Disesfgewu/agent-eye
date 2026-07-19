/**
 * Sensitive-data redaction for network artifacts (plan 7.6). Screenshots and
 * logs land in .agent-artifacts/ and may be read back into a model context or
 * shared, so auth material is stripped by default.
 */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-amz-security-token",
]);

const REDACTED = "<redacted>";

export function redactHeaders(
  headers: Record<string, string>,
  enabled: boolean
): Record<string, string> {
  if (!enabled) return headers;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

/**
 * Best-effort redaction of bearer-token / key-like substrings in free text
 * (e.g. a URL query string carrying access_token=...). Conservative: only
 * targets well-known parameter names to avoid mangling legitimate content.
 */
export function redactText(text: string, enabled: boolean): string {
  if (!enabled) return text;
  return text.replace(
    /\b(access_token|token|api[_-]?key|password|secret)=([^&\s"']+)/gi,
    (_m, key: string) => `${key}=${REDACTED}`
  );
}
