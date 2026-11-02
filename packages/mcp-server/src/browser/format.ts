/**
 * Pure, dependency-free formatters that keep tool output small. Everything an
 * agent reads costs tokens on every following turn, so defaults here favour the
 * smallest output that still answers "is the page healthy / what can I click?".
 */

// ---------------------------------------------------------------- snapshots

/** Roles worth acting on. Everything else is structure the agent can skip. */
const INTERACTIVE_ROLES = new Set([
  "link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch",
  "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "treeitem", "heading", "dialog", "alert",
]);

const LINE_RE = /^(\s*)- ([a-z]+)\b(.*)$/;

/**
 * Reduces an AI-mode ARIA snapshot to a flat list of the elements an agent can
 * act on (plus headings/dialogs for orientation). Links keep their href inline
 * (`→ /p/1`). Clickable non-semantic elements (`generic … [cursor=pointer]`) are
 * kept because div-buttons are common.
 */
export function filterInteractive(snapshot: string): string {
  const lines = snapshot.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i]);
    if (!m) continue;
    const role = m[2];
    const rest = m[3];
    if (!rest.includes("[ref=")) continue;
    const clickableGeneric = !INTERACTIVE_ROLES.has(role) && rest.includes("[cursor=pointer]");
    if (!INTERACTIVE_ROLES.has(role) && !clickableGeneric) continue;
    let line = `${role}${clickableGeneric ? rest : rest.replace(" [cursor=pointer]", "")}`;
    line = line.replace(/:$/, ""); // trailing ":" only marks "has children" in the YAML tree
    if (role === "link") {
      const next = lines[i + 1]?.trim();
      if (next?.startsWith("- /url:")) line += ` → ${next.slice("- /url:".length).trim()}`;
    }
    out.push(line);
  }
  return out.join("\n");
}

export interface Truncated {
  text: string;
  truncated: boolean;
}

/** Hard cap on characters with an actionable marker (cuts at a line boundary). */
export function truncateText(text: string, max: number, hint: string): Truncated {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", max);
  const kept = text.slice(0, cut > max * 0.5 ? cut : max);
  return { text: `${kept}\n… truncated ${text.length - kept.length} chars. ${hint}`, truncated: true };
}

/**
 * Line-level diff between two snapshots of the same page. Order is ignored
 * (refs make lines unique); returns undefined when there are no changes.
 */
export function diffSnapshots(prev: string, next: string): string | undefined {
  const count = (s: string) => {
    const m = new Map<string, number>();
    for (const l of s.split("\n")) if (l.trim()) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = count(prev);
  const b = count(next);
  const removed: string[] = [];
  const added: string[] = [];
  for (const [l, n] of a) for (let i = 0; i < n - (b.get(l) ?? 0); i++) removed.push(`- ${l.trim()}`);
  for (const [l, n] of b) for (let i = 0; i < n - (a.get(l) ?? 0); i++) added.push(`+ ${l.trim()}`);
  if (!removed.length && !added.length) return undefined;
  return [...removed, ...added].join("\n");
}

// ------------------------------------------------------------------ console

export interface ConsoleLike {
  type: string;
  text: string;
  location?: string;
  epoch: number;
}

export interface ConsoleFormatOpts {
  types?: string[];
  /** Max distinct lines returned (most recent). */
  limit: number;
  origin?: string;
}

export function formatConsole(entries: ConsoleLike[], opts: ConsoleFormatOpts): string {
  const types = opts.types?.length ? new Set(opts.types.map((t) => (t === "warn" ? "warning" : t))) : undefined;
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (types && !types.has(e.type === "warn" ? "warning" : e.type)) continue;
    const loc = e.location ? `  (${stripOrigin(e.location, opts.origin)})` : "";
    const line = `[${e.type}] ${e.text}${loc}`;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const rows = [...counts].map(([l, n]) => (n > 1 ? `${l}  ×${n}` : l));
  if (!rows.length) return "(no console messages)";
  const shown = rows.slice(-opts.limit);
  const omitted = rows.length - shown.length;
  return (omitted > 0 ? `(${omitted} older distinct messages omitted; raise limit)\n` : "") + shown.join("\n");
}

// ------------------------------------------------------------------ network

export interface NetworkLike {
  method: string;
  url: string;
  status: number;
  resourceType: string;
  failure?: string;
  epoch: number;
}

export interface NetworkFormatOpts {
  failedOnly?: boolean;
  includeStatic?: boolean;
  urlContains?: string;
  limit: number;
  origin?: string;
  /** Applied to every URL before display (secret redaction). */
  redact: (url: string) => string;
}

const STATIC_TYPES = new Set(["image", "font", "stylesheet", "script", "media", "texttrack", "manifest", "other"]);

export function isFailure(e: NetworkLike): boolean {
  return !!e.failure || e.status === 0 || e.status >= 400;
}

/** Entries that pass the filters, in original order. */
export function selectNetwork(entries: NetworkLike[], opts: NetworkFormatOpts): { shown: NetworkLike[]; hiddenStatic: number } {
  let hiddenStatic = 0;
  const shown: NetworkLike[] = [];
  const needle = opts.urlContains?.toLowerCase();
  for (const e of entries) {
    const failed = isFailure(e);
    if (opts.failedOnly && !failed) continue;
    if (needle && !e.url.toLowerCase().includes(needle)) continue;
    // Static assets are noise unless they failed (a 404 script IS the bug).
    if (!opts.includeStatic && !failed && STATIC_TYPES.has(e.resourceType)) {
      hiddenStatic++;
      continue;
    }
    shown.push(e);
  }
  return { shown, hiddenStatic };
}

export function formatNetwork(entries: NetworkLike[], opts: NetworkFormatOpts): string {
  const { shown, hiddenStatic } = selectNetwork(entries, opts);
  const counts = new Map<string, number>();
  for (const e of shown) {
    const status = e.failure ? `FAILED(${e.failure})` : String(e.status);
    const url = stripOrigin(opts.redact(e.url), opts.origin);
    const line = `${e.method} ${status} ${e.resourceType} ${url}`;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const rows = [...counts].map(([l, n]) => (n > 1 ? `${l}  ×${n}` : l));
  const kept = rows.slice(-opts.limit);
  const omitted = rows.length - kept.length;
  const notes: string[] = [];
  if (omitted > 0) notes.push(`${omitted} older distinct requests omitted; raise limit`);
  if (hiddenStatic > 0) notes.push(`${hiddenStatic} static assets hidden (ok); pass includeStatic to see them`);
  const body = kept.length ? kept.join("\n") : "(no matching requests)";
  return notes.length ? `${body}\n(${notes.join("; ")})` : body;
}

function stripOrigin(url: string, origin?: string): string {
  return origin && url.startsWith(origin) ? url.slice(origin.length) || "/" : url;
}

// ------------------------------------------------------------------- health

export interface HealthInput {
  url: string;
  title: string;
  console: ConsoleLike[];
  network: NetworkLike[];
  origin?: string;
  redact: (url: string) => string;
  /** Max distinct lines listed under each section. */
  maxLines?: number;
}

/**
 * One compact "is this page healthy?" report: document status, console
 * errors/warnings, failed requests. Replaces the usual navigate + console +
 * network round-trips with a single small result.
 */
export function formatHealth(h: HealthInput): string {
  const max = h.maxLines ?? 10;
  const doc = [...h.network].reverse().find((e) => e.resourceType === "document");
  const errors = h.console.filter((e) => e.type === "error");
  const warnings = h.console.filter((e) => e.type === "warning" || e.type === "warn");
  const failed = h.network.filter(isFailure);
  const lines = [
    `URL: ${h.url}`,
    `Title: ${h.title || "(none)"}${doc ? `   Document: ${doc.failure ? `FAILED(${doc.failure})` : doc.status}` : ""}`,
    `Console: ${errors.length} error(s), ${warnings.length} warning(s)`,
  ];
  if (errors.length) lines.push(formatConsole(errors, { limit: max, origin: h.origin }));
  if (warnings.length && !errors.length) lines.push(formatConsole(warnings, { limit: Math.min(max, 3), origin: h.origin }));
  lines.push(`Network: ${failed.length} failed of ${h.network.length} request(s)`);
  if (failed.length) lines.push(formatNetwork(failed, { limit: max, origin: h.origin, includeStatic: true, redact: h.redact }));
  return lines.join("\n");
}
