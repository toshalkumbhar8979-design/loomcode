// Modals -- provider picker, model picker, key input, base URL, settings, palette.
import { createSignal, createMemo, onMount } from "solid-js";
import { useKeyboard, usePaste } from "@opentui/solid";
import { palette } from "../theme.ts";
import * as kbs from "../keybinds.ts";
import {
  openModal, closeModal, modal, PROVIDERS, PROVIDER_ORDER, PROVIDER_LABELS,
  refreshProviderState, appendMessage, showToast, getSession, allModelOptions,
  SLASH_LIST, windowFor,
  sidebarVisible, setSidebarVisible, showToolDetails, setShowToolDetails,
  showThinking, setShowThinking, persistUi,
} from "../store.ts";
import { loadConfig, saveConfig, getBaseUrl, setBaseUrl } from "../../config/settings.js";
import { MCP_PRESETS, CONNECTOR_PRESETS } from "../mcp-presets.ts";
const plugin = require("../../core/plugin-cmd.js");

const ui = palette("loom");

// Dialog nav labels from the resolved keybinds (shown in modal footers).
function kbNav() {
  return {
    prev: kbs.label("dialog_select_prev").toUpperCase(),
    next: kbs.label("dialog_select_next").toUpperCase(),
    submit: kbs.label("dialog_select_submit").toUpperCase(),
    cancel: kbs.label("modal_cancel").toUpperCase(),
  };
}

function wheelStep(e: any, delta: number) {
  const dir = e?.scroll?.direction;
  return dir === "up" ? -delta : delta;
}

export function ModalFrame(props: { title: string; subtitle?: string; children: any; footer?: string }) {
  // Floating panel: centered over the terminal but NOT a full-screen takeover —
  // no backdrop fill, so the chat and any running agent stay visible behind it
  // ("same window, hovering"). Keys still belong to the modal while open.
  return (
    <box position="absolute" top={0} left={0} right={0} bottom={0}
      alignItems="center" justifyContent="center" flexDirection="column">
      <box border borderStyle="rounded" borderColor={ui.primary} backgroundColor={ui.bgPanel}
        paddingX={3} paddingY={2} flexDirection="column" minWidth={52} maxWidth={72}>
        <text fg={ui.primary}>{props.title}</text>
        {props.subtitle ? <text fg={ui.fgMuted} marginTop={0}>{props.subtitle}</text> : null}
        <box flexDirection="column" marginTop={1}>{props.children}</box>
        {props.footer ? <text fg={ui.fgMuted} marginTop={1}>{props.footer}</text> : null}
      </box>
    </box>
  );
}

export function ProviderPicker() {
  // opencode-scale provider list: make sure the models.dev registry is cached
  // (fetched once, ~/.loom/models-dev.json). When a fetch lands mid-session
  // the picker re-opens with the full provider list. When the cache is already
  // fresh the picker must NOT re-open itself — that would loop forever and
  // clobber every other modal.
  onMount(() => {
    const { ensureRegistry } = require("../../providers/index.js");
    const hadCache = require("../../providers/registry.js").isRegistryFresh();
    ensureRegistry().then((count) => {
      if (modal()?.type !== "provider") return;
      if (hadCache || !count) return;
      closeModal();
      setTimeout(() => openModal({ type: "provider" }), 50);
    });
  });

  const opts = PROVIDER_ORDER.map(p => ({
    label: PROVIDER_LABELS[p] || p,
    value: p,
    sub: PROVIDERS[p]?.models?.length ? String(PROVIDERS[p].models.length) + " models" : undefined,
  }));
  const pick = (val: any) => {
    const p = String(val);
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
    <SelectModal
      title="Connect Provider"
      options={opts}
      searchable={true}
      onPick={pick}
    />
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
  // Page jumps step over a full window (12 rows), skipping section headers.
  const pageJump = (i: number, dir: number) => {
    const list = filtered();
    if (!list.length) return i;
    let j = i;
    for (let n = 0; n < 12; n++) {
      const next = stepSelectable(j, dir);
      if (next === j) return j;
      j = next;
    }
    return j;
  };
  const lastSelectable = () => {
    const list = filtered();
    for (let j = list.length - 1; j >= 0; j--) if (list[j] && !list[j].isHeader) return j;
    return 0;
  };
  // Start on the first real row (not a header).
  setIndex(firstSelectable());

  // Hover must not fight scrolling: any keyboard/wheel/search index change
  // locks hover-selection briefly, so the list sliding under a stationary
  // cursor cannot yank the selection back (this feedback loop read as
  // "jitter" while scrolling the model picker).
  let hoverLockUntil = 0;
  const lockHover = () => { hoverLockUntil = Date.now() + 250; };
  const setIndexByKey = (fn: (i: number) => number) => { setIndex(fn); lockHover(); };

  const nav = kbNav();

  useKeyboard(key => {
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) { closeModal(); if (props.onCancel) props.onCancel(); return; }
    if (kbs.dialogIs("dialog_select_prev", ks)) { setIndexByKey(i => stepSelectable(i, -1)); firePreview(); return; }
    if (kbs.dialogIs("dialog_select_next", ks)) { setIndexByKey(i => stepSelectable(i, 1)); firePreview(); return; }
    if (kbs.dialogIs("dialog_select_page_up", ks)) { setIndexByKey(i => pageJump(i, -1)); firePreview(); return; }
    if (kbs.dialogIs("dialog_select_page_down", ks)) { setIndexByKey(i => pageJump(i, 1)); firePreview(); return; }
    if (kbs.dialogIs("dialog_select_home", ks)) { setIndexByKey(firstSelectable); firePreview(); return; }
    if (kbs.dialogIs("dialog_select_end", ks)) { setIndexByKey(lastSelectable); firePreview(); return; }
    if (kbs.dialogIs("dialog_select_submit", ks)) {
      const opt = filtered()[index()];
      if (!opt || opt.isHeader) return;
      props.onPick(opt.value, opt);
      return;
    }
    if (props.searchable) {
      // Reset to 0, not firstSelectable(): setQ is batched, so firstSelectable()
      // would read the STALE list and land past its end (dead arrows/blank row).
      if (key.name === "backspace") { setQ(v => v.slice(0, -1)); setIndexByKey(() => 0); firePreview(); return; }
      const s = key.sequence;
      if (!key.ctrl && !key.meta && s && s.length <= 10 && s !== "\r" && s !== "\n") {
        setQ(v => v + s);
        setIndexByKey(() => 0);
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
    setIndexByKey(() => i);
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
  // Window of 12 rows, computed ONCE per reactive change (the old version
  // mutated `winStart` from inside the JSX — called three times per render).
  let lastStart = 0;
  const win = createMemo(() => {
    const total = filtered().length;
    lastStart = windowFor(index(), total, 12, lastStart);
    return { total, start: lastStart, items: filtered().slice(lastStart, lastStart + 12) };
  });
  const rangeSub = () => {
    const w = win();
    if (w.total <= 12) return "";
    return "  showing " + (w.start + 1) + "-" + Math.min(w.start + 12, w.total) + " of " + w.total;
  };

  return (
    <ModalFrame title={props.title} subtitle={(props.searchable ? "search: " + (q() || "_") + rangeSub() : rangeSub())} footer={nav.prev + "/" + nav.next + " navigate  |  " + nav.submit + " select  |  wheel scroll  |  " + nav.cancel + " cancel" + (props.searchable ? "  |  type to search" : "")}>
      {/* Fixed height: the modal frame must not resize while scrolling.
          Headers used to add an extra margin row, so the centered modal
          bounced between 12/13/14 rows on every page of a header-heavy list
          (the model picker) — the "jitter". Every item is now exactly one
          row and the window is always 12 rows tall. */}
      <box onMouseScroll={scrollBy} height={12} flexShrink={0}>
        {win().items.map((opt, i) => {
          const abs = win().start + i;
          if (opt.isHeader) return (
            <text fg={ui.secondary}>
              {opt.header + ":"}
            </text>
          );
          const active = abs === index();
          return (
            <box
              flexDirection="row" paddingLeft={2}
              // Hover moves the selection (live theme preview via onPreview) —
              // but only for genuine pointer movement, never while a
              // keyboard/wheel scroll is settling (see hoverLockUntil).
              onMouseOver={() => { if (Date.now() >= hoverLockUntil && abs !== index()) { setIndex(abs); firePreview(); } }}
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
  value?: string;
  caretStart?: number;
  onCancel?: () => void;
}) {
  const [val, setVal] = createSignal(props.value || "");
  const [caret, setCaret] = createSignal(
    typeof props.caretStart === "number" ? props.caretStart : (props.value || "").length
  );
  const masked = () => props.isKey ? "x".repeat(Math.max(0, val().length)) : val();
  // Caret insertion: shown = left part + block cursor + right part.
  const shown = () => {
    const d = masked();
    const c = Math.min(caret(), d.length);
    return d.slice(0, c) + "\u258c" + d.slice(c);
  };

  useKeyboard(key => {
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) { closeModal(); if (props.onCancel) props.onCancel(); return; }
    if (kbs.dialogIs("dialog_select_submit", ks)) { props.onPick(val()); return; }
    if (key.name === "backspace") {
      setVal(v => { const c = Math.min(caret(), v.length); return v.slice(0, Math.max(0, c - 1)) + v.slice(c); });
      setCaret(c => Math.max(0, c - 1));
      return;
    }
    if (key.name === "left") { setCaret(c => Math.max(0, c - 1)); return; }
    if (key.name === "right") { setCaret(c => Math.min(val().length, c + 1)); return; }
    if (key.name === "home") { setCaret(0); return; }
    if (key.name === "end") { setCaret(val().length); return; }
    const s = key.sequence;
    if (!key.ctrl && !key.meta && s && s.length <= 10 && s !== "\r" && s !== "\n") {
      setVal(v => { const c = Math.min(caret(), v.length); return v.slice(0, c) + s + v.slice(c); });
      setCaret(c => Math.min(val().length, c) + s.length);
    }
  });

  usePaste(event => {
    const txt = new TextDecoder().decode((event as any).bytes || "").replace(/[\r\n]+/g, "");
    if (txt) {
      setVal(v => { const c = Math.min(caret(), v.length); return v.slice(0, c) + txt + v.slice(c); });
      setCaret(c => Math.min(val().length, c) + txt.length);
    }
  });

  return (
    <ModalFrame title={props.title} subtitle={props.placeholder} footer={kbNav().submit + " confirm  |  \u2190\u2192 move  |  Ctrl+V paste  |  " + kbNav().cancel + " cancel"}>
      <box border borderStyle="rounded" borderColor={ui.border} paddingX={1} marginTop={1}>
        <text fg={ui.fg}>{shown()}</text>
      </box>
    </ModalFrame>
  );
}

export function SettingsModal() {
  useKeyboard(key => {
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) { closeModal(); }
    if (key.name === "d" || key.name === "D") { setShowToolDetails(v => !v); persistUi(); }
    if (key.name === "t" || key.name === "T") { setShowThinking(v => !v); persistUi(); }
    if (key.name === "b" || key.name === "B") { setSidebarVisible(v => !v); persistUi(); }
  });

  return (
    <ModalFrame title="Settings" footer={"d/t/b toggle  |  " + kbNav().cancel + " close"}>
      <text fg={ui.fg}>{"[d] Tool details:   " + (showToolDetails() ? "on" : "off") + "  show tool output"}</text>
      <text fg={ui.fg}>{"[t] Thinking:       " + (showThinking() ? "on" : "off") + "  show think time"}</text>
      <text fg={ui.fg}>{"[b] Sidebar:        " + (sidebarVisible() ? "on" : "off") + "  todos + files"}</text>
    </ModalFrame>
  );
}

export function showHelpText() {
  const lines = ["Loom Code -- Slash Commands", ""];
  for (const c of SLASH_LIST) lines.push("  /" + c.cmd.padEnd(14) + "  " + c.desc + (c.args ? " (" + c.args + ")" : ""));
  lines.push("", "  " + kbs.label("session_interrupt") + "=interrupt  " + kbs.label("app_exit") + "=exit  " + kbs.label("sidebar_toggle") + "=sidebar  " + kbs.label("command_list") + "=palette" +
    (kbs.leaderKey() ? "  " + kbs.leaderKey() + "=leader" : ""));
  lines.push("  Customize in ~/.loom/tui.json \u2014 edit that file directly, then relaunch.");
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
  const agents = loadAgents() as Record<string, any>;
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

// Build a claude/opencode-style one-liner for a preset, with -e KEY=VALUE
// entries (empty values = placeholders the user fills inline in the one-line
// editor). $KEY args resolve at add time from the -e env.
function presetAddLine(p: any, envValues?: Record<string, string>): string {
  const parts: string[] = [];
  for (const k of Object.keys(p.env || {})) parts.push("-e", k + "=" + (envValues ? (envValues[k] || "") : ""));
  parts.push(p.id, "--");
  if (p.command) parts.push(p.command, ...(p.args || []));
  else parts.push("npx", "-y", p.package, ...(p.args || []));
  return parts.join(" ");
}

// The add flow: pick a preset (or Custom). Presets that need secrets walk a
// guided key-entry dialog (one masked field per prompt, pasted/typed, then the
// one-liner is built automatically); everything else opens the one-line
// editor in claude/opencode syntax — `[-e KEY=V] <name> [--] <command> [args...]`.
function openPresetPicker(presets: any[], kind: "mcp" | "connector") {
  const addLabel = kind === "connector" ? "Add connector" : "Add MCP server";
  const backType = kind === "connector" ? "connectors" : "mcp";

  // Build the server from collected env + optional args and land it; reopen
  // the browser on success, toast the error otherwise.
  const submitLine = (line: string, reopenOnError: boolean) => {
    const msg = plugin.mcpAddLineCmd(line);
    if (msg.startsWith("Added")) {
      showToast(msg, "ok");
      closeModal();
      setTimeout(function() { openModal({ type: backType as any }); }, 10);
    } else {
      showToast(String(msg).slice(0, 80), "error");
      if (reopenOnError) {
        closeModal();
        setTimeout(function() { openModal({ type: backType as any }); }, 10);
      }
    }
  };

  const guidedAdd = (preset: any) => {
    const prompts: any[] = preset.prompts || [];
    const env: Record<string, string> = {};
    const askPrompt = (i: number) => {
      if (i >= prompts.length) {
        const oap = preset.optionalArgsPrompt;
        if (!oap) { submitLine(presetAddLine(preset, env), true); return; }
        // Optional extra arg (e.g. --project-ref): Enter alone skips it.
        openModal({
          type: "input",
          title: addLabel + " \u00B7 " + preset.label,
          placeholder: oap.label,
          onCancel: function() { submitLine(presetAddLine(preset, env), true); },
          onPick: function(v: string) {
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
        title: addLabel + " \u00B7 " + preset.label + "  (" + (i + 1) + "/" + prompts.length + ")",
        placeholder: pr.label,
        isKey: pr.mask !== false,
        onCancel: function() { closeModal(); setTimeout(function() { openModal({ type: backType as any }); }, 10); },
        onPick: function(val: string) {
          const t = String(val || "").trim();
          if (!t) { showToast(pr.key + " is required", "error"); askPrompt(i); return; }
          // A value with whitespace would break the generated `-e KEY=value`
          // token in the one-liner — reject it and re-prompt (covers every
          // credential prompt in the loop, including multi-credential presets).
          if (/\s/.test(t)) { showToast(pr.key + " must not contain spaces", "error"); askPrompt(i); return; }
          env[pr.key] = t;
          askPrompt(i + 1);
        },
      });
    };

    closeModal();
    if (!prompts.length) {
      openLine(presetAddLine(preset));
      return;
    }
    askPrompt(0);
  };
const openLine = function(line: string) {
    openModal({
      type: "input",
      title: addLabel + "  \u00B7  one line",
      placeholder: "e.g. -e KEY=V " + (kind === "connector" ? "railway" : "stm32") + " -- <command> <args>",
      value: line,
      // Caret starts right after the last "=" so a preset's first -e KEY=
      // placeholder is one keystroke away; otherwise at the end.
      caretStart: line ? line.lastIndexOf("=") + 1 : 0,
      onCancel: function() { closeModal(); setTimeout(function() { openModal({ type: backType as any }); }, 10); },
      onPick: function(line2: string) {
        const msg = plugin.mcpAddLineCmd(line2);
        if (msg.startsWith("Added")) {
          showToast(msg, "ok");
          closeModal();
          setTimeout(function() { openModal({ type: backType as any }); }, 10);
        } else {
          showToast(String(msg).slice(0, 80), "error");
          openLine(line2); // keep the text so the user can fix it
        }
      },
    });
  };
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

  useKeyboard(key => {
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) { closeModal(); return; }
    if (kbs.dialogIs("dialog_select_prev", ks)) { setSel(i => Math.max(0, i - 1)); return; }
    if (kbs.dialogIs("dialog_select_next", ks)) { setSel(i => Math.min(servers().length - 1, i + 1)); return; }
    if (key.name === "a" || key.name === "A") { openPresetPicker(presets, kind); return; }
    if (kbs.dialogIs("dialog_select_submit", ks)) {
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
  // Name column width = longest name + "  [on] "/"  [off] " prefix (7-8 chars),
  // capped so the command column keeps ~28 chars. Without an explicit width the
  // name text yoga-shrinks to zero width when the command is long.
  const nameW = () => Math.min(30, Math.max(18, ...servers().map(s => String(s.name).length + 9)));
  // Command column budget: modal inner ~64 chars minus name column minus the
  // "→  " arrow — any longer and the text pixel-punches past the right border.
  const cmdW = () => Math.max(24, 62 - nameW());

  return (
    <ModalFrame title={title} subtitle={"Enter toggles a server on/off" + rangeSub()} footer={kbNav().submit + " toggle  |  A add " + (kind === "connector" ? "connector" : "server") + "  |  wheel scroll  |  " + kbNav().cancel + " close"}>
      <box onMouseScroll={scrollBy} flexDirection="column" flexShrink={0}>
        {win().items.map((s, i) => {
          const abs = win().start + i;
          return (
            <box
 flexDirection="row" paddingY={0} height={1} flexShrink={0}
              onMouseDown={() => setSel(abs)}
              onMouseUp={() => { if (abs === sel()) { const r = toggleServer(s.name); if (!r || !r.error) refresh(); } }}
            >
              <text fg={abs === sel() ? ui.primary : ui.fgDim} width={nameW()} height={1} flexShrink={0}>
                {"  " + (s.enabled ? "[on] " : "[off] ") + s.name}
              </text>
              <text fg={ui.fgMuted} height={1} flexGrow={1}>{"\u2192  " + mcpFit(s.command + " " + (s.args || []).join(" "), cmdW())}</text>
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
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) { closeModal(); return; }
    if (key.name === "backspace") { setQ(v => v.slice(0, -1)); setSel(0); return; }
    if (kbs.dialogIs("dialog_select_prev", ks)) { setSel(i => Math.max(0, i - 1)); return; }
    if (kbs.dialogIs("dialog_select_next", ks)) { setSel(i => Math.min(filtered().length - 1, i + 1)); return; }
    if (kbs.dialogIs("dialog_select_submit", ks)) {
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
 flexDirection="row" paddingY={0}
              onMouseDown={() => setSel(abs)}
              onMouseUp={() => clickRow(abs)}
            >
              <text fg={abs === sel() ? ui.primary : ui.fgDim}>
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

/**
 * Graph Modal — full-screen view of the memory graph.
 * The graph data is built synchronously by openGraphModal() (straight from
 * LOOM.md + .loom/graph/nodes/*.md) and passed in as props — no async
 * loading inside the modal. Renders the ## / ### hierarchy as an ASCII
 * tree; select a node (↑/↓) and peek at its body (Enter). ESC closes.
 * NOTE: glyphs are ASCII-only (|, +-, >) — Windows legacy consoles
 * (CP437) can't render box-drawing or Unicode arrows.
 */
export function GraphModal(props: { graph: any; err: string | null }) {
  const [sel, setSel] = createSignal(0);
  const [open, setOpen] = createSignal<number | null>(null);

  // Flatten the node graph into tree-walk order: top-level nodes (no
  // 'child' parent) followed by their ### children, recursively.
  const buildFlat = (g: any): any[] => {
    const nodes = g.nodes || [];
    const edges = g.edges || [];
    const byId = new Map<string, any>();
    for (const n of nodes) byId.set(n.id, n);
    const childMap = new Map<string, string[]>();
    const hasParent = new Set<string>();
    for (const e of edges) {
      if (e.type !== 'child') continue;
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
    for (const n of nodes) if (!seen.has(n.id)) walk(n.id, 0); // orphans
    return flat;
  };

  // Build the view; tracks the line of the selected node for viewport follow.
  let selLine = 0;
  const content = () => {
    if (props.err) return 'Error: ' + props.err;
    const g = props.graph;
    if (!g) return 'No memory graph found - is there a LOOM.md?';
    const nodes = g.nodes || [];
    const edges = g.edges || [];
    const refs = edges.filter((e: any) => e.type !== 'child');
    const flat = buildFlat(g);
    const lines: string[] = [];
    lines.push('LOOM Memory Graph - ' + nodes.length + ' nodes | ' + edges.length + ' links (from LOOM.md)');
    lines.push('');
    let idx = 0;
    for (const { node, depth } of flat) {
      const cur = idx === sel();
      if (cur) selLine = lines.length;
      const marker = cur ? '>' : ' ';
      const indent = depth === 0 ? '  ' : '    ' + '  '.repeat(depth - 1) + '+- ';
      const tag = node.tags && node.tags.length ? '  #' + node.tags.join(' #') : '';
      lines.push(marker + indent + node.title + tag);
      if (cur && open() === idx && node.body) {
        const bl = String(node.body).split('\n').slice(0, 4);
        for (const l of bl) lines.push('      ' + l);
      }
      idx++;
    }
    if (refs.length) {
      lines.push('');
      lines.push('  Links:');
      for (const e of refs) lines.push('    ' + e.source + ' -> ' + e.target);
    }
    lines.push('');
    lines.push('  up/down select | Enter toggle body | PgUp/PgDn | ESC close');
    return lines.join('\n');
  };

  const count = () => {
    const g = props.graph;
    return g && g.nodes ? g.nodes.length : 1;
  };
  useKeyboard(key => {
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) { closeModal(); return; }
    if (kbs.dialogIs("dialog_select_prev", ks)) { setSel(s => Math.max(0, s - 1)); return; }
    if (kbs.dialogIs("dialog_select_next", ks)) { setSel(s => Math.min(count() - 1, s + 1)); return; }
    if (kbs.dialogIs("dialog_select_submit", ks)) { setOpen(o => (o === sel() ? null : sel())); return; }
    if (kbs.dialogIs("dialog_select_page_up", ks)) { setSel(s => Math.max(0, s - 10)); return; }
    if (kbs.dialogIs("dialog_select_page_down", ks)) { setSel(s => Math.min(count() - 1, s + 10)); return; }
    if (kbs.dialogIs("dialog_select_home", ks)) { setSel(0); return; }
    if (kbs.dialogIs("dialog_select_end", ks)) { setSel(count() - 1); return; }
  });

  // Reactive chain: content() reads sel()/open() and stamps selLine while
  // computing, so navigation must recompute the view inside accessors (a
  // one-time const would freeze the tree at creation). lines() is evaluated
  // before selLine is read so the stamped value is fresh.
  const lines = () => content().split('\n');
  const visible = 34;
  const start = () => Math.max(0, Math.min(lines().length - visible, selLine - 2));
  const view = () => lines().slice(start(), start() + visible).join('\n');

  return (
    <ModalFrame title="Memory Graph" subtitle={"up/down select | Enter details | ESC close"} footer={""}>
      <box flexDirection="column" paddingX={2} paddingY={1}>
        <text fg={ui.fg}>{view()}</text>
      </box>
    </ModalFrame>
  );
}

/**
 * Opens the graph modal. Builds the graph synchronously from LOOM.md so the
 * modal renders immediately (no async load, no file picking).
 */
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
