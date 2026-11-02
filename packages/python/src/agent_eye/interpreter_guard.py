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

from .toolchains import django_reason, php_artisan_reason, toolchain_reason, _scan

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


# Options of npm/pnpm/yarn whose value is not a package name (so `--filter web` is not read as installing "web").
_PM_VALUE_FLAGS = {"prefix", "filter", "workspace", "dir", "loglevel", "cwd", "c", "w"}


def _install_reason(tool: str, args: List[str]) -> Optional[str]:
    """`npm install <pkg>` / `pnpm add <pkg>` download and run third-party install scripts; `create`/`init <x>` run a remote template."""
    idx = next((i for i, a in enumerate(args) if a in ("install", "i", "add", "create", "init")), -1)
    if idx < 0:
        return None
    sub = args[idx]
    named = _scan(args[idx + 1:], _PM_VALUE_FLAGS)[1]
    if sub == "create":
        return f"{tool} create runs a remote project template"
    if sub == "init":
        return f"{tool} init {named[0]} runs a remote initializer package" if named else None
    if named:
        return (f"{tool} {sub} {named[0]}: installing named packages downloads and runs third-party install scripts "
                f"(a plain `{tool} install` from the lockfile is fine)")
    return None


def _runner_reason(tool: str, args: List[str]) -> Optional[str]:
    # npm/pnpm/yarn: only their exec/dlx forms download-and-run packages. Look for the
    # subcommand ANYWHERE (an option value like ``--prefix web`` may precede it).
    subs = ["exec", "x"] if tool == "npm" else ["dlx", "exec"] if tool == "pnpm" else ["dlx"]
    idx = next((i for i, a in enumerate(args) if a in subs), -1)
    if idx < 0:
        return _install_reason(tool, args)
    return _package_runner_reason(tool, args[idx + 1:]) or _install_reason(tool, args)


# Modules that are dev servers; anything else under `python -m` can run inline code (`timeit`) or install packages (`pip`).
_PY_MODULE_OK = ["http.server", "flask", "uvicorn", "gunicorn", "django", "hypercorn", "daphne", "streamlit", "mkdocs",
                 "sphinx_autobuild", "fastapi"]


def _python_target_reason(args: List[str]) -> Optional[str]:
    for i, a in enumerate(args):
        if a.startswith("--"):
            continue
        if a.startswith("-"):
            m = re.match(r"^-[A-Za-z]*m(.*)$", a, re.DOTALL)  # -m mod, -Im mod, -mmod
            if not m:
                continue
            mod = m.group(1) or (args[i + 1] if i + 1 < len(args) else None)
            rest = args[i + 1:] if m.group(1) else args[i + 2:]
            if mod is None:
                return None
            if mod not in _PY_MODULE_OK:
                return f"python -m {mod}: only dev-server modules may be run ({', '.join(_PY_MODULE_OK)})"
            if mod == "flask":
                return toolchain_reason("flask", rest)
            if mod == "django":
                return django_reason(rest)
            if mod == "uvicorn":
                return toolchain_reason("uvicorn", rest)
            return None
        if _SCRIPT_LIKE.search(a):
            return django_reason(args[i + 1:]) if re.search(r"(^|[\\/])manage\.py$", a) else None
    return None


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
        return f"python {bad} runs inline code" if bad else _python_target_reason(args)
    if cmd == "php":
        bad = next((f for f in flags if re.fullmatch(r"-[rRBEF]", f)), None)
        return f"php {bad} runs inline code" if bad else php_artisan_reason(args)
    if cmd == "ruby":
        bad = next((f for f in flags if f == "-e" or re.fullmatch(r"-[A-Za-z]*e", f) or f == "-"), None)
        return f"ruby {bad} runs inline code" if bad else None
    if cmd == "deno":
        sub = next((a for a in args if not a.startswith("-")), None)
        if sub in ("eval", "repl"):
            return f"deno {sub} runs inline code"
        if any(re.match(r"^(https?://|npm:|jsr:|data:)", a, re.IGNORECASE) for a in args):
            return "deno: running remote code from a URL or package specifier is not allowed"
        return None
    if cmd == "bun":
        bad = next((f for f in flags if re.fullmatch(r"-e|--eval(=.*)?|-p|--print(=.*)?", f)), None)
        if bad:
            return f"bun {bad} runs inline code"
        sub = next((a for a in args if not a.startswith("-")), None)
        if sub in ("create", "repl"):
            return f"bun {sub} runs a remote template / inline code"
        return _package_runner_reason("bun x", args[args.index("x") + 1:]) if sub == "x" else None
    if cmd in ("npx", "bunx"):
        return _package_runner_reason(cmd, args)
    if cmd in ("npm", "pnpm", "yarn"):
        return _runner_reason(cmd, args)
    # Go / Rust / .NET / JVM / Elixir launchers: see toolchains.py.
    return toolchain_reason(cmd, args)
