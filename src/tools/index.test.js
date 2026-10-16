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

test("getToolDefinitions: build exposes all base tools", () => {
  const defs = tools.getToolDefinitions("build");
  expect(defs.map((d) => d.name).sort()).toEqual(["ask", "bash", "browser", "edit", "glob", "grep", "lsp", "mcp", "read", "sandbox", "task", "tasks", "todoread", "todowrite", "webfetch", "websearch", "write"]);
  for (const d of defs) {
    expect(d.description).toBeTruthy();
    expect(d.input_schema).toBeTruthy();
    expect(Array.isArray(d.input_schema.required)).toBe(true);
  }
});

test("getToolDefinitions: plan exposes read-only tools + task, chat none", () => {
  const plan = tools.getToolDefinitions("plan");
  expect(plan.map((d) => d.name).sort()).toEqual(["glob", "grep", "read", "task", "todoread", "todowrite", "webfetch", "websearch"]);
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
test("sandbox tool: opt-in only — helpful error when never set up (no auto-routing)", async () => {
  // Fresh config: sandbox not enabled. The tool must NOT fall back to the
  // host shell or docker; it explains how to set up. Bash is unaffected.
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cfg-"));
  process.env.LOOM_CONFIG_DIR = cfgDir;
  process.env.LOOM_SANDBOX = "0"; // hard kill-switch also honored
  try {
    const res = await tools.executeTool("sandbox", { command: "echo hi" });
    expect(res.error).toContain("/sandbox");
    // Host bash keeps working regardless of the sandbox state.
    const bash = await tools.executeTool("bash", { command: "echo host-still-works" });
    expect(String(bash.result)).toContain("host-still-works");
    // bash sandbox:true must take the docker exec path — an unset sandbox
    // yields the setup error, never a silent host execution of the command.
    const marker = path.join(cfgDir, "must-not-exist.txt");
    const routed = await tools.executeTool("bash", { command: `echo leak > "${marker}"`, sandbox: true });
    expect(routed.error).toContain("/sandbox");
    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    delete process.env.LOOM_SANDBOX;
    delete process.env.LOOM_CONFIG_DIR;
    try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}
  }
});

test("bash tool schema advertises the sandbox routing param", () => {
  const defs = tools.getToolDefinitions("build");
  const bash = defs.find((d) => d.name === "bash");
  expect(bash.input_schema.properties.sandbox).toBeTruthy();
  const sb = defs.find((d) => d.name === "sandbox");
  expect(sb.description).toContain("docker exec");
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

test("task: rejects unknown agents and primary agents", async () => {
  const bad = await tools.executeTool("task", { prompt: "do it", agent: "nope-not-an-agent" });
  expect(bad.error).toContain("Unknown agent");
  const primary = await tools.executeTool("task", { prompt: "do it", agent: "build" });
  expect(primary.error).toContain("primary agent");
  const empty = await tools.executeTool("task", { prompt: "   " });
  expect(empty.error).toContain("non-empty prompt");
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

// ─── v1.5.0 harness-parity additions ───

test("truncateToolText: small text passes through, huge text is head+tail capped", () => {
  const small = "hello";
  expect(tools.truncateToolText(small)).toBe(small);
  const big = "A".repeat(60000) + "MIDDLE-MARKER" + "B".repeat(60000);
  const out = tools.truncateToolText(big);
  expect(out.length).toBeLessThan(big.length);
  expect(out.length).toBeLessThanOrEqual(100 * 1000 + 200);
  expect(out).toContain("A".repeat(100)); // head survives
  expect(out).toContain("B".repeat(100)); // tail survives
  expect(out).toContain("truncated");
});

test("executeTool: result strings above the cap are truncated at the boundary", async () => {
  // grep over a generated file yields a long string result — easiest way to
  // exercise the executeTool-level cap without a 100k bash run.
  const lines = [];
  for (let i = 0; i < 12000; i++) lines.push("hit-" + i + " alpha");
  tmpFile("big.txt", lines.join("\n"));
  const res = await tools.executeTool("grep", { pattern: "alpha", path: tmpDir, include: "big.txt" });
  expect(String(res.result).length).toBeLessThanOrEqual(100 * 1000 + 200);
  expect(String(res.result)).toContain("truncated");
});

test("edit: edits array applies sequentially; entries require unique matches", async () => {
  const p = tmpFile("multi.txt", "one two three");
  const r = await tools.executeTool("edit", {
    filePath: p,
    edits: [
      { oldString: "one", newString: "1" },
      { oldString: "two", newString: "2" },
    ],
  });
  expect(r.result).toContain("replaced 1 occurrence");
  expect(r.result).toContain("replaced 1 occurrence");
  expect(fs.readFileSync(p, "utf8")).toBe("1 2 three");
  // Sequential: the second edit sees the first edit's output.
  const p2 = tmpFile("seq.txt", "aaa");
  await tools.executeTool("edit", { filePath: p2, edits: [
    { oldString: "aaa", newString: "bbb" },
    { oldString: "bbb", newString: "ccc" },
  ] });
  expect(fs.readFileSync(p2, "utf8")).toBe("ccc");
  // Ambiguous entry fails and writes nothing.
  const p3 = tmpFile("ambig.txt", "dup dup");
  const amb = await tools.executeTool("edit", { filePath: p3, edits: [{ oldString: "dup", newString: "x" }] });
  expect(amb.error).toContain("2 matches");
  expect(fs.readFileSync(p3, "utf8")).toBe("dup dup");
});

test("read: binary files are detected and skipped", async () => {
  const p = path.join(tmpDir, "bin.dat");
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00, 0x03]));
  const res = await tools.executeTool("read", { filePath: p });
  expect(String(res.result)).toContain("binary file");
});

test("bash: timeoutMs kills a hung command and reports the timeout", async () => {
  const res = await tools.executeTool("bash", {
    command: process.platform === "win32" ? "powershell -NoProfile -Command Start-Sleep -Seconds 30" : "sleep 30",
    timeoutMs: 800,
  });
  expect(String(res.result)).toContain("timed out");
}, 15000);

test("bash: ctx.signal abort kills the running command", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 400);
  const res = await tools.executeTool("bash", {
    command: process.platform === "win32" ? "powershell -NoProfile -Command Start-Sleep -Seconds 30" : "sleep 30",
    timeoutMs: 60000,
  }, "build", { signal: ac.signal });
  expect(String(res.result)).toContain("aborted by user");
}, 15000);

test("tasks: list/output/kill round-trip a background task", async () => {
  const bt = require("../core/background-tasks.js");
  const start = bt.startBackgroundTask("echo tasks-tool-ok");
  expect(start.id).toBeTruthy();
  // Wait for the echo to finish.
  for (let i = 0; i < 50; i++) {
    const t = bt.getBackgroundTask(start.id);
    if (t && t.status !== "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const list = await tools.executeTool("tasks", { action: "list" });
  expect(String(list.result)).toContain(start.id);
  const out = await tools.executeTool("tasks", { action: "output", id: start.id, tailLines: 10 });
  expect(String(out.result)).toContain("tasks-tool-ok");
  const missing = await tools.executeTool("tasks", { action: "output", id: "bt-nope" });
  expect(missing.error).toContain("Unknown task id");
});

test("todoread: returns the parent session todo list", async () => {
  const parent = { todos: [{ content: "alpha", status: "in_progress", priority: "high" }, { content: "beta", status: "pending" }] };
  const res = await tools.executeTool("todoread", {}, "build", { parentSession: parent });
  expect(String(res.result)).toContain("alpha");
  expect(String(res.result)).toContain("[>] [high] alpha");
  expect(String(res.result)).toContain("1 in-progress, 1 pending");
  const empty = await tools.executeTool("todoread", {}, "build", { parentSession: { todos: [] } });
  expect(String(empty.result)).toContain("no todos");
});
