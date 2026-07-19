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
const INTEGRATIONS_VERSION = "2";

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
    if (servers["agent-eye"]) return undefined; // never clobber an existing entry
    // No --workspace: the server defaults to the cwd Claude Code launches it in
    // (the current project), which is what we want globally.
    servers["agent-eye"] = { command: "node", args: [serverEntry], env: buildServerEnv(context) };
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
    return "Claude Code MCP (~/.claude.json)";
  } catch {
    return undefined;
  }
}

export async function autoInstallIntegrations(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("agentEye");
  if (!cfg.get<boolean>("autoInstall", true)) return;
  if (context.globalState.get<string>("agentEye.integrationsVersion") === INTEGRATIONS_VERSION) return;

  const source = skillSource(context);
  if (!source) return;
  const home = homeDir();
  const installed: string[] = [];

  // Claude Code — global skill (every project, zero per-project setup).
  if (installSkillInto(path.join(home, ".claude", "skills"), source)) {
    installed.push("Claude Code skill");
  }
  // OpenAI Codex — global skill if Codex is present.
  if (fs.existsSync(path.join(home, ".codex")) && installSkillInto(path.join(home, ".codex", "skills"), source)) {
    installed.push("Codex skill");
  }
  // Claude Code CLI — register the MCP server globally.
  const mcp = registerClaudeCodeMcp(context, home);
  if (mcp) installed.push(mcp);
  // (VS Code Copilot MCP is registered live via McpServerDefinitionProvider.)

  context.globalState.update("agentEye.integrationsVersion", INTEGRATIONS_VERSION);

  if (installed.length) {
    void vscode.window.showInformationMessage(
      `Agent Eye is ready: installed so AI agents automatically use the visible browser for frontend work (${installed.join(", ")}). ` +
        `Disable via the agentEye.autoInstall setting.`
    );
  }
}

/** Manual re-run (command), ignoring the idempotency guard. */
export async function reinstallIntegrations(context: vscode.ExtensionContext): Promise<void> {
  context.globalState.update("agentEye.integrationsVersion", undefined);
  await autoInstallIntegrations(context);
}
