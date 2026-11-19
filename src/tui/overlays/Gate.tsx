// Gate — the permission and question panel. It sits above the composer,
// owns its keys, and resolves the pending request. Approvals are explicit;
// questions accept a typed answer. The panel is deliberately a single sheet:
// one subject, one risk line, numbered choices, and a footer that always says
// what Escape does.
import { createEffect, createSignal, Show, For } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { GLYPH, palette, topRule, botRule, fit } from "../design.ts";
import {
  permission, questionOpen, questionText, setQuestionText, openQuestion, closeQuestion,
  setAutoPerm, getSession,
} from "../store.ts";

const ui = palette();

export function Gate() {
  const pr = () => permission();
  const isQ = () => !!pr()?.isQuestion;
  const isStart = () => !!pr()?.sessionStart;
  const opts = () => (isQ() && pr()?.options?.length ? pr()!.options! : []);
  const maxSel = () => isStart() ? 1 : isQ() ? (opts().length || 0) : 4;
  const [sel, setSel] = createSignal(0);
  const custom = () => questionOpen();

  // A new request always starts at the first choice with the answer editor
  // closed. Without this a stale selection from the previous prompt could
  // auto-approve (or auto-deny) the next one on Enter.
  createEffect(() => {
    const p = permission();
    if (!p) return;
    setSel(0);
    closeQuestion();
  });

  const permKey = () => pr()?.permKey || pr()?.tool || "";
  const scope = () => {
    const p = pr();
    if (!p) return "this request";
    if (p.permKey === "doom_loop") return "this repeated call";
    switch (p.tool) {
      case "bash":
      case "sandbox": return "this command";
      case "write":
      case "edit": return "this path";
      case "task":
      case "spawn_agents": return "this agent";
      case "mcp": return "this MCP tool";
      default: return "this request";
    }
  };
  const savedRule = () => {
    const p = pr();
    if (!p || p.isQuestion) return null;
    try { return getSession().permissions.getRuleFor(permKey(), p.command) || null; } catch { return null; }
  };

  const answerWith = (text: string) => {
    const p = permission();
    if (!p) return;
    closeQuestion();
    const t = String(text || "").trim();
    if (!t) return;
    p.resolve(true, t);
  };

  const execSel = (i: number) => {
    const p = permission();
    if (!p) return;
    if (isStart()) {
      if (i === 0) {
        try { getSession().permissions.setAuto(true); } catch {}
        setAutoPerm(true);
        p.resolve(true, "allow");
      } else {
        p.resolve(false, "ask");
      }
      return;
    }
    if (isQ()) {
      if (i >= opts().length) { openQuestion(""); return; }
      answerWith(opts()[i]);
      return;
    }
    const key = permKey();
    if (i === 0) { p.resolve(true); return; }
    if (i === 1) {
      try { getSession().permissions.setRuleFor(key, p.command, "allow", true); } catch {}
      p.resolve(true);
      return;
    }
    if (i === 2) { p.resolve(false); return; }
    if (i === 3) {
      try { getSession().permissions.setRuleFor(key, p.command, "deny", true); } catch {}
      p.resolve(false);
      return;
    }
    try { getSession().permissions.setAuto(true); } catch {}
    setAutoPerm(true);
    p.resolve(true);
  };

  useKeyboard((key: any) => {
    const p = permission();
    if (!p) return;
    const k = key.name;
    if (k === "escape") {
      if (custom()) { closeQuestion(); return; }
      // Questions have no approve/deny verdict: resolve with an empty note so
      // the session reports "No answer given." instead of feeding "(esc)"
      // back to the model as if the user had typed it.
      p.resolve(false, isQ() ? "" : "(esc)");
      return;
    }
    if (custom()) {
      if (k === "return") { answerWith(questionText()); return; }
      if (k === "backspace" || k === "delete") { setQuestionText(v => v.slice(0, -1)); return; }
      const s = key.sequence;
      if (!key.ctrl && !key.meta && s && s.length <= 10 && s !== "\r" && s !== "\n" && s !== "\t") setQuestionText(v => v + s);
      return;
    }
    if (k === "up" || k === "down") {
      setSel(i => (k === "up" ? Math.max(0, i - 1) : Math.min(maxSel(), i + 1)));
      return;
    }
    const seq = key.sequence;
    if (!key.ctrl && !key.meta && seq && seq.length === 1 && seq >= "1" && seq <= "9") {
      const n = Number(seq) - 1;
      if (isQ() && opts().length > 0 && n < opts().length) { setSel(n); execSel(n); return; }
      if (isQ() && n === opts().length) { openQuestion(seq); return; }
      if (!isQ() && n <= maxSel()) { setSel(n); execSel(n); return; }
    }
    if (k === "return") {
      if (isQ() && !isStart() && sel() >= opts().length) { openQuestion(""); return; }
      execSel(Math.min(sel(), maxSel()));
      return;
    }
    if (isQ() && !key.ctrl && !key.meta && seq && seq.length <= 10 && seq !== "\r" && seq !== "\n" && seq !== "\t") {
      openQuestion(seq);
    }
  });

  const title = () => custom()
    ? "Answer needed"
    : isStart()
      ? "Session permissions"
      : isQ()
        ? "Question"
        : "Permission needed" + (permKey() ? " · " + permKey() : "");
  const titleColor = () => custom() || isQ() ? ui.accent : ui.warning;
  const subject = () => {
    const p = pr()!;
    if (isStart()) return "Choose how tool prompts work for this session:";
    if (isQ()) return "wants to know:";
    if (p.permKey === "doom_loop") return "is repeating the same call:";
    switch (p.tool) {
      case "bash":
      case "sandbox": return "wants to run a shell command:";
      case "write":
      case "edit": return "wants to change a file:";
      case "task":
      case "spawn_agents": return "wants to delegate to a subagent:";
      case "mcp": return "wants to start an MCP server:";
      default: return "wants to use " + p.tool + ":";
    }
  };
  const sheetW = () => {
    const term = Math.max(40, (process.stdout?.columns || 100) | 0);
    return Math.max(44, Math.min(72, term - 10));
  };
  const row = (i: number, label: string, hint?: string) => (
    <box flexDirection="row" backgroundColor={sel() === i ? ui.bgPanelAlt : undefined}
      onMouseDown={() => setSel(i)} onMouseUp={() => execSel(i)}>
      <text fg={sel() === i ? ui.primary : ui.fgDim}>{(sel() === i ? GLYPH.pointer + " " : "  ") + "[" + (i + 1) + "] "}</text>
      <text fg={sel() === i ? ui.fg : ui.fgDim}>{label}</text>
      {hint ? <text fg={ui.fgMuted}>{"  " + hint}</text> : null}
    </box>
  );
  const permRows = () => [
    { label: "Allow once", hint: "recommended" },
    { label: "Always allow " + scope(), hint: "saved" },
    { label: "Deny once" },
    { label: "Always deny " + scope(), hint: "saved" },
    { label: "Auto-approve all prompts this session", hint: "shift+tab" },
  ];
  const footer = () => custom()
    ? "enter send · esc back to options"
    : isStart()
      ? "↑↓ select · 1-2 answer · esc = ask each time"
      : isQ()
        ? "1-" + (opts().length || 1) + " pick · type your own answer · enter confirm · esc cancel"
        : "↑↓ select · 1-5 answer · esc denies";

  return (
    <Show when={permission()} keyed>
      <box flexDirection="column" width={sheetW()} alignSelf="center" flexShrink={0}>
        <text fg={titleColor()} height={1} flexShrink={0}>{topRule(sheetW(), undefined, { left: title() })}</text>
        <box flexDirection="column" paddingX={2} backgroundColor={ui.bgPanel}>
          <Show when={!custom()}>
            <text fg={ui.fgMuted}>{subject()}</text>
            <text fg={ui.fg}>{isQ() ? pr()!.command : fit(pr()!.command, Math.max(24, sheetW() - 6))}</text>
            <Show when={!!pr()!.label}>
              <text fg={ui.warning}>{"! " + pr()!.label}</text>
            </Show>
            <Show when={!isQ() && savedRule()}>
              <text fg={savedRule() === "deny" ? ui.error : ui.success}>
                {"saved rule: " + savedRule() + " · this request still asks once"}
              </text>
            </Show>
            <box flexDirection="column" marginTop={1}>
              <Show when={isStart()} fallback={
                <Show when={isQ()} fallback={
                  <For each={permRows()}>{(r, i) => row(i(), r.label, r.hint)}</For>
                }>
                  <For each={opts()}>{(o: any, i: any) => row(i(), String(o && (o as any).label ? (o as any).label : o))}</For>
                  <box flexDirection="row" backgroundColor={sel() === opts().length ? ui.bgPanelAlt : undefined}
                    onMouseDown={() => setSel(opts().length)} onMouseUp={() => execSel(opts().length)}>
                    <text fg={sel() === opts().length ? ui.primary : ui.fgMuted}>{(sel() === opts().length ? GLYPH.pointer + " " : "  ") + "Type your answer..."}</text>
                  </box>
                </Show>
              }>
                <For each={[
                  { label: "Allow all prompts", hint: "auto-approve this session" },
                  { label: "Ask each time", hint: "keep per-request prompts" },
                ]}>{(r, i) => row(i(), r.label, r.hint)}</For>
              </Show>
            </box>
          </Show>
          <Show when={custom()}>
            <box paddingLeft={1}><text fg={ui.fg}>{questionText() || " "}</text></box>
          </Show>
          <text fg={ui.fgMuted}>{footer()}</text>
        </box>
        <text fg={titleColor()} height={1} flexShrink={0}>{botRule(sheetW())}</text>
      </box>
    </Show>
  );
}
