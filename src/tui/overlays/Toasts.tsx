// Toasts — transient confirmations above the composer. Never chat messages.
import { Show, For } from "solid-js";
import { GLYPH, palette } from "../design.ts";
import { toasts } from "../store.ts";

const ui = palette();

export function Toasts() {
  const list = () => toasts().slice(-3);
  return (
    <Show when={toasts().length > 0}>
      <box position="absolute" bottom={5} right={0} zIndex={60} flexDirection="column" paddingX={1}>
        <For each={list()}>
          {(t) => {
            const mark = t.kind === "error" ? GLYPH.cross : t.kind === "ok" ? GLYPH.check : GLYPH.dot;
            const body = t.text.length > 44 ? t.text.slice(0, 43) + GLYPH.ellipsis : t.text;
            return (
              <box marginTop={0} backgroundColor={ui.bgPanel} paddingX={1}>
                <text fg={t.kind === "error" ? ui.error : t.kind === "ok" ? ui.success : ui.fg}>
                  {mark + " " + body}
                </text>
              </box>
            );
          }}
        </For>
      </box>
    </Show>
  );
}
