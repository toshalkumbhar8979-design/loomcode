// PermissionPopup -- raised above the input bar when the model wants to run a
// command or change a file, OR when the model is asking a question (the ask
// tool). Two modes:
//   • permission: Allow / Always allow / Deny only — a permission is a yes/no
//     verdict, so there is no "type your answer" row.
//   • question: the model's question + its provided options, plus a "Type your
//     answer…" row — questions may legitimately need an answer that is not one
//     of the offered options. Typing opens the inline editor in this popup —
//     no separate overlay ever opens for typing.
import { createSignal, Show } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { palette } from "../theme.ts";
import {
  permission, getSession,
  questionOpen, questionText, setQuestionText, openQuestion, closeQuestion,
  setAutoPerm,
} from "../store.ts";

const ui = palette("loom");

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
  const pr = permission()!;
  const isQ = !!pr.isQuestion;
  const isStart = !!pr.sessionStart;
  const opts = isQ && pr.options && pr.options.length ? pr.options : [];
  // Row index: 0..opts.length-1 are the question options; the last row is
  // "Type your answer…" (question mode) — or 0 Allow · 1 Always · 2 Deny ·
  // 3 Allow-all-in-session (bash only). The session-start prompt is a
  // question with exactly its two options and no free-answer row.
  const maxSel = isStart ? opts.length - 1 : isQ ? opts.length : (pr.tool === "bash" ? 3 : 2);
  const [sel, setSel] = createSignal(0);
  const custom = () => questionOpen();
  const customText = () => questionText();

  // Note: the question state lives in the STORE (not in this component) on
  // purpose — the reconciler remounts this subtree on signal changes, and a
  // mount-time reset would wipe a typed answer mid-keystroke.

  const answerWith = (text: string) => {
    const p = permission();
    if (!p) return;
    closeQuestion();
    const t = String(text || "").trim();
    if (!t) return;
    p.resolve(true, t); // questions: any text is the answer
  };

  const submitCustom = () => answerWith(customText());

  // Mouse: rows are click-to-select + click-to-act (same action as Enter on
  // the highlighted row), so the popup is fully reachable with the mouse.
  const execSel = (i: number) => {
    const p = permission()!;
    if (isQ) {
      if (isStart) {
        if (i === 0) {
          // "Allow all commands" — session-wide auto-approve (Shift+Tab
          // toggles it off/on too).
          try { getSession().permissions.setAuto(true); } catch {}
          setAutoPerm(true);
          p.resolve(true, "allow");
          return;
        }
        p.resolve(false, "ask");
        return;
      }
      if (i >= opts.length) { openQuestion(""); return; }
      answerWith(opts[i]);
      return;
    }
    if (i === 0) { p.resolve(true); return; }
    if (i === 1) {
      try { getSession().permissions.setRule(p.command, "allow", true); } catch {}
      p.resolve(true);
      return;
    }
    if (i === 3) {
      // Session-wide auto-approve (bash only): the rest of THIS turn (and any
      // later turn in this session) stops asking for command approval.
      try { getSession().permissions.setAuto(true); } catch {}
      p.resolve(true);
      return;
    }
    p.resolve(false);
  };
  const row = (i: number) => ({
    onMouseDown: () => setSel(i),
    onMouseUp: () => execSel(i),
  });

  useKeyboard(function(key) {
    const p = permission();
    if (!p) return;
    const k = key.name;

    if (k === "escape") {
      if (custom()) { closeQuestion(); return; }
      p.resolve(false, "(esc)");
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

    // Session-start prompt: only up/down + enter + esc, never the answer
    // editor (there is no "type your own answer" for this one).
    if (isStart) {
      if (k === "up" || k === "down") {
        setSel(i => (k === "up" ? Math.max(0, i - 1) : Math.min(maxSel, i + 1)));
        return;
      }
      if (k === "return") { execSel(sel()); return; }
      return;
    }

    if (k === "up" || k === "down") {
      setSel(i => (k === "up" ? Math.max(0, i - 1) : Math.min(maxSel, i + 1)));
      return;
    }

    // Question mode: typing opens the inline editor (the user's answer may
    // not be one of the offered options). Permission mode: ignored — a
    // permission is Allow / Always allow / Deny, nothing else.
    if (isQ && !key.ctrl && !key.meta && key.sequence && key.sequence.length <= 10 && key.sequence !== "\r" && key.sequence !== "\n" && key.sequence !== "\t") {
      openQuestion(key.sequence);
      return;
    }

    if (k === "return") {
      if (isQ) {
        if (sel() >= opts.length) { openQuestion(""); return; }
        answerWith(opts[sel()]);
        return;
      }
      if (sel() === 0) { p.resolve(true); return; }
      if (sel() === 1) {
        try { getSession().permissions.setRule(p.command, "allow", true); } catch {}
        p.resolve(true);
        return;
      }
      if (sel() === 3) {
        try { getSession().permissions.setAuto(true); } catch {}
        p.resolve(true);
        return;
      }
      p.resolve(false);
    }
  });

  return (
    <box
      border borderStyle="rounded" borderColor={custom() ? ui.accent : isStart ? ui.accent : isQ ? ui.accent : ui.warning}
      paddingX={2} paddingY={1}
      flexDirection="column" marginBottom={0}
      backgroundColor={ui.bgPanel}
    >
      <text fg={custom() ? ui.accent : isStart ? ui.accent : isQ ? ui.accent : ui.warning}>
        {custom() ? "\u2753 Answer" : isStart ? "Session permissions" : isQ ? "\u2753 Question" : "\u26A0 Permission needed"}
      </text>
      <Show when={!custom()}>
        <text fg={ui.fgMuted} marginTop={1}>
          {isStart
            ? "New session \u00B7 you can toggle anytime with Shift+Tab:"
            : isQ
              ? "The model wants to know:"
              : "Model wants to " + (pr.tool === "bash" ? "run a command" : "change a file") + ":"}
        </text>
        <text fg={isQ ? ui.fg : ui.primary}>
          {isQ ? pr.command : pr.tool + ": " + fit(pr.command)}
        </text>
        <Show when={pr.label && pr.label !== "dangerous command"}>
          <text fg={ui.warning} marginTop={1}>
            {"\u26A0 " + pr.label}
          </text>
        </Show>

        <box flexDirection="column" marginTop={1} gap={0}>
          {isQ ? (
            opts.map((o, i) => (
              <box {...row(i)} flexDirection="row" paddingY={0}>
                <text fg={sel() === i ? ui.primary : ui.fgDim} paddingRight={1}>
                  {(sel() === i ? "\u25B6 " : "  ") + fit(o, 40)}
                </text>
              </box>
            ))
          ) : (
            <>
              <box {...row(0)} flexDirection="row" paddingY={0}>
                <text fg={sel() === 0 ? ui.primary : ui.fgDim} paddingRight={1}>
                  {(sel() === 0 ? "\u25B6 " : "  ") + "Allow"}
                </text>
                <text fg={ui.success}>{"(recommended)"}</text>
              </box>
              <box {...row(1)} flexDirection="row" paddingY={0}>
                <text fg={sel() === 1 ? ui.primary : ui.fgDim} paddingRight={1}>
                  {(sel() === 1 ? "\u25B6 " : "  ") + "Always allow"}
                </text>
                <text fg={ui.fgMuted}>{"remember for this command"}</text>
              </box>
              <box {...row(2)}>
                <text fg={sel() === 2 ? ui.primary : ui.fgDim} paddingY={0}>
                  {(sel() === 2 ? "\u25B6 " : "  ") + "Deny"}
                </text>
              </box>
              {pr.tool === "bash" ? (
                <box {...row(3)}>
                  <text fg={sel() === 3 ? ui.primary : ui.fgDim} paddingY={0}>
                    {(sel() === 3 ? "\u25B6 " : "  ") + "Allow all commands in this session"}
                  </text>
                </box>
              ) : null}
            </>
          )}
          {isQ && !isStart ? (
            <box {...row(opts.length)}>
              <text fg={sel() === opts.length ? ui.primary : ui.fgDim} paddingY={0}>
                {(sel() === opts.length ? "\u25B6 " : "  ") + "Type your answer\u2026"}
              </text>
            </box>
          ) : null}
        </box>
      </Show>

      <Show when={custom()}>
        <box border borderStyle="rounded" borderColor={ui.border} paddingX={1} marginTop={1}>
          <text fg={ui.fg}>{customText() || " "}</text>
        </box>
      </Show>

      <text fg={ui.fgMuted} marginTop={1}>
        {custom()
          ? "Enter send \u00B7 Esc back"
          : isStart
            ? "\u2191\u2193 choose \u00B7 Enter confirm \u00B7 ESC skip"
            : isQ
              ? "\u2191\u2193 choose \u00B7 Enter confirm \u00B7 type = your own answer \u00B7 ESC skip"
              : "\u2191\u2193 choose \u00B7 Enter confirm \u00B7 ESC deny"}
      </text>
    </box>
  );
}