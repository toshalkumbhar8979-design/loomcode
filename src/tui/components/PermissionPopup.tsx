// PermissionPopup -- raised above the input bar when the model wants to run a
// command or change a file, OR when the model is asking a question. Typing an
// answer shows the editor inline at the bottom of this same popup — no
// separate overlay ever opens for typing.
import { createSignal, Show } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { palette } from "../theme.ts";
import {
  permission, getSession,
  questionOpen, questionText, setQuestionText, openQuestion, closeQuestion,
} from "../store.ts";

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
  const custom = () => questionOpen();
  const customText = () => questionText();

  // Note: the question state lives in the STORE (not in this component) on
  // purpose — the reconciler remounts this subtree on signal changes, and a
  // mount-time reset would wipe a typed answer mid-keystroke.

  const submitCustom = () => {
    const pr = permission();
    if (!pr) return;
    const t = customText().trim();
    closeQuestion();
    if (!t) return;
    if (ALLOWISH.test(t)) pr.resolve(true);
    else pr.resolve(false, "(" + t + ")");
  };

  useKeyboard(function(key) {
    const pr = permission();
    if (!pr) return;
    const k = key.name;

    if (k === "escape") {
      if (custom()) { closeQuestion(); return; }
      pr.resolve(false, "(esc)");
      return;
    }

    if (custom()) {
      if (k === "return") { submitCustom(); return; }
      if (k === "backspace" || k === "delete") { setQuestionText(v => v.slice(0, -1)); return; }
      const s = key.sequence;
      if (!key.ctrl && !key.meta && s && s.length <= 10 && s !== "\r" && s !== "\n" && s !== "\t") {
        setQuestionText(v => v + s);
      }
      return;
    }

    if (k === "up" || k === "down") {
      setSel(i => (k === "up" ? Math.max(0, i - 1) : Math.min(3, i + 1)));
      return;
    }

    // Typing anything opens the inline editor.
    if (!key.ctrl && !key.meta && key.sequence && key.sequence.length <= 10 && key.sequence !== "\r" && key.sequence !== "\n" && key.sequence !== "\t") {
      openQuestion(key.sequence);
      return;
    }

    if (k === "return") {
      if (sel() === 3) { openQuestion(""); return; }
      if (sel() === 0) { pr.resolve(true); return; }
      if (sel() === 1) {
        try { getSession().permissions.setRule(pr.command, "allow", true); } catch {}
        pr.resolve(true);
        return;
      }
      pr.resolve(false);
    }
  });

  const pr = permission()!;

  return (
    <box
      border borderStyle="rounded" borderColor={custom() ? ui.accent : ui.warning}
      paddingX={2} paddingY={1}
      flexDirection="column" marginBottom={0}
      backgroundColor={ui.bgPanel}
    >
      <text fg={custom() ? ui.accent : ui.warning} bold>{custom() ? "\u2753 Answer" : "\u26A0 Permission needed"}</text>
      <Show when={!custom()}>
        <text fg={ui.fgMuted} dim marginTop={1}>
          {"Model wants to " + (pr.tool === "bash" ? "run a command" : "change a file") + ":"}
        </text>
        <text fg={ui.primary} bold wrap="truncate">
          {pr.tool + ": " + fit(pr.command)}
        </text>
        <Show when={pr.label && pr.label !== "dangerous command"}>
          <text fg={ui.warning} dim marginTop={1}>
            {"\u26A0 " + pr.label}
          </text>
        </Show>

        <box flexDirection="column" marginTop={1} gap={0}>
          <box flexDirection="row" paddingY={0}>
            <text fg={sel() === 0 ? ui.primary : ui.fgDim} bold={sel() === 0} paddingRight={1}>
              {(sel() === 0 ? "\u25B6 " : "  ") + "Allow"}
            </text>
            <text fg={ui.success} dim>{"(recommended)"}</text>
          </box>
          <box flexDirection="row" paddingY={0}>
            <text fg={sel() === 1 ? ui.primary : ui.fgDim} bold={sel() === 1} paddingRight={1}>
              {(sel() === 1 ? "\u25B6 " : "  ") + "Always allow"}
            </text>
            <text fg={ui.fgMuted} dim>{"remember for this command"}</text>
          </box>
          <text fg={sel() === 2 ? ui.primary : ui.fgDim} bold={sel() === 2} paddingY={0}>
            {(sel() === 2 ? "\u25B6 " : "  ") + "Deny"}
          </text>
          <text fg={sel() === 3 ? ui.primary : ui.fgDim} bold={sel() === 3} paddingY={0}>
            {(sel() === 3 ? "\u25B6 " : "  ") + "Type your answer\u2026"}
          </text>
        </box>
      </Show>

      <Show when={custom()}>
        <box border borderStyle="rounded" borderColor={ui.border} paddingX={1} marginTop={1}>
          <text fg={ui.fg}>{customText() || " "}</text>
        </box>
      </Show>

      <text fg={ui.fgMuted} dim marginTop={1}>
        {custom()
          ? "Enter send \u00B7 Esc back \u00B7 (\"allow\"/\"yes\" approves, anything else denies with that note)"
          : "\u2191\u2193 choose \u00B7 Enter confirm \u00B7 type = answer here \u00B7 ESC deny"}
      </text>
    </box>
  );
}
