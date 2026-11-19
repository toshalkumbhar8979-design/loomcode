// LoomBar — the composer. In splash mode it is the centered prompt from the
// first screen; docked, it is the persistent prompt at the bottom of the work
// area. Both share editing, suggestions, and the same three status rows.
import { createSignal, createMemo, createEffect, onMount, onCleanup, Show, For } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { GLYPH, palette, contextBar } from "../design.ts";
import {
  input, cursor, selStart, selEnd, clearSelection, setCursor,
  suggestions, autoKind, autoIndex, selectSuggestionAt, pickSuggestionAt, windowFor, moveSuggestionIndex,
  pastedAt, thinking, vimMode, vimNormal, autoPerm, inputMode, sessionUsage, modelName, providerName,
  providerKeyOk, queuedDrafts,
} from "../store.ts";
import { formatUsd } from "../../core/usage.js";

const ui = palette();

export const MODE_NAMES: Record<string, string> = { build: "Act", plan: "Plan", chat: "Chat" };
export const MODE_HINTS: Record<string, string> = { build: "all tools", plan: "read-only", chat: "no tools" };
export const MODE_COLORS: Record<string, string> = { build: ui.primary, plan: ui.accent, chat: ui.secondary };

const POPUP_ROWS = 10;
const MIN_INPUT_HEIGHT = 3;
const MAX_INPUT_HEIGHT = 14;

function wrapWidth(boxWidth: number): number {
  return Math.max(20, Math.floor(boxWidth) - 3);
}
function visualLines(text: string, boxWidth: number): number {
  if (!text) return 1;
  const w = wrapWidth(boxWidth);
  let n = 0;
  for (const ln of text.split("\n")) n += Math.max(1, Math.ceil((ln.length + 1) / w));
  return n;
}
function caretFromMouse(ev: any, text: string, boxWidth: number): number {
  const t: any = ev.target;
  if (!t) return text.length;
  const w = wrapWidth(boxWidth);
  const row = Math.max(0, Number(ev.y) - Number(t.screenY ?? ev.y));
  const col = Math.max(0, Number(ev.x) - Number(t.screenX ?? ev.x));
  let idx = 0;
  let visualRow = 0;
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const segs = Math.max(1, Math.ceil((line.length + 1) / w));
    for (let s = 0; s < segs; s++) {
      if (visualRow === row) {
        const start = s * w;
        return Math.min(text.length, idx + Math.min(line.length - start, Math.max(0, col)));
      }
      visualRow++;
      idx += Math.min(w, Math.max(0, line.length - s * w));
    }
    idx += 1;
  }
  return text.length;
}
let wheelDelta = 0;
let wheelQueued = false;
function onSuggestionWheel(e: any) {
  const dir = e?.scroll?.direction;
  if (dir !== "up" && dir !== "down") return;
  wheelDelta += dir === "up" ? -1 : 1;
  if (wheelQueued) return;
  wheelQueued = true;
  // Coalesce trackpad/wheel bursts into one index update per frame; without
  // this a fast scroll floods the renderer with one full popup update per
  // tiny wheel delta and feels laggy.
  setTimeout(() => {
    wheelQueued = false;
    const d = wheelDelta;
    wheelDelta = 0;
    if (d) moveSuggestionIndex(d);
  }, 16);
}
function rangeHint(start: number, total: number) {
  if (total <= POPUP_ROWS) return "";
  const end = Math.min(start + POPUP_ROWS, total);
  return "  (" + (start + 1) + "-" + end + "/" + total + ")";
}
function count(n: number): string {
  try { return Number(n || 0).toLocaleString("en-US"); } catch { return String(n || 0); }
}

export function LoomBar(props: { splash?: boolean }) {
  const [showCursor, setShowCursor] = createSignal(true);
  const dims = useTerminalDimensions();
  const [measuredW, setMeasuredW] = createSignal(0);
  let boxEl: any = null;
  let blink: any;
  const measureW = () => { if (boxEl && typeof boxEl.width === "number") setMeasuredW(Math.floor(boxEl.width)); };
  onMount(() => { blink = setInterval(() => setShowCursor(v => !v), 530); });
  onCleanup(() => { if (blink) clearInterval(blink); });
  createEffect(() => { dims(); measureW(); });

  const cols = () => Math.max(40, dims().width || 100);
  const splashW = () => Math.max(52, Math.min(88, cols() - 8));
  const fieldW = () => (props.splash ? splashW() : measuredW() || cols());

  let winStart = 0;
  const win = createMemo((prev: any) => {
    const list = suggestions();
    const total = list.length;
    winStart = windowFor(autoIndex(), total, POPUP_ROWS, winStart);
    // Keep the previous object while the selected row is still inside the
    // same 10-row window; otherwise every arrow key would hand For a fresh
    // array and make it diff/re-render all rows.
    if (prev && prev.start === winStart && prev.list === list) return prev;
    return { total, start: winStart, list, items: list.slice(winStart, winStart + POPUP_ROWS) };
  });
  // Stable accessors: the row callbacks must not re-read the whole win() memo
  // (that recreated every row on each arrow key). start only changes when the
  // 10-row window scrolls, so intra-window navigation updates just the
  // highlight spans.
  const winItems = createMemo(() => win().items);
  const winStartIdx = createMemo(() => win().start);
  const winTotal = createMemo(() => win().total);

  const inputLines = createMemo(() => visualLines(input(), fieldW()));
  const pasteCompressed = createMemo(() => pastedAt() > 0 && inputLines() > 10);
  const inputHeight = createMemo(() => {
    // Use VISUAL rows (wrapped text), not just explicit newlines, so a long
    // single-line prompt grows the composer instead of clipping horizontally.
    const l = pasteCompressed() ? 11 : inputLines();
    const capH = Math.max(MIN_INPUT_HEIGHT + 2, Math.floor(((dims().height || 30) * 6) / 10));
    return Math.max(MIN_INPUT_HEIGHT, Math.min(capH, MAX_INPUT_HEIGHT, 2 + l));
  });

  const usage = () => {
    const sess = sessionUsage();
    const pct = Math.max(0, Math.min(100, Math.round(sess.pct)));
    const color = pct >= 90 ? ui.error : pct >= 70 ? ui.warning : ui.success;
    return { pct, color, bar: contextBar(pct, 10), tokens: count(sess.tokens), cost: formatUsd(sess.cost) };
  };

  const modelLine = () => {
    const model = modelName() || "default";
    const prov = providerName() ? " (" + providerName() + ")" : "";
    return model + prov;
  };

  const modeTag = (id: string) => {
    const active = inputMode() === id;
    return { id, label: MODE_NAMES[id] || id, active, color: active ? (MODE_COLORS[id] || ui.primary) : ui.fgMuted };
  };

  const statusRows = (width: number) => {
    const u = usage();
    const modes = ["plan", "build", "chat"].map(modeTag);
    const cwd = process.cwd().replace(/\\/g, "/");
    const auto = autoPerm();
    const vim = vimMode() ? (vimNormal() ? "-- NORMAL --" : "INSERT") : "";
    const held = thinking() && input().trim() ? "held" : "";
    const queued = queuedDrafts().length ? queuedDrafts().length + " queued" : "";
    const extras = [vim, held, queued].filter(Boolean).join(" · ");
    return (
      <box flexDirection="column" width={width} flexShrink={0} paddingX={1}>
        <box flexDirection="row" height={1}>
          <text fg={ui.fgDim}>{modelLine()}</text>
          <box flexGrow={1} />
          <For each={modes}>{(m: any) => (
            <text fg={m.active ? m.color : ui.fgMuted}>
              {(m.active ? GLYPH.circleFilled : GLYPH.circle) + " " + m.label + "  "}
            </text>
          )}</For>
          <text fg={ui.fgMuted}>{"(Tab)"}</text>
        </box>
        <box flexDirection="row" height={1}>
          <text>
            <span style={{ fg: u.color }}>{u.bar}</span>
            <span style={{ fg: ui.fgDim }}>{" (" + u.tokens + " ctx) "}</span>
            <span style={{ fg: ui.fgDim }}>{u.cost}</span>
            <span style={{ fg: ui.fgMuted }}>{extras ? "  · " + extras : ""}</span>
          </text>
          <box flexGrow={1} />
          <text fg={ui.fgMuted}>{thinking() ? "working" : "ctrl+p menu"}</text>
        </box>
        <text fg={ui.fg} height={1}>{cwd.length > width - 2 ? GLYPH.ellipsis + cwd.slice(-(width - 3)) : cwd}</text>
        <text fg={auto ? ui.success : ui.fgMuted} height={1}>
          {auto ? ">> Auto-approve all enabled (Shift+Tab)" : ">> Auto-approve off (Shift+Tab)"}
        </text>
        <Show when={!providerKeyOk()}>
          <text fg={ui.warning} height={1}>{">> No API key — run /connect"}</text>
        </Show>
      </box>
    );
  };

  return (
    <box flexDirection="column" flexShrink={0} alignItems={props.splash ? "center" : undefined} paddingBottom={props.splash ? 1 : 0}>
      <Show when={suggestions().length > 0 && autoKind() !== "none"}>
        <box width={props.splash ? splashW() : undefined} paddingX={1} flexDirection="column" backgroundColor={ui.bgPanel} onMouseScroll={onSuggestionWheel}>
          <text fg={ui.fgMuted}>
            {autoKind() === "slash"
              ? "  ↑↓ nav  tab/enter pick  wheel/click  esc close" + rangeHint(winStartIdx(), winTotal())
              : ""}
          </text>
          <For each={winItems()}>{(item: any, i: any) => {
            const abs = () => winStartIdx() + i();
            const act = () => abs() === autoIndex();
            return (
              <box flexDirection="row" backgroundColor={act() ? ui.bgPanelAlt : undefined}
                onMouseDown={() => { selectSuggestionAt(abs()); pickSuggestionAt(abs()); }} onMouseUp={() => pickSuggestionAt(abs())}>
                <text fg={act() ? ui.primary : ui.fgDim}>{(act() ? GLYPH.pointer + " " : "  ") + (autoKind() === "slash" ? String(item.label).split(" ")[0] : String(item.label))}</text>
                <Show when={!!item.desc}>
                  <text fg={act() ? ui.fg : ui.fgMuted}>{"  " + item.desc}</text>
                </Show>
              </box>
            );
          }}</For>
          <Show when={autoKind() !== "slash"}>
            <text fg={ui.fgMuted}>{"  ↑↓ nav  tab/enter pick  wheel/click  esc close" + rangeHint(winStartIdx(), winTotal())}</text>
          </Show>
        </box>
      </Show>

      <box width={props.splash ? splashW() : undefined} flexDirection="column" flexShrink={0}>
        <text height={1} flexShrink={0}>
          <span style={{ fg: ui.primary }}>{"─".repeat(14)}</span>
          <span style={{ fg: ui.border }}>{"─".repeat(Math.max(0, fieldW() - 14))}</span>
        </text>

        <box
          ref={(r: any) => { boxEl = r; setTimeout(measureW, 0); }}
          paddingX={1} flexDirection="column"
          height={inputHeight()}
          backgroundColor={ui.bgInput}
        >
          <Show when={input().length > 0} fallback={
            <box flexGrow={1} flexDirection="column" justifyContent="center">
              <text>
                <span style={{ fg: ui.primary }}>{"> "}</span>
                <span style={{ fg: showCursor() ? ui.primary : ui.bgInput }}>{"█"}</span>
                <span style={{ fg: ui.fgMuted }}>{"Ask anything..."}</span>
              </text>
            </box>
          }>{(() => {
            const v = input();
            if (pasteCompressed()) {
              return (
                <box flexDirection="column">
                  <text fg={ui.fg}>{v.split("\n").slice(0, 10).join("\n")}</text>
                  <text fg={ui.fgMuted}>{"... (pasted ~" + inputLines() + " lines — keep typing to expand)"}</text>
                </box>
              );
            }
            const p = Math.max(0, Math.min(cursor(), v.length));
            const ss = selStart();
            const se = selEnd();
            const hasSel = ss >= 0 && se > ss;
            const pts = Array.from(new Set(
              [0, p, Math.min(p + 1, v.length), hasSel ? ss : -1, hasSel ? se : -1, v.length]
                .filter(x => x >= 0 && x <= v.length)
            )).sort((a: number, b: number) => a - b);
            const segs: Array<{ text: string; sel: boolean }> = [];
            for (let i = 0; i < pts.length - 1; i++) {
              const a = pts[i], b = pts[i + 1];
              if (b <= a) continue;
              segs.push({ text: v.slice(a, b), sel: hasSel && a >= ss && b <= se });
            }
            const cursorInSel = hasSel && p >= ss && p < se;
            return (
              <box flexDirection="column" flexGrow={1}
                onMouseDown={(ev: any) => { clearSelection(); setCursor(caretFromMouse(ev, input(), fieldW())); }}
              >
                <text fg={ui.fg}>
                  <span style={{ fg: ui.primary }}>{"> "}</span>
                  {segs.map((g) => g.sel ? (
                    <span style={{ fg: ui.bgPanel, bg: ui.primary }}>{g.text}</span>
                  ) : (
                    <span>{g.text}</span>
                  ))}
                  <span style={{ fg: cursorInSel ? (showCursor() ? ui.bgPanel : ui.primary) : (showCursor() ? ui.primary : ui.bgInput), bg: cursorInSel ? ui.primary : undefined }}>
                    {"█"}
                  </span>
                </text>
              </box>
            );
          })()}
          </Show>
        </box>

        <text height={1} flexShrink={0} fg={ui.border}>{hairlineFor(fieldW())}</text>
      </box>

      {statusRows(props.splash ? splashW() : fieldW())}
    </box>
  );
}

function hairlineFor(w: number): string {
  return "─".repeat(Math.max(1, Math.floor(w)));
}
