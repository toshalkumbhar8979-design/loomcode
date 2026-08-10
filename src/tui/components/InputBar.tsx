// InputBar -- input line + autocomplete popup. All signal reads inside JSX for reactivity.
import { onMount, onCleanup, createSignal, createMemo, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { palette } from "../theme.ts";
import { PermissionPopup } from "./PermissionPopup.tsx";
import {
  input, cursor, thinking, suggestions, autoIndex, autoKind,
  providerName, modelName, inputMode, sessionUsage, lifetimeUsage, modelMeta,
  selectSuggestionAt, moveSuggestionIndex, pickSuggestionAt, windowFor,
} from "../store.ts";
import { formatTokens, formatUsd } from "../../core/usage.js";

const ui = palette("loom");
const MODE_LABELS: Record<string, string> = { build: "B", plan: "P", chat: "C" };
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

// The chatbox grows with its content: header row (mode letter + "~N lines"
// badge) + scrollable content rows, all inside the border. The opentui
// "height" prop is the TOTAL rows including the border, so add 2 (borders) +
// 1 (header) to the visible content rows, with sane min/max bounds.
const MIN_INPUT_HEIGHT = 4;               // 2 border rows + header + 1 content row
const MAX_INPUT_HEIGHT = 12;              // generous scroll area for long drafts

function visualLines(text: string, boxWidth: number): number {
  if (!text) return 1;
  const w = Math.max(20, boxWidth - 10);
  let n = 0;
  for (const ln of text.split("\n")) {
    n += Math.max(1, Math.ceil((ln.length + 1) / w));
  }
  return n;
}

export function InputBar() {
  const [showCursor, setShowCursor] = createSignal(true);
  const dims = useTerminalDimensions();
  let blink: any;

  // Cost forecast for the current context: estimate tokens in flight, price
  // them against the active model, show "~$X" in the status row.
  const costForecast = createMemo(() => {
    const meta = modelMeta();
    if (!meta) return "";
    const { estimateTurnCost } = require("../../core/model-router.js");
    const { getSession } = require("../store.ts");
    const s = getSession();
    const est = s.estimateTokens();
    const out = s.config?.maxTokens || 8192;
    const cost = estimateTurnCost(providerName(), modelName(), est, out);
    if (cost == null || cost <= 0) return "";
    return "~" + formatUsd(cost) + " \u00B7 ";
  });
  onMount(() => { blink = setInterval(() => setShowCursor(v => !v), 530); });
  onCleanup(() => { if (blink) clearInterval(blink); });

  const footerStatus = createMemo(() => {
    const hints = "tab mode  ctrl+b sidebar  ctrl+p palette  esc interrupt";
    const modelShort = (modelName() || "default").split("/").pop();
    const sess = sessionUsage();
    const ctx = (modelMeta() && modelMeta().context) || 200000;
    const usageStr = formatTokens(sess.tokens) + " (" + Math.round(sess.pct) + "% of " + formatTokens(ctx) + ") \u00B7 " + formatUsd(sess.cost);
    const restLen = 3 + String(modelShort).length + 3 + usageStr.length;
    const maxCwd = Math.max(10, (dims().width || 100) - 6 - hints.length - restLen);
    const cwd = process.cwd();
    const cwdStr = cwd.length > maxCwd ? "\u2026" + cwd.slice(-(maxCwd - 1)) : cwd;
    let status = cwdStr + " \u00B7 " + modelShort + " \u00B7 " + usageStr;
    if (thinking() && input().trim()) status += " \u00B7 \u23F3 held \u2014 sends when the task finishes";
    const maxLen = Math.max(20, (dims().width || 100) - hints.length - 8);
    if (status.length > maxLen) status = status.slice(0, Math.max(20, maxLen - 1)) + "\u2026";
    return status;
  });

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

  // Chatbox height: 2 border rows + 1 header row + clamped content rows.
  const inputLines = createMemo(() => visualLines(input(), dims().width || 100));
  const inputHeight = createMemo(() => Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, 3 + inputLines())));

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
          <text fg={ui.fgMuted} dim>
            {"  \u2191\u2193 nav  TAB/ENTER pick  wheel/click  ESC close" + rangeHint(slashWin().start, slashWin().total)}
          </text>
          {slashWin().items.map((item, i) => {
            const abs = slashWin().start + i;
            return (
              <box
                key={item.label} flexDirection="row" paddingY={0}
                onMouseDown={() => selectSuggestionAt(abs)}
                onMouseUp={() => pickSuggestionAt(abs)}
              >
                <text fg={abs === autoIndex() ? ui.primary : ui.fgDim} bold={abs === autoIndex()}>
                  {(abs === autoIndex() ? "\u25B6 " : "   ") + item.label.split(" ")[0]}
                </text>
                <Show when={!!item.desc}>
                  <text fg={abs === autoIndex() ? ui.fg : ui.fgMuted} dim>
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
                key={item.label}
                fg={abs === autoIndex() ? ui.primary : ui.fgDim} bold={abs === autoIndex()}
                onMouseDown={() => selectSuggestionAt(abs)}
                onMouseUp={() => pickSuggestionAt(abs)}
              >
                {(abs === autoIndex() ? ">  " : "   ") + item.label}
              </text>
            );
          })}
          <text fg={ui.fgMuted} dim>{"  UP/DN TAB/ENTER pick  wheel/click  ESC close" + rangeHint(fileWin().start, fileWin().total)}</text>
        </box>
      </Show>

      <PermissionPopup />

      <box
        border borderStyle="rounded"
        borderColor={thinking() ? ui.warning : (MODE_COLORS[inputMode()] || ui.primary)}
        paddingX={1} paddingY={0}
        flexDirection="column"
        backgroundColor={ui.bgInput}
        height={inputHeight()}
      >
        <box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
          <text fg={MODE_COLORS[inputMode()] || ui.primary} bold>{MODE_LABELS[inputMode()] || "B"}</text>
          <text fg={ui.fgMuted}>{"| "}</text>
          <Show when={inputLines() > 1}>
            <text fg={ui.fgMuted} dim flexGrow={1}>{"~" + inputLines() + " lines \u00B7 Shift+Enter newline"}</text>
          </Show>
          <Show when={thinking()}>
            <text fg={ui.warning}>{"\u25C6"}</text>
          </Show>
        </box>
        <Show
          when={input().length > 0}
          fallback={
            <box flexGrow={1} flexDirection="column" justifyContent="center">
              <text fg={ui.fgMuted} dim>
                {(showCursor() ? "\u2588" : " ") + " Ask anything...  /commands  @file  !shell"}
              </text>
            </box>
          }
        >
          {(() => {
            // Caret-aware render: the block sits where the caret is, over the
            // character it covers (or after the last char when at the end).
            const v = input();
            const p = Math.max(0, Math.min(cursor(), v.length));
            const before = v.slice(0, p);
            const at = v[p] ?? "";
            const after = v.slice(p + 1);
            return (
              <scrollbox
                flexGrow={1}
                stickyScroll
                stickyStart="bottom"
                scrollbarOptions={{ trackOptions: { style: { fg: ui.border } } }}
                viewportOptions={{ flexGrow: 1 }}
              >
                <text fg={ui.fg} wrap>
                  {before}
                  <span fg={showCursor() ? ui.fg : ui.fgMuted}>{showCursor() ? "\u2588" : (at || " ")}</span>
                  {after}
                </text>
              </scrollbox>
            );
          })()}
        </Show>
      </box>

      <box paddingX={1} flexDirection="row" justifyContent="space-between">
        <text fg={ui.fgMuted} dim>{footerStatus()}</text>
        <text fg={ui.fgMuted} dim>
          {"tab mode  ctrl+b sidebar  ctrl+p palette  esc interrupt"}
        </text>
      </box>
      <box paddingX={1} flexDirection="row" justifyContent="space-between">
        <text fg={ui.fgMuted} dim>
          {"  " + costForecast() + providerName() + " \u00B7 " + MODE_NAMES[inputMode()] + " (" + MODE_HINTS[inputMode()] + ")  \u00B7  " + (thinking() ? "thinking..." : "ready")}
        </text>
        <text fg={ui.fgMuted} dim>
          {(() => {
            const life = lifetimeUsage();
            return "lifetime " + formatTokens(life.tokens) + " tokens \u00B7 " + formatUsd(life.cost) + " \u00B7 " + Math.round(life.pct) + "% of " + formatUsd(life.budget) + " budget";
          })()}
        </text>
      </box>
    </box>
  );
}
