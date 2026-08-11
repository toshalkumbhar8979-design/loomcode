// Sidebar — right panel. All signal reads inside JSX handles SolidJS
// reactivity; agent todos live-update via the todos:changed event (wired in
// App onMount); todo rows toggle done on click, file rows click to open in the
// OS default app.
import { Show } from "solid-js";
import { palette } from "../theme.ts";
import {
  sidebarTab, setSidebarTab, todos, setTodos, messages, providerName, modelName, openPetsLinked,
  cwdShort, getProjectFiles, petEnabled, speedStats, sessionUsage, budgetLevel, skillActive,
  getSession, showToast,
} from "../store.ts";
import { Companion } from "./Companion.tsx";
import { formatUsd } from "../../core/usage.js";
import path from "path";
import os from "os";
import { spawn } from "child_process";

const ui = palette("loom");
const TAB_NAMES = ["Info", "Todos", "Files"];

// Open a file/folder with the platform's default handler (start/open/xdg-open).
// openFileSpawn is a module seam so the interactive test suite can stub the
// real spawn (clicking a row must never pop windows on a dev machine).
export let openFileSpawn = spawn;
export function __stubOpenFileSpawn(fn: any) { openFileSpawn = fn || spawn; }
export function openWithDefault(rel: string) {
  const abs = path.resolve(process.cwd(), rel);
  const opener = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", '""', abs] : [abs];
  try { openFileSpawn(opener, args, { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch {}
  return abs;
}

// Toggle the clicked todo between done (✓) and open ( ).
// Also updates the canonical session list (matched by text) so a later
// recomputeTodos() doesn't stomp the flip. `i` is the index into the FULL
// todos() list (the render slices the tail, so the row passes listStart + row).
function toggleTodoAt(i: number) {
  const list = todos().slice();
  const t = list[i];
  if (!t) return;
  list[i] = { ...t, done: !t.done, inProgress: false, cancelled: false };
  setTodos(list);
  try {
    const sess = getSession();
    const idx = (sess.todos || []).findIndex((x: any) => String(x.content || "").trim() === String(t.text || "").trim());
    if (idx >= 0) {
      sess.todos[idx] = { ...sess.todos[idx], status: !t.done ? "completed" : "pending" };
    }
  } catch {}
}

// Pure helper (no component boundary) — computed inline in JSX below so the
// signal read stays reactive: component wrappers were rendering stale values.
function speedInfo(sp: any): { label: string; color: string } {
  const live = sp && sp.live ? sp.live : null;
  const last = sp && sp.last ? sp.last : null;
  const tps = live ? live.tokensPerSec : (last && last.tokensPerSec != null ? last.tokensPerSec : null);
  const latency = live ? live.firstTokenMs : (last ? last.latencyMs : null);
  let label: string;
  if (live && live.firstTokenMs == null) label = "waiting\u2026";
  else if (tps != null) label = tps + " tok/s \u00B7 " + (latency != null ? (latency / 1000).toFixed(1) + "s" : "\u2014") + " first";
  else label = "\u2014";
  let color: string;
  if (tps == null) color = ui.fgMuted;
  else if (tps >= 25 && (latency == null || latency <= 2500)) color = ui.success;
  else if (tps >= 8 || (latency != null && latency <= 6000)) color = ui.warning;
  else color = "#ff5555";
  return { label, color };
}

export function Sidebar(props: { show: boolean }) {
  return (
    <Show when={props.show}>
      <box flexDirection="column" width={38} borderStyle="single" borderColor={ui.border}
        backgroundColor={ui.bgPanel} paddingX={1} paddingY={0} flexShrink={0}>

        <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
          <text fg={ui.primary} bold height={1} flexShrink={0}>{" Loom Code"}</text>
          <text fg={ui.fgMuted} dim height={1} flexShrink={0}>{"v1.1"}</text>
        </box>

        <box flexDirection="column" height={skillActive().length > 0 ? 8 : 7} flexShrink={0}>
          <box flexDirection="row" height={1} flexShrink={0}><text fg={ui.fgMuted}>{"Provider:  "}</text><text fg={ui.primary}>{providerName()}</text></box>
          <box flexDirection="row" height={1} flexShrink={0}><text fg={ui.fgMuted}>{"Model:     "}</text><text fg={ui.fg}>{modelName()}</text></box>
          <box flexDirection="row" height={1} flexShrink={0}><text fg={ui.fgMuted}>{"Speed:     "}</text>
            <text fg={ui.fg}>{speedInfo(speedStats()).label}</text>
          </box>
          <box flexDirection="row" height={1} flexShrink={0}><text fg={ui.fgMuted}>{"Cost:      "}</text>
            <text fg={sessionUsage().cost > 0.02 ? ui.warning : ui.fg}>{formatUsd(sessionUsage().cost)}</text>
            <text fg={budgetLevel() === "auto" ? ui.fgMuted : ui.primary}>{"  [" + budgetLevel() + "]"}</text>
          </box>
          <box flexDirection="row" height={1} flexShrink={0}><text fg={ui.fgMuted}>{"Messages:  "}</text><text fg={ui.fg}>{String(messages().length)}</text></box>
          <box flexDirection="row" height={1} flexShrink={0}><text fg={ui.fgMuted}>{"Path:      "}</text><text fg={ui.fgDim}>{cwdShort() || "~"}</text></box>
          <box flexDirection="row" height={1} flexShrink={0}><text fg={ui.fgMuted}>{"OpenPets:  "}</text><text fg={openPetsLinked() ? "green" : "gray"}>{openPetsLinked() ? "linked" : "off"}</text></box>
          {skillActive().length > 0 ? (
            <box flexDirection="row" height={1} flexShrink={0}><text fg={ui.fgMuted}>{"Skills:    "}</text><text fg={ui.primary}>{skillActive().join(", ")}</text></box>
          ) : null}
        </box>

        <Companion />

        <box flexDirection="row" gap={1} flexShrink={0}>
          {TAB_NAMES.map((name, i) => (
            <text key={name} fg={sidebarTab() === i ? ui.primary : ui.fgMuted} bold={sidebarTab() === i} height={1} flexShrink={0}
              onMouseUp={() => setSidebarTab(i)}>
              {"  " + name + "  "}
            </text>
          ))}
        </box>

        <box height={3} flexShrink={0} flexDirection="column" overflow="hidden">
            <Show when={TAB_NAMES[sidebarTab()] === "Todos"}>
              <Show
                when={todos().length > 0}
                fallback={<text fg={ui.fgMuted} dim>{"No tasks -- [ ] [x] [+] in replies"}</text>}
              >
                {todos().map((td, i) => {
                  if (i < todos().length - 10) return null;
                  // OpenTUI TextNode only accepts strings/StyledText — nested
                  // <text> elements inside <text> crash the renderer, so the
                  // marker+text is built as one string with a row color. width
                  // is explicit: without it the native yoga layout shrinks the
                  // text nodes and the rows wrap/overlap (garbled glyphs).
                  const mark = td.inProgress ? "[+] " : td.done ? "[x] " : td.cancelled ? "[-] " : "[ ] ";
                  const color = td.inProgress ? ui.warning : td.done ? ui.success : td.cancelled ? ui.fgMuted : ui.fgDim;
                  return (
                    <text key={"todo-" + i} width={34} fg={color} onMouseUp={() => toggleTodoAt(i)}>
                      {mark + td.text}
                    </text>
                  );
                })}
              </Show>
            </Show>
            <Show when={TAB_NAMES[sidebarTab()] === "Files"}>
              {getProjectFiles().slice(0, 20).map(f => (
                <text key={f} width={34} fg={ui.fgDim} dim onMouseUp={() => {
                  openWithDefault(f);
                  showToast("Opened " + f, "ok", 2200);
                }}>{f}</text>
              ))}
            </Show>
            <Show when={TAB_NAMES[sidebarTab()] === "Info"}>
              <text fg={ui.fgDim} dim>{"ctrl+b toggle sidebar, esc interrupt"}</text>
            </Show>
        </box>

        <box borderTop paddingTop={1} flexShrink={0}>
          <text fg={ui.fgMuted} dim height={1} flexShrink={0}>{"~/" + cwdShort()}</text>
        </box>
      </box>
    </Show>
  );
}
