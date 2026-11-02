"""Security guards mirroring the TypeScript server (plan 7.2 / 7.6):
navigation SSRF allowlist, command allowlist + cwd containment, header redaction.
"""
from __future__ import annotations

import os
import re
from urllib.parse import urlparse

from .interpreter_guard import inline_code_reason
from .toolchains import WRAPPER_COMMANDS, is_path_escape
from .win_args import windows_launch, windows_unsafe_arg

ALLOWED_SCHEMES = {"http", "https"}
HARD_BLOCKED_HOSTS = {
    "169.254.169.254", "metadata.google.internal", "metadata.goog",
    "100.100.100.200",  # Alibaba Cloud metadata
    "168.63.129.16",    # Azure WireServer / host agent
}

# Chromium resolver rules: page-initiated requests (fetch/XHR/iframes/redirects) to these hosts can never resolve.
BLOCKED_HOST_RESOLVER_RULES = ", ".join(f"MAP {h} ~NOTFOUND" for h in sorted(HARD_BLOCKED_HOSTS))

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


def is_blocked_host(hostname: str) -> bool:
    """True for hosts that must be unreachable from any page (metadata + link-local)."""
    host = hostname.lower()
    return host in HARD_BLOCKED_HOSTS or _is_link_local(host)


def _inside(root: str, candidate: str) -> bool:
    try:
        return os.path.commonpath([candidate, root]) == root
    except ValueError:  # different drives on Windows
        return False


_SHELL_META = re.compile(r"[;&|`$(){}<>\n\r]")


def classify_command(command: str, args, cwd: str, workspace_root: str, command_allowlist):
    """Return ('blocked'|'allowlisted'|'outside', reason, resolved_cwd)."""
    cmd = (command or "").strip()
    if not cmd:
        return "blocked", "Empty command.", cwd
    if _SHELL_META.search(cmd) or any(re.search(r"[\n\r]", a) for a in args):
        return "blocked", "Command or arguments contain shell metacharacters.", cwd
    resolved = os.path.realpath(os.path.join(workspace_root, cwd or "."))
    # On Windows only .cmd/.bat shims go through cmd.exe, which interprets " % ^ even in arguments (Issues #27, #35).
    # Real executables are spawned directly: any argument is fine.
    if os.name == "nt" and windows_launch(cmd, resolved)[0] == "cmd":
        unsafe = next((u for u in map(windows_unsafe_arg, [cmd, *args]) if u), None)
        if unsafe:
            return "blocked", f"Windows: {unsafe}.", cwd
    root = os.path.realpath(workspace_root)
    if not _inside(root, resolved):
        return "blocked", f'cwd "{cwd}" resolves outside the workspace and is not allowed.', resolved
    base = os.path.basename(cmd)
    base = re.sub(r"\.(exe|cmd|bat|ps1)$", "", base, flags=re.IGNORECASE)
    if any(base.lower() == e.lower() for e in command_allowlist):
        # mvnw / gradlew are project scripts: a path to one must stay inside the workspace.
        if base.lower() in WRAPPER_COMMANDS and re.search(r"[\\/]", cmd) and is_path_escape(cmd):
            wrapper = os.path.realpath(os.path.join(resolved, cmd))
            if not _inside(root, wrapper):
                return "outside", f'Wrapper "{cmd}" resolves outside the workspace.', resolved
        # An allowlisted interpreter/toolchain running inline or remote code is NOT a dev server:
        # report it as outside the allowlist so the (default-deny) highRisk policy decides.
        reason = inline_code_reason(base, list(args))
        if reason:
            return "outside", f"{reason}. Interpreters may only run files/scripts, not inline or freshly downloaded code.", resolved
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
