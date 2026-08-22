// Unit tests for the models.dev registry integration (src/providers/registry.js
// + the merge into src/providers/index.js). Hermetic: a small fixture cache is
// written to LOOM_CONFIG_DIR BEFORE the provider index loads, so no network is
// ever touched and the merged shape is fully deterministic.
// Runs with:  bun test src/providers/registry.test.js
process.env.LOOM_MCP_NO_WARM = "1";
process.env.LOOM_MEM_AUTO = "0";
import { test, expect, afterAll } from "bun:test";
import os from "os";
import fs from "fs";
import path from "path";

const CFG_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-reg-cfg-"));
const PREV_CFG_DIR = process.env.LOOM_CONFIG_DIR;
process.env.LOOM_CONFIG_DIR = CFG_TMP;

const FIXTURE = {
  // openai-compatible, has an `api` base URL and a reasoning model.
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    env: ["DEEPSEEK_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.deepseek.com",
    models: {
      "deepseek-reasoner": {
        id: "deepseek-reasoner", name: "DeepSeek Reasoner", reasoning: true,
        limit: { context: 128000 }, cost: { input: 0.55, output: 2.19 },
      },
      "deepseek-chat": {
        id: "deepseek-chat", name: "DeepSeek Chat", reasoning: false,
        limit: { context: 64000 }, cost: { input: 0.27, output: 1.1 },
      },
    },
  },
  // SDK-based provider: no `api` field, base URL comes from the SDK map.
  mistral: {
    id: "mistral",
    name: "Mistral",
    env: ["MISTRAL_API_KEY"],
    npm: "@ai-sdk/mistral",
    models: {
      "mistral-small-latest": {
        id: "mistral-small-latest", name: "Mistral Small",
        limit: { context: 32000 }, cost: { input: 0.1, output: 0.3 },
      },
    },
  },
  // Empty provider must be listed by loadRegistry but skipped by the merge.
  "no-models": { id: "no-models", name: "Empty", env: ["NOPE_API_KEY"], models: {} },
  // Built-in id with a marker model — the merge must NOT override the builtin.
  openai: {
    id: "openai",
    name: "Fake OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: { "fake-override": { id: "fake-override", name: "Nope", limit: {}, cost: {} } },
  },
};

const fixtureFile = path.join(CFG_TMP, "models-dev.json");
fs.mkdirSync(CFG_TMP, { recursive: true });
fs.writeFileSync(fixtureFile, JSON.stringify(FIXTURE));

const registry = await import("./registry.js");
// Cache-busted import: bun test shares one process, so a plain import would
// return the module providers.test.js loaded (under a different LOOM_CONFIG_DIR
// with no cache). A fresh module load merges THIS fixture's providers.
const index = await import("./index.js?registry-fixture");
const { PROVIDERS, PROVIDER_ORDER, PROVIDER_LABELS, BUILTIN_PROVIDERS, getModelMeta, envNamesFor, ensureRegistry, mergeRegistry } = index;
const { loadRegistry, isRegistryFresh, normalizeProvider } = registry;

afterAll(() => {
  try { fs.rmSync(CFG_TMP, { recursive: true, force: true }); } catch {}
  if (PREV_CFG_DIR === undefined) delete process.env.LOOM_CONFIG_DIR; else process.env.LOOM_CONFIG_DIR = PREV_CFG_DIR;
  delete process.env.DEEPSEEK_API_KEY;
});

const BUILTINS = ["anthropic", "openai", "nvidia", "google", "openrouter", "tokenrouter", "local"];

test("loadRegistry: fixture normalizes models, prices, contexts", () => {
  const reg = loadRegistry();
  expect(reg).toBeTruthy();
  expect(Object.keys(reg)).toHaveLength(4);
  const ds = reg.deepseek;
  expect(ds.name).toBe("DeepSeek");
  expect(ds.baseURL).toBe("https://api.deepseek.com");
  // models sorted by id
  expect(ds.models.map(m => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  const chat = ds.models.find(m => m.id === "deepseek-chat");
  expect(chat.context).toBe(64000);
  expect(chat.priceIn).toBe(0.27);
  expect(chat.priceOut).toBe(1.1);
  expect(chat.tags).toEqual([]);
  const reasoner = ds.models.find(m => m.id === "deepseek-reasoner");
  expect(reasoner.tags).toEqual(["reasoning"]);
  expect(reg.mistral.baseURL).toBeUndefined(); // SDK map applies at merge time
  expect(reg["no-models"].models).toEqual([]);
});

test("merge at load: builtins first, registry alphabetical, empties skipped, builtins win", () => {
  expect(BUILTIN_PROVIDERS).toEqual(BUILTINS);
  expect(PROVIDER_ORDER.slice(0, 7)).toEqual(BUILTINS);
  expect(PROVIDER_ORDER.slice(7)).toEqual(["deepseek", "mistral"]); // no-models skipped
  expect(PROVIDER_LABELS.openai).toBe("OpenAI (GPT)"); // builtin label kept
  expect(PROVIDER_LABELS.deepseek).toBe("DeepSeek");
  // Builtin provider untouched by the fake override entry.
  expect(PROVIDERS.openai.models.some(m => m.id === "fake-override")).toBe(false);
});

test("dynamic provider: chat/stream functions + real model list", () => {
  const ds = PROVIDERS.deepseek;
  expect(typeof ds.chat).toBe("function");
  expect(typeof ds.stream).toBe("function");
  expect(ds.models.map(m => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  expect(getModelMeta("deepseek", "deepseek-reasoner").context).toBe(128000);
  expect(getModelMeta("deepseek", "nope")).toBeNull();
  const mistral = PROVIDERS.mistral;
  expect(typeof mistral.stream).toBe("function");
  expect(mistral.models).toHaveLength(1);
});

test("envNamesFor: builtin legacy names, registry env names, unknown fallback", () => {
  expect(envNamesFor("openai")).toEqual(["OPENAI_API_KEY"]);
  expect(envNamesFor("anthropic")).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]);
  expect(envNamesFor("deepseek")).toEqual(["DEEPSEEK_API_KEY"]);
  expect(envNamesFor("made-up-provider")).toEqual(["MADE-UP-PROVIDER_API_KEY"]);
});

test("hasApiKey/getApiKey: registry env vars are honored", () => {
  const { getApiKey, hasApiKey } = require("../config/settings.js");
  expect(hasApiKey("deepseek")).toBe(false);
  process.env.DEEPSEEK_API_KEY = "dk-test-123";
  expect(hasApiKey("deepseek")).toBe(true);
  expect(getApiKey("deepseek")).toBe("dk-test-123");
  delete process.env.DEEPSEEK_API_KEY;
});

test("ensureRegistry: fresh cache merges without a fetch", async () => {
  const { invalidateRegistryCache } = require("./registry.js");
  expect(isRegistryFresh()).toBe(true);
  expect(await ensureRegistry(false)).toBe(0); // fixture already merged at load
  expect(mergeRegistry()).toBe(0); // second merge adds nothing
  // A provider added to the cache later is picked up by the next fresh merge.
  const reg = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
  reg["sambanova"] = {
    id: "sambanova", name: "SambaNova", env: ["SAMBANOVA_API_KEY"],
    npm: "@ai-sdk/openai-compatible", api: "https://api.sambanova.ai/v1",
    models: { "samba-1": { id: "samba-1", name: "Samba 1", limit: { context: 8000 }, cost: { input: 0.1, output: 0.2 } } },
  };
  fs.writeFileSync(fixtureFile, JSON.stringify(reg));
  // loadRegistry memoizes on file mtime — a same-millisecond rewrite on NTFS
  // can return the same mtimeMs and serve the stale memo, so invalidate before
  // merging (mirrors what fetchRegistry does after writing a fresh cache).
  invalidateRegistryCache();
  expect(await ensureRegistry(false)).toBe(1);
  expect(PROVIDERS.sambanova.models[0].id).toBe("samba-1");
  expect(PROVIDER_ORDER).toContain("sambanova");
});

test("normalizeProvider: bare input gets sane defaults", () => {
  const p = normalizeProvider("x", { name: "X", models: {} });
  expect(p.env).toEqual(["X_API_KEY"]);
  expect(p.models).toEqual([]);
});