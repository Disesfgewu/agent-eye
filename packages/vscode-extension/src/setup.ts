import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { resolveServerEntry } from "./server-path.js";
import { buildServerEnv } from "./server-env.js";

const IGNORE_ENTRIES = [".agent-artifacts/", ".agent-eye/"];

/**
 * Writes/merges a `.mcp.json` at the workspace root so MCP clients that read it
 * (Claude Code, Cursor) auto-discover the Agent Eye server, and makes sure the
 * runtime artifact/state dirs are gitignored (plan 7.6).
 */
export async function setupForClaudeCode(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("Agent Eye: open a folder/workspace first.");
    return;
  }
  const workspaceRoot = folder.uri.fsPath;

  const serverEntry = resolveServerEntry(context.extensionPath);
  if (!serverEntry) {
    void vscode.window.showErrorMessage(
      "Agent Eye: MCP server build not found. Run `npm run build` in the agent-eye repo first."
    );
    return;
  }

  const mcpJsonPath = path.join(workspaceRoot, ".mcp.json");
  const config = readJsonSafe(mcpJsonPath);
  const mcpServers = (config.mcpServers ??= {} as Record<string, unknown>);
  (mcpServers as Record<string, unknown>)["agent-eye"] = {
    command: "node",
    args: [serverEntry, "--workspace", workspaceRoot],
    env: buildServerEnv(context),
  };

  try {
    fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  } catch (err) {
    void vscode.window.showErrorMessage(`Agent Eye: failed to write .mcp.json — ${String(err)}`);
    return;
  }

  ensureGitignore(workspaceRoot);

  const choice = await vscode.window.showInformationMessage(
    "Agent Eye: wrote .mcp.json. Restart Claude Code (or reload its MCP servers) to pick up the `agent-eye` tools.",
    "Open .mcp.json"
  );
  if (choice === "Open .mcp.json") {
    const doc = await vscode.workspace.openTextDocument(mcpJsonPath);
    await vscode.window.showTextDocument(doc);
  }
}

function readJsonSafe(file: string): { mcpServers?: Record<string, unknown> } {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    void vscode.window.showWarningMessage(
      "Agent Eye: existing .mcp.json is not valid JSON; it will be replaced."
    );
  }
  return {};
}

function ensureGitignore(workspaceRoot: string): void {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  let content = "";
  try {
    if (fs.existsSync(gitignorePath)) content = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    return;
  }
  const lines = content.split(/\r?\n/);
  const missing = IGNORE_ENTRIES.filter(
    (entry) => !lines.some((l) => l.trim() === entry || l.trim() === entry.replace(/\/$/, ""))
  );
  if (missing.length === 0) return;
  const addition =
    (content.endsWith("\n") || content === "" ? "" : "\n") +
    "\n# Agent Eye runtime artifacts (may contain test credentials / internal URLs)\n" +
    missing.join("\n") +
    "\n";
  try {
    fs.appendFileSync(gitignorePath, addition, "utf8");
  } catch {
    /* best-effort */
  }
}
