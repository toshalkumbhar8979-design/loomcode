// Unit tests for the formatter layer (src/core/format.js).
// Runs with:  bun test src/core/format.test.js
process.env.LOOM_MEM_AUTO = "0";
import { test, expect, beforeEach, afterAll } from "bun:test";
import os from "os";
import fs from "fs";
import path from "path";

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-fmt-cfg-"));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-fmt-"));
beforeEach(() => {
  try { fs.rmSync(path.join(cfgDir, "config.json"), { force: true }); } catch {}
  process.env.LOOM_CONFIG_DIR = cfgDir;
});
afterAll(() => {
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env.LOOM_CONFIG_DIR;
});

function setConfig(obj) {
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify(obj), "utf8");
}

function tmpFile(name, content) {
  const p = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

test("formatters default to disabled", () => {
  const fmt = require("./format.js");
  const { enabled, formatters } = fmt.enabledFormatters();
  expect(enabled).toBe(false);
  expect(Object.keys(formatters)).toHaveLength(0);
});

test("formatter:true enables all built-ins", () => {
  setConfig({ formatter: true });
  const fmt = require("./format.js");
  const { enabled, formatters } = fmt.enabledFormatters();
  expect(enabled).toBe(true);
  expect(Object.keys(formatters).length).toBeGreaterThan(10);
  expect(formatters.prettier.extensions).toContain(".ts");
  expect(formatters.gofmt.extensions).toContain(".go");
});

test("a disabled built-in can be turned off via object form", () => {
  setConfig({ formatter: { prettier: { disabled: true } } });
  const fmt = require("./format.js");
  const { enabled, formatters } = fmt.enabledFormatters();
  expect(enabled).toBe(true);
  expect(formatters.prettier).toBeUndefined();
  expect(formatters.gofmt).toBeTruthy();
});

test("custom formatter is added from config", () => {
  setConfig({ formatter: { shout: { command: ["node", "-e", "console.log(process.argv)", "$FILE"], extensions: [".zzz"] } } });
  const fmt = require("./format.js");
  const resolved = fmt.resolveFormatter(".zzz");
  expect(resolved.found).toBe(true);
  expect(resolved.id).toBe("shout");
});

test("$FILE placeholder is substituted and path appended when absent", () => {
  const fmt = require("./format.js");
  expect(fmt.buildCommand(["gofmt", "-w", "$FILE"], "/tmp/x.go")).toEqual(["gofmt", "-w", "/tmp/x.go"]);
  expect(fmt.buildCommand(["echo", "$FILE"], "/a/b.txt")).toEqual(["echo", "/a/b.txt"]);
  expect(fmt.buildCommand(["formatter"], "/a/b.txt")).toEqual(["formatter", "/a/b.txt"]);
});

test("formatFile: custom node formatter transforms the file", async () => {
  const script = "const fs=require('fs');const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').toUpperCase())";
  setConfig({ formatter: { shout: { command: ["node", "-e", script, "$FILE"], extensions: [".wrd"] } } });
  const p = tmpFile("hello.wrd", "hello world");
  const fmt = require("./format.js");
  const res = await fmt.formatFile(p);
  expect(res.formatted).toBe(true);
  expect(res.id).toBe("shout");
  expect(fs.readFileSync(p, "utf8")).toBe("HELLO WORLD");
});

test("formatFile: no formatter for an unhandled extension", async () => {
  setConfig({ formatter: true });
  const fmt = require("./format.js");
  const p = tmpFile("x.binary-ish", "abc");
  const res = await fmt.formatFile(p);
  expect(res.formatted).toBe(false);
  expect(res.reason).toMatch(/no enabled formatter/);
});

test("formatFile: missing formatter binary reports a clean reason", async () => {
  setConfig({ formatter: { neverexists: { command: ["definitely-not-a-real-loomin-bin", "$FILE"], extensions: [".nx"] } } });
  const fmt = require("./format.js");
  const p = tmpFile("y.nx", "z");
  const res = await fmt.formatFile(p);
  expect(res.formatted).toBe(false);
  expect(res.reason).toMatch(/command not found/);
});

test("formatAfterWrite: returns '' when disabled, a note when enabled", async () => {
  const script = "const fs=require('fs');const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8').toUpperCase())";
  const fmt = require("./format.js");
  const p = tmpFile("note.wrd", "abc");
  expect(await fmt.formatAfterWrite(p)).toBe(""); // disabled by default
  setConfig({ formatter: { shout: { command: ["node", "-e", script, "$FILE"], extensions: [".wrd"] } } });
  expect(await fmt.formatAfterWrite(p)).toBe("\n[formatted by shout]");
});
