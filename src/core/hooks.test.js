// Unit tests for lifecycle hooks (src/core/hooks.js).
process.env.LOOM_MCP_NO_WARM = "1";
process.env.LOOM_MEM_AUTO = "0";
import { test, expect, beforeAll, afterAll } from "bun:test";
import os from "os";
import fs from "fs";
import path from "path";

const CFG_TMP = path.join(os.tmpdir(), "loom-hooks-" + process.pid + "-" + Date.now());
const PREV_CFG_DIR = process.env.LOOM_CONFIG_DIR;
process.env.LOOM_CONFIG_DIR = CFG_TMP;

import * as hooks from "./hooks.js";

function writeConfig(hooksCfg) {
  fs.mkdirSync(CFG_TMP, { recursive: true });
  fs.writeFileSync(path.join(CFG_TMP, "config.json"), JSON.stringify({ provider: "anthropic", model: {}, apiKeys: {}, hooks: hooksCfg }));
}

beforeAll(() => {
  fs.mkdirSync(CFG_TMP, { recursive: true });
});

afterAll(() => {
  try { fs.rmSync(CFG_TMP, { recursive: true, force: true }); } catch {}
  if (PREV_CFG_DIR === undefined) delete process.env.LOOM_CONFIG_DIR;
  else process.env.LOOM_CONFIG_DIR = PREV_CFG_DIR;
});

test("no hook configured → allowed, not ran", async () => {
  writeConfig({});
  const r = await hooks.runHook("preToolUse", { tool: "bash", input: {} });
  expect(r.blocked).toBe(false);
  expect(r.ran).toBe(false);
});

test("preToolUse deny via structured JSON on stdout blocks", async () => {
  // node -e writes the deny JSON; cross-platform via bun.
  writeConfig({ preToolUse: 'bun -e "console.log(JSON.stringify({decision:\'deny\',reason:\'no rm\'}))"' });
  const r = await hooks.runHook("preToolUse", { tool: "bash", input: { command: "rm -rf /" } });
  expect(r.blocked).toBe(true);
  expect(r.reason).toBe("no rm");
});

test("preToolUse non-zero exit blocks with the exit code as reason", async () => {
  writeConfig({ preToolUse: process.platform === "win32" ? "cmd /c exit 2" : "exit 2" });
  const r = await hooks.runHook("preToolUse", { tool: "bash", input: {} });
  expect(r.blocked).toBe(true);
  expect(r.reason).toContain("2");
});

test("preToolUse zero-exit hook allows the call", async () => {
  writeConfig({ preToolUse: process.platform === "win32" ? "cmd /c exit 0" : "true" });
  const r = await hooks.runHook("preToolUse", { tool: "bash", input: {} });
  expect(r.blocked).toBe(false);
  expect(r.ran).toBe(true);
});

test("hook receives payload on stdin and via env vars", async () => {
  let seen = "";
  const origWrite = process.stdout.write;
  writeConfig({
    postToolUse: process.platform === "win32"
      ? 'bun -e "let d=\\"\\";process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{const j=JSON.parse(d);if(j.tool===\'grep\'&&j.hook===\'postToolUse\')process.exit(0);process.exit(1)})"'
      : 'bun -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{const j=JSON.parse(d);if(j.tool===\'grep\'&&j.hook===\'postToolUse\')process.exit(0);process.exit(1)})"',
  });
  const r = await hooks.runHook("postToolUse", { tool: "grep", input: { pattern: "x" } });
  expect(r.blocked).toBe(false);
  expect(seen).toBe("");
});

test("stop hook fires without blocking semantics", async () => {
  writeConfig({ stop: process.platform === "win32" ? "cmd /c exit 1" : "exit 1" });
  const r = await hooks.runHook("stop", { reason: "done" });
  // Non-informational failure must NOT block anything on stop.
  expect(r.blocked).toBe(false);
  expect(r.ran).toBe(true);
});
