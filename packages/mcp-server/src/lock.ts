import * as fs from "node:fs";
import { log } from "./logger.js";

/**
 * Single-instance ownership of global resources (plan architecture note).
 * Under stdio, every MCP client spawns its own server process, but the browser
 * profile and dev-server processes are workspace-global. The first server to
 * acquire the lock owns them; a second server starts (so its client connects)
 * but its browser/dev-server tools report that another instance is in control.
 */
export class InstanceLock {
  private owned = false;

  constructor(private readonly lockFile: string) {}

  acquire(): boolean {
    try {
      if (fs.existsSync(this.lockFile)) {
        const raw = fs.readFileSync(this.lockFile, "utf8").trim();
        const pid = Number(raw);
        if (Number.isInteger(pid) && pid > 0 && isAlive(pid) && pid !== process.pid) {
          log.warn("Another Agent Eye instance owns this workspace's browser/dev servers", { pid });
          return false;
        }
        // Stale lock (owner gone) — reclaim it.
      }
      fs.writeFileSync(this.lockFile, String(process.pid), "utf8");
      this.owned = true;
      return true;
    } catch (err) {
      log.warn("Failed to acquire instance lock", { error: String(err) });
      return false;
    }
  }

  get ownsGlobals(): boolean {
    return this.owned;
  }

  release(): void {
    if (!this.owned) return;
    try {
      const raw = fs.readFileSync(this.lockFile, "utf8").trim();
      if (Number(raw) === process.pid) fs.rmSync(this.lockFile, { force: true });
    } catch {
      /* best-effort */
    }
    this.owned = false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
