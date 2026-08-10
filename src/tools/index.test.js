// Unit tests for the tool layer (src/tools/index.js).
// Runs with:  bun test src/tools/index.test.js
process.env.LOOM_MCP_NO_WARM = "1";
process.env.LOOM_MEM_AUTO = "0";
import { test, expect, beforeAll, afterAll } from "bun:test";
import os from "os";
import fs from "fs";
import path from "path";

let tools;

beforeAll(async () => {
  tools = require("./index.js");
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tools-"));
afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function tmpFile(name, content) {
  const p = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

test("getToolDefinitions: build exposes all 9 base tools", () => {
  const defs = tools.getToolDefinitions("build");
  expect(defs.map((d) => d.name).sort()).toEqual(["bash", "edit", "glob", "grep", "mcp", "read", "todowrite", "webfetch", "write"]);
  for (const d of defs) {
    expect(d.description).toBeTruthy();
    expect(d.input_schema).toBeTruthy();
    expect(Array.isArray(d.input_schema.required)).toBe(true);
  }
});

test("getToolDefinitions: plan exposes only read-only tools, chat none", () => {
  const plan = tools.getToolDefinitions("plan");
  expect(plan.map((d) => d.name).sort()).toEqual(["glob", "grep", "read", "todowrite", "webfetch"]);
  expect(tools.getToolDefinitions("chat")).toEqual([]);
});

test("getAllToolDefinitions: chat is empty, build list is cached", async () => {
  expect(await tools.getAllToolDefinitions("chat")).toEqual([]);
  const a = await tools.getAllToolDefinitions("build");
  const b = await tools.getAllToolDefinitions("build");
  expect(a.length).toBeGreaterThanOrEqual(8);
  expect(b).toBe(a); // cached reference
});

test("read: returns numbered lines, honors offset/limit", async () => {
  const p = tmpFile("readme.txt", "one\ntwo\nthree\nfour");
  const full = await tools.executeTool("read", { filePath: p });
  expect(full.result).toBe("1: one\n2: two\n3: three\n4: four");
  const win = await tools.executeTool("read", { filePath: p, offset: 2, limit: 2 });
  expect(win.result).toBe("2: two\n3: three");
  const missing = await tools.executeTool("read", { filePath: path.join(tmpDir, "nope.txt") });
  expect(missing.error).toContain("File not found");
});

test("write: creates parent dirs and writes content", async () => {
  const p = path.join(tmpDir, "deep", "nested", "out.txt");
  const res = await tools.executeTool("write", { filePath: p, content: "hello world" });
  expect(res.error).toBeUndefined();
  expect(fs.readFileSync(p, "utf8")).toBe("hello world");
});

test("edit: single replace, replaceAll, and error cases", async () => {
  const p = tmpFile("edit.txt", "aaa bbb aaa");
  const r1 = await tools.executeTool("edit", { filePath: p, oldString: "aaa", newString: "XXX" });
  expect(r1.result).toContain("replaced 1 occurrence");
  expect(fs.readFileSync(p, "utf8")).toBe("XXX bbb aaa");
  const r2 = await tools.executeTool("edit", { filePath: p, oldString: "XXX", newString: "YYY", replaceAll: true });
  expect(r2.result).toContain("replaced 1 occurrences");
  expect(fs.readFileSync(p, "utf8")).toBe("YYY bbb aaa");
  const notFound = await tools.executeTool("edit", { filePath: p, oldString: "zzz", newString: "q" });
  expect(notFound.error).toBe("oldString not found in content");
  const noFile = await tools.executeTool("edit", { filePath: path.join(tmpDir, "missing.txt"), oldString: "a", newString: "b" });
  expect(noFile.error).toContain("File not found");
});

test("bash: echo runs and returns stdout", async () => {
  const res = await tools.executeTool("bash", { command: "echo hello-bash" });
  expect(res.error).toBeUndefined();
  expect(String(res.result)).toContain("hello-bash");
});

test.skipIf(process.platform === "win32")("bash: non-zero exit is reported", async () => {
  const res = await tools.executeTool("bash", { command: "exit 3" });
  expect(String(res.result)).toContain("[exit code: 3]");
});

test("bash: empty command completes cleanly", async () => {
  const res = await tools.executeTool("bash", { command: "   " });
  expect(String(res.result)).toContain("empty");
});

test("bash: dangerous commands are blocked unless approved", async () => {
  const blocked = await tools.executeTool("bash", { command: "rm -rf /" });
  expect(blocked.error).toContain("Blocked by safety filter");
  expect(blocked.error).toContain("recursive force delete");
});

test.skipIf(process.platform === "win32")("bash: approved commands bypass the filter (POSIX)", async () => {
  const approved = await tools.executeTool("bash", { command: "chmod 755 " + tmpDir, _approved: true });
  expect(String(approved.result)).not.toContain("Blocked by safety filter");
});

test("mcp: add with a dangerous command is blocked without approval", async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mcp-cfg-"));
  process.env.LOOM_CONFIG_DIR = cfgDir;
  try {
    const blocked = await tools.executeTool("mcp", { action: "add", name: "x", command: "sudo npx -y server" });
    expect(blocked.error).toContain("Blocked by safety filter");
    expect(blocked.error).toContain("sudo");
    const approved = await tools.executeTool("mcp", { action: "add", name: "x", command: "echo hello", _approved: true });
    expect(approved.error).toBeUndefined();
    const listed = await tools.executeTool("mcp", { action: "list" });
    expect(String(listed.result)).toContain("x");
  } finally {
    delete process.env.LOOM_CONFIG_DIR;
    try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}
  }
});

test("edit: dry run previews without writing", async () => {
  const p = tmpFile("dry.txt", "aaa bbb aaa");
  const res = await tools.executeTool("edit", { filePath: p, oldString: "aaa", newString: "XXX", replaceAll: true, dryRun: true });
  expect(String(res.result)).toContain("Dry run");
  expect(String(res.result)).toContain("XXX bbb XXX");
  expect(fs.readFileSync(p, "utf8")).toBe("aaa bbb aaa");
});

test("sandbox: config sandbox.paths blocks outside, allows inside", async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cfg-"));
  process.env.LOOM_CONFIG_DIR = cfgDir;
  try {
    fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ sandbox: { paths: [tmpDir] } }), "utf8");
    const inside = path.join(tmpDir, "in.txt");
    const outside = path.join(cfgDir, "out.txt");
    const wOut = await tools.executeTool("write", { filePath: outside, content: "x" });
    expect(wOut.error).toContain("Blocked by sandbox");
    expect(fs.existsSync(outside)).toBe(false);
    const rIn = await tools.executeTool("write", { filePath: inside, content: "y" });
    expect(rIn.error).toBeUndefined();
    const r = await tools.executeTool("read", { filePath: inside });
    expect(r.result).toContain("y");
    const g = await tools.executeTool("glob", { pattern: "**/*", path: path.join(tmpDir, "..") });
    expect(g.error).toContain("Blocked by sandbox");
  } finally {
    delete process.env.LOOM_CONFIG_DIR;
    try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}
  }
});
test("glob: finds files, ignores node_modules", async () => {
  tmpFile("gdir/a.txt", "x");
  tmpFile("gdir/b.md", "y");
  tmpFile("gdir/node_modules/z.txt", "nope");
  const res = await tools.executeTool("glob", { pattern: "**/*", path: path.join(tmpDir, "gdir") });
  const lines = String(res.result).split("\n");
  expect(lines.some((l) => l.endsWith("a.txt"))).toBe(true);
  expect(lines.some((l) => l.includes("node_modules"))).toBe(false);
});

test("grep: matches with line numbers, reports none", async () => {
  tmpFile("grepme.txt", "alpha\nbeta alpha\ngamma\n");
  const hit = await tools.executeTool("grep", { pattern: "alpha", path: tmpDir, include: "grepme.txt" });
  expect(String(hit.result).includes("grepme.txt:1")).toBe(true);
  expect(String(hit.result).includes("grepme.txt:2")).toBe(true);
  const miss = await tools.executeTool("grep", { pattern: "zzz", path: tmpDir, include: "grepme.txt" });
  expect(String(miss.result)).toBe("No matches found");
});

test("todowrite: renders list with status summary", async () => {
  const res = await tools.executeTool("todowrite", {
    todos: [
      { content: "one", status: "completed" },
      { content: "two", status: "in_progress" },
      { content: "three" },
      { content: "four", status: "cancelled" },
    ],
  });
  expect(String(res.result)).toContain("1 done, 1 in-progress, 1 pending, 1 cancelled");
});

test("unknown tool returns an error", async () => {
  const res = await tools.executeTool("nonexistent", {});
  expect(res.error).toContain("Unknown tool");
});

test("mode gating: chat blocks everything, plan blocks writers and MCP", async () => {
  const p = tmpFile("gate.txt", "x");
  const chat = await tools.executeTool("read", { filePath: p }, "chat");
  expect(chat.error).toContain("Blocked in chat mode");
  const planWrite = await tools.executeTool("write", { filePath: path.join(tmpDir, "g.txt"), content: "x" }, "plan");
  expect(planWrite.error).toContain("not read-only");
  const planRead = await tools.executeTool("read", { filePath: p }, "plan");
  expect(planRead.result).toContain("1: x");
  const planMcp = await tools.executeTool("mcp__server__tool", {}, "plan");
  expect(planMcp.error).toContain("not available outside Build mode");
});
