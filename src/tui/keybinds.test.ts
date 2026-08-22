// Unit tests for the keybind engine (src/tui/keybinds.ts).
// Runs with:  bun test src/tui/keybinds.test.ts
process.env.LOOM_MEM_AUTO = "0";
import { test, expect, afterAll } from "bun:test";
import os from "os";
import fs from "fs";
import path from "path";

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-kb-cfg-"));
process.env.LOOM_CONFIG_DIR = cfgDir;

const kbs = await import("./keybinds.ts");

function setTui(obj: any) {
  fs.writeFileSync(path.join(cfgDir, "tui.json"), JSON.stringify(obj), "utf8");
}
function reload(cfg: any) { setTui(cfg); kbs.reload(); }

afterAll(() => {
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}
  delete process.env.LOOM_CONFIG_DIR;
});

test("defaults preserve the legacy Loom bindings", () => {
  reload({});
  expect(kbs.is("app_exit", "ctrl+c")).toBe(true);
  expect(kbs.is("command_list", "ctrl+p")).toBe(true);
  expect(kbs.is("sidebar_toggle", "ctrl+b")).toBe(true);
  expect(kbs.is("user_expand", "ctrl+e")).toBe(true);
  expect(kbs.is("input_select_all", "ctrl+a")).toBe(true);
  expect(kbs.is("input_submit", "return")).toBe(true);
  expect(kbs.is("input_newline", "shift+return")).toBe(true);
  expect(kbs.is("prompt_autocomplete_next", "tab")).toBe(true);
  expect(kbs.is("input_delete", "ctrl+d")).toBe(true);
  expect(kbs.is("input_delete", "delete")).toBe(true);
  expect(kbs.leaderKey()).toBe("ctrl+x");
  expect(kbs.leaderTimeout()).toBe(2000);
});

test("leader-scoped defaults resolve via leaderMatch", () => {
  reload({});
  expect(kbs.leaderMatch("q")).toBe("app_exit");
  expect(kbs.leaderMatch("n")).toBe("session_new");
  expect(kbs.leaderMatch("l")).toBe("session_list");
  expect(kbs.leaderMatch("x")).toBe("session_export");
  expect(kbs.leaderMatch("c")).toBe("session_compact");
  expect(kbs.leaderMatch("m")).toBe("model_list");
  expect(kbs.leaderMatch("a")).toBe("agent_list");
  expect(kbs.leaderMatch("h")).toBe("help_show");
  expect(kbs.leaderMatch("e")).toBe("editor_open");
  expect(kbs.leaderMatch("t")).toBe("display_thinking");
  expect(kbs.leaderMatch("d")).toBe("tool_details");
  expect(kbs.leaderMatch("s")).toBe("app_settings");
  expect(kbs.leaderMatch("u")).toBe("app_undo");
  expect(kbs.leaderMatch("r")).toBe("app_redo");
  expect(kbs.leaderMatch("b")).toBe("mode_build");
  expect(kbs.leaderMatch("p")).toBe("mode_plan");
});

test("escape binds both session_interrupt and modal_cancel (mirror)", () => {
  reload({});
  expect(kbs.is("session_interrupt", "escape")).toBe(true);
  expect(kbs.is("modal_cancel", "escape")).toBe(true);
});

test("keyString serializes modifiers and aliases", () => {
  expect(kbs.keyString({ name: "y", ctrl: true, shift: true })).toBe("ctrl+shift+y");
  expect(kbs.keyString({ name: "tab", option: true })).toBe("alt+tab");
  expect(kbs.keyString({ name: "return" })).toBe("return");
  expect(kbs.keyString({ name: "enter" })).toBe("return");
  expect(kbs.keyString({ name: "esc" })).toBe("escape");
  expect(kbs.keyString({ name: "del" })).toBe("delete");
  expect(kbs.keyString({ name: "pageup", meta: true })).toBe("alt+pageup");
  expect(kbs.keyString({ name: "F5" })).toBe("f5");
  expect(kbs.keyString({ name: "a", ctrl: true, shift: true, super: true })).toBe("ctrl+shift+super+a");
});

test("canonKey canonicalizes config values", () => {
  reload({ keybinds: { command_list: "control+shift+y" } });
  expect(kbs.is("command_list", "ctrl+shift+y")).toBe(true);
  reload({ keybinds: { command_list: "Meta+Enter" } });
  expect(kbs.is("command_list", "alt+return")).toBe(true);
  reload({ keybinds: { command_list: "mod+p" } });
  expect(kbs.is("command_list", "super+p")).toBe(true);
  reload({ keybinds: { command_list: "esc" } });
  expect(kbs.is("command_list", "escape")).toBe(true);
});

test("user overrides fully replace the defaults", () => {
  reload({ keybinds: { command_list: "ctrl+r" } });
  expect(kbs.is("command_list", "ctrl+r")).toBe(true);
  expect(kbs.is("command_list", "ctrl+p")).toBe(false);
});

test("array and object binding values are accepted", () => {
  reload({ keybinds: { command_list: ["ctrl+r", "ctrl+o"] } });
  expect(kbs.is("command_list", "ctrl+r")).toBe(true);
  expect(kbs.is("command_list", "ctrl+o")).toBe(true);
  reload({ keybinds: { sidebar_toggle: { key: "ctrl+g" } } });
  expect(kbs.is("sidebar_toggle", "ctrl+g")).toBe(true);
  expect(kbs.is("sidebar_toggle", "ctrl+b")).toBe(false);
});

test("none and false disable a binding", () => {
  reload({ keybinds: { command_list: "none" } });
  expect(kbs.is("command_list", "ctrl+p")).toBe(false);
  expect(kbs.label("command_list")).toBe("none");
  reload({ keybinds: { command_list: false } });
  expect(kbs.is("command_list", "ctrl+p")).toBe(false);
});

test("opencode-style aliases resolve to Loom actions", () => {
  reload({ keybinds: { "model_provider_list": "ctrl+e" } });
  expect(kbs.is("model_list", "ctrl+e")).toBe(true);
  reload({ keybinds: { "prompt.autocomplete.next": "ctrl+k" } });
  expect(kbs.is("prompt_autocomplete_next", "ctrl+k")).toBe(true);
  reload({ keybinds: { "dialog.select.submit": "ctrl+j" } });
  expect(kbs.dialogIs("dialog_select_submit", "ctrl+j")).toBe(true);
});

test("unknown actions are reported as warnings", () => {
  reload({ keybinds: { bogus_action: "ctrl+x" } });
  expect(kbs.warnings().join(" ")).toContain("unknown keybind action: bogus_action");
});

test("custom leader key arms and matches, timeout applies", async () => {
  reload({ leader: "ctrl+g" });
  expect(kbs.leaderKey()).toBe("ctrl+g");
  expect(kbs.tapLeader("ctrl+x")).toBe(false);
  expect(kbs.tapLeader("ctrl+g")).toBe(true);
  expect(kbs.isLeaderPending()).toBe(true);
  expect(kbs.leaderMatch("m")).toBe("model_list");
  kbs.cancelLeader();
  expect(kbs.isLeaderPending()).toBe(false);
  reload({ leader: "ctrl+x", leader_timeout: 120 });
  expect(kbs.leaderTimeout()).toBe(120);
  kbs.tapLeader("ctrl+x");
  expect(kbs.isLeaderPending()).toBe(true);
  await new Promise(r => setTimeout(r, 250));
  expect(kbs.isLeaderPending()).toBe(false);
});

test("leader can be disabled", () => {
  reload({ leader: "none" });
  expect(kbs.leaderKey()).toBe("");
  expect(kbs.tapLeader("ctrl+x")).toBe(false);
  reload({ leader: false });
  expect(kbs.leaderKey()).toBe("");
});

test("modal_cancel mirrors a rebind of session_interrupt", () => {
  reload({ keybinds: { session_interrupt: "ctrl+z" } });
  expect(kbs.is("session_interrupt", "ctrl+z")).toBe(true);
  expect(kbs.is("session_interrupt", "escape")).toBe(false);
  expect(kbs.is("modal_cancel", "ctrl+z")).toBe(true);
  expect(kbs.is("modal_cancel", "escape")).toBe(false);
});

test("a separately configured modal_cancel is not mirrored", () => {
  reload({ keybinds: { modal_cancel: "ctrl+w" } });
  expect(kbs.is("modal_cancel", "ctrl+w")).toBe(true);
  expect(kbs.is("modal_cancel", "escape")).toBe(false);
  expect(kbs.is("session_interrupt", "escape")).toBe(true);
});

test("rebinding an action clears its old leader binding", () => {
  reload({ keybinds: { app_exit: "ctrl+e" } });
  expect(kbs.is("app_exit", "ctrl+e")).toBe(true);
  expect(kbs.is("app_exit", "ctrl+c")).toBe(false);
  expect(kbs.leaderMatch("q")).toBe(undefined);
});

test("slashFor and label helpers", () => {
  reload({});
  expect(kbs.slashFor("session_new")).toBe("/new");
  expect(kbs.slashFor("help_show")).toBe("/help");
  expect(kbs.label("session_new")).toBe("<leader>n");
  expect(kbs.label("app_exit")).toBe("ctrl+c");
  const desc = kbs.describeAll();
  expect(desc).toContain("session_interrupt");
  expect(desc).toContain("modal_cancel");
});
