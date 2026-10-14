// ToastOverlay -- transient confirmations float above the input bar (bottom-
// right) and auto-dismiss after a few seconds. Never shown in the chat area.
import { Show, For } from "solid-js";
import { palette } from "../theme.ts";
import { toasts } from "../store.ts";

const ui = palette("loom");

export function ToastOverlay() {
  const list = () => toasts().slice(-3);
  return (
    <Show when={toasts().length > 0}>
      <box
        position="absolute" bottom={4} right={0} zIndex={60}
        flexDirection="column" paddingX={1} paddingY={0}
      >
        <For each={list()}>
          {(t) => {
            const c = t.kind === "error" ? ui.error : t.kind === "ok" ? ui.success : ui.primary;
            const dot = t.kind === "error" ? "✖" : t.kind === "ok" ? "●" : "◆";
            // Cap the rendered width: a wide toast overlaps the chat's last
            // rows (the box is opaque) — the store keeps the full text, only
            // the floating chip clips with an ellipsis.
            const body = t.text.length > 40 ? t.text.slice(0, 39) + "\u2026" : t.text;
            return (
              <box
                border borderStyle="rounded"
                borderColor={c}
                paddingX={1} paddingY={0} marginTop={0}
                backgroundColor={ui.bgPanel}
              >
                <text fg={c}>
                  {" " + dot + " "}
                </text>
                <text fg={t.kind === "error" ? ui.error : ui.fg}>
                  {body}
                </text>
              </box>
            );
          }}
        </For>
      </box>
    </Show>
  );
}
