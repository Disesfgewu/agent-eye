/**
 * Windows argument safety for start_dev_server (Issue #27).
 *
 * `.cmd` shims (npm, vite, ...) can only be started through `cmd.exe /d /s /c "<line>"`,
 * and cmd.exe treats `& | < > ^ ( )` in that line as operators. Arguments are therefore
 * (1) quoted so those characters are literal, and (2) refused outright when they cannot
 * be quoted reliably: an embedded `"` (cmd's quote toggling can re-open the unquoted
 * region), `%` (environment expansion happens even inside quotes) and `^`.
 */

/** A reason when `arg` cannot be passed through cmd.exe safely; undefined when it can (after quoting). */
export function windowsUnsafeArg(arg: string): string | undefined {
  if (/["%^]/.test(arg)) {
    return `argument ${JSON.stringify(arg.length > 40 ? `${arg.slice(0, 40)}...` : arg)} contains " % or ^, which cmd.exe would interpret; rename or drop it`;
  }
  return undefined;
}

/** Quotes an argument for a cmd.exe command line (call windowsUnsafeArg first). */
export function quoteWinArg(arg: string): string {
  return arg === "" || /[\s&|<>^()!]/.test(arg) ? `"${arg}"` : arg;
}
