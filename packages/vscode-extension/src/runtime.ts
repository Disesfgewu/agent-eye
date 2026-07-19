import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";

/**
 * Playwright is too large (and too native) to ship inside the .vsix, so it is
 * provisioned once into the extension's global storage on first run. The bundled
 * MCP server resolves it from there via AGENT_EYE_RUNTIME_DIR (see server-env.ts
 * / browser-manager loadChromium). The install runs programmatically (no
 * terminal), cross-platform.
 */
const PLAYWRIGHT_VERSION = "1.61.1";

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
export async function installRuntime(context: vscode.ExtensionContext): Promise<void> {
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
        progress.report({ message: "downloading Chromium… (this can take a minute)" });
        // Linux CI/servers also need system libs; --with-deps is a no-op where
        // not required and pulls them where it is. Falls back without deps.
        try {
          await run("npx", ["playwright", "install", "--with-deps", "chromium"], dir);
        } catch {
          await run("npx", ["playwright", "install", "chromium"], dir);
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
          t.sendText("npx playwright install chromium");
        }
      }
    }
  );
}

/** On first run, offers to install the browser runtime if it's missing. */
export async function ensureRuntimePrompt(context: vscode.ExtensionContext): Promise<void> {
  if (isPlaywrightInstalled(context)) return;
  const choice = await vscode.window.showInformationMessage(
    "Agent Eye needs a browser runtime (Playwright + Chromium) before it can drive a browser. Install it now? (~1 min)",
    "Install now",
    "Later"
  );
  if (choice === "Install now") await installRuntime(context);
}
