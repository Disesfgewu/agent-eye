#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ensureDirs } from "./config.js";
import { log } from "./logger.js";
import { PolicyEngine } from "./policy/policy.js";
import { ArtifactStore } from "./artifacts/artifacts.js";
import { ApprovalService } from "./approval.js";
import { PermissionGate } from "./tools/gate.js";
import { BrowserManager } from "./browser/browser-manager.js";
import { DevServerManager } from "./devserver/dev-server-manager.js";
import { InstanceLock } from "./lock.js";
import { registerTools } from "./tools/register.js";

const SERVER_NAME = "agent-eye";
const SERVER_VERSION = "0.1.0";

async function main(): Promise<void> {
  const config = loadConfig();
  ensureDirs(config);
  log.info("Starting Agent Eye MCP server", { workspaceRoot: config.workspaceRoot });

  const lock = new InstanceLock(config.lockFile);
  const ownsGlobals = lock.acquire();

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Agent Eye gives you a visible browser and dev-server control for testing and debugging a local frontend. " +
        "Typical loop: start_dev_server → browser_navigate to it → browser_snapshot to see the page → " +
        "browser_click / browser_type to interact → browser_get_console_logs / browser_get_network_requests to find bugs. " +
        "Permissions are enforced by policy; a denied action is a boundary, not a failure — do not retry it.",
    }
  );

  const policy = PolicyEngine.load(config.policyFile);
  const artifacts = new ArtifactStore(config.artifactsDir);
  const approval = new ApprovalService(server);
  const gate = new PermissionGate(policy, approval, artifacts);
  const browser = new BrowserManager(
    config.browserProfileDir,
    process.env.AGENT_EYE_BROWSER_CHANNEL || undefined
  );
  const devServers = new DevServerManager();

  registerTools({
    server,
    policy,
    gate,
    artifacts,
    browser,
    devServers,
    workspaceRoot: config.workspaceRoot,
    ownsGlobals,
  });

  artifacts.record({
    type: "info",
    title: ownsGlobals ? "Agent Eye connected" : "Agent Eye connected (secondary instance)",
    detail: ownsGlobals
      ? `Workspace: ${config.workspaceRoot}`
      : "Another instance owns the browser/dev servers; browser tools are disabled here.",
    status: ownsGlobals ? "ok" : "denied",
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutting down", { signal });
    // Hard backstop: never hang on exit — if cleanup stalls, force-exit so we
    // don't leave a zombie server (Playwright's own SIGINT/TERM handlers close
    // the browser; this guarantees the process itself goes away).
    const hardExit = setTimeout(() => process.exit(0), 4000);
    hardExit.unref?.();
    try {
      await devServers.stopAll();
      await browser.close();
    } finally {
      lock.release();
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  // When the MCP client disconnects, stdin ends — treat it as shutdown.
  process.stdin.on("close", () => void shutdown("stdin-close"));
  process.stdin.on("end", () => void shutdown("stdin-end"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("Agent Eye MCP server ready (stdio)", { ownsGlobals });
}

main().catch((err) => {
  log.error("Fatal error starting server", { error: String(err) });
  process.exit(1);
});
