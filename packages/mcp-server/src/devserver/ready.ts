import * as net from "node:net";

/**
 * Readiness helpers for start_dev_server (Issue #22). Compiled stacks (Go, Rust,
 * .NET, JVM) take seconds to minutes to build; polling logs costs one LLM turn per
 * poll and a compile error looks like "still building". Waiting server-side for the
 * port — or for the process to die — removes both problems.
 *
 * Probing is loopback-only (127.0.0.1 / ::1) by construction, so it cannot be
 * turned into a port scanner for other hosts.
 */

/** Loopback hosts named in a log line, e.g. "http://127.0.0.1:8080", "localhost:3000", "[::]:4000". */
const LOOPBACK_PORT = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/g;
/** "Listening and serving HTTP on :8080", "listening on :3000". */
const LISTEN_PORT = /\b(?:listening|serving|running|started|bound|binding)\b[^\n]{0,40}?\s:(\d{2,5})\b/gi;
/** "Server running on port 3000", "port: 8080". */
const PORT_WORD = /\bport\s*(?:is|=|:)?\s*(\d{2,5})\b/gi;

/** Distinct plausible listening ports mentioned in log lines, in first-seen order. */
export function extractPorts(lines: string[], max = 5): number[] {
  const seen: number[] = [];
  for (const line of lines) {
    for (const re of [LOOPBACK_PORT, LISTEN_PORT, PORT_WORD]) {
      re.lastIndex = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        const port = Number(m[1]);
        if (port >= 80 && port <= 65535 && !seen.includes(port)) seen.push(port);
      }
    }
  }
  return seen.slice(0, max);
}

export function tryConnect(port: number, host: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function portOpen(port: number): Promise<boolean> {
  return (await tryConnect(port, "127.0.0.1")) || (await tryConnect(port, "::1"));
}

export type WaitOutcome = { state: "ready" | "exited" | "timeout"; elapsedMs: number };

export interface WaitOptions {
  timeoutMs: number;
  /** False once the dev-server process has exited. */
  isAlive: () => boolean;
  intervalMs?: number;
  /** Injectable for tests. */
  probe?: (port: number) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Resolves when the port accepts connections, the process exits, or the timeout elapses. */
export async function waitForPort(port: number, opts: WaitOptions): Promise<WaitOutcome> {
  const probe = opts.probe ?? portOpen;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  for (;;) {
    const alive = opts.isAlive();
    // Probe even after exit once: a launcher may hand the server to a daemon and return.
    if (await probe(port)) return { state: "ready", elapsedMs: now() - start };
    if (!alive) return { state: "exited", elapsedMs: now() - start };
    if (now() - start >= opts.timeoutMs) return { state: "timeout", elapsedMs: now() - start };
    await sleep(opts.intervalMs ?? 250);
  }
}
