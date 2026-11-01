import * as fs from "node:fs";
import * as path from "node:path";
import { isManifest } from "./detect.js";

/** Directories that never contain the project's own manifests (build output, caches, vendored code). */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "target", "dist", "build", "out", "vendor", ".venv", "venv", "__pycache__",
  ".next", ".nuxt", ".svelte-kit", "deps", "_build", "bin", "obj", ".dart_tool", ".gradle", ".idea",
  ".vscode", ".agent-artifacts", "coverage", ".cache", "Pods", ".turbo", ".parcel-cache",
]);

const MAX_DEPTH = 4;
const MAX_FILES = 4000;
const MAX_MANIFEST_BYTES = 64 * 1024;

/**
 * Read-only workspace listing for detectProjects: relative POSIX paths mapped to
 * content for known manifests (<= 64 KB) and "" for everything else. Stays inside
 * `root`: symlinks are never followed, and nothing but manifests is ever read.
 */
export function scanWorkspace(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  let count = 0;
  const walk = (abs: string, rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= MAX_FILES) return;
      if (e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) walk(childAbs, childRel, depth + 1);
      } else if (e.isFile()) {
        count++;
        let content = "";
        if (isManifest(e.name)) {
          try {
            if (fs.statSync(childAbs).size <= MAX_MANIFEST_BYTES) content = fs.readFileSync(childAbs, "utf8");
          } catch {
            /* unreadable manifest: still counts as present */
          }
        }
        files[childRel] = content;
      }
    }
  };
  walk(root, "", 0);
  return files;
}
