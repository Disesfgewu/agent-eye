// End-to-end check of detect_project + start_dev_server against the heavier real toolchains:
// .NET, Maven (Spring Boot), Gradle, Elixir and Trunk (Rust -> wasm). Each stack builds a tiny
// project in a temp workspace and drives it through the BUILT MCP server (no browser needed).
//
//   AGENT_EYE_STACK=dotnet|maven|gradle|elixir|trunk[,..]   which stacks to run (default: all installed)
//   AGENT_EYE_REQUIRE_TOOLCHAINS=dotnet,...                 a missing toolchain FAILS instead of being skipped (CI)
//
// First builds download dependencies and can exceed one tool call's 55 s, so start_dev_server is
// called again with the same id+port, exactly as its "still running" reply instructs; that loop is
// part of what is being verified.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const textOf = (r) => (r.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
const required = new Set((process.env.AGENT_EYE_REQUIRE_TOOLCHAINS || "").split(",").map((s) => s.trim()).filter(Boolean));
const wanted = (process.env.AGENT_EYE_STACK || "dotnet,maven,gradle,elixir,trunk").split(",").map((s) => s.trim()).filter(Boolean);
let ok = true;
const check = (name, cond, detail = "") => {
  if (!cond) ok = false;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `\n      ${String(detail).split("\n").join("\n      ")}` : ""}`);
};
const has = (bin, arg = "--version") => spawnSync(bin, [arg], { stdio: "ignore" }).status === 0;
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const write = (root, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};
// Polls until the page contains `expect` (some servers, e.g. trunk, open the port before the first build finishes).
const fetchText = async (port, expect) => {
  let last = "";
  for (let i = 0; i < 60; i++) {
    try {
      last = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      if (!expect || last.includes(expect)) return last;
    } catch { /* not accepting yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ae-tcx-"));
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--workspace", ws],
  env: { ...process.env, AGENT_EYE_HEADLESS: "1", AGENT_EYE_LOG_LEVEL: "warn" },
});
const c = new Client({ name: "e2e-toolchains-extra", version: "0" }, {});
await c.connect(transport);
const call = (name, args) => c.callTool({ name, arguments: args });

/** Starts the server, calling again (as the reply says) until Ready, an error, or `maxCalls` is used up. */
async function startUntilReady(id, command, args, cwd, port, maxCalls = 8) {
  let last = "";
  let calls = 0;
  for (; calls < maxCalls; calls++) {
    const r = await call("start_dev_server", { id, command, args, cwd, port, waitSeconds: 55 });
    last = textOf(r);
    if (r.isError || /Ready:/.test(last)) return { ready: /Ready:/.test(last), error: r.isError === true, text: last, calls: calls + 1 };
  }
  return { ready: false, error: false, text: last, calls };
}

const STACKS = {
  dotnet: {
    tool: ["dotnet"],
    async run() {
      const port = await freePort();
      write(ws, "dotnet-ok/dotnet-ok.csproj", '<Project Sdk="Microsoft.NET.Sdk.Web">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>enable</ImplicitUsings>\n  </PropertyGroup>\n</Project>\n');
      write(ws, "dotnet-ok/Program.cs", `var app = WebApplication.CreateBuilder(args).Build();\napp.MapGet("/", () => "dotnet-ok");\napp.Run("http://127.0.0.1:${port}");\n`);
      const det = textOf(await call("detect_project", { path: "dotnet-ok" }));
      check("dotnet: detect_project finds ASP.NET Core with `dotnet run`", /ASP\.NET Core @ dotnet-ok: .*command="dotnet" args=\["run"\]/.test(det), det);
      const r = await startUntilReady("dn", "dotnet", ["run"], "dotnet-ok", port);
      check(`dotnet: dotnet run -> Ready (${r.calls} call(s))`, r.ready, r.text);
      check("dotnet: really serving", /dotnet-ok/.test(await fetchText(port, "dotnet-ok")));
      await call("stop_dev_server", { id: "dn" });
      check("dotnet: -p:RunCommand=... is refused", (await call("start_dev_server", { id: "dx", command: "dotnet", args: ["run", "-p:RunCommand=echo"], cwd: "dotnet-ok" })).isError === true);
    },
  },
  maven: {
    tool: ["mvn", "-v"],
    async run() {
      const port = await freePort();
      write(ws, "mvn-ok/pom.xml", `<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.5</version></parent>
  <groupId>example</groupId><artifactId>mvn-ok</artifactId><version>0.0.1</version>
  <properties><java.version>17</java.version></properties>
  <dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>
  <build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build>
</project>
`);
      write(ws, "mvn-ok/src/main/java/example/App.java", 'package example;\nimport org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.RestController;\n@SpringBootApplication\n@RestController\npublic class App {\n  public static void main(String[] a) { SpringApplication.run(App.class, a); }\n  @GetMapping("/") String hi() { return "maven-ok"; }\n}\n');
      const det = textOf(await call("detect_project", { path: "mvn-ok" }));
      check("maven: detect_project finds Spring Boot with `mvn spring-boot:run`", /Spring Boot \(Maven\) @ mvn-ok: .*command="mvn" args=\["spring-boot:run"\]/.test(det), det);
      const r = await startUntilReady("mv", "mvn", ["-B", "spring-boot:run", `-Dspring-boot.run.arguments=--server.port=${port}`], "mvn-ok", port, 10);
      check(`maven: spring-boot:run -> Ready (${r.calls} call(s))`, r.ready, r.text);
      check("maven: really serving", /maven-ok/.test(await fetchText(port, "maven-ok")));
      await call("stop_dev_server", { id: "mv" });
      check("maven: -Dspring-boot.run.jvmArguments=-javaagent... is refused", (await call("start_dev_server", { id: "mx", command: "mvn", args: ["spring-boot:run", "-Dspring-boot.run.jvmArguments=-javaagent:/tmp/x.jar"], cwd: "mvn-ok" })).isError === true);
      check("maven: exec:java is refused", (await call("start_dev_server", { id: "my", command: "mvn", args: ["exec:java"], cwd: "mvn-ok" })).isError === true);
    },
  },
  gradle: {
    tool: ["gradle", "-v"],
    async run() {
      const port = await freePort();
      write(ws, "gr-ok/settings.gradle", "rootProject.name = 'gr-ok'\n");
      write(ws, "gr-ok/build.gradle", "plugins { id 'application' }\nrepositories { mavenCentral() }\napplication { mainClass = 'App' }\n");
      write(ws, "gr-ok/src/main/java/App.java", `import com.sun.net.httpserver.HttpServer;\nimport java.net.InetSocketAddress;\npublic class App {\n  public static void main(String[] a) throws Exception {\n    HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", ${port}), 0);\n    s.createContext("/", x -> { byte[] b = "gradle-ok".getBytes(); x.sendResponseHeaders(200, b.length); x.getResponseBody().write(b); x.close(); });\n    s.start();\n  }\n}\n`);
      const r = await startUntilReady("gr", "gradle", ["run", "--console=plain"], "gr-ok", port);
      check(`gradle: gradle run -> Ready (${r.calls} call(s))`, r.ready, r.text);
      check("gradle: really serving", /gradle-ok/.test(await fetchText(port, "gradle-ok")));
      await call("stop_dev_server", { id: "gr" });
      check("gradle: -I init.gradle is refused", (await call("start_dev_server", { id: "gx", command: "gradle", args: ["run", "-I", "init.gradle"], cwd: "gr-ok" })).isError === true);
      check("gradle: tasks other than the dev loop are refused", (await call("start_dev_server", { id: "gy", command: "gradle", args: ["build"], cwd: "gr-ok" })).isError === true);
    },
  },
  elixir: {
    tool: ["mix", "--version"],
    async run() {
      const port = await freePort();
      write(ws, "ex-ok/mix.exs", "defmodule Srv.MixProject do\n  use Mix.Project\n  def project, do: [app: :srv, version: \"0.1.0\", elixir: \"~> 1.14\"]\n  def application, do: [extra_applications: [:logger], mod: {Srv.App, []}]\nend\n");
      write(ws, "ex-ok/lib/srv.ex", `defmodule Srv.App do
  use Application
  def start(_type, _args) do
    {:ok, l} = :gen_tcp.listen(${port}, [:binary, active: false, reuseaddr: true, ip: {127, 0, 0, 1}])
    {:ok, spawn_link(fn -> loop(l) end)}
  end
  defp loop(l) do
    {:ok, s} = :gen_tcp.accept(l)
    :gen_tcp.recv(s, 0)
    :gen_tcp.send(s, "HTTP/1.1 200 OK\\r\\nContent-Length: 9\\r\\nConnection: close\\r\\n\\r\\nelixir-ok")
    :gen_tcp.close(s)
    loop(l)
  end
end
`);
      const r = await startUntilReady("ex", "mix", ["run", "--no-halt"], "ex-ok", port);
      check(`elixir: mix run --no-halt -> Ready (${r.calls} call(s))`, r.ready, r.text);
      check("elixir: really serving", /elixir-ok/.test(await fetchText(port, "elixir-ok")));
      await call("stop_dev_server", { id: "ex" });
      check("elixir: mix run -e is refused", (await call("start_dev_server", { id: "ey", command: "mix", args: ["run", "-e", "IO.puts(1)"], cwd: "ex-ok" })).isError === true);
      check("elixir: mix deps.get is refused", (await call("start_dev_server", { id: "ez", command: "mix", args: ["deps.get"], cwd: "ex-ok" })).isError === true);
    },
  },
  trunk: {
    tool: ["trunk", "--version"],
    async run() {
      const port = await freePort();
      write(ws, "tr-ok/Cargo.toml", '[package]\nname = "tr-ok"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nwasm-bindgen = "0.2"\n');
      write(ws, "tr-ok/src/main.rs", "fn main() {}\n");
      write(ws, "tr-ok/index.html", '<!DOCTYPE html><html><head><meta charset="utf-8"><link data-trunk rel="rust" data-wasm-opt="0" /></head><body>trunk-ok</body></html>\n');
      const det = textOf(await call("detect_project", { path: "tr-ok" }));
      check("trunk: detect_project suggests `trunk serve` for a wasm crate with index.html", /command="trunk" args=\["serve"\]|Rust/.test(det), det);
      const r = await startUntilReady("tr", "trunk", ["serve", "--port", String(port), "--address", "127.0.0.1", "--no-autoreload"], "tr-ok", port, 10);
      check(`trunk: trunk serve -> Ready (${r.calls} call(s))`, r.ready, r.text);
      const page = await fetchText(port, "trunk-ok");
      const logs = textOf(await call("get_dev_server_logs", { id: "tr", limit: 60 }));
      check("trunk: really serving the page", /trunk-ok/.test(page), `served:
${page.slice(0, 600)}
--- trunk logs:
${logs.slice(-2500)}`);
      await call("stop_dev_server", { id: "tr" });
      check("trunk: trunk build is refused", (await call("start_dev_server", { id: "tx", command: "trunk", args: ["build"], cwd: "tr-ok" })).isError === true);
    },
  },
};

for (const name of wanted) {
  const stack = STACKS[name];
  if (!stack) { check(`unknown stack "${name}"`, false); continue; }
  if (!has(...stack.tool)) {
    if (required.has(name)) { ok = false; console.log(`FAIL  ${name} is required (AGENT_EYE_REQUIRE_TOOLCHAINS) but ${stack.tool[0]} is not installed`); }
    else console.log(`SKIP  ${name}: ${stack.tool[0]} not installed`);
    continue;
  }
  console.log(`--- ${name}`);
  try {
    await stack.run();
  } catch (err) {
    check(`${name}: no exception`, false, String(err?.stack ?? err));
  }
}

await c.close();
console.log(ok ? "\nALL PASSED" : "\nFAILURES");
process.exit(ok ? 0 : 1);
