"""Browser engine / viewport / device / CDP selection (port of browser/engine.ts, Issues #5 and #40).

Pure helpers so the rules are unit-tested without launching a browser, and checked against golden cases computed from the
TypeScript reference (packages/mcp-server/tests/fixtures/engine-cases.json).
"""
from __future__ import annotations

import re
from typing import Any, Dict, Mapping, Optional
from urllib.parse import urlsplit

ENGINES = ("chromium", "firefox", "webkit")
DEFAULT_VIEWPORT = {"width": 1280, "height": 800}


def parse_engine(value: Optional[str]) -> str:
    v = (value or "").strip().lower()
    if not v:
        return "chromium"
    if v in ENGINES:
        return v
    raise ValueError(f'AGENT_EYE_BROWSER="{value}" is not supported. Use one of: {", ".join(ENGINES)}.')


def parse_viewport(value: Optional[str]) -> Optional[Dict[str, int]]:
    """"1280x800" -> {width, height}; None when unset; raises on malformed / out-of-range values."""
    if value is None or value.strip() == "":
        return None
    m = re.fullmatch(r"(\d{3,4})x(\d{3,4})", value.strip(), re.IGNORECASE | re.ASCII)
    width = int(m.group(1)) if m else 0
    height = int(m.group(2)) if m else 0
    if not m or width < 200 or width > 3840 or height < 200 or height > 2400:
        raise ValueError(f'AGENT_EYE_VIEWPORT="{value}" is invalid. Use WIDTHxHEIGHT, e.g. 1280x800 (200–3840 x 200–2400).')
    return {"width": width, "height": height}


def resolve_device(devices: Mapping[str, Mapping[str, Any]], name: str, engine: str) -> Dict[str, Any]:
    """Looks a device up by name (case-insensitive) in a Playwright-style descriptor table (camelCase keys, as in the
    TypeScript server; see browser.py for the conversion from Playwright's Python table). ``isMobile`` is dropped for
    Firefox, which rejects it."""
    wanted = name.strip().lower()
    key = next((k for k in devices if k.lower() == wanted), None)
    if key is None:
        first = re.split(r"\s+", wanted)[0]
        near = [k for k in devices if first in k.lower()][:6]
        raise ValueError(
            f'AGENT_EYE_DEVICE="{name}" is not a known Playwright device.'
            + (f" Similar: {', '.join(near)}." if near else " See https://playwright.dev/docs/emulation#devices.")
        )
    d = devices[key]
    out: Dict[str, Any] = {
        "userAgent": d.get("userAgent"), "viewport": d.get("viewport"),
        "deviceScaleFactor": d.get("deviceScaleFactor"), "hasTouch": d.get("hasTouch"),
    }
    if engine != "firefox":
        out["isMobile"] = d.get("isMobile")
    return out


def launch_error_hint(engine: str, err: BaseException, install_command: str = "npx playwright install") -> Optional[Exception]:
    """Turns Playwright's "Executable doesn't exist" into an actionable install hint."""
    if re.search(r"Executable doesn't exist|browserType\.launch.*install", str(err), re.IGNORECASE):
        return RuntimeError(f"The {engine} browser is not installed. Run: {install_command} {engine}")
    return None


_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}


def parse_cdp_url(value: Optional[str]) -> Optional[str]:
    """AGENT_EYE_CDP_URL: attach to a Chromium you started yourself with --remote-debugging-port. A CDP endpoint is full
    control of that browser, so only this machine is accepted: loopback hosts over http(s)/ws(s). None when unset."""
    raw = (value or "").strip()
    if not raw:
        return None
    scheme = re.match(r"^([A-Za-z][A-Za-z0-9+.\-]*):", raw)
    try:
        parts = urlsplit(raw)
        host = (parts.hostname or "").lower()
        parts.port  # noqa: B018 - raises ValueError for a malformed port
    except ValueError:
        scheme = None
    if not scheme:
        raise ValueError(f'AGENT_EYE_CDP_URL="{raw}" is not a valid URL. Example: http://127.0.0.1:9222')
    protocol = scheme.group(1).lower() + ":"
    if protocol not in ("http:", "https:", "ws:", "wss:"):
        raise ValueError(f'AGENT_EYE_CDP_URL must be http(s):// or ws(s)://, got "{protocol}".')
    if host not in _LOOPBACK_HOSTS:
        raise ValueError(
            f'AGENT_EYE_CDP_URL must point at this machine (localhost, 127.0.0.1 or [::1]); got host "{host}". '
            "A remote debugging endpoint hands over complete control of that browser."
        )
    return raw


def cdp_incompatibility(env: Mapping[str, str], channel: Optional[str]) -> Optional[str]:
    """Settings that make no sense (or would be unsafe) on a browser Agent Eye did not launch."""
    engine = (env.get("AGENT_EYE_BROWSER") or "").strip().lower()
    if engine and engine != "chromium":
        return f"AGENT_EYE_BROWSER={engine} cannot be combined with AGENT_EYE_CDP_URL (CDP is Chromium-only)."
    if channel:
        return "AGENT_EYE_BROWSER_CHANNEL cannot be combined with AGENT_EYE_CDP_URL (the browser is already running)."
    if (env.get("AGENT_EYE_DEVICE") or "").strip():
        return "AGENT_EYE_DEVICE cannot be combined with AGENT_EYE_CDP_URL (device emulation needs a context Agent Eye creates); use AGENT_EYE_VIEWPORT."
    return None
