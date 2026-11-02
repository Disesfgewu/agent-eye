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

/** `- role "name" [ref=e1]:` -> `role "name"` (what a human would call the node; no attributes/refs). */
function label(role: string, rest: string): string {
  const name = /^\s*("(?:[^"\\]|\\.)*")/.exec(rest)?.[1];
  return name ? `${role} ${name}` : role;
}

/**
 * Keeps the first `depth` levels of the tree (1 = top level only). A node whose children were cut
 * gets a marker with the node count and the ref to expand it (`selector=eN`), so the agent can drill
 * down instead of paying for the whole page.
 */
export function limitDepth(snapshot: string, depth: number): string {
  const lines = snapshot.split("\n");
  const level = (l: string) => Math.floor((/^ */.exec(l)?.[0].length ?? 0) / 2);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (level(l) >= depth) continue;
    if (level(l) === depth - 1 && LINE_RE.test(l)) {
      let nodes = 0;
      for (let j = i + 1; j < lines.length && level(lines[j]) > level(l); j++) if (LINE_RE.test(lines[j]) && !lines[j].trim().startsWith("- /")) nodes++;
      if (nodes > 0) {
        const ref = /\[ref=(e\d+)\]/.exec(l)?.[1];
        out.push(`${l.replace(/:$/, "")} …(+${nodes} nodes${ref ? `, expand: selector=${ref}` : ""})`);
        continue;
      }
    }
    out.push(l);
  }
  return out.join("\n");
}

/**
 * Elements whose role or text contains `query` (case-insensitive), each with the labels of its
 * ancestors (`main > form "Checkout" > button "Pay now" [ref=e41]`), so one control on a big page
 * costs a line or two instead of the whole tree.
 */
export function findInSnapshot(snapshot: string, query: string, limit = 20): string {
  const q = query.trim().toLowerCase();
  if (!q) return "(empty find query)";
  const lines = snapshot.split("\n");
  const stack: Array<{ level: number; label: string }> = [];
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i]);
    if (!m) continue;
    const lvl = Math.floor(m[1].length / 2);
    while (stack.length && stack[stack.length - 1].level >= lvl) stack.pop();
    const [, , role, rest] = m;
    if (`${role}${rest}`.toLowerCase().includes(q) && rest.includes("[ref=")) {
      let line = `${role}${rest.replace(" [cursor=pointer]", "").replace(/:$/, "")}`;
      const next = lines[i + 1]?.trim();
      if (role === "link" && next?.startsWith("- /url:")) line += ` → ${next.slice("- /url:".length).trim()}`;
      hits.push([...stack.map((s) => s.label), line].join(" > "));
    }
    stack.push({ level: lvl, label: label(role, rest) });
  }
  if (!hits.length) return `(no elements match "${query}")`;
  const shown = hits.slice(0, limit);
  return shown.join("\n") + (hits.length > shown.length ? `\n… ${hits.length - shown.length} more matches; refine the query` : "");
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
