import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { detectProjects, formatDetected } from "../dist/project/detect.js";
import { scanWorkspace } from "../dist/project/scan.js";
import { extractPorts, portOpen, waitForPort } from "../dist/devserver/ready.js";
import { classifyCommand } from "../dist/security/command-guard.js";
import { DEFAULT_POLICY } from "../dist/policy/types.js";

const cases = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/detect-cases.json", import.meta.url)), "utf8"));
const ws = path.resolve("/tmp/ws");

for (const c of cases) {
  test(`detect: ${c.name}`, () => {
    const res = detectProjects(c.files, { platform: c.platform ?? "linux" });
    assert.equal(res.projects.length, c.expect.length, `expected ${c.expect.length} project(s), got ${JSON.stringify(res.projects)}`);
    c.expect.forEach((want, i) => {
      for (const [k, v] of Object.entries(want)) assert.deepEqual(res.projects[i][k], v, `project ${i} ${k}`);
    });
    if (c.notes !== undefined) assert.equal(res.notes.length, c.notes);
  });
}

test("every suggested command is accepted by the command guard under the default policy", () => {
  for (const c of cases) {
    for (const platform of ["linux", "win32"]) {
      for (const p of detectProjects(c.files, { platform }).projects) {
        const v = classifyCommand(p.command, p.args, p.dir, ws, DEFAULT_POLICY.commandAllowlist);
        assert.equal(v.verdict, "allowlisted", `${c.name} (${platform}): ${p.command} ${p.args.join(" ")} in ${p.dir} -> ${v.reason ?? v.verdict}`);
      }
    }
  }
});

test("formatDetected: one compact line per project, with guard verdicts and notes", () => {
  const res = detectProjects(cases.find((c) => c.name === "go gin at the root").files);
  const out = formatDetected(res);
  assert.match(out, /1\. Go · Gin @ \.: start_dev_server id="app" command="go" args=\["run","\."\] cwd="\." port=8080 \(typical\)/);
  assert.match(formatDetected(res, ["Command \"go\" is not in the allowlist."]), /\[NOT STARTABLE: Command "go"/);
  assert.match(formatDetected({ projects: [], notes: [] }), /No runnable project found/);
});

test("scanWorkspace: reads manifests only, skips vendored dirs, never follows symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ae-scan-"));
  const w = (rel, body = "") => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  w("go.mod", "module x\n");
  w("main.go", "package main // secret-body");
  w("node_modules/dep/package.json", "{}");
  w("target/debug/Cargo.toml", "[package]");
  w("a/b/c/d/e/package.json", "{}"); // deeper than the scan limit
  w("svc/Cargo.toml", "[package]\nname=\"svc\"\n");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ae-outside-"));
  fs.writeFileSync(path.join(outside, "package.json"), "{\"scripts\":{\"dev\":\"x\"}}");
  try {
    fs.symlinkSync(outside, path.join(root, "link"), "junction");
  } catch {
    /* symlinks unavailable: the rest of the assertions still hold */
  }
  const files = scanWorkspace(root);
  assert.equal(files["go.mod"], "module x\n");
  assert.equal(files["main.go"], "", "non-manifest content is never read");
  assert.ok(!Object.keys(files).some((p) => p.startsWith("node_modules") || p.startsWith("target") || p.startsWith("link")));
  assert.ok(!("a/b/c/d/e/package.json" in files));
  assert.match(files["svc/Cargo.toml"], /svc/);
});

test("extractPorts: common dev-server banners", () => {
  assert.deepEqual(extractPorts(["[GIN-debug] Listening and serving HTTP on :8080"]), [8080]);
  assert.deepEqual(extractPorts(["  Local:   http://localhost:5173/"]), [5173]);
  assert.deepEqual(extractPorts(["server listening at http://127.0.0.1:8080/", "listening on http://[::1]:3000"]), [8080, 3000]);
  assert.deepEqual(extractPorts(["Server running on port 4000"]), [4000]);
  assert.deepEqual(extractPorts(["Running MyAppWeb.Endpoint with Bandit at 127.0.0.1:4000 (http)"]), [4000]);
  assert.deepEqual(extractPorts(["12:30:45 INFO started in 3000 ms", "ok"]), [], "timestamps and durations are not ports");
  assert.deepEqual(extractPorts(["localhost:99999", "localhost:22"]), [], "out-of-range / privileged ports ignored");
});

test("waitForPort: ready, exited and timeout outcomes (injected clock)", async () => {
  const mk = (probeResults, aliveResults) => {
    let t = 0;
    let i = 0;
    let j = 0;
    return {
      timeoutMs: 1000,
      intervalMs: 100,
      now: () => t,
      sleep: async (ms) => { t += ms; },
      probe: async () => probeResults[Math.min(i++, probeResults.length - 1)],
      isAlive: () => aliveResults[Math.min(j++, aliveResults.length - 1)],
    };
  };
  const ready = await waitForPort(1, mk([false, false, true], [true]));
  assert.equal(ready.state, "ready");
  assert.equal(ready.elapsedMs, 200);
  const exited = await waitForPort(1, mk([false], [true, false]));
  assert.equal(exited.state, "exited");
  const timeout = await waitForPort(1, mk([false], [true]));
  assert.equal(timeout.state, "timeout");
  assert.ok(timeout.elapsedMs >= 1000);
  const daemon = await waitForPort(1, mk([true], [false]));
  assert.equal(daemon.state, "ready", "a launcher that exits after handing off to a daemon still counts as ready");
});

test("portOpen: real loopback listener", async () => {
  const srv = net.createServer((s) => s.end());
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  assert.equal(await portOpen(port), true);
  await new Promise((r) => srv.close(r));
  assert.equal(await portOpen(port), false);
});
