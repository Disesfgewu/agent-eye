import * as path from "node:path";
import { isInside } from "../config.js";
import { inlineCodeReason } from "./interpreter-guard.js";
import { WRAPPER_COMMANDS, isPathEscape } from "./toolchains.js";
import { windowsUnsafeArg } from "./win-args.js";

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

  // On Windows dev servers go through cmd.exe, which interprets " % ^ even in arguments (Issue #27).
  if (process.platform === "win32") {
    const unsafe = [trimmed, ...args].map(windowsUnsafeArg).find(Boolean);
    if (unsafe) return { verdict: "blocked", reason: `Windows: ${unsafe}.` };
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
    // mvnw / gradlew are project scripts: a path to one must stay inside the workspace.
    if (WRAPPER_COMMANDS.has(base.toLowerCase()) && /[\/]/.test(trimmed)) {
      const wrapper = path.resolve(resolvedCwd, trimmed);
      if (isPathEscape(trimmed) && !isInside(workspaceRoot, wrapper)) {
        return {
          verdict: "outside",
          reason: `Wrapper "${trimmed}" resolves outside the workspace.`,
          command: trimmed,
          args,
          cwd: resolvedCwd,
        };
      }
    }
    // An allowlisted interpreter running inline/remote code is NOT a dev server:
    // treat it as outside the allowlist so the (default-deny) highRisk policy decides.
    const reason = inlineCodeReason(base, args);
    if (reason) {
      return {
        verdict: "outside",
        reason: `${reason}. Interpreters may only run files/scripts, not inline or freshly downloaded code.`,
        command: trimmed,
        args,
        cwd: resolvedCwd,
      };
    }
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
