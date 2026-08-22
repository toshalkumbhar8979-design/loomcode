// Central store — SolidJS reactive state, OpenCode-style.
import { createSignal } from "solid-js";
import path from "path";
import fs from "fs";
import os from "os";
import { loadTuiJson, saveTuiJson } from "./tui-config.ts";

let _sess: any = null;
export function getSession(): any {
  if (!_sess) {
    const { Session } = require("../core/session.js");
    _sess = new Session();
  }
  return _sess;
}

export function setSessionAuto(auto: boolean): void {
  getSession().permissions.setAuto(auto);
  setAutoPerm(auto);
}

// ─── Permission auto-approve state (muted "auto" indicator in the status row) ───
export const [autoPerm, setAutoPerm] = createSignal(false);

// ─── Chat state ───
export const [messages, setMessages] = createSignal<any[]>([]);
export const [input, setInput] = createSignal("");
export const [thinking, setThinking] = createSignal(false);
export const [thinkStart, setThinkStart] = createSignal<number | null>(null);
// Index (into messages()) of the user bubble whose collapsed preview is
// expanded. Ctrl+E toggles the most recent collapsed one; clicking a bubble
// also sets this. Null = everything collapsed.
export const [userExpandedIdx, setUserExpandedIdx] = createSignal<number | null>(null);
// Settled reasoning parts (message index → part indices) the user expanded.
// Clicking a settled "+ Thought" row toggles its part; absent = all collapsed.
export const [thoughtExpanded, setThoughtExpanded] = createSignal<Map<number, Set<number>>>(new Map());
// While a turn is RUNNING its thinking streams open by default; clicking the
// "⠋ Thinking" header collapses it live (opencode toggles reasoning at any
// time). Indices of running thoughts the user collapsed manually.
export const [thoughtClosed, setThoughtClosed] = createSignal<Set<number>>(new Set());

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
export type AutoKind = "none" | "slash" | "file" | "shell" | "at";
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
// The same popup hosts QUESTIONS (the ask tool): isQuestion flips it into
// question mode, where the user picks one of the provided options or types
// their own answer instead of the Allow/Always/Deny choices.
export type PermissionRequest = {
  tool: string;
  command: string;
  label: string;
  isQuestion?: boolean;
  options?: string[];
  sessionStart?: boolean;
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

// Draft text selection (readline-style): selStart/selEnd are indices into
// input; both -1 = no selection. Ctrl+A marks everything, Ctrl+C copies the
// highlighted span, typing/backspace replace it.
export const [selStart, setSelStart] = createSignal(-1);
export const [selEnd, setSelEnd] = createSignal(-1);
export function clearSelection() { setSelStart(-1); setSelEnd(-1); }

// Paste-vs-typing marker: set when a paste lands in the input and cleared the
// moment the user edits. Pasted drafts past 10 lines render compressed
// ("pasted ~N lines") instead of blowing the chatbox up to its scroll limit.
export const [pastedAt, setPastedAt] = createSignal(0);

// Typing an answer to a QUESTION popup (the ask tool) switches the popup into
// its inline answer editor; the text lives here so the reconciler can remount
// the popup on signal changes without wiping the typed answer.
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
// answers the popup (Allow / Always allow / Deny, or a question option/answer).
// The promise resolves { approved, note } — the session turns questions into
// the answer (note) and permissions into an approve/deny verdict.
export function requestPermission(tool: string, command: string, label: string, isQuestion?: boolean, options?: string[]): Promise<{ approved: boolean; note: string }> {
  return new Promise((resolve) => {
    setPermission({
      tool, command, label, isQuestion, options,
      resolve: (approved, note) => { setPermission(null); resolve({ approved: !!approved, note: note || "" }); },
    });
  });
}

// One-time prompt shown at the start of a new session: "Allow all commands in
// this session?" — picking "Allow all commands" flips on session-wide
// auto-approval (Shift+Tab also toggles it), "Ask each time" keeps per-command
// asks. Fire-and-forget: the popup resolves itself once the user answers.
export function askSessionPermissions(): Promise<void> {
  return new Promise((resolve) => {
    setPermission({
      tool: "session",
      command: "Allow all commands in this session?",
      label: "",
      isQuestion: true,
      options: ["Allow all commands", "Ask each time"],
      sessionStart: true,
      resolve: () => { setPermission(null); resolve(); },
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
export const [showToolDetails, setShowToolDetails] = createSignal(true);
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
  const { envNamesFor } = require("../providers/index.js");
  const hasKey = !!(cfg.apiKeys?.[prov]) || (envNamesFor(prov) || []).some(n => !!process.env[n]);
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
  const { getRecentModels, hasApiKey } = require("../config/settings.js");
  const { BUILTIN_PROVIDERS } = require("../providers/index.js");
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
    // models.dev-scale: only providers with a key list their full model set —
    // the rest stay in /connect until a key is added. Built-ins always show.
    if (!BUILTIN_PROVIDERS.includes(p) && !hasApiKey(p)) continue;
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

// ─── Vim mode ───
// Optional modal editing (config `vimMode`, toggled via /vim). Normal-mode
// keys are intercepted in the App's central key handler; insert mode behaves
// exactly like the default input.
export const [vimMode, setVimMode] = createSignal(!!loadTuiJson().vimMode);
export const [vimNormal, setVimNormal] = createSignal(false);
export function toggleVim(): boolean {
  const next = !vimMode();
  setVimMode(next);
  setVimNormal(false);
  saveTuiJson({ vimMode: next });
  return next;
}

// ─── Queued drafts ───
// Messages typed while a turn runs are queued (claude-style) and flushed
// FIFO when the turn ends. Plain strings; submitted verbatim.
export const [queuedDrafts, setQueuedDrafts] = createSignal<string[]>([]);
export function queueDraft(text: string): void { setQueuedDrafts(q => q.concat(text)); }
export function dequeueDraft(): string | null {
  const q = queuedDrafts();
  if (!q.length) return null;
  setQueuedDrafts(q.slice(1));
  return q[0];
}
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
// Reactive re-calc engine: bumping filesVersion invalidates the cache AND
// re-runs every reactive caller (the Sidebar's file list) because
// getProjectFiles() reads the signal. Bump after writes/create/rm calls.
const [filesVersion, setFilesVersion] = createSignal(0);

export function getProjectFiles(): string[] {
  filesVersion();
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

export function bumpFilesVersion() { setFilesVersion(v => v + 1); invalidateFilesCache(); }

// Recompute the sidebar's file list when a known mutator lands. Called by the
// tool-execution layer after write/edit/bash so the Files tab is always fresh.
export function refreshFilesIfNeeded(src?: string) {
  if (src === "write" || src === "edit" || src === "bash" || src === "mcp") bumpFilesVersion();
}

// Live agent todos: Session.setTodos → core event "todos:changed" → here.
// This _replaces_ any markdown-scan fallback so the sidebar mirrors the
// model's real todowrite output without waiting for a full assistant re-render.
// Registration is idempotent: App remounts must not stack duplicate listeners.
let _todoEvOff: (() => void) | null = null;
export function wireTodoEvents() {
  if (_todoEvOff) return;
  const ev = require("../core/events.js");
  _todoEvOff = ev.on("todos:changed", (todos: any[]) => {
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
  { cmd: "restore", desc: "Restore project to an earlier state" },
  { cmd: "settings", desc: "Toggle details/thinking display" },
  { cmd: "sessions", desc: "Browse saved sessions (jump to one)" },
  { cmd: "thinking", desc: "Toggle thinking visibility" },
  { cmd: "details", desc: "Toggle tool detail visibility" },
  { cmd: "theme", desc: "Switch UI theme" },
  { cmd: "graph", desc: "View the memory graph (nodes + links)" },
  { cmd: "skills", desc: "Manage skills", args: "install <dir|git> | remove <name>" },
  { cmd: "mcp", desc: "Manage MCP servers", args: "add <name> <cmd> | remove | toggle" },
  { cmd: "connectors", desc: "Manage connectors (hosting & cloud services)", args: "add <name> <cmd> | remove | toggle" },
  { cmd: "permissions", desc: "Show saved permission rules", args: "| reset | auto" },
  { cmd: "exit", desc: "Quit Loom Code" },
  // Newer commands sit at the END so early rows (help/connect/…) keep their
  // popup positions — the interactive suite and muscle memory rely on it.
  { cmd: "subagents", desc: "View subagent runs (live + history, cancel, details)" },
  { cmd: "context", desc: "Show ~token breakdown of the current context window" },
  { cmd: "think", desc: "Thinking budget", args: "off|low|medium|high" },
  { cmd: "approve", desc: "Approve the plan & switch to Build (Plan mode)" },
  { cmd: "tasks", desc: "List background tasks (bash background:true)" },
  { cmd: "rewind", desc: "Pick a restore point and rewind files" },
  { cmd: "share", desc: "Export this chat as a self-contained HTML file" },
  { cmd: "worktree", desc: "New git worktree + branch for parallel work", args: "<name>" },
  { cmd: "style", desc: "Output style preset or free text; empty clears" },
  { cmd: "vim", desc: "Toggle vim modal editing (Esc = NORMAL)" },
  { cmd: "remember", desc: "Save a fact to project LOOM.md (or type # fact)", args: "<fact>" },
];

// ─── TUI prefs ───
const _p = loadTuiJson();
if (_p.sidebarVisible !== undefined) setSidebarVisible(_p.sidebarVisible);
if (_p.showToolDetails !== undefined) setShowToolDetails(_p.showToolDetails);
if (_p.showThinking !== undefined) setShowThinking(_p.showThinking);

// ─── First-run welcome tips (small sidebar card, dismissible with ✕) ───
// Visible only until the user dismisses them once; the flag persists in
// tui.json so existing users never see the card again.
export const [welcomeTipSeen, setWelcomeTipSeen] = createSignal(!!_p.welcomeTipSeen);
export function dismissWelcomeTips() {
  setWelcomeTipSeen(true);
  saveTuiJson({ welcomeTipSeen: true });
}

export function persistUi() {
  saveTuiJson({
    sidebarVisible: sidebarVisible(),
    showToolDetails: showToolDetails(),
    showThinking: showThinking(),
    welcomeTipSeen: welcomeTipSeen(),
  });
}

// ─── Convenience getters ───
export function cwdShort(): string {
  const cwd = process.cwd().replace(/\\/g, "/");
  return cwd.split("/").filter(Boolean).slice(-2).join("/");
}
export function username(): string { return os.userInfo().username || "you"; }

// ─── Subagent tracker ───
// Active subagent runs are kept in a Solid signal so the /subagents panel can
// render live status (running/done/error/cancelled, elapsed time, last tool).
// Completed runs are also persisted to disk via saveSubagentRun and merged
// into subagentHistory so the panel can show runs from past sessions.
export interface SubagentEntry {
  runId: string;
  agent: string;
  agentId: string;
  prompt: string;
  status: "running" | "done" | "error" | "cancelled";
  startTime: number;
  endTime: number | null;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  interrupted: boolean;
  content: string;
  toolLog: string[];
  sessionId?: string;
}

// Active (in-flight + just-completed this session). Map keyed by runId; the
// signal value is replaced (not mutated) so Solid sees the change.
export const [activeSubagents, setActiveSubagents] = createSignal<Map<string, SubagentEntry>>(new Map());

export function startSubagent(opts: { runId: string; agent: string; agentId: string; prompt: string; sessionId?: string }): void {
  const now = Date.now();
  const entry: SubagentEntry = {
    runId: opts.runId,
    agent: opts.agent,
    agentId: opts.agentId,
    prompt: String(opts.prompt || ""),
    status: "running",
    startTime: now,
    endTime: null,
    durationMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    interrupted: false,
    content: "",
    toolLog: [],
    sessionId: opts.sessionId,
  };
  setActiveSubagents(prev => {
    const next = new Map(prev);
    next.set(opts.runId, entry);
    return next;
  });
}

// Append to content / toolLog and patch scalar fields. Solid needs a new Map
// to detect the change — we copy on every update.
export function updateSubagent(runId: string, patch: { contentAppend?: string; toolLogAppend?: string; durationMs?: number }): void {
  setActiveSubagents(prev => {
    const cur = prev.get(runId);
    if (!cur) return prev;
    const next = new Map(prev);
    const live: SubagentEntry = {
      ...cur,
      durationMs: patch.durationMs != null ? patch.durationMs : (Date.now() - cur.startTime),
    };
    if (patch.contentAppend) live.content = cur.content + patch.contentAppend;
    if (patch.toolLogAppend) live.toolLog = cur.toolLog.concat(patch.toolLogAppend);
    next.set(runId, live);
    return next;
  });
}

// Mark a run done/error/cancelled and (when done) copy into the in-memory
// history so the panel can keep showing it after activeSubagents evicts it.
export function endSubagent(runId: string, final: { status: "done" | "error" | "cancelled"; endTime?: number; tokensIn?: number; tokensOut?: number; costUsd?: number; durationMs?: number; interrupted?: boolean; content?: string }): SubagentEntry | null {
  let finished: SubagentEntry | null = null;
  setActiveSubagents(prev => {
    const cur = prev.get(runId);
    if (!cur) return prev;
    const next = new Map(prev);
    finished = {
      ...cur,
      status: final.status,
      endTime: final.endTime != null ? final.endTime : Date.now(),
      durationMs: final.durationMs != null ? final.durationMs : (Date.now() - cur.startTime),
      tokensIn: final.tokensIn != null ? final.tokensIn : cur.tokensIn,
      tokensOut: final.tokensOut != null ? final.tokensOut : cur.tokensOut,
      costUsd: final.costUsd != null ? final.costUsd : cur.costUsd,
      interrupted: final.interrupted != null ? final.interrupted : cur.interrupted,
      content: final.content != null ? final.content : cur.content,
    };
    next.set(runId, finished);
    return next;
  });
  if (finished) {
    // Snapshot into in-memory history so the panel can show it even if the
    // disk write fails or the panel is opened in the same session.
    setSubagentHistory(prev => [finished!, ...prev].slice(0, 500));
  }
  return finished;
}

export function getSubagent(runId: string): SubagentEntry | undefined {
  return activeSubagents().get(runId);
}

// Cancel a live subagent by runId. Delegates to core/agents.js so the
// child's interrupt() actually fires; the run will resolve as interrupted
// and endSubagent will be called with status 'cancelled' / interrupted=true.
export function cancelSubagentRun(runId: string): boolean {
  try {
    const { cancelSubagent } = require("../core/agents.js");
    return !!cancelSubagent(runId);
  } catch {
    return false;
  }
}

// History from disk (loaded on startup; refreshed when the panel opens).
export const [subagentHistory, setSubagentHistory] = createSignal<SubagentEntry[]>([]);

// Synchronous load (the log file is small — a few hundred entries max — and
// the panel needs the data immediately on first paint).
export function loadSubagentHistory(opts?: { since?: number; sessionId?: string; limit?: number }): SubagentEntry[] {
  try {
    const { loadSubagentRuns } = require("../core/subagent-log.js");
    const rows = loadSubagentRuns(opts) as SubagentEntry[];
    setSubagentHistory(rows);
    return rows;
  } catch {
    return [];
  }
}

// Persist a finished run to the on-disk log. Best-effort — a write failure
// must not break the TUI.
export function persistSubagent(entry: SubagentEntry): boolean {
  try {
    const { saveSubagentRun } = require("../core/subagent-log.js");
    return !!saveSubagentRun(entry);
  } catch {
    return false;
  }
}
