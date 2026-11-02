import { toolchainReason } from "./toolchains.js";

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

function runnerReason(tool: string, args: string[]): string | undefined {
  // npm/pnpm/yarn: only their exec/dlx forms download-and-run packages. Look for
  // the subcommand ANYWHERE (an option value like `--prefix web` may precede it).
  const subs = tool === "npm" ? ["exec", "x"] : tool === "pnpm" ? ["dlx", "exec"] : ["dlx"];
  const idx = args.findIndex((a) => subs.includes(a));
  if (idx < 0) return undefined;
  return packageRunnerReason(tool, args.slice(idx + 1));
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
      return bad ? `python ${bad} runs inline code` : undefined;
    }
    case "php": {
      const bad = flags.find((f) => /^-[rRBEF]$/.test(f));
      return bad ? `php ${bad} runs inline code` : undefined;
    }
    case "ruby": {
      const bad = flags.find((f) => f === "-e" || /^-[A-Za-z]*e$/.test(f) || f === "-");
      return bad ? `ruby ${bad} runs inline code` : undefined;
    }
    case "deno": {
      const sub = args.find((a) => !a.startsWith("-"));
      if (sub === "eval" || sub === "repl") return `deno ${sub} runs inline code`;
      if (args.some((a) => /^https?:\/\//i.test(a))) return "deno: running remote code from a URL is not allowed";
      return undefined;
    }
    case "bun": {
      const bad = flags.find((f) => /^(-e|--eval(=.*)?|-p|--print(=.*)?)$/.test(f));
      if (bad) return `bun ${bad} runs inline code`;
      const sub = args.find((a) => !a.startsWith("-"));
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
