import { spawn, type ChildProcess } from "node:child_process";
import treeKill from "tree-kill";
import { log } from "../logger.js";
import { RingBuffer } from "../browser/ring-buffer.js";

export interface DevServerLogLine {
  timestamp: string;
  stream: "stdout" | "stderr";
  text: string;
}

interface DevServer {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  child: ChildProcess;
  logs: RingBuffer<DevServerLogLine>;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: string;
}

const LOG_CAPACITY = 1000;

/**
 * Manages dev-server child processes (plan 7.2: workspace-bound cwd, argv-only
 * spawn, owned-process-only teardown). Only servers this manager started and
 * registered can be stopped — never an arbitrary PID.
 */
export class DevServerManager {
  private servers = new Map<string, DevServer>();

  /**
   * Spawns a validated command. The caller (tool layer) must have already run
   * it through the command guard and policy; this method assumes command/args/
   * cwd are safe and only handles process lifecycle.
   */
  start(id: string, command: string, args: string[], cwd: string): { alreadyRunning: boolean } {
    const existing = this.servers.get(id);
    if (existing && existing.status === "running") {
      return { alreadyRunning: true };
    }

    const child = spawnProcess(command, args, cwd);
    const logs = new RingBuffer<DevServerLogLine>(LOG_CAPACITY);

    const server: DevServer = {
      id,
      command,
      args,
      cwd,
      child,
      logs,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
    };

    child.stdout?.on("data", (chunk: Buffer) =>
      appendLines(logs, "stdout", chunk.toString("utf8"))
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      appendLines(logs, "stderr", chunk.toString("utf8"))
    );
    child.on("exit", (code) => {
      server.status = "exited";
      server.exitCode = code;
      log.info("Dev server exited", { id, code });
    });
    child.on("error", (err) => {
      appendLines(logs, "stderr", `[agent-eye] failed to start process: ${err.message}`);
      server.status = "exited";
      server.exitCode = -1;
    });

    this.servers.set(id, server);
    log.info("Dev server started", { id, command, args, cwd, pid: child.pid });
    return { alreadyRunning: false };
  }

  getLogs(id: string, limit?: number): DevServerLogLine[] | undefined {
    return this.servers.get(id)?.logs.recent(limit);
  }

  getStatus(id: string): { status: string; exitCode: number | null } | undefined {
    const server = this.servers.get(id);
    if (!server) return undefined;
    return { status: server.status, exitCode: server.exitCode };
  }

  list(): Array<{ id: string; status: string; command: string; startedAt: string }> {
    return [...this.servers.values()].map((s) => ({
      id: s.id,
      status: s.status,
      command: [s.command, ...s.args].join(" "),
      startedAt: s.startedAt,
    }));
  }

  async stop(id: string): Promise<boolean> {
    const server = this.servers.get(id);
    if (!server) return false;
    if (server.status === "running" && server.child.pid) {
      await killTree(server.child.pid);
    }
    server.status = "exited";
    return true;
  }

  /** Kills every owned process — called on server shutdown so nothing is orphaned. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((id) => this.stop(id)));
  }
}

const isWindows = process.platform === "win32";

/**
 * Spawns without a shell on POSIX. On Windows, npm/pnpm/vite/etc. are `.cmd`
 * shims that recent Node refuses to spawn directly, so we invoke them through
 * cmd.exe with verbatim arguments. This is only safe because the command guard
 * has already rejected shell metacharacters in the command and args.
 */
function spawnProcess(command: string, args: string[], cwd: string): ChildProcess {
  const env = { ...process.env, FORCE_COLOR: "0", BROWSER: "none" };
  if (!isWindows) {
    return spawn(command, args, { cwd, env, shell: false });
  }
  const line = [command, ...args.map(quoteWinArg)].join(" ");
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], {
    cwd,
    env,
    windowsVerbatimArguments: true,
  });
}

function quoteWinArg(arg: string): string {
  if (arg === "" || /[\s"]/.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg;
}

function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    treeKill(pid, "SIGTERM", (err) => {
      if (err) log.warn("tree-kill failed", { pid, error: String(err) });
      resolve();
    });
  });
}

function appendLines(
  buffer: RingBuffer<DevServerLogLine>,
  stream: "stdout" | "stderr",
  chunk: string
): void {
  for (const line of chunk.split(/\r?\n/)) {
    if (line.length === 0) continue;
    buffer.push({ timestamp: new Date().toISOString(), stream, text: line });
  }
}
