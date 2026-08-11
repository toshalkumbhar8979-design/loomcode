// Central store — SolidJS reactive state, OpenCode-style.
import { createSignal } from "solid-js";
import path from "path";
import fs from "fs";
import os from "os";

let _sess: any = null;
export function getSession(): any {
  if (!_sess) {
    const { Session } = require("../core/session.js");
    _sess = new Session();
  }
  return _sess;
}

// ─── Chat state ───
export const [messages, setMessages] = createSignal<any[]>([]);
export const [input, setInput] = createSignal("");
export const [thinking, setThinking] = createSignal(false);
export const [thinkStart, setThinkStart] = createSignal<number | null>(null);
// Index (into messages()) of the user bubble whose collapsed preview is
// expanded. Ctrl+E toggles the most recent collapsed one; clicking a bubble
// also sets this. Null = everything collapsed.
export const [userExpandedIdx, setUserExpandedIdx] = createSignal<number | null>(null);
// Index (into messages()) of the assistant message whose "+Thought" panel is
// expanded. Clicking a thought label toggles it; null = all collapsed.
export const [thoughtIdx, setThoughtIdx] = createSignal<number | null>(null);

// ─── Prompt history (Up/Down recall of earlier prompts) ───
export const [promptHistory, setPromptHistory] = createSignal<string[]>([]);
export const [historyIndex, setHistoryIndex] = createSignal(-1);
let historyDraft = "";

// Record every submitted prompt (deduped, capped at 50) and reset navigation
// so the next Up arrow starts from the newest entry.
export function recordPrompt(text: string) {
  const t = text.trim();
  if (!t) return;
  setPromptHistory(h => (h[h.length - 1] === t ? h : [...h.slice(-49), t]));
  setHistoryIndex(-1);
  historyDraft = "";
}

// Up arrow: walk toward older prompts; the first Up saves the current draft so
// Down past the end restores it.
export function historyPrev(): string | null {
  const h = promptHistory();
  if (!h.length) return null;
  if (historyIndex() === -1) historyDraft = input();
  const ni = historyIndex() === -1 ? h.length - 1 : Math.max(0, historyIndex() - 1);
  setHistoryIndex(ni);
  return h[ni];
}

// Down arrow: walk toward newer prompts; past the newest restores the draft.
export function historyNext(): string | null {
  const h = promptHistory();
  if (historyIndex() === -1) return null;
  const ni = historyIndex() + 1;
  if (ni >= h.length) { setHistoryIndex(-1); return historyDraft; }
  setHistoryIndex(ni);
  return h[ni];
}

// Typing fresh text (or escaping) abandons history navigation.
export function historyReset() { setHistoryIndex(-1); historyDraft = ""; }

// ─── Autocomplete (slash / @file / !shell) ───
export type AutoKind = "none" | "slash" | "file" | "shell";
export type Suggestion = { label: string; desc?: string };
export const [suggestions, setSuggestions] = createSignal<Suggestion[]>([]);
export const [autoKind, setAutoKind] = createSignal<AutoKind>("none");
export const [autoIndex, setAutoIndex] = createSignal(0);

// App registers a handler that executes the picked suggestion (slash / shell / file).
let _suggestionPicker: ((label: string) => void) | null = null;
export function registerSuggestionPicker(fn: ((label: string) => void) | null) { _suggestionPicker = fn; }

export function selectSuggestionAt(i: number) {
  setAutoIndex(Math.max(0, Math.min(suggestions().length - 1, i)));
}

export function moveSuggestionIndex(delta: number) {
  const n = suggestions().length;
  if (!n) return;
  setAutoIndex(i => Math.max(0, Math.min(n - 1, i + delta)));
}

// Compute the start index of a visible window that keeps `selected` in view.
// `visible` rows are shown; selection stays inside with ~1/3 of the window above it.
// If `selected` is already inside the current window, the window is NOT moved —
// this keeps the popup stable during mouse down/up (clicking must not shift rows
// between press and release, or the release lands on a different row).
export function windowFor(selected: number, total: number, visible: number, currentStart: number = 0): number {
  if (total <= visible) return 0;
  const maxStart = total - visible;
  const c = Math.max(0, Math.min(currentStart, maxStart));
  if (selected >= c && selected < c + visible) return c;
  const target = selected - Math.floor(visible / 3);
  return Math.max(0, Math.min(maxStart, target));
}

export function pickSuggestionAt(i: number): boolean {
  selectSuggestionAt(i);
  return pickSuggestion();
}

export function pickSuggestion(): boolean {
  const list = suggestions();
  const pick = list[autoIndex()];
  if (!pick) return false;
  const label = pick.label;
  setInput(""); setSuggestions([]); setAutoKind("none"); setAutoIndex(0);
  if (_suggestionPicker) _suggestionPicker(label);
  return true;
}

// ─── Modal ───
export const [modal, setModal] = createSignal<any>(null);
export function openModal(m: any) { setModal(m); }
export function closeModal() { setModal(null); }

// ─── Permission popup (model wants to run a command / change a file) ───
export type PermissionRequest = {
  tool: string;
  command: string;
  label: string;
  resolve: (approved: boolean, note?: string) => void;
};
export const [permission, setPermission] = createSignal<PermissionRequest | null>(null);

// Draft caret position (index into input) — the chatbox is a real editing
// surface: left/right arrows move it, typing inserts at it, backspace deletes
// before it. Kept in the store so history/paste/submit paths can sync it.
export const [cursor, setCursor] = createSignal(0);

// Set the draft and place the cursor (defaults to the end).
export function setDraft(text: string, pos?: number) {
  setInput(text);
  setCursor(typeof pos === "number" ? Math.max(0, Math.min(text.length, pos)) : text.length);
}

// Typing an answer to a permission request switches to a separate centered
// "Question" popup; the state lives here so the popup can render at the App
// root (overlay) while the permission prompt keeps owning the keyboard.
export const [questionOpen, setQuestionOpen] = createSignal(false);
export const [questionText, setQuestionText] = createSignal("");

export function openQuestion(initial: string) {
  setQuestionText(initial);
  setQuestionOpen(true);
}

export function closeQuestion() {
  setQuestionOpen(false);
  setQuestionText("");
}

// Raised by the session's onPermissionRequest callback; resolves once the user
// answers the popup (Allow / Always allow / Deny / typed answer).
export function requestPermission(tool: string, command: string, label: string): Promise<boolean> {
  return new Promise((resolve) => {
    setPermission({
      tool, command, label,
      resolve: (approved, note) => { setPermission(null); resolve(approved); },
    });
  });
}

// ─── Floating toasts ───
// Transient confirmations (copied, model switched, key saved, ...) render as a
// small floating box above the input bar and auto-dismiss — they are NOT chat
// messages, so they never pollute the conversation history.
export type Toast = { id: number; text: string; kind: "info" | "ok" | "error" };
export const [toasts, setToasts] = createSignal<Toast[]>([]);
let toastSeq = 0;
export function showToast(text: string, kind: "info" | "ok" | "error" = "info", durationMs: number = 3000) {
  const id = ++toastSeq;
  setToasts(t => [...t, { id, text, kind }]);
  setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), durationMs);
}

// ─── Sidebar ───
export const [sidebarVisible, setSidebarVisible] = createSignal(true);
export const [sidebarTab, setSidebarTab] = createSignal(0);

// ─── Live model speed (sidebar "Speed" row) ───
export type SpeedSnapshot = {
  live: { elapsedMs: number; firstTokenMs: number | null; tokensPerSec: number } | null;
  last: { latencyMs: number | null; tokensPerSec: number | null; durationMs: number | null; tokens: number | null; model: string } | null;
};
export const [speedStats, setSpeedStats] = createSignal<SpeedSnapshot>({ live: null, last: null });

// ─── Settings toggles ───
export const [showToolDetails, setShowToolDetails] = createSignal(false);
export const [showThinking, setShowThinking] = createSignal(true);
export const [inputMode, setInputMode] = createSignal<"build" | "plan" | "chat">("build");

// ─── Provider state ───
export const [providerName, setProviderName] = createSignal("");
export const [modelName, setModelName] = createSignal("");
export const [providerKeyOk, setProviderKeyOk] = createSignal(false);
export const [sessionId, setSessionId] = createSignal("");

// ─── Todos ───
export const [todos, setTodos] = createSignal<any[]>([]);

// ─── Usage & billing ───
export const [sessionUsage, setSessionUsage] = createSignal<{ tokens: number; pct: number; cost: number }>({ tokens: 0, pct: 0, cost: 0 });
export const [lifetimeUsage, setLifetimeUsage] = createSignal<{ tokens: number; cost: number; monthCost: number; pct: number; budget: number }>({ tokens: 0, cost: 0, monthCost: 0, pct: 0, budget: 25 });
export const [modelMeta, setModelMeta] = createSignal<any>(null);
export const [budgetLevel, setBudgetLevel] = createSignal<string>("auto");
// Phase 2.4: the last skill(s) that fired this turn — drives the sidebar Skills row.
export const [skillActive, setSkillActive] = createSignal<string[]>([]);

const { PROVIDERS, PROVIDER_ORDER, PROVIDER_LABELS } = require("../providers/index.js");
export { PROVIDERS, PROVIDER_ORDER, PROVIDER_LABELS };

export function refreshProviderState() {
  const s = getSession();
  const cfg = s.config || {};
  const prov = s.provider?.active?.name || cfg.provider || "anthropic";
  const model = cfg.model?.[prov] || "default";
  setProviderName(prov);
  setModelName(model);
  setSessionId(s.conversationId || "");
  setBudgetLevel(cfg.budgetLevel || "auto");
  const hasKey = !!(cfg.apiKeys?.[prov]) || !!process.env[prov.toUpperCase() + "_API_KEY"];
  setProviderKeyOk(!!hasKey);
}

// Refresh the session + lifetime usage/billing signals from the session counters and ~/.loom/usage.json.
export function refreshUsage() {
  refreshProviderState();
  const s = getSession();
  const { getModelMeta } = require("../providers/index.js");
  const meta = getModelMeta(providerName(), modelName());
  const ctx = meta?.context || 200000;
  setModelMeta(meta);
  setSessionUsage({
    tokens: s.tokensUsed,
    pct: ctx ? (s.tokensUsed / ctx) * 100 : 0,
    cost: s.sessionCost,
  });
  const { getUsage } = require("../core/usage.js");
  const u = getUsage();
  setLifetimeUsage({
    tokens: u.totalTokens,
    cost: u.totals.costUsd,
    monthCost: u.month.costUsd,
    pct: u.budgetUsd ? (u.month.costUsd / u.budgetUsd) * 100 : 0,
    budget: u.budgetUsd,
  });
}

export function modelOptionsForProvider(provider: string) {
  return PROVIDERS[provider]?.models || [];
}

export function allModelOptions() {
  const out: any[] = [];
  const { getRecentModels } = require("../config/settings.js");
  const recents = getRecentModels();
  const seen = new Set<string>();
  if (recents.length) {
    out.push({ header: "Recent", value: "__header_recent", isHeader: true });
    for (const r of recents) {
      if (!r || !r.provider || !r.model) continue;
      const mods = modelOptionsForProvider(r.provider);
      const m = mods.find(x => x.id === r.model);
      if (!m) continue;
      const key = r.provider + "/" + r.model;
      seen.add(key);
      out.push({ label: m.name, value: m.id, sub: m.id, provider: r.provider, tags: m.tags, recent: true });
    }
  }
  for (const p of PROVIDER_ORDER) {
    const mods = modelOptionsForProvider(p);
    if (!mods.length) continue;
    out.push({ header: PROVIDER_LABELS[p] || p, value: `__header__${p}`, isHeader: true });
    for (const m of mods) {
      const key = p + "/" + m.id;
      if (seen.has(key)) continue;
      out.push({ label: m.name, value: m.id, sub: m.id, provider: p, tags: m.tags });
    }
  }
  out.push({ label: "(custom model ID)", value: "__custom__" });
  return out;
}

// ─── Message helpers ───
export function appendMessage(m: any) { setMessages(l => [...l, m]); }
export function patchLastMessage(patch: any) {
  setMessages(l => {
    const i = l.length - 1;
    if (i < 0) return l;
    return l.map((m, j) => j === i ? { ...m, ...patch } : m);
  });
}
export function patchMessageAt(idx: number, patch: any) {
  setMessages(l => l.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
}

// Matches bare markers ("[x] task") AND markdown checklist lines
// ("- [x] task", "* [ ] task", "1. [~] task") so the sidebar mirrors todo
// lists the model writes in its reply even without the todowrite tool.
const TODO_RX = /^\s*(?:[-*+]\s+|\d+\.\s+)?\[([x+~ \-])\]\s+(.+)/i;
export function recomputeTodos() {
  // Real todo state from the session (todowrite tool persists there) wins.
  const sess = getSession();
  const real = sess.todos;
  if (Array.isArray(real) && real.length) {
    setTodos(real.map(t => ({
      done: t.status === "completed",
      inProgress: t.status === "in_progress",
      cancelled: t.status === "cancelled",
      text: t.content,
    })));
    return;
  }
  // Fallback: scan replies for [ ] [x] [+] markers (resumed/old sessions).
  const out: any[] = [];
  for (const m of messages()) {
    if (m.role !== "assistant" || !m.content) continue;
    for (const line of String(m.content).split("\n")) {
      const hit = line.match(TODO_RX);
      if (hit) {
        const st = hit[1].toLowerCase();
        out.push({ done: st === "x" || st === "+", inProgress: st === "+" || st === "~", cancelled: st === "-", text: hit[2].trim() });
      }
    }
  }
  setTodos(out);
}

// ─── File helpers ───
const IGNORE = /(^|[\/])(node_modules|\.git|dist|build|\.next|\.venv|venv|coverage|__pycache__|\.loom|\.idea|\.vscode)([\/]|$)/i;
let filesCache: string[] | null = null;

export function getProjectFiles(): string[] {
  if (filesCache) return filesCache;
  const cwd = process.cwd();
  const out: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > 4 || out.length > 500) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (IGNORE.test(full)) continue;
      const rel = path.relative(cwd, full).replace(/\\/g, "/");
      if (e.isDirectory()) walk(full, depth + 1);
      else out.push(rel);
    }
  }
  walk(cwd, 0);
  filesCache = out.sort();
  return filesCache;
}

export function fuzzyFiles(query: string): string[] {
  if (!query) return getProjectFiles().slice(0, 12);
  const q = query.toLowerCase();
  return getProjectFiles()
    .filter((f: string) => f.toLowerCase().includes(q))
    .sort((a: string, b: string) => {
      const ai = a.toLowerCase().indexOf(q);
      const bi = b.toLowerCase().indexOf(q);
      if (ai !== bi) return ai - bi;
      return a.length - b.length;
    })
    .slice(0, 12);
}

export function invalidateFilesCache() { filesCache = null; }

// Reactive re-calc engine: any of these signal bumps mean the visible slice
// of project files could be stale. Bump after writes/create/rm calls.
const [filesVersion, setFilesVersion] = createSignal(0);
export function bumpFilesVersion() { setFilesVersion(v => v + 1); invalidateFilesCache(); }

// Recompute the sidebar's file list when a known mutator lands. Called by the
// tool-execution layer after write/edit/bash so the Files tab is always fresh.
export function refreshFilesIfNeeded(src?: string) {
  if (src === "write" || src === "edit" || src === "bash" || src === "mcp") bumpFilesVersion();
}

// Live agent todos: Session.setTodos → core event "todos:changed" → here.
// This _replaces_ any markdown-scan fallback so the sidebar mirrors the
// model's real todowrite output without waiting for a full assistant re-render.
export function wireTodoEvents() {
  const ev = require("../core/events.js");
  ev.on("todos:changed", (todos: any[]) => {
    const sess = getSession();
    const real = Array.isArray(todos) && todos.length ? todos : sess.todos;
    setTodos(
      (Array.isArray(real) ? real : []).map((t: any) => ({
        done: t.status === "completed",
        inProgress: t.status === "in_progress",
        cancelled: t.status === "cancelled",
        text: String(t.content || ""),
      }))
    );
  });
}

// ─── Pet events & animation ─────────────────────────────────────
export type PetMood = "idle" | "thinking" | "working" | "success" | "error" | "celebrating" | "waving" | "sleep";
export type PetBark = { mood?: PetMood; phrase?: string; until?: number };
export const [petBark, setPetBark] = createSignal<PetBark>({});
export const [openPetsLinked, setOpenPetsLinked] = createSignal(false);
export const [openPetsSync, setOpenPetsSync] = createSignal(false);
export const [leaderPending, setLeaderPending] = createSignal(false);
export const [petEnabled, setPetEnabled] = createSignal(true);
let _petTimer: any = null;
export function notifyPet(bark: PetBark) {
  if (_petTimer) { clearTimeout(_petTimer); _petTimer = null; }
  setPetBark(bark);
  if (bark.until) _petTimer = setTimeout(() => setPetBark({}), bark.until);
}

// ─── Companion pets (declared early so prefs can reference it) ─── */
export const [companion, setCompanion] = createSignal<string>("cat");

// ─── Slash commands (for autocomplete) ───
export interface SlashCmd { cmd: string; desc: string; args?: string; }

export const SLASH_LIST: SlashCmd[] = [
  { cmd: "help", desc: "Show help dialog" },
  { cmd: "agents", desc: "List agents — primaries + subagents (@mention or task tool)" },
  { cmd: "build", desc: "Build mode — full agent tools (Tab cycles)" },
  { cmd: "plan", desc: "Plan mode — read-only analysis, no file changes" },
  { cmd: "chat", desc: "Chat mode — conversation only, no tools" },
  { cmd: "connect", desc: "Add/connect a provider", args: "[provider]" },
  { cmd: "key", desc: "Edit API key" },
  { cmd: "baseurl", desc: "Set provider base URL", args: "[provider] [url]" },
  { cmd: "model", desc: "Pick the active model", args: "[model-id]" },
  { cmd: "models", desc: "Open the model picker (grouped by provider)" },
  { cmd: "providers", desc: "List supported providers" },
  { cmd: "status", desc: "Show connection status" },
  { cmd: "usage", desc: "Show token usage and billing" },
  { cmd: "budget", desc: "Budget level: free | cheap | best | auto", args: "[level]" },
  { cmd: "new", desc: "Start a new session" },
  { cmd: "clear", desc: "Clear the chat" },
  { cmd: "compact", desc: "Compact conversation" },
  { cmd: "restore", desc: "Restore project to an earlier state" },
  { cmd: "undo", desc: "Undo last exchange (then /redo)" },
  { cmd: "redo", desc: "Redo last undone exchange" },
  { cmd: "reset", desc: "Reset the session" },
  { cmd: "settings", desc: "Toggle details/thinking display" },
  { cmd: "sessions", desc: "Browse saved sessions" },
  { cmd: "share", desc: "Export the current session to JSON" },
  { cmd: "export", desc: "Export to markdown" },
  { cmd: "thinking", desc: "Toggle thinking visibility" },
  { cmd: "details", desc: "Toggle tool detail visibility" },
  { cmd: "theme", desc: "Switch UI theme" },
  { cmd: "editor", desc: "Open LOOM.md in your editor" },
  { cmd: "diff", desc: "Show git diff" },
  { cmd: "init", desc: "Create LOOM.md" },
  { cmd: "memory", desc: "Show memory file locations" },
  { cmd: "doctor", desc: "Run diagnostics" },
  { cmd: "skills", desc: "Manage skills", args: "install <dir|git> | remove <name>" },
  { cmd: "mcp", desc: "Manage MCP servers", args: "add <name> <cmd> | remove | toggle" },
  { cmd: "connectors", desc: "Manage connectors (hosting & cloud services)", args: "add <name> <cmd> | remove | toggle" },
  { cmd: "permissions", desc: "Show saved permission rules", args: "| reset" },
  { cmd: "debug", desc: "Show debug info" },
  { cmd: "fork", desc: "Fork conversation" },
  { cmd: "companion", desc: "Change your companion pet" },
  { cmd: "exit", desc: "Quit Loom Code" },
];

// Ctrl+X leader key map
export const LEADER_CMDS: Record<string, string> = {
  c: "/compact", e: "/editor", q: "/exit", x: "/export",
  h: "/help", m: "/models", n: "/new",
  r: "/redo", l: "/sessions", u: "/undo",
  s: "/settings", t: "/thinking", d: "/details",
  b: "/build", p: "/plan",
};

// ─── TUI prefs ───
const TUI_STATE = path.join(os.homedir(), ".loom", "tui.json");
function loadPrefs(): any { try { return fs.existsSync(TUI_STATE) ? JSON.parse(fs.readFileSync(TUI_STATE, "utf8")) : {}; } catch { return {}; } }
function savePrefs(s: any) { try { fs.mkdirSync(path.dirname(TUI_STATE), { recursive: true }); fs.writeFileSync(TUI_STATE, JSON.stringify(s, null, 2)); } catch {} }

const _p = loadPrefs();
if (_p.sidebarVisible !== undefined) setSidebarVisible(_p.sidebarVisible);
if (_p.showToolDetails !== undefined) setShowToolDetails(_p.showToolDetails);
if (_p.showThinking !== undefined) setShowThinking(_p.showThinking);
if (_p.companion !== undefined) setCompanion(_p.companion);
if (_p.openPetsSync !== undefined) setOpenPetsSync(!!_p.openPetsSync);
if (_p.petEnabled !== undefined) setPetEnabled(!!_p.petEnabled);

export function persistUi() {
  savePrefs(Object.assign({}, loadPrefs(), {
    sidebarVisible: sidebarVisible(),
    showToolDetails: showToolDetails(),
    showThinking: showThinking(),
    companion: companion(),
    openPetsSync: openPetsSync(),
    petEnabled: petEnabled(),
  }));
}

// ─── Companion pets ───
export const COMPANIONS: Record<string, {
  name: string;
  icon: string[];
  description: string;
  blinkFrames: string[][];
  phrases: string[];
  poses: Record<string, string[]>;
}> = {
  cat: {
    name: "Cat",
    description: "A cozy tabby that purrs when things go well",
    icon: [" ∧∧ ", "(^.^)", " >ω< ", "  ∪ "],
    blinkFrames: [["(^.^)"],["(-.-)"],["(^.^)"],["(^.^)"]],
    phrases: ["purr…","meow?","mrow!","♥","zzz…"],
    poses: {
      idle:    [" ∧∧ ","(^.^)"," >ω< ","  ∪ "],
      thinking:[" ∧∧ ","(o.O)"," >o< ","  ∪ "],
      happy:   [" ∧∧ ","(^v^)"," >∀<","  ∪ "],
      working: [" ∧∧ ","(•ᴗ•)"," >ω<","  ∪ "],
      sleep:   [" ∧∧ ","(-.-)"," ~zZ~","  ∪ "],
    },
  },
  robot: {
    name: "Robot",
    description: "A helpful circuit that beeps at every tool call",
    icon: ["[◉ᴗ◉]"," |=⚙=| ","  ___ "],
    blinkFrames: [["[◉ᴗ◉]"],["[–ᴗ–]"],["[◉ᴗ◉]"],["[◉ᴗ◉]"]],
    phrases: ["beep!","processing…","⚡ done","uptime: ∞","rebooting…"],
    poses: {
      idle:    ["[◉ᴗ◉]"," |=⚙=| ","  ___ "],
      thinking:["[•ᴗ•]"," |=⚙=| ","  ___ "],
      happy:   ["[★ᴗ★]"," |=⚙=| ","  ___ "],
      working: ["[≧◡≦]"," |=⚙=| ","  ___ "],
      sleep:   ["[−ᴗ−]"," |=💤=|","  ___ "],
    },
  },
  fenrir: {
    name: "Fenrir",
    description: "A wolf that howls when tests pass",
    icon: ["  ⨺⨺  "," (〃^▽^)"," /  ᵕᵕ\\","  ︵︵."],
    blinkFrames: [["(〃^▽^)"],["(〃︿▽︿)"],["(〃^▽^)"],["(〃^▽^)"]],
    phrases: ["awooo!","tests pass","chasing bugs","good boy","*sniff*"],
    poses: {
      idle:    ["  ⨺⨺  "," (〃^▽^)"," /  ᵕᵕ\\","  ︵︵ "],
      thinking:["  ⨺⨺  "," (°⊙°)"," /  ᵕᵕ\\","  ︵︵ "],
      happy:   ["  ⨺⨺  "," (≧◡≦)"," /  ᵕᵕ\\","  ︵︵ "],
      working: ["  ⨺⨺  "," (•̀ᴗ•́)"," /  ᵕᵕ\\","  ︵︵ "],
      sleep:   ["  ⨺⨺  "," (−.−)"," /  zz\\","  ︵︵ "],
    },
  },
  luma: {
    name: "Luma",
    description: "A glowing firefly that lights up on success",
    icon: ["  ✦  "," (◕‿◕)","  ωωω ","  ~~~ "],
    blinkFrames: [["(◕‿◕)"],["(◕‿◕)"],["(◕‿◕)"],["(–‿–)"]],
    phrases: ["✧ bright!","glow up","illuminate","run() ▸ pass","twinkle…"],
    poses: {
      idle:    ["  ✦  "," (◕‿◕)","  ωωω ","  ~~~ "],
      thinking:["  ✧  "," (•̀δ•́)","  ωωω ","  ~~~ "],
      happy:   ["  ★  "," (≧∇≦)","  ωωω ","  ~~~ "],
      working: ["  ✦  "," (•̀ᴗ•́)","  ωωω ","  ~~~ "],
      sleep:   ["  ·  "," (−‿−)","  ωωω ","  ~~~ "],
    },
  },
  openpets: {
    name: "OpenPets",
    description: "Syncs with the OpenPets desktop pet app",
    icon: [" (◕‿◕)"," /█╲█\\","  ╱ ╲ "],
    blinkFrames: [["(◕‿◕)"],["(−‿−)"],["(◕‿◕)"],["(◕‿◕)"]],
    phrases: ["syncing…","pet me!","brb…","connected!","play dead"],
    poses: {
      idle:     [" (◕‿◕)"," /█╲█\\","  ╱ ╲ "],
      thinking: [" (•` •)"," /█╲█\\","  ╱ ╲ "],
      happy:    [" (≧◡≦)"," \\✿╱ ","  ╱ ╲ "],
      working:  [" (≧◡≦)"," /█✿█\\","  ╱ ╲ "],
      sleep:    [" (−.−)"," /zzz\\"," ─ ─ "],
    },
  },
};

export function setCompanionByName(name: string) {
  const n = name.toLowerCase();
  for (const k of Object.keys(COMPANIONS)) {
    if (k === n || COMPANIONS[k].name.toLowerCase() === n) {
      setCompanion(k as keyof typeof COMPANIONS);
      return k;
    }
  }
  return null;
}

// ─── Convenience getters ───
export function companionArt(): string[] {
  const c = COMPANIONS[companion()];
  return c ? c.icon : ["","[?]","  _ "];
}

export function companionBlinkFrame(frame: number): string[] {
  const c = COMPANIONS[companion()];
  if (!c?.blinkFrames?.length) return c?.icon ?? ["","[?]",""];
  const blink = c.blinkFrames[frame % c.blinkFrames.length];
  const icon = [...(c.icon)];
  // Replace the face line (index 1 or last-but-1 whichever has eyes)
  const faceIdx = icon.length >= 3 ? icon.length - 2 : 1;
  const face = typeof blink === "string" ? blink : (Array.isArray(blink) ? blink[0] : c.icon[faceIdx]);
  icon[faceIdx] = face;
  return icon;
}

export function companionRandomPhrase(): string {
  const c = COMPANIONS[companion()];
  if (!c?.phrases?.length) return "";
  return c.phrases[Math.floor(Math.random() * c.phrases.length)];
}

export function companionMoodPose(): string[] {
  const c = COMPANIONS[companion()];
  if (!c) return ["","[?]",""];
  const mood = petBark()?.mood || "idle";
  return c.poses[mood] || c.poses.idle;
}

export function cwdShort(): string {
  const cwd = process.cwd().replace(/\\/g, "/");
  return cwd.split("/").filter(Boolean).slice(-2).join("/");
}
export function username(): string { return os.userInfo().username || "you"; }
