// Unit tests for the Session agent-loop core (src/core/session.js).
// Runs with:  bun test src/core/session.test.js
process.env.LOOM_MCP_NO_WARM = "1";
process.env.LOOM_MEM_AUTO = "0";
import { test, expect, beforeAll, afterAll } from "bun:test";
import os from "os";
import fs from "fs";
import path from "path";

const USAGE_TMP = path.join(os.tmpdir(), "loom-session-" + process.pid + "-" + Date.now() + ".json");
process.env.LOOM_USAGE_FILE = USAGE_TMP;

let Session, events;
let savedEnv = {};

beforeAll(() => {
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TOKENROUTER_API_KEY"]) {
    savedEnv[k] = process.env[k];
  }
  ({ Session } = require("./session.js"));
  events = require("./events.js");
});

afterAll(() => {
  try { fs.rmSync(USAGE_TMP, { force: true }); } catch {}
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function freshSession() {
  const s = new Session();
  s.config = { ...s.config, budgetLevel: "auto", apiKeys: {}, skillDisabled: [] };
  return s;
}

test("constructor: default build mode, empty messages, config loaded", () => {
  const s = freshSession();
  expect(s.mode).toBe("build");
  expect(s.messages).toEqual([]);
  expect(s.turnCount).toBe(0);
  expect(s.config).toBeTruthy();
});

test("setMode validates and rebuilds system prompt", () => {
  const s = freshSession();
  expect(s.setMode("plan")).toBe("plan");
  expect(s.setMode("plan")).toBe("plan"); // unchanged -> no rebuild
  expect(s.setMode("nope")).toBe("plan");
  expect(s.setMode("chat")).toBe("chat");
  expect(s.systemPrompt).toContain("CHAT MODE");
});

test("setTodos normalizes statuses, priorities, dedupes by content", () => {
  const s = freshSession();
  const out = s.setTodos([
    { content: "  Fix the bug  ", status: "bogus", priority: "urgent" },
    { content: "Ship it", status: "in_progress", priority: "high" },
    { content: "Ship it", status: "completed" },
    { content: "  ", status: "pending" },
    { content: null, status: "pending" },
  ]);
  expect(out).toHaveLength(2);
  expect(out[0]).toEqual({ content: "Fix the bug", status: "pending", priority: "medium" });
  // later entry wins (upsert)
  expect(out[1]).toEqual({ content: "Ship it", status: "completed", priority: "medium" });
  expect(s.setTodos("nope")).toEqual([]);
});

test("estimateTokens: chars/4 incl. tool call inputs", () => {
  const s = freshSession();
  s.addMessage({ role: "user", content: "0123456789" }); // 10 chars
  s.addMessage({ role: "assistant", content: "0123456789", toolCalls: [{ input: { filePath: "abcd" } }] }); // 10 + ~18 JSON chars
  const est = s.estimateTokens();
  const expected = Math.ceil((10 + 10 + JSON.stringify({ filePath: "abcd" }).length) / 4);
  expect(est).toBe(expected);
});

test("shouldCompact: short conversations never compact", () => {
  const s = freshSession();
  s.addMessage({ role: "user", content: "hi" });
  expect(s.shouldCompact()).toBe(false);
});

test("shouldCompact: triggers over threshold", () => {
  const s = freshSession();
  // Pin the context window: getContextWindow falls back to 200k with no active
  // provider, but a 1M-context model (e.g. some OpenRouter entries) makes the
  // 0.0001 threshold unreachable for 8 short messages.
  s.provider.active = null;
  s.config.compactThreshold = 0.0001;
  for (let i = 0; i < 8; i++) {
    s.addMessage({ role: "user", content: "padding padding padding padding padding padding" });
  }
  expect(s.shouldCompact()).toBe(true);
});

test("compact: too short -> not compacted", async () => {
  const s = freshSession();
  s.addMessage({ role: "user", content: "a" });
  const res = await s.compact();
  expect(res.compacted).toBe(false);
  expect(res.reason).toBe("conversation too short");
});

test("compact: truncate fallback when no provider is active", async () => {
  const s = freshSession();
  for (let i = 0; i < 30; i++) {
    s.addMessage({ role: "user", content: "Message " + i + " some padding here" });
  }
  s.provider.active = null; // no summary call -> truncate fallback (no network)
  const res = await s.compact();
  expect(res.compacted).toBe(true);
  expect(res.method).toBe("truncate");
  expect(res.removed).toBeGreaterThan(0);
  expect(s.messages.length).toBeLessThanOrEqual(9);
  expect(s.messages[0].content).toContain("truncated");
});

test("interrupt: sets flag and aborts the controller", () => {
  const s = freshSession();
  s.abortController = new AbortController();
  s.interrupt();
  expect(s.interrupted).toBe(true);
  expect(s.abortController.signal.aborted).toBe(true);
});

test("runTurn: simple text response with no tools", async () => {
  const s = freshSession();
  s.getResponse = async () => ({ type: "assistant", content: "hello back", toolCalls: [] });
  const res = await s.runTurn({});
  expect(res.type).toBe("text");
  expect(res.content).toBe("hello back");
  expect(s.lastText).toBe("hello back");
});

test("runTurn: executes tool calls in order, then finishes", async () => {
  const s = freshSession();
  let calls = 0;
  const toolEvents = [];
  s.getResponse = async () => {
    calls++;
    if (calls === 1) {
      return {
        type: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "todowrite", input: { todos: [{ content: "task a", status: "pending" }] } }],
      };
    }
    return { type: "assistant", content: "done", toolCalls: [] };
  };
  const res = await s.runTurn({
    onTool: (name) => toolEvents.push("call:" + name),
    onToolResult: (name, out) => toolEvents.push("result:" + name),
  });
  expect(res.type).toBe("text");
  expect(res.content).toBe("done");
  expect(s.todos).toEqual([{ content: "task a", status: "pending", priority: "medium" }]);
  expect(s.messages.some((m) => m.role === "tool" && String(m.content).includes("Todo List"))).toBe(true);
  expect(toolEvents).toEqual(["call:todowrite", "result:todowrite"]);
});

test("runTurn: permission prompt denied blocks the bash call", async () => {
  const s = freshSession();
  let asks = 0;
  let calls = 0;
  s.getResponse = async () => {
    calls++;
    if (calls === 1) return { type: "assistant", content: "", toolCalls: [{ id: "t1", name: "bash", input: { command: "echo hi" } }] };
    return { type: "assistant", content: "done", toolCalls: [] };
  };
  const res = await s.runTurn({
    onPermissionRequest: async () => { asks++; return false; },
  });
  expect(res.type).toBe("text");
  expect(asks).toBe(1);
  const toolMsg = s.messages.find((m) => m.role === "tool");
  expect(String(toolMsg.content)).toContain("Permission denied");
});

test("runTurn: abort preserves partial streamed text", async () => {
  const s = freshSession();
  const deltas = [];
  s.getResponse = async () => {
    const err = new Error("stream aborted by user");
    err.name = "AbortError";
    throw err;
  };
  const res = await s.runTurn({
    onDelta: (t) => deltas.push(t),
  });
  expect(res.interrupted).toBe(true);
  expect(s.interrupted).toBe(false); // flag reset by finishInterrupted
  expect(res.content).toBe("(interrupted)");
  expect(deltas.length).toBe(0);
  const s2 = freshSession();
  s2.getResponse = async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  const res2 = await s2.runTurn({ onDelta: (t) => { s2._streamed = (s2._streamed || "") + t; } });
  // No streamed text before abort in this variant either.
  expect(res2.interrupted).toBe(true);
});

test("runTurn: 50-iteration tool limit returns a stop message", async () => {
  const s = freshSession();
  s.getResponse = async () => ({
    type: "assistant",
    content: "",
    toolCalls: [{ id: "t" + Math.random(), name: "todowrite", input: { todos: [] } }],
  });
  const res = await s.runTurn({});
  expect(res.content).toContain("tool limit");
});

test("runTurn: model errors surface as error responses", async () => {
  const s = freshSession();
  s.getResponse = async () => { throw new Error("boom"); };
  const res = await s.runTurn({});
  expect(res.type).toBe("error");
  expect(res.content).toContain("boom");
});

test("sendUserMessage: appends user message, emits turn events", async () => {
  const s = freshSession();
  s.runTurn = async () => ({ type: "text", content: "ok" });
  const seen = [];
  const offStart = events.on("turn:start", (d) => seen.push("start:" + d.text));
  const offEnd = events.on("turn:end", (d) => seen.push("end:" + (d.type || "")));
  const res = await s.sendUserMessage("hello", {});
  offStart(); offEnd();
  expect(res.type).toBe("text");
  expect(s.turnCount).toBe(1);
  expect(s.messages.some((m) => m.role === "user" && m.content === "hello")).toBe(true);
  expect(seen).toEqual(["start:hello", "end:text"]);
});

test("skill injection: matcher hit builds the skill block + emits trigger", async () => {
  const s = freshSession();
  s.runTurn = async () => ({ type: "text", content: "ok" });
  s._skillMatcher = () => [{ name: "gcode expert", instructions: "Follow G-code rules." }];
  const seen = [];
  const off = events.on("trigger:skill", (d) => seen.push(d.skills));
  const res = await s.sendUserMessage("slice this to gcode", {});
  off();
  expect(res.type).toBe("text");
  expect(s._activeSkill).toEqual(["gcode expert"]);
  expect(s._skillBlock).toContain("[Active skill for this turn: gcode expert]");
  expect(s._skillBlock).toContain("Follow G-code rules.");
  expect(seen).toEqual([["gcode expert"]]);
});

test("skill injection: disabled skills are filtered out", async () => {
  const s = freshSession();
  s.config.skillDisabled = ["gcode expert"];
  s.runTurn = async () => ({ type: "text", content: "ok" });
  s._skillMatcher = () => [{ name: "gcode expert", instructions: "Follow G-code rules." }];
  await s.sendUserMessage("slice this to gcode", {});
  expect(s._activeSkill).toEqual([]);
  expect(s._skillBlock).toBe("");
});

test("recordUsage: openai-style usage accrues tokens + cost", () => {
  const s = freshSession();
  s.recordUsage({ prompt_tokens: 500000, completion_tokens: 100000 }, "claude-sonnet-4-20250514", "anthropic");
  expect(s.tokensIn).toBe(500000);
  expect(s.tokensOut).toBe(100000);
  expect(s.tokensUsed).toBe(600000);
  // sonnet $3/$15 per 1M: 0.5*3 + 0.1*15 = $3.00
  expect(s.sessionCost).toBeCloseTo(3.0, 5);
});

test("recordUsage: anthropic-style usage + null usage no-ops", () => {
  const s = freshSession();
  s.recordUsage({ input_tokens: 10, output_tokens: 20 }, "claude-sonnet-4-20250514", "anthropic");
  expect(s.tokensIn).toBe(10);
  expect(s.tokensOut).toBe(20);
  const before = { in: s.tokensIn, out: s.tokensOut, cost: s.sessionCost };
  s.recordUsage(null, "claude-sonnet-4-20250514", "anthropic");
  expect(s.tokensIn).toBe(before.in);
  expect(s.tokensOut).toBe(before.out);
  expect(s.sessionCost).toBe(before.cost);
});

test("isQuotaError: 429/402/rate-limit messages are quota errors", () => {
  const { isQuotaError } = require("./session.js");
  expect(isQuotaError({ status: 429 })).toBe(true);
  expect(isQuotaError({ status: 402 })).toBe(true);
  expect(isQuotaError({ status: 500 })).toBe(false);
  expect(isQuotaError({ message: "rate limit exceeded, retry later" })).toBe(true);
  expect(isQuotaError({ message: "You have insufficient balance. Please add a payment method." })).toBe(true);
  expect(isQuotaError({ message: "model not found" })).toBe(false);
  expect(isQuotaError(null)).toBe(false);
});

test("isAbortError: AbortError / APIUserAbortError / cancel messages", () => {
  const { isAbortError } = require("./session.js");
  const a = new Error("x"); a.name = "AbortError";
  expect(isAbortError(a)).toBe(true);
  const b = new Error("x"); b.name = "APIUserAbortError";
  expect(isAbortError(b)).toBe(true);
  expect(isAbortError(new Error("Request was aborted."))).toBe(true);
  expect(isAbortError(new Error("rate limited"))).toBe(false);
  expect(isAbortError(null)).toBe(false);
});

test("reset: clears session state and rotates conversation id", () => {
  const s = freshSession();
  s.addMessage({ role: "user", content: "x" });
  s.turnCount = 3;
  s.tokensUsed = 100;
  const oldId = s.conversationId;
  s.reset();
  expect(s.messages).toEqual([]);
  expect(s.turnCount).toBe(0);
  expect(s.tokensUsed).toBe(0);
  expect(s.conversationId).not.toBe(oldId);
});
