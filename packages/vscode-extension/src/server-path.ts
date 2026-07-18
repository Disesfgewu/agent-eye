import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Locates the built Agent Eye MCP server entry point. Checks, in order:
 *  1. a copy bundled into the packaged extension (dist/mcp-server/index.js),
 *  2. the sibling workspace package during monorepo development,
 *  3. an installed npm dependency.
 * Returns undefined if the server hasn't been built yet.
 */
export function resolveServerEntry(extensionPath: string): string | undefined {
  const candidates = [
    path.join(extensionPath, "dist", "mcp-server", "index.js"),
    path.join(extensionPath, "..", "mcp-server", "dist", "index.js"),
    path.join(extensionPath, "node_modules", "@agent-eye", "mcp-server", "dist", "index.js"),
  ];
  return candidates.find((p) => fs.existsSync(p));
}
