// SubagentPanel — /subagents modal listing every subagent run (active + from
// disk) with live status, elapsed time, cost, and tool log. Enter opens a
// detail modal with the full output; c cancels a running subagent.
import { Show, createSignal, createMemo, onMount, onCleanup } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { palette } from "../theme.ts";
import { ModalFrame } from "./Modals.tsx";
import * as kbs from "../keybinds.ts";
import {
  activeSubagents, subagentHistory, cancelSubagentRun, loadSubagentHistory,
  modal, closeModal, openModal,
  type SubagentEntry,
} from "../store.ts";

const ui = palette("loom");

function statusGlyph(s: SubagentEntry["status"]): string {
  if (s === "running") return "\u25CF";
  if (s === "done") return "\u2713";
  if (s === "cancelled") return "\u2298";
  return "\u2717";
}

function statusColor(s: SubagentEntry["status"]): string {
  if (s === "running") return ui.warning || ui.primary;
  if (s === "done") return ui.success || ui.primary;
  if (s === "cancelled") return ui.fgMuted;
  return "#ff5555";
}

function fmtCost(c: number): string {
  if (!c || c < 0.0001) return "free";
  if (c < 0.01) return "$" + c.toFixed(4);
  return "$" + c.toFixed(2);
}

function fmtTokens(inT: number, outT: number): string {
  const sum = inT + outT;
  if (sum < 1000) return String(sum) + " tok";
  if (sum < 1000000) return (sum / 1000).toFixed(1) + "k tok";
  return (sum / 1000000).toFixed(2) + "M tok";
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m + "m " + s + "s";
}

// Live tick — bumps once a second while the panel is mounted so running
// subagents' elapsed/cost/time fields refresh without manual re-renders.
function useLiveTick(): () => number {
  const [, setTick] = createSignal(0);
  let id: any = null;
  onMount(() => { id = setInterval(() => setTick(v => v + 1), 1000); });
  onCleanup(() => { if (id) clearInterval(id); });
  return () => Date.now();
}

function openSubagentDetail(runId: string) {
  openModal({ type: "subagent_detail", runId });
}

export function SubagentPanel() {
  const now = useLiveTick();

  // Merged list: active first (running ones float up), then history.
  const all = createMemo<SubagentEntry[]>(() => {
    const active = Array.from(activeSubagents().values());
    const seen = new Set(active.map(a => a.runId));
    const hist = subagentHistory().filter(h => !seen.has(h.runId));
    return active.concat(hist).sort((a, b) => b.startTime - a.startTime);
  });

  const [sel, setSel] = createSignal(0);
  const [statusMsg, setStatusMsg] = createSignal<string>("");

  const PAGE = 14;
  const win = createMemo(() => {
    const list = all();
    const total = list.length;
    const idx = Math.min(sel(), Math.max(0, total - 1));
    const start = Math.max(0, Math.min(idx - Math.floor(PAGE / 2), total - PAGE));
    return { start: Math.max(0, start), items: list.slice(start, start + PAGE), total, idx };
  });

  useKeyboard((key: any) => {
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) { closeModal(); return; }
    if (kbs.dialogIs("dialog_select_next", ks)) { setSel(i => Math.min(all().length - 1, i + 1)); return; }
    if (kbs.dialogIs("dialog_select_prev", ks)) { setSel(i => Math.max(0, i - 1)); return; }
    if (kbs.dialogIs("dialog_select_home", ks)) { setSel(0); return; }
    if (kbs.dialogIs("dialog_select_end", ks)) { setSel(Math.max(0, all().length - 1)); return; }
    if (kbs.dialogIs("dialog_select_submit", ks)) {
      const list = all();
      const cur = list[sel()];
      if (cur) openSubagentDetail(cur.runId);
      return;
    }
    if (key.name === "r") { loadSubagentHistory({ limit: 200 }); setStatusMsg("history refreshed"); return; }
    if (key.name === "m") {
      // Set the DEFAULT model for the selected agent id ("provider/model-id").
      const cur = all()[sel()];
      if (!cur) return;
      const { loadConfig, saveConfig } = require("../../../config/settings.js");
      const cfg = loadConfig();
      cfg.agents = cfg.agents || {};
      const curModel = (cfg.agents[cur.agentId] && cfg.agents[cur.agentId].model) || "";
      openModal({
        type: "input", title: "Default model for " + cur.agent,
        placeholder: 'e.g. "anthropic/claude-sonnet-4-20250514" — empty clears',
        value: curModel,
        onPick(val: string) {
          closeModal();
          const v = String(val || "").trim();
          if (v) { cfg.agents[cur.agentId] = Object.assign({}, cfg.agents[cur.agentId], { model: v }); saveConfig(cfg); }
          else if (cfg.agents[cur.agentId]) { delete cfg.agents[cur.agentId].model; saveConfig(cfg); }
          setStatusMsg(v ? cur.agentId + " default model \u2192 " + v : cur.agentId + " default model cleared");
        },
      });
      return;
    }
    if (key.name === "c") {
      const list = all();
      const cur = list[sel()];
      if (cur && cur.status === "running") {
        const ok = cancelSubagentRun(cur.runId);
        setStatusMsg(ok ? "cancelling " + cur.agent + " \u2026" : "cancel failed (already finished)");
      } else {
        setStatusMsg("nothing to cancel (selected is not running)");
      }
      return;
    }
  });

  const activeCount = createMemo(() => Array.from(activeSubagents().values()).filter(e => e.status === "running").length);

  return (
    <ModalFrame
      title="Subagents"
      subtitle={(activeCount() || 0) + " active \u00B7 " + all().length + " total \u00B7 arrows navigate \u00B7 Enter details \u00B7 c cancel \u00B7 r refresh"}
      footer="Enter details \u00B7 c cancel running \u00B7 r refresh history \u00B7 Esc close"
    >
      <Show when={win().total === 0}>
        <text fg={ui.fgMuted}>No subagent runs yet. Delegate via the task tool or @mention and it will appear here</text>
     </Show>
      <Show when={win().total > 0}>
        <box flexDirection="column">
          {win().items.map((entry: any, i: number) => {
            const abs = win().start + i;
            const isSelected = abs === sel();
            const ms = entry.endTime ? entry.durationMs : (now() - entry.startTime);
            return (
              <box flexDirection="row" paddingX={1}
                backgroundColor={isSelected ? ui.bgInput : undefined}
                onMouseDown={() => setSel(abs)}>
                <text fg={statusColor(entry.status)}>{(isSelected ? "> " : "  ") + statusGlyph(entry.status) + " "}</text>
                <text fg={isSelected ? ui.primary : ui.fg}>{entry.agent + "  "}</text>
                <text fg={ui.fgMuted}>{fmtDuration(ms) + "  "}</text>
                <text fg={ui.fgMuted}>{fmtCost(entry.costUsd) + "  \u00B7 "}</text>
                <text fg={ui.fgDim}>{(entry.prompt || "").replace(/\s+/g, " ").slice(0, 44)}</text>
              </box>
            );
          })}
        </box>
      </Show>
      <Show when={statusMsg()}>
        <text fg={ui.fgMuted}>{statusMsg()}</text>
      </Show>
    </ModalFrame>
  );
}

export function SubagentDetailPanel() {
  let id: any = null;
  const [, setTick] = createSignal(0);
  onMount(() => { id = setInterval(() => setTick(v => v + 1), 500); });
  onCleanup(() => { if (id) clearInterval(id); });

  useKeyboard((key: any) => {
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) closeModal();
  });

  const entry = createMemo<SubagentEntry | null>(() => {
    setTick();
    const m = modal();
    const runId = m && m.runId;
    if (!runId) return null;
    const live = activeSubagents().get(runId);
    if (live) return live;
    return subagentHistory().find(h => h.runId === runId) || null;
  });

  const now = () => Date.now();

  return (
    <ModalFrame title="Subagent detail" subtitle="Esc close" footer="Esc close">
      <Show when={entry()} fallback={<text fg={ui.fgMuted}>Subagent not found</text>}>
        <box flexDirection="column">
          <text fg={ui.primary}>{(entry() as any).agent + "  " + statusGlyph((entry() as any).status) + "  " + (entry() as any).status}</text>
          <text fg={ui.fgMuted}>{"id: " + (entry() as any).runId}</text>
          <text fg={ui.fgMuted}>{"started: " + new Date((entry() as any).startTime).toISOString() + ((entry() as any).endTime ? "  ended: " + new Date((entry() as any).endTime).toISOString() : "  (running)")}</text>
          <text fg={ui.fgMuted}>{"duration: " + ((entry() as any).endTime ? fmtDuration((entry() as any).durationMs) : fmtDuration(now() - (entry() as any).startTime)) + "  cost: " + fmtCost((entry() as any).costUsd) + "  tokens: " + fmtTokens((entry() as any).tokensIn, (entry() as any).tokensOut)}</text>
          <text fg={ui.fgMuted}>{"prompt: " + ((entry() as any).prompt || "").slice(0, 500)}</text>
          <Show when={(entry() as any).toolLog && (entry() as any).toolLog.length > 0}>
            <text fg={ui.fgMuted}>{"tool log: " + (entry() as any).toolLog.join(" \u00B7 ")}</text>
          </Show>
          <text fg={ui.fg}>output</text>
          <text fg={ui.fgDim}>{((entry() as any).content || "(empty)").slice(0, 4000)}</text>
        </box>
      </Show>
    </ModalFrame>
  );
}