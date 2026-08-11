// ChatArea — message list with proper role styling + tool log + think time.
import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { palette } from "../theme.ts";
import {
  showThinking, userExpandedIdx, setUserExpandedIdx, sidebarVisible,
  thoughtIdx, setThoughtIdx,
} from "../store.ts";
import { formatDiffCount } from "../../core/file-diffs.js";
import { MdText } from "./MdText.tsx";
import { formatToolCall } from "../toolname.ts";
import os from "os";

const ui = palette("loom");
function uname() { return os.userInfo().username || "you"; }
function fmtMs(ms) { if (!ms) return ""; return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s"; }

// Rotating square-of-dots thinking animation — small, quiet, distracting-free.
// Lives INSIDE the running message's header label, opencode-style: the label
// reads "Loom is Thinking…" + spinner, and clicking it toggles the thought.
const THINK_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function ThinkingLabel() {
  const [tick, setTick] = createSignal(0);
  let t: any;
  onMount(() => { t = setInterval(() => setTick(i => i + 1), 120); });
  onCleanup(() => t && clearInterval(t));
  return (
    <span>
      {"◆ " + THINK_FRAMES[tick() % THINK_FRAMES.length] + " Loom is Thinking…  (esc to interrupt)"}
    </span>
  );
}

// Rough visual line count (logical lines + width wrapping) — drives the
// "~N lines" badge on big pasted user messages.
export const PER_LINE = 88;
export function estVisualLines(text) {
  if (!text) return 1;
  let n = 0;
  for (const ln of String(text).split("\n")) n += Math.max(1, Math.ceil((ln.length + 1) / PER_LINE));
  return n;
}

// Long pasted messages are collapsed to a preview so the chat keeps breathing
// room; the "~N lines" badge shows the real size. Click (or Ctrl+E on the most
// recent one) to expand/collapse. The FULL content is always kept — expansion
// shows everything, only the collapsed preview is truncated.
export const USER_PREVIEW_LINES = 10;
const USER_PREVIEW_CHARS = 2000;

function UserBubble(props) {
  const m = props.m;
  const idx = props.idx;
  const content = String(m.content || "");
  const lines = estVisualLines(content);
  const big = lines > USER_PREVIEW_LINES;
  const expanded = () => userExpandedIdx() === idx;
  const toggle = () => setUserExpandedIdx(expanded() ? null : idx);
  const shown = () => {
    if (!big || expanded()) return content;
    return content.split("\n").slice(0, USER_PREVIEW_LINES).join("\n").slice(0, USER_PREVIEW_CHARS);
  };

  return (
    <box flexDirection="column" marginBottom={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <box flexDirection="row">
          <text fg={ui.secondary} bold>{"\u25E4 " + uname()}</text>
          <Show when={lines > 1}>
            <text fg={ui.fgMuted} dim>{"  ~" + lines + " lines"}</text>
          </Show>
        </box>
        <text fg={ui.fgMuted} dim>{m.time || ""}</text>
      </box>
      <box
        paddingX={2}
        onMouseUp={big ? toggle : undefined}
        onKeyDown={big ? (e: any) => { if (e.name === "return" || e.name === "space") toggle(); } : undefined}
      >
        <text fg={ui.fg} wrap>{shown()}</text>
        <Show when={big}>
          <text fg={ui.fgMuted} dim>
            {"  \u2026 (" + lines + " lines \u2014 click to " + (expanded() ? "collapse" : "expand") + ", or Ctrl+E)"}
          </text>
        </Show>
      </box>
    </box>
  );
}

// Inline file-change patch for the chat area: when the model edits an existing
// file, the unified +/- hunks render inside the assistant bubble (plain blocks,
// no split view). New files show no diff — there is nothing to change yet.
function PatchBlock(props) {
  const diffs = (props.diffs || []).filter((d: any) => !d.isNew);
  if (!diffs.length) return null;

  function colWidth() {
    const term = Math.max(40, (process.stdout?.columns || 100) | 0);
    const sidebarW = sidebarVisible() ? 38 : 0;
    return Math.max(20, term - sidebarW - 8);
  }
  const W = () => colWidth();
  // Long lines truncate with an ellipsis instead of spilling past the width.
  const clip = (t: string) => (t.length > W() ? t.slice(0, W() - 1) + "…" : t);
  const prefix = (k: string) => (k === "del" ? "-" : k === "add" ? "+" : " ");

  return (
    <box flexDirection="column" marginTop={1}>
      {diffs.map((d, i) => (
        <box key={"d-" + i} flexDirection="column" backgroundColor={ui.bgPanel} paddingX={1} paddingY={0} marginBottom={i < diffs.length - 1 ? 1 : 0}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={ui.accent} bold wrap>{"✎ " + d.path}</text>
            <text fg={d.added ? ui.success : ui.fgMuted} dim>{"  " + formatDiffCount(d)}</text>
          </box>
          {(d.lines || []).map((ln, ri) => {
            const text = clip(String(ln.text || "").replace(/\n$/, ""));
            const fg = ln.kind === "del" ? ui.error : ln.kind === "add" ? ui.success : ui.fgMuted;
            return (
              <text key={"l-" + ri} fg={fg} dim={ln.kind === "ctx"} wrap>
                {prefix(ln.kind) + text}
              </text>
            );
          })}
        </box>
      ))}
    </box>
  );
}

// Inline task patch: only file edits/writes and todos belong in the patch
// blocks. The thought (reasoning) is NOT a patch — it renders as markdown
// right under the "Loom is Thinking…" header label.
function TodoBlock(props) {
  const todos = props.todos || [];
  if (!todos.length) return null;
  return (
    <box flexDirection="column" marginTop={1} backgroundColor={ui.bgPanel} paddingX={1} paddingY={0}>
      {todos.map((t, i) => (
        <text key={"t-" + i} fg={t.done ? ui.success : t.cancelled ? ui.error : t.inProgress ? ui.warning : ui.fgMuted} wrap>
          {(t.done ? "[x]" : t.cancelled ? "[-]" : t.inProgress ? "[~]" : "[ ]") + " " + t.text}
        </text>
      ))}
    </box>
  );
}

function MsgBubble(props) {
  const m = props.m;

  if (m.role === "system") {
    return (
      <box marginBottom={1} paddingX={2}>
        <text fg={ui.fgMuted} dim wrap>{m.content}</text>
      </box>
    );
  }

  if (m.role === "user") {
    return <UserBubble m={m} idx={props.idx} />;
  }

  if (m.role === "tool") {
    const first = String(m.content || "").split("\n")[0].slice(0, 140);
    return (
      <box marginBottom={1} paddingLeft={4}>
        <text fg={ui.accent} dim wrap>{"→  " + first}</text>
      </box>
    );
  }

  // Assistant. Layout, opencode-style:
  //   1. Header row (no box) — the ONLY clickable thought toggle:
  //      running+collapsed → "◆ ⠋ Loom is Thinking…  (esc to interrupt)"
  //      clicked           → "+Thought", reasoning shows below in markdown
  //      clicked again     → back to "Loom is Thinking…", reasoning hidden
  //      task done         → "+Thought · 4.2s" (click toggles the thought)
  //   2. Thought (no box) — the reasoning, rendered as markdown, OUTSIDE the
  //      response bubble.
  //   3. Response bubble (bgMsg) — the markdown answer, colorful, distinct
  //      from the plain user prompt.
  //   4. Patch region (bgPanel blocks) — ONLY task work: todos + file edits.
  //      Thought never goes in here.
  const isErr = m.isError;
  const isThink = m.thinking;
  const isStop = m.interrupted;
  const acc = isErr ? ui.error : (isThink ? ui.thinking : isStop ? ui.warning : ui.secondary);
  const agentTag = m.agentLabel ? "@" + m.agentLabel : null;
  const diffs = m.fileDiffs || [];
  const thoughtOpen = () => thoughtIdx() === props.idx;
  const toggleThought = () => setThoughtIdx(thoughtOpen() ? null : props.idx);
  const hasThought = !!(m.thinkingContent || m.thinking || m.thinkTime);
  const thoughtLabel = () => {
    if (isErr) return "✕ Error";
    if (!hasThought) return "◇ Loom" + (agentTag ? " · " + agentTag : "");
    if (thoughtOpen()) return "+Thought" + (m.thinkTime ? " · " + fmtMs(m.thinkTime) : "");
    if (isThink) return <ThinkingLabel />;
    return "+Thought · " + fmtMs(m.thinkTime || 0);
  };
  const plainLabel = () => (isErr ? "✕ Error" : isThink ? "◇ Thinking…" : isStop ? "‖ Interrupted" : "◇ Loom" + (agentTag ? " · " + agentTag : ""));
  const thoughtFallback = () => {
    const t = String(m.thinkingContent || "").trim();
    if (t) return null;
    // No reasoning stream (plain models) — show what the model was doing.
    const log = String(m.toolLog || "").split("\n").filter(Boolean).slice(-8);
    return log.length ? log.join("\n") : "(no thought content streamed for this model)";
  };
  return (
    <box flexDirection="column" marginBottom={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <Show when={showThinking()}>
          <text
            fg={acc}
            bold
            onMouseUp={hasThought ? () => toggleThought() : undefined}
            onKeyDown={hasThought ? (e: any) => { if (e.name === "return" || e.name === "space") toggleThought(); } : undefined}
          >
            {thoughtLabel()}
          </text>
        </Show>
        <Show when={!showThinking()}>
          <text fg={acc} bold>{plainLabel()}</text>
        </Show>
      </box>
      <Show when={thoughtOpen()}>
        <box paddingX={2} paddingY={0}>
          <Show when={thoughtFallback()}>
            <text fg={ui.thinking} dim wrap>{thoughtFallback()}</text>
          </Show>
          <Show when={!thoughtFallback()}>
            <MdText md={String(m.thinkingContent || "").slice(0, 20000)} />
          </Show>
        </box>
      </Show>
      <box flexDirection="column" backgroundColor={ui.bgMsg} paddingY={1} paddingX={1}>
        {m.toolCalls?.length ? (
          <text fg={ui.accent}>{m.toolCalls.map((tc) => formatToolCall(tc.name, tc.input)).join(", ")}</text>
        ) : null}
        <Show
          when={!isErr && m.content}
          fallback={
            <text fg={isErr ? ui.error : ui.fg} wrap>
              {(m.content || (isThink ? "…" : "")).slice(0, 30000)}
            </text>
          }
        >
          <MdText md={String(m.content || "").slice(0, 30000)} />
        </Show>
        {m.toolLog ? (
          <box marginTop={0}>
            <text fg={ui.accent} dim wrap>{String(m.toolLog).split("\n").slice(-5).join("\n")}</text>
          </box>
        ) : null}
      </box>
      <TodoBlock todos={m.todos} />
      {m.subagent ? (
        <box flexDirection="column" marginTop={1} borderStyle="rounded" borderColor={ui.border}
          paddingX={1} paddingY={0} backgroundColor={ui.bgPanelAlt}>
          <box flexDirection="row">
            <text fg={ui.accent} bold>{"@" + m.subagent.agent}</text>
            <text fg={ui.fgMuted} dim>
              {"  " + (m.subagent.done
                ? "finished \u00B7 " + (m.subagent.status || "")
                : m.subagent.status === "interrupted" ? "interrupted" : "working\u2026")}
            </text>
          </box>
          {m.subagent.log ? <text fg={ui.fgMuted} dim>{"\u26A1 " + m.subagent.log}</text> : null}
          <text fg={ui.fg} wrap>{m.subagent.text}</text>
        </box>
      ) : null}
      {diffs.length >= 1 ? <PatchBlock diffs={diffs} /> : null}
    </box>
  );
}

export function ChatArea(props: { messages?: () => any[]; thinking?: boolean }) {
  const visible = () => (props.messages?.() || []).slice(-40);
  // Indices must match the store's messages() so Ctrl+E (which walks the full
  // list) lands on the same bubble the chat renders.
  const baseIdx = () => Math.max(0, (props.messages?.() || []).length - 40);
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={0}>
      <scrollbox
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        scrollbarOptions={{ trackOptions: { style: { fg: ui.border } } }}
        viewportOptions={{ flexGrow: 1 }}
      >
        {visible().map((m, i) => (
          <MsgBubble key={"m-" + i} m={m} idx={baseIdx() + i} />
        ))}
      </scrollbox>
    </box>
  );
}
