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
          {(t) => (
            <box
              border borderStyle="rounded"
              borderColor={t.kind === "error" ? ui.error : t.kind === "ok" ? ui.success : ui.primary}
              paddingX={1} paddingY={0} marginTop={0}
              backgroundColor={ui.bgPanel}
            >
              <text fg={t.kind === "error" ? ui.error : t.kind === "ok" ? ui.success : ui.fg}>
                {" " + t.text}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  );
}
