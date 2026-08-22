// Unit tests for Anthropic prompt caching in buildBody.
process.env.LOOM_MCP_NO_WARM = "1";
import { test, expect } from "bun:test";
const { buildBody } = require("./anthropic.js");

const MSGS = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi", toolCalls: [{ id: "t1", name: "grep", input: { pattern: "x" } }] },
  { role: "tool", toolCallId: "t1", content: "hit" },
];

test("caching on by default: system becomes a cached content block", () => {
  const body = buildBody(MSGS, { model: "claude-x", system: "You are helpful." });
  expect(Array.isArray(body.system)).toBe(true);
  expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
  expect(body.system[0].text).toBe("You are helpful.");
});

test("caching on by default: last message carries a cache breakpoint", () => {
  const body = buildBody(MSGS, { model: "claude-x", system: "s" });
  const last = body.messages[body.messages.length - 1];
  // last is the tool_result (user role) — its block gains cache_control
  expect(last.content[last.content.length - 1].cache_control).toEqual({ type: "ephemeral" });
});

test("string-content last message converts to a cached text block", () => {
  const body = buildBody([{ role: "user", content: "just text" }], { model: "m" });
  const last = body.messages[body.messages.length - 1];
  expect(Array.isArray(last.content)).toBe(true);
  expect(last.content[0].cache_control).toEqual({ type: "ephemeral" });
  expect(last.content[0].text).toBe("just text");
});

test("options.cache === false opts out entirely", () => {
  const body = buildBody(MSGS, { model: "claude-x", system: "s", cache: false });
  expect(typeof body.system).toBe("string");
  const last = body.messages[body.messages.length - 1];
  expect(Array.isArray(last.content)).toBe(true); // tool_result block, untouched
  expect(last.content[0].cache_control).toBeUndefined();
});
