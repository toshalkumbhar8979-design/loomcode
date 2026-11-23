// Unit tests for session persistence (src/core/session-store.js).
// Layout: <cfgDir>/sessions/<id>/{session.json,messages.jsonl} (v4), with
// read-through for project-local sessions and legacy flat <id>.json files
// (v1/v2).
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
      { role: "assistant", content: "yo", toolCalls: [{ id: "x" }] },
      { role: "tool", toolCallId: "x", content: "result" },
    ],
    config: { provider: "anthropic", model: { anthropic: "claude" } },
    ...(over || {}),
  };
}

test("saveSession: per-session folder with session.json + messages.jsonl", () => {
  const { id, file, dir } = store.saveSession(fakeSession());
  expect(id).toBe("t-1");
  expect(dir).toBe(path.join(cfgDir, "sessions", "t-1"));
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(raw.schemaVersion).toBe(store.SESSION_SCHEMA_VERSION);
  expect(raw.createdAt).toBeTypeOf("string");
  expect(raw.provider).toBe("anthropic");
  expect(raw.model).toBe("claude");
  // messages live one-per-line in messages.jsonl, not inside session.json
  const lines = fs.readFileSync(path.join(dir, "messages.jsonl"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(3);
  expect(JSON.parse(lines[2]).toolCallId).toBe("x");
});

test("saveSession: round trip preserves toolCallId + toolCalls (resume wire format)", () => {
  store.saveSession(fakeSession());
  const back = store.loadSession("t-1");
  expect(back.messages).toHaveLength(3);
  expect(back.messages[1].toolCalls[0].id).toBe("x");
  expect(back.messages[2].role).toBe("tool");
  expect(back.messages[2].toolCallId).toBe("x");
});

test("saveSession: generates an id when missing", () => {
  const { id } = store.saveSession(fakeSession({ conversationId: undefined }));
  expect(id).toBeTypeOf("string");
  expect(id.length).toBeGreaterThan(4);
});

test("saveSession: overwrite keeps original createdAt", async () => {
  const first = store.saveSession(fakeSession());
  const meta1 = JSON.parse(fs.readFileSync(first.file, "utf8"));
  await new Promise((r) => setTimeout(r, 20));
  const second = store.saveSession(fakeSession());
  const meta2 = JSON.parse(fs.readFileSync(second.file, "utf8"));
  expect(meta2.createdAt).toBe(meta1.createdAt);
  expect(meta2.updatedAt >= meta1.updatedAt).toBe(true);
});

test("loadSession: returns null for unknown, bad, or corrupt ids", () => {
  expect(store.loadSession("nope")).toBeNull();
  expect(store.loadSession("")).toBeNull();
  expect(store.loadSession(undefined)).toBeNull();
  const dir = path.join(cfgDir, "sessions", "broken");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session.json"), "{not json", "utf8");
  expect(store.loadSession("broken")).toBeNull();
});

test("loadSession: normalizes legacy (v1) flat files with missing fields", () => {
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

test("loadSession: legacy snake_case tool fields alias to camelCase", () => {
  const dir = path.join(cfgDir, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "oldsave.json"),
    JSON.stringify({
      id: "oldsave",
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "tc1", name: "bash", input: {} }] },
        { role: "tool", content: "out", tool_call_id: "tc1" },
      ],
    }),
    "utf8"
  );
  const data = store.loadSession("oldsave");
  expect(data.messages[0].toolCalls[0].id).toBe("tc1");
  expect(data.messages[1].toolCallId).toBe("tc1");
});

test("listSessions: enumerates saved sessions newest first", async () => {
  store.saveSession(fakeSession({ conversationId: "one", updatedAt: "2024-01-01T00:00:00Z" }));
  // saveSession stamps updatedAt itself; space the writes so mtimes differ.
  await new Promise((r) => setTimeout(r, 20));
  store.saveSession(fakeSession({ conversationId: "two", updatedAt: "2024-01-01T00:00:01Z" }));
  const list = store.listSessions();
  expect(list).toHaveLength(2);
  expect(list.map((s) => s.id)).toEqual(["two", "one"]);
  expect(list[0].messageCount).toBe(3);
});

test("listSessions: migrated session appears once (folder shadows flat file)", () => {
  // v2 flat file on disk...
  const dir = path.join(cfgDir, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "mig.json"),
    JSON.stringify({ id: "mig", schemaVersion: 2, messages: [{ role: "user", content: "old" }] }),
    "utf8"
  );
  // ...then the same id saved in the new folder layout.
  store.saveSession(fakeSession({ conversationId: "mig" }));
  const list = store.listSessions().filter((s) => s.id === "mig");
  expect(list).toHaveLength(1);
  const back = store.loadSession("mig");
  expect(back.messages).toHaveLength(3); // folder version wins
});

test("deleteSession: removes the folder (and any stale flat file)", () => {
  store.saveSession(fakeSession());
  expect(store.deleteSession("t-1")).toBe(true);
  expect(store.deleteSession("t-1")).toBe(false);
  expect(store.loadSession("t-1")).toBeNull();
  expect(fs.existsSync(path.join(cfgDir, "sessions", "t-1"))).toBe(false);
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

test("exportChat: writes a markdown file", () => {
  const file = store.exportChat(fakeSession(), "md");
  const body = fs.readFileSync(file, "utf8");
  expect(body).toContain("# Loom Code Chat Export");
  expect(body).toContain("### User");
  try { fs.unlinkSync(file); } catch {}
});

test("saveSession: titles come from the first user message", () => {
  store.saveSession(fakeSession({
    conversationId: "titled",
    messages: [
      { role: "system", content: "ignored" },
      { role: "user", content: "Fix the parser\nplease." },
      { role: "assistant", content: "working" },
    ],
  }));
  const back = store.loadSession("titled");
  expect(back.title).toBe("Fix the parser please.");
  const listed = store.listSessions().find((s) => s.id === "titled");
  expect(listed.title).toBe("Fix the parser please.");
});

test("saveSession: never creates an empty session; old empties stay hidden", () => {
  const skipped = store.saveSession({ conversationId: "empty-new", messages: [] });
  expect(skipped.skipped).toBe(true);
  expect(skipped.file).toBeNull();
  expect(store.loadSession("empty-new")).toBeNull();

  const dir = path.join(cfgDir, "sessions", "empty-old");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({
    id: "empty-old", schemaVersion: 4, createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 0,
  }), "utf8");
  fs.writeFileSync(path.join(dir, "messages.jsonl"), "", "utf8");

  expect(store.listSessions().map((s) => s.id)).not.toContain("empty-old");
  expect(store.listSessions({ includeEmpty: true }).map((s) => s.id)).toContain("empty-old");
});

test("listSessions: scopes to the current project and latestSession picks it", () => {
  const original = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-scope-"));
  const projectA = path.join(root, "a");
  const projectB = path.join(root, "b");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  try {
    process.chdir(projectA);
    store.saveSession(fakeSession({ conversationId: "scope-a" }));
    process.chdir(projectB);
    store.saveSession(fakeSession({ conversationId: "scope-b" }));

    const scoped = store.listSessions().map((s) => s.id);
    expect(scoped).toContain("scope-b");
    expect(scoped).not.toContain("scope-a");
    expect(store.latestSession().id).toBe("scope-b");

    const all = store.listSessions({ allProjects: true }).map((s) => s.id);
    expect(all).toContain("scope-a");
    expect(all).toContain("scope-b");

    // Explicit IDs keep working outside their project, like `opencode -s`.
    expect(store.loadSession("scope-a").messages).toHaveLength(3);
  } finally {
    process.chdir(original);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test("saveSessionAsync: live save appends only the new messages", async () => {
  const first = fakeSession();
  const saved = await store.saveSessionAsync(first, { append: true });
  const extra = { role: "assistant", content: "third pass" };
  const next = fakeSession({ messages: first.messages.concat([extra]) });
  let appended = "";
  const original = fs.promises.appendFile;
  fs.promises.appendFile = async function (file, data) {
    appended += String(data);
    return original.call(fs.promises, file, data);
  };
  try {
    await store.saveSessionAsync(next, { append: true });
  } finally {
    fs.promises.appendFile = original;
  }
  expect(appended).toBe(JSON.stringify(extra) + "\n");
  const lines = fs.readFileSync(path.join(saved.dir, "messages.jsonl"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(4);
  const meta = JSON.parse(fs.readFileSync(saved.file, "utf8"));
  expect(meta.messageCount).toBe(4);
});

test("saveSessionAsync: rewrite mode drops removed messages", async () => {
  const first = fakeSession();
  const saved = await store.saveSessionAsync(first);
  await store.saveSessionAsync(fakeSession({ messages: first.messages.slice(0, 2) }), { append: false });
  const lines = fs.readFileSync(path.join(saved.dir, "messages.jsonl"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  const meta = JSON.parse(fs.readFileSync(saved.file, "utf8"));
  expect(meta.messageCount).toBe(2);
});

test("saveSession: overwriting does not re-read messages.jsonl", () => {
  store.saveSession(fakeSession());
  const original = fs.readFileSync;
  let readMessages = false;
  fs.readFileSync = function (file, ...args) {
    if (String(file).endsWith("messages.jsonl")) readMessages = true;
    return original.call(fs, file, ...args);
  };
  try {
    store.saveSession(fakeSession());
  } finally {
    fs.readFileSync = original;
  }
  expect(readMessages).toBe(false);
});
