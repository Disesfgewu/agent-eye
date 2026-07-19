import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Playwright is too large (and too native) to ship inside the .vsix, so it is
 * provisioned once into the extension's global storage on first run. The
 * bundled MCP server resolves it via NODE_PATH (see server-env.ts). Browser
 * binaries are downloaded by the same step (`npx playwright install chromium`).
 */
const PLAYWRIGHT_VERSION = "1.61.1";

export function runtimeDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "runtime");
}

export function runtimeNodeModules(context: vscode.ExtensionContext): string {
  return path.join(runtimeDir(context), "node_modules");
}

export function isPlaywrightInstalled(context: vscode.ExtensionContext): boolean {
  return fs.existsSync(path.join(runtimeNodeModules(context), "playwright"));
}

/** Opens a terminal that installs Playwright + Chromium into the runtime dir. */
export function installRuntime(context: vscode.ExtensionContext): void {
  const dir = runtimeDir(context);
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, "package.json");
  if (!fs.existsSync(pkg)) {
    fs.writeFileSync(pkg, JSON.stringify({ name: "agent-eye-runtime", private: true }, null, 2));
  }
  const terminal = vscode.window.createTerminal({ name: "Agent Eye Runtime", cwd: dir });
  terminal.show();
  // Two separate lines instead of `&&`: Windows PowerShell (VS Code's default
  // terminal) rejects `&&`. An interactive shell runs these sequentially — the
  // second line waits in the buffer until the first command returns. Works in
  // PowerShell, pwsh, cmd, bash, and zsh.
  terminal.sendText(`npm install playwright@${PLAYWRIGHT_VERSION}`);
  terminal.sendText("npx playwright install chromium");
}

/** On first run, offers to install the browser runtime if it's missing. */
export async function ensureRuntimePrompt(context: vscode.ExtensionContext): Promise<void> {
  if (isPlaywrightInstalled(context)) return;
  const choice = await vscode.window.showInformationMessage(
    "Agent Eye needs a browser runtime (Playwright + Chromium) before it can drive a browser.",
    "Install now",
    "Later"
  );
  if (choice === "Install now") installRuntime(context);
}
