// ChatArea — message list with proper role styling + tool log + think time.
import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { palette } from "../theme.ts";
import { showThinking, userExpandedIdx, setUserExpandedIdx } from "../store.ts";
import { formatDiffCount } from "../../core/file-diffs.js";
import { MdText } from "./MdText.tsx";
import { formatToolCall } from "../toolname.ts";
import os from "os";

const ui = palette("loom");
function uname() { return os.userInfo().username || "you"; }
function fmtMs(ms) { if (!ms) return ""; return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s"; }

// Rotating square-of-dots thinking animation — small, quiet, distracting-free.
const THINK_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function ThinkingSpark() {
  const [tick, setTick] = createSignal(0);
  let t: any;
  onMount(() => { t = setInterval(() => setTick(i => i + 1), 120); });
  onCleanup(() => t && clearInterval(t));
  return (
    <text fg={ui.thinking} dim>
      {"◆ " + THINK_FRAMES[tick() % THINK_FRAMES.length] + " Loom is thinking…  (esc to interrupt)"}
    </text>
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

// Right-side file-change panel for the split view: while the model edits
// files, chat stays on the left and this panel shows which files were edited,
// + counts, and the colored +/- hunks.
function DiffPanel(props) {
  const diffs = props.diffs || [];
  if (!diffs.length) return null;
  return (
    <box flexDirection="column" marginTop={1}>
      <box flexDirection="column" borderStyle="single" borderColor={ui.border}
        backgroundColor={ui.bgPanel} paddingX={1} paddingY={1}>
        {diffs.map((d, i) => (
          <box key={"d-" + i} flexDirection="column" marginBottom={i < diffs.length - 1 ? 1 : 0}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={ui.accent} bold wrap>{"✎ " + d.path}</text>
              <text fg={d.added ? ui.success : ui.fgMuted} dim>{"  " + formatDiffCount(d)}</text>
            </box>
            {d.lines.map((ln, j) => {
              if (ln.text === "…") return <text key={j} fg={ui.fgMuted} dim>{"  …"}</text>;
              const lines = String(ln.text).replace(/\n$/, "").split("\n");
              return lines.map((t, k) => (
                <text key={j + "-" + k} fg={ln.kind === "add" ? ui.success : ln.kind === "del" ? ui.error : ui.fgMuted} dim={ln.kind === "ctx"}>
                  {ln.kind === "add" ? "+ " : ln.kind === "del" ? "- " : "  "}{t.slice(0, 72)}
                </text>
              ));
            })}
          </box>
        ))}
      </box>
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

  // Assistant
  const isErr = m.isError;
  const isThink = m.thinking;
  const isStop = m.interrupted;
  const acc = isErr ? ui.error : (isThink ? ui.thinking : isStop ? ui.warning : ui.secondary);
  const label = isErr ? "✕ Error" : isThink ? "◇ Thinking…" : isStop ? "‖ Interrupted" : "◇ Loom";
  const diffs = m.fileDiffs || [];
  // Diff/coding output renders inline below the assistant text — full width.
  return (
    <box flexDirection="row" marginBottom={1}>
      <box flexDirection="column" marginRight={1}>
        <text fg={acc}>{"│"}</text>
        <text fg={acc}>{"│"}</text>
        <text fg={acc}>{"│"}</text>
      </box>
      <box flexDirection={"column"} flexGrow={1} paddingRight={1}>
        <box flexDirection="column" backgroundColor={ui.bgMsg} paddingY={1}>
          <box flexDirection="row" justifyContent="space-between" paddingX={1}>
            <text fg={acc} bold>{label}</text>
            {showThinking() && m.thinkTime ? (
              <text fg={ui.thinking} dim>{"⚡ " + fmtMs(m.thinkTime)}</text>
            ) : null}
          </box>
          {m.toolCalls?.length ? (
            <text fg={ui.accent}>{m.toolCalls.map((tc) => formatToolCall(tc.name, tc.input)).join(", ")}</text>
          ) : null}
            <box paddingX={1}>
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
            </box>
          {m.toolLog ? (
            <box paddingX={1} marginTop={0}>
              <text fg={ui.accent} dim wrap>{String(m.toolLog).split("\n").slice(-5).join("\n")}</text>
            </box>
          ) : null}
          {diffs.length >= 1 ? <DiffPanel diffs={diffs} /> : null}
        </box>
      </box>
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
        {props.thinking && (
          <box paddingX={3} paddingY={1}>
            <ThinkingSpark />
          </box>
        )}
      </scrollbox>
    </box>
  );
}
