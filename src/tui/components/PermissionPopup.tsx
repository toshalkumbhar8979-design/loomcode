// PermissionPopup -- raised above the input bar (attached to the chatbox, like
// the autocomplete popup) when the model wants to run a command or change a
// file. Options: Allow (recommended) / Always allow / Deny / Type your answer.
import { createSignal, Show } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { palette } from "../theme.ts";
import { permission, getSession } from "../store.ts";

const ui = palette("loom");

const ALLOWISH = /^(allow|yes|yeah|y|ok|okay|sure|go|run|approve|grant|fine|please|do it|go ahead|allowed)\b/i;

const FIT = 54;
function fit(s: string, n = FIT) {
  const flat = String(s || "").replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, Math.max(1, n - 1)) + "\u2026";
}

export function PermissionPopup() {
  // Keyed Show: every request is a NEW object, so the inner prompt remounts
  // with fresh selection/custom state (a plain Show kept the previous answer).
  return (
    <Show when={permission()} keyed>
      {() => <PermissionPrompt />}
    </Show>
  );
}

function PermissionPrompt() {
  const [sel, setSel] = createSignal(0); // 0 Allow · 1 Always allow · 2 Deny · 3 Type answer
  const [custom, setCustom] = createSignal(false);
  const [customText, setCustomText] = createSignal("");

  const submitCustom = () => {
    const pr = permission();
    if (!pr) return;
    const t = customText().trim();
    if (!t) { setCustom(false); return; }
    if (ALLOWISH.test(t)) pr.resolve(true);
    else pr.resolve(false, "(" + t + ")");
  };

  useKeyboard(function(key) {
    const pr = permission();
    if (!pr) return;
    const k = key.name;

    if (k === "escape") {
      if (custom()) { setCustom(false); setCustomText(""); return; }
      pr.resolve(false, "(esc)");
      return;
    }

    if (custom()) {
      if (k === "return") { submitCustom(); return; }
      if (k === "backspace" || k === "delete") { setCustomText(v => v.slice(0, -1)); return; }
      const s = key.sequence;
      if (!key.ctrl && !key.meta && s && s.length <= 10 && s !== "\r" && s !== "\n" && s !== "\t") {
        setCustomText(v => v + s);
      }
      return;
    }

    if (k === "up" || k === "down") {
      setSel(i => (k === "up" ? Math.max(0, i - 1) : Math.min(3, i + 1)));
      return;
    }

    // Typing anything starts the custom answer mode directly.
    if (!key.ctrl && !key.meta && key.sequence && key.sequence.length <= 10 && key.sequence !== "\r" && key.sequence !== "\n" && key.sequence !== "\t") {
      setCustom(true);
      setCustomText(key.sequence);
      return;
    }

    if (k === "return") {
      if (sel() === 3) { setCustom(true); return; }
      if (sel() === 0) { pr.resolve(true); return; }
      if (sel() === 1) {
        try { getSession().permissions.setRule(pr.command, "allow", true); } catch {}
        pr.resolve(true);
        return;
      }
      pr.resolve(false);
    }
  });

  return (
    <Show when={permission()}>
      <box
        border borderStyle="rounded" borderColor={ui.warning}
        paddingX={1} paddingY={0}
        flexDirection="column" marginBottom={0}
        backgroundColor={ui.bgPanel}
      >
        <text fg={ui.warning} bold>{"  \u26A0 Permission needed"}</text>
        <text fg={ui.fgMuted} dim>{"  Model wants to " + (permission()!.tool === "bash" ? "run a command" : "change a file") + ":"}</text>
        <text fg={ui.primary} bold wrap="truncate">{"   " + permission()!.tool + ": " + fit(permission()!.command)}</text>
        <Show when={permission()!.label && permission()!.label !== "dangerous command"}>
          <text fg={ui.warning} dim>{"   \u26A0 " + permission()!.label}</text>
        </Show>

        <Show when={!custom()} fallback={
          <box flexDirection="column">
            <text fg={ui.fg}>{"  Your answer: " + customText()}</text>
            <text fg={ui.fgMuted} dim>{"  Enter send \u00B7 Esc back  (\"allow\" or \"yes\" approves, anything else denies with that note)"}</text>
          </box>
        }>
          <box flexDirection="column" marginTop={0}>
            <box flexDirection="row">
              <text fg={sel() === 0 ? ui.primary : ui.fgDim} bold={sel() === 0}>
                {(sel() === 0 ? "\u25B6 " : "   ") + "Allow"}
              </text>
              <text fg={ui.success} dim>{" (recommended)"}</text>
            </box>
            <box flexDirection="row">
              <text fg={sel() === 1 ? ui.primary : ui.fgDim} bold={sel() === 1}>
                {(sel() === 1 ? "\u25B6 " : "   ") + "Always allow"}
              </text>
              <text fg={ui.fgMuted} dim>{" \u2014 remember for this command"}</text>
            </box>
            <text fg={sel() === 2 ? ui.primary : ui.fgDim} bold={sel() === 2}>
              {(sel() === 2 ? "\u25B6 " : "   ") + "Deny"}
            </text>
            <text fg={sel() === 3 ? ui.primary : ui.fgDim} bold={sel() === 3}>
              {(sel() === 3 ? "\u25B6 " : "   ") + "Type your answer\u2026"}
            </text>
          </box>
        </Show>

        <text fg={ui.fgMuted} dim>
          {"  \u2191\u2193 choose  \u21B5 confirm  type = custom answer  ESC deny"}
        </text>
      </box>
    </Show>
  );
}
