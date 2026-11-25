// Unit tests for the auth vault, provider metadata, and the ChatGPT Codex
// adapter. Hermetic: every test gets its own LOOM_CONFIG_DIR and the vault key
// is a fixed passphrase, so nothing touches the real ~/.loom directory.
// Runs with:  bun test src/auth/auth.test.js
process.env.LOOM_MCP_NO_WARM = "1";
process.env.LOOM_MEM_AUTO = "0";
import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs = [];
let store;
let auth;
let oauth;
let providers;
let settings;
let codex;
let originalFetch = globalThis.fetch;

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-auth-"));
  dirs.push(dir);
  process.env.LOOM_CONFIG_DIR = dir;
  process.env.LOOM_AUTH_NO_DPAPI = "1";
  delete process.env.LOOM_AUTH_DISABLE_KEYRING;
  return dir;
}

beforeEach(() => {
  freshDir();
  delete process.env.LOOM_AUTH_KEY;
  delete process.env.LOOM_GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.LOOM_GOOGLE_OAUTH_CLIENT_SECRET;
  store = require("./store");
  auth = require("./index");
  oauth = require("./oauth");
  providers = require("./providers");
  settings = require("../config/settings");
  codex = require("../providers/codex");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LOOM_AUTH_KEY;
});

afterAll(() => {
  delete process.env.LOOM_CONFIG_DIR;
  delete process.env.LOOM_AUTH_NO_DPAPI;
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("saves and reads an API credential through the encrypted vault", () => {
  const secret = "sk-test-super-secret-value";
  const saved = store.saveCredential("opencode", {
    type: "api",
    method: "api",
    apiKey: secret,
    label: "OpenCode API key",
  });
  expect(saved.fingerprint).toBeTruthy();
  expect(saved.fingerprint).not.toContain(secret);

  const raw = fs.readFileSync(path.join(process.env.LOOM_CONFIG_DIR, "auth.json"), "utf8");
  expect(raw).not.toContain(secret);
  expect(JSON.parse(raw).data.ciphertext).toBeTruthy();

  expect(store.getApiKeyCredential("opencode")).toBe(secret);
  expect(settings.getApiKey("opencode")).toBe(secret);
  expect(auth.hasAuth("opencode")).toBe(true);
  expect(auth.authMethod("opencode")).toBe("api");
  expect(auth.getApiKey("opencode")).toBe(secret);

  const listed = store.listCredentials();
  expect(listed).toHaveLength(1);
  expect(listed[0].provider).toBe("opencode");
  expect(listed[0].hasApiKey).toBe(true);
  expect(listed[0].apiKey).toBeUndefined();
});

test("stores a Google OAuth client encrypted and keeps it out of auth list", () => {
  const clientId = "1234567890-abcdef.apps.googleusercontent.com";
  const secret = "google-oauth-client-secret";
  oauth.saveGoogleClient(clientId, secret);

  expect(oauth.googleOAuthConfigured()).toBe(true);
  expect(oauth.getGoogleClient()).toEqual({ clientId, clientSecret: secret });
  expect(store.listCredentials()).toHaveLength(0);

  const raw = fs.readFileSync(path.join(process.env.LOOM_CONFIG_DIR, "auth.json"), "utf8");
  expect(raw).not.toContain(secret);
});

test("replaces stale OAuth secrets when switching to an API key", () => {
  store.saveCredential("openai", {
    type: "oauth",
    method: "chatgpt",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600_000,
    accountId: "acct_1",
  });
  expect(auth.isChatGPT("openai")).toBe(true);

  const saved = store.saveCredential("openai", {
    type: "api",
    method: "api",
    apiKey: "sk-new",
    label: "OpenAI API key",
  });
  expect(saved.accessToken).toBeUndefined();
  expect(saved.refreshToken).toBeUndefined();
  expect(saved.accountId).toBeUndefined();
  expect(auth.isChatGPT("openai")).toBe(false);
  expect(auth.getApiKey("openai")).toBe("sk-new");
});

test("deletes credentials and supports logout --all", () => {
  store.saveCredential("opencode", { type: "api", method: "api", apiKey: "a" });
  store.saveCredential("openrouter", { type: "api", method: "oauth", apiKey: "b" });
  expect(store.listCredentials()).toHaveLength(2);
  expect(store.deleteCredential("opencode")).toBe(true);
  expect(store.deleteCredential("opencode")).toBe(false);
  expect(store.deleteAllCredentials()).toBe(1);
  expect(store.listCredentials()).toHaveLength(0);
});

test("logout --all can reset a corrupt vault", () => {
  store.saveCredential("opencode", { type: "api", method: "api", apiKey: "stale" });
  fs.writeFileSync(path.join(process.env.LOOM_CONFIG_DIR, "auth.json"), "{not json");
  expect(() => store.listCredentials()).toThrow(/corrupt/i);
  expect(store.deleteAllCredentials()).toBe(0);
  expect(store.listCredentials()).toHaveLength(0);
});

test("LOOM_AUTH_KEY passphrase protects the vault", () => {
  process.env.LOOM_AUTH_KEY = "correct horse battery staple";
  store.saveCredential("opencode", { type: "api", method: "api", apiKey: "vaulted" });
  expect(store.getApiKeyCredential("opencode")).toBe("vaulted");
  expect(fs.existsSync(path.join(process.env.LOOM_CONFIG_DIR, "auth.key"))).toBe(false);

  process.env.LOOM_AUTH_KEY = "wrong passphrase";
  expect(() => store.getCredential("opencode")).toThrow(/could not be decrypted/i);
  expect(store.getApiKeyCredential("opencode")).toBeNull();
});

test("provider menu is stable and aliases normalize", () => {
  expect(providers.getMenuProviders().map((p) => p.id)).toEqual([
    "opencode", "openai", "github-copilot", "google", "anthropic", "openrouter", "vercel",
  ]);
  expect(providers.normalizeProviderId("ChatGPT")).toBe("openai");
  expect(providers.normalizeProviderId("claude")).toBe("anthropic");
  expect(providers.normalizeProviderId("gemini")).toBe("google");
  expect(providers.normalizeProviderId("copilot")).toBe("github-copilot");
});

test("npm Bun entry point routes auth to the CLI, not the TUI", () => {
  const root = path.join(__dirname, "..", "..");
  const result = Bun.spawnSync(
    [process.execPath, path.join(root, "bin", "loom-bun.js"), "auth", "providers"],
    { cwd: root, env: { ...process.env }, stdout: "pipe", stderr: "pipe" }
  );
  const out = result.stdout.toString();
  expect(result.exitCode).toBe(0);
  expect(out).toContain("OpenCode (opencode)");
  expect(out).not.toContain("Loom Code");
});

test("OAuth refresh timing and provider headers", () => {
  const now = Date.now();
  expect(auth.needsRefresh({ type: "oauth", expiresAt: now + 3600_000 })).toBe(false);
  expect(auth.needsRefresh({ type: "oauth", expiresAt: now + 1000 })).toBe(true);
  expect(auth.needsRefresh({ type: "api" })).toBe(false);

  store.saveCredential("anthropic", {
    type: "oauth",
    method: "oauth",
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: now + 3600_000,
  });
  const headers = auth.headersFor("anthropic");
  expect(headers.Authorization).toBe("Bearer at");
  expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
});

test("Codex request conversion matches the Responses API shape", () => {
  const req = codex.buildRequest([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", toolCalls: [{ id: "call_1", name: "lookup", input: { q: 1 } }] },
    { role: "tool", toolCallId: "call_1", content: "result" },
  ], {
    model: "gpt-5.5",
    system: "system prompt",
    tools: [{ name: "lookup", description: "look up", input_schema: { type: "object" } }],
    maxTokens: 128,
    reasoning: true,
  });

  expect(req.model).toBe("gpt-5.5");
  expect(req.instructions).toBe("system prompt");
  expect(req.store).toBe(false);
  expect(req.stream).toBe(true);
  expect(req.max_output_tokens).toBe(128);
  expect(req.reasoning).toEqual({ effort: "high", summary: "auto" });
  expect(req.tools[0]).toMatchObject({ type: "function", name: "lookup", strict: false });
  expect(req.input[0]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] });
  expect(req.input[1].type).toBe("message");
  expect(req.input[1].content[0].type).toBe("output_text");
  expect(req.input[2]).toEqual({ type: "function_call", call_id: "call_1", name: "lookup", arguments: JSON.stringify({ q: 1 }) });
  expect(req.input[3]).toEqual({ type: "function_call_output", call_id: "call_1", output: "result" });
});

test("Codex streams text and tool calls from SSE events", async () => {
  store.saveCredential("openai", {
    type: "oauth",
    method: "chatgpt",
    accessToken: "codex-access",
    refreshToken: "codex-refresh",
    expiresAt: Date.now() + 3600_000,
    accountId: "acct_123",
  });

  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    const body = [
      'data: {"type":"response.output_text.delta","delta":"Hel"}',
      "",
      'data: {"type":"response.output_text.delta","delta":"lo"}',
      "",
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_9","name":"lookup","arguments":"{\\"q\\":2}"}}',
      "",
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}}',
      "",
    ].join("\n");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const deltas = [];
  const out = await codex.stream([{ role: "user", content: "hi" }], { model: "gpt-5.5" }, (d) => deltas.push(d));

  expect(seen.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(seen.init.headers.Authorization).toBe("Bearer codex-access");
  expect(seen.init.headers["chatgpt-account-id"]).toBe("acct_123");
  expect(seen.init.headers["OpenAI-Beta"]).toBe("responses=experimental");
  expect(deltas.join("")).toBe("Hello");
  expect(out.content).toBe("Hello");
  expect(out.toolCalls).toEqual([{ id: "call_9", name: "lookup", input: { q: 2 } }]);
  expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });
  expect(out.finishReason).toBe("tool_calls");
});
