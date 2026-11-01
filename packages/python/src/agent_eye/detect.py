"""Project detection (port of project/detect.ts + project/scan.ts).

Pure: given a mapping of workspace-relative POSIX paths -> file content (content
only for known manifests, "" otherwise) it returns the exact ``start_dev_server``
arguments for each runnable project, so an agent does not burn turns reading
manifests and guessing commands/ports. Every suggestion is accepted by the command
guard under the default policy (tested).

Keep in lock-step with the TypeScript implementation: both are tested against
packages/mcp-server/tests/fixtures/detect-cases.json.
"""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Dict, List, Optional

_MANIFESTS = {
    "package.json", "go.mod", "Cargo.toml", "pubspec.yaml", "pom.xml", "build.gradle", "build.gradle.kts",
    "mix.exs", "composer.json", "Gemfile", "requirements.txt", "pyproject.toml", "launchSettings.json",
    "deno.json", "deno.jsonc",
}


def is_manifest(basename: str) -> bool:
    """Basenames whose CONTENT the scanner should load (everything else is existence-only)."""
    return basename in _MANIFESTS or basename.endswith(".csproj")


@dataclass
class DetectedProject:
    dir: str
    stack: str
    command: str
    args: List[str]
    port: Optional[int] = None
    port_source: Optional[str] = None  # "config" | "typical"
    note: Optional[str] = None


@dataclass
class DetectResult:
    projects: List[DetectedProject] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)


Files = Dict[str, str]


def _dir_of(p: str) -> str:
    head, sep, _tail = p.rpartition("/")
    return head if sep else "."


def _join(d: str, name: str) -> str:
    return name if d == "." else f"{d}/{name}"


def _base_of(p: str) -> str:
    return p.rpartition("/")[2]


def _id_of(d: str) -> str:
    return "app" if d == "." else _base_of(d)


def _json(text: Optional[str]):
    try:
        return json.loads(text) if text else None
    except ValueError:
        return None


def _has_crate(toml: str, name: str) -> bool:
    """True when ``[dependencies]``-style TOML declares crate ``name`` (``x = "1"``, ``x = {..}``, ``x.workspace = true``)."""
    return re.search(rf"^\s*{name.replace('-', '[-_]')}\s*(=|\.)", toml, re.M) is not None


def _port_from_script(script: Optional[str]) -> Optional[int]:
    m = re.search(r"(?:--port|-p|PORT=)[ =]?(\d{2,5})\b", script or "")
    return int(m.group(1)) if m else None


def _port(project: DetectedProject, port: Optional[int], source: str) -> DetectedProject:
    if port:
        project.port, project.port_source = port, source
    return project


# ---- per-ecosystem detectors ---------------------------------------------------

_NODE_FRAMEWORKS = [
    (["next"], "Next.js", 3000), (["nuxt", "nuxt3"], "Nuxt", 3000), (["astro"], "Astro", 4321),
    (["@angular/core", "@angular/cli"], "Angular", 4200), (["@sveltejs/kit"], "SvelteKit", 5173),
    (["@remix-run/dev", "@remix-run/react"], "Remix", None), (["gatsby"], "Gatsby", 8000),
    (["react-scripts"], "Create React App", 3000), (["expo"], "Expo (web)", 8081),
    (["vite"], "Vite", 5173), (["@vue/cli-service"], "Vue CLI", 8080), (["parcel"], "Parcel", 1234),
    (["webpack-dev-server"], "webpack dev server", 8080),
]


def _node_project(d: str, text: str, files: Files) -> Optional[DetectedProject]:
    pkg = _json(text)
    if not isinstance(pkg, dict):
        return None
    deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
    scripts = pkg.get("scripts") or {}
    script = next((s for s in ("dev", "start", "serve", "develop") if isinstance(scripts.get(s), str)), None)
    if not script:
        return None
    hit = next((f for f in _NODE_FRAMEWORKS if any(n in deps for n in f[0])), None)
    ui = ("React" if "react" in deps else "Vue" if "vue" in deps else "Svelte" if "svelte" in deps
          else "Solid" if "solid-js" in deps else None)
    label = (f"Vite · {ui}" if hit[1] == "Vite" and ui else hit[1]) if hit else "Node"

    def sibling(n: str) -> bool:
        return n in files and _dir_of(n) == d

    pm = ("pnpm" if sibling(_join(d, "pnpm-lock.yaml")) else "yarn" if sibling(_join(d, "yarn.lock"))
          else "bun" if sibling(_join(d, "bun.lockb")) or sibling(_join(d, "bun.lock")) else "npm")
    args = [script] if pm in ("yarn", "pnpm") else ["run", script]
    from_script = _port_from_script(scripts.get(script))
    port = from_script or (hit[2] if hit else None)
    return _port(DetectedProject(d, label, pm, args), port, "config" if from_script else "typical")


_GO_WEB = [
    ("gin-gonic/gin", "Gin", 8080), ("labstack/echo", "Echo", 1323), ("gofiber/fiber", "Fiber", 3000),
    ("go-chi/chi", "chi", None), ("gorilla/mux", "gorilla/mux", None), ("beego/beego", "Beego", 8080),
    ("a-h/templ", "templ", None), ("wailsapp/wails", "Wails", None),
]


def _go_project(d: str, mod: str, files: Files) -> Optional[DetectedProject]:
    def at(n: str) -> bool:
        return _join(d, n) in files

    prefix = _join(d, "cmd/")
    depth = len(_join(d, "cmd/x/main.go").split("/"))
    cmds = sorted(
        p.split("/")[-2] for p in files
        if p.startswith(prefix) and p.endswith("/main.go") and len(p.split("/")) == depth
    )
    fw = [f for f in _GO_WEB if f[0] in mod]
    label = " · ".join(["Go"] + [f[1] for f in fw])
    typical = next((f[2] for f in fw if f[2]), None)
    templ_note = (
        "templ: keep `*_templ.go` generated (`templ generate`) or run `templ generate --watch --proxy=http://localhost:PORT` as a second server."
        if any(f[1] == "templ" for f in fw) or any(p.endswith(".templ") for p in files) else None
    )
    if at("wails.json"):
        return DetectedProject(d, label, "wails", ["dev"], 34115, "typical",
                               "Wails also opens a native window; Agent Eye drives its browser dev server on :34115.")
    if at(".air.toml"):
        return _port(DetectedProject(d, f"{label} (air live-reload)", "air", [], note=templ_note), typical, "typical")
    entry = "." if at("main.go") else (f"./cmd/{cmds[0]}" if cmds else None)
    if not entry:
        return None
    others = [] if at("main.go") else cmds[1:]
    note = " ".join(x for x in (templ_note, f"other entry points: {', '.join('./cmd/' + c for c in others)}" if others else None) if x)
    return _port(DetectedProject(d, label, "go", ["run", entry], note=note or None), typical, "typical")


_RUST_SERVERS = [
    ("axum", "Axum", 3000), ("actix-web", "Actix Web", 8080), ("rocket", "Rocket", 8000), ("warp", "Warp", 3030),
    ("poem", "Poem", 3000), ("salvo", "Salvo", 5800), ("tide", "Tide", 8080),
]


def _rust_project(d: str, toml: str, files: Files, notes: List[str]) -> Optional[DetectedProject]:
    if not re.search(r"^\s*\[package\]", toml, re.M):
        return None  # pure workspace manifest: members are scanned on their own

    def at(n: str) -> bool:
        return _join(d, n) in files

    if _has_crate(toml, "tauri"):
        notes.append(f"{d}: Tauri app — the native window cannot be driven; start its web frontend dev server instead.")
        return None
    if at("Dioxus.toml") or _has_crate(toml, "dioxus"):
        return DetectedProject(d, "Rust · Dioxus", "dx", ["serve"], 8080, "typical", "Needs the `dx` CLI (cargo install dioxus-cli).")
    if _has_crate(toml, "leptos"):
        ssr = (re.search(r"\[package\.metadata\.leptos\]", toml) is not None
               or _has_crate(toml, "leptos_axum") or _has_crate(toml, "leptos_actix"))
        if ssr:
            return DetectedProject(d, "Rust · Leptos (SSR)", "cargo", ["leptos", "watch"], 3000, "typical", "Needs cargo-leptos.")
        return DetectedProject(d, "Rust · Leptos (CSR)", "trunk", ["serve"], 8080, "typical",
                               "Needs trunk + the wasm32-unknown-unknown target.")
    wasm = next((c for c in ("yew", "sycamore", "seed", "percy-dom", "dominator") if _has_crate(toml, c)), None)
    if wasm or at("Trunk.toml"):
        return DetectedProject(d, f"Rust · {wasm or 'wasm'} (Trunk)", "trunk", ["serve"], 8080, "typical",
                               "Needs trunk + the wasm32-unknown-unknown target.")
    srv = next((s for s in _RUST_SERVERS if _has_crate(toml, s[0])), None)
    if not srv and not at("src/main.rs") and not re.search(r"^\s*\[\[bin\]\]", toml, re.M):
        return None  # library crate
    p = DetectedProject(d, f"Rust · {srv[1]}" if srv else "Rust", "cargo", ["run"],
                        note="Rebuilds on each start; use `cargo watch -x run` (needs cargo-watch) for hot reload.")
    return _port(p, srv[2] if srv else None, "typical")


def _dotnet_project(d: str, csproj: str, files: Files) -> Optional[DetectedProject]:
    web = re.search(r'Sdk="Microsoft\.NET\.Sdk\.Web"', csproj) is not None
    blazor = re.search(r'Sdk="Microsoft\.NET\.Sdk\.BlazorWebAssembly"', csproj) is not None
    if not web and not blazor:
        return None
    settings = _json(files.get(_join(d, "Properties/launchSettings.json")))
    profiles = (settings or {}).get("profiles") if isinstance(settings, dict) else None
    urls: List[str] = []
    for prof in (profiles or {}).values():
        if isinstance(prof, dict) and prof.get("commandName") == "Project" and isinstance(prof.get("applicationUrl"), str):
            urls.extend(prof["applicationUrl"].split(";"))
    url = next((u for u in urls if u.startswith("http://")), urls[0] if urls else None)
    m = re.search(r":(\d{2,5})", url) if url else None
    port = int(m.group(1)) if m else None
    return DetectedProject(d, ".NET · Blazor WebAssembly" if blazor else ".NET · ASP.NET Core", "dotnet", ["run"],
                           port or 5000, "config" if port else "typical", "`dotnet watch run` adds hot reload.")


def _wrapper_for(d: str, wrapper: str, fallback: str, files: Files, platform: str) -> str:
    """Path to the nearest project wrapper script (mvnw/gradlew) in ``d`` or an ancestor, relative to ``d``."""
    win = platform == "win32"
    parts = [] if d == "." else d.split("/")
    for up in range(len(parts) + 1):
        anc = "/".join(parts[: len(parts) - up]) or "."
        if _join(anc, wrapper) in files:
            if up == 0:
                return wrapper if win else f"./{wrapper}"
            return ("..\\" if win else "../") * up + wrapper
    return fallback


def _jvm_project(d: str, files: Files, platform: str) -> Optional[DetectedProject]:
    pom = files.get(_join(d, "pom.xml"))
    gradle = files.get(_join(d, "build.gradle"))
    if gradle is None:
        gradle = files.get(_join(d, "build.gradle.kts"))
    if pom is not None:
        cmd = _wrapper_for(d, "mvnw", "mvn", files, platform)
        goal = (("spring-boot:run", "Spring Boot") if "spring-boot" in pom else ("quarkus:dev", "Quarkus") if "quarkus" in pom
                else ("mn:run", "Micronaut") if "micronaut" in pom else None)
        if goal:
            return DetectedProject(d, f"Java · {goal[1]} (Maven)", cmd, [goal[0]], 8080, "typical")
    if gradle is not None:
        cmd = _wrapper_for(d, "gradlew", "gradle", files, platform)
        task = (("bootRun", "Spring Boot") if "org.springframework.boot" in gradle else ("quarkusDev", "Quarkus") if "io.quarkus" in gradle
                else ("run", "Micronaut") if "io.micronaut" in gradle else None)
        if task:
            return DetectedProject(d, f"JVM · {task[1]} (Gradle)", cmd, [task[0]], 8080, "typical")
    return None


def _python_project(d: str, files: Files, platform: str) -> Optional[DetectedProject]:
    def at(n: str) -> bool:
        return _join(d, n) in files

    py = "python" if platform == "win32" else "python3"
    if at("manage.py"):
        return DetectedProject(d, "Python · Django", py, ["manage.py", "runserver"], 8000, "typical")
    deps = f"{files.get(_join(d, 'requirements.txt'), '')}\n{files.get(_join(d, 'pyproject.toml'), '')}".lower()
    if re.search(r"\bfastapi\b", deps) and at("main.py"):
        return DetectedProject(d, "Python · FastAPI", "uvicorn", ["main:app", "--reload"], 8000, "typical",
                               "Assumes the app object is `app` in main.py.")
    if re.search(r"\bflask\b", deps) and (at("app.py") or at("wsgi.py")):
        return DetectedProject(d, "Python · Flask", "flask", ["run"], 5000, "typical")
    return None


# Directory names come from the file system and end up in the model's context, so a hostile repo could try
# to smuggle instructions through them. Accept only short, plain path segments; ignore the rest.
_SAFE_SEGMENT = re.compile(r"(?!(?:.*? ){4})[\w.@+-][\w.@+ -]{0,39}", re.ASCII)


def is_safe_path(p: str) -> bool:
    return len(p) <= 160 and all(_SAFE_SEGMENT.fullmatch(s) for s in p.split("/"))


def detect_projects(raw_files: Files, platform: Optional[str] = None, max_projects: int = 12) -> DetectResult:
    files = {p: c for p, c in raw_files.items() if is_safe_path(p)}
    platform = platform or sys.platform
    notes: List[str] = []
    found: List[DetectedProject] = []

    def add(p: Optional[DetectedProject]) -> None:
        if p:
            found.append(p)

    for path in sorted(files):
        d, base, text = _dir_of(path), _base_of(path), files[path]

        def at(n: str, d=d) -> bool:
            return _join(d, n) in files

        if base == "package.json":
            add(_node_project(d, text, files))
        elif base == "go.mod":
            add(_go_project(d, text, files))
        elif base == "Cargo.toml":
            add(_rust_project(d, text, files, notes))
        elif base == "mix.exs":
            if re.search(r":phoenix\b", text):
                add(DetectedProject(d, "Elixir · Phoenix", "mix", ["phx.server"], 4000, "typical"))
        elif base == "composer.json":
            if "laravel/framework" in text:
                add(DetectedProject(d, "PHP · Laravel", "php", ["artisan", "serve"], 8000, "typical"))
        elif base == "Gemfile":
            if re.search(r"\brails\b", text):
                add(DetectedProject(d, "Ruby · Rails", "rails", ["server"], 3000, "typical"))
            elif re.search(r"\bjekyll\b", text):
                add(DetectedProject(d, "Ruby · Jekyll", "jekyll", ["serve"], 4000, "typical"))
        elif base == "pubspec.yaml":
            if re.search(r"sdk:\s*flutter", text) and at("web/index.html"):
                add(DetectedProject(
                    d, "Flutter web", "flutter", ["run", "-d", "web-server", "--web-port", "5500"], 5500, "config",
                    "Canvas UI: use screenshots + browser_click_at. For stable checks prefer `flutter build web` + a static server."))
        elif base in ("deno.json", "deno.jsonc"):
            tasks = (_json(text) or {}).get("tasks") if isinstance(_json(text), dict) else None
            if isinstance(tasks, dict) and isinstance(tasks.get("dev"), str):
                add(DetectedProject(d, "Deno", "deno", ["task", "dev"]))
        elif base == "pom.xml":
            add(_jvm_project(d, files, platform))
        elif base == "build.gradle":
            if not at("pom.xml"):
                add(_jvm_project(d, files, platform))
        elif base == "build.gradle.kts":
            if not at("pom.xml") and not at("build.gradle"):
                add(_jvm_project(d, files, platform))
        elif base in ("requirements.txt", "pyproject.toml"):
            if not (at("requirements.txt") and base == "pyproject.toml"):
                add(_python_project(d, files, platform))
        elif base.endswith(".csproj"):
            add(_dotnet_project(d, text, files))

    # Django without requirements/pyproject still has manage.py.
    for path in list(files):
        if _base_of(path) == "manage.py" and not any(p.dir == _dir_of(path) and p.stack.startswith("Python") for p in found):
            add(_python_project(_dir_of(path), files, platform))
    # Plain static site at the root.
    if "index.html" in files and not any(p.dir == "." for p in found):
        py = "python" if platform == "win32" else "python3"
        add(DetectedProject(".", "Static HTML", py, ["-m", "http.server", "5500"], 5500, "config"))

    seen = set()
    unique: List[DetectedProject] = []
    for p in found:
        key = f"{p.dir}|{p.command}|{' '.join(p.args)}"
        if key not in seen:
            seen.add(key)
            unique.append(p)
    unique.sort(key=lambda p: (len(p.dir.split("/")), p.dir))
    return DetectResult(unique[:max_projects], notes)


def format_detected(res: DetectResult, verdicts: Optional[List[Optional[str]]] = None) -> str:
    """One compact line per project; ``verdicts`` is filled by the caller from the command guard."""
    verdicts = verdicts or []
    if not res.projects and not res.notes:
        return ("No runnable project found (looked for package.json, go.mod, Cargo.toml, *.csproj, pom.xml, build.gradle, "
                "mix.exs, composer.json, Gemfile, pubspec.yaml, manage.py, index.html up to 3 levels deep). "
                "Ask the user how to start it, then call start_dev_server directly.")
    lines = []
    for i, p in enumerate(res.projects):
        port = f" port={p.port}{' (typical)' if p.port_source == 'typical' else ''}" if p.port else ""
        guard = f" [NOT STARTABLE: {verdicts[i]}]" if i < len(verdicts) and verdicts[i] else ""
        note = f"\n   note: {p.note}" if p.note else ""
        lines.append(f'{i + 1}. {p.stack} @ {p.dir}: start_dev_server id="{_id_of(p.dir)}" command="{p.command}" '
                     f'args={json.dumps(p.args, separators=(",", ":"), ensure_ascii=False)} cwd="{p.dir}"{port}{guard}{note}')
    return "\n".join(lines + [f"note: {n}" for n in res.notes])


# ---- scanner (project/scan.ts) --------------------------------------------------

_SKIP_DIRS = {
    "node_modules", ".git", "target", "dist", "build", "out", "vendor", ".venv", "venv", "__pycache__",
    ".next", ".nuxt", ".svelte-kit", "deps", "_build", "bin", "obj", ".dart_tool", ".gradle", ".idea",
    ".vscode", ".agent-artifacts", "coverage", ".cache", "Pods", ".turbo", ".parcel-cache",
}
_MAX_DEPTH = 4
_MAX_FILES = 4000
_MAX_MANIFEST_BYTES = 64 * 1024


def scan_workspace(root: str) -> Files:
    """Read-only workspace listing for detect_projects: relative POSIX paths -> manifest content ("" otherwise).

    Stays inside ``root``: symlinks are never followed and nothing but manifests is ever read.
    """
    files: Files = {}
    count = 0

    def walk(abs_dir: str, rel: str, depth: int) -> None:
        nonlocal count
        try:
            entries = list(os.scandir(abs_dir))
        except OSError:
            return
        for e in entries:
            if count >= _MAX_FILES:
                return
            if e.is_symlink():
                continue
            child_rel = f"{rel}/{e.name}" if rel else e.name
            if e.is_dir(follow_symlinks=False):
                if depth < _MAX_DEPTH and e.name not in _SKIP_DIRS:
                    walk(e.path, child_rel, depth + 1)
            elif e.is_file(follow_symlinks=False):
                count += 1
                content = ""
                if is_manifest(e.name):
                    try:
                        if e.stat().st_size <= _MAX_MANIFEST_BYTES:
                            with open(e.path, encoding="utf-8", errors="replace") as fh:
                                content = fh.read()
                    except OSError:
                        pass  # unreadable manifest: still counts as present
                files[child_rel] = content

    walk(root, "", 0)
    return files
