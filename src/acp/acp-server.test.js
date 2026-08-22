// Smoke tests for the ACP server (src/acp/acp-server.js) — protocol methods
// that don't require a live model turn. The server is exercised the way an
// editor would: as a real child process talking newline-delimited JSON over
// stdio. Runs with: bun test src/acp/acp-server.test.js
process.env.LOOM_MEM_AUTO = "0";
process.env.LOOM_MCP_NO_WARM = "1";
import { test, expect, afterAll } from "bun:test";
import { spawn } from "child_process";
import os from "os";
import fs from "fs";
import path from "path";

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-acp-cfg-"));
fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ provider: "nvidia" }), "utf8");
process.env.LOOM_CONFIG_DIR = cfgDir;

const HARNESS =
  'const { AcpServer } = require(' + JSON.stringify(path.join(__dirname, "acp-server.js")) + ');\n' +
  'const s = new AcpServer(); s.start(); process.stdin.resume();';

function spawnServer() {
  const child = spawn(process.execPath, ["-e", HARNESS], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  const pending = new Map();
  let buf = "";
  let errBuf = "";
  child.stderr.on("data", (d) => { errBuf += d.toString(); });
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let seq = 0;
  function send(method, params) {
    const rid = ++seq;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params: params || {} }) + "\n");
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(rid); reject(new Error("timeout waiting for " + method + " (id " + rid + ")")); }, 5000);
      pending.set(rid, (msg) => { clearTimeout(t); resolve(msg); });
    });
  }
  function close() { try { child.kill(); } catch {} }
  return { child, send, close, stderr: () => errBuf };
}

let server;
function serverManager() {
  if (!server) server = spawnServer();
  return server;
}
afterAll(() => {
  if (server) server.close();
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}
});

test("initialize returns protocolVersion + tool schemas", async () => {
  const s = serverManager();
  const resp = await s.send("initialize");
  if (resp.error) throw new Error("initialize error: " + JSON.stringify(resp.error) + "\nchild stderr: " + s.stderr().slice(0, 500));
  expect(resp.result.protocolVersion).toBe(1);
  expect(resp.result.capabilities.openai).toBe(true);
  expect(resp.result.toolSchemas.length).toBeGreaterThan(0);
});

test("connect creates a task and emits session.updated created", async () => {
  const s = serverManager();
  const conn = await s.send("connect", {});
  expect(conn.error).toBeUndefined();
  const taskId = conn.result.taskId;
  expect(taskId).toBeTruthy();
  const ev = await s.send("fetchAgentEvent", { taskId, cursor: 0 });
  expect(ev.result.cursor).toBeGreaterThan(0);
  expect(ev.result.events.some((e) => e.event === "session.updated" && e.type === "created")).toBe(true);
});

test("storeMessage stores into the task session", async () => {
  const s = serverManager();
  const conn = await s.send("connect", {});
  const taskId = conn.result.taskId;
  const res = await s.send("storeMessage", { taskId, message: { role: "user", content: "hello acp" } });
  expect(res.error).toBeUndefined();
  expect(res.result).toBeNull();
});

test("fetchAgentEvent on an unknown task errors", async () => {
  const s = serverManager();
  const resp = await s.send("fetchAgentEvent", { taskId: "nope", cursor: 0 });
  expect(resp.error).toBeTruthy();
  expect(resp.error.message).toMatch(/Unknown task/);
});

test("unknown method returns JSON-RPC -32601", async () => {
  const s = serverManager();
  const resp = await s.send("not.a.real.method");
  expect(resp.error.code).toBe(-32601);
});

test("cancelCurrentTask does not error on a valid task", async () => {
  const s = serverManager();
  const conn = await s.send("connect", {});
  const taskId = conn.result.taskId;
  const res = await s.send("cancelCurrentTask", { taskId });
  expect(res.error).toBeUndefined();
  expect(res.result).toBeNull();
});
