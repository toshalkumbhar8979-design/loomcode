// Unit tests for session persistence (src/core/session-store.js).
// Runs with:  bun test src/core/session-store.test.js
import { test, expect, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let store;
let cfgDir;

beforeEach(() => {
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-store-"));
  process.env.LOOM_CONFIG_DIR = cfgDir;
  store = require("./session-store");
});

afterAll(() => {
  delete process.env.LOOM_CONFIG_DIR;
});

function fakeSession(over) {
  return {
    conversationId: "t-1",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo", tool_calls: [{ id: "x" }] },
    ],
    config: { provider: "anthropic", model: { anthropic: "claude" } },
    ...(over || {}),
  };
}

test("saveSession: writes schemaVersion and metadata, survives round trip", () => {
  const { id, file } = store.saveSession(fakeSession());
  expect(id).toBe("t-1");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(raw.schemaVersion).toBe(store.SESSION_SCHEMA_VERSION);
  expect(raw.createdAt).toBeTypeOf("string");
  expect(raw.provider).toBe("anthropic");
  expect(raw.model).toBe("claude");
  const back = store.loadSession("t-1");
  expect(back.messages).toHaveLength(2);
  expect(back.messages[1].tool_calls[0].id).toBe("x");
});

test("saveSession: generates an id when missing", () => {
  const { id } = store.saveSession(fakeSession({ conversationId: undefined }));
  expect(id).toBeTypeOf("string");
  expect(id.length).toBeGreaterThan(4);
});

test("loadSession: returns null for unknown, bad, or corrupt ids", () => {
  expect(store.loadSession("nope")).toBeNull();
  expect(store.loadSession("")).toBeNull();
  expect(store.loadSession(undefined)).toBeNull();
  fs.mkdirSync(path.join(cfgDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "sessions", "t-1.json"), "{not json", "utf8");
  expect(store.loadSession("t-1")).toBeNull();
});

test("loadSession: normalizes legacy (v1) files with missing fields", () => {
  const dir = path.join(cfgDir, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "legacy.json"),
    JSON.stringify({ id: "legacy", messages: [null, { content: "no role" }, { role: "user" }] }),
    "utf8"
  );
  const data = store.loadSession("legacy");
  expect(data.schemaVersion).toBe(1);
  expect(data.messages[0]).toEqual({ role: "user", content: "" });
  expect(data.messages[1]).toEqual({ role: "user", content: "no role" });
  expect(data.messages[2]).toEqual({ role: "user", content: "" });
});

test("normalizeSession: rejects garbage and preserves extras", () => {
  expect(store.normalizeSession(null)).toBeNull();
  expect(store.normalizeSession("x")).toBeNull();
  const norm = store.normalizeSession({
    id: "a",
    messages: [{ role: "user", content: "c", extra: 1 }],
  });
  expect(norm.messages[0]).toEqual({ role: "user", content: "c", extra: 1 });
  expect(store.normalizeSession({ messages: "not an array" }).messages).toEqual([]);
});

test("listSessions: enumerates saved sessions newest first", async () => {
  store.saveSession(fakeSession({ conversationId: "one", updatedAt: "2024-01-01T00:00:00Z" }));
  // saveSession stamps updatedAt itself; space the writes so mtimes differ.
  await new Promise((r) => setTimeout(r, 20));
  store.saveSession(fakeSession({ conversationId: "two", updatedAt: "2024-01-01T00:00:01Z" }));
  const list = store.listSessions();
  expect(list).toHaveLength(2);
  expect(list.map((s) => s.id)).toEqual(["two", "one"]);
  expect(list[0].messageCount).toBe(2);
});

test("deleteSession: removes the file", () => {
  store.saveSession(fakeSession());
  expect(store.deleteSession("t-1")).toBe(true);
  expect(store.deleteSession("t-1")).toBe(false);
  expect(store.loadSession("t-1")).toBeNull();
});

test("exportChat: writes a markdown file", () => {
  const file = store.exportChat(fakeSession(), "md");
  const body = fs.readFileSync(file, "utf8");
  expect(body).toContain("# Loom Code Chat Export");
  expect(body).toContain("### User");
  try { fs.unlinkSync(file); } catch {}
});
