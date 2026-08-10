// Sidebar — right panel. All signal reads inside JSX for SolidJS reactivity.
import { Show } from "solid-js";
import { palette } from "../theme.ts";
import {
  sidebarTab, todos, messages, providerName, modelName, openPetsLinked,
  cwdShort, getProjectFiles, petEnabled, speedStats, sessionUsage, budgetLevel, skillActive,
} from "../store.ts";
import { Companion } from "./Companion.tsx";
import { formatUsd } from "../../core/usage.js";

const ui = palette("loom");
const TAB_NAMES = ["Info", "Todos", "Files"];

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
        backgroundColor={ui.bgPanel} paddingX={1} paddingY={1} flexShrink={0}>

        <box marginBottom={1} flexDirection="row" justifyContent="space-between">
          <text fg={ui.primary} bold>{" Loom Code"}</text>
          <text fg={ui.fgMuted} dim>{"v1.1"}</text>
        </box>

        <box flexDirection="column" marginBottom={1}>
          <box flexDirection="row"><text fg={ui.fgMuted}>{"Provider:  "}</text><text fg={ui.primary}>{providerName()}</text></box>
          <box flexDirection="row"><text fg={ui.fgMuted}>{"Model:     "}</text><text fg={ui.fg}>{modelName()}</text></box>
          <box flexDirection="row" height={1}><text fg={ui.fgMuted}>{"Speed:     "}</text>
            <text fg={ui.fg}>{speedInfo(speedStats()).label}</text>
          </box>
          <box flexDirection="row"><text fg={ui.fgMuted}>{"Cost:      "}</text>
            <text fg={sessionUsage().cost > 0.02 ? ui.warning : ui.fg}>{formatUsd(sessionUsage().cost)}</text>
            <text fg={budgetLevel() === "auto" ? ui.fgMuted : ui.primary}>{"  [" + budgetLevel() + "]"}</text>
          </box>
          <box flexDirection="row"><text fg={ui.fgMuted}>{"Messages:  "}</text><text fg={ui.fg}>{String(messages().length)}</text></box>
          <box flexDirection="row"><text fg={ui.fgMuted}>{"Path:      "}</text><text fg={ui.fgDim}>{cwdShort() || "~"}</text></box>
          <box flexDirection="row"><text fg={ui.fgMuted}>{"OpenPets:  "}</text><text fg={openPetsLinked() ? "green" : "gray"}>{openPetsLinked() ? "linked" : "off"}</text></box>
          {skillActive().length > 0 ? (
            <box flexDirection="row"><text fg={ui.fgMuted}>{"Skills:    "}</text><text fg={ui.primary}>{skillActive().join(", ")}</text></box>
          ) : null}
        </box>

        <Companion />

        <box flexDirection="row" gap={1} marginBottom={1}>
          {TAB_NAMES.map((name, i) => (
            <text key={name} fg={sidebarTab() === i ? ui.primary : ui.fgMuted} bold={sidebarTab() === i}>
              {"  " + name + "  "}
            </text>
          ))}
        </box>

        <box flexGrow={1} flexDirection="column" overflow="hidden">
          <Show when={TAB_NAMES[sidebarTab()] === "Todos"}>
            <Show
              when={todos().length > 0}
              fallback={<text fg={ui.fgMuted} dim>{"No tasks -- [ ] [x] [+] in replies"}</text>}
            >
              <box flexDirection="column">
                {todos().slice(-10).map((td, i) => (
                  <text key={i} wrap>
                    <Show when={td.inProgress} fallback={
                      td.done
                        ? <text fg={ui.success}>{"[x] " + td.text}</text>
                        : td.cancelled
                          ? <text fg={ui.fgMuted} dim>{"[-] " + td.text}</text>
                          : <text fg={ui.fgDim}>{"[ ] " + td.text}</text>
                    }>
                      <text fg={ui.warning}>{"[+] " + td.text}</text>
                    </Show>
                  </text>
                ))}
              </box>
            </Show>
          </Show>
          <Show when={TAB_NAMES[sidebarTab()] === "Files"}>
            <box flexDirection="column">
              {getProjectFiles().slice(0, 20).map(f => (
                <text key={f} fg={ui.fgDim} dim>{f}</text>
              ))}
            </box>
          </Show>
          <Show when={TAB_NAMES[sidebarTab()] === "Info"}>
            <text fg={ui.fgDim} dim>{"ctrl+b toggle sidebar, esc interrupt"}</text>
          </Show>
        </box>

        <box marginTop={1} borderStyle="single" borderColor={ui.border} borderTop paddingTop={1}>
          <text fg={ui.fgMuted} dim>{"~/" + cwdShort()}</text>
        </box>
      </box>
    </Show>
  );
}
