/**
 * Toolchain rules for start_dev_server (Go, Rust, .NET, JVM, Elixir, ...).
 *
 * Same idea as interpreter-guard.ts, but for build tools whose command line can
 * do much more than "run my dev server": `go run -exec <prog>`, `cargo run
 * --config build.rustc-wrapper=<prog>`, `cargo watch -s "<shell>"`, `dotnet run
 * -p:RunCommand=<prog>`, `mvn -Dspring-boot.run.jvmArguments=-javaagent:...`,
 * `gradle -I init.gradle`, `mix run -e "<code>"`, `templ generate --cmd <prog>`.
 *
 * Allowing the *executable* must not mean allowing those. Each rule therefore
 * (1) restricts the first subcommand to the dev-loop ones, and (2) rejects the
 * flags / arguments that run other programs, load code from elsewhere, or
 * escape the workspace. Everything is fail-closed: an unknown shape is reported
 * as a reason, the caller classifies the command as "outside" and the default
 * `highRisk: deny` policy applies.
 *
 * Limitation (documented in the README): build scripts and project config
 * (`build.rs`, proc-macros, `.air.toml`, `Trunk.toml` hooks, Maven/Gradle build
 * files, `.cargo/config.toml`) execute project-owned code. That is the same trust
 * boundary as `npm run dev` running package.json scripts.
 */

/** Wrapper scripts that live in the project; when given a path it must stay inside the workspace. */
export const WRAPPER_COMMANDS = new Set(["mvnw", "gradlew"]);

interface Flag {
  /** Name without leading dashes, original case (`-Dx=1` → "Dx", value "1"). */
  name: string;
  value?: string;
}

interface Scanned {
  flags: Flag[];
  positionals: string[];
  /** Everything after `--` (or after the first positional when stopAtFirstPositional). */
  rest: string[];
  /** True when scanning stopped because of a literal `--`. */
  sawDashDash: boolean;
}

function parseFlag(a: string): Flag | undefined {
  if (!a.startsWith("-") || a === "-" || a === "--") return undefined;
  const body = a.replace(/^--?/, "");
  const eq = body.indexOf("=");
  return eq < 0 ? { name: body } : { name: body.slice(0, eq), value: body.slice(eq + 1) };
}

function scan(args: string[], valueFlags: ReadonlySet<string> = new Set(), stopAtFirstPositional = false): Scanned {
  const flags: Flag[] = [];
  const positionals: string[] = [];
  let rest: string[] = [];
  let sawDashDash = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      rest = args.slice(i + 1);
      sawDashDash = true;
      break;
    }
    const f = parseFlag(a);
    if (f) {
      if (f.value === undefined && valueFlags.has(f.name.toLowerCase()) && i + 1 < args.length) f.value = args[++i];
      flags.push(f);
      continue;
    }
    positionals.push(a);
    if (stopAtFirstPositional) {
      rest = args.slice(i + 1);
      break;
    }
  }
  return { flags, positionals, rest, sawDashDash };
}

/** Absolute, drive-letter, UNC, home-relative, or containing a `..` segment. */
export function isPathEscape(v: string): boolean {
  return /^(?:[a-zA-Z]:)?[\\/]/.test(v) || v.startsWith("~") || v.split(/[\\/]/).includes("..");
}

/** Properties that can inject JVM agents / executables / alternate settings. */
const DANGEROUS_PROPERTY =
  /(exec|agent|jvm-?arg|argline|main-?class|executable|working-?dir|java\.home|javahome|settings|toolchain|classpath|loader|command|script|maven\.(home|repo)|\.opts?$)/i;

function propertyOf(f: Flag): string | undefined {
  // `-Dkey=val` → name "Dkey"; `-D key=val` → name "D", value "key=val". Same for gradle `-P`.
  if (f.name[0] !== "D" && f.name[0] !== "P") return undefined;
  return f.name.length > 1 ? f.name.slice(1) : (f.value ?? "").split("=")[0];
}

function dangerousProperty(tool: string, flags: Flag[]): string | undefined {
  for (const f of flags) {
    const p = propertyOf(f);
    if (p && DANGEROUS_PROPERTY.test(p)) return `${tool}: property "${p}" can inject executables or JVM agents`;
  }
  return undefined;
}

function denyPathFlags(tool: string, flags: Flag[], names: string[]): string | undefined {
  for (const f of flags) {
    if (names.includes(f.name.toLowerCase()) && (f.value === undefined || isPathEscape(f.value))) {
      return `${tool}: --${f.name} must be a path inside the workspace`;
    }
  }
  return undefined;
}

function denyFlagNames(tool: string, flags: Flag[], names: string[], why: string): string | undefined {
  const hit = flags.find((f) => names.includes(f.name));
  return hit ? `${tool}: -${hit.name.length > 1 ? "-" : ""}${hit.name} ${why}` : undefined;
}

function onlySubcommands(tool: string, sub: string | undefined, allowed: string[]): string | undefined {
  if (sub !== undefined && allowed.includes(sub)) return undefined;
  return `${tool}: only \`${tool} ${allowed.join("|")}\` may be started here (got ${sub === undefined ? "no subcommand" : `"${sub}"`})`;
}

// ---- Go ---------------------------------------------------------------------

const GO_VALUE_FLAGS = new Set([
  "c", "o", "p", "tags", "mod", "modfile", "overlay", "pkgdir", "asmflags", "gcflags", "ldflags", "toolexec",
  "exec", "installsuffix", "compiler", "covermode", "coverpkg", "gccgoflags", "pgo", "buildmode",
]);

/** Only -X pkg.var=value, -s and -w are accepted: other linker flags can select an external linker / ELF interpreter. */
function goLdflagsReason(value: string): string | undefined {
  const toks = value.split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === "-X") i++;
    else if (toks[i] !== "-s" && toks[i] !== "-w") return `go: -ldflags "${toks[i]}" is not allowed (only -X, -s, -w)`;
  }
  return undefined;
}

function isLocalGoTarget(t: string): boolean {
  if (t.includes("@") || isPathEscape(t)) return false;
  return t === "." || t.startsWith("./") || t.startsWith(".\\") || t.endsWith(".go");
}

function goReason(args: string[]): string | undefined {
  const bad = onlySubcommands("go", args[0], ["run"]);
  if (bad) return bad;
  const { flags, positionals } = scan(args.slice(1), GO_VALUE_FLAGS, true);
  const denied = denyFlagNames("go", flags, ["exec", "toolexec", "C", "overlay", "modfile"], "runs another program or leaves the workspace");
  if (denied) return denied;
  for (const f of flags) {
    if (f.name.toLowerCase() === "ldflags") {
      const r = goLdflagsReason(f.value ?? "");
      if (r) return r;
    }
  }
  const target = positionals[0];
  if (target !== undefined && !isLocalGoTarget(target)) {
    return `go: "${target}" is not a local package (use ".", "./cmd/x" or a .go file); remote modules would be downloaded and executed`;
  }
  return undefined;
}

// ---- Rust -------------------------------------------------------------------

const CARGO_EXEC_OK = new Set(["run", "r", "check", "build", "test"]);

function cargoReason(args: string[]): string | undefined {
  const { flags, positionals, sawDashDash } = scan(args, new Set(["color", "manifest-path", "target-dir", "j", "jobs"]));
  for (const f of flags) {
    if (f.name === "config" || f.name === "C" || /^Z/.test(f.name)) {
      return `cargo: -${f.name.length > 1 ? "-" : ""}${f.name} can run other programs or enable unstable behaviour`;
    }
  }
  const paths = denyPathFlags("cargo", flags, ["manifest-path", "target-dir"]);
  if (paths) return paths;
  // `cargo +nightly run` — the toolchain selector is not a subcommand.
  const sub = positionals.find((p) => !p.startsWith("+"));
  const bad = onlySubcommands("cargo", sub, ["run", "r", "watch", "leptos"]);
  if (bad) return bad;
  const afterSub = positionals.slice(positionals.indexOf(sub as string) + 1);
  if (sub === "leptos" && !["watch", "serve"].includes(afterSub[0])) {
    return "cargo leptos: only `watch` and `serve` may be started here";
  }
  if (sub === "watch") return cargoWatchReason(args, sawDashDash);
  return undefined;
}

/** `cargo watch` can run arbitrary shell (-s) or any command after `--`; only `-x <cargo subcommand>` is accepted. */
function cargoWatchReason(args: string[], sawDashDash: boolean): string | undefined {
  if (sawDashDash) return "cargo watch: `--` runs an arbitrary command";
  const after = args.slice(args.indexOf("watch") + 1);
  for (let i = 0; i < after.length; i++) {
    const a = after[i];
    if (a === "--shell" || a.startsWith("--shell=")) return "cargo watch: --shell runs an arbitrary shell command";
    if (a.startsWith("--env") || /^-E/.test(a)) return "cargo watch: environment overrides (-E) can inject compiler wrappers";
    let exec: string | undefined;
    if (a === "--exec" || a === "-x") exec = after[++i];
    else if (a.startsWith("--exec=")) exec = a.slice(7);
    else if (a.startsWith("-x")) exec = a.slice(2);
    if (exec !== undefined) {
      const words = exec.trim().split(/\s+/);
      if (!CARGO_EXEC_OK.has(words[0])) return `cargo watch: -x "${words[0]}" is not a dev-loop cargo subcommand`;
      const inner = cargoReason(words);
      if (inner) return inner;
      continue;
    }
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(a)) return "cargo watch: -s runs an arbitrary shell command";
    if (/^-[A-Za-z]{2,}$/.test(a)) return `cargo watch: combined short flags (${a}) are not supported; pass them separately`;
  }
  return undefined;
}

function trunkReason(args: string[]): string | undefined {
  const { flags, positionals } = scan(args, new Set(["c", "config", "dist", "w", "watch", "i", "ignore"]));
  return onlySubcommands("trunk", positionals[0], ["serve", "watch"]) ?? denyPathFlags("trunk", flags, ["c", "config", "dist"]);
}

function dxReason(args: string[]): string | undefined {
  const { flags, positionals } = scan(args, new Set(["platform", "port", "addr", "package", "bin", "example", "features", "profile"]));
  return (
    onlySubcommands("dx", positionals[0], ["serve"]) ??
    denyFlagNames("dx", flags, ["cargo-args", "rustc-args", "config"], "passes arguments straight to cargo/rustc")
  );
}

// ---- Go helpers: air / templ / wails ----------------------------------------

function airReason(args: string[]): string | undefined {
  const { flags, positionals } = scan(args, new Set(["c"]), true);
  if (positionals.length) return `air: subcommand "${positionals[0]}" is not allowed; run plain \`air\``;
  const build = flags.find((f) => /^build\./.test(f.name));
  if (build) return `air: -${build.name} overrides the build/run command`;
  return denyPathFlags("air", flags, ["c"]);
}

function templReason(args: string[]): string | undefined {
  const { flags, positionals } = scan(args, new Set(["path", "f", "proxy", "proxybind", "proxyport", "cmd"]));
  return (
    onlySubcommands("templ", positionals[0], ["generate"]) ??
    denyFlagNames("templ", flags, ["cmd"], "runs an arbitrary command after generating")
  );
}

function wailsReason(args: string[]): string | undefined {
  const { flags, positionals } = scan(args, new Set(["tags", "ldflags", "compiler", "loglevel", "m", "e"]));
  return (
    onlySubcommands("wails", positionals[0], ["dev"]) ??
    denyFlagNames("wails", flags, ["ldflags", "compiler"], "selects an alternate linker/compiler binary")
  );
}

// ---- .NET -------------------------------------------------------------------

const DOTNET_VALUE_FLAGS = new Set([
  "project", "launch-profile", "lp", "c", "configuration", "f", "framework", "r", "runtime", "v", "verbosity", "arch", "os",
]);

function dotnetReason(args: string[]): string | undefined {
  const { flags, positionals } = scan(args, DOTNET_VALUE_FLAGS);
  // MSBuild properties can override what `run` executes (RunCommand / RunArguments).
  const prop = args
    .slice(0, args.includes("--") ? args.indexOf("--") : args.length)
    .find((a) => /^[-/]{1,2}(p|property)([:=]|$)/i.test(a));
  if (prop) return `dotnet: ${prop} sets MSBuild properties that can change what is executed`;
  const bad = onlySubcommands("dotnet", positionals[0], ["run", "watch"]);
  if (bad) return bad;
  if (positionals[0] === "watch" && positionals[1] !== undefined && positionals[1] !== "run") {
    return `dotnet watch: only \`dotnet watch [run]\` may be started here (got "${positionals[1]}")`;
  }
  return denyPathFlags("dotnet", flags, ["project"]);
}

// ---- JVM --------------------------------------------------------------------

const MVN_GOALS = new Set(["clean", "compile", "spring-boot:run", "quarkus:dev", "jetty:run", "mn:run", "tomcat7:run", "tomcat:run"]);
const MVN_VALUE_FLAGS = new Set(["pl", "rf", "t", "l", "b", "p", "projects", "resume-from", "threads", "log-file", "builder", "activate-profiles", "d"]);

function mvnReason(args: string[]): string | undefined {
  const { flags, positionals } = scan(args, MVN_VALUE_FLAGS);
  const alt = denyFlagNames("mvn", flags, ["f", "file", "s", "settings", "gs", "global-settings", "gt", "t", "toolchains"], "loads an alternate pom/settings file");
  if (alt) return alt;
  const prop = dangerousProperty("mvn", flags);
  if (prop) return prop;
  const goal = positionals.find((g) => !MVN_GOALS.has(g));
  if (goal !== undefined) return `mvn: goal "${goal}" is not a dev-loop goal (allowed: ${[...MVN_GOALS].join(", ")})`;
  return undefined;
}

const GRADLE_TASKS = new Set(["bootRun", "run", "quarkusDev", "jettyRun", "appRun", "clean", "classes"]);
const GRADLE_VALUE_FLAGS = new Set(["x", "exclude-task", "console", "warning-mode", "max-workers", "args"]);

function gradleReason(args: string[]): string | undefined {
  const { flags, positionals } = scan(args, GRADLE_VALUE_FLAGS);
  const alt = denyFlagNames(
    "gradle",
    flags,
    ["I", "init-script", "b", "build-file", "c", "settings-file", "g", "gradle-user-home", "p", "project-dir", "project-cache-dir", "include-build"],
    "loads scripts or projects from another location",
  );
  if (alt) return alt;
  const prop = dangerousProperty("gradle", flags);
  if (prop) return prop;
  const task = positionals.find((t) => !GRADLE_TASKS.has(t.slice(t.lastIndexOf(":") + 1)));
  if (task !== undefined) return `gradle: task "${task}" is not a dev-loop task (allowed: ${[...GRADLE_TASKS].join(", ")})`;
  return undefined;
}

// ---- Elixir -----------------------------------------------------------------

function mixReason(args: string[]): string | undefined {
  const { flags, positionals } = scan(args, new Set());
  return (
    onlySubcommands("mix", positionals[0], ["phx.server", "run"]) ??
    denyFlagNames("mix", flags, ["e", "eval", "r", "require", "pa", "pz", "pr"], "runs inline code or loads code from elsewhere")
  );
}

/** Returns a human-readable reason when this invocation is not a plain dev-loop run; undefined otherwise (or for unknown tools). */
export function toolchainReason(base: string, args: string[]): string | undefined {
  switch (base.toLowerCase()) {
    case "go": return goReason(args);
    case "cargo": return cargoReason(args);
    case "trunk": return trunkReason(args);
    case "dx": return dxReason(args);
    case "air": return airReason(args);
    case "templ": return templReason(args);
    case "wails": return wailsReason(args);
    case "dotnet": return dotnetReason(args);
    case "mvn":
    case "mvnw": return mvnReason(args);
    case "gradle":
    case "gradlew": return gradleReason(args);
    case "mix": return mixReason(args);
    default: return undefined;
  }
}
