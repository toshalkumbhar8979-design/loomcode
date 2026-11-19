// Tool presentation registry — data, not branches. The transcript never
// checks a tool name; it looks up a display record and falls back to the
// generic entry. New tools (MCP, plugins, future built-ins) render without
// touching the renderer.
import { prettyToolName, prettyToolArgs } from "./toolname.ts";

export interface ToolDisplay {
  icon: string;
  pending: string;
  spinner?: boolean;
  label: (inp: any) => string;
  block?: { title: (t: any) => string; maxLines?: number };
  diff?: boolean;
  todos?: boolean;
  check?: boolean;
  subagent?: boolean;
  live?: boolean;
  diffs?: "file" | "bash" | null;
}

const TOOL_DISPLAY: Record<string, ToolDisplay> = Object.assign(Object.create(null), {
  bash: {
    icon: "$",
    pending: "Writing command...",
    label: (i) => String(i?.command || "command"),
    block: { title: (t) => "$ " + (t.label || t.name), maxLines: 10 },
    diffs: "bash",
    live: true,
  },
  read: {
    icon: "▸",
    pending: "Reading file...",
    spinner: true,
    label: (i) => "Read " + (i?.filePath || "file"),
    diffs: null,
  },
  write: {
    icon: "◂",
    pending: "Preparing write...",
    label: (i) => "Write " + (i?.filePath || "file"),
    diff: true,
    diffs: "file",
  },
  edit: {
    icon: "◂",
    pending: "Preparing edit...",
    label: (i) => "Edit " + (i?.filePath || "file"),
    diff: true,
    diffs: "file",
  },
  glob: {
    icon: "∗",
    pending: "Finding files...",
    label: (i) => "Glob \"" + String(i?.pattern || "") + "\"",
    diffs: null,
  },
  grep: {
    icon: "∗",
    pending: "Searching content...",
    label: (i) => "Grep \"" + String(i?.pattern || "") + "\"",
    diffs: null,
  },
  webfetch: {
    icon: "%",
    pending: "Fetching from the web...",
    label: (i) => "Fetch " + (i?.url || "url"),
    diffs: null,
  },
  websearch: {
    icon: "◈",
    pending: "Searching web...",
    label: (i) => "Search \"" + String(i?.query || "") + "\"",
    diffs: null,
  },
  browser: {
    icon: "◎",
    pending: "Browsing...",
    spinner: true,
    label: (i) => {
      const a = String(i?.action || "");
      const target = String(i?.url || i?.selector || i?.key || "");
      return "Browser " + a + (target ? " " + target.slice(0, 60) : "");
    },
    diffs: null,
  },
  todowrite: {
    icon: "≡",
    pending: "Updating tasks...",
    label: () => "Tasks",
    todos: true,
    diffs: null,
  },
  task: {
    icon: "║",
    pending: "Delegating...",
    spinner: true,
    check: true,
    subagent: true,
    label: () => "Task",
    diffs: null,
  },
  spawn_agents: {
    icon: "⋔",
    pending: "Fanning out...",
    spinner: true,
    check: true,
    subagent: true,
    label: (i) => {
      const n = Array.isArray(i?.tasks) ? i.tasks.length : 0;
      return n ? "Fan out " + n + " agents" : "Fan out agents";
    },
    diffs: null,
  },
  execute: {
    icon: "║",
    pending: "Delegating...",
    spinner: true,
    check: true,
    label: () => "Execute",
    diffs: null,
  },
  skill: {
    icon: "→",
    pending: "Loading skill...",
    label: (i) => "Skill \"" + String(i?.name || "") + "\"",
    diffs: null,
  },
  ask: {
    icon: "?",
    pending: "Asking...",
    label: () => "Ask",
    diffs: null,
  },
  question: {
    icon: "?",
    pending: "Asking...",
    label: () => "Ask",
    diffs: null,
  },
});

function genericDisplay(name: string): ToolDisplay {
  return {
    icon: "◆",
    pending: "Working...",
    label: (i) => {
      const a = prettyToolArgs(i, 60);
      return name + (a ? " " + a : "");
    },
    block: { title: (t) => "◆ " + (t.label || t.name), maxLines: 3 },
    diffs: null,
  };
}

export function toolDisplay(name: string): ToolDisplay {
  return Object.prototype.hasOwnProperty.call(TOOL_DISPLAY, name)
    ? TOOL_DISPLAY[name]
    : genericDisplay(prettyToolName(name));
}

export function toolIcon(name: string): string { return toolDisplay(name).icon; }
export function toolPending(name: string): string { return toolDisplay(name).pending; }
export function toolSpinner(name: string): boolean { return !!toolDisplay(name).spinner; }
export function toolLabel(name: string, inp: unknown): string { return toolDisplay(name).label((inp || {}) as any); }
export function toolIsGeneric(name: string): boolean { return !Object.prototype.hasOwnProperty.call(TOOL_DISPLAY, name); }
