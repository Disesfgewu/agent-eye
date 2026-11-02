import * as path from "node:path";
import { z } from "zod";
import { isInside } from "../config.js";
import { classifyCommand } from "../security/command-guard.js";
import { detectProjects, formatDetected } from "../project/detect.js";
import { scanWorkspace } from "../project/scan.js";
import { errorResult, text, type ToolContext, type ToolResult } from "./register.js";

/**
 * detect_project (Issue #22): one read-only call that replaces "ls + read go.mod /
 * Cargo.toml / pom.xml / ... + guess the command and port". Output lists the exact
 * start_dev_server arguments and flags any that the current policy would refuse.
 */
export function registerProjectTools(ctx: ToolContext): void {
  if (process.env.AGENT_EYE_TOOLSET === "core") return;
  const { server, policy, gate, artifacts, workspaceRoot } = ctx;

  server.registerTool(
    "detect_project",
    {
      title: "Detect project",
      description:
        "List runnable projects (JS, Go, Rust, .NET, JVM, Elixir, Python, PHP, Ruby, Flutter, static) with exact start_dev_server args + port. Read-only; call first on an unfamiliar repo.",
      inputSchema: {
        path: z.string().optional().describe("Subdirectory to scan (default: workspace)."),
      },
    },
    async ({ path: sub }): Promise<ToolResult> => {
      const gateResult = await gate.check("observe", { tool: "detect_project", title: "Detect project", detail: sub ?? "." });
      if (!gateResult.ok) return errorResult(gateResult.message);
      const root = path.resolve(workspaceRoot, sub ?? ".");
      if (!isInside(workspaceRoot, root)) return errorResult(`path "${sub}" resolves outside the workspace.`);
      const prefix = path.relative(workspaceRoot, root).split(path.sep).join("/");
      const result = detectProjects(scanWorkspace(root));
      for (const p of result.projects) if (prefix) p.dir = p.dir === "." ? prefix : `${prefix}/${p.dir}`;
      const verdicts = result.projects.map((p) => {
        const v = classifyCommand(p.command, p.args, p.dir, workspaceRoot, policy.commandAllowlist);
        return v.verdict === "allowlisted" ? undefined : v.reason;
      });
      artifacts.record({ type: "info", tool: "detect_project", title: `Detected ${result.projects.length} project(s)`, status: "ok" });
      return text(formatDetected(result, verdicts));
    }
  );
}
