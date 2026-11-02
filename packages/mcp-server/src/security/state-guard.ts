import * as fs from "node:fs";
import * as path from "node:path";
import { isInside } from "../config.js";

/**
 * Guards for the state tools (Issue #38): `browser_set_storage` (cookies / localStorage /
 * sessionStorage) and `browser_upload_file`. Both are write-only from the agent's side: nothing
 * reads state back into the transcript, and values never reach logs or the activity timeline.
 *
 * Upload risk: a file the agent attaches can be sent anywhere the page decides to send it, and
 * pages are not restricted in where THEY connect. So uploads are limited to regular files inside
 * the workspace (symlinks resolved first), never anything that looks like a secret or tooling
 * state, and are size-capped. A name-based deny list is defense in depth, not a guarantee:
 * `execute`/`sideEffect` policy still decides whether the action is allowed at all.
 */
export const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 10;

const FORBIDDEN_DIRS = new Set([".git", ".agent-eye", ".agent-artifacts", ".ssh", ".aws", ".gnupg", ".kube", ".docker"]);
const SECRET_FILE = [
  /^\.env(\..*)?$/i, /^\.npmrc$/i, /^\.netrc$/i, /^\.pypirc$/i, /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i,
  /^credentials(\.\w+)?$/i, /^secrets?\.(json|ya?ml|toml|env)$/i, /^service-account.*\.json$/i, /^\.htpasswd$/i,
];

export type UploadCheck = { ok: true; abs: string; size: number } | { ok: false; reason: string };

export function checkUploadPath(workspaceRoot: string, requested: string): UploadCheck {
  if (!requested || requested.includes("\0")) return { ok: false, reason: "empty or invalid path" };
  let real: string;
  let root: string;
  try {
    root = fs.realpathSync(workspaceRoot);
    real = fs.realpathSync(path.resolve(workspaceRoot, requested));
  } catch {
    return { ok: false, reason: `"${requested}" does not exist` };
  }
  if (!isInside(root, real)) return { ok: false, reason: `"${requested}" is outside the workspace` };
  const rel = path.relative(root, real).split(path.sep);
  const dir = rel.slice(0, -1).find((s) => FORBIDDEN_DIRS.has(s.toLowerCase()));
  if (dir) return { ok: false, reason: `files under "${dir}" are never uploaded` };
  const base = rel[rel.length - 1];
  if (SECRET_FILE.some((re) => re.test(base))) return { ok: false, reason: `"${base}" looks like a secret/credential file` };
  const st = fs.statSync(real);
  if (!st.isFile()) return { ok: false, reason: `"${requested}" is not a regular file` };
  if (st.size > MAX_UPLOAD_FILE_BYTES) return { ok: false, reason: `"${base}" is ${(st.size / 1048576).toFixed(1)} MB (limit ${MAX_UPLOAD_FILE_BYTES / 1048576} MB per file)` };
  return { ok: true, abs: real, size: st.size };
}

/** Checks a list of upload paths together (count + total size). */
export function checkUploads(workspaceRoot: string, requested: string[]): { ok: true; files: Array<{ abs: string; size: number; name: string }> } | { ok: false; reason: string } {
  if (!requested.length) return { ok: false, reason: "no files given" };
  if (requested.length > MAX_UPLOAD_FILES) return { ok: false, reason: `at most ${MAX_UPLOAD_FILES} files per call` };
  const files: Array<{ abs: string; size: number; name: string }> = [];
  for (const r of requested) {
    const c = checkUploadPath(workspaceRoot, r);
    if (!c.ok) return { ok: false, reason: c.reason };
    files.push({ abs: c.abs, size: c.size, name: path.basename(c.abs) });
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_UPLOAD_TOTAL_BYTES) return { ok: false, reason: `total ${(total / 1048576).toFixed(1)} MB exceeds ${MAX_UPLOAD_TOTAL_BYTES / 1048576} MB` };
  return { ok: true, files };
}

// ---- storage -----------------------------------------------------------------------

const COOKIE_NAME = /^[\w!#$%&'*+.^`|~-]{1,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_COOKIES = 30;
const MAX_ENTRIES = 50;
const MAX_COOKIE_VALUE = 4096;
const MAX_STORAGE_KEY = 128;
const MAX_STORAGE_VALUE = 8192;

export interface CookieInput {
  name: string;
  value: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface StorageInput {
  cookies?: CookieInput[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

/** A reason when the input is not acceptable (bad names, control characters, too large); undefined when fine. */
export function storageInputProblem(input: StorageInput): string | undefined {
  const cookies = input.cookies ?? [];
  if (cookies.length > MAX_COOKIES) return `at most ${MAX_COOKIES} cookies per call`;
  for (const c of cookies) {
    if (!COOKIE_NAME.test(c.name)) return `cookie name ${JSON.stringify(c.name.slice(0, 40))} is not a valid cookie name`;
    if (c.value.length > MAX_COOKIE_VALUE || CONTROL.test(c.value) || /[;,\s"\\]/.test(c.value)) {
      return `cookie "${c.name}": value must be at most ${MAX_COOKIE_VALUE} chars without whitespace, ; , " \\ or control characters`;
    }
    if (c.path !== undefined && !/^\/[\w\-./~%]*$/.test(c.path)) return `cookie "${c.name}": invalid path`;
    if (c.sameSite === "None" && c.secure !== true) return `cookie "${c.name}": SameSite=None requires secure`;
  }
  for (const [kind, store] of [["localStorage", input.localStorage], ["sessionStorage", input.sessionStorage]] as const) {
    const entries = Object.entries(store ?? {});
    if (entries.length > MAX_ENTRIES) return `at most ${MAX_ENTRIES} ${kind} entries per call`;
    for (const [k, v] of entries) {
      if (!k || k.length > MAX_STORAGE_KEY) return `${kind} key ${JSON.stringify(k.slice(0, 40))} must be 1-${MAX_STORAGE_KEY} chars`;
      if (v.length > MAX_STORAGE_VALUE) return `${kind}["${k}"] is larger than ${MAX_STORAGE_VALUE} chars`;
    }
  }
  return undefined;
}
