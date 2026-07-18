/**
 * Permission model (plan 7.1). Every tool action is classified into an
 * ActionCategory; the policy maps each category to a Decision. Enforcement
 * happens server-side inside the tool handlers — never by asking the agent to
 * behave. A prompt-injected agent still cannot exceed these decisions.
 */
export type ActionCategory =
  /** Read-only observation: snapshot, screenshot, console/network/dev-server logs. */
  | "observe"
  /** Page interaction without persistent side effects: navigate/click/type/reload within scope. */
  | "interact"
  /** Interaction with side effects: form submit, downloads, dialogs. */
  | "sideEffect"
  /** Process execution: starting/stopping dev servers (allowlisted commands). */
  | "execute"
  /** High risk: arbitrary JS injection (evaluate), non-allowlisted commands/domains. */
  | "highRisk";

export type Decision = "allow" | "ask" | "deny";

export interface Policy {
  /** Schema version, for forward-compatible migrations. */
  version: number;
  /** Per-category authorization. */
  categories: Record<ActionCategory, Decision>;
  /**
   * Hostnames the browser may navigate to. Matched case-insensitively against
   * the URL host; an entry may be an exact host or a leading-dot suffix
   * (".example.com" matches sub.example.com). Defaults to localhost only.
   */
  navigationAllowlist: string[];
  /** Executables `start_dev_server` may launch (argv[0], basename-matched). */
  commandAllowlist: string[];
  /** Redact Authorization/Cookie-style headers from network artifacts (plan 7.6). */
  redactSensitiveHeaders: boolean;
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  categories: {
    observe: "allow",
    interact: "allow",
    sideEffect: "ask",
    execute: "ask",
    highRisk: "deny",
  },
  navigationAllowlist: ["localhost", "127.0.0.1", "[::1]"],
  commandAllowlist: [
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "node",
    "npx",
    "deno",
    "vite",
    "next",
    "nuxt",
    "ng",
    "webpack",
    "rollup",
    "parcel",
    "astro",
    "remix",
    "svelte-kit",
  ],
  redactSensitiveHeaders: true,
};
