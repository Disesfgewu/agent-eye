import { build } from "esbuild";

const production = process.argv.includes("--production");

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
