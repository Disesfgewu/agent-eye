"""Guards for the state tools (port of security/state-guard.ts, Issue #38): set_storage (cookies / localStorage /
sessionStorage) and upload_file. Both are write-only from the agent's side: nothing reads state back into the
transcript, and values never reach logs.

Upload risk: a file the agent attaches can be sent anywhere the page decides to send it, and pages are not restricted
in where THEY connect. So uploads are limited to regular files inside the workspace (symlinks resolved first), never
anything that looks like a secret or tooling state, and are size-capped. A name-based deny list is defense in depth,
not a guarantee: the sideEffect policy still decides whether the action is allowed at all.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple, Union

MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024
MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024
MAX_UPLOAD_FILES = 10

_FORBIDDEN_DIRS = {".git", ".agent-eye", ".agent-artifacts", ".ssh", ".aws", ".gnupg", ".kube", ".docker"}
_SECRET_FILE = [re.compile(p, re.IGNORECASE) for p in (
    r"^\.env(\..*)?$", r"^\.npmrc$", r"^\.netrc$", r"^\.pypirc$", r"^\.git-credentials$",
    r"^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$", r"\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$",
    r"^credentials(\.\w+)?$", r"^secrets?\.(json|ya?ml|toml|env)$", r"^service-account.*\.json$", r"^\.htpasswd$",
)]


def _inside(root: str, candidate: str) -> bool:
    try:
        return os.path.commonpath([candidate, root]) == root
    except ValueError:  # different drives on Windows
        return False


def check_upload_path(workspace_root: str, requested: str) -> Tuple[bool, Union[str, Dict[str, Any]]]:
    """(True, {"abs", "size"}) or (False, reason)."""
    if not requested or "\0" in requested:
        return False, "empty or invalid path"
    try:
        root = os.path.realpath(workspace_root)
        real = os.path.realpath(os.path.join(workspace_root, requested))
        if not os.path.exists(real):
            raise FileNotFoundError(real)
    except OSError:
        return False, f'"{requested}" does not exist'
    if not _inside(root, real):
        return False, f'"{requested}" is outside the workspace'
    rel = os.path.relpath(real, root).split(os.sep)
    bad_dir = next((s for s in rel[:-1] if s.lower() in _FORBIDDEN_DIRS), None)
    if bad_dir:
        return False, f'files under "{bad_dir}" are never uploaded'
    base = rel[-1]
    if any(rx.search(base) for rx in _SECRET_FILE):
        return False, f'"{base}" looks like a secret/credential file'
    if not os.path.isfile(real):
        return False, f'"{requested}" is not a regular file'
    size = os.path.getsize(real)
    if size > MAX_UPLOAD_FILE_BYTES:
        return False, f'"{base}" is {size / 1048576:.1f} MB (limit {MAX_UPLOAD_FILE_BYTES // 1048576} MB per file)'
    return True, {"abs": real, "size": size}


def check_uploads(workspace_root: str, requested: List[str]) -> Tuple[bool, Union[str, List[Dict[str, Any]]]]:
    """Checks a list of upload paths together (count + total size)."""
    if not requested:
        return False, "no files given"
    if len(requested) > MAX_UPLOAD_FILES:
        return False, f"at most {MAX_UPLOAD_FILES} files per call"
    files: List[Dict[str, Any]] = []
    for r in requested:
        ok, res = check_upload_path(workspace_root, r)
        if not ok:
            return False, res  # type: ignore[return-value]
        files.append({**res, "name": os.path.basename(res["abs"])})  # type: ignore[index]
    total = sum(f["size"] for f in files)
    if total > MAX_UPLOAD_TOTAL_BYTES:
        return False, f"total {total / 1048576:.1f} MB exceeds {MAX_UPLOAD_TOTAL_BYTES // 1048576} MB"
    return True, files


# ---- storage ---------------------------------------------------------------------------

_COOKIE_NAME = re.compile(r"[\w!#$%&'*+.^`|~-]{1,128}", re.ASCII)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_MAX_COOKIES, _MAX_ENTRIES = 30, 50
_MAX_COOKIE_VALUE, _MAX_STORAGE_KEY, _MAX_STORAGE_VALUE = 4096, 128, 8192


def _json_str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def storage_input_problem(inp: Dict[str, Any]) -> Optional[str]:
    """A reason when the input is not acceptable (bad names, control characters, too large); None when fine."""
    cookies = inp.get("cookies") or []
    if len(cookies) > _MAX_COOKIES:
        return f"at most {_MAX_COOKIES} cookies per call"
    for c in cookies:
        if not _COOKIE_NAME.fullmatch(c["name"]):
            return f"cookie name {_json_str(c['name'][:40])} is not a valid cookie name"
        v = c["value"]
        if len(v) > _MAX_COOKIE_VALUE or _CONTROL.search(v) or re.search(r'[;,\s"\\]', v):
            return f'cookie "{c["name"]}": value must be at most {_MAX_COOKIE_VALUE} chars without whitespace, ; , " \\ or control characters'
        path = c.get("path")
        if path is not None and not re.fullmatch(r"/[\w\-./~%]*", path, re.ASCII):
            return f'cookie "{c["name"]}": invalid path'
        if c.get("sameSite") == "None" and c.get("secure") is not True:
            return f'cookie "{c["name"]}": SameSite=None requires secure'
    for kind in ("localStorage", "sessionStorage"):
        entries = list((inp.get(kind) or {}).items())
        if len(entries) > _MAX_ENTRIES:
            return f"at most {_MAX_ENTRIES} {kind} entries per call"
        for k, v in entries:
            if not k or len(k) > _MAX_STORAGE_KEY:
                return f"{kind} key {_json_str(k[:40])} must be 1-{_MAX_STORAGE_KEY} chars"
            if len(v) > _MAX_STORAGE_VALUE:
                return f'{kind}["{k}"] is larger than {_MAX_STORAGE_VALUE} chars'
    return None
