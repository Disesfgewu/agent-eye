/**
 * All diagnostic logging MUST go to stderr. stdout is reserved for the MCP
 * JSON-RPC stream when running over the stdio transport; writing anything else
 * there corrupts the protocol.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let threshold: LogLevel =
  (process.env.AGENT_EYE_LOG_LEVEL as LogLevel | undefined) ?? "info";

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function emit(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;
  const time = new Date().toISOString();
  const prefix = `[agent-eye ${time}] ${level.toUpperCase()}`;
  if (meta !== undefined) {
    process.stderr.write(`${prefix} ${message} ${safeJson(meta)}\n`);
  } else {
    process.stderr.write(`${prefix} ${message}\n`);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (message: string, meta?: unknown) => emit("debug", message, meta),
  info: (message: string, meta?: unknown) => emit("info", message, meta),
  warn: (message: string, meta?: unknown) => emit("warn", message, meta),
  error: (message: string, meta?: unknown) => emit("error", message, meta),
};
