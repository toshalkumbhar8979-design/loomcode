// Unit tests for the agent registry + delegation runner (src/core/agents.js).
// Runs with:  bun test src/core/agents.test.js
process.env.LOOM_MCP_NO_WARM = "1";
process.env.LOOM_MEM_AUTO = "0";
import { test, expect, beforeAll, afterAll } from "bun:test";
import os from "os";
import fs from "fs";
import path from "path";

const CFG_TMP = path.join(os.tmpdir(), "loom-agents-cfg-" + process.pid + "-" + Date.now());
process.env.LOOM_CONFIG_DIR = CFG_TMP;

let agents, Session;

beforeAll(() => {
  agents = require("./agents.js");
  Session = require("./session.js").Session;
});

afterAll(() => {
  try { fs.rmSync(CFG_TMP, { recursive: true, force: true }); } catch {}
  delete process.env.LOOM_CONFIG_DIR;
});

test("registry: built-in primaries and subagents with tool filters", () => {
  const all = agents.loadAgents();
  expect(all.build.mode).toBe("primary");
  expect(all.plan.mode).toBe("primary");
  expect(all.chat.mode).toBe("primary");
  expect(all.general.mode).toBe("subagent");
  expect(all.explore.mode).toBe("subagent");
  expect(all.scout.mode).toBe("subagent");
  // subagent defaults: everything except delegation (no recursion)
  expect(all.general.tools).toContain("!task");
  expect(all.explore.tools).toEqual(["read", "glob", "grep", "webfetch", "todowrite"]);
});

test("tool patterns: last-match-wins with wildcards and denies", () => {
  const { agentToolAllowed } = agents;
  // ['*','!task'] → everything but task
  const general = agents.resolveAgent("general");
  expect(agentToolAllowed(general, "bash")).toBe(true);
  expect(agentToolAllowed(general, "read")).toBe(true);
  expect(agentToolAllowed(general, "task")).toBe(false);
  // explicit list → only those
  const explore = agents.resolveAgent("explore");
  expect(agentToolAllowed(explore, "read")).toBe(true);
  expect(agentToolAllowed(explore, "grep")).toBe(true);
  expect(agentToolAllowed(explore, "bash")).toBe(false);
  expect(agentToolAllowed(explore, "write")).toBe(false);
  expect(agentToolAllowed(explore, "task")).toBe(false); // subagents never delegate
  // wildcard mcp denial
  const noMcp = { id: "x", mode: "subagent", tools: ["*", "!mcp__*"] };
  expect(agentToolAllowed(noMcp, "mcp__files__read")).toBe(false);
  expect(agentToolAllowed(noMcp, "bash")).toBe(true);
  // no tools list → everything
  expect(agentToolAllowed({ id: "open", mode: "subagent", tools: null }, "bash")).toBe(true);
  // empty list → also no restriction (same as null; mode gating covers chat)
  expect(agentToolAllowed({ id: "open2", mode: "subagent", tools: [] }, "bash")).toBe(true);
});

test("filterToolDefs: schema list is filtered per agent", async () => {
  const { getToolDefinitions } = require("../tools");
  const all = await getToolDefinitions("build");
  expect(all.length).toBeGreaterThan(5);
  const explore = agents.resolveAgent("explore");
  const filtered = agents.filterToolDefs(explore, all);
  const names = filtered.map((d) => d.name).sort();
  expect(names).toEqual(["glob", "grep", "read", "todowrite", "webfetch"]);
  const general = agents.resolveAgent("general");
  const gNames = agents.filterToolDefs(general, all).map((d) => d.name);
  expect(gNames).toContain("bash");
  expect(gNames).not.toContain("task");
});

test("config merge: custom agents, overrides and disable", () => {
  const cfgDir = path.join(CFG_TMP, "merge");
  fs.mkdirSync(cfgDir, { recursive: true });
  process.env.LOOM_CONFIG_DIR = cfgDir;
  try {
    fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({
      agents: {
        explore: { disable: true },
        general: { model: "openai/gpt-5-fast", temperature: 0.1 },
        "code-reviewer": { mode: "subagent", description: "Reviews code without edits", tools: ["read", "glob", "grep", "bash"] },
      },
    }), "utf8");
    const all = agents.loadAgents();
    expect(all.explore).toBeUndefined();
    expect(all.general.model).toBe("openai/gpt-5-fast");
    expect(all.general.temperature).toBe(0.1);
    expect(all["code-reviewer"].mode).toBe("subagent");
    expect(all["code-reviewer"].tools).toEqual(["read", "glob", "grep", "bash"]);
    expect(agents.agentToolAllowed(all["code-reviewer"], "write")).toBe(false);
    expect(agents.agentToolAllowed(all["code-reviewer"], "read")).toBe(true);
  } finally {
    delete process.env.LOOM_CONFIG_DIR;
  }
});

test("runSubagent: unknown id and primary id produce errors", async () => {
  const bad = await agents.runSubagent({ agentId: "zzz", prompt: "x" });
  expect(bad.error).toContain("Unknown agent");
  const primary = await agents.runSubagent({ agentId: "build", prompt: "x" });
  expect(primary.error).toContain("primary agent");
  const noPrompt = await agents.runSubagent({ agentId: "explore" });
  expect(noPrompt.error).toContain("non-empty prompt");
});

test("runSubagent: child session runs the delegated prompt with agent gating and streams progress", async () => {
  const origRunTurn = Session.prototype.runTurn;
  let captured = null;
  Session.prototype.runTurn = async function (callbacks) {
    captured = { agent: this.agent, block: this._agentBlock };
    if (callbacks.onDelta) callbacks.onDelta("delta text");
    if (callbacks.onReasoning) callbacks.onReasoning("reasoning text");
    if (callbacks.onTool) callbacks.onTool("grep", { pattern: "x" });
    if (callbacks.onToolResult) callbacks.onToolResult("grep", { result: "hit" });
    this.tokensIn = 40;
    this.tokensOut = 10;
    this.tokensUsed = 50;
    this.sessionCost = 0.002;
    return { type: "text", content: "subagent answer" };
  };
  try {
    const parent = new Session();
    parent.tokensIn = 100; parent.tokensOut = 100; parent.tokensUsed = 200; parent.sessionCost = 0.01;
    const progress = [];
    const res = await agents.runSubagent({
      agentId: "explore",
      prompt: "find the bug",
      parentSession: parent,
      onProgress: (ev) => progress.push(ev),
    });
    expect(res.error).toBeUndefined();
    expect(res.content).toBe("subagent answer");
    expect(res.tokensIn).toBe(40);
    expect(res.costUsd).toBe(0.002);
    // usage flows into the parent
    expect(parent.tokensIn).toBe(140);
    expect(parent.tokensOut).toBe(110);
    expect(parent.tokensUsed).toBe(250);
    expect(parent.sessionCost).toBe(0.012);
    // child ran as the explore agent with its system block
    expect(captured.agent.id).toBe("explore");
    expect(captured.agent.mode).toBe("subagent");
    expect(captured.block).toContain("Explore");
    expect(captured.block).toContain("delegated");
    // progress events: status + streamed deltas + tools
    const types = progress.map((p) => p.type);
  expect(types).toContain("status");
  expect(types).toContain("delta");
  expect(types).toContain("tool");
  expect(progress[0].type).toBe("status");
  expect(progress[progress.length - 1].type).toBe("status");
  // delegation is not recursive: the explore agent cannot call task
  expect(agents.agentToolAllowed(captured.agent, "task")).toBe(false);
  } finally {
    Session.prototype.runTurn = origRunTurn;
  }
});

test("session: agent turn (opts.agentId) scopes tools, blocks disallowed calls, and restores after", async () => {
  const s = new Session();
  let asks = 0;
  let calls = 0;
  s.getResponse = async () => {
    calls++;
    if (calls === 1) {
      return { type: "assistant", content: "", toolCalls: [
        { id: "t1", name: "bash", input: { command: "echo hi" } },
      ] };
    }
    return { type: "assistant", content: "explored", toolCalls: [] };
  };
  const res = await s.sendUserMessage("find the bug", {
    onPermissionRequest: async () => { asks++; return true; },
  }, { agentId: "explore" });
  expect(res.content).toBe("explored");
  // bash is NOT in explore's list → never asked, blocked by the agent gate
  expect(asks).toBe(0);
  const toolMsg = s.messages.find((m) => m.role === "tool");
  expect(String(toolMsg.content)).toContain("not available to the Explore agent");
  // agent scope restored after the turn
  expect(s.agent).toBeNull();
  expect(s._agentBlock).toBeNull();
});
