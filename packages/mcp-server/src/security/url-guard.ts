/**
 * Navigation scope enforcement (plan 7.2). A browser under agent control is a
 * natural SSRF pivot, so navigation is default-deny: only http(s) to an
 * allowlisted host is permitted, and a handful of targets are hard-blocked
 * regardless of policy.
 */
export type UrlVerdict =
  /** Never allowed, even if policy would allow the category (bad scheme, metadata IP). */
  | { verdict: "blocked"; reason: string }
  /** Valid http(s) to an allowlisted host — treat as an `interact` action. */
  | { verdict: "allowlisted" }
  /** Valid http(s) but outside the allowlist — treat as a `highRisk` action. */
  | { verdict: "outside"; reason: string };

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Cloud instance metadata endpoints and always-dangerous literals. */
const HARD_BLOCKED_HOSTS = new Set([
  "169.254.169.254", // AWS/GCP/Azure IMDS
  "metadata.google.internal",
  "metadata.goog",
]);

export function classifyUrl(rawUrl: string, allowlist: string[]): UrlVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { verdict: "blocked", reason: `Not a valid URL: ${rawUrl}` };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return {
      verdict: "blocked",
      reason: `Scheme "${url.protocol}" is not allowed. Only http(s) navigation is permitted (file://, chrome://, data: etc. are blocked).`,
    };
  }

  const host = url.hostname.toLowerCase();

  if (HARD_BLOCKED_HOSTS.has(host)) {
    return {
      verdict: "blocked",
      reason: `Host "${host}" is a hard-blocked address (cloud metadata / link-local).`,
    };
  }

  // Link-local range 169.254.0.0/16 is always blocked (metadata pivot).
  if (isLinkLocalIpv4(host)) {
    return {
      verdict: "blocked",
      reason: `Host "${host}" is in the link-local range 169.254.0.0/16 and is blocked.`,
    };
  }

  if (hostMatchesAllowlist(host, allowlist)) {
    return { verdict: "allowlisted" };
  }

  const detail = isPrivateHost(host)
    ? "a private/internal address"
    : "an external address";
  return {
    verdict: "outside",
    reason: `Host "${host}" is ${detail} not in the navigation allowlist. Add it in .agent-eye/policy.json to permit it.`,
  };
}

function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const bracketless = host.replace(/^\[|\]$/g, "");
  for (const entryRaw of allowlist) {
    const entry = entryRaw.toLowerCase().replace(/^\[|\]$/g, "");
    if (!entry) continue;
    if (entry.startsWith(".")) {
      // ".example.com" matches example.com and any subdomain.
      if (bracketless === entry.slice(1) || bracketless.endsWith(entry)) return true;
    } else if (bracketless === entry) {
      return true;
    }
  }
  return false;
}

function isLinkLocalIpv4(host: string): boolean {
  const octets = parseIpv4(host);
  return octets !== null && octets[0] === 169 && octets[1] === 254;
}

/** Private/loopback ranges we treat as "internal" for messaging purposes. */
function isPrivateHost(host: string): boolean {
  const bracketless = host.replace(/^\[|\]$/g, "");
  if (bracketless === "::1" || bracketless.startsWith("fe80") || bracketless.startsWith("fc") || bracketless.startsWith("fd")) {
    return true;
  }
  const octets = parseIpv4(bracketless);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  return false;
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}
