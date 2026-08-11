// Modals -- provider picker, model picker, key input, base URL, settings, companion chooser, palette.
import { createSignal } from "solid-js";
import { useKeyboard, usePaste } from "@opentui/solid";
import { palette } from "../theme.ts";
import {
  openModal, closeModal, modal, PROVIDERS, PROVIDER_ORDER, PROVIDER_LABELS,
  refreshProviderState, appendMessage, showToast, getSession, allModelOptions,
  companion, setCompanion, COMPANIONS, SLASH_LIST, windowFor,
  sidebarVisible, setSidebarVisible, showToolDetails, setShowToolDetails,
  showThinking, setShowThinking, persistUi, openPetsSync, setOpenPetsSync,
} from "../store.ts";
import { loadConfig, saveConfig, getBaseUrl, setBaseUrl } from "../../config/settings.js";
import { MCP_PRESETS, CONNECTOR_PRESETS } from "../mcp-presets.ts";

const ui = palette("loom");

function wheelStep(e: any, delta: number) {
  const dir = e?.scroll?.direction;
  return dir === "up" ? -delta : delta;
}

function ModalFrame(props: { title: string; subtitle?: string; children: any; footer?: string }) {
  return (
    <box position="absolute" top={0} left={0} right={0} bottom={0}
      alignItems="center" justifyContent="center" flexDirection="column" backgroundColor={ui.bg}>
      <box border borderStyle="rounded" borderColor={ui.primary} backgroundColor={ui.bgPanel}
        paddingX={3} paddingY={2} flexDirection="column" minWidth={52} maxWidth={72}>
        <text fg={ui.primary} bold>{props.title}</text>
        {props.subtitle ? <text fg={ui.fgMuted} dim marginTop={0}>{props.subtitle}</text> : null}
        <box flexDirection="column" marginTop={1}>{props.children}</box>
        {props.footer ? <text fg={ui.fgMuted} dim marginTop={1}>{props.footer}</text> : null}
      </box>
    </box>
  );
}

export function ProviderPicker() {
  const opts = PROVIDER_ORDER.map(p => ({ label: PROVIDER_LABELS[p] || p, value: p }));
  const [idx, setIdx] = createSignal(0);
  let winStart = 0;
  const win = () => { const s = windowFor(idx(), opts.length, 8, winStart); winStart = s; return { start: s, items: opts.slice(s, s + 8) }; };

  useKeyboard(key => {
    if (key.name === "escape") { closeModal(); return; }
    if (key.name === "up") { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.name === "down") { setIdx(i => Math.min(opts.length - 1, i + 1)); return; }
    if (key.name === "return") {
      const p = opts[idx()]?.value; if (!p) return;
      const sess = getSession();
      const cfg = loadConfig();
      const modelId = cfg.model?.[p] || (PROVIDERS[p]?.models?.[0]?.id);
      if (modelId) sess.setModel(p, modelId);
      else { cfg.provider = p; saveConfig(cfg); }
      closeModal(); refreshProviderState();
      showToast("Provider: " + (PROVIDER_LABELS[p] || p), "ok");
      setTimeout(() => openKeyModal(p), 100);
    }
  });

  const scrollBy = (e: any) => { setIdx(i => Math.max(0, Math.min(opts.length - 1, i + wheelStep(e, 1)))); };
  const clickRow = (i: number) => {
    if (i !== idx()) return;
    const p = opts[i]?.value; if (!p) return;
    const sess = getSession();
    const cfg = loadConfig();
    const modelId = cfg.model?.[p] || (PROVIDERS[p]?.models?.[0]?.id);
    if (modelId) sess.setModel(p, modelId);
    else { cfg.provider = p; saveConfig(cfg); }
    closeModal(); refreshProviderState();
    showToast("Provider: " + (PROVIDER_LABELS[p] || p), "ok");
    setTimeout(() => openKeyModal(p), 100);
  };

  return (
    <ModalFrame title="Connect Provider" footer="UP/DOWN navigate  |  Enter select  |  wheel scroll  |  Esc cancel">
      <box onMouseScroll={scrollBy}>
        {win().items.map((o, i) => {
          const abs = win().start + i;
          return (
            <box
              key={o.value} flexDirection="row" paddingY={0}
              onMouseDown={() => setIdx(abs)}
              onMouseUp={() => clickRow(abs)}
            >
              <text fg={abs === idx() ? ui.primary : ui.fgDim} bold={abs === idx()}>
                {(abs === idx() ? " > " : "   ")}{o.label}
                {(PROVIDERS[o.value]?.models?.length ? "  (" + PROVIDERS[o.value].models.length + " models)" : "")}
              </text>
            </box>
          );
        })}
      </box>
    </ModalFrame>
  );
}

// ── Model picker ──
export function openModelPicker() {
  const opts = allModelOptions().filter(function(o) { return o.value !== "__custom__"; });
  openModal({
    type: "select", title: "Select Model", options: opts, searchable: true,
    onPick(val, opt) {
      if (val === "__custom__") return;
      const provider = opt?.provider || loadConfig().provider;
      const sess = getSession();
      sess.setModel(provider, val);
      refreshProviderState(); closeModal();
      showToast("Model: " + provider + " -> " + val, "ok");
    },
  });
}

export function openKeyModal(provider: string) {
  const cur = (loadConfig().apiKeys || {})[provider] || "";
  openModal({
    type: "input", title: "API key for " + (PROVIDER_LABELS[provider] || provider),
    placeholder: cur ? "(already set -- leave blank to keep)" : "Paste your key",
    isKey: true,
    onPick(val) {
      const c = loadConfig(); c.apiKeys = c.apiKeys || {};
      if (val.trim()) { c.apiKeys[provider] = val.trim(); saveConfig(c); showToast("Key saved for " + provider, "ok"); }
      else showToast("Using env var " + provider.toUpperCase() + "_API_KEY");
      refreshProviderState(); closeModal();
    },
  });
}

export function openBaseUrlEditor(provider: string) {
  const cur = getBaseUrl(provider) || "(default)";
  openModal({
    type: "input", title: "Base URL for " + (PROVIDER_LABELS[provider] || provider),
    placeholder: "Current: " + cur,
    onPick(val) {
      if (!val.trim()) { closeModal(); return; }
      setBaseUrl(provider, val.trim()); closeModal();
      showToast("Base URL: " + val.trim());
    },
  });
}

export function openCompanionPicker() {
  openModal({ type: "companion" });
}

export function CompanionModal() {
  const entries = Object.entries(COMPANIONS);
  const [sel, setSel] = createSignal(0);
  let winStart = 0;
  const win = () => { const s = windowFor(sel(), entries.length, 6, winStart); winStart = s; return { start: s, items: entries.slice(s, s + 6) }; };

    useKeyboard(key => {
      if (key.name === "escape") { closeModal(); return; }
      if (key.name === "up") { setSel(i => Math.max(0, i - 1)); return; }
      if (key.name === "down") { setSel(i => Math.min(entries.length - 1, i + 1)); return; }
      if (key.name === "return") {
        const [petKey, c] = entries[sel()];
        setCompanion(petKey as any);
        persistUi();
        showToast(c.name + " is now your companion!", "ok");
        closeModal();
      }
    });

  const scrollBy = (e: any) => { setSel(i => Math.max(0, Math.min(entries.length - 1, i + wheelStep(e, 1)))); };
  const clickRow = (i: number) => {
    if (i !== sel()) return;
    const [petKey, c] = entries[i];
    setCompanion(petKey as any);
    persistUi();
    showToast(c.name + " is now your companion!", "ok");
    closeModal();
  };

  return (
    <ModalFrame title="Companion" footer="UP/DOWN choose  |  Enter confirm  |  wheel scroll  |  Esc close">
      <box onMouseScroll={scrollBy}>
        {win().items.map(([key, c], i) => {
          const abs = win().start + i;
          return (
            <box
              key={key} flexDirection="row" paddingLeft={abs === sel() ? 0 : 1} marginBottom={1}
              onMouseDown={() => setSel(abs)}
              onMouseUp={() => clickRow(abs)}
            >
              <text fg={abs === sel() ? ui.primary : ui.fgMuted}>{abs === sel() ? " > " : "   "}</text>
              <box flexDirection="column" marginRight={2}>
                {c.icon.map((line, li) => <text key={li} fg={abs === sel() ? ui.primary : ui.fgMuted}>{line}</text>)}
              </box>
              <box flexDirection="column">
                <text fg={abs === sel() ? ui.primary : ui.fg} bold={abs === sel()}>{c.name}</text>
                <text fg={ui.fgMuted} dim>{c.description}</text>
              </box>
            </box>
          );
        })}
      </box>
    </ModalFrame>
  );
}

export function SelectModal(props: {
  title: string;
  options: { label: string; value: any; sub?: string; provider?: string; header?: string; isHeader?: boolean; tags?: string[]; recent?: boolean }[];
  onPick: (value: any, option: any) => void;
  searchable?: boolean;
  onCancel?: () => void;
  // Live-preview: fire on selection change so theme pickers can repaint the
  // app while the user scrolls without closing the modal.
  onPreview?: (value: any) => void;
}) {
  // Long labels/subs must never wrap: the modal is maxWidth 72 (62 usable cells
  // after padding), so truncate each piece to its budget before rendering.
  const LABEL_MAX = 26, SUB_MAX = 18;
  const fit = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + "\u2026");
  const [index, setIndex] = createSignal(0);
  const [q, setQ] = createSignal("");

  const filtered = () => {
    const query = q().trim().toLowerCase();
    if (!query) return props.options;
    return props.options.filter(o => {
      if (o.isHeader) return false;
      const hay = (o.label + " " + (o.sub || "") + " " + (o.provider || "") + " " + String(o.tags || []).toLowerCase() + " " + String(o.value)).toLowerCase();
      return query.split(/\s+/).every(part => hay.includes(part));
    });
  };

  // Live-hook: fire onPreview AFTER the index has settled (Solid may batch
  // the signal write — schedule.fire settles next microtask).
  function firePreview() {
    if (!props.onPreview) return;
    setTimeout(() => {
      try { props.onPreview!(filtered()[index()]?.value); } catch {}
    }, 0);
  }

  // The selection must never land on a section header: it would render with
  // no highlight and Enter would do nothing. Always skip to the next row.
  const firstSelectable = () => {
    const list = filtered();
    const i = list.findIndex(o => o && !o.isHeader);
    return i < 0 ? 0 : i;
  };
  const stepSelectable = (i: number, dir: number) => {
    const list = filtered();
    let j = i + dir;
    while (j >= 0 && j < list.length && list[j] && list[j].isHeader) j += dir;
    if (j < 0 || j >= list.length) return i;
    return j;
  };
  // Start on the first real row (not a header).
  setIndex(firstSelectable());

  useKeyboard(key => {
    if (key.name === "escape") { closeModal(); if (props.onCancel) props.onCancel(); return; }
    if (key.name === "up") { setIndex(i => stepSelectable(i, -1)); firePreview(); return; }
    if (key.name === "down") { setIndex(i => stepSelectable(i, 1)); firePreview(); return; }
    if (key.name === "return") {
      const opt = filtered()[index()];
      if (!opt || opt.isHeader) return;
      props.onPick(opt.value, opt);
      return;
    }
    if (props.searchable) {
      if (key.name === "backspace") { setQ(v => v.slice(0, -1)); setIndex(firstSelectable()); firePreview(); return; }
      const s = key.sequence;
      if (!key.ctrl && !key.meta && s && s.length <= 10 && s !== "\r" && s !== "\n") {
        setQ(v => v + s);
        setIndex(firstSelectable());
        firePreview();
        return;
      }
    }
  });

  const scrollBy = (e: any) => {
    const step = wheelStep(e, 1);
    const dir = step < 0 ? -1 : 1;
    let i = index();
    for (let n = 0; n < Math.abs(step); n++) {
      const j = stepSelectable(i, dir);
      if (j === i) break;
      i = j;
    }
    setIndex(i);
  };
  const clickRow = (i: number) => {
    if (i !== index()) {
      setIndex(i);
      firePreview();
    }
    const o = filtered()[i];
    if (o?.isHeader) return;
    props.onPick(o?.value, o);
  };
  let winStart = 0;
  const win = () => {
    const total = filtered().length;
    winStart = windowFor(index(), total, 12, winStart);
    return { total, start: winStart, items: filtered().slice(winStart, winStart + 12) };
  };
  const rangeSub = () => {
    const w = win();
    if (w.total <= 12) return "";
    return "  showing " + (w.start + 1) + "-" + Math.min(w.start + 12, w.total) + " of " + w.total;
  };

  return (
    <ModalFrame title={props.title} subtitle={(props.searchable ? "search: " + (q() || "_") + rangeSub() : rangeSub())} footer={"UP/DOWN navigate  |  Enter select  |  wheel scroll  |  Esc cancel" + (props.searchable ? "  |  type to search" : "")}>
      <box onMouseScroll={scrollBy}>
        {win().items.map((opt, i) => {
          const abs = win().start + i;
          if (opt.isHeader) return (
            <text key={"h" + i} fg={ui.secondary} bold marginTop={i === 0 ? 0 : 1}>
              {opt.header + ":"}
            </text>
          );
          const active = abs === index();
          return (
            <box
              key={String(opt.value)} flexDirection="row" paddingLeft={2}
              onMouseDown={() => setIndex(abs)}
              onMouseUp={() => clickRow(abs)}
            >
              <text fg={active ? ui.primary : ui.fgDim}>
                {(active ? " > " : "   ") + fit(opt.label, LABEL_MAX)}
              </text>
              {opt.recent ? <text fg={ui.fgMuted}> {" \u2713 recent"}</text> : null}
              {opt.sub ? <text fg={ui.fgDim}>  {"(" + fit(opt.sub, SUB_MAX) + ")"}</text> : null}
            </box>
          );
        })}
      </box>
    </ModalFrame>
  );
}

export function InputModal(props: {
  title: string;
  placeholder: string;
  onPick: (value: string) => void;
  isKey?: boolean;
  onCancel?: () => void;
}) {
  const [val, setVal] = createSignal("");
  const masked = () => props.isKey ? "x".repeat(Math.max(0, val().length)) : val();

  useKeyboard(key => {
    if (key.name === "escape") { closeModal(); if (props.onCancel) props.onCancel(); return; }
    if (key.name === "return") { props.onPick(val()); return; }
    if (key.name === "backspace") { setVal(v => v.slice(0, -1)); return; }
    const s = key.sequence;
    if (!key.ctrl && !key.meta && s && s.length <= 10 && s !== "\r" && s !== "\n") {
      setVal(v => v + s);
    }
  });

  usePaste(event => {
    const txt = new TextDecoder().decode((event as any).bytes || "").replace(/[\r\n]+/g, "");
    if (txt) setVal(v => v + txt);
  });

  return (
    <ModalFrame title={props.title} subtitle={props.placeholder} footer="Enter confirm  |  Ctrl+V paste  |  Esc cancel">
      <box border borderStyle="rounded" borderColor={ui.border} paddingX={1} marginTop={1}>
        <text fg={ui.fg}>{masked() || " "}</text>
      </box>
    </ModalFrame>
  );
}

export function SettingsModal() {
  useKeyboard(key => {
    if (key.name === "escape") { closeModal(); }
    if (key.name === "d" || key.name === "D") { setShowToolDetails(v => !v); persistUi(); }
    if (key.name === "t" || key.name === "T") { setShowThinking(v => !v); persistUi(); }
    if (key.name === "b" || key.name === "B") { setSidebarVisible(v => !v); persistUi(); }
    if (key.name === "e" || key.name === "E") { setOpenPetsSync(v => !v); persistUi(); }
  });

  return (
    <ModalFrame title="Settings" footer="d/t/b/e toggle  |  Esc close">
      <text fg={ui.fg}>{"[d] Tool details:   " + (showToolDetails() ? "on" : "off") + "  show tool output"}</text>
      <text fg={ui.fg}>{"[t] Thinking:       " + (showThinking() ? "on" : "off") + "  show think time"}</text>
      <text fg={ui.fg}>{"[b] Sidebar:        " + (sidebarVisible() ? "on" : "off") + "  companion + todos"}</text>
      <text fg={ui.fg}>{"[e] OpenPets:       " + (openPetsSync() ? "on" : "off") + "  desktop pet sync"}</text>
    </ModalFrame>
  );
}

export function showHelpText() {
  const lines = ["Loom Code -- Slash Commands", ""];
  for (const c of SLASH_LIST) lines.push("  /" + c.cmd.padEnd(14) + "  " + c.desc + (c.args ? " (" + c.args + ")" : ""));
  lines.push("", "esc=interrupt  ctrl+c=exit  ctrl+b=sidebar  ctrl+p=palette  ctrl+x=leader");
  appendMessage({ role: "system", content: lines.join("\n") });
}

export function showProvidersText() {
  const lines = ["Supported providers:", ""];
  for (const p of PROVIDER_ORDER) {
    const mods = PROVIDERS[p]?.models?.length || 0;
    lines.push("  " + p.padEnd(12) + " " + String(mods).padEnd(3) + " models   " + (PROVIDER_LABELS[p] || p));
  }
  lines.push("", "/connect to pick interactively.");
  appendMessage({ role: "system", content: lines.join("\n") });
}

// ── Agents (OpenCode-style primaries + subagents) ──
export function showAgentsText() {
  const { loadAgents } = require("../../core/agents.js");
  const agents = loadAgents();
  const lines = ["AGENTS", ""];
  for (const a of Object.values(agents)) {
    const mode = a.mode === "primary" ? "primary" : "subagent";
    const tools = a.tools && a.tools.length ? "[" + a.tools.join(" ") + "]" : "[*]";
    const model = a.model ? " model=" + a.model : "";
    lines.push("  " + a.id.padEnd(10) + " " + mode.padEnd(9) + " " + tools.padEnd(22) + model);
    lines.push("      " + a.description);
  }
  lines.push(
    "",
    "  Automatic: the main agent calls the task tool whenever a subtask needs it.",
    "  Manual: type @<agent> in the input (e.g. @explore find the bug).",
    "  Config: ~/.loom/config.json \u2192 agents: { name: { mode, description, tools, model, prompt } }"
  );
  appendMessage({ role: "system", content: lines.join("\n") });
}

// ── MCP server / connector browser popup ──
// Lists every configured server (seeded defaults + user-added) with on/off
// state; Enter toggles, A opens the add flow, Esc closes.
// `kind` decides which preset list the "A" flow offers: "mcp" (dev tools) or
// "connector" (hosting/cloud services). Both share the same underlying
// mcp-manager — a connector IS an MCP server, just surfaced separately.
const MCP_FIT = 52;
function mcpFit(s: string, n = MCP_FIT) {
  const flat = String(s || "").replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, Math.max(1, n - 1)) + "\u2026";
}

// The preset add flow: pick a preset (or Custom), fill the single form below
// (name / command / args / env — preset fields are pre-filled), then save.
function openPresetPicker(presets: any[], kind: "mcp" | "connector") {
  const addLabel = kind === "connector" ? "Add connector" : "Add MCP server";
  const backType = kind === "connector" ? "connectors" : "mcp";

  closeModal();
  const picker = presets.map(p => ({
    label: p.label,
    sub: p.prompts.length ? "needs a token" : "no key needed",
    value: p.id,
  })).concat([{ label: "Custom…", sub: "name + command + args + env", value: "__custom__" }]);
  openModal({
    type: "select", title: addLabel,
    searchable: false,
    options: picker,
    onPick: function(val: any) {
      closeModal();
      const backTo = function() { closeModal(); setTimeout(function() { openModal({ type: backType as any }); }, 10); };
      openModal({
        type: "addserver",
        kind, backType,
        presetId: val === "__custom__" ? undefined : String(val),
        onCancel: backTo,
        onSaved: backTo,
      });
    },
  });
}

// Mask env values but keep key names visible: "FIGMA_API_KEY=••••••" so the
// user can verify which keys they've filled without secrets on screen.
function maskPairs(v: string): string {
  return v.split(/(\s+)/).map(part => {
    if (!part.trim()) return part;
    const eq = part.indexOf("=");
    if (eq < 0) return part;
    const k = part.slice(0, eq), val = part.slice(eq + 1);
    return k + "=" + (val ? "•".repeat(Math.min(val.length, 16)) : "");
  }).join("");
}

// Field-shaped input row — one line of the form in AddServerModal.
function FormField(props: {
  label: string; desc: string; active: boolean; value: string; placeholder: string;
  onInput: (v: string) => void; showCursor?: boolean; isKey?: boolean;
}) {
  const caret = props.showCursor ? "▌" : "";
  const display = props.isKey && props.value ? maskPairs(props.value) : props.value;
  const shown = display + caret || (props.value ? caret : props.placeholder);
  return (
    <box flexDirection="row" paddingX={1} paddingY={0} alignItems="center"
      border borderStyle="rounded"
      borderColor={props.active ? ui.primary : ui.border}
      backgroundColor={props.active ? ui.bgPanel : "transparent"}>
      <text fg={props.active ? ui.primary : ui.fgMuted} bold={props.active}>{props.label.padEnd(9) + "  "}</text>
      <text fg={props.active || props.value ? ui.fg : ui.fgMuted} dim={!props.active && !props.value}>
        {shown}
      </text>
      <text fg={ui.fgMuted} dim marginLeft={2} flexGrow={1}>{props.desc}</text>
    </box>
  );
}

// Form for adding an MCP server or connector. One modal — fields stacked
// vertically. Up/Down + Tab move between fields, Enter on last field saves
// (or validates and toasts), Esc cancels back to the browser.
export function AddServerModal(props: {
  kind: "mcp" | "connector";
  backType: string;
  presetId?: string;
  onSaved?: (name: string) => void;
}) {
  const kindIsConn = props.kind === "connector";
  const title = kindIsConn ? "Add Connector" : "Add MCP server";
  const toastOk = kindIsConn ? "Connector added" : "MCP added";
  const preset = props.presetId
    ? (props.kind === "connector" ? CONNECTOR_PRESETS : MCP_PRESETS).find(p => p.id === props.presetId)
    : undefined;

  const isWin = process.platform === "win32";

  const [focusIdx, setFocusIdx] = createSignal(preset && preset.prompts.length ? 3 : 0);
  const [fields, setFields] = createSignal<Record<string, string>>({
    name: preset ? preset.id : "",
    // Preset command: docker show as-is; npx shows the package in args so the
    // user sees what runs. Tokens stay as $KEY — resolved from env on save.
    command: preset ? (preset.command || "npx") : "",
    // npx preload: "-y <package> <args>" via npxRun's shape, minus the wrapper.
    args: preset
      ? (preset.command
          ? (preset.args || []).join(" ")
          : (["-y", preset.package].concat(preset.args || [])).join(" "))
      : "",
    // Presets prefill "KEY=" as a header prompt.
    env: preset ? preset.prompts.map(pr => pr.key + "=").join(" ") : "",
  });

  const fieldDef = [
    { key: "name",    label: "Name",    desc: "short id — letters/digits/-/_ only", required: true,  isKey: false },
    { key: "command", label: "Command", desc: "npx | docker | cmd | full path", required: true,  isKey: false },
    { key: "args",    label: "Args",    desc: "space-separated — e.g. -y @upstash/context7-mcp", required: false, isKey: false },
    { key: "env",     label: "Env vars", desc: "KEY=VALUE pairs, space/comma separated", required: false, isKey: true },
  ];

  function parseEnv(raw: string): Record<string, string> | null {
    const out: Record<string, string> = {};
    for (const p of raw.split(/[\s,]+/).filter(Boolean)) {
      const eq = p.indexOf("=");
      if (eq < 1) return null;
      const k = p.slice(0, eq).trim().toUpperCase();
      const v = p.slice(eq + 1).trim();
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) return null;
      out[k] = v;
    }
    return out;
  }

  function validate(f: Record<string, string>): string | null {
    if (!f.name.trim()) return "Name is required.";
    if (!/^[A-Za-z0-9_-]+$/.test(f.name.trim())) return "Letters, digits, - and _ only.";
    if (f.name.trim().includes("__")) return "No '__' in names (breaks tool naming).";
    if (!f.command.trim()) return "Command is required.";
    if (f.env.trim() && parseEnv(f.env) === null) return "Env vars: KEY=VALUE pairs — e.g. FIGMA_API_KEY=fgd_… or LINEAR_API_KEY=lin_…";
    return null;
  }

  function save() {
    const f = fields();
    const err = validate(f);
    if (err) { showToast(err, "error"); return; }
    const { addServer } = require("../../mcp/mcp-manager.js");
    let cmd = f.command.trim();
    let args = f.args.trim() ? f.args.trim().split(/\s+/) : [];
    const env = f.env.trim() ? parseEnv(f.env) : undefined;
    // Resolve "$KEY" placeholders in args from the collected env — the value
    // never lands on the command line.
    if (env) {
      const envMap: Record<string, string> = env;
      args = args.map(a => {
        if (typeof a === "string" && a.startsWith("$")) {
          const key = a.slice(1);
          return envMap[key] !== undefined ? envMap[key] : a;
        }
        return a;
      });
    }
    if (isWin && cmd === "npx") { cmd = "cmd"; args = ["/c", "npx"].concat(args); }
    const res = addServer(f.name.trim(), cmd, args, env ? { env } : undefined);
    if (res && !res.error) {
      showToast(toastOk + ": " + f.name.trim(), "ok");
      closeModal();
      if (props.onSaved) props.onSaved(f.name.trim());
      setTimeout(function() { openModal({ type: props.backType as any }); }, 10);
    } else {
      showToast(String(res && res.error ? res.error : "Failed to add.").slice(0, 80), "error");
    }
  }

  useKeyboard(key => {
    const k = key.name;
    if (k === "escape") { closeModal(); setTimeout(function() { openModal({ type: props.backType as any }); }, 10); return; }
    if (k === "up") { setFocusIdx(i => Math.max(0, i - 1)); return; }
    if (k === "down" || k === "tab") { setFocusIdx(i => Math.min(fieldDef.length - 1, i + 1)); return; }
    if (k === "shift+tab") { setFocusIdx(i => Math.max(0, i - 1)); return; }
    if (k === "return") {
      if (focusIdx() < fieldDef.length - 1) setFocusIdx(i => i + 1);
      else save();
      return;
    }
    if (k === "backspace" || k === "delete") {
      const fx = fields(); fx[fieldDef[focusIdx()].key] = fx[fieldDef[focusIdx()].key].slice(0, -1); setFields({ ...fx }); return;
    }
    const s = key.sequence;
    if (!key.ctrl && !key.meta && s && s.length <= 10 && s !== "\r" && s !== "\n" && s !== "\t") {
      const fx = fields(); fx[fieldDef[focusIdx()].key] += s; setFields({ ...fx });
    }
  });

  // Paste: drop multi-word / multi-line into the focused field.
  usePaste((ev: any) => {
    const txt = new TextDecoder().decode(ev.bytes || "").trim();
    if (!txt) return;
    const fx = fields();
    fx[fieldDef[focusIdx()].key] = (fx[fieldDef[focusIdx()].key] + " " + txt).trim();
    setFields({ ...fx });
  });

  const f = fields();
  const ready = !validate(f) ? "— all good, press Enter on the last field to save" : "";
  const presetTitle = preset ? preset.label + (preset.prompts.length ? "  ·  fill env below" : "  ·  no keys needed") : "Custom";
  return (
    <ModalFrame
      title={title + "  ·  " + presetTitle}
      subtitle={"Fill the fields, then press Enter on Env vars to save."}
      footer={"Up/Down/Tab move · Enter next/save · Esc cancel"}
    >
      <box flexDirection="column" marginTop={1}>
        {fieldDef.map((fd, i) => (
          <FormField
            key={fd.key} label={fd.label} desc={fd.desc}
            active={focusIdx() === i} value={f[fd.key]}
            showCursor={focusIdx() === i} isKey={fd.isKey}
            placeholder={fd.key === "env" && preset ? "KEY=VALUE  KEY=VALUE — Enter = save" : fd.desc}
            onInput={(v: string) => { const fx = fields(); fx[fd.key] = v; setFields({ ...fx }); }}
          />
        ))}
      </box>
      <box paddingX={1} marginTop={1}>
        <text fg={ready ? ui.success : ui.fgMuted} dim={!ready}>
          {ready || "Name and Command required; Args and Env optional."}
        </text>
        <text fg={ui.fgMuted} dim>{"Stored in ~/.loom/mcp.json — secrets masked on screen."}</text>
      </box>
    </ModalFrame>
  );
}

function ServerBrowser(props: { kind: "mcp" | "connector" }) {
  const kind = props.kind;
  const title = kind === "connector" ? "Connectors" : "MCP Servers";
  const presets = kind === "connector" ? CONNECTOR_PRESETS : MCP_PRESETS;
  const { listServers, toggleServer } = require("../../mcp/mcp-manager.js");
  const [servers, setServers] = createSignal(listServers());
  const [sel, setSel] = createSignal(0);

  const refresh = () => setServers(listServers());

  useKeyboard(key => {
    if (key.name === "escape") { closeModal(); return; }
    if (key.name === "up") { setSel(i => Math.max(0, i - 1)); return; }
    if (key.name === "down") { setSel(i => Math.min(servers().length - 1, i + 1)); return; }
    if (key.name === "a" || key.name === "A") { openPresetPicker(presets, kind); return; }
    if (key.name === "return") {
      const s = servers()[sel()];
      if (!s) return;
      const res = toggleServer(s.name);
      if (res && res.error) { showToast(String(res.error), "error"); return; }
      showToast("MCP " + s.name + ": " + (s.enabled ? "off" : "on"), "ok");
      refresh();
      return;
    }
  });

  const scrollBy = (e: any) => { setSel(i => Math.max(0, Math.min(servers().length - 1, i + wheelStep(e, 1)))); };
  let winStart = 0;
  const win = () => {
    const total = servers().length;
    winStart = windowFor(sel(), total, 12, winStart);
    return { total, start: winStart, items: servers().slice(winStart, winStart + 12) };
  };
  const rangeSub = () => {
    const w = win();
    return w.total > 12 ? "  showing " + (w.start + 1) + "-" + Math.min(w.start + 12, w.total) + " of " + w.total : "";
  };

  return (
    <ModalFrame title={title} subtitle={"Enter toggles a server on/off" + rangeSub()} footer={"Enter toggle  |  A add " + (kind === "connector" ? "connector" : "server") + "  |  wheel scroll  |  Esc close"}>
      <box onMouseScroll={scrollBy}>
        {win().items.map((s, i) => {
          const abs = win().start + i;
          return (
            <box
              key={s.name} flexDirection="row" paddingY={0}
              onMouseDown={() => setSel(abs)}
              onMouseUp={() => { if (abs === sel()) { const r = toggleServer(s.name); if (!r || !r.error) refresh(); } }}
            >
              <text fg={abs === sel() ? ui.primary : ui.fgDim} bold={abs === sel()}>
                {"  " + (s.enabled ? "[on] " : "[off] ") + s.name}
              </text>
              <text fg={ui.fgMuted} dim>{"   \u2192  " + mcpFit(s.command + " " + (s.args || []).join(" "))}</text>
            </box>
          );
        })}
      </box>
    </ModalFrame>
  );
}

export function McpModal() {
  return <ServerBrowser kind="mcp" />;
}

export function ConnectorsModal() {
  return <ServerBrowser kind="connector" />;
}

// Palette modal (ctrl+p) - proper popup window
export function PaletteModal(props: { onPick: (cmd: string) => void }) {
  const items = SLASH_LIST.map(c => ({ label: "/" + c.cmd, value: c.cmd, sub: c.desc }));
  const [sel, setSel] = createSignal(0);
  const [q, setQ] = createSignal("");

  const filtered = () => {
    const query = q().toLowerCase();
    return query ? items.filter(x => x.value.startsWith(query)) : items;
  };

  useKeyboard(key => {
    const k = key.name;
    if (k === "escape") { closeModal(); return; }
    if (k === "backspace") { setQ(v => v.slice(0, -1)); setSel(0); return; }
    if (k === "up") { setSel(i => Math.max(0, i - 1)); return; }
    if (k === "down") { setSel(i => Math.min(filtered().length - 1, i + 1)); return; }
    if (k === "return") {
      const f = filtered();
      const i = sel();
      if (f.length > i) {
        const cmd = "/" + f[i].value;
        props.onPick(cmd);
        closeModal();
      }
      return;
    }
    if (!key.ctrl && !key.meta && key.sequence && key.sequence.length <= 3 && ["\r","\n"].indexOf(key.sequence) === -1) {
      setQ(v => v + key.sequence);
      setSel(0);
    }
  });

  const scrollBy = (e: any) => { setSel(i => Math.max(0, Math.min(filtered().length - 1, i + wheelStep(e, 1)))); };
  const clickRow = (i: number) => {
    if (i !== sel()) return;
    const f = filtered();
    if (f.length > i) {
      props.onPick("/" + f[i].value);
      closeModal();
    }
  };
  let winStart = 0;
  const win = () => {
    const f = filtered();
    winStart = windowFor(sel(), f.length, 12, winStart);
    return { start: winStart, items: f.slice(winStart, winStart + 12) };
  };

  return (
    <ModalFrame title="Command Palette" subtitle={"Type to filter (" + filtered().length + " commands)"}>
      <box onMouseScroll={scrollBy}>
        {win().items.map((it, i) => {
          const abs = win().start + i;
          return (
            <box
              key={it.value} flexDirection="row" paddingY={0}
              onMouseDown={() => setSel(abs)}
              onMouseUp={() => clickRow(abs)}
            >
              <text fg={abs === sel() ? ui.primary : ui.fgDim} bold={abs === sel()}>
                {abs === sel() ? "> " : "   "}{it.label.split("/")[1] || it.label}
              </text>
            </box>
          );
        })}
      </box>
    </ModalFrame>
  );
}

export function openCustomModelId() {
  const pv = loadConfig().provider || "nvidia";
  openModal({
    type: "input", title: "Custom model ID for " + (PROVIDER_LABELS[pv] || pv),
    placeholder: "e.g. deepseek-ai/deepseek-v4-flash",
    onPick(val) {
      if (!val.trim()) { closeModal(); return; }
      const c = loadConfig(); c.provider = pv; c.model = c.model || {}; c.model[pv] = val.trim();
      saveConfig(c); refreshProviderState(); closeModal();
      showToast("Model: " + pv + " -> " + val.trim(), "ok");
    },
  });
}
