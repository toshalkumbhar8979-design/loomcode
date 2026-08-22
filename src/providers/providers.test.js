// Unit tests for the provider layer: registry shape, message formatting,
// retry/backoff, and error wrapping. Never touches the network.
// Runs with:  bun test src/providers/providers.test.js
process.env.LOOM_MCP_NO_WARM = "1";
process.env.LOOM_MEM_AUTO = "0";
import { test, expect, beforeAll, afterAll } from "bun:test";
import os from "os";
import fs from "fs";
import path from "path";

const USAGE_TMP = path.join(os.tmpdir(), "loom-prov-" + process.pid + "-" + Date.now() + ".json");
process.env.LOOM_USAGE_FILE = USAGE_TMP;

// Hermetic config dir: the index must load with ONLY the 7 built-in providers
// (no models.dev cache), so the count assertions stay deterministic.
const CFG_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-prov-cfg-"));
process.env.LOOM_CONFIG_DIR = CFG_TMP;

let PROVIDERS, PROVIDER_ORDER, getModelMeta, ProviderRouter;
let anthropic, openaiCompat;

beforeAll(() => {
  ({ PROVIDERS, PROVIDER_ORDER, getModelMeta, ProviderRouter } = require("./index.js"));
  anthropic = require("./anthropic.js");
  openaiCompat = require("./openai-compat.js");
});

afterAll(() => {
  try { fs.rmSync(USAGE_TMP, { force: true }); } catch {}
  try { fs.rmSync(CFG_TMP, { recursive: true, force: true }); } catch {}
});

const SONNET = "claude-sonnet-4-20250514";

test("registry: 7 providers, each with chat/stream/models", () => {
  expect(Object.keys(PROVIDERS)).toHaveLength(7);
  for (const name of PROVIDER_ORDER) {
    const p = PROVIDERS[name];
    expect(typeof p.chat, name + ".chat").toBe("function");
    expect(typeof p.stream, name + ".stream").toBe("function");
    expect(Array.isArray(p.models), name + ".models").toBe(true);
    expect(p.models.length).toBeGreaterThan(0);
  }
});

test("registry: every model has an id, name, context and prices", () => {
  for (const name of PROVIDER_ORDER) {
    for (const m of PROVIDERS[name].models) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.name).toBe("string");
      expect(typeof m.context).toBe("number");
      expect(typeof m.priceIn).toBe("number");
      expect(typeof m.priceOut).toBe("number");
    }
  }
});

test("getModelMeta: finds by id, null for unknown", () => {
  const meta = getModelMeta("anthropic", SONNET);
  expect(meta).toBeTruthy();
  expect(meta.context).toBe(200000);
  expect(meta.priceIn).toBe(3);
  expect(getModelMeta("anthropic", "does-not-exist")).toBeNull();
  expect(getModelMeta(null, SONNET)).toBeNull();
  expect(getModelMeta("anthropic", null)).toBeNull();
});

test("ProviderRouter: init/use activate providers, unknown throws", () => {
  const r = new ProviderRouter();
  expect(() => r.init("nope")).toThrow(/Unknown provider/);
  expect(r.use("nope")).toBeNull();
  const active = r.use("anthropic");
  expect(active.name).toBe("anthropic");
  expect(r.getModels("openai").length).toBeGreaterThan(0);
});

// ─── Anthropic message builder (pure) ───
test("anthropic buildBody: system prompt + history, tool blocks", () => {
  const body = anthropic.buildBody(
    [
      { role: "system", content: "from history" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", toolCalls: [{ id: "t1", name: "read", input: { filePath: "a.ts" } }] },
      { role: "tool", toolCallId: "t1", content: "file contents" },
    ],
    { system: "system prompt", model: SONNET, maxTokens: 1000, temperature: 0.5 }
  );
  expect(body.model).toBe(SONNET);
  expect(body.max_tokens).toBe(1000);
  expect(body.temperature).toBe(0.5);
  // system is a cached content block array by default — flatten for asserts
  const sys = Array.isArray(body.system) ? body.system.map((b) => b.text).join("\n\n") : body.system;
  expect(sys).toContain("system prompt");
  expect(sys).toContain("from history");
  expect(body.messages).toHaveLength(3);
  // tool call -> tool_use block
  expect(body.messages[1].role).toBe("assistant");
  expect(body.messages[1].content[1]).toEqual({ type: "tool_use", id: "t1", name: "read", input: { filePath: "a.ts" } });
  // tool result -> tool_result with the call id; it is ALSO the last message,
  // so prompt caching stamps a breakpoint on it
  expect(body.messages[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "file contents", cache_control: { type: "ephemeral" } });
});

test("anthropic buildBody: temperature omitted when undefined, tools mapped", () => {
  const body = anthropic.buildBody([{ role: "user", content: "x" }], { model: SONNET });
  expect(body.temperature).toBeUndefined();
  const withTools = anthropic.buildBody(
    [{ role: "user", content: "x" }],
    { model: SONNET, tools: [{ name: "read", description: "d", input_schema: { type: "object" } }] }
  );
  expect(withTools.tools[0].name).toBe("read");
  expect(withTools.tools[0].input_schema).toEqual({ type: "object" });
});

test("anthropic buildBody: extended thinking enabled for reasoning models", () => {
  const body = anthropic.buildBody([{ role: "user", content: "x" }], {
    model: SONNET,
    reasoning: true,
    maxTokens: 8192,
    temperature: 0.7,
  });
  expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  // Extended thinking requires temperature unset.
  expect(body.temperature).toBeUndefined();
  // Budget stays below max_tokens so output tokens remain.
  expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
  // No thinking block without the flag.
  const plain = anthropic.buildBody([{ role: "user", content: "x" }], { model: SONNET });
  expect(plain.thinking).toBeUndefined();
});

test("openai-compat buildRequest: reasoning effort high for o-series", () => {
  const build = openaiCompat.buildRequest;
  const o = build([{ role: "user", content: "x" }], { model: "o3-mini", reasoning: true });
  expect(o.reasoning_effort).toBe("high");
  expect(o.temperature).toBeUndefined();
  // Non-effort reasoning models (DeepSeek R1) don't get the param.
  const r1 = build([{ role: "user", content: "x" }], { model: "deepseek-reasoner", reasoning: true });
  expect(r1.reasoning_effort).toBeUndefined();
  expect(r1.temperature).toBe(0.7);
  // Without the flag, no effort.
  const plain = build([{ role: "user", content: "x" }], { model: "o3-mini" });
  expect(plain.reasoning_effort).toBeUndefined();
});

test("anthropic normalizeBlocks: text + tool_use, ignores unknown", () => {
  const { content, toolCalls } = anthropic.normalizeBlocks([
    { type: "text", text: "one" },
    { type: "tool_use", id: "x1", name: "bash", input: { command: "ls" } },
    { type: "text", text: "two" },
    { type: "weird", something: true },
  ]);
  expect(content).toBe("onetwo");
  expect(toolCalls).toEqual([{ id: "x1", name: "bash", input: { command: "ls" } }]);
});

// ─── OpenAI-compat message builder (pure) ───
test("formatMessages: system first, tool/assistant calls mapped", () => {
  const msgs = openaiCompat.formatMessages(
    [
      { role: "system", content: "skip me" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a", toolCalls: [{ id: "t1", name: "read", input: { filePath: "x.ts" } }] },
      { role: "tool", toolCallId: "t1", content: "result" },
    ],
    { system: "SYSTEM" }
  );
  expect(msgs[0]).toEqual({ role: "system", content: "SYSTEM" });
  expect(msgs[1]).toEqual({ role: "user", content: "u" });
  expect(msgs[2].role).toBe("assistant");
  expect(msgs[2].tool_calls[0].function).toEqual({ name: "read", arguments: JSON.stringify({ filePath: "x.ts" }) });
  expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "result" });
});

test("parseToolCalls: valid args parsed, invalid args become {}", () => {
  const out = openaiCompat.parseToolCalls({
    tool_calls: [
      { id: "1", function: { name: "read", arguments: '{"filePath":"a"}' } },
      { id: "2", function: { name: "edit", arguments: "not json" } },
    ],
  });
  expect(out[0]).toEqual({ id: "1", name: "read", input: { filePath: "a" } });
  expect(out[1]).toEqual({ id: "2", name: "edit", input: {} });
});

test("formatTools: undefined when empty, maps input_schema", () => {
  expect(openaiCompat.formatTools([])).toBeUndefined();
  expect(openaiCompat.formatTools(null)).toBeUndefined();
  const out = openaiCompat.formatTools([{ name: "read", description: "d", input_schema: { type: "object", properties: {} } }]);
  expect(out[0].type).toBe("function");
  expect(out[0].function.name).toBe("read");
});

test("normalize: content, toolCalls and usage extracted", () => {
  const resp = openaiCompat.normalize({
    choices: [{ message: { content: "hi", tool_calls: [{ id: "1", function: { name: "read", arguments: "{}" } }] } }],
    usage: { total_tokens: 5 },
  });
  expect(resp.content).toBe("hi");
  expect(resp.toolCalls).toHaveLength(1);
  expect(resp.usage.total_tokens).toBe(5);
});

test("retryWithBackoff: retries 429/503/502, throws others immediately", async () => {
  let attempts = 0;
  const flaky = async () => {
    attempts++;
    if (attempts < 3) { const e = new Error("rate limited"); e.status = 429; throw e; }
    return "ok";
  };
  const res = await openaiCompat.retryWithBackoff(flaky, 4, "test");
  expect(res).toBe("ok");
  expect(attempts).toBe(3);

  let bad = 0;
  const hard = async () => { bad++; const e = new Error("server error"); e.status = 500; throw e; };
  await expect(openaiCompat.retryWithBackoff(hard, 4, "test")).rejects.toThrow("server error");
  expect(bad).toBe(1); // 500 is not retried
});

test("retryWithBackoff: abort errors are never retried", async () => {
  let calls = 0;
  const fn = async () => { calls++; const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  await expect(openaiCompat.retryWithBackoff(fn, 4, "test")).rejects.toThrow("aborted");
  expect(calls).toBe(1);
});

test("wrapErr: friendly 401/403/402 messages, status passthrough", () => {
  const e401 = openaiCompat.wrapErr({ status: 401, message: "invalid" }, "m1", "OpenAI", "http://x");
  expect(e401.message).toContain("401");
  expect(e401.message).toContain("key is invalid");
  const e403 = openaiCompat.wrapErr({ status: 403, message: "no" }, "m1", "OpenAI", "http://x");
  expect(e403.message).toContain("not authorized");
  const e402 = openaiCompat.wrapErr({ status: 402, message: "billing" }, "m1", "OpenAI", "http://x");
  expect(e402.message).toContain("quota");
  const e500 = openaiCompat.wrapErr({ status: 500, message: "boom" }, "m1", "OpenAI", "http://x");
  expect(e500.message).toContain("500");
  const eBody = openaiCompat.wrapErr({ status: 400, error: { message: "bad request body" } }, "m1", "OpenAI", "http://x");
  expect(eBody.message).toContain("bad request body");
});

function streamingClient() {
  return {
    chat: {
      completions: {
        create: async () => ({
          [Symbol.asyncIterator]: async function* () {
            yield { choices: [{ delta: { content: "Hel" } }], usage: null };
            yield { choices: [{ delta: { content: "lo" } }] };
            yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"fileP' } }] } }] };
            yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ath": "x"}' } }] } }] };
            yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
          },
        }),
      },
    },
  };
}

test("stream: accumulates content, tool calls and usage across deltas", async () => {
  const p = openaiCompat.createOpenAICompatProvider({ getKey: () => "k", providerId: "openai", envKeyHint: "OPENAI", clientFactory: streamingClient });
  const deltas = [];
  const res = await p.stream([{ role: "user", content: "hi" }], { model: "gpt-5" }, (t) => deltas.push(t));
  expect(res.content).toBe("Hello");
  expect(deltas).toEqual(["Hel", "lo"]);
  expect(res.toolCalls).toEqual([{ id: "call_1", name: "read", input: { filePath: "x" } }]);
  expect(res.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
});

test("stream: works for every openai-compat provider factory", async () => {
  for (const id of ["openai", "nvidia", "google", "openrouter", "tokenrouter", "local"]) {
    const p = openaiCompat.createOpenAICompatProvider({ getKey: () => "k", providerId: id, envKeyHint: id.toUpperCase(), clientFactory: streamingClient });
    const res = await p.stream([{ role: "user", content: "hi" }], { model: "x" });
    expect(res.content).toBe("Hello");
    expect(res.toolCalls).toHaveLength(1);
    expect(p.models).toEqual([]);
  }
});

test("chat: non-streaming response normalized (content, tool calls, usage)", async () => {
  const client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: "done", tool_calls: [{ id: "t1", function: { name: "read", arguments: "{\"filePath\": \"a\"}" } }] } }],
          usage: { total_tokens: 7 },
        }),
      },
    },
  };
  const p = openaiCompat.createOpenAICompatProvider({ getKey: () => "k", providerId: "openai", envKeyHint: "OPENAI", clientFactory: () => client });
  const res = await p.chat([{ role: "user", content: "hi" }], { model: "gpt-5" });
  expect(res.content).toBe("done");
  expect(res.toolCalls[0].input.filePath).toBe("a");
  expect(res.usage.total_tokens).toBe(7);
});

test("stream: 429 then success is retried and succeeds", async () => {
  let calls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          if (calls === 1) { const e = new Error("rate limited"); e.status = 429; throw e; }
          return { [Symbol.asyncIterator]: async function* () { yield { choices: [{ delta: { content: "ok" } }] }; } };
        },
      },
    },
  };
  const p = openaiCompat.createOpenAICompatProvider({ getKey: () => "k", providerId: "openai", envKeyHint: "OPENAI", clientFactory: () => client });
  const res = await p.stream([{ role: "user", content: "hi" }], { model: "gpt-5" });
  expect(calls).toBe(2);
  expect(res.content).toBe("ok");
});

test("stream: provider errors surface wrapped messages", async () => {
  const client = {
    chat: {
      completions: {
        create: async () => { const e = new Error("nope"); e.status = 401; throw e; },
      },
    },
  };
  const p = openaiCompat.createOpenAICompatProvider({ getKey: () => "k", providerId: "openai", envKeyHint: "OPENAI", clientFactory: () => client });
  await expect(p.stream([{ role: "user", content: "hi" }], { model: "gpt-5" })).rejects.toThrow("401");
});
