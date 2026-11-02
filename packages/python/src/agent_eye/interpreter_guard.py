"""Interpreter hardening for start_dev_server (port of security/interpreter-guard.ts).

The command allowlist contains interpreters (node, python, php, ruby, deno, bun)
and package runners (npx, dlx, bunx) because dev servers are launched through
them. Allowing the *executable* must not mean allowing *arbitrary code on the
command line*: ``node -e "<code>"`` or ``npx some-random-package`` would turn the
``execute`` category into a code-execution primitive that bypasses the ``highRisk``
deny. ``inline_code_reason`` returns a reason when an invocation runs inline /
remote / freshly-downloaded code; the caller then classifies it as "outside" the
allowlist. Normal dev usage (``node server.js``, ``python -m http.server 5500``,
``npm run dev``, ``npx serve``) is unaffected.

Limitation: this cannot stop an agent that can also edit project files (e.g.
rewrite package.json scripts) and then run them.

Keep in lock-step with the TypeScript implementation: both are tested against
packages/mcp-server/tests/fixtures/command-cases.json.
"""
from __future__ import annotations

import re
from typing import List, Optional

from .toolchains import toolchain_reason

RUNNER_ALLOWED_PACKAGES = {
    "serve", "http-server", "live-server", "lite-server", "browser-sync", "light-server",
    "sirv-cli", "vite", "next", "nuxt", "astro", "ng", "webpack", "webpack-dev-server",
    "parcel", "storybook", "wrangler", "expo", "http-server-spa", "five-server",
}

_NODE_EVAL = re.compile(
    r"^(-e|--eval(=.*)?|-p|--print(=.*)?|-pe|-r|--require(=.*)?|--import(=.*)?|--input-type(=.*)?|--inspect(-brk|-wait)?(=.*)?|-)$",
    re.DOTALL,
)
_SCRIPT_LIKE = re.compile(r"\.(m?js|cjs|ts|mts|py|pyw|php|rb)$", re.IGNORECASE)
_REMOTE_PKG = re.compile(r"^(https?:|git\+|github:|file:|\.{0,2}/)")


def _strip_version(pkg: str) -> str:
    # "serve@14.2.0" -> "serve"; "@scope/pkg@1" keeps its scope.
    at = pkg.rfind("@")
    return pkg[:at] if at > 0 else pkg


def _leading_flags(args: List[str], stop_at_module: bool = False) -> List[str]:
    """Every argument before the script (or ``-m module``): the interpreter's own options."""
    out: List[str] = []
    for a in args:
        if _SCRIPT_LIKE.search(a) or (stop_at_module and a == "-m"):
            break
        out.append(a)
    return out


def _first_positional(args: List[str]) -> int:
    for i, a in enumerate(args):
        if not a.startswith("-"):
            return i
    return -1


def _package_runner_reason(tool: str, args: List[str]) -> Optional[str]:
    # Only options BEFORE the package name are the runner's own (after it, ``-p 5500``
    # is the dev server's port flag, not npx's --package).
    first = _first_positional(args)
    own = args if first < 0 else args[:first]
    for a in own:
        if a in ("-c", "--call", "-p", "--package") or a.startswith("--package=") or a.startswith("--call="):
            return f"{tool}: -c/--call/--package run arbitrary commands or packages"
    if first < 0:
        return None
    pkg = args[first]
    if _REMOTE_PKG.match(pkg):
        return f"{tool}: running a package from a URL or path is not allowed"
    if _strip_version(pkg) not in RUNNER_ALLOWED_PACKAGES:
        return f'{tool}: "{pkg}" is not a known dev-server package; it would be downloaded and executed'
    return None


def _runner_reason(tool: str, args: List[str]) -> Optional[str]:
    # npm/pnpm/yarn: only their exec/dlx forms download-and-run packages. Look for the
    # subcommand ANYWHERE (an option value like ``--prefix web`` may precede it).
    subs = ["exec", "x"] if tool == "npm" else ["dlx", "exec"] if tool == "pnpm" else ["dlx"]
    idx = next((i for i, a in enumerate(args) if a in subs), -1)
    if idx < 0:
        return None
    return _package_runner_reason(tool, args[idx + 1:])


def inline_code_reason(base: str, args: List[str]) -> Optional[str]:
    cmd = base.lower()
    flags = _leading_flags(args)

    if cmd in ("node", "nodejs"):
        bad = next((f for f in flags if _NODE_EVAL.match(f)), None)
        return f"node {bad} runs inline code / opens a debugger" if bad else None
    if cmd in ("python", "python3", "py"):
        # -c <code>, possibly clustered (-Ic); a bare "-" reads the program from stdin.
        bad = next(
            (f for f in _leading_flags(args, True) if f == "-" or (re.fullmatch(r"-[A-Za-z]+", f) and "c" in f[1:])),
            None,
        )
        return f"python {bad} runs inline code" if bad else None
    if cmd == "php":
        bad = next((f for f in flags if re.fullmatch(r"-[rRBEF]", f)), None)
        return f"php {bad} runs inline code" if bad else None
    if cmd == "ruby":
        bad = next((f for f in flags if f == "-e" or re.fullmatch(r"-[A-Za-z]*e", f) or f == "-"), None)
        return f"ruby {bad} runs inline code" if bad else None
    if cmd == "deno":
        sub = next((a for a in args if not a.startswith("-")), None)
        if sub in ("eval", "repl"):
            return f"deno {sub} runs inline code"
        if any(re.match(r"^https?://", a, re.IGNORECASE) for a in args):
            return "deno: running remote code from a URL is not allowed"
        return None
    if cmd == "bun":
        bad = next((f for f in flags if re.fullmatch(r"-e|--eval(=.*)?|-p|--print(=.*)?", f)), None)
        if bad:
            return f"bun {bad} runs inline code"
        sub = next((a for a in args if not a.startswith("-")), None)
        return _package_runner_reason("bun x", args[args.index("x") + 1:]) if sub == "x" else None
    if cmd in ("npx", "bunx"):
        return _package_runner_reason(cmd, args)
    if cmd in ("npm", "pnpm", "yarn"):
        return _runner_reason(cmd, args)
    # Go / Rust / .NET / JVM / Elixir launchers: see toolchains.py.
    return toolchain_reason(cmd, args)
