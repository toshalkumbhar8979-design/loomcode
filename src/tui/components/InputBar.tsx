// InputBar -- input line + autocomplete popup. All signal reads inside JSX for reactivity.
import { onMount, onCleanup, createSignal, createMemo, createEffect, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { palette } from "../theme.ts";
import { PermissionPopup } from "./PermissionPopup.tsx";
import {
  input, cursor, setCursor, thinking, suggestions, autoIndex, autoKind,
  inputMode, sessionUsage, modelName,
  selectSuggestionAt, moveSuggestionIndex, pickSuggestionAt, windowFor,
  selStart, selEnd, clearSelection, pastedAt, autoPerm,
  vimMode, vimNormal,
} from "../store.ts";
import { formatTokens, formatUsd } from "../../core/usage.js";
import { loadConfig } from "../../config/settings.js";

const ui = palette("loom");
const MODE_NAMES: Record<string, string> = { build: "Build", plan: "Plan", chat: "Chat" };
const MODE_HINTS: Record<string, string> = { build: "all tools", plan: "read-only", chat: "no tools" };
const MODE_COLORS: Record<string, string> = { build: ui.primary, plan: ui.primarySoft, chat: ui.warning };
const POPUP_ROWS = 10;

function onSuggestionWheel(e: any) {
  const dir = e?.scroll?.direction;
  if (dir === "up") moveSuggestionIndex(-1);
  else if (dir === "down") moveSuggestionIndex(1);
}

function rangeHint(start: number, total: number) {
  if (total <= POPUP_ROWS) return "";
  const end = Math.min(start + POPUP_ROWS, total);
  return "  (" + (start + 1) + "-" + end + "/" + total + ")";
}

// The chatbox grows with its content: header row (badges) + scrollable content
// rows + a mode row ("Build") at the bottom. No border â€” borderless panels
// keep the UI grid-line-free (box-drawing chars also snag text selection).
const MIN_INPUT_HEIGHT = 5;               // roomy resting box (splash included)
const MAX_INPUT_HEIGHT = 16;              // grows line-by-line, then scrolls

// Wrap width used for counting: the text's real content width is the box
// width minus paddingX={1} on each side, snapped DOWN to an integer so the
// count never underestimates (the box never clips text and the height never
// oscillates â€” no vibration). The measured width is integer-stable too.
function wrapWidth(boxWidth: number): number {
  return Math.max(20, Math.floor(boxWidth) - 2);
}

function visualLines(text: string, boxWidth: number): number {
  if (!text) return 1;
  const w = wrapWidth(boxWidth);
  let n = 0;
  for (const ln of text.split("\n")) {
    n += Math.max(1, Math.ceil((ln.length + 1) / w));
  }
  return n;
}

// Map a click position inside the wrapped text to a character index. The
// click's (x, y) are terminal coords; the text's screenX/screenY mark its
// first row. Wrap math matches visualLines() so the caret lands where the
// user pointed even for multi-line, wrapped drafts.
function caretFromMouse(ev: any, text: string, boxWidth: number): number {
  const t: any = ev.target;
  if (!t) return text.length;
  // Same wrap width as visualLines() so the caret lands where the user
  // pointed even for multi-line, wrapped drafts.
  const w = wrapWidth(boxWidth);
  const row = Math.max(0, Number(ev.y) - Number(t.screenY ?? ev.y));
  const col = Math.max(0, Number(ev.x) - Number(t.screenX ?? ev.x));
  // Walk the draft line-by-line, consuming wrapped segments, and find the row
  // the user clicked in.
  let idx = 0;
  let visualRow = 0;
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const segs = Math.max(1, Math.ceil((line.length + 1) / w));
    for (let s = 0; s < segs; s++) {
      if (visualRow === row) {
        const start = s * w;
        return Math.min(text.length, idx + Math.min(line.length - start, col));
      }
      visualRow++;
      idx += Math.min(w, line.length - s * w) <= 0 ? 0 : Math.min(w, line.length - s * w);
    }
    idx += 1; // the "\n"
  }
  return text.length;
}

export function InputBar() {
  const [showCursor, setShowCursor] = createSignal(true);
  const dims = useTerminalDimensions();
  // The chatbox's real width differs from the terminal width on the splash
  // screen (where it sits inside a fixed 74-col container). visualLines()
  // must use the rendered box width â€” measured post-layout and re-measured
  // when the terminal resizes (never per frame, so the height can't
  // oscillate; a per-frame measurement was the source of the whole-screen
  // vibration).
  const [measuredW, setMeasuredW] = createSignal(0);
  let boxEl: any = null;
  let blink: any;
  const measureW = () => { if (boxEl && typeof boxEl.width === "number") setMeasuredW(Math.floor(boxEl.width)); };

  onMount(() => { blink = setInterval(() => setShowCursor(v => !v), 530); });
  onCleanup(() => { if (blink) clearInterval(blink); });
  // The box width follows the terminal: re-measure whenever the terminal
  // dimensions change so visualLines()/status truncation track the live width.
  // (Only on resize events â€” never per frame, so no height oscillation.)
  createEffect(() => { dims(); measureW(); });

  let winStart = 0;
  const slashWin = createMemo(() => {
    const total = suggestions().length;
    winStart = windowFor(autoIndex(), total, POPUP_ROWS, winStart);
    return { total, start: winStart, items: suggestions().slice(winStart, winStart + POPUP_ROWS) };
  });
  const fileWin = createMemo(() => {
    const total = suggestions().length;
    winStart = windowFor(autoIndex(), total, POPUP_ROWS, winStart);
    return { total, start: winStart, items: suggestions().slice(winStart, winStart + POPUP_ROWS) };
  });

  // Chatbox height: header row + clamped content rows + mode row. A pasted
  // draft past 10 lines renders COMPRESSED (first lines + "pasted ~N lines"),
  // so the box stays compact instead of hitting the scroll cap.
  const effectiveW = () => measuredW() || dims().width || 100;
  const inputLines = createMemo(() => visualLines(input(), effectiveW()));
  const pasteCompressed = createMemo(() => pastedAt() > 0 && inputLines() > 10);
  // OpenCode-style growth: height tracks LOGICAL newlines, not soft-wrapped
  // rows. Typing mid-line never changes the height (zero jitter); the box
  // gains one row per Enter until the cap, and only then does text wrap
  // inside the fixed-height box.
  const logicalLines = createMemo(() => {
    if (pasteCompressed()) return 11;
    const v = input();
    let n = 1;
    for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) === 10) n++;
    return n;
  });
  const inputHeight = createMemo(() => {
    const l = logicalLines();
    // OpenCode-style: the editor claims what it needs up to ~60% of the
    // terminal; the chat area above absorbs the rest. No inner scrollbars.
    const capH = Math.max(MIN_INPUT_HEIGHT + 2, Math.floor(((dims().height || 30) * 6) / 10));
    return Math.max(MIN_INPUT_HEIGHT, Math.min(capH, 2 + l));
  });

  // One-line status under the chatbox, opencode-style: cwd Â· usage Â· hint.
  // The row is as wide as the chatbox itself (measured box width), so the
  // cwd truncates instead of the line wrapping.
  const statusLine = () => {
    const sess = sessionUsage();
    const usage = formatTokens(sess.tokens) + " (" + Math.round(sess.pct) + "%) \u00B7 " + formatUsd(sess.cost);
    const held = thinking() && input().trim() ? " \u00B7 \u23F3 held" : "";
    const autoTag = autoPerm() ? " \u00B7 auto" : "";
    const vimTag = vimMode() ? (vimNormal() ? " \u00B7 -- NORMAL --" : " \u00B7 INSERT") : "";
    // Optional template override (config.statusLine): {model} {cost} {tokens}
    // {mode} {cwd} placeholders. Config is cached (1.5s TTL) — reading it on
    // every keystroke stalls the renderer and desyncs mouse hit-testing.
    let tmpl: string = "";
    try {
      const nowMs = Date.now();
      const g = globalThis as any;
      if (!g.__loomStatusTmpl || nowMs - g.__loomStatusAt > 1500) {
        g.__loomStatusTmpl = String(loadConfig().statusLine || "");
        g.__loomStatusAt = nowMs;
      }
      tmpl = g.__loomStatusTmpl;
    } catch {}
    let right: string;
    if (tmpl.trim()) {
      right = tmpl
        .replace(/\{model\}/g, modelName())
        .replace(/\{cost\}/g, formatUsd(sess.cost))
        .replace(/\{tokens\}/g, formatTokens(sess.tokens))
        .replace(/\{cwd\}/g, process.cwd())
        .replace(/\{mode\}/g, inputMode());
    } else {
      right = usage + held + autoTag + vimTag + "  \u00B7  ctrl+p commands";
    }
    const avail = Math.max(20, effectiveW() - 2);
    const maxCwd = Math.max(8, avail - right.length - 2);
    const cwd = process.cwd();
    const cwdStr = cwd.length > maxCwd ? "\u2026" + cwd.slice(-(maxCwd - 1)) : cwd;
    return { cwd: cwdStr, right };
  };

  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={suggestions().length > 0 && autoKind() === "slash"}>
        <box
          border borderStyle="rounded" borderColor={ui.accent}
          paddingX={1} paddingY={0}
          flexDirection="column" marginBottom={0}
          backgroundColor={ui.bgPanel}
          onMouseScroll={onSuggestionWheel}
        >
          <text fg={ui.fgMuted}>
            {"  \u2191\u2193 nav  TAB/ENTER pick  wheel/click  ESC close" + rangeHint(slashWin().start, slashWin().total)}
          </text>
          {slashWin().items.map((item, i) => {
            const abs = slashWin().start + i;
            return (
              <box
 flexDirection="row" paddingY={0}
                onMouseDown={() => selectSuggestionAt(abs)}
                onMouseUp={() => pickSuggestionAt(abs)}
              >
                <text fg={abs === autoIndex() ? ui.primary : ui.fgDim}>
                  {(abs === autoIndex() ? "\u25B6 " : "   ") + item.label.split(" ")[0]}
                </text>
                <Show when={!!item.desc}>
                  <text fg={abs === autoIndex() ? ui.fg : ui.fgMuted}>
                    {"  " + item.desc}
                  </text>
                </Show>
              </box>
            );
          })}
        </box>
      </Show>

      <Show when={suggestions().length > 0 && autoKind() !== "slash"}>
        <box
          border borderStyle="rounded" borderColor={ui.accent}
          paddingX={1} flexDirection="column" marginBottom={0}
          backgroundColor={ui.bgInput}
          onMouseScroll={onSuggestionWheel}
        >
          {fileWin().items.map((item, i) => {
            const abs = fileWin().start + i;
            return (
              <text

                fg={abs === autoIndex() ? ui.primary : ui.fgDim}
                onMouseDown={() => selectSuggestionAt(abs)}
                onMouseUp={() => pickSuggestionAt(abs)}
              >
                {(abs === autoIndex() ? ">  " : "   ") + item.label}
              </text>
            );
          })}
          <text fg={ui.fgMuted}>{"  UP/DN TAB/ENTER pick  wheel/click  ESC close" + rangeHint(fileWin().start, fileWin().total)}</text>
        </box>
      </Show>

      <PermissionPopup />

      <box
        ref={(r: any) => { boxEl = r; setTimeout(measureW, 0); }}
        paddingX={1} paddingY={0}
        flexDirection="column"
        backgroundColor={ui.bgInput}
        height={inputHeight()}
      >
        <box flexDirection="row" alignItems="center" gap={1} flexShrink={0} height={1}>
          <Show when={pasteCompressed()}>
            <text fg={ui.warning} flexGrow={1}>{"pasted ~" + inputLines() + " lines \u00B7 Shift+Enter newline"}</text>
          </Show>
          <Show when={!pasteCompressed() && inputLines() > 1}>
            <text fg={ui.fgMuted} flexGrow={1}>{"~" + inputLines() + " lines \u00B7 Shift+Enter newline"}</text>
          </Show>
          <Show when={thinking()}>
            <text fg={ui.warning}>{"\u25C6"}</text>
          </Show>
        </box>
        <Show
          when={input().length > 0}
          fallback={
            <box flexGrow={1} flexDirection="column" justifyContent="center">
              <text>
                {/* @ts-ignore OpenTUI text nodes take fg/bg via the style prop (TextNodeOptions), not as direct props */}
                <span style={{ fg: showCursor() ? ui.fgMuted : ui.bgInput }}>{"\u2588"}</span>
                <span style={{ fg: ui.fgMuted }}>{" Ask anything...  /commands  @file  !shell"}</span>
              </text>
            </box>
          }
        >
          {(() => {
            // A freshly-pasted draft past 10 lines renders as a compact
            // preview (first 10 lines + a "pasted ~N lines" note) â€” the full
            // text is still in input() and sends untouched. Any edit expands.
            const v = input();
            if (pasteCompressed()) {
              return (
                <box flexDirection="column">
                  <text fg={ui.fg}>{v.split("\n").slice(0, 10).join("\n")}</text>
                  <text fg={ui.fgMuted}>{"\u2026 (pasted ~" + inputLines() + " lines \u2014 keep typing to expand)"}</text>
                </box>
              );
            }
            // Caret-aware render: the block sits where the caret is, over the
            // character it covers (or after the last char when at the end).
            // Ctrl+A highlights the selection with the accent background.
            const p = Math.max(0, Math.min(cursor(), v.length));
            const ss = selStart();
            const se = selEnd();
            const hasSel = ss >= 0 && se > ss;
            // Segment the draft at the caret char (p..p+1) and the selection
            // edges so ordinary text, highlighted text and the caret block
            // each render as their own span.
            const pts = Array.from(new Set(
              [0, p, Math.min(p + 1, v.length), hasSel ? ss : -1, hasSel ? se : -1, v.length]
                .filter(x => x >= 0 && x <= v.length)
            )).sort((a, b) => a - b);
            const segs: Array<{ text: string; sel: boolean }> = [];
            for (let i = 0; i < pts.length - 1; i++) {
              const a = pts[i], b = pts[i + 1];
              if (b <= a) continue;
              segs.push({ text: v.slice(a, b), sel: hasSel && a >= ss && b <= se });
            }
            const cursorInSel = hasSel && p >= ss && p < se;
            return (
              <box flexDirection="column" flexGrow={1}
                onMouseDown={(ev: any) => { clearSelection(); setCursor(caretFromMouse(ev, input(), effectiveW())); }}
              >
                <text fg={ui.fg}>
                  {segs.map((g, i) => g.sel ? (
                    // @ts-ignore OpenTUI text nodes take fg/bg via the style prop (TextNodeOptions), not as direct props
                    <span style={{ fg: ui.bgPanel, bg: ui.primary }}>{g.text}</span>
                  ) : (
                    <span>{g.text}</span>
                  ))}
                  {/* Caret blink swaps COLOR, never the character. The cell
                      always renders a full block ("\u2588"), so the text length
                      and wrap are identical in both blink phases â€” swapping the
                      char for a space lets TUI renderers that trim trailing
                      whitespace shorten the last wrapped line and vibrate the
                      box height at blink rate while typing. Instead we hide the
                      block by giving it the same fg as the background behind it
                      (bgInput, or primary inside a selection). */}
                  {/* @ts-ignore OpenTUI text nodes take fg/bg via the style prop (TextNodeOptions), not as direct props */}
                  <span style={{ fg: cursorInSel ? (showCursor() ? ui.bgPanel : ui.primary) : (showCursor() ? ui.fg : ui.bgInput), bg: cursorInSel ? ui.primary : undefined }}>
                    {"\u2588"}
                  </span>
                </text>
              </box>
            );
          })()}
        </Show>
        <box flexDirection="row" alignItems="center" flexShrink={0}>
          <text fg={MODE_COLORS[inputMode()] || ui.primary}>{MODE_NAMES[inputMode()] || "Build"}</text>
          <text fg={ui.fgDim}>{"  " + (MODE_HINTS[inputMode()] || "")}</text>
        </box>
      </box>

      <box paddingX={1} flexDirection="row">
        <text fg={ui.fgMuted}>{statusLine().cwd + "  " + statusLine().right}</text>
      </box>
    </box>
  );
}
