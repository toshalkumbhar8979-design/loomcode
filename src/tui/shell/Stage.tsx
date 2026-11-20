// Stage — the conversation. User prompts are full-width bars, replies are
// content-forward markdown under a single `*` mark, and tools are compact
// bordered blocks that stream their output live while they run.
import { createSignal, createMemo, onMount, onCleanup, Show, For } from "solid-js";
import { GLYPH, SPIN, TICK_MS, palette, topRule, botRule, fmtMs, fit } from "../design.ts";
import { Md, highlightCode, codeColor } from "../markdown.tsx";
import {
  showThinking, userExpandedIdx, setUserExpandedIdx,
  thoughtClosed, setThoughtClosed, thoughtExpanded, setThoughtExpanded,
} from "../store.ts";
import { toolDisplay } from "../toolkit.ts";
import { stripAnsi } from "../toolname.ts";
import { formatDiffCount, toSideBySide } from "../../core/file-diffs.js";

const ui = palette();

export const PER_LINE = 96;
export const USER_PREVIEW_LINES = 12;
const USER_PREVIEW_CHARS = 2400;

export function estVisualLines(text: any) {
  if (!text) return 1;
  let n = 0;
  for (const ln of String(text).split("\n")) n += Math.max(1, Math.ceil((ln.length + 1) / PER_LINE));
  return n;
}

function termCols(): number {
  return Math.max(40, (process.stdout?.columns || 100) | 0);
}
function blockW(): number {
  return Math.max(28, termCols() - 6);
}
function clean(s: any): string {
  return stripAnsi(String(s == null ? "" : s))
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}
function tail(text: string, n: number): string[] {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - n));
}

function Spin(props: { text?: string; fg?: string }) {
  const [t, setT] = createSignal(0);
  let h: any;
  onMount(() => { h = setInterval(() => setT(v => v + 1), TICK_MS); });
  onCleanup(() => { if (h) clearInterval(h); });
  return <text fg={props.fg || ui.warning}>{SPIN[t() % SPIN.length] + (props.text ? " " + props.text : "")}</text>;
}

function UserTurn(props: { m: any; idx: number }) {
  const content = () => clean(props.m.content);
  const lines = () => estVisualLines(content());
  const big = () => lines() > USER_PREVIEW_LINES;
  const expanded = () => userExpandedIdx() === props.idx;
  const toggle = () => setUserExpandedIdx(expanded() ? null : props.idx);
  const shown = () => {
    if (!big() || expanded()) return content();
    return content().split("\n").slice(0, USER_PREVIEW_LINES).join("\n").slice(0, USER_PREVIEW_CHARS);
  };
  return (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      <box flexDirection="column" backgroundColor={ui.bgMsg} paddingX={1} onMouseUp={big() ? toggle : undefined}>
        <For each={shown().split("\n")}>{(ln: string, i: any) => (
          <text fg={ui.fg}>
            <span style={{ fg: ui.primary }}>{i() === 0 ? "> " : "  "}</span>
            {ln || " "}
          </text>
        )}</For>
        <Show when={big()}>
          <text fg={ui.fgMuted}>{GLYPH.ellipsis + " " + lines() + " lines — " + (expanded() ? "collapse" : "expand") + " (click or ctrl+e)"}</text>
        </Show>
      </box>
    </box>
  );
}

function diffLang(file: string): string {
  const base = String(file || "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function clipCode(tokens: any[], width: number): any[] {
  if (width <= 0) return [];
  const out: any[] = [];
  let left = width;
  for (const t of tokens) {
    if (left <= 0) break;
    if (t.text.length <= left) {
      out.push(t);
      left -= t.text.length;
    } else {
      if (left > 1) out.push({ text: t.text.slice(0, left - 1), style: t.style });
      out.push({ text: GLYPH.ellipsis, style: "plain" });
      break;
    }
  }
  return out;
}

function DiffCell(props: { ln: any; colW: number; lang: string }) {
  const ln = props.ln;
  const kind = ln?.kind || "";
  const marker = kind === "del" ? "- " : kind === "add" ? "+ " : "  ";
  const avail = Math.max(0, props.colW - marker.length);
  const raw = ln ? clean(ln.text).replace(/\n$/, "") : "";
  const toks = ln ? clipCode(highlightCode(raw, props.lang)[0] || [], avail) : [];
  const used = toks.reduce((n: number, t: any) => n + t.text.length, 0);
  const pad = Math.max(0, avail - used);
  const markerColor = kind === "del" ? ui.error : kind === "add" ? ui.success : ui.fgMuted;
  const bg = kind === "del" ? ui.bgDiffDel : kind === "add" ? ui.bgDiffAdd : undefined;
  return (
    <text width={props.colW} bg={bg}>
      <span style={{ fg: markerColor }}>{marker}</span>
      {toks.map((t: any) => <span style={{ fg: codeColor(t.style) }}>{t.text}</span>)}
      <span>{" ".repeat(pad)}</span>
    </text>
  );
}

function PatchBlock(props: { d: any; toolName?: string }) {
  const d = props.d;
  if (!d) return null;
  const W = Math.max(20, blockW() - 2);
  const divider = " " + GLYPH.bar + " ";
  const colW = Math.max(8, Math.floor((W - divider.length) / 2));
  const lang = diffLang(d.path);
  const verb = d.isNew ? "wrote " : props.toolName === "edit" ? "edit " : "patch ";
  const head = verb + (d.path || "");
  return (
    <box flexDirection="column" marginTop={1} marginBottom={1} flexShrink={0} backgroundColor={ui.bgPanelAlt} paddingX={1}>
      <text fg={ui.border} height={1}>{topRule(W, undefined, { left: GLYPH.markOpen + " " + head, right: formatDiffCount(d) })}</text>
      <For each={toSideBySide(d.lines || [])}>{(row: any) => (
        <box flexDirection="row">
          <DiffCell ln={row.left} colW={colW} lang={lang} />
          <text fg={ui.border}>{divider}</text>
          <DiffCell ln={row.right} colW={colW} lang={lang} />
        </box>
      )}</For>
      <text fg={ui.border} height={1}>{botRule(W)}</text>
    </box>
  );
}

function TodoBlock(props: { todos: any[] }) {
  const W = blockW();
  return (
    <box flexDirection="column" marginTop={1} marginBottom={1} flexShrink={0}>
      <text fg={ui.border} height={1}>{topRule(W, "tasks")}</text>
      <For each={props.todos}>{(t: any) => (
        <text fg={t.inProgress ? ui.accent : t.done ? ui.fgMuted : ui.fgDim} paddingLeft={2}>
          {"[" + (t.done ? GLYPH.check : t.cancelled ? GLYPH.cross : t.inProgress ? GLYPH.dotFilled : " ") + "] " + String(t.text || "")}
        </text>
      )}</For>
      <text fg={ui.border} height={1}>{botRule(W)}</text>
    </box>
  );
}

function OutputBlock(props: { title: string; body: string; maxLines: number; live?: boolean; error?: boolean }) {
  const [expanded, setExpanded] = createSignal(false);
  const body = () => clean(props.body);
  const lines = () => body().split("\n");
  const overflow = () => lines().length > props.maxLines;
  const toggle = () => setExpanded(v => !v);
  const visible = () => expanded() ? lines() : lines().slice(0, props.maxLines);
  const color = () => (props.error ? ui.error : ui.fgDim);
  return (
    <box flexDirection="column" marginTop={0} marginBottom={1} flexShrink={0}
      onMouseUp={overflow() ? toggle : undefined}>
      <text fg={ui.fgMuted} height={1}>
        {GLYPH.bar + " " + props.title + (props.live ? "  · streaming" : "")}
      </text>
      <For each={visible()}>{(l: string) => (
        <text fg={color()} paddingLeft={2}>{GLYPH.bar + " " + (l || " ")}</text>
      )}</For>
      <Show when={overflow()}>
        <text fg={ui.fgMuted} paddingLeft={2}>
          {GLYPH.bar + " " + GLYPH.ellipsis + " " + (expanded() ? "collapse" : (lines().length - props.maxLines) + " more — click")}
        </text>
      </Show>
    </box>
  );
}

function ToolRow(props: { t: any; todos?: any[] }) {
  const t = props.t;
  const d = toolDisplay(t.name);
  const diffs = t.fileDiffs || [];
  const label = () => clean(t.label || d.label({}) || t.name);
  const runningLabel = () => {
    if (t.name !== "write" && t.name !== "edit") return label();
    const pending = clean(t.pending || d.pending || "Preparing change...");
    const file = clean(t.label || "").replace(/^(?:Write|Edit)\s+/i, "");
    return pending + (file ? "  " + file : "");
  };
  if (d.todos && t.status !== "running" && props.todos?.length) return <TodoBlock todos={props.todos} />;
  if (d.diff && t.status !== "running" && diffs.length) {
    return <box flexDirection="column" flexShrink={0}>{diffs.map((d2: any) => <PatchBlock d={d2} toolName={t.name} />)}</box>;
  }
  if (t.status === "running") {
    const live = clean(t.liveOutput || "");
    return (
      <box flexDirection="column" paddingLeft={2} marginTop={1} flexShrink={0}>
        <box flexDirection="row">
          <Spin text={runningLabel()} fg={ui.warning} />
          <Show when={!!live}>
            <text fg={ui.fgMuted}>{"  · " + live.split("\n").length + " lines"}</text>
          </Show>
        </box>
        <Show when={!!live}>
          <box flexDirection="column" backgroundColor={ui.bgPanel} paddingX={1} marginTop={0}>
            <For each={tail(live, d.block?.maxLines || 10)}>{(l: string) => (
              <text fg={ui.fgDim}>{l || " "}</text>
            )}</For>
          </box>
        </Show>
      </box>
    );
  }
  if (t.status === "error") {
    return (
      <box flexDirection="column" paddingLeft={2} marginTop={1} flexShrink={0}>
        <text fg={ui.error}>{GLYPH.cross + " " + label()}</text>
        <Show when={!!t.output}>
          <OutputBlock title="" body={t.output} maxLines={d.block?.maxLines || 8} error />
        </Show>
      </box>
    );
  }
  if (t.output && d.block) {
    return (
      <box flexDirection="column" paddingLeft={2} marginTop={1} flexShrink={0}>
        <text fg={ui.success}>{GLYPH.check + " " + label()}</text>
        <OutputBlock title={d.block.title(t)} body={t.output} maxLines={d.block.maxLines || 10} />
      </box>
    );
  }
  return (
    <box flexDirection="row" paddingLeft={2} marginTop={1} flexShrink={0}>
      <text fg={ui.success}>{GLYPH.check + " "}</text>
      <text fg={ui.fgDim}>{label()}</text>
    </box>
  );
}

function ThoughtRow(props: { p: any; m: any; idx: number; partIdx: number }) {
  const running = () => !!props.m.thinking;
  const isOpen = () => {
    if (thoughtExpanded().get(props.idx)?.has(props.partIdx)) return true;
    if (thoughtClosed().has(props.idx)) return false;
    return running() && showThinking();
  };
  const toggle = () => {
    const open = isOpen();
    setThoughtExpanded((prev: Map<number, Set<number>>) => {
      const next = new Map(prev);
      const set = new Set(next.get(props.idx) || []);
      if (open) set.delete(props.partIdx);
      else set.add(props.partIdx);
      if (set.size) next.set(props.idx, set);
      else next.delete(props.idx);
      return next;
    });
    setThoughtClosed((prev: Set<number>) => {
      const next = new Set(prev);
      if (open) next.add(props.idx);
      else next.delete(props.idx);
      return next;
    });
  };
  const text = () => clean(props.p.text || "");
  const preview = () => {
    const t = text();
    const first = t.split("\n").slice(0, 3).join("\n");
    return first.length > 900 ? first.slice(0, 900) + GLYPH.ellipsis : first;
  };
  const body = () => {
    const t = text();
    if (!t) return running() ? "waiting for the model..." : "";
    return isOpen() ? t.slice(0, 20000) + (t.length > 20000 ? "\n" + GLYPH.ellipsis : "") : preview();
  };
  const long = () => text().length > 900 || text().split("\n").length > 3;
  const ms = () => Number(props.p.thinkMs || 0);
  const header = () => {
    const elapsed = ms() > 0 ? "  " + fmtMs(ms()) : "";
    return "* Thinking" + elapsed;
  };
  return (
    <box flexDirection="column" paddingLeft={2} marginTop={1} flexShrink={0} onMouseUp={toggle}>
      <text fg={ui.thinking}>{header() + (running() || long() ? "  (click to " + (isOpen() ? "collapse" : "expand") + ")" : "")}</text>
      <Show when={!!body()}>
        <text fg={ui.fgDim} paddingLeft={2}>{body()}</text>
      </Show>
    </box>
  );
}

function SubagentRow(props: { s: any }) {
  const s = props.s;
  const done = !!s.done;
  return (
    <box flexDirection="column" paddingLeft={2} marginTop={1} flexShrink={0}>
      <Show when={!done} fallback={<text fg={ui.fgMuted}>{"⋔ @" + String(s.agent || "") + " · finished"}</text>}>
        <box flexDirection="row"><Spin text={"@" + String(s.agent || "") + " delegating"} fg={ui.warning} /></box>
      </Show>
      {s.log ? <text fg={ui.fgMuted} paddingLeft={2}>{GLYPH.bar + " " + clean(s.log)}</text> : null}
      {s.text ? <text fg={ui.fgDim} paddingLeft={2}>{clean(s.text)}</text> : null}
    </box>
  );
}

function deriveParts(m: any): any[] {
  const out: any[] = [];
  if (m.thinkingContent || m.thinking) out.push({ type: "reasoning", text: String(m.thinkingContent || ""), thinkMs: m.thinkTime || 0 });
  for (const t of (m.tools || [])) out.push({ type: "tool", tool: t });
  if (m.content) out.push({ type: "text", text: String(m.content) });
  return out;
}

function PartFlow(props: { m: any; idx: number }) {
  const m = props.m;
  const parts = () => (m.parts && m.parts.length ? m.parts : deriveParts(m));
  return (
    <For each={parts()}>{(p: any, partIdx: any) => {
      if (p.type === "reasoning") {
        return <ThoughtRow p={p} m={m} idx={props.idx} partIdx={partIdx()} />;
      }
      if (p.type === "tool") return <ToolRow t={p.tool} todos={m.todos} />;
      const text = String(p.text || "").slice(0, 30000);
      if (!text) return null;
      return (
        <box flexDirection="row" marginTop={1} flexShrink={0}>
          <text fg={m.isError ? ui.error : ui.primary}>{"* "}</text>
          <box flexGrow={1}>
            <Show when={!m.isError} fallback={<text fg={ui.error}>{text}</text>}>
              <Md md={text} />
            </Show>
          </box>
        </box>
      );
    }}</For>
  );
}

function AssistantTurn(props: { m: any; idx: number }) {
  const m = props.m;
  if (m.role === "system") {
    return (
      <box flexDirection="column" marginTop={1} paddingLeft={1} flexShrink={0}>
        <For each={String(m.content || "").split("\n")}>{(ln: string) => (
          <text fg={ui.fgMuted}>{GLYPH.dot + " " + ln}</text>
        )}</For>
      </box>
    );
  }
  if (m.role === "user") return <UserTurn m={m} idx={props.idx} />;
  if (m.role === "tool") {
    const first = String(m.content || "").split("\n")[0].slice(0, 140);
    return <box marginTop={1} paddingLeft={2} flexShrink={0}><text fg={ui.accent}>{GLYPH.arrow + " " + first}</text></box>;
  }

  const tools = () => (m.parts && m.parts.length ? m.parts : deriveParts(m))
    .filter((p: any) => p.type === "tool").map((p: any) => p.tool)
    .filter((t: any) => !(toolDisplay(t.name).subagent && m.subagent));
  const partPaths = new Set<string>();
  for (const t of tools()) {
    for (const d of (t.fileDiffs || [])) if (d && d.abs) partPaths.add(String(d.abs));
  }
  const diffless = (m.fileDiffs || []).filter((d: any) => !d || !d.abs || !partPaths.has(String(d.abs)));
  const todoShown = tools().some((t: any) => toolDisplay(t.name).todos && t.status !== "running" && (m.todos?.length));
  return (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      <Show when={!!m.agentLabel}>
        <text fg={ui.secondary} paddingLeft={2}>{"@" + m.agentLabel}</text>
      </Show>
      <PartFlow m={m} idx={props.idx} />
      {m.subagent ? <SubagentRow s={m.subagent} /> : null}
      {diffless.map((d: any) => <PatchBlock d={d} />)}
      {!todoShown && m.todos?.length ? <TodoBlock todos={m.todos} /> : null}
      <Show when={m.interrupted}>
        <text fg={ui.fgMuted} paddingLeft={2} marginTop={1}>{"* interrupted — partial response kept"}</text>
      </Show>
    </box>
  );
}

export function Stage(props: { messages?: () => any[]; thinking?: boolean }) {
  const visible = () => (props.messages?.() || []).slice(-60);
  const baseIdx = () => Math.max(0, (props.messages?.() || []).length - 60);
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <scrollbox
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        scrollbarOptions={{ trackOptions: {} }}
        viewportOptions={{ flexGrow: 1 }}
      >
        <For each={visible()}>{(m: any, i: any) => (
          <AssistantTurn m={m} idx={baseIdx() + i()} />
        )}</For>
      </scrollbox>
    </box>
  );
}
