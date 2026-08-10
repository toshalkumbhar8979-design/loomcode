// Unit tests for the MCP JSON-RPC layer (src/mcp/mcp-client.js).
// Runs with:  bun test src/mcp/mcp-client.test.js
process.env.LOOM_MCP_NO_WARM = "1";
import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";

let mcp;

test("setup", () => {
  mcp = require("./mcp-client");
  expect(mcp.callRpc).toBeTypeOf("function");
});

function fakeChild() {
  let written = null;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: (data) => { written = JSON.parse(data); return true; } };
  child.lastWritten = () => written;
  return child;
}

test("callRpc: resolves the matching response by id", async () => {
  const child = fakeChild();
  const p = mcp.callRpc(child, "tools/call", { name: "x" }, 1000);
  const id = child.lastWritten().id;
  expect(child.lastWritten().method).toBe("tools/call");
  child.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }) + "\n"));
  expect(await p).toEqual({ ok: true });
});

test("callRpc: ignores responses with other ids", async () => {
  const child = fakeChild();
  const p = mcp.callRpc(child, "tools/call", {}, 1000);
  const id = child.lastWritten().id;
  child.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: id + 999, result: 1 }) + "\n"));
  child.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: "mine" }) + "\n"));
  expect(await p).toBe("mine");
});

test("callRpc: rejects on error responses", async () => {
  const child = fakeChild();
  const p = mcp.callRpc(child, "tools/call", {}, 1000);
  const id = child.lastWritten().id;
  child.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, error: { message: "boom" } }) + "\n"));
  await expect(p).rejects.toThrow("boom");
});

test("callRpc: rejects with a timeout when the server never responds", async () => {
  const child = fakeChild();
  const p = mcp.callRpc(child, "tools/call", {}, 50);
  await expect(p).rejects.toThrow("timed out");
});

test("callRpc: rejects cleanly when stdin is closed", async () => {
  const child = fakeChild();
  child.stdin.write = () => { throw new Error("EPIPE"); };
  await expect(mcp.callRpc(child, "x", {}, 1000)).rejects.toThrow("EPIPE");
});

test("callRpc: strips a UTF-8 BOM from the first response line", async () => {
  const child = fakeChild();
  const p = mcp.callRpc(child, "tools/call", {}, 1000);
  const id = child.lastWritten().id;
  child.stdout.emit("data", Buffer.from("\uFEFF" + JSON.stringify({ jsonrpc: "2.0", id, result: "bom-free" }) + "\n"));
  expect(await p).toBe("bom-free");
});

test("callRpc: rejects immediately when the server process exits", async () => {
  const child = fakeChild();
  const p = mcp.callRpc(child, "tools/call", {}, 60000);
  child.emit("close", 1, null);
  await expect(p).rejects.toThrow("exited (code 1)");
});

test("killTree: terminates the child even if taskkill/process-group kill fails", () => {
  const killed = [];
  const child = { pid: 999999, killed: false, kill: (sig) => { killed.push(sig); child.killed = true; } };
  mcp.killTree(child);
  expect(killed.length).toBeGreaterThan(0);
  mcp.killTree(child); // already dead → no-op
  expect(killed.length).toBe(1);
});
