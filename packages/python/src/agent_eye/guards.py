"""Security guards mirroring the TypeScript server (plan 7.2 / 7.6):
navigation SSRF allowlist, command allowlist + cwd containment, header redaction.
"""
from __future__ import annotations

import os
import re
from urllib.parse import urlparse

ALLOWED_SCHEMES = {"http", "https"}
HARD_BLOCKED_HOSTS = {"169.254.169.254", "metadata.google.internal", "metadata.goog"}

SENSITIVE_HEADERS = {
    "authorization", "proxy-authorization", "cookie", "set-cookie",
    "x-api-key", "x-auth-token", "x-amz-security-token",
}
REDACTED = "<redacted>"


def _parse_ipv4(host: str):
    parts = host.split(".")
    if len(parts) != 4:
        return None
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    if any(n < 0 or n > 255 for n in nums):
        return None
    return nums


def _is_link_local(host: str) -> bool:
    o = _parse_ipv4(host)
    return o is not None and o[0] == 169 and o[1] == 254


def _host_matches(host: str, allowlist) -> bool:
    h = host.strip("[]").lower()
    for entry in allowlist:
        e = entry.strip("[]").lower()
        if not e:
            continue
        if e.startswith("."):
            if h == e[1:] or h.endswith(e):
                return True
        elif h == e:
            return True
    return False


def classify_url(raw_url: str, allowlist):
    """Return ('blocked'|'allowlisted'|'outside', reason)."""
    try:
        u = urlparse(raw_url)
    except Exception:
        return "blocked", f"Not a valid URL: {raw_url}"
    if u.scheme not in ALLOWED_SCHEMES:
        return "blocked", (
            f'Scheme "{u.scheme}:" is not allowed. Only http(s) navigation is permitted.'
        )
    host = (u.hostname or "").lower()
    if host in HARD_BLOCKED_HOSTS:
        return "blocked", f'Host "{host}" is a hard-blocked address (cloud metadata / link-local).'
    if _is_link_local(host):
        return "blocked", f'Host "{host}" is in the link-local range 169.254.0.0/16 and is blocked.'
    if _host_matches(host, allowlist):
        return "allowlisted", ""
    return "outside", (
        f'Host "{host}" is not in the navigation allowlist. '
        f"Add it to the policy to permit it."
    )


_SHELL_META = re.compile(r"[;&|`$(){}<>\n\r]")


def classify_command(command: str, args, cwd: str, workspace_root: str, command_allowlist):
    """Return ('blocked'|'allowlisted'|'outside', reason, resolved_cwd)."""
    cmd = (command or "").strip()
    if not cmd:
        return "blocked", "Empty command.", cwd
    if _SHELL_META.search(cmd) or any(re.search(r"[\n\r]", a) for a in args):
        return "blocked", "Command or arguments contain shell metacharacters.", cwd
    resolved = os.path.realpath(os.path.join(workspace_root, cwd or "."))
    root = os.path.realpath(workspace_root)
    if os.path.commonpath([resolved, root]) != root:
        return "blocked", f'cwd "{cwd}" resolves outside the workspace and is not allowed.', resolved
    base = os.path.basename(cmd)
    base = re.sub(r"\.(exe|cmd|bat|ps1)$", "", base, flags=re.IGNORECASE)
    if any(base.lower() == e.lower() for e in command_allowlist):
        return "allowlisted", "", resolved
    return "outside", f'Command "{base}" is not in the allowlist.', resolved


def redact_headers(headers: dict, enabled: bool) -> dict:
    if not enabled:
        return dict(headers)
    return {k: (REDACTED if k.lower() in SENSITIVE_HEADERS else v) for k, v in headers.items()}


def redact_text(text: str, enabled: bool) -> str:
    if not enabled:
        return text
    return re.sub(
        r"\b(access_token|token|api[_-]?key|password|secret)=([^&\s\"']+)",
        lambda m: f"{m.group(1)}={REDACTED}",
        text,
        flags=re.IGNORECASE,
    )
