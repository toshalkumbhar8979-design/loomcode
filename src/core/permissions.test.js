// Unit tests for the OpenCode-style permission layer (src/core/permissions.js).
// Runs with:  bun test src/core/permissions.test.js
import { test, expect } from "bun:test";
import path from "path";
import os from "os";

const {
  PermissionManager, DEFAULT_PERMISSIONS, TOOL_TO_PERMISSION,
  wildcardToRegExp, matchNode, expandHome, normPathArg,
} = require("./permissions.js");

function pm(config) {
  const p = new PermissionManager();
  p.loadConfig(config || {});
  return p;
}

test("defaults: most tools allow; bash allows normal commands, dangerous still ask; edit/task ask; .env read denied, .env.example ok", () => {
  const p = pm({});
  expect(p.resolve("glob", "src/**")).toBe("allow");
  expect(p.resolve("webfetch", "https://x.dev")).toBe("allow");
  expect(p.resolve("read", "/abs/env/.env")).toBe("deny");
  expect(p.resolve("read", "/abs/env/.env.local")).toBe("deny");
  expect(p.resolve("read", "/abs/env/.env.example")).toBe("allow");
  expect(p.resolve("read", "/abs/src/app.js")).toBe("allow");
  expect(p.resolve("edit", "/abs/src/app.js")).toBe("ask");
  expect(p.resolve("bash", "ls")).toBe("allow");
  expect(p.resolve("bash", "rm -rf /tmp/x")).toBe("ask");
  expect(p.resolve("task", "general")).toBe("ask");
});

test("config.permission string shorthand; object overrides; last-match-wins", () => {
  const p = pm({ permission: "allow" });
  expect(p.resolve("bash", "echo hi")).toBe("allow");
  expect(p.resolve("read", "/x/.env")).toBe("allow");
  // Safety heuristics still hold under a blanket allow.
  expect(p.resolve("bash", "rm -rf /")).toBe("ask");

  const p2 = pm({ permission: { bash: { "*": "allow", "*.sh": "deny" } } });
  expect(p2.resolve("bash", "echo hi")).toBe("allow");
  expect(p2.resolve("bash", "run.sh")).toBe("deny");

  const p3 = pm({ permission: { read: { "*": "allow", "**/.env": "deny", "**/.env.example": "allow" } } });
  expect(p3.resolve("read", "/a/b/.env")).toBe("deny");
  expect(p3.resolve("read", "/a/b/.env.example")).toBe("allow");
});

test("agent-scoped permission overrides the global tree", () => {
  const cfg = {
    permission: { bash: "deny" },
    agent: { builder: { permission: { bash: "allow" } } },
  };
  const p = pm(cfg);
  p.setAgent("builder");
  expect(p.resolve("bash", "anything")).toBe("allow");
  p.setAgent(null);
  expect(p.resolve("bash", "anything")).toBe("deny");
});

test("danger heuristics: bash ask even when a rule allows, exact session rule wins", () => {
  const p = pm({ permission: { bash: "allow" } });
  expect(p.resolve("bash", "rm -rf /tmp/x")).toBe("ask");
  p.setRule("rm -rf /tmp/x", "allow");
  expect(p.resolve("bash", "rm -rf /tmp/x")).toBe("allow");
  expect(p.resolve("bash", "rm -rf /tmp/y")).toBe("ask");
});

test("wildcards: * any run, ? one char, case-insensitive on win32", () => {
  expect(wildcardToRegExp("*.env").test(".env")).toBe(true);
  expect(wildcardToRegExp("*.env").test("a/b/.env")).toBe(true);
  expect(wildcardToRegExp("*.env").test(".env.example")).toBe(false);
  expect(wildcardToRegExp("a?c").test("abc")).toBe(true);
  expect(wildcardToRegExp("a?c").test("ac")).toBe(false);
});

test("expandHome and normPathArg", () => {
  const home = os.homedir();
  expect(expandHome("~/x", home)).toBe(path.join(home, "x"));
  expect(expandHome("$HOME/x", home)).toBe(path.join(home, "x"));
  expect(normPathArg("src/a.js", "C:/proj")).toBe("C:/proj/src/a.js");
  expect(normPathArg("C:\\proj\\a.js", "C:/proj")).toBe("C:/proj/a.js");
});

test("external_directory: inside cwd allow; outside asks unless pattern allows", () => {
  const p = pm({ permission: { external_directory: "ask" } });
  p.cwd = "C:/proj";
  expect(p.checkExternal("C:/proj/src/x.js")).toBe("allow");
  expect(p.checkExternal("C:/other/x.js")).toBe("ask");
  const p2 = pm({ permission: { external_directory: { "~/projects/personal/**": "allow" } } });
  expect(p2.checkExternal(path.join(os.homedir(), "projects", "personal", "x.js"))).toBe("allow");
  expect(p2.checkExternal("C:/nope/x.js")).toBe("ask");
});

test("permissionArg extracts the right argument per tool", () => {
  const p = pm({});
  expect(p.permissionArg("bash", { command: "ls -la" })).toBe("ls -la");
  expect(p.permissionArg("read", { filePath: "src/a.js" }, "C:/proj")).toBe("C:/proj/src/a.js");
  expect(p.permissionArg("edit", { filePath: "src/a.js" }, "C:/proj")).toBe("C:/proj/src/a.js");
  expect(p.permissionArg("task", { agent: "explore" })).toBe("explore");
  expect(p.permissionArg("skill", { name: "cad" })).toBe("cad");
  expect(p.permissionArg("websearch", { query: "hi" })).toBe("hi");
});

test("legacy check/checkRule/loadRules API unchanged", async () => {
  const p = pm({});
  p.loadRules({ "npm install -g foo": "allow" });
  expect(p.checkRule("npm install -g foo")).toBe("allow");
  expect(await p.check("npm install -g foo")).toBe("allow");
  expect(await p.check("echo hi")).toBe("allow");
  expect(await p.check("rm -rf /")).toBe("ask");
  p.clearRule("npm install -g foo");
  expect(p.checkRule("npm install -g foo")).toBe(null);
});

test("setAuto toggles the auto flag; task/skill/webfetch map to permission keys", () => {
  expect(TOOL_TO_PERMISSION.write).toBe("edit");
  expect(TOOL_TO_PERMISSION.todowrite).toBe(null);
  const p = pm({});
  expect(p.auto).toBe(false);
  p.setAuto(true);
  expect(p.auto).toBe(true);
});

test("resolveKey: doom_loop defaults to ask; config can allow/deny it", () => {
  const p = pm({});
  expect(p.resolveKey("doom_loop", "bash:...")).toBe("ask");
  const p2 = pm({ permission: { doom_loop: "deny" } });
  expect(p2.resolveKey("doom_loop", "bash:...")).toBe("deny");
  const p3 = pm({ permission: { external_directory: "allow" } });
  expect(p3.resolveKey("external_directory", "C:/elsewhere")).toBe("allow");
});