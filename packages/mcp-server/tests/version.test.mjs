import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SERVER_VERSION } from "../dist/version.js";

const read = (rel) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

test("the version reported to MCP clients matches every package.json (no drift)", () => {
  const server = read("../package.json").version;
  const root = read("../../../package.json").version;
  const ext = read("../../vscode-extension/package.json").version;
  assert.equal(SERVER_VERSION, server);
  assert.equal(root, server);
  assert.equal(ext, server);
});

test("the Python package reports the same version (pyproject + __version__)", () => {
  const server = read("../package.json").version;
  const pyproject = fs.readFileSync(fileURLToPath(new URL("../../python/pyproject.toml", import.meta.url)), "utf8");
  const init = fs.readFileSync(fileURLToPath(new URL("../../python/src/agent_eye/__init__.py", import.meta.url)), "utf8");
  assert.equal(/^version = "([^"]+)"/m.exec(pyproject)?.[1], server);
  assert.equal(/^__version__ = "([^"]+)"/m.exec(init)?.[1], server);
});

test("SKILL.md frontmatter description stays short (it is loaded into every conversation)", () => {
  const skill = fs.readFileSync(fileURLToPath(new URL("../../../skills/agent-eye/SKILL.md", import.meta.url)), "utf8");
  const desc = /^description: (.*)$/m.exec(skill)?.[1] ?? "";
  assert.ok(desc.length > 50, "has a description");
  assert.ok(desc.length <= 600, `description is ${desc.length} chars; keep it <= 600`);
});

test("SKILL.md does not contradict itself about closing the browser", () => {
  const skill = fs.readFileSync(fileURLToPath(new URL("../../../skills/agent-eye/SKILL.md", import.meta.url)), "utf8");
  assert.ok(!/Never close or relaunch/i.test(skill));
  assert.ok(!/another instance owns/i.test(skill), "the instance lock was removed in 0.1.1");
});

test("the extension's pinned Playwright satisfies the server's range and is what the lockfile resolves (Issue #67)", () => {
  const range = read("../package.json").dependencies.playwright; // e.g. "^1.64.1"
  const min = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)?.slice(1).map(Number);
  assert.ok(min, `expected a caret range, got ${range}`);
  const runtime = fs.readFileSync(fileURLToPath(new URL("../../vscode-extension/src/runtime.ts", import.meta.url)), "utf8");
  const pinText = /const PLAYWRIGHT_VERSION = "(\d+\.\d+\.\d+)"/.exec(runtime)?.[1];
  assert.ok(pinText, "PLAYWRIGHT_VERSION not found in runtime.ts");
  const pin = pinText.split(".").map(Number);
  const atLeast = pin[0] > min[0] || (pin[0] === min[0] && (pin[1] > min[1] || (pin[1] === min[1] && pin[2] >= min[2])));
  assert.equal(pin[0], min[0], "same major");
  assert.ok(atLeast, `extension pins ${pinText}, below the server's range ${range}`);
  const lock = read("../../../package-lock.json").packages["node_modules/playwright"].version;
  assert.equal(lock, pinText, "the extension installs the same Playwright the lockfile (and CI) tests against");
});
