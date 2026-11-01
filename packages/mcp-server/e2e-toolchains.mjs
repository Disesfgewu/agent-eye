// End-to-end check of detect_project + start_dev_server readiness against REAL
// toolchains. Spawns the BUILT MCP server (no browser needed), creates tiny Go /
// Rust / Python / Node projects in a temp workspace, and drives them through the
// MCP tools. A stack whose toolchain is not installed is SKIPPED, unless it is
// listed in AGENT_EYE_REQUIRE_TOOLCHAINS (CI sets "go,cargo") - then it FAILS.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const textOf = (r) => (r.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
const required = new Set((process.env.AGENT_EYE_REQUIRE_TOOLCHAINS || "").split(",").map((s) => s.trim()).filter(Boolean));
let ok = true;
const check = (name, cond, detail = "") => {
  if (!cond) ok = false;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `\n      ${String(detail).split("\n").join("\n      ")}` : ""}`);
};
const skip = (what, key) => {
  if (required.has(key)) { ok = false; console.log(`FAIL  ${what} is required (AGENT_EYE_REQUIRE_TOOLCHAINS) but not installed`); }
  else console.log(`SKIP  ${what} not installed`);
};
const has = (bin) => spawnSync(bin, [bin === "go" ? "version" : "--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const write = (root, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ae-tc-"));
const py = process.platform === "win32" ? "python" : "python3";

// ---- fixtures -------------------------------------------------------------------
const ports = { go: await freePort(), goSlow: await freePort(), rust: await freePort(), py: await freePort(), node: await freePort() };
write(ws, "py-static/index.html", "<h1>py-static-ok</h1>");
write(ws, "node-app/package.json", JSON.stringify({ scripts: { dev: "node server.js" } }));
write(ws, "node-app/server.js", `require("http").createServer((q,r)=>r.end("node-ok")).listen(${ports.node},"127.0.0.1");`);
write(ws, "go-ok/go.mod", "module example.com/ok\n\ngo 1.20\n");
write(ws, "go-ok/main.go", `package main
import ("fmt";"net/http")
func main(){ http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request){ fmt.Fprint(w, "go-ok") }); http.ListenAndServe("127.0.0.1:${ports.go}", nil) }
`);
write(ws, "go-slow/go.mod", "module example.com/slow\n\ngo 1.20\n");
write(ws, "go-slow/main.go", `package main
import ("fmt";"net/http";"time")
func main(){ time.Sleep(4*time.Second); http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request){ fmt.Fprint(w, "go-slow-ok") }); http.ListenAndServe("127.0.0.1:${ports.goSlow}", nil) }
`);
write(ws, "go-broken/go.mod", "module example.com/broken\n\ngo 1.20\n");
write(ws, "go-broken/main.go", "package main\nfunc main() { this is not go }\n");
write(ws, "rust-ok/Cargo.toml", '[package]\nname = "rust-ok"\nversion = "0.1.0"\nedition = "2021"\n');
write(ws, "rust-ok/src/main.rs", `use std::io::{Read, Write};
use std::net::TcpListener;
fn main() {
    let l = TcpListener::bind("127.0.0.1:${ports.rust}").unwrap();
    for s in l.incoming() {
        let mut s = s.unwrap();
        let mut buf = [0u8; 1024];
        let _ = s.read(&mut buf);
        let _ = s.write_all(b"HTTP/1.1 200 OK\\r\\nContent-Length: 7\\r\\nConnection: close\\r\\n\\r\\nrust-ok");
    }
}
`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--workspace", ws],
  env: { ...process.env, AGENT_EYE_HEADLESS: "1", AGENT_EYE_LOG_LEVEL: "warn" },
});
const c = new Client({ name: "e2e-toolchains", version: "0" }, {});
await c.connect(transport);
const call = (name, args) => c.callTool({ name, arguments: args });

const fetchText = async (port) => {
  for (let i = 0; i < 20; i++) {
    try { return await (await fetch(`http://127.0.0.1:${port}/`)).text(); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  return "";
};

// ---- detect_project --------------------------------------------------------------
const det = textOf(await call("detect_project", {}));
check("detect_project finds the Go project", /Go @ go-ok: .*command="go" args=\["run","\."\] cwd="go-ok"/.test(det), det);
check("detect_project finds the Rust project", /Rust @ rust-ok: .*command="cargo" args=\["run"\]/.test(det), det);
check("detect_project finds the Node project with its npm script", /@ node-app: .*command="npm" args=\["run","dev"\]/.test(det), det);
check("detect_project path=… stays inside the workspace", (await call("detect_project", { path: ".." })).isError === true);
check("detect_project path=go-ok scopes the scan", /Go @ go-ok/.test(textOf(await call("detect_project", { path: "go-ok" }))));

// ---- python (always available where Node + Python run) -----------------------------
if (has(py)) {
  const r = textOf(await call("start_dev_server", { id: "py", command: py, args: ["-m", "http.server", String(ports.py)], cwd: "py-static", port: ports.py, waitSeconds: 20 }));
  check("python http.server: start_dev_server waits until Ready", new RegExp(`Ready: http://localhost:${ports.py}`).test(r), r);
  check("python http.server: really serving", /py-static-ok/.test(await fetchText(ports.py)));
  const busy = await call("start_dev_server", { id: "py2", command: py, args: ["-m", "http.server", String(ports.py)], cwd: "py-static", port: ports.py });
  check("port already in use by another process is refused (no false 'ready')", busy.isError === true && /already accepts connections/.test(textOf(busy)), textOf(busy));
  const again = textOf(await call("start_dev_server", { id: "py", command: py, args: ["-m", "http.server", String(ports.py)], cwd: "py-static", port: ports.py }));
  check("calling again with the same id reports it running and ready", /already running/.test(again) && /Ready/.test(again), again);
  await call("stop_dev_server", { id: "py" });
} else {
  skip("python", "python");
}

// ---- node ----------------------------------------------------------------------------
{
  const r = textOf(await call("start_dev_server", { id: "node", command: "npm", args: ["run", "dev"], cwd: "node-app", port: ports.node, waitSeconds: 20 }));
  check("npm run dev: Ready", /Ready:/.test(r), r);
  check("npm run dev: really serving", /node-ok/.test(await fetchText(ports.node)));
  await call("stop_dev_server", { id: "node" });
}

// ---- go -------------------------------------------------------------------------------
if (has("go")) {
  const r = textOf(await call("start_dev_server", { id: "go", command: "go", args: ["run", "."], cwd: "go-ok", port: ports.go, waitSeconds: 55 }));
  check("go run .: Ready after the compile", /Ready:/.test(r), r);
  check("go run .: really serving", /go-ok/.test(await fetchText(ports.go)));
  await call("stop_dev_server", { id: "go" });

  const bad = await call("start_dev_server", { id: "gob", command: "go", args: ["run", "."], cwd: "go-broken", port: 59999, waitSeconds: 55 });
  check("go compile error: returned as an error with the compiler output, not 'still building'", bad.isError === true && /exited with code/.test(textOf(bad)) && /syntax error|main\.go/.test(textOf(bad)), textOf(bad));

  const slow = textOf(await call("start_dev_server", { id: "gos", command: "go", args: ["run", "."], cwd: "go-slow", port: ports.goSlow, waitSeconds: 1 }));
  check("slow server: times out politely and says how to keep waiting", /Still running but port \d+ is not accepting/.test(slow) && /same id and port/.test(slow), slow);
  const cont = textOf(await call("start_dev_server", { id: "gos", command: "go", args: ["run", "."], cwd: "go-slow", port: ports.goSlow, waitSeconds: 55 }));
  check("slow server: second call keeps waiting and becomes Ready", /already running/.test(cont) && /Ready:/.test(cont), cont);
  await call("stop_dev_server", { id: "gos" });

  const blocked = await call("start_dev_server", { id: "gox", command: "go", args: ["run", "-exec", "echo", "."], cwd: "go-ok" });
  check("go run -exec is refused by the toolchain guard", blocked.isError === true, textOf(blocked));
} else {
  skip("go", "go");
}

// ---- rust -----------------------------------------------------------------------------
if (has("cargo")) {
  const r = textOf(await call("start_dev_server", { id: "rust", command: "cargo", args: ["run", "--quiet"], cwd: "rust-ok", port: ports.rust, waitSeconds: 55 }));
  check("cargo run: Ready after the build", /Ready:/.test(r), r);
  check("cargo run: really serving", /rust-ok/.test(await fetchText(ports.rust)));
  await call("stop_dev_server", { id: "rust" });
  const blocked = await call("start_dev_server", { id: "rx", command: "cargo", args: ["watch", "-s", "echo hi"], cwd: "rust-ok" });
  check("cargo watch -s is refused by the toolchain guard", blocked.isError === true, textOf(blocked));
} else {
  skip("cargo", "cargo");
}

await c.close();
console.log(ok ? "\nALL PASSED" : "\nFAILURES");
process.exit(ok ? 0 : 1);
