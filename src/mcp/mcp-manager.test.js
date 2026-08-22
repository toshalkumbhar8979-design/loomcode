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