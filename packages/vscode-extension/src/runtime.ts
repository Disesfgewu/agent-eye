import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { ENGINES, enginesFromListing, normalizeEngines, playwrightBrowsersDir, playwrightInstallArgs, type Engine } from "./browser-settings.js";

/**
 * Playwright is too large (and too native) to ship inside the .vsix, so it is
 * provisioned once into the extension's global storage on first run. The bundled
 * MCP server resolves it from there via AGENT_EYE_RUNTIME_DIR (see server-env.ts
 * / browser-manager loadChromium). The install runs programmatically (no
 * terminal), cross-platform.
 */
const PLAYWRIGHT_VERSION = "1.64.1";

let channel: vscode.OutputChannel | undefined;
function out(): vscode.OutputChannel {
  return (channel ??= vscode.window.createOutputChannel("Agent Eye"));
}

export function runtimeDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "runtime");
}

export function runtimeNodeModules(context: vscode.ExtensionContext): string {
  return path.join(runtimeDir(context), "node_modules");
}

export function isPlaywrightInstalled(context: vscode.ExtensionContext): boolean {
  return fs.existsSync(path.join(runtimeNodeModules(context), "playwright"));
}

/** Runs a command, streaming output to the Agent Eye channel. Resolves on exit
 * code 0, rejects otherwise. `shell:true` so Windows .cmd shims (npm/npx) work;
 * args are fixed constants here, so there is no injection surface. */
function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    out().appendLine(`\n$ ${cmd} ${args.join(" ")}  (cwd: ${cwd})`);
    const child = spawn(cmd, args, { cwd, shell: true, env: process.env });
    child.stdout?.on("data", (d: Buffer) => out().append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => out().append(d.toString()));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`\`${cmd}\` exited with code ${code}`))
    );
  });
}

/**
 * Installs Playwright + Chromium into the runtime dir, in-process, with a
 * progress notification. Cross-platform (Windows/macOS/Linux). Never requires
 * the user to type anything; falls back to opening a terminal only if it fails.
 */
/** The engine selected in settings (agentEye.browser). */
function configuredEngine(): Engine {
  const v = vscode.workspace.getConfiguration("agentEye").get<string>("browser", "chromium");
  return (ENGINES as readonly string[]).includes(v) ? (v as Engine) : "chromium";
}

/** Engines whose browser download exists (Playwright's shared browsers directory). */
export function installedEngines(): Engine[] {
  try {
    return enginesFromListing(fs.readdirSync(playwrightBrowsersDir(process.env, process.platform, os.homedir())));
  } catch {
    return [];
  }
}

/**
 * `engines` omitted = ask (multi-select quick pick, the configured engine pre-ticked).
 * Callers that want the one-click first-run flow pass the engines explicitly.
 */
export async function installRuntime(context: vscode.ExtensionContext, engines?: readonly string[]): Promise<void> {
  if (!engines) {
    const have = installedEngines();
    const wanted = configuredEngine();
    const picks = await vscode.window.showQuickPick(
      ENGINES.map((e) => ({
        label: e[0].toUpperCase() + e.slice(1),
        description: have.includes(e) ? "already installed (reinstall/update)" : undefined,
        picked: e === wanted || (e === "chromium" && !have.length),
        engine: e,
      })),
      { canPickMany: true, title: "Agent Eye: which browsers to install?", placeHolder: "Chromium is the default; add Firefox/WebKit for cross-browser checks" }
    );
    if (!picks) return; // cancelled
    engines = picks.map((p) => p.engine);
  }
  const targets = normalizeEngines(engines);
  const dir = runtimeDir(context);
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, "package.json");
  if (!fs.existsSync(pkg)) {
    fs.writeFileSync(pkg, JSON.stringify({ name: "agent-eye-runtime", private: true }, null, 2));
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Agent Eye: installing browser runtime", cancellable: false },
    async (progress) => {
      try {
        progress.report({ message: "installing Playwright…" });
        await run("npm", ["install", `playwright@${PLAYWRIGHT_VERSION}`], dir);
        // Download Chromium using the just-installed local Playwright.
        progress.report({ message: `downloading ${targets.join(", ")}… (this can take a minute)` });
        // Linux CI/servers also need system libs; --with-deps is a no-op where
        // not required and pulls them where it is. Falls back without deps.
        try {
          await run("npx", playwrightInstallArgs(targets, true), dir);
        } catch {
          await run("npx", playwrightInstallArgs(targets, false), dir);
        }
        void vscode.window.showInformationMessage(
          "Agent Eye: browser runtime is ready. Restart your agent (or reload its MCP servers) to use it."
        );
      } catch (err) {
        out().appendLine(`\nInstall failed: ${String(err)}`);
        const pick = await vscode.window.showErrorMessage(
          `Agent Eye: browser runtime install failed. ${String(err)}`,
          "Show log",
          "Open a terminal to retry"
        );
        if (pick === "Show log") out().show();
        if (pick === "Open a terminal to retry") {
          const t = vscode.window.createTerminal({ name: "Agent Eye Runtime", cwd: dir });
          t.show();
          t.sendText(`npm install playwright@${PLAYWRIGHT_VERSION}`);
          t.sendText(`npx ${playwrightInstallArgs(targets, false).join(" ")}`);
        }
      }
    }
  );
}

/** On first run, offers to install the browser runtime if it's missing. */
export async function ensureRuntimePrompt(context: vscode.ExtensionContext): Promise<void> {
  const engine = configuredEngine();
  if (isPlaywrightInstalled(context) && (engine === "chromium" || installedEngines().includes(engine))) return;
  const choice = await vscode.window.showInformationMessage(
    `Agent Eye needs a browser runtime (Playwright + ${engine[0].toUpperCase() + engine.slice(1)}) before it can drive a browser. Install it now? (~1 min)`,
    "Install now",
    "Later"
  );
  if (choice === "Install now") await installRuntime(context, [engine]);
}
