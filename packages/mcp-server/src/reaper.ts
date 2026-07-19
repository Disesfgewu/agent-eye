import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { log } from "./logger.js";

const isWindows = process.platform === "win32";

/**
 * Guarantees no leaked/zombie child processes (browser + dev servers).
 *
 * Playwright's own SIGINT/SIGTERM/SIGHUP handlers and our graceful shutdown
 * cover normal exits, but an ABRUPT death (SIGKILL, crash, the parent editor
 * being force-killed) orphans children. This registry records every child PID
 * this server spawns in `<pidsDir>/<ownPid>`, and on startup reaps any PIDs left
 * behind by a server instance that is no longer alive — plus a synchronous
 * best-effort kill on `process.exit` as a last resort.
 */
export class ProcessReaper {
  private readonly file: string;
  private readonly pids = new Set<number>();

  constructor(pidsDir: string) {
    fs.mkdirSync(pidsDir, { recursive: true });
    this.file = path.join(pidsDir, String(process.pid));
    // Last-resort synchronous cleanup if we exit without running shutdown.
    process.on("exit", () => this.killAllSync());
  }

  track(pid: number | undefined): void {
    if (!pid) return;
    this.pids.add(pid);
    this.flush();
  }

  untrack(pid: number | undefined): void {
    if (!pid) return;
    this.pids.delete(pid);
    this.flush();
  }

  /** Removes our registry file (call after children are cleanly stopped). */
  dispose(): void {
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* best-effort */
    }
  }

  private flush(): void {
    try {
      fs.writeFileSync(this.file, [...this.pids].join("\n"), "utf8");
    } catch {
      /* best-effort */
    }
  }

  private killAllSync(): void {
    for (const pid of this.pids) killTreeSync(pid);
    this.dispose();
  }

  /**
   * At startup, kills child PIDs recorded by any PREVIOUS server instance that
   * is no longer alive (the orphans a crash/SIGKILL would leave), and removes
   * their registry files.
   */
  static reapStale(pidsDir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(pidsDir);
    } catch {
      return; // dir doesn't exist yet
    }
    for (const name of entries) {
      const ownerPid = Number(name);
      if (!Number.isInteger(ownerPid) || ownerPid === process.pid || isAlive(ownerPid)) continue;
      const file = path.join(pidsDir, name);
      let pids: number[] = [];
      try {
        pids = fs.readFileSync(file, "utf8").split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      } catch {
        /* ignore */
      }
      for (const pid of pids) {
        if (isAlive(pid)) {
          log.warn("Reaping orphaned child process from a dead server instance", { ownerPid, pid });
          killTreeSync(pid);
        }
      }
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* best-effort */
      }
    }
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

/** Synchronously kills a process and its whole tree (best-effort). */
function killTreeSync(pid: number): void {
  try {
    if (isWindows) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      // Our POSIX children are spawned as session leaders (start_new_session),
      // so the negative pid targets the whole group; fall back to the pid.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* process may already be gone */
  }
}
