/**
 * Project detection (Issue #22). Pure: given a map of workspace-relative POSIX
 * paths → file content (content only for known manifests, "" otherwise) it
 * returns the exact `start_dev_server` arguments for each runnable project, so
 * an agent does not burn turns reading manifests and guessing commands/ports.
 *
 * Every suggestion must be accepted by the command guard under the default
 * policy; a unit test enforces that, so detection can never recommend a command
 * the server would then refuse.
 */
export interface DetectedProject {
  /** Workspace-relative directory ("." for the root). Use as `cwd`. */
  dir: string;
  /** Short label, e.g. "Go · Gin" or "Rust · Leptos (SSR)". */
  stack: string;
  command: string;
  args: string[];
  /** Expected port, when known. */
  port?: number;
  /** Where `port` came from. */
  portSource?: "config" | "typical";
  note?: string;
}

export interface DetectResult {
  projects: DetectedProject[];
  /** Things worth knowing that are not startable (e.g. native shells). */
  notes: string[];
}

export interface DetectOptions {
  /** Defaults to process.platform; decides `mvnw` vs `./mvnw` and python vs python3. */
  platform?: string;
  maxProjects?: number;
}

const MANIFESTS = [
  "package.json", "go.mod", "Cargo.toml", "pubspec.yaml", "pom.xml", "build.gradle", "build.gradle.kts",
  "mix.exs", "composer.json", "Gemfile", "requirements.txt", "pyproject.toml", "launchSettings.json",
  "deno.json", "deno.jsonc",
];
/** Basenames whose CONTENT the scanner should load (everything else is existence-only). */
export function isManifest(basename: string): boolean {
  return MANIFESTS.includes(basename) || basename.endsWith(".csproj");
}

type Files = Record<string, string>;

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const join = (dir: string, name: string) => (dir === "." ? name : `${dir}/${name}`);
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const idOf = (dir: string) => (dir === "." ? "app" : baseOf(dir));

function json(text: string | undefined): any {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** True when `[dependencies]`-style TOML text declares crate `name` (`x = "1"`, `x = {…}`, `x.workspace = true`). */
const hasCrate = (toml: string, name: string) => new RegExp(`^\\s*${name.replace(/[-]/g, "[-_]")}\\s*(=|\\.)`, "m").test(toml);

function portFromScript(script: string | undefined): number | undefined {
  const m = /(?:--port|-p|PORT=)[ =]?(\d{2,5})\b/.exec(script ?? "");
  return m ? Number(m[1]) : undefined;
}

// ---- per-ecosystem detectors -------------------------------------------------

function nodeProject(dir: string, text: string, files: Files): DetectedProject | undefined {
  const pkg = json(text);
  if (!pkg || typeof pkg !== "object") return undefined;
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const script = ["dev", "start", "serve", "develop"].find((s) => typeof scripts[s] === "string");
  if (!script) return undefined;
  const has = (n: string) => n in deps;
  const frameworks: Array<[string[], string, number | undefined]> = [
    [["next"], "Next.js", 3000], [["nuxt", "nuxt3"], "Nuxt", 3000], [["astro"], "Astro", 4321],
    [["@angular/core", "@angular/cli"], "Angular", 4200], [["@sveltejs/kit"], "SvelteKit", 5173],
    [["@remix-run/dev", "@remix-run/react"], "Remix", undefined], [["gatsby"], "Gatsby", 8000],
    [["react-scripts"], "Create React App", 3000], [["expo"], "Expo (web)", 8081],
    [["vite"], "Vite", 5173], [["@vue/cli-service"], "Vue CLI", 8080], [["parcel"], "Parcel", 1234],
    [["webpack-dev-server"], "webpack dev server", 8080],
  ];
  const hit = frameworks.find(([names]) => names.some(has));
  const ui = has("react") ? "React" : has("vue") ? "Vue" : has("svelte") ? "Svelte" : has("solid-js") ? "Solid" : undefined;
  const label = hit ? (hit[1] === "Vite" && ui ? `Vite · ${ui}` : hit[1]) : "Node";
  const sibling = (n: string) => n in files && dirOf(n) === dir;
  const pm = sibling(join(dir, "pnpm-lock.yaml")) ? "pnpm" : sibling(join(dir, "yarn.lock")) ? "yarn"
    : sibling(join(dir, "bun.lockb")) || sibling(join(dir, "bun.lock")) ? "bun" : "npm";
  const args = pm === "yarn" || pm === "pnpm" ? [script] : ["run", script];
  const fromScript = portFromScript(scripts[script]);
  const port = fromScript ?? hit?.[2];
  return {
    dir, stack: label, command: pm, args,
    ...(port ? { port, portSource: fromScript ? ("config" as const) : ("typical" as const) } : {}),
  };
}

function goProject(dir: string, mod: string, files: Files): DetectedProject | undefined {
  const at = (n: string) => join(dir, n) in files;
  const cmds = Object.keys(files)
    .filter((p) => p.startsWith(join(dir, "cmd/")) && p.endsWith("/main.go") && p.split("/").length === join(dir, "cmd/x/main.go").split("/").length)
    .map((p) => p.split("/").slice(-2)[0])
    .sort();
  const web: Array<[string, string, number | undefined]> = [
    ["gin-gonic/gin", "Gin", 8080], ["labstack/echo", "Echo", 1323], ["gofiber/fiber", "Fiber", 3000],
    ["go-chi/chi", "chi", undefined], ["gorilla/mux", "gorilla/mux", undefined], ["beego/beego", "Beego", 8080],
    ["a-h/templ", "templ", undefined], ["wailsapp/wails", "Wails", undefined],
  ];
  const fw = web.filter(([m]) => mod.includes(m));
  const label = ["Go", ...fw.map((f) => f[1])].join(" · ");
  const typical = fw.find((f) => f[2])?.[2];
  const templNote = fw.some((f) => f[1] === "templ") || Object.keys(files).some((p) => p.endsWith(".templ"))
    ? "templ: keep `*_templ.go` generated (`templ generate`) or run `templ generate --watch --proxy=http://localhost:PORT` as a second server."
    : undefined;
  if (at("wails.json")) {
    return { dir, stack: label, command: "wails", args: ["dev"], port: 34115, portSource: "typical",
      note: "Wails also opens a native window; Agent Eye drives its browser dev server on :34115." };
  }
  if (at(".air.toml")) {
    return { dir, stack: `${label} (air live-reload)`, command: "air", args: [], ...(typical ? { port: typical, portSource: "typical" as const } : {}), note: templNote };
  }
  const entry = at("main.go") ? "." : cmds.length ? `./cmd/${cmds[0]}` : undefined;
  if (!entry) return undefined;
  const others = at("main.go") ? [] : cmds.slice(1);
  const note = [templNote, others.length ? `other entry points: ${others.map((c) => `./cmd/${c}`).join(", ")}` : undefined].filter(Boolean).join(" ");
  return { dir, stack: label, command: "go", args: ["run", entry], ...(typical ? { port: typical, portSource: "typical" as const } : {}), ...(note ? { note } : {}) };
}

function rustProject(dir: string, toml: string, files: Files, notes: string[]): DetectedProject | undefined {
  if (!/^\s*\[package\]/m.test(toml)) return undefined; // pure workspace manifest: members are scanned on their own
  const at = (n: string) => join(dir, n) in files;
  if (hasCrate(toml, "tauri")) {
    notes.push(`${dir}: Tauri app — the native window cannot be driven; start its web frontend dev server instead.`);
    return undefined;
  }
  if (at("Dioxus.toml") || hasCrate(toml, "dioxus")) {
    return { dir, stack: "Rust · Dioxus", command: "dx", args: ["serve"], port: 8080, portSource: "typical", note: "Needs the `dx` CLI (cargo install dioxus-cli)." };
  }
  if (hasCrate(toml, "leptos")) {
    const ssr = /\[package\.metadata\.leptos\]/.test(toml) || hasCrate(toml, "leptos_axum") || hasCrate(toml, "leptos_actix");
    return ssr
      ? { dir, stack: "Rust · Leptos (SSR)", command: "cargo", args: ["leptos", "watch"], port: 3000, portSource: "typical", note: "Needs cargo-leptos." }
      : { dir, stack: "Rust · Leptos (CSR)", command: "trunk", args: ["serve"], port: 8080, portSource: "typical", note: "Needs trunk + the wasm32-unknown-unknown target." };
  }
  const wasm = ["yew", "sycamore", "seed", "percy-dom", "dominator"].find((c) => hasCrate(toml, c));
  if (wasm || at("Trunk.toml")) {
    return { dir, stack: `Rust · ${wasm ?? "wasm"} (Trunk)`, command: "trunk", args: ["serve"], port: 8080, portSource: "typical", note: "Needs trunk + the wasm32-unknown-unknown target." };
  }
  const servers: Array<[string, string, number | undefined]> = [
    ["axum", "Axum", 3000], ["actix-web", "Actix Web", 8080], ["rocket", "Rocket", 8000], ["warp", "Warp", 3030],
    ["poem", "Poem", 3000], ["salvo", "Salvo", 5800], ["tide", "Tide", 8080],
  ];
  const srv = servers.find(([c]) => hasCrate(toml, c));
  if (!srv && !at("src/main.rs") && !/^\s*\[\[bin\]\]/m.test(toml)) return undefined; // library crate
  return {
    dir, stack: srv ? `Rust · ${srv[1]}` : "Rust", command: "cargo", args: ["run"],
    ...(srv?.[2] ? { port: srv[2], portSource: "typical" as const } : {}),
    note: "Rebuilds on each start; use `cargo watch -x run` (needs cargo-watch) for hot reload.",
  };
}

function dotnetProject(dir: string, csproj: string, files: Files): DetectedProject | undefined {
  const web = /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(csproj);
  const blazor = /Sdk="Microsoft\.NET\.Sdk\.BlazorWebAssembly"/.test(csproj);
  if (!web && !blazor) return undefined;
  const settings = json(files[join(dir, "Properties/launchSettings.json")]);
  const urls: string[] = Object.values<any>(settings?.profiles ?? {})
    .filter((p) => p?.commandName === "Project" && typeof p.applicationUrl === "string")
    .flatMap((p) => String(p.applicationUrl).split(";"));
  const url = urls.find((u) => u.startsWith("http://")) ?? urls[0];
  const port = url ? Number(/:(\d{2,5})/.exec(url)?.[1]) || undefined : undefined;
  return {
    dir, stack: blazor ? ".NET · Blazor WebAssembly" : ".NET · ASP.NET Core", command: "dotnet", args: ["run"],
    port: port ?? 5000, portSource: port ? "config" : "typical",
    note: "`dotnet watch run` adds hot reload.",
  };
}

/** Path to the nearest project wrapper script (mvnw/gradlew) in `dir` or an ancestor, relative to `dir`; else the bare tool. */
function wrapperFor(dir: string, wrapper: string, fallback: string, files: Files, platform: string): string {
  const win = platform === "win32";
  const parts = dir === "." ? [] : dir.split("/");
  for (let up = 0; up <= parts.length; up++) {
    const anc = parts.slice(0, parts.length - up).join("/") || ".";
    if (join(anc, wrapper) in files) {
      if (up === 0) return win ? wrapper : `./${wrapper}`;
      return (win ? "..\\" : "../").repeat(up) + wrapper;
    }
  }
  return fallback;
}

function jvmProject(dir: string, files: Files, platform: string): DetectedProject | undefined {
  const pom = files[join(dir, "pom.xml")];
  const gradle = files[join(dir, "build.gradle")] ?? files[join(dir, "build.gradle.kts")];
  if (pom !== undefined) {
    const cmd = wrapperFor(dir, "mvnw", "mvn", files, platform);
    const goal = /spring-boot/.test(pom) ? ["spring-boot:run", "Spring Boot"] : /quarkus/.test(pom) ? ["quarkus:dev", "Quarkus"]
      : /micronaut/.test(pom) ? ["mn:run", "Micronaut"] : undefined;
    if (goal) return { dir, stack: `Java · ${goal[1]} (Maven)`, command: cmd, args: [goal[0]], port: 8080, portSource: "typical" };
  }
  if (gradle !== undefined) {
    const cmd = wrapperFor(dir, "gradlew", "gradle", files, platform);
    const task = /org\.springframework\.boot/.test(gradle) ? ["bootRun", "Spring Boot"] : /io\.quarkus/.test(gradle) ? ["quarkusDev", "Quarkus"]
      : /io\.micronaut/.test(gradle) ? ["run", "Micronaut"] : undefined;
    if (task) return { dir, stack: `JVM · ${task[1]} (Gradle)`, command: cmd, args: [task[0]], port: 8080, portSource: "typical" };
  }
  return undefined;
}

function pythonProject(dir: string, files: Files, platform: string): DetectedProject | undefined {
  const at = (n: string) => join(dir, n) in files;
  const py = platform === "win32" ? "python" : "python3";
  if (at("manage.py")) {
    return { dir, stack: "Python · Django", command: py, args: ["manage.py", "runserver"], port: 8000, portSource: "typical" };
  }
  const deps = `${files[join(dir, "requirements.txt")] ?? ""}\n${files[join(dir, "pyproject.toml")] ?? ""}`.toLowerCase();
  if (/\bfastapi\b/.test(deps) && at("main.py")) {
    return { dir, stack: "Python · FastAPI", command: "uvicorn", args: ["main:app", "--reload"], port: 8000, portSource: "typical", note: "Assumes the app object is `app` in main.py." };
  }
  if (/\bflask\b/.test(deps) && (at("app.py") || at("wsgi.py"))) {
    return { dir, stack: "Python · Flask", command: "flask", args: ["run"], port: 5000, portSource: "typical" };
  }
  return undefined;
}

/**
 * Directory names come from the file system and end up in the model's context, so a
 * hostile repo could try to smuggle instructions through them. Accept only short,
 * plain path segments (letters, digits, `. _ @ + -`, at most 3 spaces); paths with
 * anything else are ignored rather than echoed.
 */
const SAFE_SEGMENT = /^(?!(?:.*? ){4})[\w.@+-][\w.@+ -]{0,39}$/;
export const isSafePath = (p: string) => p.length <= 160 && p.split("/").every((s) => SAFE_SEGMENT.test(s));

/** Detects runnable projects (depth is limited by what the scanner provides). */
export function detectProjects(rawFiles: Files, opts: DetectOptions = {}): DetectResult {
  const files: Files = Object.fromEntries(Object.entries(rawFiles).filter(([p]) => isSafePath(p)));
  const platform = opts.platform ?? process.platform;
  const notes: string[] = [];
  const found: DetectedProject[] = [];
  const add = (p: DetectedProject | undefined) => p && found.push(p);

  for (const path of Object.keys(files).sort()) {
    const dir = dirOf(path);
    const base = baseOf(path);
    const text = files[path];
    const at = (n: string) => join(dir, n) in files;
    switch (base) {
      case "package.json": add(nodeProject(dir, text, files)); break;
      case "go.mod": add(goProject(dir, text, files)); break;
      case "Cargo.toml": add(rustProject(dir, text, files, notes)); break;
      case "mix.exs":
        if (/:phoenix\b/.test(text)) add({ dir, stack: "Elixir · Phoenix", command: "mix", args: ["phx.server"], port: 4000, portSource: "typical" });
        break;
      case "composer.json":
        if (/laravel\/framework/.test(text)) add({ dir, stack: "PHP · Laravel", command: "php", args: ["artisan", "serve"], port: 8000, portSource: "typical" });
        break;
      case "Gemfile":
        if (/\brails\b/.test(text)) add({ dir, stack: "Ruby · Rails", command: "rails", args: ["server"], port: 3000, portSource: "typical" });
        else if (/\bjekyll\b/.test(text)) add({ dir, stack: "Ruby · Jekyll", command: "jekyll", args: ["serve"], port: 4000, portSource: "typical" });
        break;
      case "pubspec.yaml":
        if (/sdk:\s*flutter/.test(text) && at("web/index.html")) {
          add({ dir, stack: "Flutter web", command: "flutter", args: ["run", "-d", "web-server", "--web-port", "5500"], port: 5500, portSource: "config",
            note: "Canvas UI: use screenshots + browser_click_at. For stable checks prefer `flutter build web` + a static server." });
        }
        break;
      case "deno.json":
      case "deno.jsonc": {
        const tasks = json(text)?.tasks;
        if (tasks && typeof tasks.dev === "string") add({ dir, stack: "Deno", command: "deno", args: ["task", "dev"] });
        break;
      }
      case "pom.xml":
        add(jvmProject(dir, files, platform));
        break;
      case "build.gradle":
        if (!at("pom.xml")) add(jvmProject(dir, files, platform));
        break;
      case "build.gradle.kts":
        if (!at("pom.xml") && !at("build.gradle")) add(jvmProject(dir, files, platform));
        break;
      case "requirements.txt":
      case "pyproject.toml":
        if (!(at("requirements.txt") && base === "pyproject.toml")) add(pythonProject(dir, files, platform));
        break;
      default:
        if (base.endsWith(".csproj")) add(dotnetProject(dir, text, files));
    }
  }
  // Django without requirements/pyproject still has manage.py.
  for (const path of Object.keys(files)) {
    if (baseOf(path) === "manage.py" && !found.some((p) => p.dir === dirOf(path) && p.stack.startsWith("Python"))) add(pythonProject(dirOf(path), files, platform));
  }
  // Plain static site at the root.
  if ("index.html" in files && !found.some((p) => p.dir === ".")) {
    const py = platform === "win32" ? "python" : "python3";
    add({ dir: ".", stack: "Static HTML", command: py, args: ["-m", "http.server", "5500"], port: 5500, portSource: "config" });
  }

  const seen = new Set<string>();
  const projects = found
    .filter((p) => {
      const key = `${p.dir}|${p.command}|${p.args.join(" ")}`;
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .sort((a, b) => a.dir.split("/").length - b.dir.split("/").length || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
    .slice(0, opts.maxProjects ?? 12);
  return { projects, notes };
}

/** One compact line per project; `verdict` is filled by the caller from the command guard. */
export function formatDetected(res: DetectResult, verdicts: (string | undefined)[] = []): string {
  if (!res.projects.length && !res.notes.length) {
    return "No runnable project found (looked for package.json, go.mod, Cargo.toml, *.csproj, pom.xml, build.gradle, mix.exs, composer.json, Gemfile, pubspec.yaml, manage.py, index.html up to 3 levels deep). Ask the user how to start it, then call start_dev_server directly.";
  }
  const lines = res.projects.map((p, i) => {
    const port = p.port ? ` port=${p.port}${p.portSource === "typical" ? " (typical)" : ""}` : "";
    const guard = verdicts[i] ? ` [NOT STARTABLE: ${verdicts[i]}]` : "";
    const id = idOf(p.dir);
    return `${i + 1}. ${p.stack} @ ${p.dir}: start_dev_server id="${id}" command="${p.command}" args=${JSON.stringify(p.args)} cwd="${p.dir}"${port}${guard}${p.note ? `\n   note: ${p.note}` : ""}`;
  });
  return [...lines, ...res.notes.map((n) => `note: ${n}`)].join("\n");
}
