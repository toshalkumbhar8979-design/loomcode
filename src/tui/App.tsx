// Loom Code - OpenTUI app root component.
// useKeyboard handles ALL text input char-by-char.
import { onMount, onCleanup, createMemo } from "solid-js";
import { useKeyboard, usePaste, useRenderer, useSelectionHandler } from "@opentui/solid";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";
import { palette, setTheme, themeOptions, themeName, LOOM_LOGO } from "./theme.ts";
import {
  messages, setMessages, input, setInput, cursor, setCursor, setDraft,
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
  inputMode, setInputMode,
  SLASH_LIST, LEADER_CMDS, fuzzyFiles,
  leaderPending, setLeaderPending, Suggestion,
  notifyPet, registerSuggestionPicker, pickSuggestion,
  recordPrompt, historyPrev, historyNext, historyReset,
  speedStats, setSpeedStats,
  permission, requestPermission,
  userExpandedIdx, setUserExpandedIdx,
  showToast,
  wireTodoEvents,
} from "./store.ts";
import { BreadcrumbBar } from "./components/BreadcrumbBar.tsx";
import { SplashScreen } from "./components/SplashScreen.tsx";
import { ChatArea, estVisualLines, USER_PREVIEW_LINES } from "./components/ChatArea.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { InputBar } from "./components/InputBar.tsx";
import { ToastOverlay } from "./components/ToastOverlay.tsx";
import { PermissionPopup } from "./components/PermissionPopup.tsx";
import { formatToolLogLine } from "./toolname.ts";
import {
  ProviderPicker, SelectModal, InputModal, SettingsModal, CompanionModal,
  PaletteModal, McpModal, ConnectorsModal, AddServerModal,
  openModelPicker, openKeyModal, openBaseUrlEditor,
  openCompanionPicker, showProvidersText, showHelpText, showAgentsText,
} from "./components/Modals.tsx";
import { saveSession, loadSession } from "../core/session-store.js";
import { MEMORY_TEMPLATE } from "../core/session.js";
import { loadConfig, saveConfig, getBaseUrl } from "../config/settings.js";
import { loadAgents, resolveAgent } from "../core/agents.js";
import { snapshotBefore, snapshotAfter, snapshotBashBefore, diffBashAfter, clearFileDiffs } from "../core/file-diffs.js";
import { createRestorePoint, listRestorePoints, restoreTo } from "../core/restore.js";
import { PROVIDERS, PROVIDER_ORDER, PROVIDER_LABELS } from "../providers/index.js";
import * as plugin from "../core/plugin-cmd.js";
import { openPetsConnect } from "./companion/openpets.ts";
import { on } from "../core/events.js";
import { listSkills } from "../skills/skills-manager.js";

const ui = palette("loom");

export function App(props: { initialPrompt?: string; resumeSession?: string }) {
  const renderer = useRenderer();

  let leaderTimer: any = null;
  let redoStack: any[][] = [];

  function quit(code: number = 0) {
    persistUi();
    if (leaderTimer) { clearTimeout(leaderTimer); leaderTimer = null; }
    let sessionId = "";
    try { sessionId = saveSession(getSession()).id; } catch {}
    try { renderer.destroy(); } catch {}
    setTimeout(function() {
      console.log("");
      console.log(LOOM_LOGO.join("\n"));
      console.log("   resume: loomcode -s " + sessionId);
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
    if (!text) { setSuggestions([]); setAutoKind("none"); return; }
    if (text.startsWith("/")) {
      var q = text.slice(1).toLowerCase();
      var hits = SLASH_LIST.filter(function(c) { return c.cmd.startsWith(q); }).map(function(c) { return { label: "/" + c.cmd, desc: c.desc + (c.args ? " \u2014 " + c.args : "") }; } as Suggestion);
      setSuggestions(hits); setAutoKind("slash"); setAutoIndex(0);
    } else if (text.startsWith("@") && !/\s/.test(text.slice(text.lastIndexOf("@") + 1))) {
      // Only when the trailing token after the last @ is unspaced ("@ex…"):
      // a completed "@agent query" must not re-open the picker.
      var m = text.match(/@([\w\.\-\/\\]*)$/);
      var q = (m ? m[1] : "").toLowerCase();
      // Subagents first (the main agent delegates to them automatically), then
      // files, so "@ex…" suggests @explore before paths.
      var agentHits = Object.values(loadAgents()).filter(function(a: any) {
        return a.mode === "subagent" && (a.id.startsWith(q) || a.name.toLowerCase().startsWith(q));
      }).map(function(a: any) { return { label: "@" + a.id, desc: a.description } as Suggestion; });
      var fileHits = fuzzyFiles(m ? m[1] : "").slice(0, Math.max(1, 10 - agentHits.length)).map(function(f) { return { label: "@" + f } as Suggestion; });
      setSuggestions(agentHits.concat(fileHits)); setAutoKind("at"); setAutoIndex(0);
    } else if (text.startsWith("@")) {
      setSuggestions([]); setAutoKind("none"); setAutoIndex(0);
    } else if (text.startsWith("!")) {
      setSuggestions([{ label: "!ls -la" }, { label: "!git status" }, { label: "!git diff" }, { label: "!pwd" } as Suggestion[]]); setAutoKind("shell"); setAutoIndex(0);
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

    // "@agent …" delegates the whole turn to that subagent (same as the model
    // calling the task tool — but explicit). "@file …" still inlines the file.
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
      // Keep the text in the input bar — hint shown in the footer while held.
      return;
    }
    recordPrompt(raw);
    setDraft("");
    runPrompt(userText != null ? userText : raw, false, agentId, userText);
  }

  function runPrompt(raw: string, shown: boolean, agentId?: string | null, userText?: string) {
    notifyPet({ mood: "working" });
    if (!shown) appendMessage({ role: "user", content: raw });
    // Snapshot the project in the background so /restore always works, without
    // stalling the first API call.
    setTimeout(function() { try { createRestorePoint(raw); } catch {} }, 0);
    setThinking(true); setThinkStart(Date.now());
    var idx = messages().length;
    appendMessage({ role: "assistant", content: "", thinking: true, agentLabel: agentId || undefined });
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
    // Live subagent delegation panel (task tool): streamed deltas, tool calls
    // and status land in the message's `subagent` field while the child runs.
    var subAcc: any = { agent: "", text: "", log: "", status: "" };
    function flushStream() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      // Patch the FULL accumulated text (never reset): the old per-delta
      // replace made the bubble show only the newest chunk and flicker the
      // whole screen while writing.
      if (contentAcc) patchLastMessage({ content: contentAcc });
      if (reasonAcc) patchLastMessage({ thinkingContent: reasonAcc });
      if (subAcc.agent) patchMessageAt(idx, { subagent: { agent: subAcc.agent, text: subAcc.text, log: subAcc.log, status: subAcc.status } });
    }
    var speedTimer = setInterval(function() {
      if (thinking()) setSpeedStats({ live: sess.getSpeed().live, last: sess.getSpeed().last });
    }, 1000);
    var sendOpts: any = agentId ? { agentId: agentId } : undefined;
    sess.sendUserMessage(raw, {
      onDelta: function(txt) {
        contentAcc += txt;
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
        if (!flushTimer) flushTimer = setTimeout(flushStream, 100);
      },
      onSubagent: function(ev: any) {
        if (!ev) return;
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
      onTool: function(name, inp) {
        flushStream();
        patchLastMessage({ toolLog: formatToolLogLine(name, inp) });
        notifyPet({ mood: "working" });
        if (name === "write" || name === "edit") {
          var fp = inp?.filePath;
          if (fp) { snapshotBefore(fp); }
        }
        if (name === "bash") snapshotBashBefore();
      },
      onPermissionRequest: function(name, command, label) {
        // The permission popup rises from the input bar; the turn stays paused
        // until the user picks Allow / Always allow / Deny / typed answer.
        return requestPermission(String(name), String(command || ""), String(label || ""));
      },
      onToolResult: function(name, out, inp) {
        flushStream();
        patchLastMessage({ toolResult: "-> " + String(out?.result || out?.error || "").slice(0, 200) });
        var diffs2: any[] = [];
        var fp = inp?.filePath;
        if ((name === "write" || name === "edit") && fp && !out?.error) {
          try {
            var d = snapshotAfter(fp);
            // New files get no diff — there is nothing to change yet; only
            // edits of existing files show a patch.
            if (d.added || d.removed) diffs2.push(d);
          } catch {}
        }
        if (name === "bash" && !out?.error) {
          try { diffs2 = diffs2.concat(diffBashAfter().filter(function(d2: any) { return !d2.isNew; })); } catch {}
        }
        if (diffs2.length) {
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
      notifyPet({ mood: isErr ? "error" : "success", until: 2500 });
      setSpeedStats({ live: null, last: sess.getSpeed().last });
    }).catch(function(e) {
      flushStream();
      var err = e || {};
      patchMessageAt(idx, { content: "Error: " + String(err.message || err).slice(0, 500), thinking: false, isError: true, thinkTime: Date.now() - t0 });
      notifyPet({ mood: "error" });
    }).finally(function() {
      clearInterval(speedTimer);
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (offTodos) { offTodos(); offTodos = null; }
      // Freeze the subagent panel at its final state ("finished").
      if (subAcc.agent) patchMessageAt(idx, { subagent: { agent: subAcc.agent, text: subAcc.text, log: subAcc.log, status: subAcc.status, done: true } });
      setThinking(false); setThinkStart(null); recomputeTodos(); refreshUsage();
      setTimeout(function() { notifyPet({ mood: "idle" }); }, 3000);
    });
    // Per-turn todo capture: todo updates land in the message's patch region
    // (alongside file diffs) instead of only the sidebar.
    var offTodos: (() => void) | null = on("todos:changed", function(list: any[]) {
      patchMessageAt(idx, { todos: (Array.isArray(list) ? list : []).map(function(t: any) {
        return { done: t.status === "completed", inProgress: t.status === "in_progress", cancelled: t.status === "cancelled", text: String(t.content || "") };
      }) });
    });
  }

  function processSlash(raw: string) {
    var parts = raw.slice(1).split(/\s+/);
    var cmd = parts[0].toLowerCase();
    var args = parts.slice(1).filter(function(a) { return !/^\[.*\]$/.test(a); });
    var sess = getSession();
    var cfg = loadConfig();

    switch (cmd) {
      case "help": showHelpText(); return;
      case "agents": showAgentsText(); return;
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
      case "share": {
        try {
          var id = sess.conversationId || "session-" + Date.now();
          var p = path.join(os.homedir(), ".loom", "sessions", "share-" + id + ".json");
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, JSON.stringify({ conversationId: id, messages: sess.messages }, null, 2));
          showToast("Session exported: " + p, "ok");
        } catch (e: any) { showToast("Share failed: " + String(e?.message || e), "error"); }
        return;
      }
      case "redo": {
        const popped = redoStack.pop();
        if (popped?.length) {
          sess.messages.push(...popped);
          setMessages(sess.messages.map(x => ({ role: x.role, content: x.content })));
          showToast("Redone.", "ok");
        } else showToast("Nothing to redo.");
        return;
      }
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
        var keySet = !!(cfg.apiKeys?.[cfg.provider] || process.env[cfg.provider.toUpperCase() + "_API_KEY"]);
        appendMessage({ role: "system", content: "Provider: " + cfg.provider + "\nModel: " + (cfg.model?.[cfg.provider] || "default") + "\nKey: " + (keySet ? "configured" : "NOT SET") });
        return;
      }
      case "init": {
        var p = path.join(process.cwd(), "LOOM.md");
        if (fs.existsSync(p)) showToast("LOOM.md already exists at " + p);
        else { fs.writeFileSync(p, MEMORY_TEMPLATE); showToast("Created " + p, "ok"); }
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
      case "permissions": {
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
          showToast("Budget override set — exactly one paid turn will go through despite the cap.", "ok");
          refreshUsage();
          return;
        }
        if (arg === "daily") {
          // 0 is a valid value (disables the alert) — only a missing argument
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
            "Daily spend today: " + formatUsd(day.dayCostUsd) + (day.alertUsd > 0 ? " (alert at " + formatUsd(day.alertUsd) + ")" : " (no alert set)") + " — set one: /budget daily 3",
            "ok"
          );
          return;
        }
        // /budget <number> — set the monthly spend cap (Phase 2 governor).
        // 0 is a valid value (disables enforcement) — only a missing argument
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
        if (!LEVELS.includes(arg)) { showToast("Budget: free, cheap, best, auto — or a dollar cap, e.g. /budget 50", "error"); return; }
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
        // Warn before wiping the session — one wrong /clear loses the whole
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
      case "compact": {
        sess.compact().then(function(res) {
          if (res.compacted) {
            var line = "Compacted (" + res.method + "): removed " + res.removed + " earlier messages. " +
              (res.method === "summary" ? "Summary kept at top of context." : "Recent context kept verbatim.");
            if (res.tokensBefore && res.tokensAfter) {
              line += " est. " + res.tokensBefore + " \u2192 " + res.tokensAfter + " tokens.";
            }
            setMessages(sess.messages.map(x => ({ role: x.role, content: x.content })));
            appendMessage({ role: "system", content: line });
          } else {
            appendMessage({ role: "system", content: "Nothing to compact \u2014 conversation too short." });
          }
        }).catch(function(e) {
          showToast("Compact failed: " + String(e?.message || e).slice(0, 300), "error");
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
      case "undo": {
        if (sess.messages.length >= 2) {
          const tail = sess.messages.splice(sess.messages.length - 2, 2);
          redoStack.push(tail);
          setMessages(sess.messages.map(x => ({ role: x.role, content: x.content })));
          showToast("Undone. Type /redo to restore.", "ok");
        }
        else showToast("Nothing to undo.");
        return;
      }
      case "reset": sess.reset(); setMessages([]); showToast("Reset.", "ok"); refreshUsage(); return;
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
      case "doctor": {
        appendMessage({ role: "system", content: "=== Diagnose ===\n" + process.version + "\n" + process.cwd() + "\n" + cfg.provider + "\n" + (cfg.model?.[cfg.provider] || "default") }); return;
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
          type: "select", title: "Skills — Enter toggle on/off",
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
      case "diff": appendMessage({ role: "system", content: plugin.diffCmd() }); return;
      case "debug": appendMessage({ role: "system", content: plugin.debugCmd() }); return;
      case "editor": appendMessage({ role: "system", content: plugin.editorCmd() }); return;
      case "export": appendMessage({ role: "system", content: plugin.exportCmd(sess.messages) }); return;
      case "sessions": appendMessage({ role: "system", content: plugin.sessionsCmd() }); return;
      case "fork": appendMessage({ role: "system", content: plugin.forkCmd(sess) }); return;
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
      case "companion": openCompanionPicker(); return;
      case "exit": {
        persistUi(); saveSession(sess);
        showToast("Session saved: " + (sess.conversationId || "???") + " \u2014 Goodbye!", "ok");
        setTimeout(function() { quit(); }, 500);
        return;
      }
      default: showToast("Unknown command: /" + cmd + ". Try /help.", "error"); return;
    }
  }
  // ═══════════════════════ Keyboard handler ═══════════════════════
  useKeyboard(function(key) {
    var k = key.name;
    var ma = modal();

    // Global exit
    if (key.ctrl && k === "c") { quit(); return; }
    if (key.ctrl && k === "b") { setSidebarVisible(function(v) { return !v; }); return; }

    // Leader ctrl+x
    if (key.ctrl && k === "x") {
      setLeaderPending(true);
      if (leaderTimer) clearTimeout(leaderTimer);
      leaderTimer = setTimeout(function() { setLeaderPending(false); }, 3000);
      return;
    }
    if (leaderPending() && !key.ctrl && !key.meta && k && k.length === 1) {
      setLeaderPending(false);
      if (leaderTimer) { clearTimeout(leaderTimer); leaderTimer = null; }
      var mapped = LEADER_CMDS[k];
      if (mapped) processSlash(mapped);
      return;
    }

    // Permission popup owns all keys while it is open (its own useKeyboard
    // handles up/down/enter/typing/esc) — the input bar must not receive them.
    if (permission()) return;

    // Ctrl+E — keyboard expand/collapse for the most recent collapsed user
    // bubble (clicking a bubble toggles it too).
    if (key.ctrl && k === "e") {
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

    // Escape
    if (k === "escape") {
      if (leaderPending()) { setLeaderPending(false); return; }
      if (thinking()) { try { getSession().interrupt(); } catch {} setThinking(false); return; }
      if (ma) {
        // Honor the modal's own cancel hook (e.g. multi-step add flows return
        // to the browser that launched them) — App runs before the modal's
        // handler, so the modal must not rely on receiving the key itself.
        closeModal();
        if (ma.onCancel) ma.onCancel();
        return;
      }
      setDraft(""); setSuggestions([]); setAutoKind("none"); setAutoIndex(0); historyReset();
      return;
    }

    // Ctrl+P palette
    if (key.ctrl && k === "p") {
      if (!ma) openModal({ type: "palette", onPick: function(cmd) { processSlash(cmd); } });
      return;
    }

    // Modal active => halt
    if (ma) return;

    // Sidebar tab
    if (key.ctrl && k === "i") { setSidebarTab(function(t) { return (t + 1) % 3; }); return; }

    // Tab
    if (k === "tab") {
      var s = suggestions();
      if (s.length) { setAutoIndex(function(i) { return Math.min(s.length - 1, (i || 0) + 1); }); return; }
      var modes = ["build", "plan", "chat"];
      var mi = modes.indexOf(inputMode());
      var nm = modes[(mi + 1) % 3];
      setInputMode(nm as any);
      getSession().setMode(nm);
      return;
    }

    // Suggest nav
    var s2 = suggestions();
    if (s2.length && (k === "up" || k === "down")) {
      if (k === "up") setAutoIndex(function(i) { return Math.max(0, i - 1); });
      else setAutoIndex(function(i) { return Math.min(s2.length - 1, i + 1); });
      return;
    }

    // Cursor movement: left/right always; up/down surf lines when the draft
    // is multi-line (otherwise they recall prompt history).
    if (k === "left") { setCursor(function(c) { return Math.max(0, c - 1); }); return; }
    if (k === "right") { setCursor(function(c) { return Math.min(input().length, c + 1); }); return; }
    if (k === "home") { setCursor(0); return; }
    if (k === "end") { setCursor(input().length); return; }

    if ((k === "up" || k === "down") && !s2.length) {
      if (input().includes("\n")) {
        // Multi-line draft: move the caret one line, keeping the column.
        const text = input();
        const pos = Math.min(cursor(), text.length);
        const upto = text.slice(0, pos);
        const lineIdx = (upto.match(/\n/g) || []).length;
        const col = pos - (upto.lastIndexOf("\n") + 1);
        const rows = text.split("\n");
        const target = Math.max(0, Math.min(rows.length - 1, lineIdx + (k === "up" ? -1 : 1)));
        let tp = 0;
        for (let li = 0; li < target; li++) tp += rows[li].length + 1;
        setCursor(tp + Math.min(col, rows[target].length));
        return;
      }
      const recall = k === "up" ? historyPrev() : historyNext();
      if (recall !== null) setDraft(recall);
      return;
    }

    // Enter
    if (k === "return") {
      if (pickSuggestion()) return;
      // Shift+Enter inserts a newline instead of submitting — the chatbox
      // grows with the text (up to its limit) and scrolls beyond it.
      if (key.shift) {
        const p = Math.min(cursor(), input().length);
        const v = input();
        const n = v.slice(0, p) + "\n" + v.slice(p);
        setDraft(n, p + 1);
        historyReset();
        return;
      }
      var text = input().trim();
      if (!text) return;
      var wantsCmd = text.startsWith("/") || text.startsWith("!");
      // Busy: hold the draft in the input bar — nothing is consumed or sent.
      if (thinking() && !wantsCmd) return;
      setDraft("");
      submit(text);
      return;
    }

    // Backspace / Delete — operate at the caret, not at the end.
    if (k === "backspace" || k === "delete") {
      const p = Math.min(cursor(), input().length);
      const v = input();
      let n: string, np: number;
      if (k === "backspace") { if (p === 0) return; n = v.slice(0, p - 1) + v.slice(p); np = p - 1; }
      else { if (p >= v.length) return; n = v.slice(0, p) + v.slice(p + 1); np = p; }
      setDraft(n, np);
      updateAutocomplete(n);
      historyReset();
      return;
    }

    // Typing — insert at the caret. Sequences containing ESC (e.g. arrow
    // keys or \x1b]52; clipboard OSC) must never be treated as text.
    if (!key.ctrl && !key.meta && key.sequence && key.sequence.indexOf("\x1b") < 0 && key.sequence.length <= 10 && key.sequence !== "\r" && key.sequence !== "\n" && key.sequence !== "\t") {
      const p = Math.min(cursor(), input().length);
      const v = input();
      const n = v.slice(0, p) + key.sequence + v.slice(p);
      setDraft(n, p + key.sequence.length);
      updateAutocomplete(n);
      historyReset();
    }
  });

  // ═══════════════════════ Mouse selection → copy ═══════════════════════
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
      try { process.stdout.write("\x1b]52;c;" + Buffer.from(text, "utf8").toString("base64") + "\x07"); } catch {}
      try {
        execSync('powershell -NoProfile -NonInteractive -Command "$input | Set-Clipboard"', { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 8000, windowsHide: true });
      } catch {}
      showToast("Copied " + text.length + " chars to clipboard.", "ok");
    } catch {}
  });

  // ═══════════════════════ Paste ═══════════════════════
  usePaste(event => {
    if (modal()) return;
    // Multi-line paste is kept: the chatbox grows up to its height limit and
    // scrolls beyond it, showing a "~N lines" indicator to save space.
    const txt = new TextDecoder().decode((event as any).bytes || "").replace(/\r\n?/g, "\n");
    if (!txt) return;
    const p = Math.min(cursor(), input().length);
    const v = input();
    const n = v.slice(0, p) + txt + v.slice(p);
    setDraft(n, p + txt.length);
    updateAutocomplete(n);
    historyReset();
  });

  // ═══════════════════════ Lifecycle ═══════════════════════
  let _skillToastOff: (() => void) | null = null;
  let _skillDoneOff: (() => void) | null = null;
  onMount(function() {
    refreshProviderState();
    refreshUsage();
    wireTodoEvents();
    registerSuggestionPicker(function(label: string) {
      if (label.startsWith("/")) processSlash(label);
      else if (label.startsWith("!")) { appendMessage({ role: "user", content: label }); appendMessage({ role: "system", content: runShell(label.slice(1)) }); }
      else if (label.startsWith("@")) setDraft(label + " ");
    });
    if (props.resumeSession) {
      var data = loadSession(props.resumeSession);
      if (data?.messages?.length) {
        getSession().messages = data.messages;
        setMessages(data.messages.map(function(m) { return { role: m.role, content: m.content, toolCalls: m.toolCalls, thinkTime: m.thinkTime }; }));
        appendMessage({ role: "system", content: "Resumed " + props.resumeSession });
        refreshProviderState();
      }
    }
    if (props.initialPrompt) setTimeout(function() { submit(props.initialPrompt); }, 200);
    openPetsConnect();
    _skillToastOff = on("trigger:skill", function(d: any) {
      const names = (d?.skills || []).join(", ");
      showToast("skill: " + names, "ok", 5000);
      setSkillActive(d?.skills || []);
    });
    _skillDoneOff = on("turn:end", function(d: any) {
      if (d?.skills?.length) showToast("skill handled: " + d.skills.join(", "), "ok");
    });
  });
  onCleanup(function() { persistUi(); if (_skillToastOff) _skillToastOff(); if (_skillDoneOff) _skillDoneOff(); });

  var showSplash = createMemo(function() { return messages().length === 0; });

  return (
    <box position="absolute" top={0} left={0} right={0} bottom={0} flexDirection="column" backgroundColor={ui.bg}>
      {showSplash() ? (
        <SplashScreen />
      ) : (
        <box flexDirection="column" flexGrow={1}>
          <BreadcrumbBar />
          <box flexDirection="row" flexGrow={1}>
            <ChatArea messages={messages} thinking={thinking()} />
            <Sidebar show={sidebarVisible()} />
          </box>
          <InputBar />
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
            {m.type === "select" ? <SelectModal title={m.title} options={m.options ?? []} onPick={m.onPick} searchable={m.searchable} onCancel={m.onCancel} /> : null}
            {m.type === "input" ? <InputModal title={m.title} placeholder={m.placeholder} onPick={m.onPick} isKey={m.isKey} onCancel={m.onCancel} /> : null}
            {m.type === "settings" ? <SettingsModal /> : null}
            {m.type === "companion" ? <CompanionModal /> : null}
            {m.type === "palette" ? <PaletteModal onPick={m.onPick} /> : null}
            {m.type === "mcp" ? <McpModal /> : null}
            {m.type === "connectors" ? <ConnectorsModal /> : null}
            {m.type === "addserver" ? <AddServerModal kind={m.kind} backType={m.backType} presetId={m.presetId} onSaved={m.onSaved} /> : null}
          </box>
        );
      })()}

      <ToastOverlay />
    </box>
  );
}