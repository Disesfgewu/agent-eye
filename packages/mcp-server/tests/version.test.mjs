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
