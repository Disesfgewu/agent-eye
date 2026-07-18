import * as vscode from "vscode";
import * as fs from "node:fs";
import { runtimeNodeModules } from "./runtime.js";

/**
 * Builds the environment passed to the MCP server from the `agentEye.*`
 * settings, shared by the .mcp.json writer and the MCP provider so both
 * discovery paths behave identically. Adds NODE_PATH so the bundled server can
 * resolve the Playwright runtime provisioned into global storage.
 */
export function buildServerEnv(context: vscode.ExtensionContext): Record<string, string> {
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

  const nodeModules = runtimeNodeModules(context);
  if (fs.existsSync(nodeModules)) {
    env.NODE_PATH = process.env.NODE_PATH ? `${nodeModules}${pathDelim()}${process.env.NODE_PATH}` : nodeModules;
  }
  return env;
}

function pathDelim(): string {
  return process.platform === "win32" ? ";" : ":";
}
