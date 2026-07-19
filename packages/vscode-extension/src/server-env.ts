import * as vscode from "vscode";
import { runtimeDir, runtimeNodeModules } from "./runtime.js";

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

  // Tell the bundled server where the browser runtime lives so it can resolve
  // Playwright from there (AGENT_EYE_RUNTIME_DIR → createRequire, see
  // browser-manager loadChromium). Set even before the runtime is installed —
  // the registration is written once at activation, and this path becomes valid
  // as soon as the user runs "Install Browser Runtime", with no re-register.
  // NODE_PATH is a harmless extra for any CJS require paths.
  env.AGENT_EYE_RUNTIME_DIR = runtimeDir(context);
  env.NODE_PATH = runtimeNodeModules(context);
  return env;
}
