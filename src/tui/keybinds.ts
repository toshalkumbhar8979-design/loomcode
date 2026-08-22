// Keybinds â€” configurable keybindings for the Loom TUI.
//
// Reads `keybinds`, `leader`, and `leader_timeout` from ~/.loom/tui.json
// (see docs/keybinds.md). OpenCode-compatible action names are accepted as
// aliases; unknown names are ignored with a warning. Binding values follow the
// same rules as OpenCode: a string with comma-separated alternatives, an
// array, an object ({ key }), or "none" / false to disable. "<leader>X"
// bindings fire after the leader key.
//
// This module is intentionally dependency-free (no Solid, no store) so it can
// be unit-tested in isolation; the App owns action execution and the leader
// state lives here as a plain boolean.
import { loadTuiJson } from "./tui-config.ts";

export interface KeybindAction {
  action: string;
  desc: string;
  def: string | string[];
  slash?: string;
  opencode?: string;
  context?: "app" | "dialog";
}

export const KB_ACTIONS: KeybindAction[] = [
  // â”€â”€ App / session â”€â”€
  { action: "app_exit", desc: "Quit Loom Code", def: "ctrl+c,<leader>q", opencode: "app_exit" },
  { action: "command_list", desc: "Open the command palette", def: "ctrl+p", opencode: "command_list" },
  { action: "sidebar_toggle", desc: "Toggle the sidebar", def: "ctrl+b", opencode: "sidebar_toggle" },
  { action: "sidebar_cycle_tab", desc: "Cycle the sidebar tab", def: "ctrl+i" },
  { action: "session_interrupt", desc: "Interrupt the running task / clear the draft", def: "escape", opencode: "session_interrupt" },
  { action: "modal_cancel", desc: "Close the open dialog", def: "escape" },
  { action: "user_expand", desc: "Expand/collapse the most recent long message", def: "ctrl+e" },
  { action: "session_new", desc: "Start a new session", def: "<leader>n", slash: "/new", opencode: "session_new" },
  { action: "session_list", desc: "Browse saved sessions", def: "<leader>l", slash: "/sessions", opencode: "session_list" },
  { action: "session_export", desc: "Export the session to markdown", def: "<leader>x", slash: "/export", opencode: "session_export" },
  { action: "session_compact", desc: "Compact the conversation", def: "<leader>c", slash: "/compact", opencode: "session_compact" },
  { action: "model_list", desc: "Open the model picker", def: "<leader>m", slash: "/models", opencode: "model_list,model_provider_list" },
  { action: "agent_list", desc: "List agents", def: "<leader>a", slash: "/agents", opencode: "agent_list" },
  { action: "subagent_list", desc: "View subagents (live + history, cancel, details)", def: "<leader>j", slash: "/subagents" },
  { action: "help_show", desc: "Show help", def: "<leader>h", slash: "/help", opencode: "help_show" },
  { action: "editor_open", desc: "Open LOOM.md in your editor", def: "<leader>e", slash: "/editor", opencode: "editor_open" },
  { action: "display_thinking", desc: "Toggle thinking visibility", def: "<leader>t", slash: "/thinking", opencode: "display_thinking" },
  { action: "tool_details", desc: "Toggle tool detail visibility", def: "<leader>d", slash: "/details", opencode: "tool_details" },
  { action: "app_settings", desc: "Open settings", def: "<leader>s", slash: "/settings" },
  { action: "app_undo", desc: "Undo the last exchange", def: "<leader>u", slash: "/undo" },
  { action: "app_redo", desc: "Redo the last undone exchange", def: "<leader>r", slash: "/redo" },
  { action: "mode_build", desc: "Switch to Build mode", def: "<leader>b", slash: "/build" },
  { action: "mode_plan", desc: "Switch to Plan mode", def: "<leader>p", slash: "/plan" },
  { action: "theme_list", desc: "Open the theme picker", def: "none", slash: "/theme", opencode: "theme_list" },
  // â”€â”€ Prompt input (readline-style editing) â”€â”€
  { action: "input_submit", desc: "Submit the prompt", def: "return", opencode: "input_submit,prompt_submit" },
  { action: "input_newline", desc: "Insert a newline", def: "shift+return", opencode: "input_newline" },
  { action: "input_paste", desc: "Paste (the terminal handles it)", def: "ctrl+v", opencode: "input_paste" },
  { action: "input_select_all", desc: "Select the whole draft", def: "ctrl+a", opencode: "input_select_all" },
  { action: "input_move_left", desc: "Move the caret left", def: "left", opencode: "input_move_left" },
  { action: "input_move_right", desc: "Move the caret right", def: "right", opencode: "input_move_right" },
  { action: "line_home", desc: "Move to the start of the draft", def: "home", opencode: "input_line_home,input_buffer_home" },
  { action: "line_end", desc: "Move to the end of the draft", def: "end", opencode: "input_line_end,input_buffer_end" },
  { action: "input_backspace", desc: "Backspace", def: "backspace", opencode: "input_backspace" },
  { action: "input_delete", desc: "Delete forward", def: "ctrl+d,delete", opencode: "input_delete" },
  { action: "prompt_autocomplete_next", desc: "Next suggestion / cycle the mode", def: "tab", opencode: "prompt.autocomplete.next,prompt.autocomplete.complete" },
  { action: "up_context", desc: "Up (suggestion / caret line / history)", def: "up", opencode: "input_move_up,history_previous,prompt.autocomplete.prev" },
  { action: "down_context", desc: "Down (suggestion / caret line / history)", def: "down", opencode: "input_move_down,history_next" },
  // â”€â”€ Dialog keys (modal lists & prompts) â”€â”€
  { action: "dialog_select_prev", desc: "Dialog: previous row", def: "up", context: "dialog", opencode: "dialog.select.prev" },
  { action: "dialog_select_next", desc: "Dialog: next row", def: "down", context: "dialog", opencode: "dialog.select.next" },
  { action: "dialog_select_submit", desc: "Dialog: select the row", def: "return", context: "dialog", opencode: "dialog.select.submit,dialog.prompt.submit" },
  { action: "dialog_select_page_up", desc: "Dialog: page up", def: "pageup", context: "dialog", opencode: "dialog.select.page_up" },
  { action: "dialog_select_page_down", desc: "Dialog: page down", def: "pagedown", context: "dialog", opencode: "dialog.select.page_down" },
  { action: "dialog_select_home", desc: "Dialog: first row", def: "home", context: "dialog", opencode: "dialog.select.home" },
  { action: "dialog_select_end", desc: "Dialog: last row", def: "end", context: "dialog", opencode: "dialog.select.end" },
];

// â”€â”€â”€ Config file â”€â”€â”€

// â”€â”€â”€ Canonical key strings â”€â”€â”€
// Both the event serializer and the config parser produce the same shape:
// modifier+name, e.g. "ctrl+shift+y", "shift+return", "escape", "f5".
const NAME_ALIASES: Record<string, string> = {
  enter: "return", esc: "escape", del: "delete", ins: "insert",
  "page-up": "pageup", page_up: "pageup", pgup: "pageup", pgdn: "pagedown",
  page_down: "pagedown", "page-down": "pagedown",
};

export function keyString(k: any): string {
  if (!k || !k.name) return "";
  const parts: string[] = [];
  if (k.ctrl) parts.push("ctrl");
  if (k.shift) parts.push("shift");
  if (k.meta || k.option) parts.push("alt");
  if (k.super) parts.push("super");
  if (k.hyper) parts.push("hyper");
  let name = String(k.name).toLowerCase();
  if (/^f([1-9]|1[0-2])$/.test(name)) name = name.toLowerCase();
  else if (NAME_ALIASES[name]) name = NAME_ALIASES[name];
  parts.push(name);
  return parts.join("+");
}

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: "ctrl", control: "ctrl",
  shift: "shift",
  alt: "alt", meta: "alt", option: "alt",
  super: "super", cmd: "super", win: "super", mod: "super",
  hyper: "hyper",
};

function canonKey(s: string): string {
  if (typeof s !== "string") return "";
  const t = s.trim();
  if (!t) return "";
  if (t.startsWith("<leader>")) {
    const rest = canonKey(t.slice(8));
    return rest ? "<leader>" + rest : "";
  }
  const parts = t.split("+").map(p => p.trim().toLowerCase()).filter(Boolean);
  const mods: string[] = [];
  let name = "";
  for (const p of parts) {
    const m = MODIFIER_ALIASES[p];
    if (m) { if (mods.indexOf(m) < 0) mods.push(m); continue; }
    if (!name) name = NAME_ALIASES[p] || (/^f([1-9]|1[0-2])$/i.test(p) ? p.toLowerCase() : p);
  }
  const order = ["ctrl", "shift", "alt", "super", "hyper"];
  const out = order.filter(m => mods.indexOf(m) >= 0);
  if (name) out.push(name);
  return out.join("+");
}

// â”€â”€â”€ Binding value parsing â”€â”€â”€
// Returns the list of raw key specs, or null when the binding is disabled.
function parseBindings(value: any): string[] | null {
  if (value === false || value === null) return null;
  if (value === undefined) return null;
  if (typeof value === "string") {
    if (value.trim() === "" || value.trim().toLowerCase() === "none") return null;
    return value.split(",").map(s => s.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === "object" && value && value.key !== undefined) return [String(value.key).trim()];
  return null;
}

// â”€â”€â”€ Alias resolution (opencode-compatible names) â”€â”€â”€
const ALIAS_TO_ACTION: Record<string, string> = {};
const ACTION_BY_NAME: Record<string, KeybindAction> = {};
for (const a of KB_ACTIONS) {
  ACTION_BY_NAME[a.action] = a;
  for (const alias of (a.opencode || "").split(",").map(s => s.trim()).filter(Boolean)) {
    ALIAS_TO_ACTION[alias] = a.action;
  }
}
function resolveActionName(name: string): string | undefined {
  const n = name.trim();
  if (ACTION_BY_NAME[n]) return n;
  if (ALIAS_TO_ACTION[n]) return ALIAS_TO_ACTION[n];
  return undefined;
}

// â”€â”€â”€ Resolved maps â”€â”€â”€
let appMap = new Map<string, string>();      // keystring â†’ action (app context)
let dialogMap = new Map<string, string>();   // keystring â†’ action (dialog context)
let modalMap = new Map<string, string>();    // keystring â†’ "modal_cancel" (own map: it
                                            // shares its key with session_interrupt)
let leaderMap = new Map<string, string>();   // "leader:<keystring>" â†’ action
let labels = new Map<string, string[]>();    // action â†’ display strings
let leader = "ctrl+x";
let leaderTimeoutMs = 2000;
let configWarnings: string[] = [];

function removeAction(action: string) {
  for (const m of [appMap, dialogMap, modalMap, leaderMap]) {
    for (const [ks, a] of Array.from(m.entries())) {
      if (a === action) m.delete(ks);
    }
  }
  labels.delete(action);
}

function addBinding(mode: "app" | "dialog" | "leader", keystring: string, action: string) {
  const target = mode === "leader" ? leaderMap
    : action === "modal_cancel" ? modalMap
    : mode === "dialog" ? dialogMap
    : appMap;
  target.set(mode === "leader" ? "leader:" + keystring : keystring, action);
  const disp = mode === "leader" ? "<leader>" + keystring : keystring;
  const l = labels.get(action) || [];
  l.push(disp);
  labels.set(action, l);
}

function actionContext(action: string): "app" | "dialog" {
  return ACTION_BY_NAME[action]?.context === "dialog" ? "dialog" : "app";
}

export function reload() {
  appMap = new Map();
  dialogMap = new Map();
  modalMap = new Map();
  leaderMap = new Map();
  labels = new Map();
  configWarnings = [];
  const cfg = loadTuiJson();

  // Leader key + timeout.
  const lv = cfg.leader;
  if (lv === false || lv === "none" || lv === "") leader = "";
  else leader = lv == null ? "ctrl+x" : canonKey(String(lv));
  const lt = Number(cfg.leader_timeout);
  leaderTimeoutMs = Number.isFinite(lt) && lt > 0 ? lt : 2000;
  cancelLeader();

  // Defaults firstâ€¦
  for (const a of KB_ACTIONS) {
    const binds = parseBindings(a.def);
    if (!binds) continue;
    for (const b of binds) {
      const c = canonKey(b);
      if (!c) continue;
      if (c.startsWith("<leader>")) addBinding("leader", c.slice(8), a.action);
      else addBinding(a.context === "dialog" ? "dialog" : "app", c, a.action);
    }
  }

  // â€¦then user overrides (a configured value fully replaces the defaults).
  const ub = cfg.keybinds && typeof cfg.keybinds === "object" ? cfg.keybinds : {};
  let modalCancelConfigured = false;
  for (const name of Object.keys(ub)) {
    const action = resolveActionName(name);
    if (!action) { configWarnings.push("unknown keybind action: " + name); continue; }
    if (action === "modal_cancel") modalCancelConfigured = true;
    const binds = parseBindings(ub[name]);
    removeAction(action);
    if (!binds) continue;
    for (const b of binds) {
      const c = canonKey(b);
      if (!c) continue;
      if (c.startsWith("<leader>")) addBinding("leader", c.slice(8), action);
      else addBinding(actionContext(action), c, action);
    }
  }

  // modal_cancel mirrors session_interrupt's keys unless configured separately,
  // so ESC both clears the input and closes an open modal (legacy behavior).
  if (!modalCancelConfigured) {
    removeAction("modal_cancel");
    for (const m of [appMap, leaderMap]) {
      for (const [ks, a] of Array.from(m.entries())) {
        if (a !== "session_interrupt") continue;
        const plain = ks.startsWith("leader:") ? ks.slice(7) : ks;
        addBinding(m === leaderMap ? "leader" : "app", plain, "modal_cancel");
      }
    }
  }
}

// â”€â”€â”€ Leader state â”€â”€â”€
let leaderArmed = false;
let leaderTimer: any = null;

export function isLeaderPending() { return leaderArmed; }

export function cancelLeader() {
  leaderArmed = false;
  if (leaderTimer) { clearTimeout(leaderTimer); leaderTimer = null; }
}

/** Returns true when ks IS the leader key (arms the leader mode). */
export function tapLeader(ks: string): boolean {
  if (!leader || !ks || ks !== leader) return false;
  leaderArmed = true;
  if (leaderTimer) clearTimeout(leaderTimer);
  leaderTimer = setTimeout(cancelLeader, leaderTimeoutMs);
  return true;
}

/** While the leader is pending, look up the action bound to <leader>+ks. */
export function leaderMatch(ks: string): string | undefined {
  return leaderMap.get("leader:" + ks);
}

// â”€â”€â”€ Lookups â”€â”€â”€
export function is(action: string, ks: string): boolean {
  if (action === "modal_cancel") return modalMap.get(ks) === action;
  return appMap.get(ks) === action;
}
export function dialogIs(action: string, ks: string): boolean { return dialogMap.get(ks) === action; }
export function leaderKey(): string { return leader; }
export function leaderTimeout(): number { return leaderTimeoutMs; }
export function slashFor(action: string): string { return ACTION_BY_NAME[action]?.slash || ""; }
export function warnings(): string[] { return configWarnings.slice(); }

/** Human-readable label for an action (first bound key), for help/footers. */
export function label(action: string): string {
  const l = labels.get(action);
  return l && l.length ? l[0] : "none";
}

/** Full description for /keybinds: one line per bound action. */
export function describeAll(): string {
  const lines: string[] = [];
  lines.push("Keybinds (from ~/.loom/tui.json):");
  for (const a of KB_ACTIONS) {
    const l = labels.get(a.action);
    if (!l || !l.length) continue;
    lines.push("  " + a.action.padEnd(24) + " " + l.join(", "));
  }
  if (leader) lines.push("  " + "leader".padEnd(24) + " " + leader + "  (timeout " + leaderTimeout() + "ms)");
  else lines.push("  " + "leader".padEnd(24) + " disabled");
  if (configWarnings.length) {
    lines.push("Warnings:");
    for (const w of configWarnings) lines.push("  " + w);
  }
  lines.push("Edit ~/.loom/tui.json, then restart. See docs/keybinds.md.");
  return lines.join("\n");
}

reload();
