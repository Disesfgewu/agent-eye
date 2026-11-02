/**
 * Compact lab performance summary (Issue #39). The browser side is two constant scripts (observers
 * for LCP / layout shift / long tasks installed before the page loads, and a collector); everything
 * else is pure so it is unit-tested without a browser. The result is a handful of lines instead of a
 * raw trace (tens of thousands of tokens).
 *
 * This is NOT Lighthouse: one unthrottled run on a dev server. Good for "is this slow, and why"
 * (what is the LCP element, which requests are big/slow, how many long tasks), not for scores.
 */

/** Installed with page.addInitScript so the observers see the whole load. Each observer is optional per engine. */
export const PERF_INIT_SCRIPT = `(() => {
  const g = globalThis;
  if (g.__aePerf) return;
  const p = (g.__aePerf = { lcp: null, cls: 0, long: [] });
  const watch = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch (e) {} };
  watch('largest-contentful-paint', (e) => {
    const el = e.element;
    const cls = el && typeof el.className === 'string' ? el.className.trim().split(/\\s+/)[0] : '';
    p.lcp = { t: e.startTime, el: el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '') : (e.url || '') };
  });
  watch('layout-shift', (e) => { if (!e.hadRecentInput) p.cls += e.value; });
  watch('longtask', (e) => { p.long.push({ s: e.startTime, d: e.duration }); });
})();`;

/** Evaluated after the load has settled. */
export const PERF_COLLECT_SCRIPT = `(() => {
  const p = globalThis.__aePerf || {};
  const nav = performance.getEntriesByType('navigation')[0];
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  return {
    ttfb: nav ? nav.responseStart : null,
    dcl: nav ? nav.domContentLoadedEventEnd : null,
    load: nav ? nav.loadEventEnd : null,
    fcp: fcp ? fcp.startTime : null,
    lcp: p.lcp || null,
    cls: typeof p.cls === 'number' ? p.cls : null,
    long: p.long || [],
    supported: (PerformanceObserver.supportedEntryTypes || []).slice(),
    resources: performance.getEntriesByType('resource').map((r) => ({ u: r.name, d: r.duration, s: r.transferSize || r.encodedBodySize || 0 })),
  };
})()`;

export interface RawPerf {
  ttfb: number | null;
  dcl: number | null;
  load: number | null;
  fcp: number | null;
  lcp: { t: number; el: string } | null;
  cls: number | null;
  long: Array<{ s: number; d: number }>;
  supported: string[];
  resources: Array<{ u: string; d: number; s: number }>;
}

export interface PerfContext {
  url: string;
  how: "reloaded" | "navigated";
  engine: string;
  cpuSlowdown: number;
}

type Rating = "good" | "ni" | "poor";

/** web.dev thresholds (TBT is the lab proxy the Lighthouse/INP guidance uses: 200 / 600 ms). */
const THRESHOLDS = {
  fcp: [1800, 3000],
  lcp: [2500, 4000],
  cls: [0.1, 0.25],
  tbt: [200, 600],
} as const;

export function rate(metric: keyof typeof THRESHOLDS, value: number): Rating {
  const [good, poor] = THRESHOLDS[metric];
  return value <= good ? "good" : value <= poor ? "ni" : "poor";
}

const MARK: Record<Rating, string> = { good: "✓", ni: "~", poor: "✗" };
const ms = (v: number) => `${Math.round(v)} ms`;
const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Total blocking time: how far each long task after FCP exceeded 50 ms. */
export function totalBlockingTime(long: RawPerf["long"], fcp: number | null): { tbt: number; worst: number; count: number } {
  const after = long.filter((t) => fcp === null || t.s + t.d >= fcp);
  return {
    tbt: after.reduce((n, t) => n + Math.max(0, t.d - 50), 0),
    worst: after.reduce((n, t) => Math.max(n, t.d), 0),
    count: after.length,
  };
}

function shortUrl(u: string, pageUrl: string, max = 70): string {
  let out = u;
  try {
    const origin = new URL(pageUrl).origin;
    if (u.startsWith(origin)) out = u.slice(origin.length) || "/";
  } catch {
    /* keep the full URL */
  }
  out = out.replace(/^data:[^,]{0,30},.*$/, "data:…");
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

export function formatPerf(raw: RawPerf, ctx: PerfContext): string {
  const has = (t: string) => raw.supported.includes(t);
  const parts: string[] = [];
  if (raw.ttfb !== null) parts.push(`TTFB ${ms(raw.ttfb)}`);
  if (raw.fcp !== null) parts.push(`FCP ${ms(raw.fcp)} ${MARK[rate("fcp", raw.fcp)]}`);
  if (has("largest-contentful-paint")) {
    parts.push(raw.lcp ? `LCP ${ms(raw.lcp.t)} ${MARK[rate("lcp", raw.lcp.t)]}${raw.lcp.el ? ` (${raw.lcp.el.length > 40 ? `${raw.lcp.el.slice(0, 39)}…` : raw.lcp.el})` : ""}` : "LCP none");
  }
  if (has("layout-shift") && raw.cls !== null) parts.push(`CLS ${raw.cls.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")} ${MARK[rate("cls", raw.cls)]}`);
  if (has("longtask")) {
    const t = totalBlockingTime(raw.long, raw.fcp);
    parts.push(`TBT ${ms(t.tbt)} ${MARK[rate("tbt", t.tbt)]} (${t.count} long task${t.count === 1 ? "" : "s"}${t.count ? `, worst ${ms(t.worst)}` : ""})`);
  }
  if (raw.dcl !== null) parts.push(`DCL ${ms(raw.dcl)}`);
  if (raw.load !== null && raw.load > 0) parts.push(`load ${ms(raw.load)}`);

  const total = raw.resources.reduce((n, r) => n + r.s, 0);
  const slowest = [...raw.resources].sort((a, b) => b.d - a.d).slice(0, 5).filter((r) => r.d >= 50);
  const largest = [...raw.resources].sort((a, b) => b.s - a.s).slice(0, 5).filter((r) => r.s >= 10 * 1024);
  const missing = [
    ["largest-contentful-paint", "LCP"],
    ["layout-shift", "CLS"],
    ["longtask", "TBT"],
  ].filter(([t]) => !has(t)).map(([, n]) => n);

  const lines = [
    `Perf ${ctx.url} (${ctx.how}, ${ctx.engine}, cpu x${ctx.cpuSlowdown}; one lab run, not Lighthouse)`,
    parts.join(" · "),
    `${raw.resources.length} requests · ${kb(total)} transferred`,
  ];
  if (slowest.length) lines.push(`slowest: ${slowest.map((r) => `${ms(r.d)} ${shortUrl(r.u, ctx.url)}`).join(" · ")}`);
  if (largest.length) lines.push(`largest: ${largest.map((r) => `${kb(r.s)} ${shortUrl(r.u, ctx.url)}`).join(" · ")}`);
  if (missing.length) lines.push(`n/a on ${ctx.engine}: ${missing.join(", ")} (use chromium for all metrics)`);
  lines.push("✓ good  ~ needs work  ✗ poor (web.dev thresholds)");
  return lines.join("\n");
}
