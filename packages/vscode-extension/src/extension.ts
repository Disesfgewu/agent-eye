import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupForClaudeCode } from "./setup.js";
import { registerMcpProvider } from "./mcp-provider.js";
import { AgentEyePanel } from "./panel.js";
import { installRuntime, ensureRuntimePrompt } from "./runtime.js";
import { autoInstallIntegrations, reinstallIntegrations } from "./auto-install.js";

export function activate(context: vscode.ExtensionContext): void {
  const panel = new AgentEyePanel(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentEyePanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentEye.setupForClaudeCode", () =>
      setupForClaudeCode(context)
    ),
    vscode.commands.registerCommand("agentEye.openPanel", () =>
      vscode.commands.executeCommand("agentEye.activity.focus")
    ),
    vscode.commands.registerCommand("agentEye.openPolicy", () => openPolicy()),
    vscode.commands.registerCommand("agentEye.clearArtifacts", () => panel.clear()),
    vscode.commands.registerCommand("agentEye.installRuntime", () => installRuntime(context)),
    vscode.commands.registerCommand("agentEye.reinstallIntegrations", () => reinstallIntegrations(context))
  );

  registerMcpProvider(context);
  void ensureRuntimePrompt(context);
  // Auto-place the skill + MCP registration into agents' global config so the
  // user never has to install a skill by hand (plan: zero-setup).
  void autoInstallIntegrations(context);
}

export function deactivate(): void {
  // Subscriptions are disposed automatically by the extension host.
}

async function openPolicy(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("Agent Eye: open a folder/workspace first.");
    return;
  }
  const policyPath = path.join(folder.uri.fsPath, ".agent-eye", "policy.json");
  if (!fs.existsSync(policyPath)) {
    void vscode.window.showInformationMessage(
      "Agent Eye: policy.json is created the first time the MCP server runs. Start your agent once, then reopen this."
    );
    return;
  }
  const doc = await vscode.workspace.openTextDocument(policyPath);
  await vscode.window.showTextDocument(doc);
}
