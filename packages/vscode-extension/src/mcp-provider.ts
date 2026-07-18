import * as vscode from "vscode";
import { resolveServerEntry } from "./server-path.js";

/**
 * Registers Agent Eye as an MCP server VS Code manages directly (plan: Copilot
 * zero-config path). This is the in-editor equivalent of the `.mcp.json` file:
 * VS Code's own agent (Copilot) discovers the tools without the user editing
 * any config. Feature-detected so the extension still loads on builds without
 * the MCP provider API.
 */
export function registerMcpProvider(context: vscode.ExtensionContext): void {
  const lm = vscode.lm as unknown as {
    registerMcpServerDefinitionProvider?: (
      id: string,
      provider: vscode.McpServerDefinitionProvider
    ) => vscode.Disposable;
  };
  if (typeof lm.registerMcpServerDefinitionProvider !== "function") {
    return;
  }

  const didChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(didChange);

  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: didChange.event,
    provideMcpServerDefinitions: () => {
      const serverEntry = resolveServerEntry(context.extensionPath);
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!serverEntry || !folder) return [];

      const cfg = vscode.workspace.getConfiguration("agentEye");
      const channel = cfg.get<string>("browserChannel", "");
      const logLevel = cfg.get<string>("logLevel", "info");

      const def = new vscode.McpStdioServerDefinition(
        "Agent Eye",
        "node",
        [serverEntry, "--workspace", folder.uri.fsPath],
        {
          AGENT_EYE_LOG_LEVEL: logLevel,
          ...(channel ? { AGENT_EYE_BROWSER_CHANNEL: channel } : {}),
        },
        context.extension.packageJSON.version as string
      );
      def.cwd = folder.uri;
      return [def];
    },
    resolveMcpServerDefinition: (server) => server,
  };

  context.subscriptions.push(
    lm.registerMcpServerDefinitionProvider("agentEye.mcpProvider", provider)
  );

  // Re-provide when the workspace or relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => didChange.fire()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentEye")) didChange.fire();
    })
  );
}
