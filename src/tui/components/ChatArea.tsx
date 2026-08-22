// ChatArea — message list with proper role styling + tool log + think time.
import { createSignal, createMemo, onMount, onCleanup, Show } from "solid-js";
import { palette } from "../theme.ts";
import {
  showThinking, userExpandedIdx, setUserExpandedIdx, sidebarVisible,
  thoughtExpanded, setThoughtExpanded, thoughtClosed, setThoughtClosed,
} from "../store.ts";
import { toolDisplay } from "../tool-display.ts";
import { formatDiffCount } from "../../core/file-diffs.js";
import { MdText } from "./MdText.tsx";
import os from "os";

const ui = palette("loom");
function uname() { return os.userInfo().username || "you"; }
function fmtMs(ms) { if (!ms) return ""; return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s"; }

// Rotating square-of-dots thinking animation — small, quiet, distracting-free.
// Renders as the reasoning part's header while the model streams reasoning,
// opencode-style: "⠋ Thinking", and the body markdown streams live below it.
const THINK_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function ThinkingLabel() {
  const [tick, setTick] = createSignal(0);
  let t: any;
  onMount(() => { t = setInterval(() => setTick(i => i + 1), 120); });
  onCleanup(() => t && clearInterval(t));
  return (
    <span>
      {THINK_FRAMES[tick() % THINK_FRAMES.length] + " Thinking"}
    </span>
  );
}

// Running tool rows that opencode spins (read/task/execute) use the braille
// spinner; everything else shows the quiet "~ pending" text instead — a long
// command never looks frozen on screen.
function ToolSpinner(props: { text: string; fg?: string }) {
  const [tick, setTick] = createSignal(0);
  let t: any;
  onMount(() => { t = setInterval(() => setTick(i => i + 1), 120); });
  onCleanup(() => t && clearInterval(t));
  return <text fg={props.fg || ui.fg}>{THINK_FRAMES[tick() % THINK_FRAMES.length] + " " + props.text}</text>;
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
          <text fg={ui.secondary}>{"\u25E4 " + uname()}</text>
          <Show when={lines > 1}>
            <text fg={ui.fgMuted}>{"  ~" + lines + " lines"}</text>
          </Show>
        </box>
        <text fg={ui.fgMuted}>{m.time || ""}</text>
      </box>
      <box
        paddingX={2}
        onMouseUp={big ? toggle : undefined}
        onKeyDown={big ? (e: any) => { if (e.name === "return" || e.name === "space") toggle(); } : undefined}
      >
        <text fg={ui.fg}>{shown()}</text>
        <Show when={big}>
          <text fg={ui.fgMuted}>
            {"  \u2026 (" + lines + " lines \u2014 click to " + (expanded() ? "collapse" : "expand") + ", or Ctrl+E)"}
          </text>
        </Show>
      </box>
    </box>
  );
}

// opencode's BlockTool: a flat panel with a subtle LEFT border (drawn in the
// main background color so it reads as a faint divider, not a frame) on the
// panel background. Blocks always separate from the rows around them.
function Block(props: { children: any }) {
  return (
    <box
      flexDirection="column"
      marginTop={1}
      paddingLeft={2}
      paddingTop={1}
      paddingBottom={1}
      border={["left"]}
      borderColor={ui.bg}
      backgroundColor={ui.bgPanelAlt}
    >
      {props.children}
    </box>
  );
}

// opencode's generic/bash output block: "$ {command}" (bash) or
// "# {tool} {args}" (ANY tool — MCP, custom — through the generic fallback)
// with the tool's result beneath, collapsed to a few lines with a
// click-to-expand hint. The agent's actual work product shows up in the chat
// no matter which tool produced it.
function OutputBlock(props: { title: string; body: string; maxLines: number; mt?: number; live?: boolean }) {
  const [expanded, setExpanded] = createSignal(false);
  const lines = () => String(props.body || "").split("\n");
  const overflow = () => lines().length > props.maxLines;
  const toggle = () => setExpanded((v) => !v);
  return (
    <box
      flexDirection="column"
      marginTop={props.mt ? 1 : 0}
      paddingLeft={2}
      paddingTop={1}
      paddingBottom={1}
      border={["left"]}
      borderColor={ui.bg}
      backgroundColor={ui.bgPanelAlt}
      onMouseUp={overflow() ? toggle : undefined}
      onKeyDown={overflow() ? (e: any) => { if (e.name === "return" || e.name === "space") toggle(); } : undefined}
    >
      <box flexDirection="row">
        <text paddingLeft={3} fg={ui.fgMuted}>{props.title}</text>
        <Show when={props.live}>
          <text paddingLeft={1} fg={ui.warning}>{"\u25CF streaming"}</text>
        </Show>
      </box>
      {lines().slice(0, expanded() ? undefined : props.maxLines).map((l: string) => (
        <text paddingLeft={4} fg={ui.fg}>{l || " "}</text>
      ))}
      <Show when={overflow()}>
        <text paddingLeft={4} fg={ui.fgMuted}>
          {props.live
            ? "\u2026 streaming \u2014 " + (expanded() ? "click to collapse" : "click to expand")
            : "\u2026 " + (expanded() ? "Click to collapse" : "Click to expand")}
        </text>
      </Show>
    </box>
  );
}

// Inline file-change block, opencode-style: a finished write/edit/bash shows
// its diff right where the tool ran ("← Edit src/b.ts" + +/- hunks), so the
// patch only appears when the agent actually changed a file — then the message
// continues normally. A brand-new file renders as "# Wrote src/new.ts" with
// its fresh content marked "+".
function DiffBlock(props: { d: any; toolName?: string }) {
  const d = props.d;
  if (!d) return null;
  function colWidth() {
    const term = Math.max(40, (process.stdout?.columns || 100) | 0);
    const sidebarW = sidebarVisible() ? 40 : 0; // 38 sidebar + 1 margin + 1 gap
    return Math.max(20, term - sidebarW - 12);
  }
  const W = colWidth();
  // Long lines truncate with an ellipsis instead of spilling past the width.
  const clip = (t: string) => (t.length > W ? t.slice(0, W - 1) + "…" : t);
  const prefix = (k: string) => (k === "del" ? "-" : k === "add" ? "+" : " ");
  // opencode's block titles: "← Edit src/b.ts" for edits, "# Wrote ..." for
  // writes (and any brand-new file), and the bare arrow for bash-changed files.
  const verb = props.toolName === "edit" && !d.isNew ? "\u2190 Edit " : (props.toolName === "write" || d.isNew) ? "# Wrote " : "\u2190 ";
  return (
    <Block>
      <box flexDirection="row" justifyContent="space-between">
        <text paddingLeft={3} fg={ui.fgMuted}>{verb + d.path}</text>
        <text fg={d.added ? ui.success : ui.fgMuted}>{"  " + formatDiffCount(d)}</text>
      </box>
      <box paddingLeft={1}>
        {(d.lines || []).map((ln: any) => (
          <text fg={ln.kind === "del" ? ui.error : ln.kind === "add" ? ui.success : ui.fgMuted}>
            {prefix(ln.kind) + clip(String(ln.text || "").replace(/\n$/, ""))}
          </text>
        ))}
      </box>
    </Block>
  );
}

// Todos block, opencode TodoWrite-style: "# Todos" with [✓]/[•]/[ ] marks.
// The in-progress row uses the warning color, like opencode's TodoItem.
function TodosBlock(props: { todos: any[] }) {
  const todoMark = (t: any) => "[" + (t.done ? "\u2713" : t.inProgress ? "\u2022" : " ") + "] ";
  return (
    <Block>
      <text paddingLeft={3} fg={ui.fgMuted}># Todos</text>
      {props.todos.map((t: any) => (
        <text fg={t.inProgress ? ui.warning : ui.fgMuted}>{todoMark(t) + String(t.text || "")}</text>
      ))}
    </Block>
  );
}

// One tool call = its own part, opencode-style. While running, most tools show
// the quiet "~ Preparing edit..." pending text (deeper indent, no spinner, no
// accent — opencode only spins read/task/execute rows). Once done the row
// flips to a muted "→ Read src/a.ts" / "← Edit src/b.ts" line that STAYS in
// the transcript — each command gets its own entry, never one merged patch.
// A finished write/edit/bash that actually changed a file REPLACES its row
// with the diff block (opencode's Edit renders only its BlockTool once the
// diff exists) — the patch shows right where the edit happened, then the
// message continues normally. Errors render in the error color. Completed
// rows vanish when "tool details" are off (only running rows and errors
// stay) — App filters done tool parts out of messages() reactively. Every
// decision below comes from the tool's DISPLAY DATA (tool-display.ts), never
// a tool name in the renderer — anything unregistered renders via the
// GenericTool fallback.
function ToolPart(props: { t: any; todos?: any[]; blockBefore: boolean }) {
  const t = props.t;
  const d = toolDisplay(t.name);
  const diffs = t.fileDiffs || [];
  const mt = props.blockBefore ? 1 : 0;
  // todowrite collapses into the "# Todos" block once done (opencode
  // TodoWrite swaps the inline row for the block), but its pending row
  // still shows.
  if (d.todos && t.status !== "running" && (props.todos?.length)) {
    return <TodosBlock todos={props.todos} />;
  }
  // Finished write/edit/bash WITH a diff: only the patch renders — opencode
  // swaps the inline row for its BlockTool once the diff is available.
  if (d.diff && t.status !== "running" && diffs.length) {
    return (
      <box flexDirection="column" marginTop={mt}>
        {diffs.map((d2: any) => <DiffBlock d={d2} toolName={t.name} />)}
      </box>
    );
  }
  // Finished tools with output that define a block swap the row for it — the
  // "$ command" result (bash, opencode's Shell) or the generic "# {tool} {args}"
  // preview (ANY other tool with output).
  if (t.status === "done" && t.output && d.block) {
    return <OutputBlock title={d.block.title(t)} body={t.output} maxLines={d.block.maxLines || 10} mt={mt} />;
  }
  if (t.status === "running") {
    // Bash (live tools) with streamed output swaps the quiet pending row for
    // a growing, collapsible terminal block — the command's output appears
    // as it runs, then the finished block takes over with the full result.
    if (d.live && t.liveOutput) {
      return (
        <OutputBlock
          title={d.block ? d.block.title(t) : "$ " + (t.label || t.name)}
          body={t.liveOutput}
          maxLines={(d.block && d.block.maxLines) || 8}
          mt={mt}
          live={true}
        />
      );
    }
    // read/task/execute spin their label (opencode passes spinner=true for
    // exactly these); everything else gets the quiet "~ pending" text.
    if (d.spinner) {
      return (
        <box flexDirection="column" paddingLeft={3} marginTop={mt}>
          <ToolSpinner text={t.label || t.pending || "Working..."} />
        </box>
      );
    }
    return (
      <box flexDirection="column" paddingLeft={3} marginTop={mt}>
        <text paddingLeft={3} fg={ui.fg}>{"~ " + (t.pending || "Working...")}</text>
      </box>
    );
  }
  const icon =
    t.status === "error" && d.check ? "\u2717"
      : t.status === "done" && d.check ? "\u2713"
        : (t.icon || d.icon);
  const fg = t.status === "error" ? ui.error : ui.fgMuted;
  return (
    <box flexDirection="column" paddingLeft={3} marginTop={mt}>
      <text fg={fg}>{icon + " " + (t.label || d.label({}) || t.name)}</text>
    </box>
  );
}

// opencode streams each part WHERE it arrived: reasoning → tool → reasoning →
// tool → text, in exact chronological order, so the chat reads as a flow —
// "thinks, reads, thinks again, edits, replies" — never a fixed block layout.
// Single-line parts (settled "+ Thought" rows, running/done tool rows) pack
// tightly; anything multi-line (streaming/open thinking, patch blocks, text)
// separates with a gap.
function PartList(props: { m: any; idx: number }) {
  const m = props.m;
  const parts = () => (m.parts && m.parts.length ? m.parts : deriveParts(m));
  // The part streaming right now is the LAST reasoning part while the turn is
  // live; earlier reasoning parts have already settled (opencode's minimal
  // mode collapses each one the moment the model moves on to tools/text).
  // Memoized: streamed reasoning parts arrive asynchronously, so the index
  // must recompute from parts() (not a one-time const) for the ThinkingLabel
  // to follow the stream.
  const lastReasonIdx = createMemo(() => {
    let last = -1;
    const ps = parts();
    for (let k = 0; k < ps.length; k++) if (ps[k].type === "reasoning") last = k;
    return last;
  });
  let blockPrev = false;
  return (
    <>
      {parts().map((p: any, i: number) => {
        if (p.type === "reasoning") {
          if (!showThinking()) return null;
          const live = !!m.thinking && i === lastReasonIdx();
          const open = live ? !thoughtClosed().has(props.idx) : (thoughtExpanded().get(props.idx)?.has(i) ?? false);
          blockPrev = open;
          return <ThoughtPart p={p} i={i} idx={props.idx} live={live} open={open} />;
        }
        if (p.type === "tool") {
          const t = p.tool;
          const d = toolDisplay(t.name);
          const isBlock = !!(
            (d.todos && t.status !== "running" && (m.todos?.length)) ||
            (d.diff && t.status !== "running" && (t.fileDiffs || []).length > 0) ||
            (t.status === "done" && t.output && d.block) ||
            (t.status === "running" && t.liveOutput)
          );
          const mt = blockPrev;
          blockPrev = isBlock;
          return <ToolPart t={t} todos={m.todos} blockBefore={mt} />;
        }
        blockPrev = true;
        return (
          <box paddingLeft={3} marginTop={1} flexShrink={0}>
            <Show
              when={!m.isError}
              fallback={<text fg={ui.error}>{String(p.text || "").slice(0, 30000)}</text>}
            >
              <MdText md={String(p.text || "").slice(0, 30000)} />
            </Show>
          </box>
        );
      })}
    </>
  );
}

// Fallback for restored sessions / test fixtures in the old shape: derive the
// parts list from the legacy fields (thinking on top, then tools, then text).
function deriveParts(m: any): any[] {
  const out: any[] = [];
  if (m.thinkingContent || m.thinking) out.push({ type: "reasoning", text: String(m.thinkingContent || ""), thinkMs: m.thinkTime || 0 });
  for (const t of (m.tools || [])) out.push({ type: "tool", tool: t });
  if (m.content) out.push({ type: "text", text: String(m.content) });
  return out;
}

// One reasoning part = its own block, opencode-style. While the turn runs and
// it is the latest reasoning it streams as "⠋ Thinking" with the body LIVE
// below (click collapses it mid-turn); once the model moves on (a tool or text
// part arrives, or the turn ends) it settles to a clickable "+ Thought · Ns"
// line — opencode's minimal mode. Clicking toggles the body in either state.
function ThoughtPart(props: { p: any; i: number; idx: number; live: boolean; open: boolean }) {
  const toggle = () => {
    if (props.live) {
      const closed = new Set(thoughtClosed());
      if (closed.has(props.idx)) closed.delete(props.idx); else closed.add(props.idx);
      setThoughtClosed(closed);
    } else {
      const map = new Map(thoughtExpanded());
      const set = new Set(map.get(props.idx) || []);
      if (set.has(props.i)) set.delete(props.i); else set.add(props.i);
      if (set.size) map.set(props.idx, set); else map.delete(props.idx);
      setThoughtExpanded(map);
    }
  };
  const ms = () => (props.p.thinkMs && props.p.thinkMs >= 1000 ? fmtMs(props.p.thinkMs) : "");
  return (
    <box flexDirection="column" paddingLeft={3} marginTop={1}>
      <text
        fg={ui.thinking}
        onMouseUp={() => toggle()}
        onKeyDown={(e: any) => { if (e.name === "return" || e.name === "space") toggle(); }}
      >
        {props.live ? <ThinkingLabel /> : (props.open ? "- " : "+ ") + "Thought" + (ms() ? " \u00B7 " + ms() : "")}
      </text>
      <Show when={props.open}>
        <box paddingLeft={2}>
          <MdText md={String(props.p.text || "").slice(0, 20000)} />
        </box>
      </Show>
    </box>
  );
}

// Subagent delegation (task tool), opencode-style: one InlineTool row —
// "│ @explore Task" spinning while the child runs, flipping to a muted
// "✓ @explore Task" once done — with the "↳ tool log" and streamed body
// lines beneath, and a "↳ finished · <status>" line at the end.
function SubagentPanel(props: { s: any }) {
  const s = props.s;
  const done = !!s.done;
  const agent = String(s.agent || "");
  return (
    <box flexDirection="column" marginTop={1} paddingLeft={3}>
      {done ? (
        <text fg={ui.fgMuted}>{"\u2713 @" + agent + " Task"}</text>
      ) : (
        <ToolSpinner text={"@" + agent + " Task"} />
      )}
      {s.log ? <text fg={ui.fgMuted}>{"\u21B3 " + s.log}</text> : null}
      {s.text ? <text fg={ui.fg}>{String(s.text)}</text> : null}
      {done ? <text fg={ui.fgMuted}>{"\u21B3 finished \u00B7 " + (s.status || "")}</text> : null}
    </box>
  );
}

// Assistant message, opencode-style: every part streams as its OWN flat block
// at the same left padding (paddingLeft 3) in exact arrival order — reasoning
// ("⠋ Thinking" streaming live, settling to a clickable "+ Thought" once the
// model moves on), tool rows (one per call, "~ Preparing edit..." while
// running, the patch block right where the edit happened when done), and the
// markdown text wherever the model actually said it — so a turn reads like
// "thinks, reads, thinks again, edits, replies" instead of a fixed layout.
// NO bubble; the answer renders as the last text part. After the parts come
// the subagent panel (task tool), leftover diff blocks, "# Todos" block and
// the footer "▣ Loom · 4.2s" once the turn finishes.
function MsgBubble(props: { m: any; idx: number }) {
  const m = props.m;

  if (m.role === "system") {
    return (
      <box marginBottom={1} paddingX={2}>
        <text fg={ui.fgMuted}>{m.content}</text>
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
        <text fg={ui.accent}>{"\u2192  " + first}</text>
      </box>
    );
  }

  const isErr = m.isError;
  const isThink = m.thinking;
  const isStop = m.interrupted;
  const agentTag = m.agentLabel ? "@" + m.agentLabel : null;
  const parts = () => (m.parts && m.parts.length ? m.parts : deriveParts(m));
  const tools = () => parts().filter((p: any) => p.type === "tool").map((p: any) => p.tool)
    .filter((t: any) => !(toolDisplay(t.name).subagent && m.subagent));
  // Diffs already attached to a tool part render inline in that part; anything
  // left over (restored sessions, tests) renders after the parts. Dedupe by
  // stable abs path (the same key App uses to merge diffs), not object
  // identity — copies of the same diff would render twice.
  const partPaths = new Set<string>();
  for (const t of tools()) {
    for (const d of (t.fileDiffs || [])) if (d && d.abs) partPaths.add(String(d.abs));
  }
  const diffless = (m.fileDiffs || []).filter((d: any) => !d || !d.abs || !partPaths.has(String(d.abs)));
  const todoShown = tools().some((t: any) =>
    toolDisplay(t.name).todos && t.status !== "running" && (m.todos?.length));
  return (
    <box flexDirection="column" marginBottom={1} paddingRight={1}>
      <PartList m={m} idx={props.idx} />
      {m.subagent ? <SubagentPanel s={m.subagent} /> : null}
      {diffless.map((d: any) => <DiffBlock d={d} />)}
      {!todoShown && m.todos?.length ? <TodosBlock todos={m.todos} /> : null}
      {!isThink ? (
        <box flexDirection="row" paddingLeft={3} marginTop={1}>
          <text fg={isErr ? ui.error : ui.secondary}>{"\u25A3 " + (agentTag || "Loom")}</text>
          <text fg={ui.fgMuted}>
            {(m.thinkTime ? " \u00B7 " + fmtMs(m.thinkTime) : "") + (isStop ? " \u00B7 interrupted" : "")}
          </text>
        </box>
      ) : null}
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
        scrollbarOptions={{ trackOptions: {} }}
        viewportOptions={{ flexGrow: 1 }}
      >
        {visible().map((m, i) => (
          <MsgBubble m={m} idx={baseIdx() + i} />
        ))}
      </scrollbox>
    </box>
  );
}
