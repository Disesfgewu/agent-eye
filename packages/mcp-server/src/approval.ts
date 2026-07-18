import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { log } from "./logger.js";

export type ApprovalResult =
  | { outcome: "approved" }
  | { outcome: "denied" }
  /** Client can't prompt the user; caller must fail safe (deny). */
  | { outcome: "unsupported" };

/**
 * Human-in-the-loop approval for `ask`-tier actions (plan 7.3, server layer).
 * Uses MCP elicitation to ask the user mid-tool-call. If the client doesn't
 * support elicitation we report "unsupported" and the caller denies — we never
 * silently proceed on an action the policy said needs a human.
 */
export class ApprovalService {
  constructor(private readonly server: McpServer) {}

  async request(title: string, detail: string): Promise<ApprovalResult> {
    const caps = this.server.server.getClientCapabilities();
    if (!caps?.elicitation) {
      return { outcome: "unsupported" };
    }

    try {
      const response = await this.server.server.elicitInput({
        message: `${title}\n\n${detail}`,
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve this action?",
              description: "Allow Agent Eye to perform this action once.",
            },
          },
          required: ["approve"],
        },
      });

      if (response.action === "accept" && response.content?.approve === true) {
        return { outcome: "approved" };
      }
      return { outcome: "denied" };
    } catch (err) {
      log.warn("Elicitation failed; treating as denied", { error: String(err) });
      return { outcome: "unsupported" };
    }
  }
}
