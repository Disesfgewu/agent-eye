import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "../logger.js";

/**
 * A single entry in the agent's operation timeline, consumed by the VS Code
 * Webview so the user can watch what the agent is doing (plan: artifacts /
 * "user-facing" layer). Written as append-only JSONL for cheap tailing.
 */
export interface ArtifactEvent {
  id: string;
  timestamp: string;
  type: "tool_call" | "approval" | "console" | "network" | "dev_server" | "info";
  /** Tool name, when this event is a tool invocation. */
  tool?: string;
  title: string;
  detail?: string;
  /** Relative path (from artifactsDir) to a screenshot, when present. */
  screenshot?: string;
  status?: "ok" | "denied" | "error" | "pending";
}

export interface ArtifactRetention {
  /** Maximum events retained in events.jsonl before the oldest are pruned. */
  maxEvents: number;
  /** Maximum total bytes of screenshots before the oldest are deleted. */
  maxScreenshotBytes: number;
}

const DEFAULT_RETENTION: ArtifactRetention = {
  maxEvents: 500,
  maxScreenshotBytes: 200 * 1024 * 1024, // 200 MB
};

export class ArtifactStore {
  private readonly eventsFile: string;
  private readonly screenshotsDir: string;
  private readonly retention: ArtifactRetention;

  constructor(
    private readonly artifactsDir: string,
    retention: Partial<ArtifactRetention> = {}
  ) {
    this.eventsFile = path.join(artifactsDir, "events.jsonl");
    this.screenshotsDir = path.join(artifactsDir, "screenshots");
    this.retention = { ...DEFAULT_RETENTION, ...retention };
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
  }

  record(event: Omit<ArtifactEvent, "id" | "timestamp">): ArtifactEvent {
    const full: ArtifactEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
    };
    try {
      fs.appendFileSync(this.eventsFile, JSON.stringify(full) + "\n", "utf8");
      this.pruneEvents();
    } catch (err) {
      log.warn("Failed to record artifact event", { error: String(err) });
    }
    return full;
  }

  /** Persists a screenshot and returns its path relative to artifactsDir. */
  saveScreenshot(buffer: Buffer, label = "screenshot"): string {
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
    const name = `${Date.now()}-${safeLabel}-${randomUUID().slice(0, 8)}.png`;
    const abs = path.join(this.screenshotsDir, name);
    fs.writeFileSync(abs, buffer);
    this.pruneScreenshots();
    return path.relative(this.artifactsDir, abs).split(path.sep).join("/");
  }

  private pruneEvents(): void {
    try {
      const lines = fs.readFileSync(this.eventsFile, "utf8").split("\n").filter(Boolean);
      if (lines.length > this.retention.maxEvents) {
        const kept = lines.slice(lines.length - this.retention.maxEvents);
        fs.writeFileSync(this.eventsFile, kept.join("\n") + "\n", "utf8");
      }
    } catch {
      /* best-effort */
    }
  }

  private pruneScreenshots(): void {
    try {
      const files = fs
        .readdirSync(this.screenshotsDir)
        .map((name) => {
          const abs = path.join(this.screenshotsDir, name);
          const stat = fs.statSync(abs);
          return { abs, size: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => a.mtime - b.mtime); // oldest first

      let total = files.reduce((sum, f) => sum + f.size, 0);
      for (const file of files) {
        if (total <= this.retention.maxScreenshotBytes) break;
        fs.rmSync(file.abs, { force: true });
        total -= file.size;
      }
    } catch {
      /* best-effort */
    }
  }
}
