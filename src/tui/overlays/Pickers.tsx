// Pickers — provider/model selection, key and base-URL editors, settings.
import { createSignal, createMemo } from "solid-js";
import { useKeyboard, usePaste } from "@opentui/solid";
import { GLYPH, palette, fit } from "../design.ts";
import { ModalFrame, wheelStep, kbNav } from "./Layer.tsx";
import {
  openModal, closeModal, modal, PROVIDERS, PROVIDER_ORDER, PROVIDER_LABELS,
  refreshProviderState, showToast, getSession, allModelOptions, windowFor,
  showToolDetails, setShowToolDetails,
  showThinking, setShowThinking, persistUi,
  vimMode, toggleVim,
} from "../store.ts";
import { loadConfig, saveConfig, getBaseUrl, setBaseUrl } from "../../config/settings.js";
import { saveCredential } from "../../auth/store.js";
import { hasAuth } from "../../auth/index.js";
import * as kbs from "../keybinds.ts";

const ui = palette();

export function ProviderPicker() {
  const opts = PROVIDER_ORDER.map((p: any) => ({
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
  return <SelectModal title="Connect Provider" options={opts} searchable={true} onPick={pick} />;
}

export function openModelPicker() {
  const opts = allModelOptions();
  openModal({
    type: "select", title: "Select Model", options: opts, searchable: true,
    onPick(val: string, opt: any) {
      if (val === "__custom__") { openCustomModelId(opt?.provider); return; }
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
  const exists = !!cur || hasAuth(provider);
  openModal({
    type: "input", title: "API key for " + (PROVIDER_LABELS[provider] || provider),
    placeholder: exists ? "(already set — leave blank to keep)" : "Paste your key",
    isKey: true,
    onPick(val: string) {
      if (val.trim()) {
        try {
          saveCredential(provider, {
            type: "api", method: "api", apiKey: val.trim(),
            label: (PROVIDER_LABELS[provider] || provider) + " API key",
          });
          const c = loadConfig();
          if (c.apiKeys && c.apiKeys[provider]) { delete c.apiKeys[provider]; saveConfig(c); }
          showToast("Key saved for " + provider, "ok");
        } catch (err: any) {
          showToast("Could not save key: " + (err?.message || String(err)), "error");
        }
      } else showToast("Using env var " + provider.toUpperCase() + "_API_KEY");
      refreshProviderState(); closeModal();
    },
  });
}

export function openBaseUrlEditor(provider: string) {
  const cur = getBaseUrl(provider) || "(default)";
  openModal({
    type: "input", title: "Base URL for " + (PROVIDER_LABELS[provider] || provider),
    placeholder: "Current: " + cur,
    onPick(val: string) {
      if (!val.trim()) { closeModal(); return; }
      setBaseUrl(provider, val.trim()); closeModal();
      showToast("Base URL: " + val.trim());
    },
  });
}

export function openCustomModelId(provider?: string) {
  const pv = provider || loadConfig().provider || "nvidia";
  openModal({
    type: "input", title: "Custom model ID for " + (PROVIDER_LABELS[pv] || pv),
    placeholder: "e.g. deepseek-ai/deepseek-v4-flash",
    onPick(val: string) {
      if (!val.trim()) { closeModal(); return; }
      const c = loadConfig(); c.provider = pv; c.model = c.model || {}; c.model[pv] = val.trim();
      saveConfig(c); refreshProviderState(); closeModal();
      showToast("Model: " + pv + " -> " + val.trim(), "ok");
    },
  });
}

export function SelectModal(props: {
  title: string;
  options: { label: string; value: any; sub?: string; provider?: string; header?: string; isHeader?: boolean; tags?: string[]; recent?: boolean }[];
  onPick: (value: any, option: any) => void;
  searchable?: boolean;
  onCancel?: () => void;
  onPreview?: (value: any) => void;
}) {
  const LABEL_MAX = 26, SUB_MAX = 20;
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

  function firePreview() {
    if (!props.onPreview) return;
    setTimeout(() => { try { props.onPreview!(filtered()[index()]?.value); } catch {} }, 0);
  }

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
  setIndex(firstSelectable());

  let hoverLockUntil = 0;
  const lockHover = () => { hoverLockUntil = Date.now() + 250; };
  const setIndexByKey = (fn: (i: number) => number) => { setIndex(fn); lockHover(); };

  const nav = kbNav();

  useKeyboard((key: any) => {
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
      if (key.name === "backspace") { setQ(v => v.slice(0, -1)); setIndexByKey(() => 0); firePreview(); return; }
      const s = key.sequence;
      if (!key.ctrl && !key.meta && s && s.length <= 10 && s !== "\r" && s !== "\n") {
        setQ(v => v + s);
        setIndexByKey(() => 0);
        firePreview();
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
    if (i !== index()) { setIndex(i); firePreview(); }
    const o = filtered()[i];
    if (o?.isHeader) return;
    props.onPick(o?.value, o);
  };
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
    <ModalFrame title={props.title}
      subtitle={(props.searchable ? "search: " + (q() || "_") + rangeSub() : rangeSub())}
      footer={nav.prev + "/" + nav.next + " nav · " + nav.submit + " select · " + nav.cancel + " cancel"}>
      <box onMouseScroll={scrollBy} height={12} flexShrink={0}>
        {win().items.map((opt: any, i: number) => {
          const abs = win().start + i;
          if (opt.isHeader) return <text fg={ui.secondary}>{opt.header + ":"}</text>;
          const active = abs === index();
          return (
            <box flexDirection="row" paddingLeft={2}
              backgroundColor={active ? ui.bgPanelAlt : undefined}
              onMouseOver={() => { if (Date.now() >= hoverLockUntil && abs !== index()) { setIndex(abs); firePreview(); } }}
              onMouseDown={() => setIndex(abs)}
              onMouseUp={() => clickRow(abs)}>
              <text fg={active ? ui.primary : ui.fgDim}>
                {(active ? GLYPH.pointer + " " : "  ") + fit(opt.label, LABEL_MAX)}
              </text>
              {opt.recent ? <text fg={ui.fgMuted}>{"  " + GLYPH.check + " recent"}</text> : null}
              {opt.sub ? <text fg={active ? ui.fg : ui.fgDim}>{"  (" + fit(opt.sub, SUB_MAX) + ")"}</text> : null}
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
  const shown = () => {
    const d = val();
    const c = Math.min(caret(), d.length);
    return d.slice(0, c) + "█" + d.slice(c);
  };

  useKeyboard((key: any) => {
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

  usePaste((event: any) => {
    const txt = new TextDecoder().decode(event?.bytes || "").replace(/[\r\n]+/g, "");
    if (txt) {
      setVal(v => { const c = Math.min(caret(), v.length); return v.slice(0, c) + txt + v.slice(c); });
      setCaret(c => Math.min(val().length, c) + txt.length);
    }
  });

  return (
    <ModalFrame title={props.title} subtitle={props.placeholder}
      footer={kbNav().submit + " confirm · ←→ move · ctrl+v paste · " + kbNav().cancel + " cancel"}>
      <box paddingX={1} marginTop={1}>
        <text fg={ui.fg}>{shown()}</text>
      </box>
    </ModalFrame>
  );
}

export function SettingsModal() {
  useKeyboard((key: any) => {
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) { closeModal(); return; }
    if (key.name === "d" || key.name === "D") { setShowToolDetails(v => !v); persistUi(); }
    if (key.name === "t" || key.name === "T") { setShowThinking(v => !v); persistUi(); }
    if (key.name === "v" || key.name === "V") { toggleVim(); persistUi(); }
  });

  return (
    <ModalFrame title="Settings" footer={"d/t/v toggle · " + kbNav().cancel + " close"}>
      <text fg={ui.fg}>{"[d] Tool details   " + (showToolDetails() ? "on" : "off") + "   show tool output"}</text>
      <text fg={ui.fg}>{"[t] Thinking       " + (showThinking() ? "on" : "off") + "   show think time"}</text>
      <text fg={ui.fg}>{"[v] Vim editing    " + (vimMode() ? "on" : "off") + "   Esc toggles NORMAL"}</text>
    </ModalFrame>
  );
}
