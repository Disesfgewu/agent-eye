import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

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
  /** Directory of per-instance child-PID registries (for orphan reaping). */
  pidsDir: string;
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
  const profilesRoot = path.join(stateDir, "browser-profile");
  cleanStaleProfiles(profilesRoot);
  return {
    workspaceRoot,
    stateDir,
    artifactsDir,
    // Per-instance profile (keyed by pid) so two servers never collide on the
    // same Playwright user-data-dir — which is what a single-instance lock used
    // to (over-)protect against, at the cost of false "another instance owns the
    // browser" errors even when no browser was ever opened.
    browserProfileDir: path.join(profilesRoot, `p${process.pid}`),
    policyFile: path.join(stateDir, "policy.json"),
    pidsDir: path.join(stateDir, "pids"),
  };
}

/** Removes leftover per-pid profile dirs whose owning process is gone, and kills
 * any orphaned browser still holding that profile (the case a SIGKILL of the
 * server leaves behind, since Playwright can't clean up on an uncatchable
 * signal). Best-effort — no zombies left around. */
function cleanStaleProfiles(profilesRoot: string): void {
  try {
    for (const name of fs.readdirSync(profilesRoot)) {
      const m = /^p(\d+)$/.exec(name);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid || isAlive(pid)) continue;
      const dir = path.join(profilesRoot, name);
      killProcessesUsingDir(dir); // kill an orphan chromium holding this profile
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    /* dir may not exist yet */
  }
}

/** Kills processes whose command line references `dir` (an orphan browser using
 * a dead instance's user-data-dir). Only runs for already-stale dirs, so it can
 * never touch a live browser. Best-effort, cross-platform. */
function killProcessesUsingDir(dir: string): void {
  try {
    if (process.platform === "win32") {
      const escaped = dir.replace(/'/g, "''");
      spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ],
        { stdio: "ignore", timeout: 10000 }
      );
    } else {
      spawnSync("pkill", ["-9", "-f", dir], { stdio: "ignore", timeout: 10000 });
    }
  } catch {
    /* best-effort */
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
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
