"""Compact, token-lean output formatters (port of browser/format.ts, Issues #2, #36).

Pure and dependency-free. Everything an agent reads costs tokens on every following turn, so
defaults favour the smallest output that still answers "is the page healthy / what can I click?".

Keep in lock-step with the TypeScript implementation: both run the golden cases in
packages/mcp-server/tests/fixtures/format-cases.json. One known difference: lengths are Python code
points, TypeScript counts UTF-16 units (only visible for characters outside the BMP, e.g. emoji).
"""
from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional

# ---------------------------------------------------------------- snapshots

# Roles worth acting on. Everything else is structure the agent can skip.
INTERACTIVE_ROLES = {
    "link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch",
    "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "treeitem", "heading", "dialog", "alert",
}

_LINE_RE = re.compile(r"^(\s*)- ([a-z]+)\b(.*)$")
# Element handles look like `e12`; newer Playwright prefixes the frame (`f1e12`) once several pages/frames are involved.
_REF_PATTERN = r"(?:f\d+)?e\d+"
_REF_RE = re.compile(rf"\[ref=({_REF_PATTERN})\]")


def parse_ref(target: str) -> Optional[str]:
    """`e12`, `ref=e12`, `aria-ref=f1e12` -> the bare handle; None when `target` is a selector."""
    m = re.match(rf"^(?:ref=|aria-ref=)?({_REF_PATTERN})$", target.strip())
    return m.group(1) if m else None


def filter_interactive(snapshot: str) -> str:
    """Flat list of the elements an agent can act on (plus headings/dialogs); links keep their href inline."""
    lines = snapshot.split("\n")
    out: List[str] = []
    for i, raw in enumerate(lines):
        m = _LINE_RE.match(raw)
        if not m:
            continue
        role, rest = m.group(2), m.group(3)
        if "[ref=" not in rest:
            continue
        clickable_generic = role not in INTERACTIVE_ROLES and "[cursor=pointer]" in rest
        if role not in INTERACTIVE_ROLES and not clickable_generic:
            continue
        line = role + (rest if clickable_generic else rest.replace(" [cursor=pointer]", "", 1))
        line = re.sub(r":$", "", line, count=1)  # trailing ":" only marks "has children" in the YAML tree
        if role == "link" and i + 1 < len(lines):
            nxt = lines[i + 1].strip()
            if nxt.startswith("- /url:"):
                line += " → " + nxt[len("- /url:"):].strip()
        out.append(line)
    return "\n".join(out)


def _label(role: str, rest: str) -> str:
    m = re.match(r'^\s*("(?:[^"\\]|\\.)*")', rest)
    return f"{role} {m.group(1)}" if m else role


def limit_depth(snapshot: str, depth: int) -> str:
    """Keep the first `depth` levels; cut subtrees get a node count and the ref to expand them."""
    lines = snapshot.split("\n")

    def level(line: str) -> int:
        return (len(line) - len(line.lstrip(" "))) // 2

    out: List[str] = []
    for i, line in enumerate(lines):
        if level(line) >= depth:
            continue
        if level(line) == depth - 1 and _LINE_RE.match(line):
            nodes = 0
            j = i + 1
            while j < len(lines) and level(lines[j]) > level(line):
                if _LINE_RE.match(lines[j]) and not lines[j].strip().startswith("- /"):
                    nodes += 1
                j += 1
            if nodes > 0:
                ref = _REF_RE.search(line)
                out.append(f"{re.sub(r':$', '', line, count=1)} …(+{nodes} nodes{', expand: selector=' + ref.group(1) if ref else ''})")
                continue
        out.append(line)
    return "\n".join(out)


def find_in_snapshot(snapshot: str, query: str, limit: int = 20) -> str:
    """Elements whose role/text contains `query`, each with the labels of its ancestors."""
    q = query.strip().lower()
    if not q:
        return "(empty find query)"
    lines = snapshot.split("\n")
    stack: List[Dict[str, Any]] = []
    hits: List[str] = []
    for i, raw in enumerate(lines):
        m = _LINE_RE.match(raw)
        if not m:
            continue
        lvl = len(m.group(1)) // 2
        while stack and stack[-1]["level"] >= lvl:
            stack.pop()
        role, rest = m.group(2), m.group(3)
        if q in f"{role}{rest}".lower() and "[ref=" in rest:
            line = role + re.sub(r":$", "", rest.replace(" [cursor=pointer]", "", 1), count=1)
            nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if role == "link" and nxt.startswith("- /url:"):
                line += " → " + nxt[len("- /url:"):].strip()
            hits.append(" > ".join([s["label"] for s in stack] + [line]))
        stack.append({"level": lvl, "label": _label(role, rest)})
    if not hits:
        return f'(no elements match "{query}")'
    shown = hits[:limit]
    extra = f"\n… {len(hits) - len(shown)} more matches; refine the query" if len(hits) > len(shown) else ""
    return "\n".join(shown) + extra


def truncate_text(text: str, max_chars: int, hint: str) -> Dict[str, Any]:
    """Hard cap on characters with an actionable marker (cuts at a line boundary)."""
    if len(text) <= max_chars:
        return {"text": text, "truncated": False}
    cut = text.rfind("\n", 0, max_chars + 1)
    kept = text[: cut if cut > max_chars * 0.5 else max_chars]
    return {"text": f"{kept}\n… truncated {len(text) - len(kept)} chars. {hint}", "truncated": True}


def diff_snapshots(prev: str, nxt: str) -> Optional[str]:
    """Line-level diff of two snapshots of the same page (order ignored); None when nothing changed."""
    def count(s: str) -> Dict[str, int]:
        m: Dict[str, int] = {}
        for line in s.split("\n"):
            if line.strip():
                m[line] = m.get(line, 0) + 1
        return m

    a, b = count(prev), count(nxt)
    removed = [f"- {line.strip()}" for line, n in a.items() for _ in range(max(0, n - b.get(line, 0)))]
    added = [f"+ {line.strip()}" for line, n in b.items() for _ in range(max(0, n - a.get(line, 0)))]
    if not removed and not added:
        return None
    return "\n".join(removed + added)


# ------------------------------------------------------------------ console

def _strip_origin(url: str, origin: Optional[str]) -> str:
    return (url[len(origin):] or "/") if origin and url.startswith(origin) else url


def format_console(entries: List[Dict[str, Any]], opts: Dict[str, Any]) -> str:
    wanted = {("warning" if t == "warn" else t) for t in opts["types"]} if opts.get("types") else None
    counts: Dict[str, int] = {}
    for e in entries:
        kind = "warning" if e["type"] == "warn" else e["type"]
        if wanted is not None and kind not in wanted:
            continue
        loc = f"  ({_strip_origin(e['location'], opts.get('origin'))})" if e.get("location") else ""
        line = f"[{e['type']}] {e['text']}{loc}"
        counts[line] = counts.get(line, 0) + 1
    rows = [f"{line}  ×{n}" if n > 1 else line for line, n in counts.items()]
    if not rows:
        return "(no console messages)"
    shown = rows[-opts["limit"]:]
    omitted = len(rows) - len(shown)
    return (f"({omitted} older distinct messages omitted; raise limit)\n" if omitted > 0 else "") + "\n".join(shown)


# ------------------------------------------------------------------ network

_STATIC_TYPES = {"image", "font", "stylesheet", "script", "media", "texttrack", "manifest", "other"}


def is_failure(e: Dict[str, Any]) -> bool:
    return bool(e.get("failure")) or e["status"] == 0 or e["status"] >= 400


def select_network(entries: List[Dict[str, Any]], opts: Dict[str, Any]) -> Dict[str, Any]:
    hidden_static = 0
    shown: List[Dict[str, Any]] = []
    needle = (opts.get("urlContains") or "").lower() or None
    for e in entries:
        failed = is_failure(e)
        if opts.get("failedOnly") and not failed:
            continue
        if needle and needle not in e["url"].lower():
            continue
        # Static assets are noise unless they failed (a 404 script IS the bug).
        if not opts.get("includeStatic") and not failed and e["resourceType"] in _STATIC_TYPES:
            hidden_static += 1
            continue
        shown.append(e)
    return {"shown": shown, "hiddenStatic": hidden_static}


def format_network(entries: List[Dict[str, Any]], opts: Dict[str, Any]) -> str:
    """`opts["redact"]` is a callable applied to every URL before display (secret redaction)."""
    sel = select_network(entries, opts)
    redact: Callable[[str], str] = opts["redact"]
    counts: Dict[str, int] = {}
    for e in sel["shown"]:
        status = f"FAILED({e['failure']})" if e.get("failure") else str(e["status"])
        url = _strip_origin(redact(e["url"]), opts.get("origin"))
        line = f"{e['method']} {status} {e['resourceType']} {url}"
        counts[line] = counts.get(line, 0) + 1
    rows = [f"{line}  ×{n}" if n > 1 else line for line, n in counts.items()]
    kept = rows[-opts["limit"]:]
    omitted = len(rows) - len(kept)
    notes: List[str] = []
    if omitted > 0:
        notes.append(f"{omitted} older distinct requests omitted; raise limit")
    if sel["hiddenStatic"] > 0:
        notes.append(f"{sel['hiddenStatic']} static assets hidden (ok); pass includeStatic to see them")
    body = "\n".join(kept) if kept else "(no matching requests)"
    return f"{body}\n({'; '.join(notes)})" if notes else body


# ------------------------------------------------------------------- health

def format_health(h: Dict[str, Any]) -> str:
    """One compact "is this page healthy?" report: document status, console errors/warnings, failed requests."""
    max_lines = h.get("maxLines") or 10
    network = h["network"]
    doc = next((e for e in reversed(network) if e["resourceType"] == "document"), None)
    errors = [e for e in h["console"] if e["type"] == "error"]
    warnings = [e for e in h["console"] if e["type"] in ("warning", "warn")]
    failed = [e for e in network if is_failure(e)]
    document = ""
    if doc:
        document = f"   Document: {'FAILED(' + doc['failure'] + ')' if doc.get('failure') else doc['status']}"
    lines = [
        f"URL: {h['url']}",
        f"Title: {h.get('title') or '(none)'}{document}",
        f"Console: {len(errors)} error(s), {len(warnings)} warning(s)",
    ]
    origin = h.get("origin")
    if errors:
        lines.append(format_console(errors, {"limit": max_lines, "origin": origin}))
    if warnings and not errors:
        lines.append(format_console(warnings, {"limit": min(max_lines, 3), "origin": origin}))
    lines.append(f"Network: {len(failed)} failed of {len(network)} request(s)")
    if failed:
        lines.append(format_network(failed, {"limit": max_lines, "origin": origin, "includeStatic": True, "redact": h["redact"]}))
    return "\n".join(lines)
