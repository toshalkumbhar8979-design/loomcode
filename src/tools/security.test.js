// Security-hardening tests: webfetch SSRF guard, MCP env allowlist,
// skills install name sanitization.
// Runs with:  bun test src/tools/security.test.js
process.env.LOOM_MCP_NO_WARM = "1";
import { test, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-sec-"));
process.env.LOOM_CONFIG_DIR = path.join(tmpRoot, ".loom");

let tools;
let mcp;
let skills;

beforeAll(() => {
  tools = require("./index.js");
  mcp = require("../mcp/mcp-client.js");
  skills = require("../skills/skills-manager.js");
});

// ---------------- webfetch SSRF guard ----------------

test("isPrivateAddress flags every dangerous range", () => {
  const p = tools.isPrivateAddress;
  const bad = [
    "127.0.0.1", "127.8.8.8", "10.0.0.7", "172.16.0.9", "172.31.255.254",
    "192.168.7.3", "169.254.169.254", "100.64.0.5", "100.127.255.1",
    "0.0.0.0", "999.10.10.10", "1.2.3.999",
    "::1", "::", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
    "fd00::dead", "fe80::1", "[::1]",
  ];
  for (const ip of bad) expect(p(ip), ip).toBe(true);
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"])
    expect(p(ip), ip).toBe(false);
});

test("webfetch blocks loopback / metadata / non-http targets before any request", async () => {
  const cases = [
    "http://localhost:1234/x",
    "http://sub.localhost/x",
    "http://127.0.0.1:99/x",
    "http://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
  ];
  for (const url of cases) {
    const r = await tools.TOOLS.webfetch.execute({ url });
    expect(String(r && r.error), url).toContain("Blocked");
  }
});

test("webfetch still fetches a real public URL", async () => {
  const r = await tools.TOOLS.webfetch.execute({
    url: "https://registry.npmjs.org/loom-agent/latest",
  });
  expect(String(r)).toContain('"name"');
}, 30000);

// ---------------- MCP env allowlist ----------------

test("MCP baseline env drops ambient secrets, keeps PATH-like basics", () => {
  process.env.LOOM_TEST_SECRET = "hunter2";
  try {
    expect(mcp.buildMcpBaseEnv().LOOM_TEST_SECRET).toBeUndefined();
    expect(mcp.buildMcpBaseEnv().PATH).toBeDefined();
  } finally {
    delete process.env.LOOM_TEST_SECRET;
  }
});

test("mcpSpawnEnv: explicit cfg.env wins over baseline, secrets stay opt-in", () => {
  process.env.LOOM_TEST_SECRET = "hunter2";
  try {
    const e = mcp.mcpSpawnEnv({ env: { MY_KEY: "k", PATH: "/custom" } });
    expect(e.MY_KEY).toBe("k");
    expect(e.PATH).toBe("/custom"); // per-server override honored
    expect(e.LOOM_TEST_SECRET).toBeUndefined(); // ambient secret NOT inherited
    expect(mcp.mcpSpawnEnv({}).MY_KEY).toBeUndefined();
  } finally {
    delete process.env.LOOM_TEST_SECRET;
  }
});

// ---------------- skills install name safety ----------------

test("safeSkillName rejects traversal / drives / separators / junk", () => {
  for (const bad of [
    "../../etc", "..\\..\\win", "C:\\Temp\\x", "c:/abs/path", "..", ".",
    "", null, undefined, "has space", "a/b", "semi;colon", "$env:x",
    "x".repeat(65),
  ]) {
    expect(skills.safeSkillName(bad), String(bad)).toBeNull();
  }
  expect(skills.safeSkillName(" my-skill_1 ")).toBe("my-skill_1");
});

test("installFrom cannot escape or silently rename outside the skills dir", () => {
  const mk = (n) => {
    const dir = path.join(tmpRoot, "src-" + n);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# t", "utf8");
    return dir;
  };
  const r = skills.installFrom(mk("ok"), "../../escapee");
  expect(r.error).toBeTruthy();
  const loomDir = path.join(tmpRoot, ".loom");
  if (fs.existsSync(loomDir)) {
    expect(fs.readdirSync(path.join(loomDir, "skills")).join()).not.toContain(
      "escapee"
    );
  }
  const good = skills.installFrom(mk("second"), "renamed-skill");
  expect(good.installed).toBe(true);
  expect(good.dir.startsWith(skills.globalSkillsDir())).toBe(true);
});