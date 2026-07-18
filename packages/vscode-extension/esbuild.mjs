import { build } from "esbuild";

const production = process.argv.includes("--production");

// 1) The extension host entry.
await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  // `vscode` is provided by the extension host at runtime, never bundled.
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
});

// 2) The MCP server, bundled into the extension so the packaged .vsix is
//    self-contained (server-path.ts finds it at dist/mcp-server/index.js).
//    Playwright can't be bundled (native browsers + dynamic requires), so it
//    stays external and is shipped in the extension's node_modules.
await build({
  entryPoints: ["../mcp-server/src/index.ts"],
  bundle: true,
  outfile: "dist/mcp-server/index.js",
  platform: "node",
  // CJS so it runs under the extension's (non-module) package without needing
  // an .mjs extension; esbuild transpiles the ESM deps (MCP SDK) down.
  format: "cjs",
  target: "node20",
  external: ["playwright", "playwright-core"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
});
