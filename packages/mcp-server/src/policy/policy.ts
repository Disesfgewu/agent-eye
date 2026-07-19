import * as fs from "node:fs";
import { log } from "../logger.js";
import {
  type ActionCategory,
  type Decision,
  type Policy,
  DEFAULT_POLICY,
} from "./types.js";

/**
 * Loads and enforces the workspace permission policy (plan 7.1).
 *
 * The policy is read once at startup. This is deliberate: an agent that also
 * has a file-write tool must not be able to widen its own permissions by
 * rewriting policy.json mid-session — changes only take effect on restart, and
 * significant relaxations (e.g. enabling `evaluate`) are expected to go through
 * the extension UI. See plan 7.1.
 */
export class PolicyEngine {
  private policy: Policy;

  private constructor(policy: Policy) {
    this.policy = policy;
  }

  static load(policyFile: string): PolicyEngine {
    let policy = DEFAULT_POLICY;
    try {
      if (fs.existsSync(policyFile)) {
        const raw = JSON.parse(fs.readFileSync(policyFile, "utf8"));
        policy = mergePolicy(DEFAULT_POLICY, raw);
        log.info("Loaded workspace policy", { policyFile });
      } else {
        fs.writeFileSync(policyFile, JSON.stringify(DEFAULT_POLICY, null, 2), "utf8");
        log.info("Wrote default policy", { policyFile });
      }
    } catch (err) {
      log.warn("Failed to load policy, using safe defaults", {
        policyFile,
        error: String(err),
      });
      policy = DEFAULT_POLICY;
    }
    return new PolicyEngine(policy);
  }

  decide(category: ActionCategory): Decision {
    return this.policy.categories[category] ?? "deny";
  }

  get navigationAllowlist(): string[] {
    return this.policy.navigationAllowlist;
  }

  get commandAllowlist(): string[] {
    return this.policy.commandAllowlist;
  }

  get redactSensitiveHeaders(): boolean {
    return this.policy.redactSensitiveHeaders;
  }

  snapshot(): Policy {
    return structuredClone(this.policy);
  }
}

/**
 * Shallow-merges a loaded policy over the defaults so a partial or slightly
 * outdated policy.json never leaves a category undefined (undefined → deny).
 */
function mergePolicy(base: Policy, incoming: Partial<Policy>): Policy {
  return {
    version: incoming.version ?? base.version,
    categories: { ...base.categories, ...(incoming.categories ?? {}) },
    navigationAllowlist: incoming.navigationAllowlist ?? base.navigationAllowlist,
    commandAllowlist: incoming.commandAllowlist ?? base.commandAllowlist,
    redactSensitiveHeaders:
      incoming.redactSensitiveHeaders ?? base.redactSensitiveHeaders,
  };
}
