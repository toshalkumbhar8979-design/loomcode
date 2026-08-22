// Loom Code - OpenTUI app root component.
// useKeyboard handles ALL text input char-by-char.
import { onMount, onCleanup, createMemo, Show } from "solid-js";
import { useKeyboard, usePaste, useRenderer, useSelectionHandler } from "@opentui/solid";
import { engine, createTimeline } from "@opentui/core";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";
import { palette, setTheme, themeOptions, themeName, LOOM_LOGO } from "./theme.ts";
import {
  messages, setMessages, input, setInput, cursor, setCursor, setDraft,
  selStart, selEnd, setSelStart, setSelEnd, clearSelection,
  pastedAt, setPastedAt,
  thinking, setThinking,
  thinkStart, setThinkStart,
  modal, openModal, closeModal,
  suggestions, setSuggestions, autoKind, setAutoKind, setAutoIndex,
  sidebarVisible, setSidebarVisible, sidebarTab, setSidebarTab,
  refreshProviderState, refreshUsage, appendMessage, patchLastMessage, patchMessageAt, recomputeTodos,
  invalidateFilesCache,
  getSession, persistUi,
  providerName, modelName, sessionId, modelMeta,
  showToolDetails, setShowToolDetails, showThinking, setShowThinking,
  setThoughtClosed,
  inputMode, setInputMode,
  setSkillActive,
  SLASH_LIST, fuzzyFiles,
  Suggestion,
  registerSuggestionPicker, pickSuggestion,
  recordPrompt, historyPrev, historyNext, historyReset,
  speedStats, setSpeedStats,
  permission, requestPermission, askSessionPermissions,
  setSessionAuto, autoPerm,
  userExpandedIdx, setUserExpandedIdx,
  showToast,
  wireTodoEvents,
  startSubagent, updateSubagent, endSubagent, persistSubagent, loadSubagentHistory,
  activeSubagents, subagentHistory,
  queueDraft, dequeueDraft, queuedDrafts,
  vimMode, vimNormal, setVimNormal, toggleVim,
} from "./store.ts";
import { BreadcrumbBar } from "./components/BreadcrumbBar.tsx";
import * as kbs from "./keybinds.ts";
import { SplashScreen } from "./components/SplashScreen.tsx";
import { ChatArea, estVisualLines, USER_PREVIEW_LINES } from "./components/ChatArea.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { InputBar } from "./components/InputBar.tsx";
import { ToastOverlay } from "./components/ToastOverlay.tsx";
import { PermissionPopup } from "./components/PermissionPopup.tsx";
import { prettyToolName, stripAnsi } from "./toolname.ts";
import { toolDisplay } from "./tool-display.ts";
import {
  ProviderPicker, SelectModal, InputModal, SettingsModal,
  PaletteModal, McpModal, ConnectorsModal, GraphModal,
  openModelPicker, openKeyModal, openBaseUrlEditor,
  showProvidersText, showHelpText, showAgentsText,
  openGraphModal,
} from "./components/Modals.tsx";
import { SubagentPanel, SubagentDetailPanel } from "./components/SubagentPanel.tsx";
import { saveSession, loadSession, listSessions } from "../core/session-store.js";
import { loadConfig, saveConfig, getBaseUrl } from "../config/settings.js";
import { loadAgents, resolveAgent } from "../core/agents.js";
import { snapshotBefore, snapshotAfter, snapshotBashBefore, diffBashAfter, clearFileDiffs } from "../core/file-diffs.js";
import { createRestorePoint, listRestorePoints, restoreTo } from "../core/restore.js";
import { PROVIDERS, PROVIDER_ORDER, PROVIDER_LABELS } from "../providers/index.js";
import * as plugin from "../core/plugin-cmd.js";
import { on } from "../core/events.js";
import { listSkills } from "../skills/skills-manager.js";

let _vimReg = ""; // vim NORMAL-mode paste register

const ui = palette("loom");

export function App(props: { initialPrompt?: string; resumeSession?: string; autoMode?: boolean }) {
  const renderer = useRenderer();
  if (props.autoMode) setSessionAuto(true);

  // First ESC while a turn runs only arms the interrupt; a second ESC within
  // the window actually stops it (no more accidental Interrupts).
  let escArmAt: number | null = null;

  function quit(code: number = 0) {
    persistUi();
    let sessionId = "";
    try { sessionId = saveSession(syncSessionForSave()).id; } catch {}
    try { renderer.destroy(); } catch {}
    setTimeout(function() {
      console.log("");
      console.log(LOOM_LOGO.join("\n"));
      const binName = process.env.LOOM_BIN_NAME || "loom";
      console.log("   resume: " + binName + " -s " + sessionId);
      console.log("");
      process.exit(code);
    }, 150);
  }

  // Shell helper
  function runShell(cmd: string): string {
    try {
      return (execSync(cmd, { cwd: process.cwd(), encoding: "utf8", timeout: 15000, stdio: "pipe", windowsHide: true }) || "(no output)").slice(0, 4000);
    } catch (e: any) { return "Error: " + String(e?.message || e).slice(0, 500); }
  }

  function expandAt(text: string): string {
    return text.replace(/@([\w\.\-\/\\]+)/g, function(_, r) {
      var p = path.join(process.cwd(), r);
      if (fs.existsSync(p)) {
        try { return "\n\n[File: " + r + "]\n" + fs.readFileSync(p, "utf8").slice(0, 5000); } catch {}
      }
      return _;
    });
  }

  function updateAutocomplete(text: string) {
    if (!text) { setSuggestions([]); setAutoKind("none"); setAutoIndex(0); return; }
    if (text.startsWith("/")) {
      var q = text.slice(1).toLowerCase();
      var hits = SLASH_LIST.filter(function(c) { return c.cmd.startsWith(q); }).map(function(c) {
        var s: Suggestion = { label: "/" + c.cmd, desc: c.desc + (c.args ? " \u2014 " + c.args : "") };
        return s;
      });
      // Custom commands (.loom/commands/*.md) join the picker after built-ins.
      try {
        const { listCustomCommands } = require("../core/custom-commands.js");
        for (const cc of listCustomCommands()) {
          if (cc.name.toLowerCase().startsWith(q)) hits.push({ label: "/" + cc.name, desc: "custom command \u2014 " + cc.file });
        }
      } catch {}
      setSuggestions(hits); setAutoKind("slash"); setAutoIndex(0);
    } else if (text.startsWith("@") && !/\s/.test(text.slice(text.lastIndexOf("@") + 1))) {
      // Only when the trailing token after the last @ is unspaced ("@exâ€¦"):
      // a completed "@agent query" must not re-open the picker.
      var m = text.match(/@([\w\.\-\/\\]*)$/);
      var q = (m ? m[1] : "").toLowerCase();
      // Subagents first (the main agent delegates to them automatically), then
      // files, so "@exâ€¦" suggests @explore before paths.
      var agentHits = Object.values(loadAgents()).filter(function(a: any) {
        return a.mode === "subagent" && (a.id.startsWith(q) || a.name.toLowerCase().startsWith(q));
      }).map(function(a: any) { return { label: "@" + a.id, desc: a.description } as Suggestion; });
      var fileHits = fuzzyFiles(m ? m[1] : "").slice(0, Math.max(1, 10 - agentHits.length)).map(function(f) { return { label: "@" + f } as Suggestion; });
      setSuggestions(agentHits.concat(fileHits)); setAutoKind("at"); setAutoIndex(0);
    } else if (text.startsWith("@")) {
      setSuggestions([]); setAutoKind("none"); setAutoIndex(0);
    } else if (text.startsWith("!")) {
      setSuggestions([{ label: "!ls -la" }, { label: "!git status" }, { label: "!git diff" }, { label: "!pwd" }] as Suggestion[]); setAutoKind("shell"); setAutoIndex(0);
    } else {
      // Plain text draft: no prefix, no suggestions â€” stale autocomplete
      // selection must not take precedence over submission.
      setSuggestions([]); setAutoKind("none"); setAutoIndex(0);
    }
  }

  // While a turn is running, Enter does NOT consume the input: the typed text
  // stays in the bar (editable) and is sent normally once the task finishes.
  // recordPrompt() runs only when the prompt is actually submitted, so a held
  // draft that was never sent doesn't pollute the prompt history.
  function submit(text: string) {
    var raw = text.trim();
    if (!raw) return;
    setSuggestions([]); setAutoKind("none"); setAutoIndex(0);

    if (raw.startsWith("/")) { recordPrompt(raw); setDraft(""); processSlash(raw); return; }
    if (raw.startsWith("!")) { recordPrompt(raw); setDraft(""); appendMessage({ role: "user", content: raw }); appendMessage({ role: "system", content: runShell(raw.slice(1)) }); return; }

    // "@agent â€¦" delegates the whole turn to that subagent (same as the model
    // calling the task tool â€” but explicit). "@file â€¦" still inlines the file.
    var agentId: string | null = null;
    var userText: string | undefined;
    if (raw.startsWith("@")) {
      var atMatch = raw.match(/^@([\w\-]+)\s*([\s\S]*)$/);
      if (atMatch) {
        var atAgent = resolveAgent(atMatch[1]);
        if (atAgent && atAgent.mode === "subagent") {
          agentId = atAgent.id;
          userText = atMatch[2].trim() || "Continue with your task.";
        }
      }
      if (!agentId) raw = expandAt(raw);
    }

    if (thinking()) {
      // Keep the text in the input bar â€” hint shown in the footer while held.
      return;
    }
    recordPrompt(raw);
    setDraft("");
    runPrompt(userText != null ? userText : raw, false, agentId, userText);
  }

  function runPrompt(raw: string, shown: boolean, agentId?: string | null, userText?: string) {
    if (!shown) appendMessage({ role: "user", content: raw });
    // Snapshot the project in the background so /restore always works, without
    // stalling the first API call.
    setTimeout(function() { try { createRestorePoint(raw); } catch {} }, 0);
    setThinking(true); setThinkStart(Date.now());
    var idx = messages().length;
    appendMessage({ role: "assistant", content: "", thinking: true, agentLabel: agentId || undefined });
    // Live-collapse state from a previous turn must not leak onto this one.
    setThoughtClosed(new Set<number>());
    var t0 = Date.now();

    var sess = getSession();
    sess.setMode(inputMode());
    setSpeedStats({ live: { elapsedMs: 0, firstTokenMs: null, tokensPerSec: 0 }, last: sess.getSpeed().last });
    var turnDiffs: any[] = [];
    var lastSpeedPush = 0;
    // Streaming is batched: rapid deltas would re-render the whole chat (and
    // the diff patches inside it) dozens of times a second, which flickers the
    // whole screen. Text is accumulated and flushed ~10/sec instead.
    var contentAcc = "";
    var reasonAcc = "";
    var flushTimer: any = null;
    // Opencode-style tool activity, interleaved with thinking and text: every
    // event lands as its OWN part in arrival order, so the chat streams as a
    // flow â€” thinking, then the read row, thinking again, the edit row, then
    // the reply â€” never a fixed "thinking on top, tools below" layout. Each
    // tool call keeps its own row ("~ Preparing edit..." while running, then
    // a muted "â†’ Read a.ts" that STAYS in the transcript like opencode).
    // A finished write/edit/bash that actually changed a file attaches its
    // diff to that row's part, so the patch renders inline right where the
    // edit happened, then the message continues normally. Parts are
    // THROTTLED: bursts must not re-render at full rate (that is what made
    // fast output flicker), so the first tool of a burst patches immediately
    // and the rest ride the 100ms stream flush.
    var parts: any[] = [];
    var lastToolPatch = 0;
    // Fresh array of part objects with reasoning durations stamped in (the
    // active reasoning part's duration grows while it streams; once the model
    // moves on its first/last timestamps freeze, so the settled "+ Thought Â· Ns"
    // shows the time it actually spent thinking).
    function snapshotParts() {
      return parts.map(function(p: any) {
        if (p.type === "reasoning") {
          return { ...p, thinkMs: Math.max(0, (p.lastAt || p.firstAt || 0) - (p.firstAt || 0)) };
        }
        return p;
      });
    }
    function ensureTextPart(txt: string) {
      if (!txt) return;
      var hasText = parts.some(function(p: any) { return p.type === "text"; });
      if (!hasText) parts.push({ type: "text", text: String(txt) });
    }
    // Live subagent delegation panel (task tool): streamed deltas, tool calls
    // and status land in the message's `subagent` field while the child runs.
    var subAcc: any = { agent: "", text: "", log: "", status: "" };
    function flushStream() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      // Patch the FULL accumulated state (never reset): the old per-delta
      // replace made the bubble show only the newest chunk and flicker the
      // whole screen while writing.
      if (contentAcc) patchLastMessage({ content: contentAcc });
      if (reasonAcc) patchLastMessage({ thinkingContent: reasonAcc });
      if (parts.length) patchLastMessage({ parts: snapshotParts() });
      if (subAcc.agent) patchMessageAt(idx, { subagent: { agent: subAcc.agent, text: subAcc.text, log: subAcc.log, status: subAcc.status } });
    }
    var speedTimer = setInterval(function() {
      if (thinking()) setSpeedStats({ live: sess.getSpeed().live, last: sess.getSpeed().last });
    }, 1000);
    // Per-turn todo capture: registered BEFORE the turn starts so a fast
    // first todo update is never missed; todo updates land in the message's
    // patch region (alongside file diffs) instead of only the sidebar.
    var offTodos: (() => void) | null = on("todos:changed", function(list: any[]) {
      patchMessageAt(idx, { todos: (Array.isArray(list) ? list : []).map(function(t: any) {
        return { done: t.status === "completed", inProgress: t.status === "in_progress", cancelled: t.status === "cancelled", text: String(t.content || "") };
      }) });
    });
    var sendOpts: any = agentId ? { agentId: agentId } : undefined;
    try {
    sess.sendUserMessage(raw, {
      onDelta: function(txt) {
        contentAcc += txt;
        // Text streams where it arrived: merge into the running text part, or
        // start a new one below the tools/reasoning that came before it.
        var last = parts[parts.length - 1];
        if (last && last.type === "text") last.text += txt;
        else parts.push({ type: "text", text: String(txt) });
        if (!flushTimer) flushTimer = setTimeout(flushStream, 100);
        // Throttle sidebar speed updates to ~2/sec so fast streams don't spam renders.
        var now = Date.now();
        if (now - lastSpeedPush > 500) {
          lastSpeedPush = now;
          setSpeedStats({ live: sess.getSpeed().live, last: sess.getSpeed().last });
        }
      },
      onReasoning: function(txt) {
        reasonAcc += txt;
        // Merge into the live reasoning part (the model streams one thinking
        // block at a time); a tool/text part in between starts a NEW reasoning
        // part below it â€” opencode interleaves thinking with the tool rows.
        var last = parts[parts.length - 1];
        if (last && last.type === "reasoning") {
          last.text += txt;
          last.lastAt = Date.now();
        } else {
          var now = Date.now();
          parts.push({ type: "reasoning", text: String(txt), firstAt: now, lastAt: now });
        }
        if (!flushTimer) flushTimer = setTimeout(flushStream, 100);
      },
      onSubagent: function(ev: any) {
        if (!ev) return;
        // Mirror the streamed event into the global subagent tracker so the
        // /subagents panel can show live status alongside the per-message block.
        // Tracker writes are guarded by try/catch so a tracker bug never
        // breaks streaming.
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
        else if (ev.type === "tool") subAcc.log += (subAcc.log ? " \u00B7 " : "") + String(ev.text || "");
        else if (ev.type === "status") subAcc.status = String(ev.text || "");
        if (!flushTimer) flushTimer = setTimeout(flushStream, 100);
      },
      onAutoCompact: function(res) {
        if (res?.compacted) {
          appendMessage({ role: "system", content: "Auto-compacted: " + res.method + " \u2014 summarized/truncated " + res.removed + " earlier messages. Context was near the model limit." });
        }
      },
      onTool: function(name, inp, callId) {
        var pn = prettyToolName(name);
        var dsp = toolDisplay(pn);
        parts.push({ type: "tool", tool: { name: pn, icon: dsp.icon, pending: dsp.pending, label: dsp.label(inp || {}), status: "running", callId: callId || undefined } });
        // First tool of a burst shows immediately; follow-ups ride the
        // 100ms stream flush so a rapid tool sequence does not re-render
        // the bubble (and the whole chat) dozens of times a second.
        if (Date.now() - lastToolPatch > 150) {
          lastToolPatch = Date.now();
          flushStream();
        } else if (!flushTimer) {
          flushTimer = setTimeout(flushStream, 100);
        }
        // Diff capture is per-tool display data too ("file" snapshots the
        // path, "bash" diffs the tree) â€” no names in the loop.
        if (dsp.diffs === "file") {
          var fp = inp?.filePath;
          if (fp) { snapshotBefore(fp); }
        }
        if (dsp.diffs === "bash") snapshotBashBefore();
      },
      onPermissionRequest: function(name, command, label, options) {
        // The permission popup rises from the input bar; the turn stays paused
        // until the user picks Allow / Always allow / Deny â€” or, for the ask
        // tool, one of the question options / a typed answer.
        return requestPermission(
          String(name),
          String(command || ""),
          String(label || ""),
          name === "ask",
          Array.isArray(options) ? options.map(String) : undefined
        );
      },
      onToolOutput: function(tc, chunk, kind) {
        // Live terminal output (bash): append to the matching RUNNING tool
        // part so the chat streams a growing output block. The callId keeps
        // parallel commands on their own rows.
        var cid = tc && tc.id;
        for (var pi = parts.length - 1; pi >= 0; pi--) {
          var pt = parts[pi];
          if (pt.type !== "tool" || pt.tool.status !== "running") continue;
          if (cid) {
            if (pt.tool.callId && pt.tool.callId === cid) break;
            continue;
          }
          if (!pt.tool.callId) break;
        }
        if (pi >= 0 && parts[pi].type === "tool") {
          var buf = (parts[pi].tool.liveOutput || "") + String(chunk || "");
          if (buf.length > 6000) buf = "\u2026 (stream truncated)\n" + buf.slice(-6000);
          parts[pi].tool.liveOutput = buf;
        }
        if (!flushTimer) flushTimer = setTimeout(flushStream, 100);
      },
      onToolResult: function(name, out, inp, callId) {
        // Mark the LAST running tool part for this tool as done (LIFO â€” a
        // burst of the same tool resolves in order; callId pins the exact row).
        var pn = prettyToolName(name);
        var doneIdx = -1;
        for (var pi = parts.length - 1; pi >= 0; pi--) {
          var pt = parts[pi];
          if (pt.type === "tool" && pt.tool.name === pn && pt.tool.status === "running") {
            if (callId && pt.tool.callId && pt.tool.callId !== callId) continue;
            pt.tool.status = out?.error ? "error" : "done";
            delete pt.tool.liveOutput;
            doneIdx = pi;
            break;
          }
        }
        // Keep the tool's RESULT on its part (stripped, capped) so the chat can
        // render an output block â€” opencode shows bash/generic tool output in
        // the transcript; the agent's work product belongs in the chat, not
        // only the log.
        if (doneIdx >= 0 && !out?.error && typeof out?.result === "string") {
          var resTxt = stripAnsi(out.result).trim();
          if (resTxt.length > 4000) resTxt = resTxt.slice(0, 4000) + "\n\u2026 (truncated)";
          if (resTxt) parts[doneIdx].tool.output = resTxt;
        }
        flushStream();
        var diffs2: any[] = [];
        var fp = inp?.filePath;
        var dsp = toolDisplay(pn);
        if (dsp.diffs === "file" && fp && !out?.error) {
          try {
            var d = snapshotAfter(fp);
            // New files get no diff â€” there is nothing to change yet; only
            // edits of existing files show a patch.
            if (d.added || d.removed) diffs2.push(d);
          } catch {}
        }
        if (dsp.diffs === "bash" && !out?.error) {
          try { diffs2 = diffs2.concat(diffBashAfter().filter(function(d2: any) { return !d2.isNew; })); } catch {}
        }
        if (diffs2.length) {
          // Attach the diff to the part that produced it (opencode renders the
          // patch INLINE in the Edit part, right where the edit happened) and
          // keep the message-level copy for restored sessions.
          if (doneIdx >= 0) parts[doneIdx].tool.fileDiffs = diffs2.slice();
          var merged = turnDiffs.filter(function(x) { return !diffs2.some(function(y) { return y.abs === x.abs; }); }).concat(diffs2);
          turnDiffs = merged;
          // Patch only when the list actually changed, or every tool result
          // forces a full re-render of the message mid-stream.
          var cur = messages()[idx]?.fileDiffs || [];
          if (cur.length !== merged.length || cur.some(function(x: any, i: number) { return x.abs !== merged[i].abs; })) {
            patchMessageAt(idx, { fileDiffs: merged });
          }
        }
      },
      onModelSwitch: function(info) {
        appendMessage({ role: "system", content: "Model \u2014 tokens finished on " + info.from + ", auto-switched to " + info.to + " and retrying." });
        refreshProviderState();
      },
    }, sendOpts).then(function(resp) {
      // Providers that answer without streaming text (no onDelta ever fired)
      // still land their reply as the final text part.
      ensureTextPart(resp.content);
      flushStream();
      var isErr = resp.type === "error";
      if (resp.interrupted) {
        // Keep the partial text in the bubble; the session already stored it,
        // so the user can type "continue" to resume the task.
        patchMessageAt(idx, { thinking: false, interrupted: true, thinkTime: Date.now() - t0, isError: false });
        appendMessage({ role: "system", content: "Interrupted \u2014 partial response kept. Type \"continue\" to resume the task." });
      } else {
        patchMessageAt(idx, { content: resp.content || "(no response)", thinking: false, thinkTime: Date.now() - t0, isError: isErr });
      }
      if (!isErr && sess.mode === "plan") {
        appendMessage({ role: "system", content: "Plan complete \u2014 press Tab to switch to Build, then send \"go\" to execute." });
      }
      setSpeedStats({ live: null, last: sess.getSpeed().last });
    }).catch(function(e) {
      ensureTextPart("Error: " + String(e?.message || e).slice(0, 500));
      flushStream();
      var err = e || {};
      patchMessageAt(idx, { content: "Error: " + String(err.message || err).slice(0, 500), thinking: false, isError: true, thinkTime: Date.now() - t0 });
    }).finally(function() {
      clearInterval(speedTimer);
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (offTodos) { offTodos(); offTodos = null; }
      // Freeze the subagent panel at its final state ("finished").
      if (subAcc.agent) patchMessageAt(idx, { subagent: { agent: subAcc.agent, text: subAcc.text, log: subAcc.log, status: subAcc.status, done: true } });
      setThinking(false); setThinkStart(null); recomputeTodos(); refreshUsage();
      flushQueueSoon();
    });
    } catch (e: any) {
      // A provider that throws synchronously (bad key, malformed config) must
      // still finish the turn â€” never leave the chat stuck on "Thinking".
      ensureTextPart("Error: " + String(e?.message || e).slice(0, 500));
      flushStream();
      patchMessageAt(idx, { content: "Error: " + String(e?.message || e).slice(0, 500), thinking: false, isError: true, thinkTime: Date.now() - t0 });
      clearInterval(speedTimer);
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (offTodos) { offTodos(); offTodos = null; }
      setThinking(false); setThinkStart(null); recomputeTodos(); refreshUsage();
      flushQueueSoon();
    }
  }

  // Send the next queued draft (deferred so it never runs inside the turn's
  // finally stack); no-op when a new turn already started or nothing queued.
  function flushQueueSoon() {
    setTimeout(function() {
      if (thinking() || permission() || modal()) return;
      const next = dequeueDraft();
      if (next) submit(next);
    }, 60);
  }

  // Save the FULL chat: the core session only tracks {role, content,
  // toolCalls, reasoning} (that list feeds the provider API), while the TUI's
  // display parts â€” thinking text, tool rows, diffs, todos, error flags â€” live
  // in the store's message list. Merge them into the session before persisting
  // so /sessions restores the whole conversation, not just a text dump.
  function syncSessionForSave() {
    var sess = getSession();
    var ui = messages();
    // Pair by TURN INDEX (tail-aligned), never by content: repeated, empty or
    // identical assistant replies would otherwise attach the wrong message's
    // parts/tools/diffs/todos. Walking from the end keeps the pairing aligned
    // when auto-compaction trims the session's head but not the UI's.
    var uiAsst: any[] = [];
    for (var j = 0; j < ui.length; j++) if (ui[j].role === "assistant") uiAsst.push(ui[j]);
    var uiIdx = uiAsst.length - 1;
    var sessMsgs = sess.messages.slice();
    for (var i = sessMsgs.length - 1; i >= 0; i--) {
      var m = sessMsgs[i];
      if (m.role !== "assistant") continue;
      var u = uiAsst[uiIdx];
      uiIdx--;
      if (!u || !(u.parts || u.thinkingContent || u.todos || u.fileDiffs || u.isError || u.interrupted)) continue;
      // Strip ephemeral stream state (live terminal output) â€” the saved chat
      // keeps the final tool output only.
      var cleanParts = Array.isArray(u.parts) ? u.parts.map(function(p: any) {
        if (p.type === "tool" && p.tool && p.tool.liveOutput) {
          var t = Object.assign({}, p.tool);
          delete t.liveOutput;
          return Object.assign({}, p, { tool: t });
        }
        return p;
      }) : u.parts;
      sessMsgs[i] = {
        ...m,
        parts: cleanParts, tools: u.tools, thinkingContent: u.thinkingContent,
        todos: u.todos, fileDiffs: u.fileDiffs, isError: u.isError,
        interrupted: u.interrupted, thinkTime: u.thinkTime,
      };
    }
    sess.messages = sessMsgs;
    return sess;
  }

  // Jump to a saved session: swap its messages into the live conversation
  // (used by /sessions picker and `loom -s <id>` resume on start). The saved
  // file carries the full display chat (parts, thinking, diffs, todos); for
  // older saves that only have toolCalls, rebuild the tool rows from them and
  // attach each saved tool result to its row â€” same look as a live turn.
  function resumeSessionById(id: string) {
    var data = loadSession(id);
    if (!data?.messages?.length) { showToast("Session not found: " + id, "error"); return; }
    // Reuse the resumed id as the live session's id so a later
    // saveSession(syncSessionForSave()) persists under the SAME id.
    getSession().conversationId = id;
    var pendingParts: Record<string, any> = {};
    getSession().messages = data.messages.map(function(m) {
      var clean: any = { role: m.role, content: m.content, toolCalls: m.toolCalls };
      if (m.reasoning) clean.reasoning = m.reasoning;
      return clean;
    });
    setMessages(data.messages.map(function(m) {
      // Tool result rows: attach the saved output to the matching call's row
      // so bash/generic tools render their collapsed block like live turns.
      if (m.role === "tool" && m.toolCallId && pendingParts[m.toolCallId]) {
        pendingParts[m.toolCallId].output = m.content;
        return null;
      }
      var out: any = { role: m.role, content: m.content, toolCalls: m.toolCalls, thinkTime: m.thinkTime };
      if (m.role === "assistant") {
        if (m.reasoning && !m.thinkingContent) out.thinkingContent = m.reasoning;
        if (Array.isArray(m.parts) && m.parts.length) {
          out.parts = m.parts;
        } else {
          var calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
          if (calls.length) {
            out.parts = calls.map(function(c: any) {
              var pn = prettyToolName(c.name);
              var dsp = toolDisplay(pn);
              var tool: any = { name: pn, icon: dsp.icon, pending: dsp.pending, label: dsp.label(c.input || {}), status: "done" };
              if (c.id) pendingParts[c.id] = tool;
              return { type: "tool", tool };
            });
          }
        }
        out.todos = m.todos; out.fileDiffs = m.fileDiffs; out.isError = m.isError; out.interrupted = m.interrupted;
      }
      return out;
    }).filter(function(x) { return x !== null; }));
    appendMessage({ role: "system", content: "Resumed " + id });
    refreshProviderState();
  }

  function processSlash(raw: string) {
    // Quote-aware tokenizer so /mcp add keeps "C:\path with spaces\python.exe"
    // intact (claude-compatible one-liner).
    var parts = plugin.tokenizeCli(raw.slice(1));
    if (!parts.length) return;
    var cmd = parts[0].toLowerCase();
    var args = parts.slice(1).filter(function(a) { return !/^\[.*\]$/.test(a); });
    // Custom commands from .loom/commands/*.md run FIRST: /name args
    // expands the md body ($ARGUMENTS â†’ args) and submits it as a prompt.
    try {
      const { expandCustomCommand } = require("../core/custom-commands.js");
      const expanded = expandCustomCommand(cmd, args.join(" "));
      if (expanded !== null) {
        setInput("");
        setCursor(0);
        submit(expanded);
        return;
      }
    } catch {}
    var sess = getSession();
    var cfg = loadConfig();

    switch (cmd) {
      case "help": showHelpText(); return;
      case "agents": showAgentsText(); return;
      case "subagents": runAction("subagent_list"); return;
      case "context": {
        const msgs = getSession().messages || [];
        const est = (s: any) => Math.ceil(String(s == null ? "" : (typeof s === "object" ? JSON.stringify(s) : s)).length / 4);
        let sys = 0, user = 0, asst = 0, tool = 0;
        try { sys += est(getSession().systemPrompt); } catch {}
        for (const m of msgs) {
          const t = est(m.content) + est(m.toolCalls);
          if (m.role === "user") user += t; else if (m.role === "assistant") asst += t; else if (m.role === "tool") tool += t; else sys += t;
        }
        const total = sys + user + asst + tool;
        appendMessage({ role: "system", content: [
          "=== Context (~tokens, chars/4 estimate) ===",
          "System+memory: " + sys,
          "User messages: " + user,
          "Assistant:     " + asst,
          "Tool results:  " + tool,
          "TOTAL:         " + total + "  (" + msgs.length + " messages)",
          "", "Tip: /compact frees context when this grows large.",
        ].join("\n") });
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
        for (let i = ms2.length - 1; i >= 0; i--) { const m: any = ms2[i]; if (m.role === "assistant" && String(m.content || "").includes("## Plan")) { plan = String(m.content); break; } }
        openModal({
          type: "select", title: "Approve plan & switch to Build?", searchable: false,
          options: [{ label: "Approve \u2014 execute in Build", value: "go" }, { label: "Stay in Plan", value: "stay" }],
          onPick(v: string) {
            closeModal();
            if (v !== "go") return;
            setInputMode("build");
            getSession().setMode("build");
            appendMessage({ role: "system", content: "Plan approved \u2014 switched to Build." });
            submit(plan ? "Execute this plan:\n\n" + plan : "Proceed with the approved plan.");
          },
        });
        return;
      }
      case "tasks": {
        const bt = require("../core/background-tasks.js");
        const rows = bt.listBackgroundTasks();
        appendMessage({ role: "system", content: rows.length
          ? "=== Background tasks ===\n" + rows.map((t: any) => `${t.status === "running" ? "[>]" : t.status === "done" ? "[x]" : "[-]"} ${t.id}  ${t.command.slice(0, 50)}\n    ${t.status}${t.exitCode != null ? " exit=" + t.exitCode : ""} \u00B7 ${(t.output.match(/\n/g) || []).length} lines`).join("\n")
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
          onPick(id: string) { closeModal(); const r = rp.restoreTo(id); showToast(r && r.ok ? "Files rewound to " + id : "Restore failed", r && r.ok ? "ok" : "error"); },
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
          const html = `<!doctype html><meta charset="utf-8"><title>Loom session</title><style>body{background:#191817;color:#e8e2d9;font-family:ui-monospace,monospace;max-width:900px;margin:2rem auto;padding:0 1rem}.m{border-left:3px solid #555;padding:.25rem .75rem;margin:.6rem 0}.m.user{border-color:#d7a35f}.m.assistant{border-color:#7aa2f7}.m.system{color:#9a938a}pre{white-space:pre-wrap;font-family:inherit;margin:.2rem 0}</style><h1>Loom Code session</h1>${body}`;
          const f = pathx.join(dir, (sessionId() || "session") + ".html");
          fsx.writeFileSync(f, html);
          showToast("Shared: " + f, "ok", 6000);
        } catch (e: any) { showToast("Share failed: " + String(e?.message || e), "error"); }
        return;
      }
      case "worktree": {
        const name = String(args[0] || "").replace(/[^\w-]/g, "");
        if (!name) { showToast("Usage: /worktree <name>", "error"); return; }
        const out2 = runShell(`git worktree add ../loom-${name} -b wt/${name}`);
        showToast(out2.toLowerCase().includes("fatal") ? "Worktree failed \u2014 see chat" : "Worktree ../loom-" + name + " ready (branch wt/" + name + ")", out2.toLowerCase().includes("fatal") ? "error" : "ok", 6000);
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
          showToast(ok2 ? "Remembered \u2192 LOOM.md" : "Could not write LOOM.md", ok2 ? "ok" : "error");
        } catch { showToast("Could not write LOOM.md", "error"); }
        return;
      }
      case "vim": {
        const on = toggleVim();
        showToast("Vim mode: " + (on ? "on \u2014 Esc toggles NORMAL" : "off"), "ok");
        return;
      }
      case "build": case "plan": case "chat": {
        var modeInfo: Record<string, string> = {
          build: "Build \u2014 all tools enabled",
          plan: "Plan \u2014 read-only, no file changes",
          chat: "Chat \u2014 conversation only, no tools",
        };
        setInputMode(cmd as any);
        sess.setMode(cmd);
        showToast("Mode: " + modeInfo[cmd] + ". Press Tab to cycle.");
        return;
      }
      case "models": openModelPicker(); return;
      case "connect": {
        var pv = args[0]?.toLowerCase();
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
        }
		else openModelPicker();
        return;
      }
      case "providers": showProvidersText(); return;
      case "status": {
        const { envNamesFor } = require("../providers/index.js");
        var keySet = !!(cfg.apiKeys?.[cfg.provider] || (envNamesFor(cfg.provider) || []).some(n => !!process.env[n]));
        appendMessage({ role: "system", content: "Provider: " + cfg.provider + "\nModel: " + (cfg.model?.[cfg.provider] || "default") + "\nKey: " + (keySet ? "configured" : "NOT SET") });
        return;
      }
      case "memory": {
        appendMessage({ role: "system", content: [
          path.join(process.cwd(), "LOOM.md"),
          path.join(os.homedir(), ".loom", "LOOM.md")
        ].map(function(l) { return (fs.existsSync(l) ? "+" : "-") + " " + l; }).join("\n") });
        appendMessage({ role: "system", content: plugin.editorCmd() });
        return;
      }
      case "graph": {
        openGraphModal();
        return;
      }
      case "permissions": {
        if (args[0] === "auto") {
          const next = !sess.permissions.auto;
          sess.permissions.setAuto(next);
          setSessionAuto(next);
          showToast("Auto-approve permissions: " + (next ? "ON" : "OFF") + (next ? " (asks are auto-approved, denies still block)" : ""), next ? "ok" : "info");
          return;
        }
        var rules = sess.permissions.sessionRules;
        if (args[0] === "reset") {
          for (var rk of Array.from(rules.keys())) sess.permissions.clearRule(rk);
          showToast("Permission rules cleared.", "ok");
          return;
        }
        var lines: string[] = [];
        rules.forEach(function(v: string, k: string) { lines.push("  " + k + "  \u2192  " + v); });
        if (!lines.length) lines.push("  (no saved rules)");
        appendMessage({ role: "system", content: "Saved permission rules (set via \"Always allow\" in the popup):\n" + lines.join("\n") + "\nUse /permissions reset to clear." });
        return;
      }
      case "budget": {
        const { LEVELS, pickModel, describeLevel } = require("../core/model-router.js");
        const { budgetStatus, setMonthlyBudget, setDailyAlert, dayStatus, requestOverride, formatUsd } = require("../core/usage.js");
        const cur = cfg.budgetLevel || "auto";
        const arg = args[0]?.toLowerCase();
        if (arg === "override") {
          requestOverride();
          showToast("Budget override set â€” exactly one paid turn will go through despite the cap.", "ok");
          refreshUsage();
          return;
        }
        if (arg === "daily") {
          // 0 is a valid value (disables the alert) â€” only a missing argument
          // is invalid.
          const num = args[1] === undefined ? NaN : parseFloat(args[1].replace(/^[$]/, ""));
          if (!Number.isNaN(num)) {
            setDailyAlert(num);
            showToast("Daily spend alert: " + formatUsd(num) + " / day (0 disables)", "ok");
            refreshUsage();
            return;
          }
          const day = dayStatus();
          showToast(
            "Daily spend today: " + formatUsd(day.dayCostUsd) + (day.alertUsd > 0 ? " (alert at " + formatUsd(day.alertUsd) + ")" : " (no alert set)") + " â€” set one: /budget daily 3",
            "ok"
          );
          return;
        }
        // /budget <number> â€” set the monthly spend cap (Phase 2 governor).
        // 0 is a valid value (disables enforcement) â€” only a missing argument
        // is invalid.
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
          const dayLine = "Day:      " + formatUsd(day.dayCostUsd) + (day.alertUsd > 0 ? " today (alert at " + formatUsd(day.alertUsd) + ")" : " today") + (day.alert ? "  \u26a0 daily alert reached" : "");
          appendMessage({
            role: "system",
            content:
              "=== Budget ===\n" +
              "Level:    " + cur + (cur === "auto" ? "  (explicit picks, no routing)" : "  (auto-routed per turn)") + "\n" +
              "Would pick: " + picked + (info.freeAvailable ? "" : "  \u2014 no free models reachable") + "\n" +
              "Spend:    " + formatUsd(spend.monthCostUsd) + " of " + formatUsd(spend.budgetUsd) + " this month (" + Math.round(spend.pct) + "%)" + (spend.over ? "  \u26a0 cap reached \u2014 paid turns blocked" : "") + "\n" +
              dayLine + "\n" +
              "Levels:  free (only $0 models)  cheap (free + low-cost)  best (frontier)  auto (default)\n" +
              "Try: /budget free  \u2014 every turn stays free, paid models are blocked.  /budget 50 \u2014 set the monthly cap.  /budget override \u2014 one paid turn past the cap.  /budget daily 3 \u2014 alert when a day spends $3."
          });
          return;
        }
        if (!LEVELS.includes(arg)) { showToast("Budget: free, cheap, best, auto â€” or a dollar cap, e.g. /budget 50", "error"); return; }
        cfg.budgetLevel = arg; saveConfig(cfg); sess.config = cfg; refreshProviderState();
        if (arg === "free") {
          const info = describeLevel("free");
          if (!info.picked) showToast("Budget: free \u2014 but NO free model reachable yet. Run /connect for a free provider.", "error");
          else showToast("Budget: free \u2014 every turn now routes to " + info.picked.provider + " / " + info.picked.model, "ok");
        } else {
          showToast("Budget: " + arg, "ok");
        }
        return;
      }
      case "new": case "clear": {
        // Warn before wiping the session â€” one wrong /clear loses the whole
        // transcript. A compact confirm modal with explicit Keep/Clear options.
        var msgCount = messages().length;
        openModal({
          type: "select", title: "Clear session?",
          searchable: false,
          options: [
            { label: "Keep it", sub: "esc / enter to keep", value: "keep" },
            { label: "Clear session (" + msgCount + " messages)", sub: "irreversible", value: "clear" },
          ],
          onPick: function(val: any) {
            closeModal();
            if (val !== "clear") { showToast("Session kept.", "info"); return; }
            sess.reset(); setMessages([]); showToast("Session cleared.", "ok"); refreshUsage();
          },
        });
        return;
      }
      case "restore": {
        const points = listRestorePoints();
        if (!points.length) {
          showToast("No restore points yet. A point is saved automatically before every prompt.");
          return;
        }
        openModal({
          type: "select",
          title: "Restore Point",
          options: points.map(function(p) {
            const t = new Date(p.at);
            const pad = (n: number) => String(n).padStart(2, "0");
            const when = pad(t.getMonth() + 1) + "-" + pad(t.getDate()) + " " + pad(t.getHours()) + ":" + pad(t.getMinutes());
            const count = Object.keys(p.files).length;
            return { label: (p.label ? p.label : "(no prompt)"), sub: when + " \u2014 " + count + " files", value: p.id };
          }),
          onPick: function(id) {
            const r = restoreTo(id);
            closeModal();
            if (!r.ok) { closeModal(); showToast("Restore failed: " + r.error, "error"); return; }
            var line = "Restored to earlier state: " + r.restored.length + " files written back";
            if (r.deleted.length) line += ", " + r.deleted.length + " files removed";
            if (r.errors.length) line += "\nErrors: " + r.errors.join("; ").slice(0, 300);
            appendMessage({ role: "system", content: line });
            invalidateFilesCache();
            clearFileDiffs();
          },
        });
        return;
      }
      case "usage": {
        refreshUsage();
        const { formatTokens, formatUsd, getUsage } = require("../core/usage.js");
        const u = getUsage();
        const meta = modelMeta();
        const sess2 = getSession();
        const ctx = meta?.context || 200000;
        const ctxPct = ctx ? Math.round((sess2.tokensUsed / ctx) * 100) : 0;
        const budgetPct = u.budgetUsd ? Math.round((u.month.costUsd / u.budgetUsd) * 100) : 0;
        const priceLine = meta ? " ($" + (meta.priceIn || 0) + "/$" + (meta.priceOut || 0) + " per 1M in/out)" : "";
        appendMessage({ role: "system", content:
          "=== Usage ===\n" +
          "Model:    " + providerName() + " / " + modelName() + priceLine + "\n" +
          "Session:  " + formatTokens(sess2.tokensUsed) + " tokens (" + formatTokens(sess2.tokensIn) + " in / " + formatTokens(sess2.tokensOut) + " out)  " + ctxPct + "% of " + formatTokens(ctx) + " context  \u00B7  " + formatUsd(sess2.sessionCost) + "\n" +
          "Lifetime: " + formatTokens(u.totalTokens) + " tokens \u00B7 " + formatUsd(u.totals.costUsd) + "\n" +
          "Month " + u.monthKey + ": " + formatTokens(u.monthTokens) + " tokens \u00B7 " + formatUsd(u.month.costUsd) + "  \u00B7  " + budgetPct + "% of " + formatUsd(u.budgetUsd) + " budget"
        });
        return;
      }
      case "skills": {
        var sub = args[0];
        if (sub === "install") { appendMessage({ role: "system", content: plugin.installSkillCmd(args.slice(1)) }); return; }
        if (sub === "remove") { appendMessage({ role: "system", content: plugin.removeSkillCmd(args.slice(1)) }); return; }
        if (sub === "help") { appendMessage({ role: "system", content: plugin.skillHelp() }); return; }
        // Skill browser popup (same window as the model selector): grouped by
        // source (global ~/.loom, agents ~/.agents, project .loom), Enter
        // toggles on/off, and an "install" row opens the add flow.
        var cfgNow = loadConfig();
        var disabledNow = (cfgNow.skillDisabled || []);
        var list = listSkills();
        if (!list.length) { appendMessage({ role: "system", content: plugin.listSkillsText() }); return; }
        var bySource: Record<string, any[]> = { global: [], agents: [], project: [] };
        for (var sk of list) (bySource[sk.source] = bySource[sk.source] || []).push(sk);
        var skillOptions: any[] = [];
        var sourceTitles: Record<string, string> = { global: "Global (~/.loom/skills)", agents: "Agents (~/.agents/skills)", project: "Project (.loom/skills)" };
        var firstHeader = true;
        for (var srcKey of ["global", "agents", "project"]) {
          if (!bySource[srcKey].length) continue;
          skillOptions.push({ isHeader: true, header: sourceTitles[srcKey] });
          firstHeader = false;
          for (var sk3 of bySource[srcKey]) {
            var off3 = disabledNow.includes(sk3.name);
            skillOptions.push({ label: sk3.name, value: sk3.name,
              sub: "[" + (off3 ? "off" : "on") + "] " + sk3.description.slice(0, 44), tags: [srcKey] });
          }
        }
        skillOptions.push({ label: "+ Install skill", value: "__install__", sub: "from a local folder or git URL (--trust for remote)" });
        openModal({
          type: "select", title: "Skills â€” Enter toggle on/off",
          searchable: true,
          options: skillOptions,
          onPick: function(val: any) {
            if (val === "__install__") {
              closeModal();
              openModal({
                type: "input", title: "Install skill",
                placeholder: "folder path or git URL [--trust]",
                onCancel: function() { setTimeout(function() { processSlash("/skills"); }, 10); },
                onPick: function(target: string) {
                  if (!target.trim()) { closeModal(); return; }
                  var out = plugin.installSkillCmd(target.trim().split(/\s+/));
                  showToast(out.split("\n")[0].slice(0, 90), out.indexOf("blocked") >= 0 || out.indexOf("failed") >= 0 ? "error" : "ok", 6000);
                  appendMessage({ role: "system", content: out });
                  closeModal();
                  setTimeout(function() { processSlash("/skills"); }, 10); // reopen refreshed
                },
              });
              return;
            }
            var cfg2 = loadConfig();
            var d = (cfg2.skillDisabled || []);
            if (d.includes(val)) {
              cfg2.skillDisabled = d.filter(function(n: string) { return n !== val; });
              showToast("skill ON: " + val, "ok");
            } else {
              cfg2.skillDisabled = d.concat([val]);
              showToast("skill OFF: " + val, "ok");
            }
            saveConfig(cfg2);
            sess.config = cfg2;
            closeModal(); setTimeout(function() { processSlash("/skills"); }, 10); // reopen refreshed
          },
        });
        return;
      }
      case "mcp": {
        var sub2 = args[0];
        if (sub2 === "add") { appendMessage({ role: "system", content: plugin.mcpAddCmd(args.slice(1)) }); return; }
        if (sub2 === "remove") { appendMessage({ role: "system", content: plugin.mcpRemoveCmd(args.slice(1)) }); return; }
        if (sub2 === "toggle") { appendMessage({ role: "system", content: plugin.mcpToggleCmd(args.slice(1)) }); return; }
        if (sub2 === "help") { appendMessage({ role: "system", content: plugin.mcpHelp() }); return; }
        // MCP browser popup: list every server (defaults + added), toggle
        // on/off with Enter, add new servers with A.
        openModal({ type: "mcp" });
        return;
      }
      case "connectors": {
        var sub3 = args[0];
        if (sub3 === "add") { appendMessage({ role: "system", content: plugin.mcpAddCmd(args.slice(1)) }); return; }
        if (sub3 === "remove") { appendMessage({ role: "system", content: plugin.mcpRemoveCmd(args.slice(1)) }); return; }
        if (sub3 === "toggle") { appendMessage({ role: "system", content: plugin.mcpToggleCmd(args.slice(1)) }); return; }
        if (sub3 === "help") { appendMessage({ role: "system", content: plugin.mcpHelp() }); return; }
        // Connector browser: hosting/cloud services (Supabase, Railway, Vercel,
        // Netlify, Cloudflare, Next.js). Same server store as /mcp, different
        // preset list behind the "A" add flow.
        openModal({ type: "connectors" });
        return;
      }
      case "sessions": {
        const saved = listSessions();
        if (!saved.length) {
          appendMessage({ role: "system", content: "No saved sessions yet." });
          return;
        }
        openModal({
          type: "select",
          title: "Saved Sessions",
          searchable: true,
          options: saved.map(function(s) {
            const when = (s.updatedAt || s.createdAt || s.mtime || "").replace("T", " ").slice(0, 16);
            return { label: s.id, sub: when + " \u2014 " + s.messageCount + " msgs", value: s.id };
          }),
          onPick: function(id) {
            closeModal();
            resumeSessionById(id);
          },
        });
        return;
      }
      case "settings": openModal({ type: "settings" }); return;
      case "thinking": setShowThinking(function(v) { return !v; }); showToast("Thinking display: " + (showThinking() ? "on" : "off")); return;
      case "details": setShowToolDetails(function(v) { return !v; }); showToast("Tool details: " + (showToolDetails() ? "on" : "off")); return;
      case "theme": {
        // Live preview: moving the selection immediately shows the theme
        // behind the modal; Enter confirms and closes. Esc restores the
        // previous theme without saving it.
        var tOpts = themeOptions().map(function(t) { return { label: t.label, value: t.id, sub: t.desc }; });
        if (args.length) {
          if (setTheme(args[0].toLowerCase())) { showToast("Theme: " + args[0].toLowerCase(), "ok"); }
          else showToast("Unknown theme: " + args[0] + ". Try /theme to pick.", "error");
          return;
        }
        var prevTheme = themeName();
        openModal({
          type: "select", title: "Select Theme",
          options: tOpts,
          searchable: false,
          preview: true,
          onPick(val: any, opt: any) {
            if (setTheme(val)) { closeModal(); showToast("Theme: " + (opt?.label || val), "ok"); }
          },
          onPreview(val: any) { if (val) { try { setTheme(val); } catch {} } },
          onCancel() {
            // Restore the pre-picker theme if the user bailed with Esc.
            if (themeName() !== prevTheme) { try { setTheme(prevTheme); } catch {} }
            closeModal();
          },
        });
        return;
      }
      case "exit": {
        persistUi(); saveSession(syncSessionForSave());
        showToast("Session saved: " + (sess.conversationId || "???") + " \u2014 Goodbye!", "ok");
        setTimeout(function() { quit(); }, 500);
        return;
      }
      default: showToast("Unknown command: /" + cmd + ". Try /help.", "error"); return;
    }
  }
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• Keybind-driven actions â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // The keyboard handler below is a pure dispatcher: it maps the incoming key
  // to a configured action (see keybinds.ts / docs/keybinds.md) and runs it
  // here, where all the app state lives.
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

  // Up/Down resolve by context: suggestion list first, then caret lines in a
  // multi-line draft, then prompt history (readline recall).
  function caretOrHistory(dir: number) {
    const s2 = suggestions();
    if (s2.length) {
      if (dir < 0) setAutoIndex(function(i) { return Math.max(0, i - 1); });
      else setAutoIndex(function(i) { return Math.min(s2.length - 1, i + 1); });
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
    const slash = kbs.slashFor(action);
    if (slash) { processSlash(slash); return; }
    switch (action) {
      case "app_exit": quit(); return;
      case "sidebar_toggle": setSidebarVisible(function(v) { return !v; }); return;
      case "sidebar_cycle_tab": setSidebarTab(function(t) { return (t + 1) % 3; }); return;
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
      case "subagent_list": {
        // Open (or re-open) the /subagents panel. The panel itself handles
        // close on Esc; refreshing history on every open keeps past-session
        // runs visible without requiring a restart.
        loadSubagentHistory({ limit: 200 });
        openModal({ type: "subagents" });
        return;
      }
      case "command_list": {
        if (!modal()) openModal({ type: "palette", onPick: function(cmd) { processSlash(cmd); } });
        return;
      }
      case "session_interrupt": {
        if (thinking()) {
          // Two-press confirm: the 1st ESC arms, the 2nd (within 2.5s) actually
          // interrupts â€” accidental key taps no longer kill a running task.
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
        var text = input().trim();
        if (!text) return;
        var wantsCmd = text.startsWith("/") || text.startsWith("!");
        // "# fact" \u2014 self-edit memory: save to project LOOM.md, send nothing.
        if (text.startsWith("# ") && text.slice(2).trim()) {
          try {
            const memR = require("../core/memory.js");
            const okR = memR.appendMemory(text.slice(2).trim(), "project");
            showToast(okR ? "Remembered \u2192 LOOM.md" : "Could not write LOOM.md", okR ? "ok" : "error");
          } catch { showToast("Could not write LOOM.md", "error"); }
          clearSelection();
          setDraft("");
          setPastedAt(0);
          return;
        }
        // Busy: queue the draft (claude-style) â€” it sends when the turn ends.
        if (thinking() && !wantsCmd) {
          queueDraft(text);
          clearSelection();
          setDraft("");
          setPastedAt(0);
          showToast("Queued \u2014 " + queuedDrafts().length + " waiting", "ok");
          return;
        }
        clearSelection();
        setDraft("");
        setPastedAt(0);
        submit(text);
        return;
      }
      case "input_newline": {
        clearSelection();
        setPastedAt(0);
        const p = Math.min(cursor(), input().length);
        const v = input();
        const n = v.slice(0, p) + "\n" + v.slice(p);
        setDraft(n, p + 1);
        historyReset();
        return;
      }
      case "input_move_left": clearSelection(); setCursor(function(c) { return Math.max(0, c - 1); }); return;
      case "input_move_right": clearSelection(); setCursor(function(c) { return Math.min(input().length, c + 1); }); return;
      case "line_home": clearSelection(); setCursor(0); return;
      case "line_end": clearSelection(); setCursor(input().length); return;
      case "input_backspace": setPastedAt(0); editDelete("backspace"); return;
      case "input_delete": setPastedAt(0); editDelete("delete"); return;
      case "prompt_autocomplete_next": {
        var s = suggestions();
        if (s.length) { setAutoIndex(function(i) { return Math.min(s.length - 1, (i || 0) + 1); }); return; }
        var modes = ["build", "plan", "chat"];
        var mi = modes.indexOf(inputMode());
        var nm = modes[(mi + 1) % 3];
        setInputMode(nm as any);
        getSession().setMode(nm);
        return;
      }
      case "up_context": caretOrHistory(-1); return;
      case "down_context": caretOrHistory(1); return;
      case "input_paste": return; // bracketed paste arrives via usePaste
      default: return;
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• Keyboard handler â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Dispatcher: resolves the key against the configured keybinds (defaults
  // merged with ~/.loom/tui.json) and runs the action. Keys that match no
  // binding fall through to the typing branch at the bottom.
  useKeyboard(function(key) {
    var k = key.name;
    var ks = kbs.keyString(key);
    var ma = modal();

    // Global exit; Ctrl+C copies the chatbox selection first when one exists.
    if (kbs.is("app_exit", ks)) {
      const ss = selStart(), se = selEnd();
      if (!ma && ss >= 0 && se > ss) {
        const selText = input().slice(ss, se);
        clearSelection();
        setCursor(se);
        if (selText) {
          copyText(selText);
          showToast("Copied \"" + selText.slice(0, 24) + (selText.length > 24 ? "\u2026" : "") + "\" to clipboard.", "ok");
        }
        return;
      }
      quit(); return;
    }
    if (kbs.is("sidebar_toggle", ks)) { runAction("sidebar_toggle"); return; }

    // Ctrl+A â€” select the whole draft (readline-style).
    if (kbs.is("input_select_all", ks)) { runAction("input_select_all"); return; }

    // Leader key (default ctrl+x): the next key runs a <leader>X binding.
    if (kbs.tapLeader(ks)) return;
    if (kbs.isLeaderPending()) {
      const la = kbs.leaderMatch(ks);
      if (la) { kbs.cancelLeader(); runAction(la, ks); return; }
      // Any other key while the leader is pending cancels it, then falls
      // through to normal processing (matches classic leader UX).
      kbs.cancelLeader();
    }

    // Permission popup owns all keys while it is open (its own useKeyboard
    // handles up/down/enter/typing/esc) â€” the input bar must not receive them.
    if (permission()) return;

    // Shift+Tab â€” toggle session-wide auto-approval (no per-command asks).
    // Plain Tab still cycles suggestions/modes; shift+tab is unbound, so this
    // never collides with the suggestion picker.
    if (k === "tab" && key.shift && !ma) {
      const next = !autoPerm();
      setSessionAuto(next);
      showToast(next
        ? "Auto-approve ON \u00B7 all commands allowed this session (Shift+Tab to toggle)"
        : "Auto-approve OFF \u00B7 per-command asks are back (Shift+Tab to toggle)",
        next ? "ok" : "info", 4000);
      return;
    }

    // Ctrl+E â€” keyboard expand/collapse for the most recent collapsed user
    // bubble (clicking a bubble toggles it too).
    if (kbs.is("user_expand", ks)) { runAction("user_expand"); return; }

    // Escape cancels a pending leader.
    if (k === "escape" && kbs.isLeaderPending()) { kbs.cancelLeader(); return; }

    // Vim mode (/vim): Esc toggles NORMAL; in NORMAL, single keys edit the
    // draft without inserting. i/a/I/A return to INSERT (default behavior).
    if (vimMode() && !ma && !permission()) {
      if (k === "escape") { setVimNormal(function(v) { return !v; }); return; }
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
        return; // swallow everything else while NORMAL
      }
    }

    // Interrupt / draft-clear / modal cancel (default: ESC). A modal_cancel
    // key without an open modal behaves like an interrupt (legacy ESC UX).
    if (kbs.is("session_interrupt", ks) || kbs.is("modal_cancel", ks)) { runAction("session_interrupt", ks); return; }

    // Ctrl+P palette
    if (kbs.is("command_list", ks)) { runAction("command_list"); return; }

    // Modal active => halt
    if (ma) return;

    // Sidebar tab
    if (kbs.is("sidebar_cycle_tab", ks)) { runAction("sidebar_cycle_tab"); return; }

    // Tab â€” next suggestion, or cycle build/plan/chat when the list is empty.
    if (kbs.is("prompt_autocomplete_next", ks)) { runAction("prompt_autocomplete_next"); return; }

    // Suggest nav / caret lines / history recall.
    if (kbs.is("up_context", ks)) { runAction("up_context"); return; }
    if (kbs.is("down_context", ks)) { runAction("down_context"); return; }

    // Cursor movement: left/right always; up/down surf lines when the draft
    // is multi-line (otherwise they recall prompt history). Moving the caret
    // drops the selection (readline behavior).
    if (kbs.is("input_move_left", ks)) { runAction("input_move_left"); return; }
    if (kbs.is("input_move_right", ks)) { runAction("input_move_right"); return; }
    if (kbs.is("line_home", ks)) { runAction("line_home"); return; }
    if (kbs.is("line_end", ks)) { runAction("line_end"); return; }

    // Enter (submit) and Shift+Enter (newline) â€” the chatbox grows with the
    // text (up to its limit) and scrolls beyond it.
    if (kbs.is("input_submit", ks)) { runAction("input_submit"); return; }
    if (kbs.is("input_newline", ks)) { runAction("input_newline"); return; }

    // Backspace / Delete â€” operate at the caret, or drop the whole selection
    // when one is active.
    if (kbs.is("input_backspace", ks)) { runAction("input_backspace"); return; }
    if (kbs.is("input_delete", ks)) { runAction("input_delete"); return; }

    // Typing â€” insert at the caret (or replace the selection). Sequences
    // containing ESC (e.g. arrow keys or \x1b]52; clipboard OSC) must never
    // be treated as text.
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

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• Mouse selection â†’ copy â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  function copyText(text: string) {
    try { process.stdout.write("\x1b]52;c;" + Buffer.from(text, "utf8").toString("base64") + "\x07"); } catch {}
    if (process.platform === "win32" && process.env.LOOM_NO_CLIPBOARD !== "1") {
      try {
        execSync('powershell -NoProfile -NonInteractive -Command "$input | Set-Clipboard"', { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 8000, windowsHide: true });
      } catch {}
    }
  }
  useSelectionHandler(function(sel: any) {
    if (!sel || sel.isDragging || sel.isStart) return;
    const ax = Math.min(Number(sel.anchor.x), Number(sel.focus.x));
    const ay = Math.min(Number(sel.anchor.y), Number(sel.focus.y));
    const bx = Math.max(Number(sel.anchor.x), Number(sel.focus.x));
    const by = Math.max(Number(sel.anchor.y), Number(sel.focus.y));
    if (ax === bx && ay === by) return;
    try {
      const lines = new TextDecoder().decode(renderer.currentRenderBuffer.getRealCharBytes(true)).split("\n");
      const parts: string[] = [];
      for (let y = ay; y <= by; y++) parts.push((lines[y] || "").slice(ax, bx + 1));
      const text = parts.join("\n").replace(/\s+$/g, "").trimEnd();
      if (!text.trim()) return;
      copyText(text);
      showToast("Copied " + text.length + " chars to clipboard.", "ok");
    } catch {}
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• Paste â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  usePaste(event => {
    if (modal()) return;
    // Multi-line paste is kept: the chatbox grows up to its height limit and
    // scrolls beyond it, showing a "~N lines" indicator to save space.
    const txt = new TextDecoder().decode((event as any).bytes || "").replace(/\r\n?/g, "\n");
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

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• Lifecycle â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  let _skillToastOff: (() => void) | null = null;
  let _skillDoneOff: (() => void) | null = null;
  onMount(function() {
    // Keep the renderer's frame pump alive indefinitely.
    // Without a running timeline, the engine drops the live renderer
    // after the first frame, freezing the UI (stdoutBytes flatlines).
    const keepAlive = createTimeline({
      duration: Infinity,
      autoplay: true,
      onUpdate: () => {},
    });
    onCleanup(() => { keepAlive.pause(); engine.unregister(keepAlive); });

    refreshProviderState();
    refreshUsage();
    wireTodoEvents();
    // Hydrate the subagent history from disk so /subagents can show past runs.
    loadSubagentHistory({ limit: 200 });
    registerSuggestionPicker(function(label: string) {
      if (label.startsWith("/")) processSlash(label);
      else if (label.startsWith("!")) { appendMessage({ role: "user", content: label }); appendMessage({ role: "system", content: runShell(label.slice(1)) }); }
      else if (label.startsWith("@")) setDraft(label + " ");
    });
    if (props.resumeSession) {
      resumeSessionById(props.resumeSession);
    }
    if (props.initialPrompt) setTimeout(function() { submit(props.initialPrompt); }, 200);
    // One-time session-start prompt: "Allow all commands in this session?"
    // (Shift+Tab toggles auto-approval any time). Skipped when auto-approval
    // is already on, when a popup/modal is open, and in the test harness
    // (tests drive the popup explicitly via askSessionPermissions()).
    if (!process.env.LOOM_NO_SESSION_PROMPT && !autoPerm() && !permission() && !modal() && !props.resumeSession) {
      setTimeout(function() {
        if (!autoPerm() && !permission() && !modal()) askSessionPermissions();
      }, 500);
    }
    _skillToastOff = on("trigger:skill", function(d: any) {
      const names = (d?.skills || []).join(", ");
      showToast("skill: " + names, "ok", 5000);
      setSkillActive(d?.skills || []);
    });
    _skillDoneOff = on("turn:end", function(d: any) {
      if (d?.skills?.length) showToast("skill handled: " + d.skills.join(", "), "ok");
    });
    (globalThis as any).__loomTrace?.("onMount-done", new Error("mount complete"));
  });
  onCleanup(function() { persistUi(); if (_skillToastOff) _skillToastOff(); if (_skillDoneOff) _skillDoneOff(); });

  var showSplash = createMemo(function() { return messages().length === 0; });

  // opencode hides completed tool parts when "tool details" are off
  // (shouldHide); running rows and errors always stay. Messages drive the
  // chat render, so filtering HERE (a memo over messages() + showToolDetails())
  // is the only path that reliably re-renders the chat on the toggle.
  var chatMessages = createMemo(function() {
    const msgs = messages();
    if (showToolDetails()) return msgs;
    return msgs.map(function(m: any) {
      if (m.role !== "assistant" || (!m.parts && !m.tools)) return m;
      return Object.assign({}, m, {
        parts: (m.parts || []).filter((p: any) => p.type !== "tool" || p.tool.status !== "done"),
        tools: (m.tools || []).filter((t: any) => t.status !== "done"),
      });
    });
  });

  return (
    <box position="absolute" top={0} left={0} right={0} bottom={0} flexDirection="column" backgroundColor={ui.bg}>
      {showSplash() ? (
        <SplashScreen />
      ) : (
        <box flexDirection="column" flexGrow={1}>
          <BreadcrumbBar />
          <box flexDirection="row" flexGrow={1}>
            {/* Chat column: messages + input share one column so the input
                never visually bleeds under the sidebar. */}
            <box flexDirection="column" flexGrow={1}>
              <ChatArea messages={chatMessages} thinking={thinking()} />
              <InputBar />
            {/* Sidebar separated by a breathing gap â€” no shared bottom edge. */}
            </box>
            <Show when={sidebarVisible()}>
              <box width={39} flexShrink={0} marginLeft={1}>
                <Sidebar show={sidebarVisible()} />
              </box>
            </Show>
          </box>
        </box>
      )}

      {(() => {
        // Snapshot the modal object once: closeModal() inside an onCancel / key
        // handler nulls the store mid-render, so reading modal() again in
        // props would throw "null is not an object" on every Escape.
        const m = modal();
        if (!m) return null;
        return (
          <box position="absolute" top={0} left={0} right={0} bottom={0} flexDirection="column" alignItems="center" justifyContent="center" zIndex={99}>
            {m.type === "provider" ? <ProviderPicker /> : null}
            {m.type === "select" ? <SelectModal title={m.title} options={m.options ?? []} onPick={m.onPick} searchable={m.searchable} onCancel={m.onCancel} onPreview={m.onPreview} /> : null}
            {m.type === "input" ? <InputModal title={m.title} placeholder={m.placeholder} onPick={m.onPick} isKey={m.isKey} value={m.value} caretStart={m.caretStart} onCancel={m.onCancel} /> : null}
            {m.type === "settings" ? <SettingsModal /> : null}
            {m.type === "palette" ? <PaletteModal onPick={m.onPick} /> : null}
            {m.type === "mcp" ? <McpModal /> : null}
            {m.type === "connectors" ? <ConnectorsModal /> : null}
            {m.type === "graph" ? <GraphModal graph={m.graph} err={m.graphError} /> : null}
            {m.type === "subagents" ? <SubagentPanel /> : null}
            {m.type === "subagent_detail" ? <SubagentDetailPanel /> : null}
         </box>
        );
      })()}

      <ToastOverlay />
    </box>
  );
}