"""Compact lab performance summary (port of browser/perf.ts, Issue #39).

The browser side is two constant scripts (observers for LCP / layout shift / long tasks installed before the page loads,
and a collector); everything else is pure. The scripts below are checked byte-for-byte against the TypeScript ones
(packages/mcp-server/tests/fixtures/perf-cases.json) so the two servers measure the same thing.

This is NOT Lighthouse: one unthrottled run on a dev server. Good for "is this slow, and why" (the LCP element, which
requests are big or slow, how many long tasks), not for scores.
"""
from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

# Installed with page.add_init_script so the observers see the whole load. Each observer is optional per engine.
PERF_INIT_SCRIPT = r'''(() => {
  const g = globalThis;
  if (g.__aePerf) return;
  const p = (g.__aePerf = { lcp: null, cls: 0, long: [] });
  const watch = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch (e) {} };
  watch('largest-contentful-paint', (e) => {
    const el = e.element;
    const cls = el && typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    p.lcp = { t: e.startTime, el: el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '') : (e.url || '') };
  });
  watch('layout-shift', (e) => { if (!e.hadRecentInput) p.cls += e.value; });
  watch('longtask', (e) => { p.long.push({ s: e.startTime, d: e.duration }); });
})();'''

# Evaluated after the load has settled.
PERF_COLLECT_SCRIPT = r'''(() => {
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
})()'''

# web.dev thresholds (TBT is the lab proxy the Lighthouse/INP guidance uses: 200 / 600 ms).
_THRESHOLDS = {"fcp": (1800, 3000), "lcp": (2500, 4000), "cls": (0.1, 0.25), "tbt": (200, 600)}
_MARK = {"good": "✓", "ni": "~", "poor": "✗"}


def rate(metric: str, value: float) -> str:
    good, poor = _THRESHOLDS[metric]
    return "good" if value <= good else "ni" if value <= poor else "poor"


def _js_round(v: float) -> int:
    """JavaScript's Math.round: halves go up (Python's round() goes to even)."""
    return int(math.floor(v + 0.5))


def _ms(v: float) -> str:
    return f"{_js_round(v)} ms"


def _kb(n: float) -> str:
    return f"{n / 1048576:.1f} MB" if n >= 1024 * 1024 else f"{max(1, _js_round(n / 1024))} KB"


def total_blocking_time(long: List[Dict[str, float]], fcp: Optional[float]) -> Dict[str, float]:
    """How far each long task that ends after FCP exceeded 50 ms."""
    after = [t for t in long if fcp is None or t["s"] + t["d"] >= fcp]
    return {
        "tbt": sum(max(0, t["d"] - 50) for t in after),
        "worst": max([0] + [t["d"] for t in after]),
        "count": len(after),
    }


def _short_url(u: str, page_url: str, max_len: int = 70) -> str:
    out = u
    try:
        p = urlparse(page_url)
        origin = f"{p.scheme}://{p.netloc}"
        if u.startswith(origin):
            out = u[len(origin):] or "/"
    except ValueError:
        pass
    out = re.sub(r"^data:[^,]{0,30},.*$", "data:…", out)
    return out if len(out) <= max_len else out[: max_len - 1] + "…"


def _cls_text(v: float) -> str:
    s = re.sub(r"0+$", "", f"{v:.3f}")
    return re.sub(r"\.$", "", s)


def format_perf(raw: Dict[str, Any], ctx: Dict[str, Any]) -> str:
    supported = raw["supported"]
    has = lambda t: t in supported  # noqa: E731
    parts: List[str] = []
    if raw["ttfb"] is not None:
        parts.append(f"TTFB {_ms(raw['ttfb'])}")
    if raw["fcp"] is not None:
        parts.append(f"FCP {_ms(raw['fcp'])} {_MARK[rate('fcp', raw['fcp'])]}")
    if has("largest-contentful-paint"):
        lcp = raw["lcp"]
        if lcp:
            el = lcp.get("el") or ""
            shown = f" ({el if len(el) <= 40 else el[:39] + '…'})" if el else ""
            parts.append(f"LCP {_ms(lcp['t'])} {_MARK[rate('lcp', lcp['t'])]}{shown}")
        else:
            parts.append("LCP none")
    if has("layout-shift") and raw["cls"] is not None:
        parts.append(f"CLS {_cls_text(raw['cls'])} {_MARK[rate('cls', raw['cls'])]}")
    if has("longtask"):
        t = total_blocking_time(raw["long"], raw["fcp"])
        count = t["count"]
        worst = f", worst {_ms(t['worst'])}" if count else ""
        parts.append(f"TBT {_ms(t['tbt'])} {_MARK[rate('tbt', t['tbt'])]} ({count} long task{'' if count == 1 else 's'}{worst})")
    if raw["dcl"] is not None:
        parts.append(f"DCL {_ms(raw['dcl'])}")
    if raw["load"] is not None and raw["load"] > 0:
        parts.append(f"load {_ms(raw['load'])}")

    resources = raw["resources"]
    total = sum(r["s"] for r in resources)
    slowest = [r for r in sorted(resources, key=lambda r: -r["d"])[:5] if r["d"] >= 50]
    largest = [r for r in sorted(resources, key=lambda r: -r["s"])[:5] if r["s"] >= 10 * 1024]
    missing = [n for t, n in (("largest-contentful-paint", "LCP"), ("layout-shift", "CLS"), ("longtask", "TBT")) if not has(t)]

    lines = [
        f"Perf {ctx['url']} ({ctx['how']}, {ctx['engine']}, cpu x{ctx['cpuSlowdown']}; one lab run, not Lighthouse)",
        " · ".join(parts),
        f"{len(resources)} requests · {_kb(total)} transferred",
    ]
    if slowest:
        lines.append("slowest: " + " · ".join(f"{_ms(r['d'])} {_short_url(r['u'], ctx['url'])}" for r in slowest))
    if largest:
        lines.append("largest: " + " · ".join(f"{_kb(r['s'])} {_short_url(r['u'], ctx['url'])}" for r in largest))
    if missing:
        lines.append(f"n/a on {ctx['engine']}: {', '.join(missing)} (use chromium for all metrics)")
    lines.append("✓ good  ~ needs work  ✗ poor (web.dev thresholds)")
    return "\n".join(lines)
