// Unit tests for the MCP server manager (src/mcp/mcp-manager.js).
// Runs with:  bun test src/mcp/mcp-manager.test.js
process.env.LOOM_MEM_AUTO = "0";
import { test, expect, beforeEach, afterAll } from "bun:test";
import os from "os";
import fs from "fs";
import path from "path";

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mcp-cfg-"));
beforeEach(() => {
  process.env.LOOM_CONFIG_DIR = cfgDir;
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(cfgDir, { recursive: true });
});
afterAll(() => {
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}
  delete process.env.LOOM_CONFIG_DIR;
});

const mgr = await import("./mcp-manager.js");
const plugin = await import("../core/plugin-cmd.js");

function parse(argv) {
  return mgr.parseMcpAddArgs(argv);
}

test("tokenizeCli keeps quoted paths with spaces intact", () => {
  const r = plugin.tokenizeCli('add stm32 -- "C:\\stm32-mcp\\.venv\\Scripts\\python.exe" -m stm32_mcp.server');
  expect(r).toEqual(["add", "stm32", "--", "C:\\stm32-mcp\\.venv\\Scripts\\python.exe", "-m", "stm32_mcp.server"]);
  expect(plugin.tokenizeCli("  a   b  ")).toEqual(["a", "b"]);
  expect(plugin.tokenizeCli("'single quoted' x")).toEqual(["single quoted", "x"]);
  expect(plugin.tokenizeCli("unterminated\"quote")).toEqual(["unterminatedquote"]);
});

test("claude-compatible: name -- command args", () => {
  const r = parse(["stm32", "--", "C:\\stm32\\.venv\\Scripts\\python.exe", "-m", "stm32_mcp.server"]);
  expect(r.error).toBeUndefined();
  expect(r.name).toBe("stm32");
  expect(r.command).toBe("C:\\stm32\\.venv\\Scripts\\python.exe");
  expect(r.args).toEqual(["-m", "stm32_mcp.server"]);
});

test("the -- separator is optional", () => {
  const r = parse(["github", "docker", "run", "-i", "--rm", "ghcr.io/github/github-mcp-server"]);
  expect(r.name).toBe("github");
  expect(r.command).toBe("docker");
  expect(r.args).toEqual(["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"]);
});

test("env flags before the name", () => {
  const r = parse(["-e", "BRAVE_API_KEY=abc", "brave", "--", "npx", "-y", "server-brave-search"]);
  expect(r.name).toBe("brave");
  expect(r.env).toEqual({ BRAVE_API_KEY: "abc" });
  expect(r.args).toEqual(["-y", "server-brave-search"]);
});

test("--env and env flags after the name work", () => {
  const r = parse(["brave", "-e", "K1=v1", "--env", "K2=v2", "--", "npx", "-y", "srv"]);
  expect(r.env).toEqual({ K1: "v1", K2: "v2" });
  expect(r.command).toBe("npx");
});

test("a -e-looking arg after -- stays in command args", () => {
  const r = parse(["docker", "--", "sh", "-c", "-e", "echo hi"]);
  expect(r.command).toBe("sh");
  expect(r.args).toEqual(["-c", "-e", "echo hi"]);
  expect(r.env).toBeUndefined();
});

test("missing command is a usage error", () => {
  expect(parse(["stm32", "--"]).error).toContain("Usage");
  expect(parse(["stm32"]).error).toContain("Usage");
  expect(parse([]).error).toContain("Usage");
});

test("malformed env flag is an error", () => {
  expect(parse(["-e", "nope", "srv", "--", "x"]).error).toContain("KEY=VALUE");
});

test("addServer persists name, command, args and env", () => {
  const r = mgr.addServer("stm32", "C:\\venv\\python.exe", ["-m", "stm32_mcp.server"], { env: { SWD_PORT: "COM4" } });
  expect(r.added).toBe("stm32");
  const loaded = mgr.loadServers().servers["stm32"];
  expect(loaded.command).toBe("C:\\venv\\python.exe");
  expect(loaded.args).toEqual(["-m", "stm32_mcp.server"]);
  expect(loaded.env).toEqual({ SWD_PORT: "COM4" });
  expect(loaded.enabled).toBe(true);
});

test("addServer rejects bad names", () => {
  expect(mgr.addServer("bad name", "x", []).error).toContain("letters, digits");
  expect(mgr.addServer("a__b", "x", []).error).toContain("__");
});

test("toggle and remove roundtrip", () => {
  mgr.addServer("srv", "node", ["x.js"]);
  expect(mgr.toggleServer("srv").enabled).toBe(false);
  expect(mgr.listServers()[0].enabled).toBe(false);
  expect(mgr.removeServer("srv").removed).toBe("srv");
  expect(mgr.loadServers().servers["srv"]).toBeUndefined();
});

test("mcpAddLineCmd: one-line add resolves $KEY from -e env and persists", () => {
  const msg = plugin.mcpAddLineCmd('-e SENTRY_TOKEN=abc sentry -- npx -y @sentry/mcp-server --access-token $SENTRY_TOKEN');
  expect(msg.startsWith("Added MCP server \"sentry\"")).toBe(true);
  const loaded = mgr.loadServers().servers["sentry"];
  // npx is wrapped on Windows (cmd /c npx ...); the tail is platform-stable.
  const npxPrefix = process.platform === "win32" ? ["/c", "npx"] : ["npx"];
  expect(loaded.command).toBe(process.platform === "win32" ? "cmd" : "npx");
  expect(loaded.args.slice(0, npxPrefix.length)).toEqual(npxPrefix);
  expect(loaded.args.slice(npxPrefix.length)).toEqual(["-y", "@sentry/mcp-server", "--access-token", "abc"]);
  expect(loaded.env).toEqual({ SENTRY_TOKEN: "abc" });
  mgr.removeServer("sentry");
});

test("mcpAddLineCmd: leading add / mcp add prefixes are forgiven", () => {
  expect(plugin.mcpAddLineCmd("add probe -- node s.js").startsWith("Added MCP server \"probe\"")).toBe(true);
  expect(plugin.mcpAddLineCmd("mcp add probe2 -- node s.js").startsWith("Added MCP server \"probe2\"")).toBe(true);
  mgr.removeServer("probe");
  mgr.removeServer("probe2");
});

test("mcpAddLineCmd: errors pass through with a usage message", () => {
  expect(plugin.mcpAddLineCmd("").length).toBeGreaterThan(0);
  expect(plugin.mcpAddLineCmd("-e BROKEN= probe").length).toBeGreaterThan(0);
  expect(plugin.mcpAddLineCmd("probe -- npx -y x").startsWith("Added")).toBe(true);
  mgr.removeServer("probe");
});

test("mcpAddLineCmd: quoted paths with spaces survive the round-trip", () => {
  const msg = plugin.mcpAddLineCmd('qtest -- "C:\\Program Files\\python\\python.exe" -m server');
  expect(msg.startsWith("Added MCP server \"qtest\"")).toBe(true);
  const loaded = mgr.loadServers().servers["qtest"];
  expect(loaded.command).toBe("C:\\Program Files\\python\\python.exe");
  mgr.removeServer("qtest");
});

// ── connectorAddLineCmd: preset-aware one-line add ──

test("connectorAddLineCmd: preset name + -e flags expands and persists", () => {
  const msg = plugin.connectorAddLineCmd("supabase -e SUPABASE_ACCESS_TOKEN=tok123");
  expect(msg.startsWith("Added connector \"supabase\"")).toBe(true);
  const loaded = mgr.loadServers().servers["supabase"];
  const npxPrefix = process.platform === "win32" ? ["/c", "npx"] : ["npx"];
  expect(loaded.command).toBe(process.platform === "win32" ? "cmd" : "npx");
  expect(loaded.args.slice(0, npxPrefix.length)).toEqual(npxPrefix);
  expect(loaded.args.slice(npxPrefix.length)).toEqual(["-y", "@supabase/mcp-server-supabase", "--access-token", "tok123"]);
  expect(loaded.env).toEqual({ SUPABASE_ACCESS_TOKEN: "tok123" });
  mgr.removeServer("supabase");
});

test("connectorAddLineCmd: leading -e flags before the preset name work", () => {
  const msg = plugin.connectorAddLineCmd("-e RAILWAY_API_TOKEN=rtok railway");
  expect(msg.startsWith("Added connector \"railway\"")).toBe(true);
  const loaded = mgr.loadServers().servers["railway"];
  expect(loaded.env).toEqual({ RAILWAY_API_TOKEN: "rtok" });
  mgr.removeServer("railway");
});

test("connectorAddLineCmd: leftover tokens are appended as trailing args", () => {
  const msg = plugin.connectorAddLineCmd("supabase -e SUPABASE_ACCESS_TOKEN=tok --project-ref abcdef");
  expect(msg.startsWith("Added connector \"supabase\"")).toBe(true);
  const loaded = mgr.loadServers().servers["supabase"];
  const npxPrefix = process.platform === "win32" ? ["/c", "npx"] : ["npx"];
  expect(loaded.args.slice(npxPrefix.length)).toEqual(["-y", "@supabase/mcp-server-supabase", "--access-token", "tok", "--project-ref", "abcdef"]);
  mgr.removeServer("supabase");
});

test("connectorAddLineCmd: no-env presets (vercel, nextjs) expand directly", () => {
  expect(plugin.connectorAddLineCmd("vercel").startsWith("Added connector \"vercel\"")).toBe(true);
  const loaded = mgr.loadServers().servers["vercel"];
  const npxPrefix = process.platform === "win32" ? ["/c", "npx"] : ["npx"];
  expect(loaded.args.slice(npxPrefix.length)).toEqual(["-y", "mcp-remote", "https://mcp.vercel.com"]);
  mgr.removeServer("vercel");
  expect(plugin.connectorAddLineCmd("nextjs").startsWith("Added connector \"nextjs\"")).toBe(true);
  mgr.removeServer("nextjs");
});

test("connectorAddLineCmd: missing required env errors and adds nothing", () => {
  const msg = plugin.connectorAddLineCmd("supabase");
  expect(msg).not.toContain("Added");
  expect(msg).toContain("Missing key");
  expect(msg).toContain("SUPABASE_ACCESS_TOKEN");
  expect(mgr.loadServers().servers["supabase"]).toBeUndefined();
  // Two-key preset: every missing key is listed.
  const msg2 = plugin.connectorAddLineCmd("cloudflare");
  expect(msg2).toContain("CLOUDFLARE_API_TOKEN");
  expect(msg2).toContain("CLOUDFLARE_ACCOUNT_ID");
  expect(mgr.loadServers().servers["cloudflare"]).toBeUndefined();
});

test("connectorAddLineCmd: a -- form skips preset expansion (custom command)", () => {
  const msg = plugin.connectorAddLineCmd("supabase -- node custom.js");
  expect(msg.startsWith("Added connector \"supabase\"")).toBe(true);
  const loaded = mgr.loadServers().servers["supabase"];
  expect(loaded.command).toBe("node");
  expect(loaded.args).toEqual(["custom.js"]);
  mgr.removeServer("supabase");
});

test("connectorAddLineCmd: custom one-liners pass through with connector wording", () => {
  const msg = plugin.connectorAddLineCmd("mytool -- node s.js");
  expect(msg.startsWith("Added connector \"mytool\"")).toBe(true);
  mgr.removeServer("mytool");
});

test("connectorAddLineCmd: add / connector add / connectors add prefixes are forgiven", () => {
  expect(plugin.connectorAddLineCmd("add nextjs").startsWith("Added connector \"nextjs\"")).toBe(true);
  mgr.removeServer("nextjs");
  expect(plugin.connectorAddLineCmd("connector add nextjs2 -- node s.js").startsWith("Added connector \"nextjs2\"")).toBe(true);
  mgr.removeServer("nextjs2");
  expect(plugin.connectorAddLineCmd("connectors vercel").startsWith("Added connector \"vercel\"")).toBe(true);
  mgr.removeServer("vercel");
});

test("connectorAddLineCmd: empty input returns the usage listing presets", () => {
  const msg = plugin.connectorAddLineCmd("");
  expect(msg).toContain("Usage");
  expect(msg).toContain("supabase");
  expect(msg).toContain("cloudflare");
});