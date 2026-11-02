import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProcessReaper, processStartSync } from "../dist/reaper.js";

const reaperUrl = new URL("../dist/reaper.js", import.meta.url).href;
const SLEEPER = ["-e", "setTimeout(() => {}, 300000)"];
const procs = [];
const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ae-pids-"));
const sleeper = () => {
  const p = spawn(process.execPath, SLEEPER, { stdio: "ignore", windowsHide: true });
  procs.push(p);
  return p;
};
const alive = (pid) => processStartSync(pid) !== undefined;
const until = async (pred, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return pred();
};
const deadPid = async () => {
  const p = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((r) => p.on("exit", r));
  return p.pid;
};
const record = (dir, owner, ownerStart, children) =>
  fs.writeFileSync(path.join(dir, String(owner)), JSON.stringify({ ownerStart, children: children.map(([pid, start]) => ({ pid, start })) }));

test.after(() => {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
});

test("processStartSync: a token for a live process, undefined for a gone or invalid one (Issue #68)", async () => {
  const p = sleeper();
  await until(() => processStartSync(p.pid) !== undefined);
  const a = processStartSync(p.pid);
  assert.ok(a);
  assert.equal(a, processStartSync(p.pid), "stable");
  assert.notEqual(a, processStartSync(process.pid), "different processes differ");
  p.kill();
  assert.ok(await until(() => processStartSync(p.pid) === undefined, 10000), "gone once exited");
  assert.equal(processStartSync(0), undefined);
  assert.equal(processStartSync(-5), undefined);
});

test("reapStale kills the orphan of a dead owner when its start time matches", async () => {
  const dir = mkdir();
  const child = sleeper();
  await until(() => processStartSync(child.pid) !== undefined);
  record(dir, await deadPid(), "x", [[child.pid, processStartSync(child.pid)]]);
  assert.deepEqual(ProcessReaper.reapStale(dir), [child.pid]);
  assert.ok(await until(() => child.exitCode !== null || child.signalCode !== null, 10000), "the orphan is really dead");
  assert.deepEqual(fs.readdirSync(dir), [], "the dead owner's record is removed");
});

test("a recorded PID now used by an unrelated process is NEVER killed", async () => {
  const dir = mkdir();
  const innocent = sleeper();
  await until(() => processStartSync(innocent.pid) !== undefined);
  record(dir, await deadPid(), null, [[innocent.pid, "start-time-of-some-earlier-process"]]);
  assert.deepEqual(ProcessReaper.reapStale(dir), []);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(innocent.exitCode, null);
  assert.ok(alive(innocent.pid), "the unrelated process survived");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("children of a live owner are left alone, and so is its record", async () => {
  const dir = mkdir();
  const owner = sleeper();
  const child = sleeper();
  await until(() => processStartSync(owner.pid) !== undefined && processStartSync(child.pid) !== undefined);
  record(dir, owner.pid, processStartSync(owner.pid), [[child.pid, processStartSync(child.pid)]]);
  assert.deepEqual(ProcessReaper.reapStale(dir), []);
  assert.equal(child.exitCode, null);
  assert.deepEqual(fs.readdirSync(dir), [String(owner.pid)]);
});

test("an owner PID reused by another process counts as dead; the stranger is untouched", async () => {
  const dir = mkdir();
  const stranger = sleeper();
  const child = sleeper();
  await until(() => processStartSync(stranger.pid) !== undefined && processStartSync(child.pid) !== undefined);
  record(dir, stranger.pid, "start-time-of-the-original-owner", [[child.pid, processStartSync(child.pid)]]);
  assert.deepEqual(ProcessReaper.reapStale(dir), [child.pid]);
  assert.ok(await until(() => child.exitCode !== null || child.signalCode !== null, 10000));
  assert.equal(stranger.exitCode, null, "the stranger that reused the owner PID is not touched");
});

test("legacy (newline-separated PIDs), corrupt and foreign files are never acted on", async () => {
  const dir = mkdir();
  const live = sleeper();
  await until(() => processStartSync(live.pid) !== undefined);
  fs.writeFileSync(path.join(dir, String(await deadPid())), `${live.pid}\n`); // the format older versions wrote
  fs.writeFileSync(path.join(dir, String(await deadPid())), "{ not json");
  fs.writeFileSync(path.join(dir, "not-a-pid"), "x");
  assert.deepEqual(ProcessReaper.reapStale(dir), [], "without a start time nothing is killed");
  assert.equal(live.exitCode, null);
  assert.deepEqual(fs.readdirSync(dir), ["not-a-pid"]);
});

test("track records the start time (immediately on POSIX, a moment later on Windows) and untrack/dispose clean up", async () => {
  const dir = mkdir();
  const reaper = new ProcessReaper(dir);
  const child = sleeper();
  await until(() => processStartSync(child.pid) !== undefined);
  reaper.track(child.pid);
  const file = path.join(dir, String(process.pid));
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(await until(() => read().children[0]?.start, 20000), "the start time was recorded");
  assert.deepEqual(read().children, [{ pid: child.pid, start: processStartSync(child.pid) }]);
  assert.equal(read().ownerStart, processStartSync(process.pid));
  reaper.untrack(child.pid);
  assert.deepEqual(read().children, []);
  reaper.dispose();
  assert.equal(fs.existsSync(file), false);
});

test("a hard-killed server leaves its child running; the next start reaps it (real processes)", async () => {
  const dir = mkdir();
  const script = `
    import { spawn } from "node:child_process";
    import { ProcessReaper } from ${JSON.stringify(reaperUrl)};
    const reaper = new ProcessReaper(${JSON.stringify(dir)});
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { stdio: "ignore", detached: true });
    reaper.track(child.pid);
    console.log(JSON.stringify({ owner: process.pid, child: child.pid }));
    setInterval(() => {}, 1000);
  `;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  procs.push(owner);
  const info = await new Promise((resolve, reject) => {
    owner.stdout.once("data", (d) => resolve(JSON.parse(d.toString().trim().split("\n")[0])));
    owner.on("exit", () => reject(new Error("owner exited early")));
  });
  const file = path.join(dir, String(info.owner));
  assert.ok(await until(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).children[0]?.start, 20000), "registered with a start time");
  owner.kill("SIGKILL"); // TerminateProcess on Windows: no exit handlers, no shutdown
  await new Promise((r) => owner.on("exit", r));
  assert.ok(alive(info.child), "premise: the orphan outlives its owner");
  assert.ok(ProcessReaper.reapStale(dir).includes(info.child));
  assert.ok(await until(() => !alive(info.child), 15000), "the orphan was reaped");
});

test("a zombie (finished, not yet waited for by its parent) has no start time, so a zombie owner counts as dead (Linux)", { skip: process.platform !== "linux" }, async () => {
  // `sleep 0.1 &` exits at once and stays a zombie because the shell then exec()s into a `sleep` that never wait()s for it
  const holder = spawn("sh", ["-c", "sleep 0.1 & echo $!; exec sleep 300"], { stdio: ["ignore", "pipe", "ignore"] });
  procs.push(holder);
  const zombie = Number(await new Promise((resolve) => holder.stdout.once("data", (d) => resolve(d.toString().trim()))));
  assert.ok(await until(() => fs.readFileSync(`/proc/${zombie}/stat`, "utf8").includes(") Z "), 5000), "premise: it is a zombie");
  assert.equal(processStartSync(zombie), undefined, "a zombie is finished");
  // and as an owner: its record must be reaped even though /proc/<pid> still exists
  const dir = mkdir();
  const child = sleeper();
  await until(() => processStartSync(child.pid) !== undefined);
  record(dir, zombie, "any", [[child.pid, processStartSync(child.pid)]]);
  assert.deepEqual(ProcessReaper.reapStale(dir), [child.pid]);
});
