// PermissionPopup -- raised above the input bar when the model wants to run a
// command or change a file. The popup offers Allow / Always allow / Deny.
// Typing an answer (or Enter on "Type your answer…") switches to a SEPARATE
// centered Question popup (rendered at the App root) where the free-form
// answer is typed — the permission options stay clean and never mix with it.
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

    // Typing anything opens the Question popup with the answer directly.
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
    <Show when={!custom()}>
      <box
        border borderStyle="rounded" borderColor={ui.warning}
        paddingX={2} paddingY={1}
        flexDirection="column" marginBottom={0}
        backgroundColor={ui.bgPanel}
      >
        <text fg={ui.warning} bold>{"\u26A0 Permission needed"}</text>
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

        <text fg={ui.fgMuted} dim marginTop={1}>
          {"\u2191\u2193 choose  \u00B7  Enter confirm  \u00B7  type = question popup  \u00B7  ESC deny"}
        </text>
      </box>
    </Show>
  );
}

// The Question popup — a centered overlay (same look as the modals) for the
// free-form answer. Rendered at the App root next to the modal overlay;
// the PermissionPrompt above owns the keyboard while it is open.
export function QuestionPopupOverlay() {
  return (
    <Show when={permission() && questionOpen()}>
      <box position="absolute" top={0} left={0} right={0} bottom={0}
        alignItems="center" justifyContent="center" flexDirection="column" backgroundColor={ui.bg}>
        <box border borderStyle="rounded" borderColor={ui.accent} backgroundColor={ui.bgPanel}
          paddingX={3} paddingY={2} flexDirection="column" minWidth={52} maxWidth={72}>
          <text fg={ui.accent} bold>{"\u2753 Question \u2014 type your answer"}</text>
          <text fg={ui.fgMuted} dim marginTop={0}>
            {"Model wants to " + (permission()!.tool === "bash" ? "run a command" : "change a file") + ":"}
          </text>
          <text fg={ui.primary} bold wrap="truncate">
            {permission()!.tool + ": " + fit(permission()!.command, 60)}
          </text>
          <Show when={permission()!.label && permission()!.label !== "dangerous command"}>
            <text fg={ui.warning} dim>{"  \u26A0 " + permission()!.label}</text>
          </Show>
          <box border borderStyle="rounded" borderColor={ui.border} paddingX={1} marginTop={1}>
            <text fg={ui.fg}>{questionText() || " "}</text>
          </box>
          <text fg={ui.fgMuted} dim marginTop={1}>
            {"Enter send  \u00B7  Esc back to options  \u00B7  (\"allow\"/\"yes\" approves, anything else denies with that note)"}
          </text>
        </box>
      </box>
    </Show>
  );
}
