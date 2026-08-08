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

  useKeyboard(key => {
    if (key.name === "escape") { closeModal(); return; }
    if (key.name === "up") { setIndex(i => Math.max(0, i - 1)); return; }
    if (key.name === "down") { setIndex(i => Math.min(filtered().length - 1, i + 1)); return; }
    if (key.name === "return") {
      const opt = filtered()[index()];
      if (!opt || opt.isHeader) return;
      props.onPick(opt.value, opt);
      return;
    }
    if (props.searchable) {
      if (key.name === "backspace") { setQ(v => v.slice(0, -1)); setIndex(0); return; }
      const s = key.sequence;
      if (!key.ctrl && !key.meta && s && s.length <= 10 && s !== "\r" && s !== "\n") {
        setQ(v => v + s);
        setIndex(0);
        return;
      }
    }
  });

  const scrollBy = (e: any) => { setIndex(i => Math.max(0, Math.min(filtered().length - 1, i + wheelStep(e, 1)))); };
  const clickRow = (i: number) => {
    if (i !== index()) return;
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
}) {
  const [val, setVal] = createSignal("");
  const masked = () => props.isKey ? "x".repeat(Math.max(0, val().length)) : val();

  useKeyboard(key => {
    if (key.name === "escape") { closeModal(); return; }
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