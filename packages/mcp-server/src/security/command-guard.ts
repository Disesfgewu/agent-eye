import * as path from "node:path";
import { isInside } from "../config.js";

/**
 * Dev-server launch scope enforcement (plan 7.2). Commands are passed as an
 * argv array (never a shell string), the cwd is confined to the workspace, and
 * only allowlisted executables may be spawned. Anything outside the allowlist
 * is a `highRisk` action for the policy to reject.
 */
export type CommandVerdict =
  | { verdict: "blocked"; reason: string }
  | { verdict: "allowlisted"; command: string; args: string[]; cwd: string }
  | { verdict: "outside"; reason: string; command: string; args: string[]; cwd: string };

export function classifyCommand(
  command: string,
  args: string[],
  cwd: string,
  workspaceRoot: string,
  commandAllowlist: string[]
): CommandVerdict {
  const trimmed = command.trim();
  if (!trimmed) {
    return { verdict: "blocked", reason: "Empty command." };
  }

  // Reject shell metacharacters: argv is spawned without a shell, so these can
  // only be an attempt to smuggle a second command or a redirection.
  if (/[;&|`$(){}<>\n\r]/.test(trimmed) || args.some((a) => /[\n\r]/.test(a))) {
    return {
      verdict: "blocked",
      reason: "Command or arguments contain shell metacharacters; commands run without a shell and must be a plain executable + args.",
    };
  }

  const resolvedCwd = path.resolve(workspaceRoot, cwd);
  if (!isInside(workspaceRoot, resolvedCwd)) {
    return {
      verdict: "blocked",
      reason: `cwd "${cwd}" resolves outside the workspace and is not allowed.`,
    };
  }

  const base = basename(trimmed);
  const allowed = commandAllowlist.some(
    (entry) => entry.toLowerCase() === base.toLowerCase()
  );

  if (allowed) {
    return { verdict: "allowlisted", command: trimmed, args, cwd: resolvedCwd };
  }
  return {
    verdict: "outside",
    reason: `Command "${base}" is not in the allowlist. Add it in .agent-eye/policy.json to permit it.`,
    command: trimmed,
    args,
    cwd: resolvedCwd,
  };
}

/** Executable basename without directory or .exe/.cmd/.bat extension. */
function basename(command: string): string {
  const withoutDir = path.basename(command);
  return withoutDir.replace(/\.(exe|cmd|bat|ps1)$/i, "");
}
