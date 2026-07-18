import * as vscode from "vscode";

/**
 * Builds the environment passed to the MCP server from the `agentEye.*`
 * settings, shared by the .mcp.json writer and the MCP provider so both
 * discovery paths behave identically.
 */
export function buildServerEnv(): Record<string, string> {
  const cfg = vscode.workspace.getConfiguration("agentEye");
  const channel = cfg.get<string>("browserChannel", "");
  const logLevel = cfg.get<string>("logLevel", "info");
  const showCursor = cfg.get<boolean>("showCursor", true);
  const slowMoMs = cfg.get<number>("slowMoMs", 0);

  const env: Record<string, string> = {
    AGENT_EYE_LOG_LEVEL: logLevel,
    AGENT_EYE_SHOW_CURSOR: showCursor ? "1" : "0",
  };
  if (channel) env.AGENT_EYE_BROWSER_CHANNEL = channel;
  if (slowMoMs > 0) env.AGENT_EYE_SLOWMO = String(slowMoMs);
  return env;
}
