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
// Hermetic config: never read the developer's real ~/.loom (its provider —
// possibly a dynamic models.dev one — isn't merged under the test process's
// registry state, which made every `new Session()` throw "Unknown provider").
const CFG_TMP = path.join(os.tmpdir(), "loom-session-cfg-" + process.pid + "-" + Date.now());
process.env.LOOM_CONFIG_DIR = CFG_TMP;

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
  try { fs.rmSync(CFG_TMP, { recursive: true, force: true }); } catch {}
  delete process.env.LOOM_CONFIG_DIR;
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
  // bash defaults to allow now (dangerous commands still ask) — pin an
  // explicit ask rule to exercise the prompt path.
  s.permissions.loadConfig({ permission: { bash: "ask" } });
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
  expect(res.content).toBe("(interrupted before any text was streamed)");
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

test("runTurn: no tool-use cap — long tool chains run until the model stops", async () => {
  const s = freshSession();
  let calls = 0;
  s.getResponse = async () => {
    calls++;
    if (calls <= 60) {
      return { type: "assistant", content: "", toolCalls: [{ id: "t" + calls, name: "todowrite", input: { todos: [{ text: "step " + calls, status: "pending" }] } }] };
    }
    // Mark the tracked work done before the final reply — otherwise the
    // drive-to-completion guard would (correctly) keep nudging.
    if (calls === 61) {
      return { type: "assistant", content: "", toolCalls: [{ id: "t61", name: "todowrite", input: { todos: [{ content: "step 60", status: "completed" }] } }] };
    }
    return { type: "assistant", content: "finally done", toolCalls: [] };
  };
  const res = await s.runTurn({});
  expect(res.type).toBe("text");
  expect(res.content).toContain("finally done");
  expect(calls).toBe(62);
});

test("runTurn: drive-to-completion — premature summary with open todos continues", async () => {
  const s = freshSession();
  let calls = 0;
  s.getResponse = async () => {
    calls++;
    if (calls === 1) {
      return { type: "assistant", content: "", toolCalls: [{ id: "t1", name: "todowrite", input: { todos: [
        { content: "item one", status: "pending" },
        { content: "item two", status: "pending" },
      ] } }] };
    }
    if (calls === 2) {
      return { type: "assistant", content: "", toolCalls: [{ id: "t2", name: "todowrite", input: { todos: [
        { content: "item one", status: "completed" },
        { content: "item two", status: "pending" },
      ] } }] };
    }
    if (calls === 3) {
      // Premature wrap-up while "item two" is still open.
      return { type: "assistant", content: "Done so far — item one is finished.", toolCalls: [] };
    }
    if (calls === 4) {
      return { type: "assistant", content: "", toolCalls: [{ id: "t4", name: "todowrite", input: { todos: [
        { content: "item one", status: "completed" },
        { content: "item two", status: "completed" },
      ] } }] };
    }
    return { type: "assistant", content: "All done.", toolCalls: [] };
  };
  const res = await s.runTurn({});
  expect(res.type).toBe("text");
  expect(res.content).toBe("All done.");
  expect(calls).toBe(5);
  const nudges = s.messages.filter((m) => m.role === "user" && String(m.content).includes("unfinished work detected"));
  expect(nudges.length).toBe(1);
  expect(String(nudges[0].content)).toContain("item two");
  // The nudge quotes the model's ACTUAL last message, not a canned line.
  expect(String(nudges[0].content)).toContain("Your last message was:");
  expect(String(nudges[0].content)).toContain("Done so far");
  // Everything completed -> no leftovers surfaced to the UI.
  expect(res.openTodos).toBeUndefined();
});

test("runTurn: drive-to-completion nudges are capped", async () => {
  const s = freshSession();
  let calls = 0;
  s.getResponse = async () => {
    calls++;
    if (calls === 1) {
      return { type: "assistant", content: "", toolCalls: [{ id: "t1", name: "todowrite", input: { todos: [{ content: "stuck item", status: "pending" }] } }] };
    }
    return { type: "assistant", content: "premature stop", toolCalls: [] };
  };
  const res = await s.runTurn({});
  expect(res.type).toBe("text");
  // 1 tool call + 8 nudged continuations; the 9th premature reply returns.
  expect(calls).toBe(10);
  const nudges = s.messages.filter((m) => m.role === "user" && String(m.content).includes("unfinished work detected"));
  expect(nudges.length).toBe(8);
  // Every nudge carries the actual last reply and the open todo list.
  expect(String(nudges[0].content)).toContain("premature stop");
  expect(String(nudges[0].content)).toContain("stuck item");
  // The turn reports the REAL leftovers so the UI can show them.
  expect(res.openTodos.map((t) => t.content)).toEqual(["stuck item"]);
});

test("runTurn: transient provider errors are retried before surfacing", async () => {
  const s = freshSession();
  let calls = 0;
  s.getResponse = async () => {
    calls++;
    if (calls <= 2) throw new Error("socket hang up");
    return { type: "assistant", content: "recovered", toolCalls: [] };
  };
  const res = await s.runTurn({});
  expect(res.type).toBe("text");
  expect(res.content).toBe("recovered");
  expect(calls).toBe(3);
});

test("runTurn: empty reply after tools is nudged with the real tool-call count", async () => {
  const s = freshSession();
  let calls = 0;
  s.getResponse = async () => {
    calls++;
    if (calls === 1) {
      return { type: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", input: { filePath: __filename } }] };
    }
    if (calls === 2) return { type: "assistant", content: "", toolCalls: [] }; // silent stop
    return { type: "assistant", content: "recovered with actual text", toolCalls: [] };
  };
  const res = await s.runTurn({});
  expect(res.type).toBe("text");
  expect(res.content).toBe("recovered with actual text");
  expect(calls).toBe(3);
  const nudge = s.messages.find((m) => m.role === "user" && String(m.content).includes("empty reply"));
  expect(nudge).toBeTruthy();
  expect(String(nudge.content)).toContain("1 tool call");
});

test("runTurn: finish_reason=length auto-continues instead of dead-ending (empty content)", async () => {
  const s = freshSession();
  let calls = 0;
  s.getResponse = async () => {
    calls++;
    // Two truncated replies (thinking ate the whole output budget), then a
    // normal one.
    if (calls <= 2) return { type: "assistant", content: "", toolCalls: [], finishReason: "length" };
    return { type: "assistant", content: "the actual answer", toolCalls: [], finishReason: "stop" };
  };
  const res = await s.runTurn({});
  expect(res.type).toBe("text");
  expect(res.content).toBe("the actual answer");
  expect(calls).toBe(3);
  const truncs = s.messages.filter((m) => m.role === "user" && String(m.content).includes("cut off by the output-token limit"));
  expect(truncs.length).toBe(2);
  // The empty truncated assistant rows are dropped — Anthropic 400s on them.
  const empties = s.messages.filter((m) => m.role === "assistant" && !String(m.content || "").trim() && !(m.toolCalls || []).length);
  expect(empties.length).toBe(0);
});

test("runTurn: finish_reason=length with partial text continues from the cut point", async () => {
  const s = freshSession();
  let calls = 0;
  s.getResponse = async () => {
    calls++;
    if (calls === 1) {
      return { type: "assistant", content: "The fix has two parts. Part one is done,", toolCalls: [], finishReason: "length" };
    }
    return { type: "assistant", content: " and part two is the parser update.", toolCalls: [], finishReason: "stop" };
  };
  const res = await s.runTurn({});
  expect(res.type).toBe("text");
  expect(res.content).toContain("part two");
  const trunc = s.messages.find((m) => m.role === "user" && String(m.content).includes("cut off by the output-token limit"));
  expect(trunc).toBeTruthy();
  // The nudge quotes the actual cut point so the model can resume mid-sentence.
  expect(String(trunc.content)).toContain("Part one is done");
});

test("runTurn: truncation continuation is capped — no infinite loop", async () => {
  const s = freshSession();
  let calls = 0;
  s.getResponse = async () => {
    calls++;
    return { type: "assistant", content: "", toolCalls: [], finishReason: "length" };
  };
  const res = await s.runTurn({});
  expect(res.type).toBe("text");
  // 1 initial + 5 truncation continuations, then the placeholder returns.
  expect(calls).toBe(6);
  expect(res.content).toContain("max-tokens limit");
});

test("runTurn: premature short reply with stale todos + tools run is nudged (no todowrite needed)", async () => {
  const s = freshSession();
  s.setTodos([{ content: "stale but open item", status: "pending" }]);
  let calls = 0;
  s.getResponse = async () => {
    calls++;
    if (calls === 1) {
      return { type: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", input: { filePath: __filename } }] };
    }
    if (calls === 2) {
      // Short promise-style stop WITHOUT calling todowrite this turn.
      return { type: "assistant", content: "Now I will implement the parser.", toolCalls: [] };
    }
    // Finish: mark the item done, then close out.
    if (calls === 3) {
      return { type: "assistant", content: "", toolCalls: [{ id: "t3", name: "todowrite", input: { todos: [{ content: "stale but open item", status: "completed" }] } }] };
    }
    return { type: "assistant", content: "Parser implemented and item closed.", toolCalls: [] };
  };
  const res = await s.runTurn({});
  expect(res.type).toBe("text");
  expect(res.content).toContain("Parser implemented");
  expect(calls).toBe(4);
  const nudges = s.messages.filter((m) => m.role === "user" && String(m.content).includes("unfinished work detected"));
  expect(nudges.length).toBe(1);
  expect(String(nudges[0].content)).toContain("stale but open item");
});

test("runTurn: a complete-looking final answer is NOT nudged despite stale todos", async () => {
  const s = freshSession();
  s.setTodos([{ content: "old leftover", status: "pending" }]);
  let calls = 0;
  s.getResponse = async () => {
    calls++;
    if (calls === 1) {
      return { type: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", input: { filePath: __filename } }] };
    }
    // Long, closed-out explanation — not a mid-work stop.
    return {
      type: "assistant",
      content: "Here is the full explanation of how the caching layer works, why it was introduced, " +
        "which call sites benefit from it, what the invalidation strategy is, and how the tests cover " +
        "the eviction paths. The answer includes every detail a reviewer would ask about, with references " +
        "to the relevant files and line numbers throughout the discussion.",
      toolCalls: [],
    };
  };
  const res = await s.runTurn({});
  expect(res.type).toBe("text");
  expect(calls).toBe(2);
  const nudges = s.messages.filter((m) => m.role === "user" && String(m.content).includes("unfinished work detected"));
  expect(nudges.length).toBe(0);
  expect(res.openTodos).toBeUndefined();
});

test("runTurn: empty-reply nudges are capped (3 per turn)", async () => {
  const s = freshSession();
  let calls = 0;
  s.getResponse = async () => {
    calls++;
    if (calls <= 3) return { type: "assistant", content: "", toolCalls: [] };
    return { type: "assistant", content: "finally text", toolCalls: [] };
  };
  const res = await s.runTurn({});
  expect(res.type).toBe("text");
  expect(res.content).toBe("finally text");
  expect(calls).toBe(4);
  const nudges = s.messages.filter((m) => m.role === "user" && String(m.content).includes("was empty"));
  expect(nudges.length).toBe(3);
});

test("primary agents: role prompt reaches the system prompt; children are exempt", () => {
  const s = freshSession();
  s.setMode("build");
  expect(s._primaryBlock()).toContain("MAIN ORCHESTRATOR");
  s.setMode("plan");
  expect(s._primaryBlock()).toContain("Plan agent");
  // Child sessions and @agent turns use _agentBlock, never the primary block.
  const child = freshSession();
  child._isChild = true;
  expect(child._primaryBlock()).toBe("");
  const agentTurn = freshSession();
  agentTurn.agent = { id: "explore", name: "Explore", mode: "subagent", tools: ["read"] };
  expect(agentTurn._primaryBlock()).toBe("");
});

test("runTurn: model errors surface as error responses", async () => {
  const s = freshSession();
  s.getResponse = async () => { throw new Error("boom"); };
  const res = await s.runTurn({});
  expect(res.type).toBe("error");
  expect(res.content).toContain("boom");
});

test("_sandboxBlock: empty until sandbox enabled, then routes via docker exec", () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cfg-"));
  const prevCfg = process.env.LOOM_CONFIG_DIR;
  const prevKill = process.env.LOOM_SANDBOX;
  process.env.LOOM_CONFIG_DIR = cfgDir;
  delete process.env.LOOM_SANDBOX;
  try {
    const s = freshSession();
    // Fresh config (no sandbox) → no docker line, no config read of note.
    expect(s._sandboxBlock()).toBe("");
    // Enabled in config → the block names the exact docker exec shape.
    fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ sandbox: { enabled: true } }), "utf8");
    const blk = s._sandboxBlock();
    expect(blk).toContain("docker exec loom-sandbox");
    expect(blk).toContain("/workspace");
    // Kill-switch wins even when enabled.
    process.env.LOOM_SANDBOX = "0";
    expect(s._sandboxBlock()).toBe("");
    process.env.LOOM_SANDBOX = "";
    delete process.env.LOOM_SANDBOX;
    // Non-build modes never get it.
    s.setMode("plan");
    expect(s._sandboxBlock()).toBe("");
    s.setMode("build");
    expect(s._sandboxBlock()).toContain("docker exec loom-sandbox");
  } finally {
    if (prevCfg === undefined) delete process.env.LOOM_CONFIG_DIR;
    else process.env.LOOM_CONFIG_DIR = prevCfg;
    if (prevKill === undefined) delete process.env.LOOM_SANDBOX;
    else process.env.LOOM_SANDBOX = prevKill;
    try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}
  }
});

test("build system prompt documents sandbox routing via docker exec", () => {
  const s = freshSession();
  s.setMode("build");
  expect(s.systemPrompt).toContain("docker exec loom-sandbox");
  expect(s.systemPrompt).toContain("sandbox:true");
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
