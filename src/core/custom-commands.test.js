// Unit tests for custom slash commands (src/core/custom-commands.js).
process.env.LOOM_MCP_NO_WARM = "1";
process.env.LOOM_MEM_AUTO = "0";
import { test, expect, beforeAll, afterAll } from "bun:test";
import os from "os";
import fs from "fs";
import path from "path";

const CMDS_TMP = path.join(os.tmpdir(), "loom-cmds-" + process.pid + "-" + Date.now());
const PREV = process.env.LOOM_COMMANDS_DIR;
process.env.LOOM_COMMANDS_DIR = path.join(CMDS_TMP, "commands");

import * as cc from "./custom-commands.js";

beforeAll(() => {
  fs.mkdirSync(process.env.LOOM_COMMANDS_DIR, { recursive: true });
  fs.writeFileSync(path.join(CMDS_TMP, "commands", "deploy.md"), "Ship $ARGUMENTS to prod.\nCheck tests first.");
  fs.writeFileSync(path.join(CMDS_TMP, "commands", "review.md"), "Review the diff. No args needed.");
  cc.invalidateCommandCache();
});

afterAll(() => {
  try { fs.rmSync(CMDS_TMP, { recursive: true, force: true }); } catch {}
  if (PREV === undefined) delete process.env.LOOM_COMMANDS_DIR;
  else process.env.LOOM_COMMANDS_DIR = PREV;
});

test("listCustomCommands discovers .md files by name", () => {
  const names = cc.listCustomCommands().map(c => c.name);
  expect(names).toContain("deploy");
  expect(names).toContain("review");
});

test("expandCustomCommand substitutes $ARGUMENTS", () => {
  const out = cc.expandCustomCommand("deploy", "the api service");
  expect(out).toBe("Ship the api service to prod.\nCheck tests first.");
});

test("expandCustomCommand with no args empties $ARGUMENTS", () => {
  const out = cc.expandCustomCommand("review", "");
  expect(out).toBe("Review the diff. No args needed.");
});

test("unknown command returns null (built-in slash handling proceeds)", () => {
  expect(cc.expandCustomCommand("nope", "")).toBe(null);
});
