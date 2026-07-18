import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Runtime configuration derived from the workspace root. Every path the server
 * touches for policy, artifacts, and the browser profile is anchored under the
 * workspace so nothing escapes it (plan 7.2 — file scope).
 */
export interface ServerConfig {
  /** Absolute path to the workspace root the agent is operating on. */
  workspaceRoot: string;
  /** Directory for agent-eye internal state (policy, browser profile, lock). */
  stateDir: string;
  /** Directory for user-facing artifacts (screenshots, event timeline). */
  artifactsDir: string;
  /** Dedicated Playwright profile dir — never the user's real browser profile. */
  browserProfileDir: string;
  /** Policy file path. */
  policyFile: string;
  /** Lock file guarding single-instance ownership of global resources. */
  lockFile: string;
}

function resolveWorkspaceRoot(): string {
  const fromArg = parseArg("--workspace");
  const fromEnv = process.env.AGENT_EYE_WORKSPACE;
  const root = fromArg ?? fromEnv ?? process.cwd();
  return path.resolve(root);
}

function parseArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  return undefined;
}

export function loadConfig(): ServerConfig {
  const workspaceRoot = resolveWorkspaceRoot();
  const stateDir = path.join(workspaceRoot, ".agent-eye");
  const artifactsDir = path.join(workspaceRoot, ".agent-artifacts");
  return {
    workspaceRoot,
    stateDir,
    artifactsDir,
    browserProfileDir: path.join(stateDir, "browser-profile"),
    policyFile: path.join(stateDir, "policy.json"),
    lockFile: path.join(stateDir, "server.lock"),
  };
}

export function ensureDirs(config: ServerConfig): void {
  for (const dir of [config.stateDir, config.artifactsDir, config.browserProfileDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * True if `candidate` resolves to a location inside `root` (or equal to it).
 * Used to keep dev-server cwd and file writes inside the workspace.
 */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
