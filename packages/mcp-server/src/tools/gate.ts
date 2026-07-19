import type { PolicyEngine } from "../policy/policy.js";
import type { ActionCategory } from "../policy/types.js";
import type { ApprovalService } from "../approval.js";
import type { ArtifactStore } from "../artifacts/artifacts.js";
import { log } from "../logger.js";

export type GateOutcome =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Single choke point where the permission policy is enforced (plan 7.1). Every
 * tool routes its action through here before doing any work. Enforcement lives
 * in the server, not in the prompt: a manipulated agent still cannot get past a
 * `deny`, and an `ask` always requires a real human approval.
 */
export class PermissionGate {
  /** Categories approved once and remembered for the session (plan 7.1: execute
   * is "ask" first, then remembered after the user approves it once). */
  private readonly sessionApproved = new Set<ActionCategory>();

  constructor(
    private readonly policy: PolicyEngine,
    private readonly approval: ApprovalService,
    private readonly artifacts: ArtifactStore
  ) {}

  async check(
    category: ActionCategory,
    ctx: { tool: string; title: string; detail: string; remember?: boolean }
  ): Promise<GateOutcome> {
    const decision = this.policy.decide(category);
    log.debug("Policy decision", { category, decision, tool: ctx.tool });

    if (decision === "ask" && this.sessionApproved.has(category)) {
      return { ok: true };
    }

    if (decision === "deny") {
      this.artifacts.record({
        type: "approval",
        tool: ctx.tool,
        title: `Denied: ${ctx.title}`,
        detail: `Policy category "${category}" is set to deny.`,
        status: "denied",
      });
      return {
        ok: false,
        message:
          `Permission denied by policy: this action is in the "${category}" category, which is set to "deny". ` +
          `This is a permission boundary, not a tool failure — do not retry. ` +
          `The user can permit it by editing .agent-eye/policy.json (categories.${category}) and restarting.`,
      };
    }

    if (decision === "ask") {
      const result = await this.approval.request(ctx.title, ctx.detail);
      if (result.outcome === "approved") {
        if (ctx.remember) this.sessionApproved.add(category);
        this.artifacts.record({
          type: "approval",
          tool: ctx.tool,
          title: `Approved: ${ctx.title}`,
          detail: ctx.remember ? `${ctx.detail} (remembered for this session)` : ctx.detail,
          status: "ok",
        });
        return { ok: true };
      }
      if (result.outcome === "denied") {
        this.artifacts.record({
          type: "approval",
          tool: ctx.tool,
          title: `Rejected by user: ${ctx.title}`,
          detail: ctx.detail,
          status: "denied",
        });
        return {
          ok: false,
          message:
            `The user declined this action. This is a permission boundary, not a tool failure — do not retry the same action.`,
        };
      }
      // unsupported → fail safe
      this.artifacts.record({
        type: "approval",
        tool: ctx.tool,
        title: `Blocked (no approval channel): ${ctx.title}`,
        detail: ctx.detail,
        status: "denied",
      });
      return {
        ok: false,
        message:
          `This action requires user approval (policy category "${category}" is "ask"), but the connected MCP client ` +
          `cannot prompt the user (no elicitation support). Failing safe. To allow such actions, either use a client ` +
          `that supports MCP elicitation, or set categories.${category} to "allow" in .agent-eye/policy.json.`,
      };
    }

    return { ok: true };
  }
}
