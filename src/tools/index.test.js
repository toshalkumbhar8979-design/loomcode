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
  expect(defs.map((d) => d.name).sort()).toEqual(["ask", "bash", "browser", "edit", "glob", "grep", "lsp", "mcp", "read", "sandbox", "spawn_agents", "task", "tasks", "todoread", "todowrite", "webfetch", "websearch", "write"]);
  for (const d of defs) {
    expect(d.description).toBeTruthy();
    expect(d.input_schema).toBeTruthy();
    expect(Array.isArray(d.input_schema.required)).toBe(true);
  }
});

test("getToolDefinitions: plan exposes read-only tools + task, chat none", () => {
  const plan = tools.getToolDefinitions("plan");
  expect(plan.map((d) => d.name).sort()).toEqual(["glob", "grep", "read", "spawn_agents", "task", "todoread", "todowrite", "webfetch", "websearch"]);
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
  const p = tmpFile("edit.txt", "aaa bbb ccc");
  const r1 = await tools.executeTool("edit", { filePath: p, oldString: "aaa", newString: "XXX" });
  expect(r1.result).toContain("replaced 1 occurrence");
  expect(fs.readFileSync(p, "utf8")).toBe("XXX bbb ccc");
  const r2 = await tools.executeTool("edit", { filePath: p, oldString: "XXX", newString: "YYY", replaceAll: true });
  expect(r2.result).toContain("replaced 1 occurrences");
  expect(fs.readFileSync(p, "utf8")).toBe("YYY bbb ccc");
  const notFound = await tools.executeTool("edit", { filePath: p, oldString: "zzz", newString: "q" });
  expect(notFound.error).toBe("oldString not found in content");
  const noFile = await tools.executeTool("edit", { filePath: path.join(tmpDir, "missing.txt"), oldString: "a", newString: "b" });
  expect(noFile.error).toContain("File not found");
});

test("write/edit: append LSP diagnostics when enabled", async () => {
  const prev = process.env.LOOM_CONFIG_DIR;
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tools-lsp-cfg-"));
  const script = String.raw`
const fs = require('fs');
let buf = Buffer.alloc(0);
function send(obj) {
  const body = JSON.stringify(obj);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
}
function diagsFor(text) {
  return text.indexOf('BAD') >= 0
    ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, source: 'fake', message: 'bad token' }]
    : [];
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const idx = buf.indexOf('\r\n\r\n');
    if (idx < 0) break;
    const header = buf.slice(0, idx).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) { buf = buf.slice(idx + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < idx + 4 + len) break;
    const body = buf.slice(idx + 4, idx + 4 + len).toString('utf8');
    buf = buf.slice(idx + 4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
    } else if (msg.method === 'textDocument/didOpen') {
      const td = msg.params.textDocument;
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: td.uri, version: td.version, diagnostics: diagsFor(td.text) } });
    } else if (msg.method === 'textDocument/didChange') {
      const td = msg.params.textDocument;
      const text = msg.params.contentChanges && msg.params.contentChanges[0] ? msg.params.contentChanges[0].text : '';
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: td.uri, version: td.version, diagnostics: diagsFor(text) } });
    }
  }
});
`;
  const scriptPath = path.join(tmpDir, "fake-lsp-tools.js");
  fs.writeFileSync(scriptPath, script, "utf8");
  const lsp = require("../core/lsp.js");
  const cfg = {};
  for (const id of Object.keys(lsp.DEFAULT_LSP)) cfg[id] = { disabled: true };
  cfg.fake = { command: ["node", scriptPath], extensions: [".fake"] };
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ lsp: cfg }), "utf8");
  process.env.LOOM_CONFIG_DIR = cfgDir;
  try {
    const p = path.join(tmpDir, "lsp-write.fake");
    const w = await tools.executeTool("write", { filePath: p, content: "BAD" });
    expect(String(w.result)).toContain("[lsp fake: 1 error(s), 0 warning(s)]");
    expect(String(w.result)).toContain("E 1:1 [fake] bad token");
    const e = await tools.executeTool("edit", { filePath: p, oldString: "BAD", newString: "ok" });
    expect(String(e.result)).toContain("[lsp fake: clean]");
  } finally {
    lsp.shutdownAll();
    if (prev === undefined) delete process.env.LOOM_CONFIG_DIR;
    else process.env.LOOM_CONFIG_DIR = prev;
    try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}
  }
});

test("edit: ambiguous and no-op replacements are rejected", async () => {
  const p = tmpFile("ambiguous.txt", "aaa bbb aaa");
  const amb = await tools.executeTool("edit", { filePath: p, oldString: "aaa", newString: "XXX" });
  expect(amb.error).toContain("2 matches");
  expect(amb.error).toContain("replaceAll");
  expect(fs.readFileSync(p, "utf8")).toBe("aaa bbb aaa");
  const same = await tools.executeTool("edit", { filePath: p, oldString: "aaa", newString: "aaa" });
  expect(same.error).toContain("identical");
  const empty = await tools.executeTool("edit", { filePath: p, oldString: "", newString: "x" });
  expect(empty.error).toContain("cannot be empty");
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

test("windowsShellCommand: translates Unix idioms and shell operators", () => {
  expect(tools.windowsShellCommand("ls -la")).toBe("Get-ChildItem -Force");
  expect(tools.windowsShellCommand("cat README.md")).toBe("Get-Content README.md");
  expect(tools.windowsShellCommand("mkdir -p a/b")).toBe("New-Item -ItemType Directory -Force -Path a/b");
  expect(tools.windowsShellCommand("mkdir -p a b")).toBe("New-Item -ItemType Directory -Force -Path @(a,b)");
  expect(tools.windowsShellCommand("rm -rf tmp")).toBe("Remove-Item -Recurse -Force -LiteralPath tmp");
  expect(tools.windowsShellCommand("find . -name \"*.js\"")).toBe("Get-ChildItem -Path . -Recurse -Filter \"*.js\"");
  expect(tools.windowsShellCommand("find src -type f -name \"*.js\"")).toBe("Get-ChildItem -Path src -Recurse -File -Filter \"*.js\"");
  expect(tools.windowsShellCommand("grep -rn \"foo bar\" src")).toBe("Get-ChildItem -Path src -Recurse -File | Select-String -Pattern \"foo bar\" -CaseSensitive");
  expect(tools.windowsShellCommand("ls -la | head -n 5")).toBe("Get-ChildItem -Force | Select-Object -First 5");
  expect(tools.windowsShellCommand("echo a; ls -la")).toBe("echo a; Get-ChildItem -Force");
  expect(tools.windowsShellCommand("cd C:\\foo; ls -la")).toBe("Set-Location -LiteralPath C:\\foo; Get-ChildItem -Force");
  expect(tools.windowsShellCommand("ls -la 2>/dev/null")).toBe("Get-ChildItem -Force 2> $null");
  expect(tools.windowsShellCommand("npm run build 2>/dev/null")).toBe("npm run build 2> $null");
  expect(tools.windowsShellCommand("export FOO=bar")).toBe("$env:FOO = \"bar\"");
  expect(tools.windowsShellCommand("echo a && echo b")).toBe("echo a; if ($?) { echo b }");
  expect(tools.windowsShellCommand("ls -la && cat foo")).toBe("Get-ChildItem -Force; if ($?) { Get-Content foo }");
  expect(tools.windowsShellCommand("a || b")).toBe("a; if (-not $?) { b }");
});

test.skipIf(process.platform !== "win32")("bash: ls -la runs on Windows", async () => {
  const res = await tools.executeTool("bash", { command: "ls -la " + tmpDir });
  expect(res.error).toBeUndefined();
  expect(String(res.result)).toContain("readme.txt");
});

test.skipIf(process.platform !== "win32")("bash: mkdir -p handles multiple Windows paths", async () => {
  const a = path.join(tmpDir, "multi a");
  const b = path.join(tmpDir, "multi b");
  const res = await tools.executeTool("bash", { command: `mkdir -p "${a}" "${b}"` });
  expect(res.error).toBeUndefined();
  expect(fs.existsSync(a)).toBe(true);
  expect(fs.existsSync(b)).toBe(true);
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

test("grep: searches nested includes and ignores node_modules", async () => {
  tmpFile("grep-nested/keep.txt", "needle\n");
  tmpFile("grep-nested/sub/deep.txt", "needle\n");
  tmpFile("grep-nested/node_modules/skip.txt", "needle\n");
  const res = await tools.executeTool("grep", {
    pattern: "needle",
    path: path.join(tmpDir, "grep-nested"),
    include: "**/*.txt",
  });
  const out = String(res.result);
  expect(out).toContain("keep.txt:1");
  expect(out).toContain("deep.txt:1");
  expect(out).not.toContain("node_modules");
});

test("grep: falls back to JS regex for lookbehind patterns", async () => {
  tmpFile("grep-look.txt", "alpha\nbeta\n");
  const res = await tools.executeTool("grep", {
    pattern: "(?<=a)lpha",
    path: tmpDir,
    include: "grep-look.txt",
  });
  expect(String(res.result)).toContain("grep-look.txt:1: alpha");
});

test("glob: absolute patterns resolve their own search root", async () => {
  tmpFile("glob-abs/a.txt", "x");
  tmpFile("glob-abs/sub/b.txt", "y");
  const pattern = path.join(tmpDir, "glob-abs", "**/*.txt").replace(/\\/g, "/");
  const res = await tools.executeTool("glob", { pattern });
  const out = String(res.result);
  expect(out).toContain("a.txt");
  expect(out).toContain("b.txt");
});

test("read: cache reflects file changes", async () => {
  const p = tmpFile("cache-read.txt", "one");
  const first = await tools.executeTool("read", { filePath: p });
  expect(String(first.result)).toBe("1: one");
  await tools.executeTool("write", { filePath: p, content: "two-longer" });
  const second = await tools.executeTool("read", { filePath: p });
  expect(String(second.result)).toBe("1: two-longer");
});

test("grep: cache is invalidated by writes", async () => {
  const p = tmpFile("cache-grep.txt", "alpha\n");
  const hit = await tools.executeTool("grep", { pattern: "alpha", path: tmpDir, include: "cache-grep.txt" });
  expect(String(hit.result)).toContain("alpha");
  await tools.executeTool("write", { filePath: p, content: "beta\n" });
  const miss = await tools.executeTool("grep", { pattern: "alpha", path: tmpDir, include: "cache-grep.txt" });
  expect(String(miss.result)).toBe("No matches found");
});

test("glob: cache is invalidated by writes", async () => {
  const dir = path.join(tmpDir, "cache-glob");
  fs.mkdirSync(dir, { recursive: true });
  const before = await tools.executeTool("glob", { pattern: "*.txt", path: dir });
  expect(String(before.result)).toBe("No files found");
  await tools.executeTool("write", { filePath: path.join(dir, "new.txt"), content: "x" });
  const after = await tools.executeTool("glob", { pattern: "*.txt", path: dir });
  expect(String(after.result)).toContain("new.txt");
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

test("executeTool: a deadline returns promptly even when a tool ignores abort", async () => {
  // This is the important production property: an uncooperative plugin must
  // not pin the main agent loop after its time budget is exhausted.
  tools.TOOLS.__deadline_probe = {
    name: "__deadline_probe", description: "test-only", parameters: {},
    execute: () => new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
  };
  try {
    const t0 = Date.now();
    const res = await tools.executeTool("__deadline_probe", {}, "build", { toolTimeoutMs: 25 });
    expect(Date.now() - t0).toBeLessThan(150);
    expect(res.error).toContain("timed out after 1s");
  } finally {
    delete tools.TOOLS.__deadline_probe;
  }
});

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

test("websearch: uses the open-source SearXNG JSON fallback when configured", async () => {
  const saved = { brave: process.env.BRAVE_API_KEY, tavily: process.env.TAVILY_API_KEY, searx: process.env.SEARXNG_URL, list: process.env.SEARXNG_INSTANCES };
  delete process.env.BRAVE_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.SEARXNG_INSTANCES;
  let requested = "";
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      requested = req.url;
      return Response.json({ results: [
        { title: "Result <b>A</b>", url: "https://example.com/a", content: "First <i>snippet</i>" },
        { title: "Result B", url: "https://example.com/b", content: "Second snippet" },
        { title: "Ignored", url: "https://example.com/c", content: "beyond count" },
      ] });
    },
  });
  process.env.SEARXNG_URL = server.url.origin;
  try {
    const res = await tools.executeTool("websearch", { query: "loom search", count: 2 });
    expect(String(res.result)).toContain("1. Result A");
    expect(String(res.result)).toContain("https://example.com/a");
    expect(String(res.result)).toContain("First snippet");
    expect(String(res.result)).not.toContain("Ignored");
    const u = new URL(requested);
    expect(u.pathname).toBe("/search");
    expect(u.searchParams.get("q")).toBe("loom search");
    expect(u.searchParams.get("format")).toBe("json");
  } finally {
    await server.stop(true);
    if (saved.brave == null) delete process.env.BRAVE_API_KEY; else process.env.BRAVE_API_KEY = saved.brave;
    if (saved.tavily == null) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = saved.tavily;
    if (saved.searx == null) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = saved.searx;
    if (saved.list == null) delete process.env.SEARXNG_INSTANCES; else process.env.SEARXNG_INSTANCES = saved.list;
  }
});
