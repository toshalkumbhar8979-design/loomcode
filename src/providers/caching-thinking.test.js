process.env.LOOM_MCP_NO_WARM = "1";
import { test, expect } from "bun:test";
const { buildBody } = require("./anthropic.js");
test("cache breakpoint skips thinking blocks (API 400s on thinking cache_control)", () => {
  const body = buildBody([
    { role: "user", content: "go" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "hmm", signature: "sig" },
      { type: "text", text: "partial" },
    ], toolCalls: [{ id: "t9", name: "read", input: { filePath: "x" } }] },
  ], { model: "claude-x", system: "s" });
  const last = body.messages[body.messages.length - 1];
  const stamped = last.content.filter((b) => b.cache_control);
  expect(stamped.length).toBe(1);
  expect(stamped[0].type).not.toBe("thinking");
});
