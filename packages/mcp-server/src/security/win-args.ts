import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Windows launch safety for start_dev_server (Issues #27, #35).
 *
 * Real executables (`go.exe`, `cargo.exe`, `dotnet.exe`, `node.exe`, `python.exe`, ...) are
 * spawned DIRECTLY, with no shell: Node quotes the argv correctly and no argument is ever
 * interpreted, so any argument is fine.
 *
 * Only `.cmd` / `.bat` shims (npm, pnpm, yarn, vite, ...) must go through
 * `cmd.exe /d /s /c "<line>"`, and cmd.exe treats `& | < > ^ ( )` in that line as
 * operators. For that path arguments are (1) quoted so those characters are literal, and
 * (2) refused outright when they cannot be quoted reliably: an embedded `"` (cmd's quote
 * toggling can re-open the unquoted region), `%` (environment expansion happens even
 * inside quotes) and `^`.
 */

/** A reason when `arg` cannot be passed through cmd.exe safely; undefined when it can (after quoting). */
export function windowsUnsafeArg(arg: string): string | undefined {
  if (/["%^]/.test(arg)) {
    return `argument ${JSON.stringify(arg.length > 40 ? `${arg.slice(0, 40)}...` : arg)} contains " % or ^, which cmd.exe would interpret (this command is a .cmd/.bat shim, so it must go through cmd.exe); rename or drop it`;
  }
  return undefined;
}

/** Quotes an argument for a cmd.exe command line (call windowsUnsafeArg first). */
export function quoteWinArg(arg: string): string {
  return arg === "" || /[\s&|<>^()!]/.test(arg) ? `"${arg}"` : arg;
}

export type WinLaunch = { mode: "direct"; file: string } | { mode: "cmd" };

/**
 * How a command will be started on Windows, resolved like cmd.exe does: the working
 * directory first, then PATH, trying each PATHEXT extension in order. A real executable
 * (`.exe`/`.com`) is launched directly; a `.cmd`/`.bat` shim, an unresolvable name or
 * anything else goes through cmd.exe (which then reports "not recognized" if missing).
 */
export function windowsLaunch(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): WinLaunch {
  const pathext = (env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const hasDir = /[\\/]/.test(command);
  const ext = path.extname(command).toLowerCase();
  const dirs = hasDir ? [path.resolve(cwd)] : [path.resolve(cwd), ...(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)];
  const exts = ext && pathext.includes(ext) ? [""] : pathext;
  for (const dir of dirs) {
    for (const e of exts) {
      const file = hasDir ? path.resolve(cwd, command + e) : path.join(dir, command + e);
      let isFile = false;
      try {
        isFile = fs.statSync(file).isFile();
      } catch {
        /* not here */
      }
      if (!isFile) continue;
      const found = path.extname(file).toLowerCase();
      return found === ".exe" || found === ".com" ? { mode: "direct", file } : { mode: "cmd" };
    }
  }
  return { mode: "cmd" };
}
