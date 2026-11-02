import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
 *
 * PIDs are reused (after a reboot, or just after a long time), so "this PID is
 * alive" is not evidence that it is OUR orphan. Every recorded PID therefore
 * carries the process START TIME, and a process is only killed if it still has
 * the start time recorded at registration. The owner is judged the same way: an
 * owner PID that is alive but started at another time is a dead owner whose PID
 * was reused. A record without a start time (older versions, or one that was
 * never filled in) is never acted on: fail safe, not fail deadly.
 */
export class ProcessReaper {
  private readonly file: string;
  /** pid -> start-time token (undefined until known). */
  private readonly pids = new Map<number, string | undefined>();
  private readonly ownerStart = processStartSync(process.pid);

  constructor(pidsDir: string) {
    fs.mkdirSync(pidsDir, { recursive: true });
    this.file = path.join(pidsDir, String(process.pid));
    // Last-resort synchronous cleanup if we exit without running shutdown.
    process.on("exit", () => this.killAllSync());
  }

  track(pid: number | undefined): void {
    if (!pid) return;
    // POSIX reads this in microseconds (/proc) or ~10 ms (ps); Windows needs PowerShell, which must not block the event loop,
    // so there the start time is filled in a moment later (a death inside that window leaves a record that is simply not acted on).
    const start = isWindows ? undefined : processStartSync(pid);
    this.pids.set(pid, start);
    this.flush();
    if (isWindows) {
      void processStartAsync(pid).then((s) => {
        if (s && this.pids.has(pid)) {
          this.pids.set(pid, s);
          this.flush();
        }
      });
    }
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
      const children = [...this.pids].map(([pid, start]) => ({ pid, start: start ?? null }));
      fs.writeFileSync(this.file, JSON.stringify({ ownerStart: this.ownerStart ?? null, children }), "utf8");
    } catch {
      /* best-effort */
    }
  }

  private killAllSync(): void {
    // Our own children, recorded by this very process: no start-time check needed (they cannot be a reused PID yet).
    for (const pid of this.pids.keys()) killTreeSync(pid);
    this.dispose();
  }

  /**
   * At startup, kills child PIDs recorded by any PREVIOUS server instance that
   * is no longer alive (the orphans a crash/SIGKILL would leave), and removes
   * their registry files.
   */
  static reapStale(pidsDir: string): number[] {
    const killed: number[] = [];
    let entries: string[];
    try {
      entries = fs.readdirSync(pidsDir);
    } catch {
      return killed; // dir doesn't exist yet
    }
    for (const name of entries) {
      const ownerPid = Number(name);
      if (!Number.isInteger(ownerPid) || ownerPid === process.pid) continue;
      const file = path.join(pidsDir, name);
      let rec: { ownerStart?: string | null; children?: Array<{ pid?: number; start?: string | null }> } = {};
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed && typeof parsed === "object") rec = parsed as typeof rec;
      } catch {
        /* legacy / corrupt record: nothing we can safely act on */
      }
      // A live owner is another running server in this workspace: leave it and its record alone. "Live" means the SAME
      // process that wrote the record; an owner PID that now belongs to a different process is dead.
      const ownerNow = processStartSync(ownerPid);
      if (ownerNow !== undefined && (rec.ownerStart == null || rec.ownerStart === ownerNow)) continue;
      for (const child of rec.children ?? []) {
        const pid = child.pid;
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !child.start) continue;
        if (processStartSync(pid) === child.start) {
          log.warn("Reaping orphaned child process from a dead server instance", { ownerPid, pid });
          killTreeSync(pid);
          killed.push(pid);
        } else if (isAlive(pid)) {
          log.warn("Not reaping a recorded PID: it is alive but started at a different time (PID reuse)", { ownerPid, pid });
        }
      }
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* best-effort */
      }
    }
    return killed;
  }
}

/**
 * An opaque token that changes if the PID is reused: the process start time. undefined if the process is gone or unreadable.
 * Linux: /proc/<pid>/stat field 22; macOS: `ps -o lstart=`; Windows: CIM CreationDate (slow: PowerShell).
 */
export function processStartSync(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      // a zombie (state Z) or dead (X) process is finished: it only lingers until its parent calls wait()
      if (fields[0] === "Z" || fields[0] === "X") return undefined;
      return fields[19] || undefined;
    }
    if (isWindows) {
      const r = spawnSync("powershell", ["-NoProfile", "-Command", winStartCommand(pid)], { encoding: "utf8", timeout: 10000 });
      return r.stdout.trim() || undefined;
    }
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    return r.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function winStartCommand(pid: number): string {
  return `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}').CreationDate.ToFileTimeUtc()`;
}

function processStartAsync(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const child = spawn("powershell", ["-NoProfile", "-Command", winStartCommand(pid)], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", () => resolve(undefined));
      child.on("close", () => resolve(out.trim() || undefined));
    } catch {
      resolve(undefined);
    }
  });
}

/** Finds PIDs whose command line references `dir` — used to identify exactly
 * which OS processes belong to a browser launched with that unique per-instance
 * user-data-dir (Playwright doesn't expose the browser PID publicly). */
export function findPidsUsingDir(dir: string): number[] {
  try {
    if (isWindows) {
      const esc = dir.replace(/'/g, "''");
      const r = spawnSync(
        "powershell",
        ["-NoProfile", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${esc}*' } | Select-Object -ExpandProperty ProcessId`],
        { encoding: "utf8", timeout: 10000 }
      );
      return parsePids(r.stdout);
    }
    const r = spawnSync("pgrep", ["-f", dir], { encoding: "utf8", timeout: 10000 });
    return parsePids(r.stdout);
  } catch {
    return [];
  }
}

function parsePids(s: string | null | undefined): number[] {
  return (s ?? "").split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
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
