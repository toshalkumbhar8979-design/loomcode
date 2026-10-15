// Unit tests for the Docker sandbox (src/core/sandbox.js).
// Runs with:  bun test src/core/sandbox.test.js
// Docker itself is never invoked — detectDocker takes an injectable runner,
// and the pure helpers (guide, paths, ready-signal) need no daemon.
import { test, expect, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let sandbox;
let cfgDir;

beforeEach(() => {
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-sandbox-"));
  process.env.LOOM_CONFIG_DIR = cfgDir;
  sandbox = require("./sandbox");
});

afterAll(() => {
  delete process.env.LOOM_CONFIG_DIR;
});

test("detectDocker: not_installed when even `docker --version` fails", () => {
  const res = sandbox.detectDocker(() => { throw new Error("ENOENT"); });
  expect(res.state).toBe("not_installed");
});

test("detectDocker: no_daemon when CLI exists but server version fails", () => {
  const res = sandbox.detectDocker((cmd, args) => {
    if (args.includes("--version")) return "Docker version 27.0.1";
    throw new Error("Cannot connect to the Docker daemon");
  });
  expect(res.state).toBe("no_daemon");
});

test("detectDocker: ready when server version returns", () => {
  const res = sandbox.detectDocker(() => "27.0.1");
  expect(res.state).toBe("ready");
  expect(res.version).toBe("27.0.1");
});

test("detectDockerAsync: spawn-based, same states, never blocks", async () => {
  const ok = await sandbox.detectDockerAsync(async () => ({ code: 0, out: "27.0.1\n" }));
  expect(ok.state).toBe("ready");
  expect(ok.version).toBe("27.0.1");
  const noDaemon = await sandbox.detectDockerAsync(async (cmd, args) =>
    args[0] === "--version" // CLI probe succeeds, daemon probe fails
      ? { code: 0, out: "Docker version 27.0.1\n" }
      : { code: 1, out: "Cannot connect to the Docker daemon" });
  expect(noDaemon.state).toBe("no_daemon");
  const missing = await sandbox.detectDockerAsync(async () => ({ code: -1, out: "spawn docker ENOENT" }));
  expect(missing.state).toBe("not_installed");
});

test("sandboxPending: config-only check needs no docker", () => {
  expect(sandbox.sandboxPending()).toBe(false);
  sandbox.markInstallPending();
  expect(sandbox.sandboxPending()).toBe(true);
});

test("installGuide: platform steps + the resume phrase", () => {
  const guide = sandbox.installGuide();
  expect(guide).toContain("docker.com");
  expect(guide).toContain("docker is ready");
  expect(guide).toContain("/sandbox setup");
});

test("toSandboxPath: project root maps to /workspace, subdirs underneath", () => {
  const root = path.join(cfgDir, "proj");
  expect(sandbox.toSandboxPath(root, root)).toBe("/workspace");
  expect(sandbox.toSandboxPath(path.join(root, "src", "core"), root)).toBe("/workspace/src/core");
});

test("toSandboxPath: paths outside the project fall back to /workspace", () => {
  const root = path.join(cfgDir, "proj");
  const outside = path.join(cfgDir, "elsewhere");
  expect(sandbox.toSandboxPath(outside, root)).toBe("/workspace");
});

test("isReadySignal: matches announce phrases, ignores long/irrelevant text", () => {
  expect(sandbox.isReadySignal("docker is ready")).toBe(true);
  expect(sandbox.isReadySignal("Docker installed!")).toBe(true);
  expect(sandbox.isReadySignal("docker is done")).toBe(true);
  expect(sandbox.isReadySignal("ok docker running now")).toBe(true);
  expect(sandbox.isReadySignal("is docker ready yet?")).toBe(false); // question, not announce
  expect(sandbox.isReadySignal("docker is a container platform we might use")).toBe(false);
  expect(sandbox.isReadySignal("")).toBe(false);
  expect(sandbox.isReadySignal("x".repeat(200))).toBe(false);
});

test("markInstallPending + sandboxStatus: pending round-trips through config", () => {
  sandbox.markInstallPending();
  const st = sandbox.sandboxStatus();
  expect(st.pending).toBe(true);
});

test("setSandboxEnabled: persists the routing flag", () => {
  sandbox.setSandboxEnabled(true);
  expect(sandbox.shouldUseSandbox()).toBe(true);
  sandbox.setSandboxEnabled(false);
  expect(sandbox.shouldUseSandbox()).toBe(false);
});

test("shouldUseSandbox: LOOM_SANDBOX=0 is a hard kill-switch", () => {
  sandbox.setSandboxEnabled(true);
  process.env.LOOM_SANDBOX = "0";
  expect(sandbox.shouldUseSandbox()).toBe(false);
  delete process.env.LOOM_SANDBOX;
  expect(sandbox.shouldUseSandbox()).toBe(true);
  sandbox.setSandboxEnabled(false);
});

test("OS_CATALOG: lightweight defaults, browser flags, no heavy images", () => {
  const cat = sandbox.OS_CATALOG;
  expect(cat.length).toBeGreaterThanOrEqual(2);
  expect(cat[0].id).toBe("alpine");
  expect(cat[0].image).toBe("node:20-alpine");
  expect(cat[0].browser).toBe(true);
  const ids = cat.map((o) => o.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const o of cat) {
    expect(o.pkg === "apk" || o.pkg === "apt").toBe(true);
    expect(typeof o.label).toBe("string");
    expect(typeof o.sizeNote).toBe("string");
  }
});

test("installLink: platform URL + guide embeds it", () => {
  const link = sandbox.installLink();
  expect(link.startsWith("https://docs.docker.com/")).toBe(true);
  expect(sandbox.installGuide()).toContain(link);
});

test("trackPullLine: folds docker-pull layer lines into fractions + percent", () => {
  const layers = new Map();
  // Queued layer → 0%.
  sandbox.trackPullLine("9ad6246f5168: Waiting", layers);
  expect(layers.get("9ad6246f5168")).toBe(0);
  // Mid-download: 5MB of 10MB.
  sandbox.trackPullLine("9ad6246f5168: Downloading [==>         ] 5MB/10MB", layers);
  expect(layers.get("9ad6246f5168")).toBeCloseTo(0.5, 5);
  // A second, fully downloaded layer (IDs are hex).
  sandbox.trackPullLine("3c814d5612ab: Pull complete", layers);
  expect(layers.get("3c814d5612ab")).toBe(1);
  // Overall percent = average of per-layer fractions (2 layers: 0.5 + 1).
  expect(sandbox.pullPercent(layers)).toBe(75);
  // Unrelated lines are ignored; empty maps report null (no bar yet).
  const empty = new Map();
  sandbox.trackPullLine("Status: Downloaded newer image", empty);
  expect(empty.size).toBe(0);
  expect(sandbox.pullPercent(empty)).toBeNull();
});

test("ensureContainerAlive: friendly error when sandbox was never set up", async () => {
  // Not enabled in a fresh config dir → no docker invocation at all.
  const res = await sandbox.ensureContainerAlive();
  expect(res.ok).toBe(false);
  expect(res.error).toContain("/sandbox");
});

test("runInSandbox: refuses before setup (no forced routing)", async () => {
  const res = await sandbox.runInSandbox("echo hi");
  expect("error" in res).toBe(true);
});
