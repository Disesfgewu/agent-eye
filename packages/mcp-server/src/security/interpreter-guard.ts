import { djangoReason, phpArtisanReason, scan, toolchainReason } from "./toolchains.js";

/**
 * Interpreter hardening for start_dev_server. The command allowlist contains
 * interpreters (node, python, php, ruby, deno, bun) and package runners (npx,
 * dlx, bunx) because dev servers are launched through them. Allowing the
 * *executable* must not mean allowing *arbitrary code on the command line*:
 * `node -e "<code>"` or `npx some-random-package` would turn the `execute`
 * category into a code-execution primitive that bypasses the `highRisk` deny.
 *
 * `inlineCodeReason` returns a human-readable reason when an invocation runs
 * inline / remote / freshly-downloaded code; the caller then classifies it as
 * "outside" the allowlist (→ highRisk → denied by default). Normal dev usage
 * (`node server.js`, `python -m http.server 5500`, `npm run dev`, `npx serve`)
 * is unaffected.
 *
 * Limitation (documented in the README): this cannot stop an agent that can also
 * edit project files (e.g. rewrite package.json scripts) and then run them.
 */

/** Package runners may only fetch/run these well-known dev servers/tools. */
const RUNNER_ALLOWED_PACKAGES = new Set([
  "serve", "http-server", "live-server", "lite-server", "browser-sync", "light-server",
  "sirv-cli", "vite", "next", "nuxt", "astro", "ng", "webpack", "webpack-dev-server",
  "parcel", "storybook", "wrangler", "expo", "http-server-spa", "five-server",
]);

const NODE_EVAL = /^(-e|--eval(=.*)?|-p|--print(=.*)?|-pe|-r|--require(=.*)?|--import(=.*)?|--input-type(=.*)?|--inspect(-brk|-wait)?(=.*)?|-)$/;

function stripVersion(pkg: string): string {
  // "serve@14.2.0" → "serve"; "@scope/pkg@1" keeps its scope.
  const at = pkg.lastIndexOf("@");
  return at > 0 ? pkg.slice(0, at) : pkg;
}

/** Looks like the program the interpreter will run (everything after it is the program's own argv). */
const SCRIPT_LIKE = /\.(m?js|cjs|ts|mts|py|pyw|php|rb)$/i;

/**
 * Interpreter options: every argument before the script (or `-m module`). Option
 * *values* (e.g. `--max-old-space-size 4096`) are included on purpose, so an
 * eval flag can't hide behind a valued option; the cost is occasional false
 * positives, which fail closed (→ "outside" → denied by default).
 */
function leadingFlags(args: string[], stopAtModule = false): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (SCRIPT_LIKE.test(a) || (stopAtModule && a === "-m")) break;
    out.push(a);
  }
  return out;
}

/** Options of npm/pnpm/yarn whose value is not a package name (so `--filter web` is not read as installing "web"). */
const PM_VALUE_FLAGS = new Set(["prefix", "filter", "workspace", "dir", "loglevel", "cwd", "c", "w"]);

/** `npm install <pkg>` / `pnpm add <pkg>` download and run third-party install scripts; `create`/`init <x>` run a remote template. */
function installReason(tool: string, args: string[]): string | undefined {
  const idx = args.findIndex((a) => ["install", "i", "add", "create", "init"].includes(a));
  if (idx < 0) return undefined;
  const sub = args[idx];
  const named = scan(args.slice(idx + 1), PM_VALUE_FLAGS).positionals;
  if (sub === "create") return `${tool} create runs a remote project template`;
  if (sub === "init") return named.length ? `${tool} init ${named[0]} runs a remote initializer package` : undefined;
  return named.length ? `${tool} ${sub} ${named[0]}: installing named packages downloads and runs third-party install scripts (a plain \`${tool} install\` from the lockfile is fine)` : undefined;
}

function runnerReason(tool: string, args: string[]): string | undefined {
  // npm/pnpm/yarn: only their exec/dlx forms download-and-run packages. Look for
  // the subcommand ANYWHERE (an option value like `--prefix web` may precede it).
  const subs = tool === "npm" ? ["exec", "x"] : tool === "pnpm" ? ["dlx", "exec"] : ["dlx"];
  const idx = args.findIndex((a) => subs.includes(a));
  if (idx < 0) return installReason(tool, args);
  return packageRunnerReason(tool, args.slice(idx + 1)) ?? installReason(tool, args);
}

function packageRunnerReason(tool: string, args: string[]): string | undefined {
  // Only options BEFORE the package name are the runner's own (after it, `-p 5500`
  // is the dev server's port flag, not npx's --package).
  const firstPositional = args.findIndex((a) => !a.startsWith("-"));
  const own = firstPositional < 0 ? args : args.slice(0, firstPositional);
  if (own.some((a) => a === "-c" || a === "--call" || a === "-p" || a === "--package" || a.startsWith("--package=") || a.startsWith("--call="))) {
    return `${tool}: -c/--call/--package run arbitrary commands or packages`;
  }
  const pkg = firstPositional < 0 ? undefined : args[firstPositional];
  if (pkg === undefined) return undefined;
  if (/^(https?:|git\+|github:|file:|\.{0,2}\/)/.test(pkg)) {
    return `${tool}: running a package from a URL or path is not allowed`;
  }
  if (!RUNNER_ALLOWED_PACKAGES.has(stripVersion(pkg))) {
    return `${tool}: "${pkg}" is not a known dev-server package; it would be downloaded and executed`;
  }
  return undefined;
}

/** Modules that are dev servers; anything else under `python -m` can run inline code (`timeit`) or install packages (`pip`). */
const PY_MODULE_OK = new Set(["http.server", "flask", "uvicorn", "gunicorn", "django", "hypercorn", "daphne", "streamlit", "mkdocs", "sphinx_autobuild", "fastapi"]);

function pythonTargetReason(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) continue;
    if (a.startsWith("-")) {
      const m = /^-[A-Za-z]*m(.*)$/.exec(a); // -m mod, -Im mod, -mmod
      if (!m) continue;
      const mod = m[1] || args[i + 1];
      const rest = args.slice(m[1] ? i + 1 : i + 2);
      if (mod === undefined) return undefined;
      if (!PY_MODULE_OK.has(mod)) return `python -m ${mod}: only dev-server modules may be run (${[...PY_MODULE_OK].join(", ")})`;
      if (mod === "flask") return toolchainReason("flask", rest);
      if (mod === "django") return djangoReason(rest);
      if (mod === "uvicorn") return toolchainReason("uvicorn", rest);
      return undefined;
    }
    if (SCRIPT_LIKE.test(a)) return /(^|[\\/])manage\.py$/.test(a) ? djangoReason(args.slice(i + 1)) : undefined;
  }
  return undefined;
}

export function inlineCodeReason(base: string, args: string[]): string | undefined {
  const cmd = base.toLowerCase();
  const flags = leadingFlags(args);

  switch (cmd) {
    case "node":
    case "nodejs": {
      const bad = flags.find((f) => NODE_EVAL.test(f));
      return bad ? `node ${bad} runs inline code / opens a debugger` : undefined;
    }
    case "python":
    case "python3":
    case "py": {
      // -c <code>, possibly clustered (-Ic); a bare "-" reads the program from stdin.
      const bad = leadingFlags(args, true).find((f) => f === "-" || (/^-[A-Za-z]+$/.test(f) && f.slice(1).includes("c")));
      return bad ? `python ${bad} runs inline code` : pythonTargetReason(args);
    }
    case "php": {
      const bad = flags.find((f) => /^-[rRBEF]$/.test(f));
      return bad ? `php ${bad} runs inline code` : phpArtisanReason(args);
    }
    case "ruby": {
      const bad = flags.find((f) => f === "-e" || /^-[A-Za-z]*e$/.test(f) || f === "-");
      return bad ? `ruby ${bad} runs inline code` : undefined;
    }
    case "deno": {
      const sub = args.find((a) => !a.startsWith("-"));
      if (sub === "eval" || sub === "repl") return `deno ${sub} runs inline code`;
      if (args.some((a) => /^(https?:\/\/|npm:|jsr:|data:)/i.test(a))) return "deno: running remote code from a URL or package specifier is not allowed";
      return undefined;
    }
    case "bun": {
      const bad = flags.find((f) => /^(-e|--eval(=.*)?|-p|--print(=.*)?)$/.test(f));
      if (bad) return `bun ${bad} runs inline code`;
      const sub = args.find((a) => !a.startsWith("-"));
      if (sub === "create" || sub === "repl") return `bun ${sub} runs a remote template / inline code`;
      return sub === "x" ? packageRunnerReason("bun x", args.slice(args.indexOf("x") + 1)) : undefined;
    }
    case "npx":
    case "bunx":
      return packageRunnerReason(cmd, args);
    case "npm":
    case "pnpm":
    case "yarn":
      return runnerReason(cmd, args);
    default:
      // Go / Rust / .NET / JVM / Elixir launchers: see toolchains.ts.
      return toolchainReason(cmd, args);
  }
}
