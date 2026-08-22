// Data-driven tool display registry — opencode's model, in one place: every
// tool's chat presentation (icon, pending label, spinner, done label, block
// rendering, diff/todo behavior) lives HERE as data. The chat renderer never
// checks tool names; it looks up the display for each tool and falls back to
// the GenericTool defaults (⚙, "Writing command...", "# {name} {args}" block)
// for anything it has never seen — MCP servers, custom tools, future tools.
// That is the agent's freedom: any tool it calls shows up in the chat.
import { prettyToolName, prettyToolArgs } from "./toolname.ts";

export interface ToolDisplay {
  icon: string;
  pending: string;
  // opencode passes spinner=true for exactly read/task/execute; every other
  // tool shows the quiet "~ pending" text while it runs.
  spinner?: boolean;
  // The "done" row label, summarised from the call's args.
  label: (inp: any) => string;
  // Tools that swap their row for a BLOCK once the result is back (opencode's
  // BlockTool components): bash → "$ cmd" with the output, unknown tools →
  // "# {name} {args}" with the output. title builds the block header from the
  // tool part; maxLines caps the output preview (bash 10, generic 3).
  block?: { title: (t: any) => string; maxLines?: number };
  // A finished write/edit renders its diff inline instead of the row.
  diff?: boolean;
  // A done todowrite collapses into the "# Todos" block.
  todos?: boolean;
  // Done/error rows use ✓/✗ (task/execute), not the plain icon.
  check?: boolean;
  // The row is suppressed while the message's subagent panel is up (task).
  subagent?: boolean;
  // Tools that STREAM their output live while running (bash): the chat shows a
  // growing, collapsible terminal block instead of the quiet pending row.
  live?: boolean;
  // How the loop captures what changed for this tool's diff: "file" snapshots
  // the path before/after, "bash" diffs the tree around the command.
  diffs?: "file" | "bash" | null;
}

// Null-prototype object: names like "constructor"/"toString" must NOT resolve
// to inherited Object.prototype members — they fall back to the generic entry.
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
    icon: "\u2192",
    pending: "Reading file...",
    spinner: true,
    label: (i) => "Read " + (i?.filePath || "file"),
    diffs: null,
  },
  write: {
    icon: "\u2190",
    pending: "Preparing write...",
    label: (i) => "Write " + (i?.filePath || "file"),
    diff: true,
    diffs: "file",
  },
  edit: {
    icon: "\u2190",
    pending: "Preparing edit...",
    label: (i) => "Edit " + (i?.filePath || "file"),
    diff: true,
    diffs: "file",
  },
  glob: {
    icon: "\u2731",
    pending: "Finding files...",
    label: (i) => "Glob \u0022" + String(i?.pattern || "") + "\u0022",
    diffs: null,
  },
  grep: {
    icon: "\u2731",
    pending: "Searching content...",
    label: (i) => "Grep \u0022" + String(i?.pattern || "") + "\u0022",
    diffs: null,
  },
  webfetch: {
    icon: "%",
    pending: "Fetching from the web...",
    label: (i) => "WebFetch " + (i?.url || "url"),
    diffs: null,
  },
  websearch: {
    icon: "\u25C8",
    pending: "Searching web...",
    label: (i) => "WebSearch \u0022" + String(i?.query || "") + "\u0022",
    diffs: null,
  },
  todowrite: {
    icon: "\u2699",
    pending: "Updating todos...",
    label: () => "Todos",
    todos: true,
    diffs: null,
  },
  task: {
    icon: "\u2502",
    pending: "Delegating...",
    spinner: true,
    check: true,
    subagent: true,
    label: () => "Task",
    diffs: null,
  },
  execute: {
    icon: "\u2502",
    pending: "Delegating...",
    spinner: true,
    check: true,
    label: () => "Execute",
    diffs: null,
  },
  skill: {
    icon: "\u2192",
    pending: "Loading skill...",
    label: (i) => "Skill \u0022" + String(i?.name || "") + "\u0022",
    diffs: null,
  },
  ask: {
    icon: "\u2192",
    pending: "Asking...",
    label: () => "Ask",
    diffs: null,
  },
  question: {
    icon: "\u2192",
    pending: "Asking...",
    label: () => "Ask",
    diffs: null,
  },
});

// The GenericTool fallback (opencode): ANY unregistered tool renders with the
// ⚙ icon, "Writing command..." pending, "{name} {args}" label, and an output
// block once it returns something. No registry entry required.
function genericDisplay(name: string): ToolDisplay {
  return {
    icon: "\u2699",
    pending: "Writing command...",
    label: (i) => {
      const a = prettyToolArgs(i, 60);
      return name + (a ? " " + a : "");
    },
    block: { title: (t) => "# " + (t.label || t.name), maxLines: 3 },
    diffs: null,
  };
}

export function toolDisplay(name: string): ToolDisplay {
  return Object.prototype.hasOwnProperty.call(TOOL_DISPLAY, name)
    ? TOOL_DISPLAY[name]
    : genericDisplay(prettyToolName(name));
}

// Compatibility helpers (App stamps parts with these at call time).
export function toolIcon(name: string): string {
  return toolDisplay(name).icon;
}
export function toolPending(name: string): string {
  return toolDisplay(name).pending;
}
export function toolSpinner(name: string): boolean {
  return !!toolDisplay(name).spinner;
}
export function toolLabel(name: string, inp: unknown): string {
  return toolDisplay(name).label((inp || {}) as any);
}
export function toolIsGeneric(name: string): boolean {
  return !Object.prototype.hasOwnProperty.call(TOOL_DISPLAY, name);
}