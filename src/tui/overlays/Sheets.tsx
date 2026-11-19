// Sheets — the longer flows: MCP and connector browsers, the sandbox
// wizard, the memory graph, and the subagent panels.
import { createSignal, createMemo, onMount, onCleanup, Show } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { GLYPH, SPIN, TICK_MS, palette, fit } from "../design.ts";
import { ModalFrame, wheelStep, kbNav } from "./Layer.tsx";
import * as kbs from "../keybinds.ts";
import {
  openModal, closeModal, modal, showToast, windowFor, appendMessage,
  activeSubagents, subagentHistory, cancelSubagentRun, loadSubagentHistory,
  type SubagentEntry,
} from "../store.ts";
import { MCP_PRESETS, CONNECTOR_PRESETS } from "../mcp-presets.ts";

const ui = palette();
const plugin = require("../../core/plugin-cmd.js");

function ticker(ms: number): () => number {
  const [t, setT] = createSignal(0);
  let id: any = null;
  onMount(() => { id = setInterval(() => setT(v => v + 1), ms); });
  onCleanup(() => { if (id) clearInterval(id); });
  return t;
}

// ─── MCP / connector browser ───
const MCP_FIT = 52;
function mcpFit(s: string, n = MCP_FIT) {
  const flat = String(s || "").replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, Math.max(1, n - 1)) + GLYPH.ellipsis;
}

function presetAddLine(p: any, envValues?: Record<string, string>): string {
  const parts: string[] = [];
  for (const k of Object.keys(p.env || {})) parts.push("-e", k + "=" + (envValues ? (envValues[k] || "") : ""));
  parts.push(p.id, "--");
  if (p.command) parts.push(p.command, ...(p.args || []));
  else parts.push("npx", "-y", p.package, ...(p.args || []));
  return parts.join(" ");
}

function openPresetPicker(presets: any[], kind: "mcp" | "connector") {
  const addLabel = kind === "connector" ? "Add connector" : "Add MCP server";
  const backType = kind === "connector" ? "connectors" : "mcp";
  const addLine = kind === "connector" ? plugin.connectorAddLineCmd : plugin.mcpAddLineCmd;

  const submitLine = (line: string, reopenOnError: boolean) => {
    const msg = addLine(line);
    if (msg.startsWith("Added")) {
      showToast(msg, "ok");
      closeModal();
      setTimeout(() => { openModal({ type: backType as any }); }, 10);
    } else {
      showToast(String(msg).slice(0, 80), "error");
      if (reopenOnError) {
        closeModal();
        setTimeout(() => { openModal({ type: backType as any }); }, 10);
      }
    }
  };

  const openLine = (line: string) => {
    openModal({
      type: "input",
      title: addLabel + "  ·  one line",
      placeholder: "e.g. -e KEY=V " + (kind === "connector" ? "railway" : "stm32") + " -- <command> <args>",
      value: line,
      caretStart: line ? line.lastIndexOf("=") + 1 : 0,
      onCancel() { closeModal(); setTimeout(() => { openModal({ type: backType as any }); }, 10); },
      onPick(line2: string) {
        const msg = addLine(line2);
        if (msg.startsWith("Added")) {
          showToast(msg, "ok");
          closeModal();
          setTimeout(() => { openModal({ type: backType as any }); }, 10);
        } else {
          showToast(String(msg).slice(0, 80), "error");
          openLine(line2);
        }
      },
    });
  };

  const guidedAdd = (preset: any) => {
    const prompts: any[] = preset.prompts || [];
    const env: Record<string, string> = {};
    const askPrompt = (i: number) => {
      if (i >= prompts.length) {
        const oap = preset.optionalArgsPrompt;
        if (!oap) { submitLine(presetAddLine(preset, env), true); return; }
        openModal({
          type: "input",
          title: addLabel + " · " + preset.label,
          placeholder: oap.label,
          onCancel() { submitLine(presetAddLine(preset, env), true); },
          onPick(v: string) {
            const t = String(v || "").trim();
            const line = presetAddLine(preset, env) + (t ? " " + (oap.flag ? oap.flag + " " : "") + t : "");
            submitLine(line, true);
          },
        });
        return;
      }
      const pr = prompts[i];
      openModal({
        type: "input",
        title: addLabel + " · " + preset.label + "  (" + (i + 1) + "/" + prompts.length + ")",
        placeholder: pr.label,
        isKey: pr.mask !== false,
        onCancel() { closeModal(); setTimeout(() => { openModal({ type: backType as any }); }, 10); },
        onPick(val: string) {
          const t = String(val || "").trim();
          if (!t) { showToast(pr.key + " is required", "error"); askPrompt(i); return; }
          if (/\s/.test(t)) { showToast(pr.key + " must not contain spaces", "error"); askPrompt(i); return; }
          env[pr.key] = t;
          askPrompt(i + 1);
        },
      });
    };

    closeModal();
    if (!prompts.length) { openLine(presetAddLine(preset)); return; }
    askPrompt(0);
  };

  const picker = presets.map(p => ({
    label: p.label,
    sub: p.prompts.length ? "needs a token" : "no key needed",
    value: p.id,
  })).concat([{ label: "Custom…", sub: "name + command + args + env", value: "__custom__" }]);
  openModal({
    type: "select", title: addLabel, searchable: false, options: picker,
    onPick(val: any) {
      const preset = val === "__custom__" ? undefined : presets.find((p: any) => p.id === val);
      if (!preset) { closeModal(); openLine(""); return; }
      if ((preset.prompts || []).length) { guidedAdd(preset); return; }
      closeModal();
      openLine(presetAddLine(preset));
    },
  });
}

function ServerBrowser(props: { kind: "mcp" | "connector" }) {
  const kind = props.kind;
  const title = kind === "connector" ? "Connectors" : "MCP Servers";
  const presets = kind === "connector" ? CONNECTOR_PRESETS : MCP_PRESETS;
  const { listServers, toggleServer } = require("../../mcp/mcp-manager.js");
  const [servers, setServers] = createSignal(listServers());
  const [sel, setSel] = createSignal(0);
  const refresh = () => setServers(listServers());

  useKeyboard((key: any) => {
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) { closeModal(); return; }
    if (kbs.dialogIs("dialog_select_prev", ks)) { setSel(i => Math.max(0, i - 1)); return; }
    if (kbs.dialogIs("dialog_select_next", ks)) { setSel(i => Math.min(servers().length, i + 1)); return; }
    if (key.name === "a" || key.name === "A") { openPresetPicker(presets, kind); return; }
    if (kbs.dialogIs("dialog_select_submit", ks)) {
      if (sel() >= servers().length) { openPresetPicker(presets, kind); return; }
      const s = servers()[sel()];
      if (!s) return;
      const res = toggleServer(s.name);
      if (res && res.error) { showToast(String(res.error), "error"); return; }
      showToast("MCP " + s.name + ": " + (s.enabled ? "off" : "on"), "ok");
      refresh();
    }
  });

  const scrollBy = (e: any) => { setSel(i => Math.max(0, Math.min(servers().length, i + wheelStep(e, 1)))); };
  let winStart = 0;
  const win = () => {
    const total = servers().length;
    winStart = windowFor(sel(), total, 12, winStart);
    return { total, start: winStart, items: servers().slice(winStart, winStart + 12) };
  };
  const nameW = () => Math.min(30, Math.max(18, ...servers().map((s: any) => String(s.name).length + 9)));
  const cmdW = () => Math.max(22, 60 - nameW());

  return (
    <ModalFrame title={title} subtitle="Enter toggles, + Add row adds"
      footer={kbNav().submit + " toggle/add · A add · " + kbNav().cancel + " close"}>
      <box onMouseScroll={scrollBy} flexDirection="column" flexShrink={0}>
        {win().items.map((s: any, i: number) => {
          const abs = win().start + i;
          const active = abs === sel();
          return (
            <box flexDirection="row" height={1} flexShrink={0} paddingLeft={1}
              backgroundColor={active ? ui.bgPanelAlt : undefined}
              onMouseDown={() => setSel(abs)}
              onMouseUp={() => { if (abs === sel()) { const r: any = toggleServer(s.name); if (!r || !r.error) refresh(); } }}>
              <text fg={active ? ui.primary : ui.fgDim} width={nameW()} height={1} flexShrink={0}>
                {(active ? GLYPH.pointer + " " : "  ") + "[" + (s.enabled ? "on" : "off") + "] " + s.name}
              </text>
              <text fg={s.enabled ? ui.success : ui.fgMuted} height={1} flexGrow={1}>
                {mcpFit(s.command + " " + (s.args || []).join(" "), cmdW())}
              </text>
            </box>
          );
        })}
        {(() => {
          const addActive = sel() >= servers().length;
          return (
            <box flexDirection="row" height={1} flexShrink={0} paddingLeft={1}
              backgroundColor={addActive ? ui.bgPanelAlt : undefined}
              onMouseDown={() => setSel(servers().length)}
              onMouseUp={() => { if (sel() >= servers().length) openPresetPicker(presets, kind); }}>
              <text fg={addActive ? ui.primary : ui.fgMuted} height={1}>
                {(addActive ? GLYPH.pointer + " " : "  ") + "+ Add " + (kind === "connector" ? "connector" : "MCP server") + "…"}
              </text>
            </box>
          );
        })()}
      </box>
    </ModalFrame>
  );
}

export function McpModal() { return <ServerBrowser kind="mcp" />; }
export function ConnectorsModal() { return <ServerBrowser kind="connector" />; }

// ─── Sandbox wizard ───
export function SandboxModal() {
  const sb = require("../../core/sandbox.js");
  const [step, setStep] = createSignal<"docker" | "os" | "setup">("docker");
  const [docker, setDocker] = createSignal<{ state: string; version: string } | null>(null);
  const [osSel, setOsSel] = createSignal(0);
  const [logs, setLogs] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [prog, setProg] = createSignal<{ stage: string; pct: number | null; step: number; total: number } | null>(null);
  const spin = ticker(TICK_MS);

  const STAGE_LABELS: Record<string, string> = {
    pull: "Pulling image",
    create: "Creating container",
    start: "Starting container",
    essentials: "Installing essentials",
    browser: "Installing browser",
    done: "Ready",
  };

  onMount(() => {
    sb.detectDockerAsync().then((d: any) => {
      setDocker(d);
      if (d.state === "ready") setTimeout(() => { if (step() === "docker") setStep("os"); }, 600);
    });
  });

  function recheck() {
    setDocker(null);
    sb.detectDockerAsync().then((d: any) => {
      setDocker(d);
      if (d.state === "ready") setStep("os");
    });
  }

  function startSetup() {
    const os = sb.OS_CATALOG[osSel()];
    setStep("setup");
    setBusy(true);
    setErr(null);
    setProg(null);
    setLogs(["Preparing " + os.label + " (" + os.image + ")…"]);
    sb.setupSandbox({
      osId: os.id,
      onLog: (l: string) => setLogs(xs => [...xs, l]),
      onProgress: (p: any) => setProg(p),
    }).then((res: any) => {
      setBusy(false);
      if (res.ok) {
        appendMessage({ role: "system", content: "Sandbox is live (" + os.label + "). Normal commands still run on your system. Use the sandbox tool or ask explicitly when you want isolation. Your project is mounted at /workspace." });
        showToast("Sandbox ready — " + os.label, "ok");
        closeModal();
      } else {
        setErr(res.error || "setup failed");
      }
    });
  }

  useKeyboard((key: any) => {
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) { closeModal(); return; }
    const s = step();
    if (s === "setup") {
      if (!busy() && err() && kbs.dialogIs("dialog_select_submit", ks)) { setErr(null); startSetup(); }
      return;
    }
    if (kbs.dialogIs("dialog_select_prev", ks)) { if (s === "os") setOsSel(i => Math.max(0, i - 1)); return; }
    if (kbs.dialogIs("dialog_select_next", ks)) { if (s === "os") setOsSel(i => Math.min(sb.OS_CATALOG.length - 1, i + 1)); return; }
    if (kbs.dialogIs("dialog_select_submit", ks)) {
      if (s === "docker") {
        const d = docker();
        if (!d) return;
        if (d.state === "not_installed") {
          sb.markInstallPending();
          sb.openInstallPage();
          appendMessage({ role: "system", content: "Opened the Docker download page. Install Docker (restart if asked), then run /sandbox again — or just say \"docker is ready\" in chat." });
          closeModal();
        } else if (d.state === "no_daemon") {
          recheck();
        } else {
          setStep("os");
        }
        return;
      }
      if (s === "os" && !busy()) startSetup();
    }
  });

  const link = sb.installLink();
  const st = () => (docker() ? docker()!.state : "checking");

  return (
    <ModalFrame
      title="Sandbox Setup"
      subtitle={
        step() === "docker" ? "Step 1/3 — Docker check"
          : step() === "os" ? "Step 2/3 — pick a lightweight OS"
            : "Step 3/3 — building the sandbox"
      }
      footer={
        step() === "docker"
          ? (st() === "not_installed" ? "enter open download page · esc close"
            : st() === "no_daemon" ? "enter re-check · esc close"
              : "checking…")
          : step() === "os" ? "↑↓ pick · enter start setup · esc close"
            : busy() ? "working… esc to keep running in background"
              : "enter retry · esc close"
      }
    >
      {step() === "docker" && st() === "checking" ? (
        <text fg={ui.fgMuted}>{SPIN[spin() % SPIN.length] + " Checking Docker…"}</text>
      ) : null}
      {step() === "docker" && st() === "not_installed" ? (
        <box flexDirection="column">
          <text fg={ui.warning}>Docker is not installed</text>
          <text fg={ui.fgMuted} marginTop={1}>The sandbox needs Docker once. After that it is permanent.</text>
          <box flexDirection="column" marginTop={1}>
            <text fg={ui.fg}>1. Install Docker Desktop (restart if asked)</text>
            <text fg={ui.primary}>{"   " + link}</text>
            <text fg={ui.fg}>2. Start it and wait for "running"</text>
            <text fg={ui.fg}>3. Come back here and press enter</text>
          </box>
        </box>
      ) : null}
      {step() === "docker" && st() === "no_daemon" ? (
        <box flexDirection="column">
          <text fg={ui.warning}>Docker is installed but not running</text>
          <text fg={ui.fgMuted} marginTop={1}>Start Docker Desktop (or: sudo systemctl start docker), wait for it, then press enter to re-check.</text>
        </box>
      ) : null}
      {step() === "docker" && st() === "ready" ? (
        <box flexDirection="column">
          <text fg={ui.success}>{"Docker installed (v" + (docker() || { version: "?" }).version + ")"}</text>
          <text fg={ui.fgMuted} marginTop={1}>Opening OS selection…</text>
        </box>
      ) : null}
      {step() === "os" ? (
        <box flexDirection="column">
          {sb.OS_CATALOG.map((os: any, i: number) => {
            const active = i === osSel();
            return (
              <box flexDirection="row"
                backgroundColor={active ? ui.bgPanelAlt : undefined}
                onMouseDown={() => setOsSel(i)}
                onMouseUp={() => { if (osSel() === i) startSetup(); }}>
                <text fg={active ? ui.primary : ui.fgDim}>{(active ? GLYPH.pointer + " " : "  ") + os.label}</text>
                <text fg={active ? ui.fg : ui.fgMuted}>{"  " + os.sizeNote}</text>
                {os.browser ? <text fg={ui.success}>{"  +browser"}</text> : null}
              </box>
            );
          })}
          <text fg={ui.fgMuted} marginTop={1}>All options include git, curl, ripgrep and a shell.</text>
        </box>
      ) : null}
      {step() === "setup" ? (
        <box flexDirection="column" maxWidth={72}>
          {prog() ? (() => {
            const p = prog()!;
            const os = sb.OS_CATALOG[osSel()];
            const keys = ["pull", "create", "start", "essentials"]
              .concat(os.browser ? ["browser"] : [], ["done"])
              .slice(0, p.total);
            return (
              <box flexDirection="column" marginBottom={1}>
                {keys.map((key2: string, i: number) => {
                  const done = i < p.step || p.stage === "done";
                  const active = i === p.step && p.stage !== "done";
                  const mark = done ? GLYPH.check : active ? SPIN[spin() % SPIN.length] : GLYPH.dash;
                  const color = done ? ui.success : active ? ui.primary : ui.fgDim;
                  let bar = "";
                  if (active && p.pct != null) bar = "  " + p.pct + "%";
                  else if (active) bar = " …";
                  return <text fg={color}>{mark + " " + STAGE_LABELS[key2] + bar}</text>;
                })}
              </box>
            );
          })() : <text fg={ui.fgMuted}>Starting…</text>}
          {logs().slice(-6).map((l: string) => <text fg={ui.fgMuted}>{GLYPH.pointer + " " + l.slice(0, 68)}</text>)}
          {busy() ? <text fg={ui.primary}>{SPIN[spin() % SPIN.length] + " working — you can esc; setup continues in the background"}</text> : null}
          {err() ? (
            <box flexDirection="column" marginTop={1}>
              <text fg={ui.error}>{err()}</text>
              <text fg={ui.fgMuted}>press enter to retry, esc to close</text>
            </box>
          ) : null}
          {!busy() && !err() ? <text fg={ui.success}>done</text> : null}
        </box>
      ) : null}
    </ModalFrame>
  );
}

// ─── Memory graph ───
export function GraphModal(props: { graph: any; err: string | null }) {
  const [sel, setSel] = createSignal(0);
  const [open, setOpen] = createSignal<number | null>(null);

  const buildFlat = (g: any): any[] => {
    const nodes = g.nodes || [];
    const edges = g.edges || [];
    const byId = new Map<string, any>();
    for (const n of nodes) byId.set(n.id, n);
    const childMap = new Map<string, string[]>();
    const hasParent = new Set<string>();
    for (const e of edges) {
      if (e.type !== "child") continue;
      if (!childMap.has(e.source)) childMap.set(e.source, []);
      childMap.get(e.source)!.push(e.target);
      hasParent.add(e.target);
    }
    const flat: any[] = [];
    const seen = new Set<string>();
    const walk = (id: string, depth: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      const n = byId.get(id);
      if (!n) return;
      flat.push({ node: n, depth });
      for (const k of childMap.get(id) || []) walk(k, depth + 1);
    };
    for (const n of nodes) if (!hasParent.has(n.id)) walk(n.id, 0);
    for (const n of nodes) if (!seen.has(n.id)) walk(n.id, 0);
    return flat;
  };

  let selLine = 0;
  const content = () => {
    if (props.err) return "Error: " + props.err;
    const g = props.graph;
    if (!g) return "No memory graph found — is there a LOOM.md?";
    const nodes = g.nodes || [];
    const edges = g.edges || [];
    const refs = edges.filter((e: any) => e.type !== "child");
    const flat = buildFlat(g);
    const lines: string[] = [];
    lines.push("LOOM memory graph — " + nodes.length + " nodes | " + edges.length + " links (from LOOM.md)");
    lines.push("");
    let idx = 0;
    for (const { node, depth } of flat) {
      const cur = idx === sel();
      if (cur) selLine = lines.length;
      const marker = cur ? ">" : " ";
      const indent = depth === 0 ? "  " : "    " + "  ".repeat(depth - 1) + "+- ";
      const tag = node.tags && node.tags.length ? "  #" + node.tags.join(" #") : "";
      lines.push(marker + indent + node.title + tag);
      if (cur && open() === idx && node.body) {
        for (const l of String(node.body).split("\n").slice(0, 4)) lines.push("      " + l);
      }
      idx++;
    }
    if (refs.length) {
      lines.push("");
      lines.push("  Links:");
      for (const e of refs) lines.push("    " + e.source + " -> " + e.target);
    }
    lines.push("");
    lines.push("  ↑↓ select | enter toggle body | esc close");
    return lines.join("\n");
  };

  const count = () => {
    const g = props.graph;
    return g && g.nodes ? g.nodes.length : 1;
  };
  useKeyboard((key: any) => {
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) { closeModal(); return; }
    if (kbs.dialogIs("dialog_select_prev", ks)) { setSel(s => Math.max(0, s - 1)); return; }
    if (kbs.dialogIs("dialog_select_next", ks)) { setSel(s => Math.min(count() - 1, s + 1)); return; }
    if (kbs.dialogIs("dialog_select_submit", ks)) { setOpen(o => (o === sel() ? null : sel())); return; }
    if (kbs.dialogIs("dialog_select_page_up", ks)) { setSel(s => Math.max(0, s - 10)); return; }
    if (kbs.dialogIs("dialog_select_page_down", ks)) { setSel(s => Math.min(count() - 1, s + 10)); return; }
    if (kbs.dialogIs("dialog_select_home", ks)) { setSel(0); return; }
    if (kbs.dialogIs("dialog_select_end", ks)) { setSel(count() - 1); }
  });

  const lines = () => content().split("\n");
  const visible = 34;
  const start = () => Math.max(0, Math.min(lines().length - visible, selLine - 2));
  const view = () => lines().slice(start(), start() + visible).join("\n");

  return (
    <ModalFrame title="Memory Graph" subtitle="↑↓ select | enter details | esc close" footer="">
      <box flexDirection="column" paddingX={2} paddingY={1}>
        <text fg={ui.fg}>{view()}</text>
      </box>
    </ModalFrame>
  );
}

export function openGraphModal() {
  let graph: any = null;
  let err: string | null = null;
  try {
    const { buildGraph } = require("../../core/graph.js");
    graph = buildGraph(process.cwd());
  } catch (e) {
    err = String((e as any)?.message || e);
  }
  openModal({ type: "graph", graph, graphError: err });
}

// ─── Subagents ───
function statusGlyph(s: SubagentEntry["status"], tick = 0): string {
  if (s === "running") return SPIN[tick % SPIN.length];
  if (s === "done") return GLYPH.check;
  if (s === "cancelled") return GLYPH.cross;
  return GLYPH.cross;
}

function statusColor(s: SubagentEntry["status"]): string {
  if (s === "running") return ui.warning;
  if (s === "done") return ui.success;
  if (s === "cancelled") return ui.fgMuted;
  return ui.error;
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
  const all = createMemo<SubagentEntry[]>(() => {
    const active = Array.from(activeSubagents().values());
    const seen = new Set(active.map(a => a.runId));
    const hist = subagentHistory().filter(h => !seen.has(h.runId));
    return active.concat(hist).sort((a: any, b: any) => b.startTime - a.startTime);
  });
  const [sel, setSel] = createSignal(0);
  const [statusMsg, setStatusMsg] = createSignal("");

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
      const cur = all()[sel()];
      if (cur) openSubagentDetail(cur.runId);
      return;
    }
    if (key.name === "r") { loadSubagentHistory({ limit: 200 }); setStatusMsg("history refreshed"); return; }
    if (key.name === "m") {
      const cur = all()[sel()];
      if (!cur) return;
      const { loadConfig, saveConfig } = require("../../config/settings.js");
      const cfg = loadConfig();
      cfg.agents = cfg.agents || {};
      const curModel = (cfg.agents[cur.agentId] && cfg.agents[cur.agentId].model) || "";
      openModal({
        type: "input", title: "Default model for " + cur.agent,
        placeholder: 'e.g. "anthropic/claude-sonnet-5-5" — empty clears',
        value: curModel,
        onPick(val: string) {
          closeModal();
          const v = String(val || "").trim();
          if (v) { cfg.agents[cur.agentId] = Object.assign({}, cfg.agents[cur.agentId], { model: v }); saveConfig(cfg); }
          else if (cfg.agents[cur.agentId]) { delete cfg.agents[cur.agentId].model; saveConfig(cfg); }
          setStatusMsg(v ? cur.agentId + " default model → " + v : cur.agentId + " default model cleared");
        },
      });
      return;
    }
    if (key.name === "c") {
      const cur = all()[sel()];
      if (cur && cur.status === "running") {
        const ok = cancelSubagentRun(cur.runId);
        setStatusMsg(ok ? "cancelling " + cur.agent + " …" : "cancel failed (already finished)");
      } else {
        setStatusMsg("nothing to cancel (selected is not running)");
      }
    }
  });

  const activeCount = createMemo(() => Array.from(activeSubagents().values()).filter(e => e.status === "running").length);

  return (
    <ModalFrame
      title="Subagents"
      subtitle={(activeCount() || 0) + " active · " + all().length + " total · ↑↓ navigate · enter details · c cancel · r refresh"}
      footer="enter details · c cancel running · r refresh history · esc close"
    >
      <Show when={win().total === 0}>
        <text fg={ui.fgMuted}>No subagent runs yet. Delegate via the task tool or @mention and it will appear here.</text>
      </Show>
      <Show when={win().total > 0}>
        <box flexDirection="column">
          {win().items.map((entry: any, i: number) => {
            const abs = win().start + i;
            const isSelected = abs === sel();
            const ms = entry.endTime ? entry.durationMs : (now() - entry.startTime);
            return (
              <box flexDirection="row" paddingX={1}
                backgroundColor={isSelected ? ui.bgPanelAlt : undefined}
                onMouseDown={() => setSel(abs)}>
                <text fg={statusColor(entry.status)}>{(isSelected ? "> " : "  ") + statusGlyph(entry.status, Math.floor(now() / 180)) + " "}</text>
                <text fg={isSelected ? ui.primary : ui.fg}>{entry.agent + "  "}</text>
                <text fg={ui.fgMuted}>{fmtDuration(ms) + "  "}</text>
                <text fg={ui.fgMuted}>{fmtCost(entry.costUsd) + "  · "}</text>
                <text fg={ui.fgDim}>{(entry.prompt || "").replace(/\s+/g, " ").slice(0, 44)}</text>
              </box>
            );
          })}
        </box>
      </Show>
      <Show when={statusMsg()}><text fg={ui.fgMuted}>{statusMsg()}</text></Show>
    </ModalFrame>
  );
}

export function SubagentDetailPanel() {
  const tick = ticker(500);
  useKeyboard((key: any) => {
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) closeModal();
  });
  const entry = createMemo<SubagentEntry | null>(() => {
    tick();
    const m = modal();
    const runId = m && m.runId;
    if (!runId) return null;
    const live = activeSubagents().get(runId);
    if (live) return live;
    return subagentHistory().find(h => h.runId === runId) || null;
  });
  const now = () => Date.now();

  return (
    <ModalFrame title="Subagent detail" subtitle="esc close" footer="esc close">
      <Show when={entry()} fallback={<text fg={ui.fgMuted}>Subagent not found</text>}>
        <box flexDirection="column">
          <text fg={ui.primary}>{(entry() as any).agent + "  " + statusGlyph((entry() as any).status) + "  " + (entry() as any).status}</text>
          <text fg={ui.fgMuted}>{"id: " + (entry() as any).runId}</text>
          <text fg={ui.fgMuted}>{"started: " + new Date((entry() as any).startTime).toISOString() + ((entry() as any).endTime ? "  ended: " + new Date((entry() as any).endTime).toISOString() : "  (running)")}</text>
          <text fg={ui.fgMuted}>{"duration: " + ((entry() as any).endTime ? fmtDuration((entry() as any).durationMs) : fmtDuration(now() - (entry() as any).startTime)) + "  cost: " + fmtCost((entry() as any).costUsd) + "  tokens: " + fmtTokens((entry() as any).tokensIn, (entry() as any).tokensOut)}</text>
          <text fg={ui.fgMuted}>{"prompt: " + ((entry() as any).prompt || "").slice(0, 500)}</text>
          <Show when={(entry() as any).toolLog && (entry() as any).toolLog.length > 0}>
            <text fg={ui.fgMuted}>{"tool log: " + (entry() as any).toolLog.join(" · ")}</text>
          </Show>
          <text fg={ui.fg}>output</text>
          <text fg={ui.fgDim}>{((entry() as any).content || "(empty)").slice(0, 4000)}</text>
        </box>
      </Show>
    </ModalFrame>
  );
}
