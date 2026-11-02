"""Toolchain rules for start_dev_server (port of security/toolchains.ts).

Go, Rust, .NET, JVM and Elixir launchers whose command line can do much more
than "run my dev server": ``go run -exec <prog>``, ``cargo run --config
build.rustc-wrapper=<prog>``, ``cargo watch -s "<shell>"``, ``dotnet run
-p:RunCommand=<prog>``, ``mvn -Dspring-boot.run.jvmArguments=-javaagent:...``,
``gradle -I init.gradle``, ``mix run -e "<code>"``, ``templ generate --cmd <prog>``.

Each rule (1) restricts the first subcommand to the dev-loop ones and (2) rejects
flags / arguments that run other programs, load code from elsewhere, or escape the
workspace. Fail-closed: an unknown shape yields a reason, the caller classifies the
command as "outside" and the default ``highRisk: deny`` applies.

Limitation: build scripts and project config (build.rs, proc-macros, .air.toml,
Trunk hooks, Maven/Gradle build files, .cargo/config.toml) execute project-owned
code - the same trust boundary as ``npm run dev`` running package.json scripts.

Keep in lock-step with the TypeScript implementation: both are tested against
packages/mcp-server/tests/fixtures/command-cases.json.
"""
from __future__ import annotations

import re
from typing import Iterable, List, Optional, Set, Tuple

# Wrapper scripts that live in the project; given a path it must stay inside the workspace.
WRAPPER_COMMANDS = {"mvnw", "gradlew"}


class Flag:
    __slots__ = ("name", "value")

    def __init__(self, name: str, value: Optional[str] = None):
        self.name = name  # without leading dashes, original case (-Dx=1 -> "Dx", value "1")
        self.value = value


def _parse_flag(a: str) -> Optional[Flag]:
    if not a.startswith("-") or a in ("-", "--"):
        return None
    body = re.sub(r"^--?", "", a, count=1)
    eq = body.find("=")
    return Flag(body) if eq < 0 else Flag(body[:eq], body[eq + 1:])


def _scan(args: List[str], value_flags: Iterable[str] = (), stop_at_first_positional: bool = False
          ) -> Tuple[List[Flag], List[str], List[str], bool]:
    """Returns (flags, positionals, rest, saw_dash_dash)."""
    vf = set(value_flags)
    flags: List[Flag] = []
    positionals: List[str] = []
    rest: List[str] = []
    saw = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            rest = args[i + 1:]
            saw = True
            break
        f = _parse_flag(a)
        if f is not None:
            if f.value is None and f.name.lower() in vf and i + 1 < len(args):
                i += 1
                f.value = args[i]
            flags.append(f)
            i += 1
            continue
        positionals.append(a)
        if stop_at_first_positional:
            rest = args[i + 1:]
            break
        i += 1
    return flags, positionals, rest, saw


def is_path_escape(v: str) -> bool:
    """Absolute, drive-letter, UNC, home-relative, or containing a ``..`` segment."""
    return bool(re.match(r"^(?:[a-zA-Z]:)?[\\/]", v)) or v.startswith("~") or ".." in re.split(r"[\\/]", v)


# Properties that can inject JVM agents / executables / alternate settings.
_DANGEROUS_PROPERTY = re.compile(
    r"(exec|agent|jvm-?arg|argline|main-?class|executable|working-?dir|java\.home|javahome|settings|toolchain"
    r"|classpath|loader|command|script|maven\.(home|repo)|\.opts?$)",
    re.IGNORECASE,
)


def _property_of(f: Flag) -> Optional[str]:
    # -Dkey=val -> name "Dkey"; -D key=val -> name "D", value "key=val". Same for gradle -P.
    if f.name[:1] not in ("D", "P"):
        return None
    return f.name[1:] if len(f.name) > 1 else (f.value or "").split("=")[0]


def _dangerous_property(tool: str, flags: List[Flag]) -> Optional[str]:
    for f in flags:
        p = _property_of(f)
        if p and _DANGEROUS_PROPERTY.search(p):
            return f'{tool}: property "{p}" can inject executables or JVM agents'
    return None


def _deny_path_flags(tool: str, flags: List[Flag], names: List[str]) -> Optional[str]:
    for f in flags:
        if f.name.lower() in names and (f.value is None or is_path_escape(f.value)):
            return f"{tool}: --{f.name} must be a path inside the workspace"
    return None


def _deny_flag_names(tool: str, flags: List[Flag], names: List[str], why: str) -> Optional[str]:
    hit = next((f for f in flags if f.name in names), None)
    if hit is None:
        return None
    return f"{tool}: -{'-' if len(hit.name) > 1 else ''}{hit.name} {why}"


def _only_subcommands(tool: str, sub: Optional[str], allowed: List[str]) -> Optional[str]:
    if sub is not None and sub in allowed:
        return None
    got = "no subcommand" if sub is None else f'"{sub}"'
    return f"{tool}: only `{tool} {'|'.join(allowed)}` may be started here (got {got})"


def _first(items: List[str]) -> Optional[str]:
    return items[0] if items else None


# ---- Go ----------------------------------------------------------------------

_GO_VALUE_FLAGS = {
    "c", "o", "p", "tags", "mod", "modfile", "overlay", "pkgdir", "asmflags", "gcflags", "ldflags", "toolexec",
    "exec", "installsuffix", "compiler", "covermode", "coverpkg", "gccgoflags", "pgo", "buildmode",
}


def _go_ldflags_reason(value: str) -> Optional[str]:
    """Only -X pkg.var=value, -s and -w: other linker flags can select an external linker / ELF interpreter."""
    toks = [t for t in re.split(r"\s+", value) if t]
    i = 0
    while i < len(toks):
        if toks[i] == "-X":
            i += 1
        elif toks[i] not in ("-s", "-w"):
            return f'go: -ldflags "{toks[i]}" is not allowed (only -X, -s, -w)'
        i += 1
    return None


def _is_local_go_target(t: str) -> bool:
    if "@" in t or is_path_escape(t):
        return False
    return t == "." or t.startswith("./") or t.startswith(".\\") or t.endswith(".go")


def _go_reason(args: List[str]) -> Optional[str]:
    bad = _only_subcommands("go", _first(args), ["run"])
    if bad:
        return bad
    flags, positionals, _rest, _ = _scan(args[1:], _GO_VALUE_FLAGS, True)
    denied = _deny_flag_names("go", flags, ["exec", "toolexec", "C", "overlay", "modfile"],
                              "runs another program or leaves the workspace")
    if denied:
        return denied
    for f in flags:
        if f.name.lower() == "ldflags":
            r = _go_ldflags_reason(f.value or "")
            if r:
                return r
    target = _first(positionals)
    if target is not None and not _is_local_go_target(target):
        return (f'go: "{target}" is not a local package (use ".", "./cmd/x" or a .go file); '
                "remote modules would be downloaded and executed")
    return None


# ---- Rust --------------------------------------------------------------------

_CARGO_EXEC_OK = {"run", "r", "check", "build", "test"}


def _cargo_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _rest, saw_dash_dash = _scan(args, {"color", "manifest-path", "target-dir", "j", "jobs"})
    for f in flags:
        if f.name == "config" or f.name == "C" or re.match(r"^Z", f.name):
            return f"cargo: -{'-' if len(f.name) > 1 else ''}{f.name} can run other programs or enable unstable behaviour"
    paths = _deny_path_flags("cargo", flags, ["manifest-path", "target-dir"])
    if paths:
        return paths
    # `cargo +nightly run`: the toolchain selector is not a subcommand.
    sub = next((p for p in positionals if not p.startswith("+")), None)
    bad = _only_subcommands("cargo", sub, ["run", "r", "watch", "leptos"])
    if bad:
        return bad
    after_sub = positionals[positionals.index(sub) + 1:]
    if sub == "leptos" and (_first(after_sub) not in ("watch", "serve")):
        return "cargo leptos: only `watch` and `serve` may be started here"
    if sub == "watch":
        return _cargo_watch_reason(args, saw_dash_dash)
    return None


def _cargo_watch_reason(args: List[str], saw_dash_dash: bool) -> Optional[str]:
    """`cargo watch` can run arbitrary shell (-s) or any command after `--`; only `-x <cargo subcommand>` is accepted."""
    if saw_dash_dash:
        return "cargo watch: `--` runs an arbitrary command"
    after = args[args.index("watch") + 1:]
    i = 0
    while i < len(after):
        a = after[i]
        if a == "--shell" or a.startswith("--shell="):
            return "cargo watch: --shell runs an arbitrary shell command"
        if a.startswith("--env") or re.match(r"^-E", a):
            return "cargo watch: environment overrides (-E) can inject compiler wrappers"
        execv: Optional[str] = None
        if a in ("--exec", "-x"):
            i += 1
            execv = after[i] if i < len(after) else None
        elif a.startswith("--exec="):
            execv = a[7:]
        elif a.startswith("-x"):
            execv = a[2:]
        if execv is not None:
            words = execv.strip().split()
            head = words[0] if words else ""
            if head not in _CARGO_EXEC_OK:
                return f'cargo watch: -x "{head}" is not a dev-loop cargo subcommand'
            inner = _cargo_reason(words)
            if inner:
                return inner
            i += 1
            continue
        if re.fullmatch(r"-[A-Za-z]*s[A-Za-z]*", a):
            return "cargo watch: -s runs an arbitrary shell command"
        if re.fullmatch(r"-[A-Za-z]{2,}", a):
            return f"cargo watch: combined short flags ({a}) are not supported; pass them separately"
        i += 1
    return None


def _trunk_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _r, _ = _scan(args, {"c", "config", "dist", "w", "watch", "i", "ignore"})
    return _only_subcommands("trunk", _first(positionals), ["serve", "watch"]) or \
        _deny_path_flags("trunk", flags, ["c", "config", "dist"])


def _dx_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _r, _ = _scan(args, {"platform", "port", "addr", "package", "bin", "example", "features", "profile"})
    return _only_subcommands("dx", _first(positionals), ["serve"]) or \
        _deny_flag_names("dx", flags, ["cargo-args", "rustc-args", "config"], "passes arguments straight to cargo/rustc")


# ---- Go helpers: air / templ / wails -----------------------------------------

def _air_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _r, _ = _scan(args, {"c"}, True)
    if positionals:
        return f'air: subcommand "{positionals[0]}" is not allowed; run plain `air`'
    build = next((f for f in flags if re.match(r"^build\.", f.name)), None)
    if build:
        return f"air: -{build.name} overrides the build/run command"
    return _deny_path_flags("air", flags, ["c"])


def _templ_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _r, _ = _scan(args, {"path", "f", "proxy", "proxybind", "proxyport", "cmd"})
    return _only_subcommands("templ", _first(positionals), ["generate"]) or \
        _deny_flag_names("templ", flags, ["cmd"], "runs an arbitrary command after generating")


def _wails_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _r, _ = _scan(args, {"tags", "ldflags", "compiler", "loglevel", "m", "e"})
    return _only_subcommands("wails", _first(positionals), ["dev"]) or \
        _deny_flag_names("wails", flags, ["ldflags", "compiler"], "selects an alternate linker/compiler binary")


# ---- .NET --------------------------------------------------------------------

_DOTNET_VALUE_FLAGS = {
    "project", "launch-profile", "lp", "c", "configuration", "f", "framework", "r", "runtime", "v", "verbosity", "arch", "os",
}
_DOTNET_PROP = re.compile(r"^[-/]{1,2}(p|property)([:=]|$)", re.IGNORECASE)


def _dotnet_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _r, _ = _scan(args, _DOTNET_VALUE_FLAGS)
    # MSBuild properties can override what `run` executes (RunCommand / RunArguments).
    own = args[: args.index("--")] if "--" in args else args
    prop = next((a for a in own if _DOTNET_PROP.match(a)), None)
    if prop:
        return f"dotnet: {prop} sets MSBuild properties that can change what is executed"
    bad = _only_subcommands("dotnet", _first(positionals), ["run", "watch"])
    if bad:
        return bad
    if positionals[0] == "watch" and len(positionals) > 1 and positionals[1] != "run":
        return f'dotnet watch: only `dotnet watch [run]` may be started here (got "{positionals[1]}")'
    return _deny_path_flags("dotnet", flags, ["project"])


# ---- JVM ---------------------------------------------------------------------

_MVN_GOALS = ["clean", "compile", "spring-boot:run", "quarkus:dev", "jetty:run", "mn:run", "tomcat7:run", "tomcat:run"]
_MVN_VALUE_FLAGS = {"pl", "rf", "t", "l", "b", "p", "projects", "resume-from", "threads", "log-file", "builder", "activate-profiles", "d"}


def _mvn_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _r, _ = _scan(args, _MVN_VALUE_FLAGS)
    alt = _deny_flag_names("mvn", flags, ["f", "file", "s", "settings", "gs", "global-settings", "gt", "t", "toolchains"],
                           "loads an alternate pom/settings file")
    if alt:
        return alt
    prop = _dangerous_property("mvn", flags)
    if prop:
        return prop
    goal = next((g for g in positionals if g not in _MVN_GOALS), None)
    if goal is not None:
        return f'mvn: goal "{goal}" is not a dev-loop goal (allowed: {", ".join(_MVN_GOALS)})'
    return None


_GRADLE_TASKS = ["bootRun", "run", "quarkusDev", "jettyRun", "appRun", "clean", "classes"]
_GRADLE_VALUE_FLAGS = {"x", "exclude-task", "console", "warning-mode", "max-workers", "args"}


def _gradle_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _r, _ = _scan(args, _GRADLE_VALUE_FLAGS)
    alt = _deny_flag_names(
        "gradle", flags,
        ["I", "init-script", "b", "build-file", "c", "settings-file", "g", "gradle-user-home", "p", "project-dir",
         "project-cache-dir", "include-build"],
        "loads scripts or projects from another location",
    )
    if alt:
        return alt
    prop = _dangerous_property("gradle", flags)
    if prop:
        return prop
    task = next((t for t in positionals if t[t.rfind(":") + 1:] not in _GRADLE_TASKS), None)
    if task is not None:
        return f'gradle: task "{task}" is not a dev-loop task (allowed: {", ".join(_GRADLE_TASKS)})'
    return None


# ---- Elixir ------------------------------------------------------------------

def _mix_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _r, _ = _scan(args, set())
    return _only_subcommands("mix", _first(positionals), ["phx.server", "run"]) or \
        _deny_flag_names("mix", flags, ["e", "eval", "r", "require", "pa", "pz", "pr"],
                         "runs inline code or loads code from elsewhere")


# ---- Ruby / PHP / Python frameworks (Issue #32) -------------------------------------
# Entry points that are allowlisted for their server command but also evaluate code
# (`rails runner`, `manage.py shell -c`, `flask shell`, `php artisan tinker`, `bundle exec <anything>`).

def _rails_reason(args: List[str]) -> Optional[str]:
    return _only_subcommands("rails", _first(_scan(args)[1]), ["server", "s"])


_BUNDLE_EXEC_OK = ["rails", "puma", "rackup", "jekyll", "unicorn", "thin", "middleman", "bridgetown", "hanami"]


def _bundle_reason(args: List[str]) -> Optional[str]:
    positionals = _scan(args)[1]
    bad = _only_subcommands("bundle", _first(positionals), ["exec"])
    if bad:
        return bad
    inner = positionals[1] if len(positionals) > 1 else None
    if inner is None or inner not in _BUNDLE_EXEC_OK:
        return f'bundle exec: "{inner or ""}" is not a known server command (allowed: {", ".join(_BUNDLE_EXEC_OK)})'
    return toolchain_reason(inner, args[args.index(inner) + 1:])


def _rackup_reason(args: List[str]) -> Optional[str]:
    return _deny_flag_names("rackup", _scan(args)[0], ["e", "eval", "r", "require", "I"],
                            "runs inline code or loads code from elsewhere")


def _jekyll_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _r, _ = _scan(args, {"source", "s", "destination", "d", "config", "c", "port", "p", "host", "h", "baseurl", "b"})
    return _only_subcommands("jekyll", _first(positionals), ["serve", "s", "server"]) or \
        _deny_path_flags("jekyll", flags, ["source", "s", "destination", "d", "config", "c"])


def _hugo_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _r, _ = _scan(args, {"source", "s", "destination", "d", "config", "themesdir", "cachedir", "contentdir",
                                             "layoutdir", "port", "p", "bind", "baseurl", "b", "environment", "e", "theme", "t"})
    return _only_subcommands("hugo", _first(positionals), ["server"]) or \
        _deny_path_flags("hugo", flags, ["source", "s", "destination", "d", "config", "themesdir", "cachedir", "contentdir", "layoutdir"])


def _flask_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _r, _ = _scan(args, {"app", "a", "env-file", "e"})
    return _only_subcommands("flask", _first(positionals), ["run"]) or _deny_path_flags("flask", flags, ["env-file", "e"])


def django_reason(args: List[str]) -> Optional[str]:
    flags, positionals, _r, _ = _scan(args, {"settings", "pythonpath"})
    return _only_subcommands("manage.py", _first(positionals), ["runserver", "runserver_plus"]) or \
        _deny_path_flags("manage.py", flags, ["pythonpath"])


def _uvicorn_reason(args: List[str]) -> Optional[str]:
    flags = _scan(args, {"app-dir", "env-file", "log-config", "host", "port", "workers", "reload-dir", "ssl-keyfile", "ssl-certfile"})[0]
    return _deny_path_flags("uvicorn", flags, ["app-dir", "env-file", "log-config"])


def php_artisan_reason(args: List[str]) -> Optional[str]:
    """`php artisan <cmd>`: only `serve` is a dev server (`tinker`, `migrate`, custom commands run code)."""
    i = next((k for k, a in enumerate(args) if re.search(r"(^|[\\/])artisan$", a)), -1)
    if i < 0:
        return None
    sub = next((a for a in args[i + 1:] if not a.startswith("-")), None)
    return None if sub == "serve" else f"php artisan {sub or ''}: only `php artisan serve` may be started here"


_RULES = {
    "go": _go_reason, "cargo": _cargo_reason, "trunk": _trunk_reason, "dx": _dx_reason, "air": _air_reason,
    "templ": _templ_reason, "wails": _wails_reason, "dotnet": _dotnet_reason,
    "mvn": _mvn_reason, "mvnw": _mvn_reason, "gradle": _gradle_reason, "gradlew": _gradle_reason, "mix": _mix_reason,
    "rails": _rails_reason, "bundle": _bundle_reason, "rackup": _rackup_reason, "jekyll": _jekyll_reason, "hugo": _hugo_reason,
    "flask": _flask_reason, "django-admin": django_reason, "manage.py": django_reason, "uvicorn": _uvicorn_reason,
}


def toolchain_reason(base: str, args: List[str]) -> Optional[str]:
    """A reason when this invocation is not a plain dev-loop run; None otherwise (or for unknown tools)."""
    rule = _RULES.get(base.lower())
    return rule(args) if rule else None
