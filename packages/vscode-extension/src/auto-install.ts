import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { resolveServerEntry } from "./server-path.js";
import { buildServerEnv } from "./server-env.js";

/**
 * Installs the Agent Eye skill + MCP registration into AI agents' GLOBAL config
 * automatically on first activation, so the user never has to find the right
 * folder or place a skill file themselves (they might put it in the wrong
 * place). Idempotent (tracked by version in globalState), opt-out via
 * `agentEye.autoInstall`, and safe (backs up before editing shared config,
 * never clobbers an existing agent-eye entry, refreshes only our own files).
 */
const INTEGRATIONS_VERSION = "3";

function homeDir(): string {
  return process.env.AGENT_EYE_HOME_OVERRIDE || os.homedir();
}

function skillSource(context: vscode.ExtensionContext): string | undefined {
  return [
    path.join(context.extensionPath, "dist", "skill", "SKILL.md"),
    path.join(context.extensionPath, "..", "..", "skills", "agent-eye", "SKILL.md"),
  ].find((p) => fs.existsSync(p));
}

/** Copies our managed skill into `<dir>/agent-eye/SKILL.md` (kept up to date). */
function installSkillInto(dir: string, source: string): boolean {
  try {
    const target = path.join(dir, "agent-eye", "SKILL.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    return true;
  } catch {
    return false;
  }
}

/** Safe merge of the MCP server into a Claude Code user config (~/.claude.json). */
function registerClaudeCodeMcp(context: vscode.ExtensionContext, home: string): string | undefined {
  const serverEntry = resolveServerEntry(context.extensionPath);
  if (!serverEntry) return undefined;
  const file = path.join(home, ".claude.json");
  try {
    let json: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      json = JSON.parse(raw) as Record<string, unknown>;
      const backup = file + ".agent-eye-backup";
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw, "utf8");
    }
    const servers = (json.mcpServers ?? (json.mcpServers = {})) as Record<string, unknown>;
    // No --workspace: the server defaults to the cwd Claude Code launches it in
    // (the current project), which is what we want globally.
    const desired = { command: "node", args: [serverEntry], env: buildServerEnv(context) };
    const existing = servers["agent-eye"];
    // Re-point on every change — crucially when the extension UPDATES, its
    // install dir (and thus serverEntry) changes; without this the registration
    // would keep pointing at the OLD version's server (or a removed path).
    if (existing && JSON.stringify(existing) === JSON.stringify(desired)) return undefined;
    servers["agent-eye"] = desired;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
    return existing ? "Claude Code MCP (updated to this version)" : "Claude Code MCP (~/.claude.json)";
  } catch {
    return undefined;
  }
}

export async function autoInstallIntegrations(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("agentEye");
  if (!cfg.get<boolean>("autoInstall", true)) return;

  const source = skillSource(context);
  if (!source) return;
  const home = homeDir();

  // Run on EVERY activation (idempotent). This is what makes updates work: the
  // MCP registration is re-pointed at this extension version's server, and the
  // skill refreshed — instead of being skipped by a "already installed once"
  // guard that left ~/.claude.json pointing at the previous version's path.
  installSkillInto(path.join(home, ".claude", "skills"), source);
  if (fs.existsSync(path.join(home, ".codex"))) {
    installSkillInto(path.join(home, ".codex", "skills"), source);
  }
  const mcpChange = registerClaudeCodeMcp(context, home); // string if it wrote (new/updated)
  // (VS Code Copilot MCP is registered live via McpServerDefinitionProvider.)

  // Notify at most once per integrations version (first install / upgrade) so we
  // don't nag on every launch; also notify if the MCP path was just re-pointed.
  const seen = context.globalState.get<string>("agentEye.integrationsVersion");
  if (seen !== INTEGRATIONS_VERSION) {
    context.globalState.update("agentEye.integrationsVersion", INTEGRATIONS_VERSION);
    void vscode.window.showInformationMessage(
      "Agent Eye is ready: AI agents will automatically use the visible browser for frontend work. " +
        "Restart your agent (or reload its MCP servers) to pick up the tools. Disable via agentEye.autoInstall."
    );
  } else if (mcpChange) {
    void vscode.window.showInformationMessage(
      "Agent Eye: updated the MCP registration to this version — restart your agent (or reload its MCP servers) to use it."
    );
  }
}

/** Manual re-run (command), ignoring the idempotency guard. */
export async function reinstallIntegrations(context: vscode.ExtensionContext): Promise<void> {
  context.globalState.update("agentEye.integrationsVersion", undefined);
  await autoInstallIntegrations(context);
}
