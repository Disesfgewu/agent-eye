import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "../logger.js";

export interface ToolUsage {
  calls: number;
  errors: number;
  inTokens: number;
  outTokens: number;
  maxOutTokens: number;
  totalMs: number;
}

export interface UsageSummary {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  /** Estimated fixed cost of the tool definitions the client loads each session. */
  toolDefinitionTokens: number;
  toolCount: number;
  totals: { calls: number; errors: number; inTokens: number; outTokens: number };
  tools: Record<string, ToolUsage>;
}

const HISTORY_MAX_LINES = 200;

/**
 * Per-session token ledger. All figures are estimates (see estimate.ts). State is
 * persisted to <artifactsDir>/usage.json (current session) and, on flush at
 * shutdown, appended to usage-history.jsonl (bounded) so runs can be compared.
 */
export class UsageLedger {
  private readonly sessionId = `${Date.now().toString(36)}-${process.pid}`;
  private readonly startedAt = new Date().toISOString();
  private readonly tools = new Map<string, ToolUsage>();
  private toolDefinitionTokens = 0;
  private toolCount = 0;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly artifactsDir?: string) {}

  setToolDefinitionOverhead(tokens: number, count: number): void {
    this.toolDefinitionTokens = tokens;
    this.toolCount = count;
    this.schedule();
  }

  record(tool: string, inTokens: number, outTokens: number, ms: number, ok: boolean): void {
    const u =
      this.tools.get(tool) ??
      { calls: 0, errors: 0, inTokens: 0, outTokens: 0, maxOutTokens: 0, totalMs: 0 };
    u.calls++;
    if (!ok) u.errors++;
    u.inTokens += inTokens;
    u.outTokens += outTokens;
    u.maxOutTokens = Math.max(u.maxOutTokens, outTokens);
    u.totalMs += ms;
    this.tools.set(tool, u);
    this.schedule();
  }

  summary(): UsageSummary {
    const tools: Record<string, ToolUsage> = {};
    const totals = { calls: 0, errors: 0, inTokens: 0, outTokens: 0 };
    for (const [name, u] of this.tools) {
      tools[name] = { ...u };
      totals.calls += u.calls;
      totals.errors += u.errors;
      totals.inTokens += u.inTokens;
      totals.outTokens += u.outTokens;
    }
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      toolDefinitionTokens: this.toolDefinitionTokens,
      toolCount: this.toolCount,
      totals,
      tools,
    };
  }

  /** Compact human/agent-readable report (kept small: it is itself tool output). */
  report(): string {
    const s = this.summary();
    const n = (v: number) => v.toLocaleString("en-US");
    const lines = [
      `Agent Eye token usage (estimates) — session ${s.sessionId}`,
      `Tool definitions (fixed per session): ~${n(s.toolDefinitionTokens)} tokens, ${s.toolCount} tools`,
      `Calls: ${s.totals.calls} (${s.totals.errors} errors) | tool args in: ~${n(s.totals.inTokens)} | results out: ~${n(s.totals.outTokens)}`,
      `Total added to context ≈ ${n(s.toolDefinitionTokens + s.totals.inTokens + s.totals.outTokens)} tokens`,
    ];
    const rows = Object.entries(s.tools).sort((a, b) => b[1].outTokens - a[1].outTokens);
    if (rows.length) {
      lines.push("", "tool | calls | out | avg out | max out | err");
      for (const [name, u] of rows) {
        lines.push(
          `${name} | ${u.calls} | ${n(u.outTokens)} | ${n(Math.round(u.outTokens / u.calls))} | ${n(u.maxOutTokens)} | ${u.errors}`
        );
      }
    }
    return lines.join("\n");
  }

  private schedule(): void {
    this.dirty = true;
    if (!this.artifactsDir || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.writeCurrent();
    }, 1000);
    this.timer.unref?.();
  }

  private writeCurrent(): void {
    if (!this.artifactsDir || !this.dirty) return;
    this.dirty = false;
    try {
      fs.writeFileSync(
        path.join(this.artifactsDir, "usage.json"),
        JSON.stringify(this.summary(), null, 2),
        "utf8"
      );
    } catch (err) {
      log.warn("Failed to write usage.json", { error: String(err) });
    }
  }

  /** Writes the final state and appends one summary line to usage-history.jsonl. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const s = this.summary();
    if (s.totals.calls === 0) return; // nothing worth recording
    this.dirty = true;
    this.writeCurrent();
    log.info("Token usage (estimate)", {
      calls: s.totals.calls,
      outTokens: s.totals.outTokens,
      toolDefinitionTokens: s.toolDefinitionTokens,
    });
    if (!this.artifactsDir) return;
    try {
      const file = path.join(this.artifactsDir, "usage-history.jsonl");
      fs.appendFileSync(file, JSON.stringify(s) + "\n", "utf8");
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      if (lines.length > HISTORY_MAX_LINES) {
        fs.writeFileSync(file, lines.slice(-HISTORY_MAX_LINES).join("\n") + "\n", "utf8");
      }
    } catch (err) {
      log.warn("Failed to append usage history", { error: String(err) });
    }
  }
}
