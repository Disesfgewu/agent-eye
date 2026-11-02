import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PermissionGate } from "./gate.js";
import type { UsageLedger } from "../usage/ledger.js";

export function registerUsageTool(server: McpServer, gate: PermissionGate, ledger: UsageLedger): void {
  server.registerTool(
    "usage_report",
    {
      title: "Token usage report",
      description:
        "Estimated token cost of Agent Eye tool calls this session (per tool). Read-only; call when asked how much a task cost.",
      inputSchema: {},
    },
    async () => {
      const g = await gate.check("observe", { tool: "usage_report", title: "Read token usage", detail: "" });
      if (!g.ok) return { content: [{ type: "text" as const, text: g.message }], isError: true };
      return { content: [{ type: "text" as const, text: ledger.report() }] };
    }
  );
}
