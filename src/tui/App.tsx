// Loom Code — OpenTUI root. One keyboard dispatcher, one turn engine, one
// shell. Every key maps to a configured action; every turn streams into the
// Stage as numbered parts (thought, tool, output, patch, reply).
import { onMount, onCleanup, createMemo, Show } from "solid-js";
import { useKeyboard, usePaste, useRenderer, useSelectionHandler } from "@opentui/solid";
import { createTimeline } from "@opentui/core";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";
import { palette, setTheme, themeOptions, themeName, WORDMARK_CODE_PLAIN } from "./design.ts";
import {
  messages, setMessages, input, setInput, cursor, setCursor, setDraft,
  selStart, selEnd, setSelStart, setSelEnd, clearSelection,
  pastedAt, setPastedAt,
  thinking, setThinking,
  thinkStart, setThinkStart,
  modal, openModal, closeModal,
  suggestions, setSuggestions, autoKind, setAutoKind, setAutoIndex,
  refreshProviderState, refreshUsage, appendMessage, patchLastMessage, patchMessageAt, recomputeTodos,
  invalidateFilesCache,
  getSession, persistUi,
  providerName, modelName, sessionId, modelMeta,
  showToolDetails, setShowToolDetails, showThinking, setShowThinking,
  setThoughtClosed,
  inputMode, setInputMode,
  setSkillActive,
  SLASH_LIST, fuzzyFiles,
  type Suggestion,
  registerSuggestionPicker, pickSuggestion,
  recordPrompt, historyPrev, historyNext, historyReset,
  speedStats, setSpeedStats,
  permission, requestPermission, askSessionPermissions,
  setSessionAuto, autoPerm, setPointerPos,
  setUserExpandedIdx,
  showToast,
  wireTodoEvents,
  startSubagent, updateSubagent, endSubagent, persistSubagent, loadSubagentHistory,
  queueDraft, dequeueDraft, queuedDrafts,
  vimMode, vimNormal, setVimNormal, toggleVim,
} from "./store.ts";
import * as kbs from "./keybinds.ts";
import { prettyToolName, stripAnsi } from "./toolname.ts";
import { toolDisplay } from "./toolkit.ts";
import { Stage, estVisualLines, USER_PREVIEW_LINES } from "./shell/Stage.tsx";
import { LoomBar } from "./shell/LoomBar.tsx";
import { Boot } from "./shell/Boot.tsx";
import { Gate } from "./overlays/Gate.tsx";
import { Toasts } from "./overlays/Toasts.tsx";
import { Deck } from "./overlays/Deck.tsx";
import {
  ProviderPicker, SelectModal, InputModal, SettingsModal,
  openModelPicker, openKeyModal, openBaseUrlEditor,
} from "./overlays/Pickers.tsx";
import {
  McpModal, ConnectorsModal, SandboxModal, GraphModal, openGraphModal,
  SubagentPanel, SubagentDetailPanel,
} from "./overlays/Sheets.tsx";
import { showHelpText, showProvidersText, showAgentsText } from "./reports.ts";
import { saveSession, loadSession, listSessions } from "../core/session-store.js";
import { loadConfig, saveConfig } from "../config/settings.js";
import { loadAgents, resolveAgent } from "../core/agents.js";
import { snapshotBefore, snapshotAfter, snapshotBashBefore, diffBashAfter, clearFileDiffs } from "../core/file-diffs.js";
import { createRestorePoint, listRestorePoints, restoreTo } from "../core/restore.js";
import { TranscriptUndo } from "../core/transcript-undo.js";
import { PROVIDERS, PROVIDER_ORDER, PROVIDER_LABELS } from "../providers/index.js";
import * as plugin from "../core/plugin-cmd.js";
import * as sandbox from "../core/sandbox.js";
import { on } from "../core/events.js";
import { listSkills } from "../skills/skills-manager.js";

let _vimReg = "";
const _undo = new TranscriptUndo(50);
let _lastRestoreId: string | null = null;

const ui = palette();

export function App(props: { initialPrompt?: string; resumeSession?: string; autoMode?: boolean }) {
  const renderer = useRenderer();
  if (props.autoMode) setSessionAuto(true);

  let escArmAt: number | null = null;
  let pointerTimer: any = null;
  let pendingPointer = { x: 0, y: 0 };

  // Mouse movement is only consumed by the splash robot. Coalesce it to one
  // update per frame and skip it entirely once the transcript is docked, so
  // hovering/scrolling the slash list does not re-render the splash art.
  function trackPointer(e: any) {
    if (messages().length > 0) return;
    pendingPointer = { x: Number(e.x) || 0, y: Number(e.y) || 0 };
    if (pointerTimer) return;
    pointerTimer = setTimeout(() => {
      pointerTimer = null;
      setPointerPos(pendingPointer.x, pendingPointer.y);
    }, 16);
  }

  function quit(code: number = 0) {
    persistUi();
    let sid = "";
    try { sid = saveSession(syncSessionForSave()).id; } catch {}
    try { renderer.destroy(); } catch {}
    setTimeout(() => {
      console.log("");
      console.log(WORDMARK_CODE_PLAIN);
      console.log("");
      const binName = process.env.LOOM_BIN_NAME || "loom";
      console.log("   Resume this session: " + binName + (sid ? " -s " + sid : ""));
      console.log("");
      process.exit(code);
    }, 150);
  }

  function runShell(cmd: string): string {
    try {
      return (execSync(cmd, { cwd: process.cwd(), encoding: "utf8", timeout: 15000, stdio: "pipe", windowsHide: true }) || "(no output)").slice(0, 4000);
    } catch (e: any) { return "Error: " + String(e?.message || e).slice(0, 500); }
  }

  function expandAt(text: string): string {
    return text.replace(/@([\w\.\-\/\\]+)/g, (_, r) => {
      const p = path.join(process.cwd(), r);
      if (fs.existsSync(p)) {
        try { return "\n\n[File: " + r + "]\n" + fs.readFileSync(p, "utf8").slice(0, 5000); } catch {}
      }
      return _;
    });
  }

  function updateAutocomplete(text: string) {
    if (!text) { setSuggestions([]); setAutoKind("none"); setAutoIndex(0); return; }
    if (text.startsWith("/")) {
      const q = text.slice(1).toLowerCase();
      const hits = SLASH_LIST.filter(c => c.cmd.startsWith(q)).map(c => ({ label: "/" + c.cmd, desc: c.desc } as Suggestion));
      try {
        const { listCustomCommands } = require("../core/custom-commands.js");
        for (const cc of listCustomCommands()) {
          if (cc.name.toLowerCase().startsWith(q)) hits.push({ label: "/" + cc.name, desc: "custom command" });
        }
      } catch {}
      setSuggestions(hits); setAutoKind("slash"); setAutoIndex(0);
    } else if (text.startsWith("@") && !/\s/.test(text.slice(text.lastIndexOf("@") + 1))) {
      const m = text.match(/@([\w\.\-\/\\]*)$/);
      const q = (m ? m[1] : "").toLowerCase();
      const agentHits = Object.values(loadAgents()).filter((a: any) =>
        a.mode === "subagent" && (a.id.startsWith(q) || a.name.toLowerCase().startsWith(q))
      ).map((a: any) => ({ label: "@" + a.id, desc: a.description } as Suggestion));
      const fileHits = fuzzyFiles(m ? m[1] : "").slice(0, Math.max(1, 10 - agentHits.length)).map(f => ({ label: "@" + f } as Suggestion));
      setSuggestions(agentHits.concat(fileHits)); setAutoKind("at"); setAutoIndex(0);
    } else if (text.startsWith("@")) {
      setSuggestions([]); setAutoKind("none"); setAutoIndex(0);
    } else if (text.startsWith("!")) {
      setSuggestions([{ label: "!ls -la" }, { label: "!git status" }, { label: "!git diff" }, { label: "!pwd" }] as Suggestion[]);
      setAutoKind("shell"); setAutoIndex(0);
    } else {
      setSuggestions([]); setAutoKind("none"); setAutoIndex(0);
    }
  }

  function submit(text: string) {
    const raw = text.trim();
    if (!raw) return;
    setSuggestions([]); setAutoKind("none"); setAutoIndex(0);

    if (raw.startsWith("/")) { recordPrompt(raw); setDraft(""); processSlash(raw); return; }
    if (raw.startsWith("!")) {
      recordPrompt(raw); setDraft("");
      appendMessage({ role: "user", content: raw });
      appendMessage({ role: "system", content: runShell(raw.slice(1)) });
      return;
    }

    if (sandbox.isReadySignal(raw)) {
      if (sandbox.sandboxPending()) {
        recordPrompt(raw); setDraft("");
        appendMessage({ role: "user", content: raw });
        sandbox.sandboxStatusAsync().then((st0: any) => {
          if (st0.docker === "ready" || st0.docker === "no_daemon") {
            appendMessage({ role: "system", content: "Docker detected — pick an OS to finish the sandbox setup." });
            openModal({ type: "sandbox" });
          } else {
            sandbox.markInstallPending();
            appendMessage({ role: "system", content: sandbox.installGuide() });
          }
        });
        return;
      }
      if (!thinking()) {
        sandbox.sandboxStatusAsync().then((st0: any) => {
          if (st0.docker === "ready" && st0.container === "absent" && /set ?up|build|create|make/i.test(raw)) {
            recordPrompt(raw); setDraft("");
            appendMessage({ role: "user", content: raw });
            appendMessage({ role: "system", content: "Docker detected — pick an OS to finish the sandbox setup." });
            openModal({ type: "sandbox" });
          } else {
            recordPrompt(raw); setDraft("");
            runPrompt(raw, false);
          }
        });
        return;
      }
    }

    let agentId: string | null = null;
    let userText: string | undefined;
    let expanded = raw;
    if (raw.startsWith("@")) {
      const atMatch = raw.match(/^@([\w\-]+)\s*([\s\S]*)$/);
      if (atMatch) {
        const atAgent = resolveAgent(atMatch[1]);
        if (atAgent && atAgent.mode === "subagent") {
          agentId = atAgent.id;
          userText = atMatch[2].trim() || "Continue with your task.";
        }
      }
      if (!agentId) expanded = expandAt(raw);
    }

    if (thinking()) return;
    recordPrompt(expanded);
    setDraft("");
    runPrompt(userText != null ? userText : expanded, false, agentId, userText);
  }

  function runPrompt(raw: string, shown: boolean, agentId?: string | null, userText?: string) {
    const preUi = messages().slice();
    const preSess = getSession().messages.slice();
    const preTodos = (getSession().todos || []).slice();
    const preStep = _undo.push({ ui: preUi, session: preSess, todos: preTodos }, raw);

    if (!shown) appendMessage({ role: "user", content: raw });
    setTimeout(() => {
      try {
        const rp = createRestorePoint(raw);
        if (rp && rp.id) {
          _lastRestoreId = rp.id;
          if (preStep) preStep.restoreId = rp.id;
        }
      } catch {}
    }, 0);
    setThinking(true); setThinkStart(Date.now());
    const sess = getSession();
    const turnId = (sess.turnCount || 0) + 1;
    const idx = messages().length;
    appendMessage({ role: "assistant", content: "", thinking: true, agentLabel: agentId || undefined, turnId });
    setThoughtClosed(new Set<number>());
    const t0 = Date.now();

    sess.setMode(inputMode());
    setSpeedStats({ live: { elapsedMs: 0, firstTokenMs: null, tokensPerSec: 0 }, last: sess.getSpeed().last });
    clearFileDiffs();
    let turnDiffs: any[] = [];
    let lastSpeedPush = 0;
    let contentAcc = "";
    let reasonAcc = "";
    let flushTimer: any = null;
    const parts: any[] = [];
    let lastToolPatch = 0;
    const subAcc: any = { agent: "", text: "", log: "", status: "" };

    function snapshotParts() {
      return parts.map(p => p.type === "reasoning"
        ? { ...p, thinkMs: Math.max(0, (p.lastAt || p.firstAt || 0) - (p.firstAt || 0)) }
        : p);
    }
    function ensureTextPart(txt: string) {
      if (!txt) return;
      if (!parts.some(p => p.type === "text")) parts.push({ type: "text", text: String(txt) });
    }
    function flushStream() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (contentAcc) patchLastMessage({ content: contentAcc });
      if (reasonAcc) patchLastMessage({ thinkingContent: reasonAcc });
      if (parts.length) patchLastMessage({ parts: snapshotParts() });
      if (subAcc.agent) patchMessageAt(idx, { subagent: { agent: subAcc.agent, text: subAcc.text, log: subAcc.log, status: subAcc.status } });
    }
    const speedTimer = setInterval(() => {
      if (thinking()) setSpeedStats({ live: sess.getSpeed().live, last: sess.getSpeed().last });
    }, 1000);
    const offTodos: (() => void) | null = on("todos:changed", (list: any[]) => {
      patchMessageAt(idx, {
        todos: (Array.isArray(list) ? list : []).map((t: any) => ({
          done: t.status === "completed", inProgress: t.status === "in_progress",
          cancelled: t.status === "cancelled", text: String(t.content || ""),
        })),
      });
    });
    const sendOpts: any = agentId ? { agentId } : undefined;

    try {
      sess.sendUserMessage(raw, {
        onDelta(txt: string) {
          contentAcc += txt;
          const last = parts[parts.length - 1];
          if (last && last.type === "text") last.text += txt;
          else parts.push({ type: "text", text: String(txt) });
          if (!flushTimer) flushTimer = setTimeout(flushStream, 100);
          const now = Date.now();
          if (now - lastSpeedPush > 500) {
            lastSpeedPush = now;
            setSpeedStats({ live: sess.getSpeed().live, last: sess.getSpeed().last });
          }
        },
        onReasoning(txt: string) {
          reasonAcc += txt;
          const last = parts[parts.length - 1];
          if (last && last.type === "reasoning") {
            last.text += txt;
            last.lastAt = Date.now();
          } else {
            const now = Date.now();
            parts.push({ type: "reasoning", text: String(txt), firstAt: now, lastAt: now });
          }
          if (!flushTimer) flushTimer = setTimeout(flushStream, 100);
        },
        onSubagent(ev: any) {
          if (!ev) return;
          try {
            const runId = ev.runId || subAcc.runId;
            if (ev.type === "start" && runId) {
              subAcc.runId = runId;
              startSubagent({ runId, agent: ev.agent || "", agentId: ev.id || "", prompt: String(ev.text || ""), sessionId: getSession()?.conversationId });
            } else if (runId) {
              if (ev.type === "delta" || ev.type === "reasoning") updateSubagent(runId, { contentAppend: String(ev.text || "") });
              else if (ev.type === "tool") updateSubagent(runId, { toolLogAppend: String(ev.text || "") });
              else if (ev.type === "done") {
                const wasInterrupted = !!ev.interrupted;
                const finished = endSubagent(runId, {
                  status: wasInterrupted ? "cancelled" : "done",
                  content: String(ev.text || ""),
                  interrupted: wasInterrupted,
                  durationMs: typeof ev.durationMs === "number" ? ev.durationMs : undefined,
                  tokensIn: typeof ev.tokensIn === "number" ? ev.tokensIn : undefined,
                  tokensOut: typeof ev.tokensOut === "number" ? ev.tokensOut : undefined,
                  costUsd: typeof ev.costUsd === "number" ? ev.costUsd : undefined,
                });
                if (finished) persistSubagent(finished);
              } else if (ev.type === "error") {
                const finished = endSubagent(runId, { status: "error", content: String(ev.text || ""), interrupted: false });
                if (finished) persistSubagent(finished);
              }
            }
          } catch {}
          if (ev.agent) subAcc.agent = ev.agent;
          if (ev.type === "delta" || ev.type === "reasoning") subAcc.text += String(ev.text || "");
          else if (ev.type === "tool") subAcc.log += (subAcc.log ? " · " : "") + String(ev.text || "");
          else if (ev.type === "status") subAcc.status = String(ev.text || "");
          if (!flushTimer) flushTimer = setTimeout(flushStream, 100);
        },
        onAutoCompact(res: any) {
          if (res?.compacted) {
            appendMessage({ role: "system", content: "Auto-compacted: " + res.method + " — summarized/truncated " + res.removed + " earlier messages. Context was near the model limit." });
            refreshUsage();
          }
        },
        onTool(name: string, inp: any, callId: string) {
          const pn = prettyToolName(name);
          const dsp = toolDisplay(pn);
          parts.push({ type: "tool", tool: { name: pn, icon: dsp.icon, pending: dsp.pending, label: dsp.label(inp || {}), status: "running", callId: callId || undefined } });
          if (Date.now() - lastToolPatch > 150) {
            lastToolPatch = Date.now();
            flushStream();
          } else if (!flushTimer) {
            flushTimer = setTimeout(flushStream, 100);
          }
          if (dsp.diffs === "file") {
            const fp = inp?.filePath;
            if (fp) snapshotBefore(fp);
          }
          if (dsp.diffs === "bash") snapshotBashBefore();
        },
        onPermissionRequest(name: string, command: string, label: string, options?: string[], permKey?: string) {
          return requestPermission(
            String(name), String(command || ""), String(label || ""),
            name === "ask", Array.isArray(options) ? options.map(String) : undefined,
            permKey ? String(permKey) : undefined
          );
        },
        onToolOutput(tc: any, chunk: string) {
          const cid = tc && tc.id;
          let pi = -1;
          for (let k = parts.length - 1; k >= 0; k--) {
            const pt = parts[k];
            if (pt.type !== "tool" || pt.tool.status !== "running") continue;
            if (cid) { if (pt.tool.callId && pt.tool.callId === cid) { pi = k; break; } continue; }
            if (!pt.tool.callId) { pi = k; break; }
          }
          if (pi >= 0) {
            let buf = (parts[pi].tool.liveOutput || "") + String(chunk || "");
            if (buf.length > 6000) buf = "… (stream truncated)\n" + buf.slice(-6000);
            parts[pi].tool.liveOutput = buf;
          }
          if (!flushTimer) flushTimer = setTimeout(flushStream, 100);
        },
        onToolResult(name: string, out: any, inp: any, callId: string) {
          const pn = prettyToolName(name);
          let doneIdx = -1;
          for (let k = parts.length - 1; k >= 0; k--) {
            const pt = parts[k];
            if (pt.type === "tool" && pt.tool.name === pn && pt.tool.status === "running") {
              if (callId && pt.tool.callId && pt.tool.callId !== callId) continue;
              pt.tool.status = out?.error ? "error" : "done";
              delete pt.tool.liveOutput;
              doneIdx = k;
              break;
            }
          }
          if (doneIdx >= 0 && !out?.error && typeof out?.result === "string") {
            let resTxt = stripAnsi(out.result).trim();
            if (resTxt.length > 4000) resTxt = resTxt.slice(0, 4000) + "\n… (truncated)";
            if (resTxt) parts[doneIdx].tool.output = resTxt;
          }
          flushStream();
          let diffs2: any[] = [];
          const fp = inp?.filePath;
          const dsp = toolDisplay(pn);
          if (dsp.diffs === "file" && fp && !out?.error) {
            try {
              const d = snapshotAfter(fp);
              if (d.added || d.removed) diffs2.push(d);
            } catch {}
          }
          if (dsp.diffs === "bash" && !out?.error) {
            try { diffs2 = diffs2.concat(diffBashAfter().filter((d2: any) => !d2.isNew)); } catch {}
          }
          if (diffs2.length) {
            if (doneIdx >= 0) parts[doneIdx].tool.fileDiffs = diffs2.slice();
            const merged = turnDiffs.filter(x => !diffs2.some(y => y.abs === x.abs)).concat(diffs2);
            turnDiffs = merged;
            const cur = messages()[idx]?.fileDiffs || [];
            if (cur.length !== merged.length || cur.some((x: any, i: number) => x.abs !== merged[i].abs)) {
              patchMessageAt(idx, { fileDiffs: merged });
            }
          }
        },
        onModelSwitch(info: any) {
          appendMessage({ role: "system", content: "Model — tokens finished on " + info.from + ", auto-switched to " + info.to + " and retrying." });
          refreshProviderState();
        },
      }, sendOpts).then((resp: any) => {
        ensureTextPart(resp.content);
        flushStream();
        const isErr = resp.type === "error";
        if (resp.interrupted) {
          patchMessageAt(idx, { thinking: false, interrupted: true, thinkTime: Date.now() - t0, isError: false, parts: snapshotParts() });
          const keptChars = String(resp.content || "").length;
          let inProgress = null;
          const tdNow = sess.todos || [];
          for (const td of tdNow) { if (td.status === "in_progress") { inProgress = td; break; } }
          appendMessage({ role: "system", content: "Interrupted — kept " + keptChars + " chars of the partial response" + (inProgress ? " (in progress: " + inProgress.content + ")" : "") + ". Type \"continue\" to resume the task." });
        } else {
          patchMessageAt(idx, { content: resp.content || "(the model ended the turn without any text)", thinking: false, thinkTime: Date.now() - t0, isError: isErr, parts: snapshotParts() });
          const openTodos = resp.openTodos;
          if (!isErr && openTodos && openTodos.length) {
            const openNames: string[] = [];
            for (let oi = 0; oi < Math.min(openTodos.length, 8); oi++) openNames.push("- [" + openTodos[oi].status + "] " + openTodos[oi].content);
            appendMessage({ role: "system", content: "Stopped with " + openTodos.length + " todo(s) still open:\n" + openNames.join("\n") + (openTodos.length > 8 ? "\n- …" : "") + "\nSay \"continue\" to keep going." });
          }
        }
        if (!isErr && sess.mode === "plan") {
          let plannedSteps = 0;
          const planTodos = sess.todos || [];
          for (const td of planTodos) { if (td.status !== "completed" && td.status !== "cancelled") plannedSteps++; }
          appendMessage({ role: "system", content: "Plan complete — " + (plannedSteps ? plannedSteps + " step(s) planned. " : "") + "press Tab to switch to Build, then send \"go\" to execute." });
        }
        setSpeedStats({ live: null, last: sess.getSpeed().last });
      }).catch((e: any) => {
        ensureTextPart("Error: " + String(e?.message || e).slice(0, 500));
        flushStream();
        patchMessageAt(idx, { content: "Error: " + String(e?.message || e).slice(0, 500), thinking: false, isError: true, thinkTime: Date.now() - t0, parts: snapshotParts() });
      }).finally(() => {
        clearInterval(speedTimer);
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (offTodos) offTodos();
        try { saveSession(syncSessionForSave()); } catch {}
        if (subAcc.agent) patchMessageAt(idx, { subagent: { agent: subAcc.agent, text: subAcc.text, log: subAcc.log, status: subAcc.status, done: true } });
        setTimeout(() => {
          setThinking(false); setThinkStart(null); recomputeTodos(); refreshUsage();
          flushQueueSoon();
        }, 0);
      });
    } catch (e: any) {
      ensureTextPart("Error: " + String(e?.message || e).slice(0, 500));
      flushStream();
      patchMessageAt(idx, { content: "Error: " + String(e?.message || e).slice(0, 500), thinking: false, isError: true, thinkTime: Date.now() - t0 });
      clearInterval(speedTimer);
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (offTodos) offTodos();
      setTimeout(() => {
        setThinking(false); setThinkStart(null); recomputeTodos(); refreshUsage();
        flushQueueSoon();
      }, 0);
    }
  }

  function flushQueueSoon() {
    setTimeout(() => {
      if (thinking() || permission() || modal()) return;
      const next = dequeueDraft();
      if (next) submit(next);
    }, 60);
  }

  function syncSessionForSave() {
    const sess = getSession();
    const uiMsgs = messages();
    const sessMsgs = sess.messages.slice();
    // A UI assistant row represents the WHOLE turn (thoughts + tools + final
    // reply), while the session stores one assistant row per model pass. Map
    // each UI row to the LAST assistant row with the same turnId; the old
    // reverse-order pairing attached a previous turn's parts to an earlier
    // tool-call row.
    const lastAssistantForTurn = new Map<number, number>();
    for (let i = 0; i < sessMsgs.length; i++) {
      const m = sessMsgs[i];
      if (m.role === "assistant" && typeof m.turnId === "number") lastAssistantForTurn.set(m.turnId, i);
    }
    for (const u of uiMsgs) {
      if (u.role !== "assistant" || typeof u.turnId !== "number") continue;
      const i = lastAssistantForTurn.get(u.turnId);
      if (i == null) continue;
      if (!(u.parts || u.thinkingContent || u.todos || u.fileDiffs || u.isError || u.interrupted)) continue;
      const cleanParts = Array.isArray(u.parts) ? u.parts.map((p: any) => {
        if (p.type === "tool" && p.tool && p.tool.liveOutput) {
          const t = Object.assign({}, p.tool);
          delete t.liveOutput;
          return Object.assign({}, p, { tool: t });
        }
        return p;
      }) : u.parts;
      sessMsgs[i] = {
        ...sessMsgs[i], parts: cleanParts, tools: u.tools, thinkingContent: u.thinkingContent,
        todos: u.todos, fileDiffs: u.fileDiffs, isError: u.isError,
        interrupted: u.interrupted, thinkTime: u.thinkTime,
      };
    }
    sess.messages = sessMsgs;
    return sess;
  }

  function resumeSessionById(id: string) {
    const data = loadSession(id);
    if (!data?.messages?.length) { showToast("Session not found: " + id, "error"); return; }
    getSession().conversationId = id;
    const pendingParts: Record<string, any> = {};
    getSession().messages = data.messages.map((m: any) => {
      const clean: any = {
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls || m.tool_calls,
        toolCallId: m.toolCallId || m.tool_call_id,
        turnId: m.turnId,
      };
      if (m.reasoning) clean.reasoning = m.reasoning;
      return clean;
    });
    setMessages(data.messages.map((m: any) => {
      if (m.role === "tool" && m.toolCallId && pendingParts[m.toolCallId]) {
        pendingParts[m.toolCallId].output = m.content;
        return null;
      }
      const out: any = { role: m.role, content: m.content, toolCalls: m.toolCalls, thinkTime: m.thinkTime, turnId: m.turnId };
      if (m.role === "assistant") {
        if (m.reasoning && !m.thinkingContent) out.thinkingContent = m.reasoning;
        if (Array.isArray(m.parts) && m.parts.length) {
          out.parts = m.parts;
        } else {
          const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
          if (calls.length) {
            out.parts = calls.map((c: any) => {
              const pn = prettyToolName(c.name);
              const dsp = toolDisplay(pn);
              const tool: any = { name: pn, icon: dsp.icon, pending: dsp.pending, label: dsp.label(c.input || {}), status: "done" };
              if (c.id) pendingParts[c.id] = tool;
              return { type: "tool", tool };
            });
          }
        }
        out.todos = m.todos; out.fileDiffs = m.fileDiffs; out.isError = m.isError; out.interrupted = m.interrupted;
      }
      return out;
    }).filter((x: any) => x !== null));
    appendMessage({ role: "system", content: "Resumed " + id });
    refreshProviderState();
  }

  function processSlash(raw: string) {
    const parts = plugin.tokenizeCli(raw.slice(1));
    if (!parts.length) return;
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).filter(a => !/^\[.*\]$/.test(a));

    try {
      const { expandCustomCommand } = require("../core/custom-commands.js");
      const expanded = expandCustomCommand(cmd, args.join(" "));
      if (expanded !== null) {
        setInput(""); setCursor(0);
        submit(expanded);
        return;
      }
    } catch {}

    const sess = getSession();
    const cfg = loadConfig();

    switch (cmd) {
      case "help": showHelpText(); return;
      case "agents": showAgentsText(); return;
      case "subagents": loadSubagentHistory({ limit: 200 }); openModal({ type: "subagents" }); return;
      case "editor": appendMessage({ role: "system", content: plugin.editorCmd() }); return;
      case "context": {
        const msgs = getSession().messages || [];
        const est = (s: any) => Math.ceil(String(s == null ? "" : (typeof s === "object" ? JSON.stringify(s) : s)).length / 4);
        let sys = 0, user = 0, asst = 0, tool = 0, schemas = 0;
        try { sys += est(getSession().systemPrompt); } catch {}
        try { schemas += est(getSession()._agentBlock) + est(getSession()._resolvedPrimary) + est(getSession()._resolvedSandbox) + Math.ceil((getSession()._toolSchemaChars || 0) / 4); } catch {}
        for (const m of msgs) {
          const t = est(m.content) + est(m.toolCalls);
          if (m.role === "user") user += t;
          else if (m.role === "assistant") asst += t;
          else if (m.role === "tool") tool += t;
          else sys += t;
        }
        const total = sys + user + asst + tool + schemas;
        let winLine = "";
        let autoLine = "";
        try {
          const ce = getSession().contextEstimate();
          winLine = "Window:  ~" + ce.tokens.toLocaleString() + " / " + ce.window.toLocaleString() + " tokens (" + ce.pct + "% used)";
          const threshold = Math.round((getSession().config.compactThreshold ?? 0.75) * 100);
          autoLine = "Auto-compact at: " + threshold + "% of the window";
        } catch {}
        appendMessage({ role: "system", content: [
          "=== Context (~tokens, chars/4 estimate) ===",
          "System+memory: " + sys,
          "User messages: " + user,
          "Assistant:     " + asst,
          "Tool results:  " + tool,
          "Schemas+turn:  " + schemas,
          "TOTAL:         " + total + "  (" + msgs.length + " messages)",
          winLine,
          autoLine,
          "", "Tip: /compact frees context when this grows large.",
        ].join("\n") });
        return;
      }
      case "compact": {
        appendMessage({ role: "system", content: "Compacting…" });
        getSession().compact({
          onCompact: (r: any) => {
            appendMessage({ role: "system", content: r.compacted
              ? "Compacted (" + r.method + "): summarized/truncated " + r.removed + " earlier messages; ~" + (r.tokensAfter ?? "?") + " tokens remain."
              : "Nothing to compact — the conversation is still short." });
            refreshUsage();
          },
        }).then((r: any) => {
          if (!r.compacted && !r.reason) appendMessage({ role: "system", content: "Compaction failed — try again." });
          refreshUsage();
          try { saveSession(syncSessionForSave()); } catch {}
        }).catch((e: any) => appendMessage({ role: "system", content: "Compaction failed: " + String(e?.message || e) }));
        return;
      }
      case "think": {
        const lvl = String(args[0] || "").toLowerCase();
        if (!["off", "low", "medium", "high"].includes(lvl)) { showToast("Usage: /think off|low|medium|high", "error"); return; }
        saveConfig(Object.assign({}, loadConfig(), { thinkLevel: lvl }));
        getSession().refresh();
        showToast("Thinking: " + lvl, "ok");
        return;
      }
      case "approve": {
        if (inputMode() !== "plan") { showToast("/approve only applies in Plan mode", "error"); return; }
        let plan = "";
        const ms2 = messages();
        for (let i = ms2.length - 1; i >= 0; i--) {
          const m: any = ms2[i];
          if (m.role === "assistant" && String(m.content || "").includes("## Plan")) { plan = String(m.content); break; }
        }
        openModal({
          type: "select", title: "Approve plan & switch to Build?", searchable: false,
          options: [{ label: "Approve — execute in Build", value: "go" }, { label: "Stay in Plan", value: "stay" }],
          onPick(v: string) {
            closeModal();
            if (v !== "go") return;
            setInputMode("build");
            getSession().setMode("build");
            appendMessage({ role: "system", content: "Plan approved — switched to Build." });
            submit(plan ? "Execute this plan:\n\n" + plan : "Proceed with the approved plan.");
          },
        });
        return;
      }
      case "tasks": {
        const bt = require("../core/background-tasks.js");
        const rows = bt.listBackgroundTasks();
        appendMessage({ role: "system", content: rows.length
          ? "=== Background tasks ===\n" + rows.map((t: any) => `${t.status === "running" ? "[>]" : t.status === "done" ? "[x]" : "[-]"} ${t.id}  ${t.command.slice(0, 50)}\n    ${t.status}${t.exitCode != null ? " exit=" + t.exitCode : ""} · ${(t.output.match(/\n/g) || []).length} lines`).join("\n")
          : "No background tasks. Start one: ask the agent to run bash with background:true." });
        return;
      }
      case "rewind": {
        const rp = require("../core/restore.js");
        let pts: any[] = [];
        try { pts = rp.listRestorePoints() || []; } catch {}
        if (!pts.length) { showToast("No restore points yet", "error"); return; }
        openModal({
          type: "select", title: "Rewind files to restore point", searchable: false,
          options: pts.slice(0, 12).map((p: any) => ({ label: p.label || p.id, sub: new Date(p.createdAt || Date.now()).toLocaleString(), value: p.id })),
          onPick(id: string) {
            closeModal();
            const r = rp.restoreTo(id);
            showToast(r && r.ok ? "Files rewound to " + id : "Restore failed", r && r.ok ? "ok" : "error");
          },
        });
        return;
      }
      case "share": {
        try {
          const fsx = require("fs"); const pathx = require("path");
          const dir = pathx.join(process.cwd(), ".loom", "shares");
          fsx.mkdirSync(dir, { recursive: true });
          const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const body = messages().map((m: any) => `<div class="m ${esc(m.role)}"><b>${esc(m.role)}</b><pre>${esc(String(m.content ?? ""))}</pre></div>`).join("\n");
          const html = `<!doctype html><meta charset="utf-8"><title>Loom session</title><style>body{background:#0b0d10;color:#d7dee6;font-family:ui-monospace,monospace;max-width:900px;margin:2rem auto;padding:0 1rem}.m{border-left:3px solid #2b333d;padding:.25rem .75rem;margin:.6rem 0}.m.user{border-color:#6fd3b6}.m.assistant{border-color:#e5b567}.m.system{color:#61707d}pre{white-space:pre-wrap;font-family:inherit;margin:.2rem 0}</style><h1>Loom Code session</h1>${body}`;
          const f = pathx.join(dir, (sessionId() || "session") + ".html");
          fsx.writeFileSync(f, html);
          showToast("Shared: " + f, "ok", 6000);
        } catch (e: any) { showToast("Share failed: " + String(e?.message || e), "error"); }
        return;
      }
      case "export": {
        try {
          const fsx = require("fs"); const pathx = require("path");
          const dir = pathx.join(process.cwd(), ".loom", "exports");
          fsx.mkdirSync(dir, { recursive: true });
          const lines: string[] = [];
          lines.push("# Loom Code session", "");
          lines.push("- Date: " + new Date().toISOString().slice(0, 19).replace("T", " "));
          lines.push("- Model: " + providerName() + " / " + modelName());
          lines.push("- Messages: " + messages().length, "");
          for (const m of messages()) {
            const who = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
            lines.push("## " + who, "");
            const text = String(m.content ?? "").trim();
            if (text) { lines.push(text, ""); }
            if (Array.isArray(m.parts)) {
              for (const p of m.parts) {
                if (p.type === "tool" && p.tool) {
                  const t = p.tool;
                  let row = "- tool `" + t.name + "` " + (t.status || "");
                  const out = String(t.output || "").trim();
                  if (out) row += ": " + out.replace(/\s+/g, " ").slice(0, 300);
                  lines.push(row);
                } else if (p.type === "text" && String(p.text || "").trim()) {
                  lines.push(String(p.text).trim(), "");
                }
              }
            }
            if (m.isError) lines.push("**(turn ended with an error)**", "");
            lines.push("---", "");
          }
          const f = pathx.join(dir, (sessionId() || "session") + ".md");
          fsx.writeFileSync(f, lines.join("\n"));
          showToast("Exported: " + f, "ok", 6000);
        } catch (e: any) { showToast("Export failed: " + String(e?.message || e), "error"); }
        return;
      }
      case "worktree": {
        const name = String(args[0] || "").replace(/[^\w-]/g, "");
        if (!name) { showToast("Usage: /worktree <name>", "error"); return; }
        const out2 = runShell(`git worktree add ../loom-${name} -b wt/${name}`);
        showToast(out2.toLowerCase().includes("fatal") ? "Worktree failed — see chat" : "Worktree ../loom-" + name + " ready (branch wt/" + name + ")", out2.toLowerCase().includes("fatal") ? "error" : "ok", 6000);
        appendMessage({ role: "system", content: out2.slice(0, 1500) });
        return;
      }
      case "style": {
        const text = args.join(" ").trim();
        const presets: Record<string, string> = { concise: "Reply in at most 2 sentences. No summaries of obvious steps.", explain: "Explain key decisions briefly after acting; teach the why." };
        const val = text ? (presets[text.toLowerCase()] || text) : "";
        saveConfig(Object.assign({}, loadConfig(), { outputStyle: val }));
        getSession().refresh();
        showToast(val ? "Output style set" : "Output style cleared", "ok");
        return;
      }
      case "remember": {
        const fact = args.join(" ").trim();
        if (!fact) { showToast("Usage: /remember <fact>", "error"); return; }
        try {
          const mem = require("../core/memory.js");
          const ok2 = mem.appendMemory(fact, "project");
          showToast(ok2 ? "Remembered → LOOM.md" : "Could not write LOOM.md", ok2 ? "ok" : "error");
        } catch { showToast("Could not write LOOM.md", "error"); }
        return;
      }
      case "vim": {
        const on2 = toggleVim();
        showToast("Vim mode: " + (on2 ? "on — Esc toggles NORMAL" : "off"), "ok");
        return;
      }
      case "build": case "plan": case "chat": {
        const modeInfo: Record<string, string> = {
          build: "Build — all tools enabled",
          plan: "Plan — read-only, no file changes",
          chat: "Chat — conversation only, no tools",
        };
        setInputMode(cmd as any);
        sess.setMode(cmd);
        showToast("Mode: " + modeInfo[cmd] + ". Press Tab to cycle.");
        return;
      }
      case "models": openModelPicker(); return;
      case "connect": {
        const pv = args[0]?.toLowerCase();
        if (!pv) { openModal({ type: "provider" }); return; }
        if (!PROVIDERS[pv]) { showToast("Unknown provider: " + pv + ". Try /connect to pick.", "error"); return; }
        cfg.provider = pv; saveConfig(cfg); refreshProviderState(); openKeyModal(pv);
        return;
      }
      case "key": openKeyModal(cfg.provider); return;
      case "baseurl": openBaseUrlEditor(args[0] || cfg.provider); return;
      case "model": {
        if (args.length) {
          sess.setModel(cfg.provider, args[0]);
          refreshProviderState();
          showToast("Model: " + args[0], "ok");
        } else openModelPicker();
        return;
      }
      case "providers": showProvidersText(); return;
      case "status": {
        const { envNamesFor } = require("../providers/index.js");
        const keySet = !!(cfg.apiKeys?.[cfg.provider] || (envNamesFor(cfg.provider) || []).some((n: string) => !!process.env[n]));
        appendMessage({ role: "system", content: "Provider: " + cfg.provider + "\nModel: " + (cfg.model?.[cfg.provider] || "default") + "\nKey: " + (keySet ? "configured" : "NOT SET") });
        return;
      }
      case "memory": {
        appendMessage({ role: "system", content: [
          path.join(process.cwd(), "LOOM.md"),
          path.join(os.homedir(), ".loom", "LOOM.md"),
        ].map(l => (fs.existsSync(l) ? "+" : "-") + " " + l).join("\n") });
        appendMessage({ role: "system", content: plugin.editorCmd() });
        return;
      }
      case "graph": openGraphModal(); return;
      case "permissions": {
        if (args[0] === "auto") {
          const next = !sess.permissions.auto;
          sess.permissions.setAuto(next);
          setSessionAuto(next);
          showToast("Auto-approve permissions: " + (next ? "ON" : "OFF") + (next ? " (asks are auto-approved, denies still block)" : ""), next ? "ok" : "info");
          return;
        }
        const rules = sess.permissions.sessionRules;
        if (args[0] === "reset") {
          for (const rk of Array.from(rules.keys())) sess.permissions.clearRule(rk as string);
          showToast("Permission rules cleared.", "ok");
          return;
        }
        const lines: string[] = [];
        rules.forEach((v: string, k: string) => {
          const i = k.indexOf("|");
          lines.push("  " + (i > 0 ? "[" + k.slice(0, i) + "] " + k.slice(i + 1) : "legacy " + k) + "  →  " + v);
        });
        if (!lines.length) lines.push("  (no saved rules)");
        appendMessage({ role: "system", content: "Saved permission rules (set via \"Always allow\" / \"Always deny\" in the popup):\n" + lines.join("\n") + "\nUse /permissions reset to clear." });
        return;
      }
      case "budget": {
        const { LEVELS, pickModel, describeLevel } = require("../core/model-router.js");
        const { budgetStatus, setMonthlyBudget, setDailyAlert, dayStatus, requestOverride, formatUsd } = require("../core/usage.js");
        const cur = cfg.budgetLevel || "auto";
        const arg = args[0]?.toLowerCase();
        if (arg === "override") {
          requestOverride();
          showToast("Budget override set — exactly one paid turn will go through despite the cap.", "ok");
          refreshUsage();
          return;
        }
        if (arg === "daily") {
          const num = args[1] === undefined ? NaN : parseFloat(args[1].replace(/^[$]/, ""));
          if (!Number.isNaN(num)) {
            setDailyAlert(num);
            showToast("Daily spend alert: " + formatUsd(num) + " / day (0 disables)", "ok");
            refreshUsage();
            return;
          }
          const day = dayStatus();
          showToast("Daily spend today: " + formatUsd(day.dayCostUsd) + (day.alertUsd > 0 ? " (alert at " + formatUsd(day.alertUsd) + ")" : " (no alert set)") + " — set one: /budget daily 3", "ok");
          return;
        }
        const num = arg === undefined ? NaN : parseFloat(arg.replace(/^[$]/, ""));
        if (!Number.isNaN(num)) {
          setMonthlyBudget(num);
          showToast("Monthly budget: " + formatUsd(num), "ok");
          refreshUsage();
          return;
        }
        if (!arg) {
          const info = describeLevel(cur);
          const spend = budgetStatus();
          const day = dayStatus();
          const picked = info.picked ? info.picked.provider + " / " + info.picked.model : "(none available)";
          const dayLine = "Day:      " + formatUsd(day.dayCostUsd) + (day.alertUsd > 0 ? " today (alert at " + formatUsd(day.alertUsd) + ")" : " today") + (day.alert ? "  daily alert reached" : "");
          appendMessage({ role: "system", content:
            "=== Budget ===\n" +
            "Level:    " + cur + (cur === "auto" ? "  (explicit picks, no routing)" : "  (auto-routed per turn)") + "\n" +
            "Would pick: " + picked + (info.freeAvailable ? "" : "  — no free models reachable") + "\n" +
            "Spend:    " + formatUsd(spend.monthCostUsd) + " of " + formatUsd(spend.budgetUsd) + " this month (" + Math.round(spend.pct) + "%)" + (spend.over ? "  cap reached — paid turns blocked" : "") + "\n" +
            dayLine + "\n" +
            "Levels:  free (only $0 models)  cheap (free + low-cost)  best (frontier)  auto (default)\n" +
            "Try: /budget free  — every turn stays free, paid models are blocked.  /budget 50 — set the monthly cap.  /budget override — one paid turn past the cap.  /budget daily 3 — alert when a day spends $3." });
          return;
        }
        if (!LEVELS.includes(arg)) { showToast("Budget: free, cheap, best, auto — or a dollar cap, e.g. /budget 50", "error"); return; }
        cfg.budgetLevel = arg; saveConfig(cfg); sess.config = cfg; refreshProviderState();
        if (arg === "free") {
          const info = describeLevel("free");
          if (!info.picked) showToast("Budget: free — but NO free model reachable yet. Run /connect for a free provider.", "error");
          else showToast("Budget: free — every turn now routes to " + info.picked.provider + " / " + info.picked.model, "ok");
        } else {
          showToast("Budget: " + arg, "ok");
        }
        return;
      }
      case "new": case "clear": {
        const msgCount = messages().length;
        openModal({
          type: "select", title: "Clear session?", searchable: false,
          options: [
            { label: "Keep it", sub: "esc / enter to keep", value: "keep" },
            { label: "Clear session (" + msgCount + " messages)", sub: "irreversible", value: "clear" },
          ],
          onPick(val: any) {
            closeModal();
            if (val !== "clear") { showToast("Session kept.", "info"); return; }
            sess.reset(); setMessages([]); showToast("Session cleared.", "ok"); refreshUsage();
          },
        });
        return;
      }
      case "restore": {
        const points = listRestorePoints();
        if (!points.length) { showToast("No restore points yet. A point is saved automatically before every prompt."); return; }
        openModal({
          type: "select", title: "Restore Point",
          options: points.map(p => {
            const t = new Date(p.at);
            const pad = (n: number) => String(n).padStart(2, "0");
            const when = pad(t.getMonth() + 1) + "-" + pad(t.getDate()) + " " + pad(t.getHours()) + ":" + pad(t.getMinutes());
            return { label: (p.label ? p.label : "(no prompt)"), sub: when + " — " + Object.keys(p.files).length + " files", value: p.id };
          }),
          onPick(id: string) {
            const r = restoreTo(id);
            closeModal();
            if (!r.ok) { showToast("Restore failed: " + r.error, "error"); return; }
            let line = "Restored to earlier state: " + r.restored.length + " files written back";
            if (r.deleted.length) line += ", " + r.deleted.length + " files removed";
            if (r.errors.length) line += "\nErrors: " + r.errors.join("; ").slice(0, 300);
            appendMessage({ role: "system", content: line });
            invalidateFilesCache();
            clearFileDiffs();
          },
        });
        return;
      }
      case "undo": {
        if (!_undo.canUndo()) { showToast("Nothing to undo.", "info"); return; }
        const curSnap = {
          ui: messages().slice(),
          session: getSession().messages.slice(),
          todos: (getSession().todos || []).slice(),
          restoreId: _lastRestoreId || undefined,
        };
        const target = _undo.undo(curSnap);
        if (!target) { showToast("Nothing to undo.", "info"); return; }
        setMessages(target.ui || []);
        getSession().messages = (target.session || []).slice();
        getSession().todos = (target.todos || []).slice();
        let undoLine = "Undone — transcript restored" + (target.label ? " to before: " + target.label.slice(0, 60) : "") + ".";
        if (target.restoreId) {
          _lastRestoreId = target.restoreId;
          undoLine += "\nAlso rewind the working tree to match? Run /undo-files to restore files from the same point.";
        }
        appendMessage({ role: "system", content: undoLine });
        try { saveSession(syncSessionForSave()); } catch {}
        refreshUsage();
        return;
      }
      case "redo": {
        if (!_undo.canRedo()) { showToast("Nothing to redo.", "info"); return; }
        const curSnap2 = {
          ui: messages().slice(),
          session: getSession().messages.slice(),
          todos: (getSession().todos || []).slice(),
          restoreId: _lastRestoreId || undefined,
        };
        const target2 = _undo.redo(curSnap2);
        if (!target2) { showToast("Nothing to redo.", "info"); return; }
        setMessages(target2.ui || []);
        getSession().messages = (target2.session || []).slice();
        getSession().todos = (target2.todos || []).slice();
        if (target2.restoreId) _lastRestoreId = target2.restoreId;
        appendMessage({ role: "system", content: "Redone — transcript restored" + (target2.label ? " to: " + target2.label.slice(0, 60) : "") + "." });
        try { saveSession(syncSessionForSave()); } catch {}
        refreshUsage();
        return;
      }
      case "undo-files": {
        if (!_lastRestoreId) { showToast("No file restore point bound to the last undo.", "error"); return; }
        const rr = restoreTo(_lastRestoreId);
        if (!rr.ok) { showToast("File restore failed: " + rr.error, "error"); return; }
        appendMessage({ role: "system", content: "Working tree rewound — " + rr.restored.length + " files restored, " + rr.deleted.length + " removed." });
        invalidateFilesCache();
        clearFileDiffs();
        return;
      }
      case "usage": {
        refreshUsage();
        const { formatTokens, formatUsd, getUsage } = require("../core/usage.js");
        const u = getUsage();
        const meta = modelMeta();
        const sess2 = getSession();
        const ce = sess2.contextEstimate();
        const budgetPct = u.budgetUsd ? Math.round((u.month.costUsd / u.budgetUsd) * 100) : 0;
        const priceLine = meta ? " ($" + (meta.priceIn || 0) + "/$" + (meta.priceOut || 0) + " per 1M in/out)" : "";
        appendMessage({ role: "system", content:
          "=== Usage ===\n" +
          "Model:    " + providerName() + " / " + modelName() + priceLine + "\n" +
          "Session:  " + formatTokens(sess2.tokensUsed) + " tokens (" + formatTokens(sess2.tokensIn) + " in / " + formatTokens(sess2.tokensOut) + " out)  ·  " + formatUsd(sess2.sessionCost) + "\n" +
          "Context:  ~" + formatTokens(ce.tokens) + " / " + formatTokens(ce.window) + " tokens (" + ce.pct + "% used)\n" +
          "Lifetime: " + formatTokens(u.totalTokens) + " tokens · " + formatUsd(u.totals.costUsd) + "\n" +
          "Month " + u.monthKey + ": " + formatTokens(u.monthTokens) + " tokens · " + formatUsd(u.month.costUsd) + "  ·  " + budgetPct + "% of " + formatUsd(u.budgetUsd) + " budget" });
        return;
      }
      case "skills": {
        const sub = args[0];
        if (sub === "install") { appendMessage({ role: "system", content: plugin.installSkillCmd(args.slice(1)) }); return; }
        if (sub === "remove") { appendMessage({ role: "system", content: plugin.removeSkillCmd(args.slice(1)) }); return; }
        if (sub === "help") { appendMessage({ role: "system", content: plugin.skillHelp() }); return; }
        const cfgNow = loadConfig();
        const disabledNow = (cfgNow.skillDisabled || []);
        const list = listSkills();
        if (!list.length) { appendMessage({ role: "system", content: plugin.listSkillsText() }); return; }
        const bySource: Record<string, any[]> = { global: [], agents: [], project: [] };
        for (const sk of list) (bySource[sk.source] = bySource[sk.source] || []).push(sk);
        const skillOptions: any[] = [];
        const sourceTitles: Record<string, string> = { global: "Global (~/.loom/skills)", agents: "Agents (~/.agents/skills)", project: "Project (.loom/skills)" };
        for (const srcKey of ["global", "agents", "project"]) {
          if (!bySource[srcKey].length) continue;
          skillOptions.push({ isHeader: true, header: sourceTitles[srcKey] });
          for (const sk3 of bySource[srcKey]) {
            const off3 = disabledNow.includes(sk3.name);
            skillOptions.push({ label: sk3.name, value: sk3.name, sub: "[" + (off3 ? "off" : "on") + "] " + sk3.description.slice(0, 44), tags: [srcKey] });
          }
        }
        skillOptions.push({ label: "+ Install skill", value: "__install__", sub: "from a local folder or git URL (--trust for remote)" });
        openModal({
          type: "select", title: "Skills — Enter toggle on/off", searchable: true, options: skillOptions,
          onPick(val: any) {
            if (val === "__install__") {
              closeModal();
              openModal({
                type: "input", title: "Install skill",
                placeholder: "folder path or git URL [--trust]",
                onCancel() { setTimeout(() => processSlash("/skills"), 10); },
                onPick(target: string) {
                  if (!target.trim()) { closeModal(); return; }
                  const out = plugin.installSkillCmd(target.trim().split(/\s+/));
                  showToast(out.split("\n")[0].slice(0, 90), out.indexOf("blocked") >= 0 || out.indexOf("failed") >= 0 ? "error" : "ok", 6000);
                  appendMessage({ role: "system", content: out });
                  closeModal();
                  setTimeout(() => processSlash("/skills"), 10);
                },
              });
              return;
            }
            const cfg2 = loadConfig();
            const d = (cfg2.skillDisabled || []);
            if (d.includes(val)) {
              cfg2.skillDisabled = d.filter((n: string) => n !== val);
              showToast("skill ON: " + val, "ok");
            } else {
              cfg2.skillDisabled = d.concat([val]);
              showToast("skill OFF: " + val, "ok");
            }
            saveConfig(cfg2);
            sess.config = cfg2;
            closeModal(); setTimeout(() => processSlash("/skills"), 10);
          },
        });
        return;
      }
      case "mcp": {
        const sub2 = args[0];
        if (sub2 === "add") { appendMessage({ role: "system", content: plugin.mcpAddCmd(args.slice(1)) }); return; }
        if (sub2 === "remove") { appendMessage({ role: "system", content: plugin.mcpRemoveCmd(args.slice(1)) }); return; }
        if (sub2 === "toggle") { appendMessage({ role: "system", content: plugin.mcpToggleCmd(args.slice(1)) }); return; }
        if (sub2 === "help") { appendMessage({ role: "system", content: plugin.mcpHelp() }); return; }
        openModal({ type: "mcp" });
        return;
      }
      case "connectors": {
        const sub3 = args[0];
        if (sub3 === "add") { appendMessage({ role: "system", content: plugin.connectorAddCmd(args.slice(1)) }); return; }
        if (sub3 === "remove") { appendMessage({ role: "system", content: plugin.mcpRemoveCmd(args.slice(1)) }); return; }
        if (sub3 === "toggle") { appendMessage({ role: "system", content: plugin.mcpToggleCmd(args.slice(1)) }); return; }
        if (sub3 === "help") { appendMessage({ role: "system", content: plugin.mcpHelp() }); return; }
        openModal({ type: "connectors" });
        return;
      }
      case "sandbox": {
        const ssub = args[0];
        if (!ssub || ssub === "setup" || ssub === "os") { openModal({ type: "sandbox" }); return; }
        if (ssub === "guide") { appendMessage({ role: "system", content: sandbox.installGuide() }); return; }
        if (ssub === "off") {
          sandbox.setSandboxEnabled(false);
          appendMessage({ role: "system", content: "Sandbox off — the sandbox tool is disabled; the agent works on your machine as usual. The container is kept (run /sandbox on to re-enable, /sandbox rm to delete it)." });
          return;
        }
        if (ssub === "on") {
          sandbox.sandboxStatusAsync().then((stOn: any) => {
            if (stOn.container !== "running") { appendMessage({ role: "system", content: "Sandbox container is not running. Run /sandbox setup first." }); return; }
            sandbox.setSandboxEnabled(true);
            appendMessage({ role: "system", content: "Sandbox on — the agent can use the sandbox tool for isolated commands inside " + sandbox.CONTAINER + " when needed. Everything else stays on your machine." });
          });
          return;
        }
        if (ssub === "rm") {
          appendMessage({ role: "system", content: "Removing the sandbox container…" });
          const rmCp = require("child_process");
          const rmSpawn = rmCp.spawn("docker", ["rm", "-f", sandbox.CONTAINER], { windowsHide: true });
          let rmDone = false;
          const rmTimer = setTimeout(() => {
            if (!rmDone) { rmDone = true; try { rmSpawn.kill(); } catch {} appendMessage({ role: "system", content: "Sandbox removal timed out. Is Docker running?" }); }
          }, 30000);
          rmSpawn.on("close", (rmCode: number) => {
            if (rmDone) return;
            rmDone = true;
            clearTimeout(rmTimer);
            if (rmCode === 0) {
              sandbox.setSandboxEnabled(false);
              appendMessage({ role: "system", content: "Sandbox container removed. Run /sandbox setup to rebuild it." });
            } else {
              appendMessage({ role: "system", content: "No sandbox container to remove." });
            }
          });
          rmSpawn.on("error", () => {
            if (rmDone) return;
            rmDone = true;
            clearTimeout(rmTimer);
            appendMessage({ role: "system", content: "No sandbox container to remove (docker not reachable)." });
          });
          return;
        }
        if (ssub === "status") {
          sandbox.sandboxStatusAsync().then((st: any) => {
            let line = "Sandbox: ";
            if (st.docker === "not_installed") line += "Docker not installed";
            else if (st.docker === "no_daemon") line += "Docker installed, daemon not running";
            else line += "Docker " + st.dockerVersion + " · container " + st.container + (st.enabled ? " · sandbox tool on" : " · sandbox tool off");
            if (st.pending) line += "\nWaiting for you to install Docker — when it's done say \"docker is ready\" (or run /sandbox).";
            else if (st.docker === "not_installed") line += "\nRun /sandbox for the setup wizard.";
            else if (st.container === "absent") line += "\nRun /sandbox to build it.";
            appendMessage({ role: "system", content: line });
          });
          return;
        }
        appendMessage({ role: "system", content: "Usage: /sandbox (wizard) | status | on | off | rm | guide" });
        return;
      }
      case "sessions": {
        const saved = listSessions();
        if (!saved.length) { appendMessage({ role: "system", content: "No saved sessions yet." }); return; }
        openModal({
          type: "select", title: "Saved Sessions", searchable: true,
          options: saved.map(s => {
            const when = (s.updatedAt || s.createdAt || s.mtime || "").replace("T", " ").slice(0, 16);
            return { label: s.id, sub: when + " — " + s.messageCount + " msgs", value: s.id };
          }),
          onPick(id: string) { closeModal(); resumeSessionById(id); },
        });
        return;
      }
      case "settings": openModal({ type: "settings" }); return;
      case "thinking": setShowThinking(v => !v); persistUi(); showToast("Thinking display: " + (showThinking() ? "on" : "off")); return;
      case "details": setShowToolDetails(v => !v); showToast("Tool details: " + (showToolDetails() ? "on" : "off")); return;
      case "theme": {
        const tOpts = themeOptions().map(t => ({ label: t.label, value: t.id, sub: t.desc }));
        if (args.length) {
          if (setTheme(args[0].toLowerCase())) showToast("Theme: " + args[0].toLowerCase(), "ok");
          else showToast("Unknown theme: " + args[0] + ". Try /theme to pick.", "error");
          return;
        }
        const prevTheme = themeName();
        openModal({
          type: "select", title: "Select Theme", options: tOpts, searchable: false, preview: true,
          onPick(val: any, opt: any) {
            if (setTheme(val)) { closeModal(); showToast("Theme: " + (opt?.label || val), "ok"); }
          },
          onPreview(val: any) { if (val) { try { setTheme(val); } catch {} } },
          onCancel() {
            if (themeName() !== prevTheme) { try { setTheme(prevTheme); } catch {} }
            closeModal();
          },
        });
        return;
      }
      case "exit": {
        persistUi(); saveSession(syncSessionForSave());
        showToast("Session saved: " + (sess.conversationId || "???") + " — Goodbye!", "ok");
        setTimeout(() => quit(), 500);
        return;
      }
      default: showToast("Unknown command: /" + cmd + ". Try /help.", "error"); return;
    }
  }

  function editDelete(kind: "backspace" | "delete") {
    const ss = selStart(), se = selEnd();
    if (ss >= 0 && se > ss) {
      const v = input();
      setDraft(v.slice(0, ss) + v.slice(se), ss);
      clearSelection();
      updateAutocomplete(input());
      historyReset();
      return;
    }
    const p = Math.min(cursor(), input().length);
    const v = input();
    let n: string, np: number;
    if (kind === "backspace") { if (p === 0) return; n = v.slice(0, p - 1) + v.slice(p); np = p - 1; }
    else { if (p >= v.length) return; n = v.slice(0, p) + v.slice(p + 1); np = p; }
    setDraft(n, np);
    updateAutocomplete(n);
    historyReset();
  }

  function caretOrHistory(dir: number) {
    const s2 = suggestions();
    if (s2.length) {
      if (dir < 0) setAutoIndex(i => Math.max(0, i - 1));
      else setAutoIndex(i => Math.min(s2.length - 1, i + 1));
      return;
    }
    clearSelection();
    if (input().includes("\n")) {
      const text = input();
      const pos = Math.min(cursor(), text.length);
      const upto = text.slice(0, pos);
      const lineIdx = (upto.match(/\n/g) || []).length;
      const col = pos - (upto.lastIndexOf("\n") + 1);
      const rows = text.split("\n");
      const target = Math.max(0, Math.min(rows.length - 1, lineIdx + dir));
      let tp = 0;
      for (let li = 0; li < target; li++) tp += rows[li].length + 1;
      setCursor(tp + Math.min(col, rows[target].length));
      return;
    }
    const recall = dir < 0 ? historyPrev() : historyNext();
    if (recall !== null) setDraft(recall);
  }

  function runAction(action: string, ks?: string) {
    switch (action) {
      case "app_exit": quit(); return;
      case "input_select_all": {
        const len = input().length;
        setSelStart(0); setSelEnd(len);
        setCursor(len);
        return;
      }
      case "user_expand": {
        const msgs = messages();
        for (let i = msgs.length - 1; i >= 0; i--) {
          const um = msgs[i];
          if (um.role === "user" && estVisualLines(String(um.content || "")) > USER_PREVIEW_LINES) {
            setUserExpandedIdx(cur => (cur === i ? null : i));
            return;
          }
        }
        return;
      }
      case "subagent_list":
        loadSubagentHistory({ limit: 200 });
        openModal({ type: "subagents" });
        return;
      case "command_list": {
        if (!modal()) openModal({ type: "palette", onPick: (cmd: string) => processSlash(cmd) });
        return;
      }
      case "session_interrupt": {
        if (thinking()) {
          const now = Date.now();
          if (escArmAt && now - escArmAt < 2500) {
            escArmAt = null;
            try { getSession().interrupt(); } catch {}
            setThinking(false);
          } else {
            escArmAt = now;
            showToast("Press ESC again to interrupt the running task");
          }
          return;
        }
        if (modal() && ks && kbs.is("modal_cancel", ks)) {
          const m = modal();
          closeModal();
          if (m && m.onCancel) m.onCancel();
          return;
        }
        setDraft(""); setSuggestions([]); setAutoKind("none"); setAutoIndex(0); historyReset(); clearSelection(); setPastedAt(0);
        return;
      }
      case "modal_cancel": {
        const m = modal();
        closeModal();
        if (m && m.onCancel) m.onCancel();
        return;
      }
      case "input_submit": {
        if (pickSuggestion()) return;
        const text = input().trim();
        if (!text) return;
        const wantsCmd = text.startsWith("/") || text.startsWith("!");
        if (text.startsWith("# ") && text.slice(2).trim()) {
          try {
            const memR = require("../core/memory.js");
            const okR = memR.appendMemory(text.slice(2).trim(), "project");
            showToast(okR ? "Remembered → LOOM.md" : "Could not write LOOM.md", okR ? "ok" : "error");
          } catch { showToast("Could not write LOOM.md", "error"); }
          clearSelection(); setDraft(""); setPastedAt(0);
          return;
        }
        if (thinking() && !wantsCmd) {
          queueDraft(text);
          clearSelection(); setDraft(""); setPastedAt(0);
          showToast("Queued — " + queuedDrafts().length + " waiting", "ok");
          return;
        }
        clearSelection(); setDraft(""); setPastedAt(0);
        submit(text);
        return;
      }
      case "input_newline": {
        clearSelection(); setPastedAt(0);
        const p = Math.min(cursor(), input().length);
        const v = input();
        setDraft(v.slice(0, p) + "\n" + v.slice(p), p + 1);
        historyReset();
        return;
      }
      case "input_move_left": clearSelection(); setCursor(c => Math.max(0, c - 1)); return;
      case "input_move_right": clearSelection(); setCursor(c => Math.min(input().length, c + 1)); return;
      case "line_home": clearSelection(); setCursor(0); return;
      case "line_end": clearSelection(); setCursor(input().length); return;
      case "input_backspace": setPastedAt(0); editDelete("backspace"); return;
      case "input_delete": setPastedAt(0); editDelete("delete"); return;
      case "prompt_autocomplete_next": {
        const s = suggestions();
        if (s.length) { setAutoIndex(i => Math.min(s.length - 1, (i || 0) + 1)); return; }
        const modes = ["build", "plan", "chat"];
        const mi = modes.indexOf(inputMode());
        const nm = modes[(mi + 1) % 3];
        setInputMode(nm as any);
        getSession().setMode(nm);
        return;
      }
      case "up_context": caretOrHistory(-1); return;
      case "down_context": caretOrHistory(1); return;
      case "input_paste": return;
      default: {
        const slash = kbs.slashFor(action);
        if (slash) { processSlash(slash); return; }
        return;
      }
    }
  }

  useKeyboard((key: any) => {
    const k = key.name;
    const ks = kbs.keyString(key);
    const ma = modal();

    if (kbs.is("app_exit", ks)) {
      const ss = selStart(), se = selEnd();
      if (!ma && ss >= 0 && se > ss) {
        const selText = input().slice(ss, se);
        clearSelection();
        setCursor(se);
        if (selText) {
          copyText(selText);
          showToast("Copied \"" + selText.slice(0, 24) + (selText.length > 24 ? "…" : "") + "\" to clipboard.", "ok");
        }
        return;
      }
      quit(); return;
    }
    if (kbs.is("input_select_all", ks)) { runAction("input_select_all"); return; }

    if (kbs.tapLeader(ks)) return;
    if (kbs.isLeaderPending()) {
      const la = kbs.leaderMatch(ks);
      if (la) { kbs.cancelLeader(); runAction(la, ks); return; }
      kbs.cancelLeader();
    }

    if (permission()) return;

    if (k === "tab" && key.shift && !ma) {
      const next = !autoPerm();
      setSessionAuto(next);
      showToast(next
        ? "Auto-approve ON · all commands allowed this session (Shift+Tab to toggle)"
        : "Auto-approve OFF · per-command asks are back (Shift+Tab to toggle)",
        next ? "ok" : "info", 4000);
      return;
    }

    if (kbs.is("user_expand", ks)) { runAction("user_expand"); return; }
    if (k === "escape" && kbs.isLeaderPending()) { kbs.cancelLeader(); return; }

    if (vimMode() && !ma && !permission()) {
      if (k === "escape") { setVimNormal(v => !v); return; }
      if (vimNormal()) {
        const vl = input();
        const vc = Math.min(cursor(), vl.length);
        const wordFwd = () => { const m2 = vl.slice(vc).match(/^\W*\w+/); return m2 ? vc + m2[0].length : vl.length; };
        const wordBack = () => { const head = vl.slice(0, vc); const m2 = head.match(/\w+\W*$|\W+$/); return m2 ? vc - m2[0].length : 0; };
        switch (k) {
          case "h": if (vc > 0) setCursor(vc - 1); return;
          case "l": if (vc < vl.length) setCursor(vc + 1); return;
          case "0": setCursor(0); return;
          case "$": setCursor(vl.length); return;
          case "w": setCursor(wordFwd()); return;
          case "b": setCursor(wordBack()); return;
          case "x": setInput(vl.slice(0, vc) + vl.slice(vc + 1)); return;
          case "D": _vimReg = vl.slice(vc); setInput(vl.slice(0, vc)); return;
          case "S": _vimReg = vl; setInput(""); return;
          case "p": setInput(vl.slice(0, vc) + _vimReg + vl.slice(vc)); setCursor(vc + _vimReg.length); return;
          case "i": setVimNormal(false); return;
          case "a": setVimNormal(false); setCursor(Math.min(vl.length, vc + 1)); return;
          case "I": setVimNormal(false); setCursor(0); return;
          case "A": setVimNormal(false); setCursor(vl.length); return;
        }
        return;
      }
    }

    if (kbs.is("session_interrupt", ks) || kbs.is("modal_cancel", ks)) { runAction("session_interrupt", ks); return; }
    if (kbs.is("command_list", ks)) { runAction("command_list"); return; }
    if (ma) return;
    if (kbs.is("prompt_autocomplete_next", ks)) { runAction("prompt_autocomplete_next"); return; }
    if (kbs.is("up_context", ks)) { runAction("up_context"); return; }
    if (kbs.is("down_context", ks)) { runAction("down_context"); return; }
    if (kbs.is("input_move_left", ks)) { runAction("input_move_left"); return; }
    if (kbs.is("input_move_right", ks)) { runAction("input_move_right"); return; }
    if (kbs.is("line_home", ks)) { runAction("line_home"); return; }
    if (kbs.is("line_end", ks)) { runAction("line_end"); return; }
    if (kbs.is("input_submit", ks)) { runAction("input_submit"); return; }
    if (kbs.is("input_newline", ks)) { runAction("input_newline"); return; }
    if (kbs.is("input_backspace", ks)) { runAction("input_backspace"); return; }
    if (kbs.is("input_delete", ks)) { runAction("input_delete"); return; }

    if (!key.ctrl && !key.meta && key.sequence && key.sequence.indexOf("\x1b") < 0 && key.sequence.length <= 10 && key.sequence !== "\r" && key.sequence !== "\n" && key.sequence !== "\t") {
      const v = input();
      const ss = selStart(), se = selEnd();
      const hasSel = ss >= 0 && se > ss;
      const p = Math.min(cursor(), v.length);
      const n = hasSel ? v.slice(0, ss) + key.sequence + v.slice(se) : v.slice(0, p) + key.sequence + v.slice(p);
      clearSelection();
      setDraft(n, hasSel ? ss + key.sequence.length : p + key.sequence.length);
      setPastedAt(0);
      updateAutocomplete(n);
      historyReset();
    }
  });

  function copyText(text: string) {
    try { process.stdout.write("\x1b]52;c;" + Buffer.from(text, "utf8").toString("base64") + "\x07"); } catch {}
    if (process.platform === "win32" && process.env.LOOM_NO_CLIPBOARD !== "1") {
      try {
        execSync('powershell -NoProfile -NonInteractive -Command "$input | Set-Clipboard"', { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 8000, windowsHide: true });
      } catch {}
    }
  }
  useSelectionHandler((sel: any) => {
    if (!sel || sel.isDragging || sel.isStart) return;
    const ax = Math.min(Number(sel.anchor.x), Number(sel.focus.x));
    const ay = Math.min(Number(sel.anchor.y), Number(sel.focus.y));
    const bx = Math.max(Number(sel.anchor.x), Number(sel.focus.x));
    const by = Math.max(Number(sel.anchor.y), Number(sel.focus.y));
    if (ax === bx && ay === by) return;
    try {
      const lines = new TextDecoder().decode(renderer.currentRenderBuffer.getRealCharBytes(true)).split("\n");
      const out: string[] = [];
      for (let y = ay; y <= by; y++) out.push((lines[y] || "").slice(ax, bx + 1));
      const text = out.join("\n").replace(/\s+$/g, "").trimEnd();
      if (!text.trim()) return;
      copyText(text);
      showToast("Copied " + text.length + " chars to clipboard.", "ok");
    } catch {}
  });

  usePaste((event: any) => {
    if (modal() || permission()) return;
    const txt = new TextDecoder().decode(event?.bytes || "").replace(/\r\n?/g, "\n");
    if (!txt) return;
    const v = input();
    const ss = selStart(), se = selEnd();
    const hasSel = ss >= 0 && se > ss;
    const p = Math.min(cursor(), v.length);
    const n = hasSel ? v.slice(0, ss) + txt + v.slice(se) : v.slice(0, p) + txt + v.slice(p);
    clearSelection();
    setDraft(n, hasSel ? ss + txt.length : p + txt.length);
    setPastedAt(Date.now());
    updateAutocomplete(n);
    historyReset();
  });

  let _skillToastOff: (() => void) | null = null;
  let _skillDoneOff: (() => void) | null = null;
  let _taskToastOff: (() => void) | null = null;
  onMount(() => {
    createTimeline({ duration: Infinity, autoplay: true });
    refreshProviderState();
    refreshUsage();
    wireTodoEvents();
    loadSubagentHistory({ limit: 200 });
    registerSuggestionPicker((label: string) => {
      if (label.startsWith("/")) processSlash(label);
      else if (label.startsWith("!")) { appendMessage({ role: "user", content: label }); appendMessage({ role: "system", content: runShell(label.slice(1)) }); }
      else if (label.startsWith("@")) setDraft(label + " ");
    });
    if (props.resumeSession) resumeSessionById(props.resumeSession);
    if (props.initialPrompt) setTimeout(() => submit(props.initialPrompt!), 200);
    if (!process.env.LOOM_NO_SESSION_PROMPT && !autoPerm() && !permission() && !modal() && !props.resumeSession) {
      setTimeout(() => { if (!autoPerm() && !permission() && !modal()) askSessionPermissions(); }, 500);
    }
    try {
      if (!process.env.LOOM_NO_SESSION_PROMPT && sandbox.sandboxPending()) {
        setTimeout(() => {
          appendMessage({ role: "system", content: "Docker sandbox setup is still pending. Install Docker (see /sandbox guide), then say \"docker is ready\" and I'll build it automatically." });
        }, 800);
      }
    } catch {}
    _skillToastOff = on("trigger:skill", (d: any) => {
      showToast("skill: " + (d?.skills || []).join(", "), "ok", 5000);
      setSkillActive(d?.skills || []);
    });
    _skillDoneOff = on("turn:end", (d: any) => {
      if (d?.skills?.length) showToast("skill handled: " + d.skills.join(", "), "ok");
    });
    const taskStatuses: Record<string, string> = {};
    _taskToastOff = on("tasks:changed", () => {
      try {
        const bt = require("../core/background-tasks.js");
        const rows = bt.listBackgroundTasks();
        for (const t of rows) {
          const prev = taskStatuses[t.id];
          taskStatuses[t.id] = t.status;
          if (prev === "running" && t.status !== "running") {
            showToast("Task " + t.id + " " + t.status + (t.exitCode != null ? " (exit " + t.exitCode + ")" : "") + " — /tasks for output", t.status === "done" ? "ok" : "error", 6000);
          }
        }
      } catch {}
    });
  });
  onCleanup(() => { persistUi(); if (_skillToastOff) _skillToastOff(); if (_skillDoneOff) _skillDoneOff(); if (_taskToastOff) _taskToastOff(); });

  const chatMessages = createMemo(() => {
    const msgs = messages();
    if (showToolDetails()) return msgs;
    return msgs.map((m: any) => {
      if (m.role !== "assistant" || (!m.parts && !m.tools)) return m;
      return Object.assign({}, m, {
        parts: (m.parts || []).filter((p: any) => p.type !== "tool" || p.tool.status !== "done"),
        tools: (m.tools || []).filter((t: any) => t.status !== "done"),
      });
    });
  });

  const Shell = () => {
    return (
      <box flexDirection="column" flexGrow={1} paddingX={1}>
        <Show
          when={messages().length === 0}
          fallback={
            <>
              <Stage messages={chatMessages} thinking={thinking()} />
              <Gate />
              <LoomBar />
            </>
          }
        >
          <Show when={!permission()} fallback={
            <box flexDirection="column" flexGrow={1} justifyContent="center">
              <Gate />
            </box>
          }>
            <box flexDirection="column" flexGrow={1} justifyContent="center">
              <Boot />
              <LoomBar splash />
            </box>
            <Gate />
          </Show>
        </Show>
      </box>
    );
  };

  return (
    <box position="absolute" top={0} left={0} right={0} bottom={0} flexDirection="column" backgroundColor={ui.bg}
      onMouseMove={(e: any) => trackPointer(e)}>
      <Shell />

      {(() => {
        const m = modal();
        if (!m) return null;
        return (
          <box position="absolute" top={0} left={0} right={0} bottom={0} flexDirection="column" alignItems="center" justifyContent="center" zIndex={99}>
            {m.type === "provider" ? <ProviderPicker /> : null}
            {m.type === "select" ? <SelectModal title={m.title} options={m.options ?? []} onPick={m.onPick} searchable={m.searchable} onCancel={m.onCancel} onPreview={m.onPreview} /> : null}
            {m.type === "input" ? <InputModal title={m.title} placeholder={m.placeholder} onPick={m.onPick} isKey={m.isKey} value={m.value} caretStart={m.caretStart} onCancel={m.onCancel} /> : null}
            {m.type === "settings" ? <SettingsModal /> : null}
            {m.type === "palette" ? <Deck onPick={m.onPick} /> : null}
            {m.type === "mcp" ? <McpModal /> : null}
            {m.type === "connectors" ? <ConnectorsModal /> : null}
            {m.type === "sandbox" ? <SandboxModal /> : null}
            {m.type === "graph" ? <GraphModal graph={m.graph} err={m.graphError} /> : null}
            {m.type === "subagents" ? <SubagentPanel /> : null}
            {m.type === "subagent_detail" ? <SubagentDetailPanel /> : null}
          </box>
        );
      })()}

      <Toasts />
    </box>
  );
}
