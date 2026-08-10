// Pretty tool-name display for the chat. MCP tools arrive as
// "mcp__server__tool" — the raw string plus an args blob like {} reads as
// noise. This module normalises names to "server.tool" and formats the
// args with smart truncation for the "⚡ name args…" row.

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

// Compact args for display: drop the secret-ish noise, cap the length.
export function prettyToolArgs(inp: unknown, maxLen = 48): string {
  if (!inp || typeof inp !== "object") return "";
  const entries = Object.entries(inp as Record<string, unknown>).filter(([k]) => !k.startsWith("_"));
  if (!entries.length) return "";
  let s = JSON.stringify(Object.fromEntries(entries));
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + "…";
  return s;
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
