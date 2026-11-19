// Deck — the command palette (ctrl+p). Type to filter; enter runs.
import { createSignal } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { GLYPH, palette, fit } from "../design.ts";
import { ModalFrame, wheelStep } from "./Layer.tsx";
import { SLASH_LIST, closeModal, windowFor } from "../store.ts";
import * as kbs from "../keybinds.ts";

const ui = palette();

export function Deck(props: { onPick: (cmd: string) => void }) {
  const items = SLASH_LIST.map((c: any) => ({ label: "/" + c.cmd, value: c.cmd, sub: c.desc }));
  const [sel, setSel] = createSignal(0);
  const [q, setQ] = createSignal("");

  const filtered = () => {
    const query = q().toLowerCase();
    return query
      ? items.filter((x: any) => (x.value + " " + x.sub).toLowerCase().includes(query))
      : items;
  };

  useKeyboard((key: any) => {
    const ks = kbs.keyString(key);
    if (kbs.is("modal_cancel", ks)) { closeModal(); return; }
    if (key.name === "backspace") { setQ(v => v.slice(0, -1)); setSel(0); return; }
    if (kbs.dialogIs("dialog_select_prev", ks)) { setSel(i => Math.max(0, i - 1)); return; }
    if (kbs.dialogIs("dialog_select_next", ks)) { setSel(i => Math.min(filtered().length - 1, i + 1)); return; }
    if (kbs.dialogIs("dialog_select_submit", ks)) {
      const f = filtered();
      if (f.length > sel()) { props.onPick("/" + f[sel()].value); closeModal(); }
      return;
    }
    if (!key.ctrl && !key.meta && key.sequence && key.sequence.length <= 3 && ["\r", "\n"].includes(key.sequence) === false) {
      setQ(v => v + key.sequence);
      setSel(0);
    }
  });

  const scrollBy = (e: any) => { setSel(i => Math.max(0, Math.min(filtered().length - 1, i + wheelStep(e, 1)))); };
  let winStart = 0;
  const win = () => {
    const f = filtered();
    winStart = windowFor(sel(), f.length, 12, winStart);
    return { start: winStart, items: f.slice(winStart, winStart + 12) };
  };

  return (
    <ModalFrame title="Command Deck" subtitle={"filter: " + (q() || "_") + "   (" + filtered().length + " commands)"} footer="↑↓ nav · enter run · esc close">
      <box onMouseScroll={scrollBy} flexDirection="column" height={12} flexShrink={0}>
        {win().items.map((it: any, i: number) => {
          const abs = win().start + i;
          const active = abs === sel();
          return (
            <box flexDirection="row" backgroundColor={active ? ui.bgPanelAlt : undefined}
              onMouseDown={() => setSel(abs)}
              onMouseUp={() => { if (abs === sel()) { props.onPick("/" + it.value); closeModal(); } }}>
              <text fg={active ? ui.primary : ui.fgDim}>
                {(active ? GLYPH.pointer + " " : "  ") + fit(it.label, 18)}
              </text>
              <text fg={active ? ui.fg : ui.fgMuted}>{"  " + fit(String(it.sub || ""), 40)}</text>
            </box>
          );
        })}
      </box>
    </ModalFrame>
  );
}
