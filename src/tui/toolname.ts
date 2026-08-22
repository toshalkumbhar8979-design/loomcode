// Generic tool-name/arg formatting shared by the chat and the tool log.
// Per-tool display data (icons, pending labels, spinners, blocks) lives in
// tool-display.ts — this module only knows how to FORMAT, never which tool
// is which.

// mcp__memory__read_graph → memory.read_graph  ·  todowrite → todowrite
export function prettyToolName(name: unknown): string {
  let n = String(name || "");
  if (n.indexOf("mcp__") === 0) {
    const idx = n.indexOf("__", 5);
    if (idx > 0) n = n.slice(5, idx) + "." + n.slice(idx + 2);
    else n = n.slice(5);
  }
  return n;
}

// Credential-like keys are redacted (case-insensitive): token, apiKey/api_key,
// password, authorization, secret. The underscore filter already drops
// "_"-prefixed keys; values here must never leak into the chat or log.
const SECRET_KEY_RX = /(^|[_-])(token|api_?key|password|authorization|secret)([_-]|$)/i;

// Compact args for display (opencode's `input()` helper): only primitive
// values, "key=value" pairs in brackets, capped length. Drops the "_"-prefixed
// secret-ish keys and nested objects.
export function prettyToolArgs(inp: unknown, maxLen = 48): string {
  if (!inp || typeof inp !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(inp as Record<string, unknown>)) {
    if (k.startsWith("_")) continue;
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    if (SECRET_KEY_RX.test(k)) { parts.push(k + "=[redacted]"); continue; }
    let s = String(v);
    if (s.length > 24) s = s.slice(0, 23) + "\u2026";
    parts.push(k + "=" + s);
  }
  if (!parts.length) return "";
  let s = "[" + parts.join(", ") + "]";
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + "\u2026";
  return s;
}

// Tool results arrive with terminal escape codes; strip them before the
// output block renders them (opencode strips ANSI on display too).
export function stripAnsi(s: string): string {
  return String(s)
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

// The full lookup row: "⚡ memory.read_graph {"query":"x"}".
export function formatToolCall(name: unknown, inp: unknown): string {
  const a = prettyToolArgs(inp);
  return "⚡ " + prettyToolName(name) + (a ? " " + a : "");
}

// And the append-only tool log line (same content, for the log box).
export function formatToolLogLine(name: unknown, inp: unknown): string {
  const a = prettyToolArgs(inp, 60);
  return prettyToolName(name) + (a ? " " + a : "");
}