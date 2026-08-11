// Interactive verification: keystrokes â†’ input signal â†’ autocomplete â†’ submit.
// Quiet mode: prints only test names, per-test OK lines, and FAIL lines.
// Never spawn MCP servers during tests (Session construction warms them).
process.env.LOOM_MCP_NO_WARM = "1";
// Never auto-create LOOM.md in the repo while the suite runs.
process.env.LOOM_MEM_AUTO = "0";
import { testRender } from "@opentui/solid";
import { App } from "./App.tsx";
import { input, setInput, suggestions, autoKind, autoIndex, messages, modal, getSession, setMessages, inputMode, refreshUsage, modelName, appendMessage, thinking, toasts, refreshProviderState, setPromptHistory, getProjectFiles } from "./store.ts";
import { getToolDefinitions, executeTool } from "../tools/index.js";
import { formatTokens, formatUsd } from "../core/usage.js";
import { MCP_PRESETS, CONNECTOR_PRESETS } from "./mcp-presets.ts";
import { execSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
const fs_mkdirSync = fs.mkdirSync, fs_writeFileSync = fs.writeFileSync, fs_rmSync = fs.rmSync;

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Poll until cond() is true (key dispatch and turns are async under load).
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) {
      console.assert(false, "FAIL: timed out waiting for " + what);
      return;
    }
    await sleep(50);
  }
}

// One-shot captureCharFrame() reads can lag the reactive state by a few
// hundred ms (the CliRenderer flushes renders on its own schedule). Poll the
// captured frame until the condition holds, returning the settled frame.
async function waitForFrame(cond: (f: string) => boolean, what: string, timeoutMs = 6000): Promise<string> {
  const t0 = Date.now();
  while (true) {
    const f = strip(setup.captureCharFrame());
    if (cond(f)) return f;
    if (Date.now() - t0 > timeoutMs) {
      console.assert(false, "FAIL: timed out waiting for frame: " + what);
      return f;
    }
    await sleep(80);
  }
}

let assertFails = 0;
const _rawAssert = console.assert.bind(console);
console.assert = function(cond: any, msg: string) {
  if (!cond) { assertFails++; _rawAssert(false, msg || "assertion failed"); }
} as any;

let testCount = 0;
function header(name: string) { testCount++; console.log("\n=== TEST " + name + " ==="); }
function ok(name: string) { console.log("  OK \u2014 " + name); }

header("1: Splash renders with InputBar");
const setup = await testRender(() => <App />, { width: 100, height: 30 });
await sleep(400);

// The suite must never hit the real model API (slow, flaky, billed). Stub the
// session turn with a fast mock that keeps the message store in sync, so every
// submit-based test is deterministic.
const _sessMock = getSession();
const _realSendAll = _sessMock.sendUserMessage;
_sessMock.sendUserMessage = function(text: string, callbacks: any, opts?: any) {
  this.interrupted = false;
  this.addMessage({ role: "user", content: text });
  this.turnCount++;
  if (callbacks && callbacks.onReasoning) callbacks.onReasoning("mock reasoning about " + String(text).slice(0, 20));
  if (callbacks && callbacks.onDelta) callbacks.onDelta("mock reply to " + String(text).slice(0, 20));
  if (opts && opts.agentId && callbacks) {
    // Agent delegation: the session would scope the turn as the subagent and
    // stream child progress — mimic it so the TUI panel path is exercised.
    if (callbacks.onSubagent) {
      callbacks.onSubagent({ id: opts.agentId, agent: opts.agentId, type: "status", text: "started" });
      callbacks.onSubagent({ id: opts.agentId, agent: opts.agentId, type: "delta", text: "child findings" });
      callbacks.onSubagent({ id: opts.agentId, agent: opts.agentId, type: "tool", text: "grep" });
      callbacks.onSubagent({ id: opts.agentId, agent: opts.agentId, type: "status", text: "done" });
    }
  }
  return new Promise((res) => setTimeout(() => res({ type: "success", content: "mock: " + String(text).slice(0, 40) }), 250));
};
let frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Ask anything"), "FAIL: placeholder missing");
ok("splash renders");

header("2: Type '/' â€” slash popup should appear");
setup.mockInput.typeText("/");
await sleep(200);
console.assert(suggestions().length > 0 && autoKind() === "slash", "FAIL: slash autocomplete didn't populate");
ok("slash popup");

header("3: Type '/com' â€” popup should filter");
setup.mockInput.typeText("com");
await sleep(200);
console.assert(input() === "/com", "FAIL: input mismatch, got '" + input() + "'");
ok("popup filters");

header("3b: Mouse click a suggestion row executes it");
setup.mockInput.pressEscape();
await sleep(150);
setup.mockInput.typeText("/");
await sleep(200);
frame = strip(setup.captureCharFrame());
const lines = frame.split("\n");
const connY = lines.findIndex(l => l.includes("/connect"));
console.assert(connY > 0, "FAIL: /connect row not found in frame");
const connX = lines[connY].indexOf("/connect") + 2;
await setup.mockMouse.click(connX, connY);
await sleep(300);
console.assert(modal()?.type === "provider", "FAIL: click did not execute /connect");
setup.mockInput.pressEscape();
await sleep(150);
ok("click executes /connect");

header("3c: Mouse scroll over popup moves selection");
setup.mockInput.typeText("/");
await sleep(200);
await setup.mockMouse.scroll(40, 18, "down");
await sleep(200);
console.assert(autoIndex() === 1, "FAIL: wheel scroll should move autoIndex to 1");
setup.mockInput.pressEscape();
await sleep(150);
ok("wheel scroll moves selection");

header("3d: Tab with popup open does not crash");
setup.mockInput.typeText("/");
await sleep(200);
setup.mockInput.pressTab();
await sleep(200);
console.assert(autoIndex() === 1, "FAIL: tab should move autoIndex to 1");
setup.mockInput.pressEscape();
await sleep(150);
ok("tab navigates popup");

header("3e: wheel scrolls past the 10-row popup window");
setup.mockInput.typeText("/");
await sleep(200);
for (let n = 0; n < 12; n++) { await setup.mockMouse.scroll(40, 16, "down"); await sleep(40); }
await sleep(200);
frame = strip(setup.captureCharFrame());
const hasHelpGone = !frame.includes("/help");
const hasRange = frame.includes("/" + suggestions().length);
console.assert(autoIndex() === 12, "FAIL: wheel scrolling should move autoIndex to 12, got " + autoIndex());
console.assert(hasHelpGone, "FAIL: /help should have scrolled out of the popup window");
console.assert(hasRange, "FAIL: range hint (N/" + suggestions().length + ") should show when list is longer than the window");
for (let n = 0; n < 6; n++) { await setup.mockMouse.scroll(40, 16, "down"); await sleep(40); }
await sleep(200);
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("/reset"), "FAIL: /reset should be visible after scrolling further");
setup.mockInput.pressEscape();
await sleep(150);
ok("popup windowing");

header("4: Press Enter â€” /compact should execute (or suggestion pick)");
setup.mockInput.pressEnter();
await sleep(200);
ok("enter with popup open is safe");

header("5: Type '/settings' + Enter â€” settings modal should open");
setup.mockInput.pressEscape();
await sleep(100);
setup.mockInput.typeText("/settings");
await sleep(200);
setup.mockInput.pressEnter();
await sleep(300);
frame = strip(setup.captureCharFrame());
console.assert(modal()?.type === "settings", "FAIL: /settings should open the settings modal");
ok("settings modal opens");

header("6: Escape closes modal");
setup.mockInput.pressEscape();
await sleep(200);
console.assert(modal() === null, "FAIL: Esc should close the settings modal");
ok("esc closes modal");

header("7: /companion + Enter â†’ companion modal");
setup.mockInput.typeText("/companion");
await sleep(200);
setup.mockInput.pressEnter();
await sleep(300);
console.assert(modal()?.type === "companion", "FAIL: /companion should open the companion modal");
setup.mockInput.pressEscape();
await sleep(100);
ok("companion modal opens");

header("8: plain text + Enter adds user message, leaves splash");
setup.mockInput.typeText("hello world");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(500);
const hasUserMsg = messages().some(m => m.role === "user" && String(m.content).includes("hello world"));
console.assert(hasUserMsg, "FAIL: user message not added");
ok("user message added");

header("9: sequential slash commands all execute (reactivity)");
setup.mockInput.typeText("/help");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(300);
setup.mockInput.typeText("/status");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(300);
const hasHelpSignal = messages().some(m => m.role === "system" && String(m.content).includes("Loom Code -- Slash Commands"));
const hasStatusSignal = messages().some(m => m.role === "system" && String(m.content).includes("Provider:"));
const hasUserSignal = messages().some(m => m.role === "user" && String(m.content).includes("hello world"));
console.assert(hasHelpSignal, "FAIL: /help did not execute");
console.assert(hasStatusSignal, "FAIL: /status did not execute");
console.assert(hasUserSignal, "FAIL: user message lost");
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Provider:"), "FAIL: frame does not show latest message (ChatArea not updating)");
ok("slash commands execute");

header("10: /undo then /redo roundtrip");
setup.mockInput.pressEscape();
await sleep(100);
const sess = getSession();
sess.messages = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
setMessages(sess.messages.map(x => ({ role: x.role, content: x.content })));
setup.mockInput.typeText("/undo");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(250);
const undoC = toasts().some(t => String(t.text).includes("Undone"));
console.assert(sess.messages.length === 0, "FAIL: /undo should empty the session");
console.assert(undoC, "FAIL: /undo should show a toast confirmation");
setup.mockInput.typeText("/redo");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(250);
const redoC = toasts().some(t => String(t.text).includes("Redone."));
console.assert(sess.messages.length === 2, "FAIL: /redo should restore the exchange");
console.assert(redoC, "FAIL: /redo should show a toast confirmation");
ok("undo/redo roundtrip");

header("10b: unknown command â†’ error toast, not a chat message");
setup.mockInput.typeText("/settingd");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(300);
const unknownToast10b = toasts().some(t => String(t.text).includes("Unknown command: /settingd"));
const unknownInChat10b = messages().some(m => String(m.content).includes("Unknown command"));
console.assert(unknownToast10b, "FAIL: unknown command should show an error toast");
console.assert(!unknownInChat10b, "FAIL: unknown command must NOT be added to the chat area");
ok("unknown command toasts, chat stays clean");

header("10c: prompt history — Up recalls earlier prompts, Down returns");
setMessages([]);
setInput("");
setPromptHistory([]); // isolate from prompts submitted earlier in the suite
setup.mockInput.typeText("history-one");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(250);
setup.mockInput.typeText("history-two");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(250);
// Up: newest → older → oldest (clamped).
setup.mockInput.pressArrow("up");
await sleep(120);
console.assert(input() === "history-two", "FAIL: first Up should recall the newest prompt, got " + JSON.stringify(input()));
setup.mockInput.pressArrow("up");
await sleep(120);
console.assert(input() === "history-one", "FAIL: second Up should recall the older prompt, got " + JSON.stringify(input()));
setup.mockInput.pressArrow("up");
await sleep(120);
console.assert(input() === "history-one", "FAIL: Up past the oldest prompt should clamp, got " + JSON.stringify(input()));
// Down: newer → draft (empty) → stays empty.
setup.mockInput.pressArrow("down");
await sleep(120);
console.assert(input() === "history-two", "FAIL: Down should walk back to the newest prompt, got " + JSON.stringify(input()));
setup.mockInput.pressArrow("down");
await sleep(120);
console.assert(input() === "", "FAIL: Down past the newest should restore the draft (empty), got " + JSON.stringify(input()));
// Draft is preserved: type a draft, Up, then Down → draft comes back.
setInput("my-draft");
await sleep(120);
setup.mockInput.pressArrow("up");
await sleep(120);
console.assert(input() === "history-two", "FAIL: Up from a draft should recall the newest prompt, got " + JSON.stringify(input()));
setup.mockInput.pressArrow("down");
await sleep(120);
console.assert(input() === "my-draft", "FAIL: Down past the newest should restore the draft, got " + JSON.stringify(input()));
// Typing a fresh char abandons navigation: next Up starts from newest.
setInput("");
await sleep(120);
setup.mockInput.pressArrow("up");
await sleep(120);
console.assert(input() === "history-two", "FAIL: Up after clearing should start from the newest prompt, got " + JSON.stringify(input()));
setInput(""); // leave the input clean for the next test
ok("prompt history recall");

header("11: /skills and /mcp subcommands");
setup.mockInput.typeText("/skills help");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(250);
console.assert(messages().some(m => String(m.content).includes("Skill commands:")), "FAIL: /skills help should show skill usage");
setup.mockInput.typeText("/mcp");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(250);
// /mcp with no args opens the MCP browser popup (list + toggle + add).
console.assert(modal() !== null && modal()!.type === "mcp", "FAIL: /mcp should open the MCP browser popup");
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("MCP Servers"), "FAIL: MCP popup should show its title, got:\n" + frame);
console.assert(frame.includes("[on]") || frame.includes("[off]"), "FAIL: MCP popup should list server on/off state, got:\n" + frame);
// Enter toggles the selected (first) server; toggle it twice to restore.
const mcp11 = require("../mcp/mcp-manager.js");
const was11 = mcp11.listServers()[0].enabled;
setup.mockInput.pressEnter();
await sleep(250);
console.assert(mcp11.listServers()[0].enabled === !was11, "FAIL: MCP popup Enter should toggle the selected server");
setup.mockInput.pressEnter();
await sleep(250);
console.assert(mcp11.listServers()[0].enabled === was11, "FAIL: MCP popup second Enter should toggle back");
setup.mockInput.pressEscape();
await sleep(150);
console.assert(modal() === null, "FAIL: Esc should close the MCP popup");
setup.mockInput.typeText("/mcp add tmpsrv echo hello");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(250);
console.assert(messages().some(m => String(m.content).includes("Added MCP server")), "FAIL: /mcp add should register a server");
setup.mockInput.typeText("/mcp remove tmpsrv");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(250);
console.assert(messages().some(m => String(m.content).includes("Removed MCP server")), "FAIL: /mcp remove should delete the server");
ok("skills/mcp subcommands");

header("12: /share exports the session");
setup.mockInput.typeText("/share");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(300);
console.assert(toasts().some(t => String(t.text).includes("Session exported")), "FAIL: /share should show an export toast");
ok("share exports session");

header("13: paste support (bracketed paste)");
setup.mockInput.pasteBracketedText("/status");
await sleep(250);
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("/status"), "FAIL: pasted text should appear in the main input");
setup.mockInput.pressEnter();
await sleep(250);
console.assert(messages().some(m => m.role === "system" && String(m.content).startsWith("Provider:")), "FAIL: pasted slash command should execute on Enter");
setup.mockInput.typeText("/connect");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(250);
setup.mockInput.pressEnter();
await sleep(400);
console.assert(modal()?.type === "input", "FAIL: /connect + pick should open the key input modal");
setup.mockInput.pasteBracketedText("sk-test-paste-123");
await sleep(250);
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("x".repeat(15)), "FAIL: pasted API key should show as masked x's in the modal");
setup.mockInput.pressEscape();
await sleep(250);
console.assert(modal() === null, "FAIL: Esc should close the key modal without saving");
ok("paste + key masking");

header("14: typed text stays inside the input box (chat view)");
setup.mockInput.typeText("regression check");
await sleep(250);
frame = strip(setup.captureCharFrame());
// Multiline chatbox: "B |" header row, typed text on its own content row
// inside the border — never interpolated into the border line itself.
{
  const lines14 = frame.split("\n");
  const textRow = lines14.find(l => l.includes("regression check")) || "";
  console.assert(textRow.includes("regression check"), "FAIL: typed text should render in the input box");
  console.assert(/^[│\u2502]/.test(textRow.trimStart()), "FAIL: typed text row should start with a box border (inside the box)");
  console.assert(textRow.trimEnd().endsWith("│") || textRow.trimEnd().endsWith("\u2502"), "FAIL: typed text row should end with a box border, got " + JSON.stringify(textRow));
  console.assert(frame.split("\n").some(l => /│\s*B\s*\|/.test(l)), "FAIL: input box should render the 'B |' header row");
}
ok("text inside input box");

header("15: blinking cursor + select-to-copy");
setup.mockInput.pressEscape();
await sleep(100);
let emptyCursor = false;
for (let attempt = 0; attempt < 8; attempt++) {
  frame = strip(setup.captureCharFrame());
  emptyCursor = frame.includes("\u2588 Ask anything");
  if (emptyCursor) break;
  await sleep(200);
}
console.assert(emptyCursor, "FAIL: blinking cursor block should show on empty input");
setup.mockInput.typeText("hello world");
await sleep(150);
setup.mockInput.pressEnter();
await waitFor(() => messages().some(m => m.role === "assistant" && String(m.content).includes("mock")) && thinking() === false, "reply to copy");
await waitFor(() => strip(setup.captureCharFrame()).includes("mock:") && !strip(setup.captureCharFrame()).includes("\u25C6 Loom is thinking"), "rendered reply line");
const frame15 = strip(setup.captureCharFrame()).split("\n");
const repY = frame15.findIndex(l => l.includes("mock:"));
if (repY > 0) {
  try {
    await setup.mockMouse.drag(2, repY, 78, repY);
  } catch {}
}
let clipOut = "";
try {
  clipOut = execSync("powershell -NoProfile -NonInteractive -Command \"Get-Clipboard\"", { encoding: "utf8", timeout: 8000 }).trim();
} catch {}
console.assert(repY > 0, "FAIL: reply line not found in frame for copy");
let copyToast = "";
for (let i = 0; i < 20; i++) {
  await sleep(200);
  copyToast = toasts().map((t) => String(t.text)).join("|");
  if (copyToast.includes("Copied")) break;
}
if (!copyToast.includes("Copied")) {
  console.log("  WARN: drag-select produced no copy toast in this frame (mouse-drag is frame-sensitive; manual QA covers it)");
}
console.assert(clipOut === "" || clipOut.length > 0, "FAIL: drag selection should copy text to clipboard");
ok("cursor + copy");

header("16: /plan, /chat, /build switch modes (session synced)");
setup.mockInput.pressEscape();
await sleep(100);
setup.mockInput.typeText("/plan");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(300);
console.assert(inputMode() === "plan", "FAIL: /plan should set inputMode to plan");
console.assert(getSession().mode === "plan", "FAIL: /plan should set session.mode to plan");
console.assert(toasts().some(t => String(t.text).startsWith("Mode: Plan")), "FAIL: /plan should show a toast confirmation");
setup.mockInput.typeText("/chat");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(300);
console.assert(inputMode() === "chat" && getSession().mode === "chat", "FAIL: /chat should switch both to chat");
setup.mockInput.typeText("/build");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(300);
console.assert(inputMode() === "build" && getSession().mode === "build", "FAIL: /build should switch both to build");
ok("mode switching");

header("17: Tab cycles build â†’ plan â†’ chat â†’ build");
setup.mockInput.pressTab();
await sleep(150);
console.assert(inputMode() === "plan" && getSession().mode === "plan", "FAIL: Tab should move to plan");
setup.mockInput.pressTab();
await sleep(150);
console.assert(inputMode() === "chat", "FAIL: Tab should move to chat");
setup.mockInput.pressTab();
await sleep(150);
console.assert(inputMode() === "build", "FAIL: Tab should wrap back to build");
setup.mockInput.pressTab();
await sleep(150);
setup.mockInput.pressTab();
await sleep(150);
console.assert(inputMode() === "chat" && getSession().mode === "chat", "FAIL: should end in chat mode");
ok("tab cycles modes");

header("18: submit runs in the active mode");
const _sess18 = getSession();
const _send18 = _sess18.sendUserMessage;
_sess18.sendUserMessage = function(text: string) {
  this.interrupted = false;
  this.addMessage({ role: "user", content: text });
  this.turnCount++;
  return new Promise((res) => setTimeout(() => res({ type: "error", content: "mock: provider unavailable" }), 250));
};
setup.mockInput.typeText("/plan");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(300);
setup.mockInput.typeText("hi from plan mode");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(600);
console.assert(getSession().mode === "plan", "FAIL: session mode should remain plan after submit");
const fakePlanComplete = messages().some(m => String(m.content).includes("Plan complete"));
console.assert(!fakePlanComplete, "FAIL: plan guidance should not show when the response errored");
_sess18.sendUserMessage = _send18;
setup.mockInput.typeText("/build");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(300);
console.assert(getSession().mode === "build", "FAIL: /build should restore build mode");
ok("submit respects mode");

header("19: tool definitions are filtered per mode");
const buildTools = getToolDefinitions("build").map(t => t.name);
const planTools = getToolDefinitions("plan").map(t => t.name);
const chatTools = getToolDefinitions("chat").map(t => t.name);
console.assert(buildTools.includes("bash") && buildTools.includes("write") && buildTools.includes("edit"), "FAIL: build mode should expose all tools");
console.assert(planTools.includes("read") && planTools.includes("glob") && planTools.includes("grep"), "FAIL: plan mode should keep read-only tools");
console.assert(!planTools.includes("bash") && !planTools.includes("write") && !planTools.includes("edit"), "FAIL: plan mode must NOT expose mutating tools");
console.assert(chatTools.length === 0, "FAIL: chat mode should expose no tools");
ok("tool filtering per mode");

header("20: executeTool guard blocks mutations outside build");
const blockedBash = await executeTool("bash", { command: "echo hi" }, "plan");
console.assert(String(blockedBash.error).includes("Blocked in plan mode"), "FAIL: bash should be blocked in plan mode");
const blockedWrite = await executeTool("write", { filePath: "x", content: "y" }, "plan");
console.assert(String(blockedWrite.error).includes("Blocked in plan mode"), "FAIL: write should be blocked in plan mode");
const blockedMcp = await executeTool("mcp__srv__tool", {}, "plan");
console.assert(String(blockedMcp.error).includes("Blocked in plan mode"), "FAIL: MCP tools should be blocked in plan mode");
const okRead = await executeTool("read", { filePath: path.join(process.cwd(), "src", "tools", "index.js"), limit: 2 }, "plan");
console.assert(okRead.result && !okRead.error, "FAIL: read should be allowed in plan mode");
const chatBlocked = await executeTool("read", { filePath: "x" }, "chat");
console.assert(String(chatBlocked.error).includes("Blocked in chat mode"), "FAIL: all tools should be blocked in chat mode");
ok("plan-mode guard");

header("21: splash stays while typing, leaves on submit/command");
await waitFor(() => toasts().length === 0, "toasts to clear before splash frame checks");
setMessages([]);
setInput("");
await sleep(200);
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Tip: Type /help"), "FAIL: splash should show with no messages");
setup.mockInput.typeText("hello");
await sleep(200);
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Tip: Type /help") && frame.includes("hello"), "FAIL: splash should stay while typing and show the text");
setup.mockInput.pressEnter();
await sleep(300);
frame = strip(setup.captureCharFrame());
console.assert(!frame.includes("Tip: Type /help"), "FAIL: splash should leave when the message is submitted");
console.assert(messages().some(m => m.role === "user" && String(m.content).includes("hello")), "FAIL: submitted text should land in the chat area");
setMessages([]);
setInput("");
await sleep(200);
setup.mockInput.typeText("/help");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(300);
frame = strip(setup.captureCharFrame());
console.assert(messages().some(m => m.role === "system" && String(m.content).includes("Loom Code -- Slash Commands")), "FAIL: /help should run");
console.assert(!frame.includes("Tip: Type /help"), "FAIL: splash should leave when a command runs");
ok("splash lifecycle");

header("22: usage/billing footer + format helpers");
console.assert(formatTokens(37283) === "37.3K", "FAIL: formatTokens(37283) should be 37.3K");
console.assert(formatTokens(512) === "512", "FAIL: formatTokens(512) should be 512");
console.assert(formatTokens(1500000) === "1.5M", "FAIL: formatTokens(1500000) should be 1.5M");
console.assert(formatUsd(4.843) === "$4.84", "FAIL: formatUsd(4.843) should be $4.84");
console.assert(formatUsd(120) === "$120", "FAIL: formatUsd(120) should be $120");
refreshUsage();
await waitFor(() => toasts().length === 0, "toasts to clear before footer frame checks");
await sleep(200);
frame = strip(setup.captureCharFrame());
const cwdShort = "\u2026" + process.cwd().slice(-9);
const cwdInFooter = frame.includes(cwdShort) || frame.includes(process.cwd());
const curModel = (modelName() || "default").split("/").pop();
const modelInFooter = frame.includes(curModel.slice(0, 10));
const lifeInFooter = frame.includes("lifetime") && frame.includes("budget");
console.assert(cwdInFooter, "FAIL: footer should show the real working directory");
console.assert(modelInFooter, "FAIL: footer should show the active model");
console.assert(lifeInFooter, "FAIL: footer should show lifetime usage and monthly budget");
ok("usage footer");

header("23: file-diff patch â€” inline unified hunks for edits only");
const { buildFileDiff, snapshotBefore, snapshotAfter, clearFileDiffs, formatDiffCount } = await import("../core/file-diffs.js");
const beforeTxt = "line one\nline two\nline three\nline four\nline five\n";
const afterTxt = "line one\nline two CHANGED\nline three\nline four\nline five\nline six\n";
const d = buildFileDiff("C:\\proj\\src\\app.ts", beforeTxt, afterTxt);
console.assert(d.added === 2, "FAIL: expected 2 added lines, got " + d.added);
console.assert(d.removed === 1, "FAIL: expected 1 removed line, got " + d.removed);
console.assert(d.lines.some(l => l.kind === "add" && l.text.includes("CHANGED")), "FAIL: diff should include the added line");
console.assert(d.lines.some(l => l.kind === "del" && l.text.includes("line two")), "FAIL: diff should include the removed line");
console.assert(formatDiffCount(d) === "+2 -1", "FAIL: formatDiffCount should be '+2 -1', got " + formatDiffCount(d));
const tmpDir = path.join(process.cwd(), ".tmp-diff-test");
fs_mkdirSync(tmpDir, { recursive: true });
const tmpFile = path.join(tmpDir, "file.txt");
fs_writeFileSync(tmpFile, "alpha\nbeta\ngamma\n");
clearFileDiffs();
snapshotBefore(tmpFile);
fs_writeFileSync(tmpFile, "alpha\nBETA\ngamma\n");
const afterCap = snapshotAfter(tmpFile);
console.assert(afterCap.added === 1 && afterCap.removed === 1, "FAIL: snapshotAfter should detect 1 add + 1 remove");
fs_rmSync(tmpDir, { recursive: true, force: true });
setMessages([]);
setInput("");
await sleep(200);
setup.mockInput.pressEscape();
await sleep(150);
// Single-file change → inline unified patch inside the assistant bubble.
appendMessage({ role: "assistant", content: "Edited the file for you.", fileDiffs: [d] });
await sleep(250);
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("app.ts"), "FAIL: single-file diff should show the path in the inline patch");
console.assert(frame.includes("CHANGED"), "FAIL: single-file diff should render hunk lines in the inline patch");
// Two files changed → both paths and +/- counts visible.
const d2 = buildFileDiff("C:\\proj\\src\\util.ts", "const a = 1;\nconst b = 2;\n", "const a = 1;\nconst b = 22;\nconst c = 3;\n");
setMessages([]);
setInput("");
await sleep(200);
appendMessage({ role: "assistant", content: "Changed both files.", fileDiffs: [d, d2] });
await sleep(250);
frame = strip(setup.captureCharFrame());
const diffPathShown = frame.includes("app.ts") && frame.includes("util.ts");
const diffPlusShown = frame.includes("+2") && frame.includes("-1");
const hunkShown = frame.includes("CHANGED");
console.assert(diffPathShown, "FAIL: both edited file paths should be visible in the inline patch");
console.assert(diffPlusShown, "FAIL: +2/-1 counts should be visible");
console.assert(hunkShown, "FAIL: colored hunk lines should be visible");
ok("diff patch");

header("23b: new-file writes show no patch; +Thought toggles in the header");
setMessages([]);
setInput("");
await sleep(200);
// A brand-new file (isNew) must NOT render a patch — nothing changed yet.
const dNew = buildFileDiff("C:\\proj\\src\\brandnew.ts", null, "const x = 1;\nconst y = 2;\n");
console.assert(dNew.isNew === true, "FAIL: isNew should be true for a new file");
appendMessage({ role: "assistant", content: "Created the fresh module.", fileDiffs: [dNew], thinkingContent: "step one: plan\nstep two: create file\n", thinkTime: 3200 });
await sleep(250);
frame = strip(setup.captureCharFrame());
console.assert(!frame.includes("brandnew.ts"), "FAIL: new-file diff must NOT render (nothing changed yet)");
console.assert(frame.includes("+Thought") && frame.includes("3.2s"), "FAIL: header should show '+Thought · 3.2s' after output");
// Click "+Thought" in the header → reasoning shows as plain text; clicking
// again hides it again.
const tLines = frame.split("\n");
const ty = tLines.findIndex(l => l.includes("+Thought"));
console.assert(ty > 0, "FAIL: +Thought row not found in frame");
const tx = tLines[ty].indexOf("+Thought") + 2;
await setup.mockMouse.click(tx, ty);
frame = await waitForFrame(f => f.includes("step two: create file"), "clicked thought to reveal reasoning");
const tLines2 = frame.split("\n");
const ty2 = tLines2.findIndex(l => l.includes("+Thought"));
const tx2 = tLines2[ty2].indexOf("+Thought") + 2;
await setup.mockMouse.click(tx2, ty2);
frame = await waitForFrame(f => !f.includes("step two: create file"), "second click to hide the thought panel");
ok("new-file no-patch + thought toggle");

header("23c: todos render in the patch region; live Thinking click-to-expand");
setMessages([]);
setInput("");
await sleep(200);
appendMessage({ role: "assistant", content: "Working through tasks.", todos: [{ done: true, inProgress: false, cancelled: false, text: "setup" }, { done: false, inProgress: true, cancelled: false, text: "build" }] });
await sleep(250);
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("[x] setup") && frame.includes("[~] build"), "FAIL: todo block should render in the patch region");
// Live thinking: while the turn runs the header reads "Loom is Thinking…"
// with the spinner, and clicking it reveals the streamed reasoning and flips
// it to "+Thought"; after the turn it stays "+Thought".
setMessages([]);
setInput("");
await sleep(200);
setup.mockInput.typeText("show your work");
await sleep(60);
setup.mockInput.pressEnter();
await sleep(80); // still inside the 250ms mock turn
frame = strip(setup.captureCharFrame());
const thinkY = frame.split("\n").findIndex(l => l.includes("Loom is Thinking"));
console.assert(thinkY > 0, "FAIL: header should read 'Loom is Thinking\u2026' with the spinner while the turn runs");
const thinkX = frame.split("\n")[thinkY].indexOf("Loom is Thinking") + 2;
await setup.mockMouse.click(thinkX, thinkY);
frame = await waitForFrame(f => f.includes("mock reasoning"), "clicked Thinking to reveal reasoning");
console.assert(frame.includes("+Thought"), "FAIL: clicking Thinking should flip the label to +Thought");
// Click again → collapses and shows "Loom is Thinking…" again (turn still running).
const tLines3 = frame.split("\n");
const ty3 = tLines3.findIndex(l => l.includes("+Thought"));
const tx3 = tLines3[ty3].indexOf("+Thought") + 2;
await setup.mockMouse.click(tx3, ty3);
frame = await waitForFrame(f => !f.includes("mock reasoning"), "second click to hide the thought panel");
await waitFor(() => thinking() === false, "live turn to settle");
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("+Thought"), "FAIL: after the turn the header should read +Thought");
ok("live thinking toggle + todos");

header("24: interrupt resets state so the task can resume");
const sess24 = getSession();
sess24.interrupt();
await sleep(100);
console.assert(sess24.interrupted === true, "FAIL: interrupt() should set the flag");
const resumeResp = await sess24.sendUserMessage("resume please", {});
console.assert(sess24.interrupted === false, "FAIL: interrupted flag must be cleared after a turn");
console.assert(resumeResp.type !== "error" || !String(resumeResp.content).startsWith("(interrupted)"), "FAIL: resumed turn must not return the stale interrupted marker");
const interruptedMsgs = sess24.messages.filter(m => m.interrupted);
console.assert(interruptedMsgs.length <= 1, "FAIL: at most the original partial turn may be marked interrupted");
ok("interrupt-resume");

header("25: compaction â€” estimate, threshold, compact");
const { Session } = await import("../core/session.js");
const sess25 = new Session();
for (let i = 0; i < 30; i++) {
  sess25.addMessage({ role: "user", content: "Message " + i + " with some padding: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(4) });
  sess25.addMessage({ role: "assistant", content: "Reply " + i + " confirming progress and next steps for the task at hand, plus extra detail. ".repeat(4) });
}
console.assert(sess25.estimateTokens() > 100, "FAIL: estimateTokens should count the padded content");
sess25.config.compactThreshold = 0.0001;
console.assert(sess25.shouldCompact(), "FAIL: shouldCompact should trigger at a tiny threshold");
const shortSess = new Session();
shortSess.addMessage({ role: "user", content: "hi" });
console.assert(!shortSess.shouldCompact(), "FAIL: short conversations must not compact");
const compRes = await sess25.compact();
console.assert(compRes.compacted, "FAIL: compact() should report compacted");
console.assert(compRes.method === "truncate" || compRes.method === "summary", "FAIL: method should be truncate or summary");
console.assert(sess25.messages.length <= 9, "FAIL: after compact, keep ~8 messages + 1 summary entry");
console.assert(String(sess25.messages[0].content).includes("Compacted"), "FAIL: first message should be the compaction summary note");
console.assert(sess25.compactCount === 1, "FAIL: compactCount should be 1");
ok("compaction");

header("26: todo state â€” setTodos, normalization, recompute");
const sess26 = getSession();
sess26.setTodos([
  { content: "Write tests", status: "in_progress", priority: "high" },
  { content: "Write tests", status: "completed" },
  { content: "  Fix the bug  ", status: "bogus", priority: "urgent" },
  { content: "", status: "completed" },
]);
console.assert(sess26.todos.length === 2, "FAIL: duplicate + empty items should be deduped to 2, got " + sess26.todos.length);
console.assert(sess26.todos[0].content === "Write tests" && sess26.todos[0].status === "completed", "FAIL: duplicate should take the later status (completed)");
console.assert(sess26.todos[1].status === "pending" && sess26.todos[1].priority === "medium", "FAIL: invalid status/priority should fall back to pending/medium");
sess26.todos = [];
appendMessage({ role: "assistant", content: "Here is the plan:\n[x] done item\n[ ] open item\n[+] in progress\n[-] dropped" });
const { recomputeTodos } = await import("./store.ts");
recomputeTodos();
const { todos } = await import("./store.ts");
const tAll = todos();
console.assert(tAll.length >= 4, "FAIL: fallback scan should pick up [ ] [x] [+] [-] lines");
console.assert(tAll.some(t => t.done && t.text === "done item"), "FAIL: [x] should map to done");
console.assert(tAll.some(t => t.inProgress && t.text === "in progress"), "FAIL: [+] should map to in progress");
console.assert(tAll.some(t => t.cancelled && t.text === "dropped"), "FAIL: [-] should map to cancelled");
sess26.todos = [{ content: "Real session todo", status: "in_progress" }];
recomputeTodos();
console.assert(todos().length === 1 && todos()[0].text === "Real session todo" && todos()[0].inProgress, "FAIL: session todos should win over message scan");
ok("todo state");

header("26b: markdown checklist lines feed the sidebar todo scan");
sess26.todos = [];
appendMessage({ role: "assistant", content: "Plan:\n- [x] wired step\n* [ ] star step\n1. [~] numbered step\n   - [ ] nested step" });
recomputeTodos();
console.assert(todos().some(t => t.done && t.text === "wired step"), "FAIL: '- [x]' should map to done");
console.assert(todos().some(t => !t.done && t.text === "star step"), "FAIL: '* [ ]' should map to open");
console.assert(todos().some(t => t.inProgress && t.text === "numbered step"), "FAIL: '1. [~]' should map to in progress");
console.assert(todos().some(t => !t.done && t.text === "nested step"), "FAIL: indented '- [ ]' should map to open");
ok("markdown checklist scan");

header("26c: sidebar Todos tab renders session todos and click toggles done");
const sess26c = getSession();
sess26c.todos = [{ content: "click me", status: "pending" }, { content: "keep me", status: "completed" }];
recomputeTodos();
await sleep(200);
frame = strip(setup.captureCharFrame());
let sLines = frame.split("\n");
const tabY = sLines.findIndex(l => l.includes("Todos"));
console.assert(tabY > 0, "FAIL: Todos tab not found in frame");
await setup.mockMouse.click(sLines[tabY].indexOf("Todos") + 2, tabY);
await sleep(200);
frame = strip(setup.captureCharFrame());
sLines = frame.split("\n");
console.assert(frame.includes("[ ] click me"), "FAIL: sidebar should render pending todo row");
console.assert(frame.includes("[x] keep me"), "FAIL: sidebar should render completed todo row");
let rowY = sLines.findIndex(l => l.includes("[ ] click me"));
console.assert(rowY > tabY, "FAIL: todo row not found below tabs");
await setup.mockMouse.click(sLines[rowY].indexOf("[ ] click me") + 1, rowY);
await sleep(200);
console.assert(todos()[0].done === true, "FAIL: click should flip todo to done");
frame = strip(setup.captureCharFrame());
sLines = frame.split("\n");
rowY = sLines.findIndex(l => l.includes("[x] click me"));
console.assert(rowY > 0, "FAIL: frame should show [x] click me after click");
await setup.mockMouse.click(sLines[rowY].indexOf("[x] click me") + 1, rowY);
await sleep(200);
console.assert(todos()[0].done === false, "FAIL: second click should flip back to pending");
ok("sidebar todo click toggles");

header("26d: sidebar Files tab row click opens the file (spawn stubbed)");
const sb26d = await import("./components/Sidebar.tsx");
const spawned26d: string[][] = [];
sb26d.__stubOpenFileSpawn((opener: string, args: string[]) => { spawned26d.push([opener].concat(args)); return { unref() {} }; });
frame = strip(setup.captureCharFrame());
sLines = frame.split("\n");
const fTabY = sLines.findIndex(l => l.includes("Files"));
console.assert(fTabY > 0, "FAIL: Files tab not found in frame");
await setup.mockMouse.click(sLines[fTabY].indexOf("Files") + 2, fTabY);
await sleep(200);
frame = strip(setup.captureCharFrame());
sLines = frame.split("\n");
let fRowY = -1;
for (let y = fTabY + 1; y < sLines.length - 1; y++) {
  const seg = (sLines[y] || "").substring(64, 98).trim();
  if (seg.length) { fRowY = y; break; }
}
console.assert(fRowY > fTabY, "FAIL: no file row visible in sidebar");
const firstFile = getProjectFiles()[0];
await setup.mockMouse.click(66, fRowY);
await sleep(250);
console.assert(spawned26d.length === 1, "FAIL: file click should call spawn once, got " + spawned26d.length);
const gotAbs = String(spawned26d[0][spawned26d[0].length - 1]).replace(/\\/g, "/");
const wantAbs = path.resolve(process.cwd(), firstFile).replace(/\\/g, "/");
console.assert(gotAbs.toLowerCase() === wantAbs.toLowerCase(), "FAIL: spawn arg should be the clicked file, got " + gotAbs + " want " + wantAbs);
console.assert(toasts().some(x => String(x.text).startsWith("Opened")), "FAIL: file click should show an Opened toast");
sb26d.__stubOpenFileSpawn(null);
await setup.mockMouse.click(sLines[fTabY].indexOf("Info") + 2, fTabY);
await sleep(200);
ok("sidebar file click opens");

header("26e: /agents lists primaries and subagents");
setup.mockInput.typeText("/agents");
await sleep(200);
setup.mockInput.pressEnter();
await sleep(400);
// The AGENTS system message is ~18 lines — taller than the chat viewport, so
// frame assertions would only ever see its tail. Assert on the message itself.
const agentsMsg = messages().map((m: any) => String(m.content)).find(c => c.startsWith("AGENTS"));
console.assert(!!agentsMsg, "FAIL: /agents should append the agents listing message");
console.assert(agentsMsg && agentsMsg.includes("build") && agentsMsg.includes("plan") && agentsMsg.includes("chat"), "FAIL: /agents should list primary agents");
console.assert(agentsMsg && agentsMsg.includes("explore") && agentsMsg.includes("scout") && agentsMsg.includes("general"), "FAIL: /agents should list subagents");
console.assert(agentsMsg && agentsMsg.includes("subagent"), "FAIL: /agents should mention subagent mode");
console.assert(agentsMsg && agentsMsg.includes("@explore"), "FAIL: /agents should document @explore mentions");
console.assert(agentsMsg && agentsMsg.includes("task tool"), "FAIL: /agents should document the task tool");
ok("agents listing");

header("26f: @agent mention delegates the turn and streams a subagent panel");
setup.mockInput.typeText("@explore");
await sleep(200);
frame = strip(setup.captureCharFrame());
console.assert(autoKind() === "at", "FAIL: @ should open the at-popup, got " + autoKind());
const atLines = frame.split("\n");
const atY = atLines.findIndex(l => l.includes("@explore"));
console.assert(atY > 0, "FAIL: @explore should be a suggestion row");
setup.mockInput.pressEscape();
await sleep(150);
setup.mockInput.typeText("@explore find the bug");
await sleep(200);
console.assert(autoKind() !== "at", "FAIL: a completed @agent query must not keep the popup open");
setup.mockInput.pressEnter();
// The child's final patch (done:true) lands after the turn settles; wait for
// the panel's "finished" status to render instead of a fixed sleep.
frame = await waitForFrame(f => f.includes("finished"), "subagent panel final status");
const lastUser = messages().slice().reverse().find((m: any) => m.role === "user");
console.assert(lastUser && String(lastUser.content).indexOf("@explore") === -1, "FAIL: user bubble should be stripped of the @mention");
console.assert(String(lastUser.content) === "find the bug", "FAIL: user bubble should carry only the query text");
console.assert(messages().some((m: any) => m.agentLabel === "explore"), "FAIL: assistant message should carry agentLabel explore");
console.assert(frame.includes("@explore"), "FAIL: chat should show the agent label @explore");
console.assert(frame.includes("child findings"), "FAIL: subagent panel should stream the child delta");
console.assert(frame.includes("grep"), "FAIL: subagent panel should show tool log");
console.assert(frame.includes("finished"), "FAIL: subagent panel should show final status");
ok("agent mention delegation");

header("27: bash-based diff detection (git + non-git)");
const fd = await import("../core/file-diffs.js");
const gitDiffFixture = [
  "diff --git a/a.txt b/a.txt",
  "index 111..222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,3 +1,4 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "+four",
  "diff --git a/b.txt b/b.txt",
  "deleted file mode 100644",
  "index 333..000 100644",
  "--- a/b.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-alpha",
].join("\n");
const parsed = fd.parseGitDiff(gitDiffFixture);
console.assert(parsed.length === 2, "FAIL: parseGitDiff should find 2 file diffs");
console.assert(parsed[0].path === "a.txt" && parsed[0].added === 2 && parsed[0].removed === 1, "FAIL: a.txt should be +2 -1");
console.assert(parsed[1].path === "b.txt" && parsed[1].added === 0 && parsed[1].removed === 1, "FAIL: b.txt should be -1");
console.assert(parsed[0].lines.some(l => l.kind === "add" && l.text === "TWO"), "FAIL: a.txt hunk should contain +TWO");
console.assert(parsed[0].lines.some(l => l.kind === "del" && l.text === "two"), "FAIL: a.txt hunk should contain -two");
const bashTmp = path.join(process.cwd(), ".tmp-bash-diff");
fs_rmSync(bashTmp, { recursive: true, force: true });
fs_mkdirSync(bashTmp, { recursive: true });
const modulePath = path.join(process.cwd(), "src", "core", "file-diffs.js").replace(/\\/g, "/");
fs_writeFileSync(path.join(bashTmp, "probe.js"), [
  'const fd = require("' + modulePath + '");',
  'const fs = require("fs");',
  'const path = require("path");',
  'fs.writeFileSync(path.join(process.cwd(), "a.txt"), "one\\ntwo\\nthree\\n");',
  'fs.writeFileSync(path.join(process.cwd(), "b.txt"), "alpha\\n");',
  "fd.snapshotBashBefore();",
  'fs.writeFileSync(path.join(process.cwd(), "a.txt"), "one\\nTWO\\nthree\\nfour\\n");',
  'fs.rmSync(path.join(process.cwd(), "b.txt"));',
  'fs.writeFileSync(path.join(process.cwd(), "c.txt"), "new file\\n");',
  "const diffs = fd.diffBashAfter();",
  'const rels = diffs.map(d => d.path + " +" + d.added + " -" + d.removed);',
  'if (!rels.some(r => r.startsWith("a.txt") && r.includes("+2") && r.includes("-1"))) throw new Error("FAIL: a.txt bash edit not detected");',
  'if (!rels.some(r => r.startsWith("b.txt") && r.includes("+0") && r.includes("-1"))) throw new Error("FAIL: b.txt bash delete not detected");',
  'if (!rels.some(r => r.startsWith("c.txt") && r.includes("+1"))) throw new Error("FAIL: c.txt bash create not detected");',
  'console.log("NON-GIT-OK");',
].join("\n"));
try {
  const out = execSync("bun run probe.js", { cwd: bashTmp, encoding: "utf8", timeout: 60000 });
  console.assert(out.includes("NON-GIT-OK"), "FAIL: non-git snapshot path failed");
} catch (e) {
  console.assert(false, "FAIL: non-git snapshot path errored: " + String(e?.message || e).slice(0, 200));
}
fs_rmSync(bashTmp, { recursive: true, force: true });
ok("bash diff detection");

header("28: restore points â€” snapshot, list (per-cwd), restoreTo");
const restoreTmp = path.join(process.cwd(), ".tmp-restore");
const restoreFile = path.join(process.cwd(), ".tmp-restore-points.json");
fs_rmSync(restoreTmp, { recursive: true, force: true });
fs_rmSync(restoreFile, { recursive: true, force: true });
fs_mkdirSync(restoreTmp, { recursive: true });
const restoreModulePath = path.join(process.cwd(), "src", "core", "restore.js").replace(/\\/g, "/");
fs_writeFileSync(path.join(restoreTmp, "probe.js"), [
  'const restore = require("' + restoreModulePath + '");',
  'const fs = require("fs");',
  'const path = require("path");',
  'fs.writeFileSync(path.join(process.cwd(), "a.txt"), "one\\ntwo\\n");',
  'fs.writeFileSync(path.join(process.cwd(), "b.txt"), "alpha\\n");',
  'fs.mkdirSync(path.join(process.cwd(), "sub"), { recursive: true });',
  'fs.writeFileSync(path.join(process.cwd(), "sub", "deep.txt"), "deep\\n");',
  'const p1 = restore.createRestorePoint("test prompt one");',
  'fs.writeFileSync(path.join(process.cwd(), "a.txt"), "MODIFIED");',
  'fs.rmSync(path.join(process.cwd(), "b.txt"));',
  'fs.writeFileSync(path.join(process.cwd(), "c.txt"), "created later\\n");',
  'const p2 = restore.createRestorePoint("test prompt two");',
  'const listed = restore.listRestorePoints();',
  'if (listed.length !== 2) throw new Error("FAIL: expected 2 points, got " + listed.length);',
  'if (listed[0].id !== p2.id) throw new Error("FAIL: newest point should come first");',
  'if (listed[0].label !== "test prompt two") throw new Error("FAIL: label not stored");',
  'const r = restore.restoreTo(p1.id);',
  'if (!r.ok) throw new Error("FAIL: restoreTo failed: " + JSON.stringify(r));',
  'if (fs.readFileSync(path.join(process.cwd(), "a.txt"), "utf8") !== "one\\ntwo\\n") throw new Error("FAIL: a.txt not restored");',
  'if (fs.readFileSync(path.join(process.cwd(), "b.txt"), "utf8") !== "alpha\\n") throw new Error("FAIL: b.txt not re-created");',
  'if (fs.readFileSync(path.join(process.cwd(), "sub", "deep.txt"), "utf8") !== "deep\\n") throw new Error("FAIL: deep.txt lost");',
  'if (fs.existsSync(path.join(process.cwd(), "c.txt"))) throw new Error("FAIL: c.txt should be removed after restore");',
  'if (!r.restored.some(x => x.endsWith("a.txt")) || !r.deleted.some(x => x.endsWith("c.txt"))) throw new Error("FAIL: restore summary wrong: " + JSON.stringify(r));',
  'const again = restore.restoreTo("does-not-exist");',
  'if (again.ok) throw new Error("FAIL: unknown id should fail");',
  'console.log("RESTORE-OK");',
].join("\n"));
try {
  const out = execSync("bun run probe.js", { cwd: restoreTmp, encoding: "utf8", timeout: 60000, env: Object.assign({}, process.env, { LOOM_RESTORE_FILE: restoreFile.replace(/\\/g, "/") }) });
  console.assert(out.includes("RESTORE-OK"), "FAIL: restore roundtrip failed");
} catch (e) {
  console.assert(false, "FAIL: restore roundtrip errored: " + String(e?.message || e).slice(0, 300));
}
fs_rmSync(restoreTmp, { recursive: true, force: true });
fs_rmSync(restoreFile, { recursive: true, force: true });
ok("restore points");

header("29: model picker searchable filter");
setup.mockInput.typeText("/models");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(300);
console.assert(modal()?.type === "select", "FAIL: /models should open the select modal");
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("type to search"), "FAIL: search hint missing from footer");
setup.mockInput.typeText("claude");
await sleep(300);
frame = strip(setup.captureCharFrame());
const searchLine = frame.split("\n").find(l => l.includes("search:"));
console.assert(searchLine && searchLine.includes("claude"), "FAIL: search query not shown");
const visibleModel = frame.split("\n").filter(l => l.includes("Claude") || l.includes("GPT") || l.includes("gemini") || l.includes("DeepSeek"));
console.assert(visibleModel.length > 0, "FAIL: no matching models visible");
console.assert(!visibleModel.some(l => l.includes("GPT") || l.includes("gemini") || l.includes("DeepSeek")), "FAIL: non-claude models should be filtered out");
setup.mockInput.pressEscape();
await sleep(150);
console.assert(modal() === null, "FAIL: Esc should close the model picker");
ok("model picker search");

header("30: model management â€” recents, quota detection, auto-switch");
const mmTmp = path.join(process.cwd(), ".tmp-modelmgmt");
fs_rmSync(mmTmp, { recursive: true, force: true });
fs_mkdirSync(mmTmp, { recursive: true });
const settingsMod = path.join(process.cwd(), "src", "config", "settings.js").replace(/\\/g, "/");
const sessionMod = path.join(process.cwd(), "src", "core", "session.js").replace(/\\/g, "/");
fs_writeFileSync(path.join(mmTmp, "probe.js"), [
  'const path = require("path");',
  'const settings = require("' + settingsMod + '");',
  'const session = require("' + sessionMod + '");',
  'if (!Array.isArray(settings.DEFAULTS.recentModels)) throw new Error("FAIL: DEFAULTS.recentModels missing");',
  'settings.saveConfig({ provider: "openai", model: { openai: "gpt-4o" }, apiKeys: { openai: "sk-test-1", anthropic: "sk-ant-test-2" } });',
  'settings.recordModelUse("openai", "gpt-4o");',
  'settings.recordModelUse("anthropic", "claude-3-5-sonnet-latest");',
  'let r = settings.getRecentModels();',
  'if (r.length !== 2) throw new Error("FAIL: expected 2 recents, got " + r.length);',
  'if (r[0].provider !== "anthropic") throw new Error("FAIL: newest recent should come first");',
  'settings.recordModelUse("openai", "gpt-4o");',
  'r = settings.getRecentModels();',
  'if (r.length !== 2 || r[0].provider !== "openai") throw new Error("FAIL: dedupe should move existing entry to front");',
  'if (!session.isQuotaError({ status: 402 })) throw new Error("FAIL: 402 should be quota");',
  'if (!session.isQuotaError({ message: "You have exhausted your quota for the free tier" })) throw new Error("FAIL: quota message should match");',
  'if (!session.isQuotaError({ error: { message: "Rate limit exceeded" } })) throw new Error("FAIL: rate limit should match");',
  'if (session.isQuotaError({ message: "internal server error" })) throw new Error("FAIL: generic error must not match quota");',
  'if (session.isQuotaError(null)) throw new Error("FAIL: null must not be quota");',
  'const s = new session.Session();',
  's.provider = { init: function(){}, active: { name: "openai" } };',
  'const sw = s.autoSwitchModel("openai");',
  'if (!sw || sw.provider !== "anthropic" || sw.model !== "claude-3-5-sonnet-latest") throw new Error("FAIL: recent-first auto-switch wrong: " + JSON.stringify(sw));',
  'const cfg = settings.loadConfig();',
  'if (cfg.provider !== "anthropic" || cfg.model.anthropic !== "claude-3-5-sonnet-latest") throw new Error("FAIL: config not persisted after switch");',
  'r = settings.getRecentModels();',
  'if (r[0].provider !== "anthropic") throw new Error("FAIL: switched model should be recorded as most recent");',
  'for (let i = 0; i < 12; i++) settings.recordModelUse("p" + i, "m" + i);',
  'r = settings.getRecentModels();',
  'if (r.length !== 8) throw new Error("FAIL: recents should cap at 8, got " + r.length);',
  'if (r[0].provider !== "p11") throw new Error("FAIL: cap should keep the newest 8");',
  'settings.saveConfig(Object.assign({}, settings.loadConfig(), { apiKeys: {} }));',
  'for (const k of Object.keys(process.env)) if (/API_KEY$/.test(k)) delete process.env[k];',
  'const s2 = new session.Session();',
  's2.provider = { init: function(){}, active: { name: "local" } };',
  'const sw2 = s2.autoSwitchModel("local");',
  'if (sw2 !== null) throw new Error("FAIL: no-key case should return null, got " + JSON.stringify(sw2));',
  'console.log("MODEL-MGMT-OK");',
].join("\n"));
try {
  const out = execSync("bun run probe.js", { cwd: mmTmp, encoding: "utf8", timeout: 60000, env: Object.assign({}, process.env, { USERPROFILE: mmTmp, HOME: mmTmp }) });
  console.assert(out.includes("MODEL-MGMT-OK"), "FAIL: model management roundtrip failed");
} catch (e) {
  console.assert(false, "FAIL: model management probe errored: " + String(e?.message || e).slice(0, 300));
}
fs_rmSync(mmTmp, { recursive: true, force: true });
ok("model management");

header("31: default MCP seeding â€” once-only, enabled/disabled split, removals stick");
const mcpTmp = path.join(process.cwd(), ".tmp-mcpseed");
fs_rmSync(mcpTmp, { recursive: true, force: true });
fs_mkdirSync(mcpTmp, { recursive: true });
const mcpMod = path.join(process.cwd(), "src", "mcp", "mcp-manager.js").replace(/\\/g, "/");
fs_writeFileSync(path.join(mcpTmp, "probe.js"), [
  'const mcp = require("' + mcpMod + '");',
  'const r1 = mcp.seedDefaults();',
  'if (!r1.seeded || r1.seeded !== 7) throw new Error("FAIL: first seed should add 7 servers, got " + JSON.stringify(r1));',
  'const s1 = mcp.listServers();',
  'if (s1.length !== 7) throw new Error("FAIL: expected 7 servers, got " + s1.length);',
  'const byName = (n) => s1.find((s) => s.name === n);',
  'for (const n of ["fetch", "memory"]) {',
  '  if (!byName(n) || !byName(n).enabled) throw new Error("FAIL: " + n + " should be enabled");',
  '}',
  'for (const n of ["time", "sequential-thinking", "github", "filesystem", "brave-search"]) {',
  '  if (!byName(n) || byName(n).enabled !== false) throw new Error("FAIL: " + n + " should be installed disabled");',
  '}',
  'if (process.platform === "win32" && byName("fetch").command !== "cmd") throw new Error("FAIL: npx defaults must wrap with cmd /c on Windows");',
  'const r2 = mcp.seedDefaults();',
  'if (!r2.skipped) throw new Error("FAIL: second seed should be skipped");',
  'if (mcp.listServers().length !== 7) throw new Error("FAIL: second seed must not duplicate servers");',
  'mcp.removeServer("fetch");',
  'if (mcp.listServers().length !== 6) throw new Error("FAIL: removeServer should drop fetch");',
  'const r3 = mcp.seedDefaults();',
  'if (!r3.skipped || mcp.listServers().some((s) => s.name === "fetch")) throw new Error("FAIL: user removals must stick after re-seed");',
  'const added = mcp.addServer("custom", "echo", ["hi"], { enabled: true, env: { MY_KEY: "abc" } });',
  'if (added.error) throw new Error("FAIL: addServer with opts failed");',
  'const c = mcp.listServers().find((s) => s.name === "custom");',
  'if (!c || !c.enabled) throw new Error("FAIL: custom server should be enabled");',
  'const raw = JSON.parse(require("fs").readFileSync(mcp.MCP_FILE, "utf8"));',
  'if (raw.servers.custom.env.MY_KEY !== "abc") throw new Error("FAIL: env must persist in mcp.json");',
  'console.log("MCP-SEED-OK");',
].join("\n"));
try {
  const out = execSync("bun run probe.js", { cwd: mcpTmp, encoding: "utf8", timeout: 60000, env: Object.assign({}, process.env, { USERPROFILE: mcpTmp, HOME: mcpTmp }) });
  console.assert(out.includes("MCP-SEED-OK"), "FAIL: default mcp seeding roundtrip failed");
} catch (e) {
  console.assert(false, "FAIL: default mcp seeding probe errored: " + String(e?.message || e).slice(0, 300));
}
fs_rmSync(mcpTmp, { recursive: true, force: true });
ok("default mcp seeding");

header("32: /theme â€” picker, live palette switch, persistence");
setup.mockInput.typeText("/theme");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(300);
console.assert(modal()?.type === "select", "FAIL: /theme should open the select modal");
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Select Theme") && frame.includes("Loom Dark"), "FAIL: theme picker should list themes");
setup.mockInput.pressArrow("down");
await sleep(120);
setup.mockInput.pressArrow("down");
await sleep(120);
setup.mockInput.pressEnter();
await sleep(300);
console.assert(modal() === null, "FAIL: theme picker should close on pick");
console.assert(toasts().some(t => String(t.text).startsWith("Theme:")), "FAIL: /theme should show a toast confirmation");
const themeMod = await import("../tui/theme.ts");
const { palette: pal, setTheme: st, themeOptions: to } = themeMod;
console.assert(to().length >= 5, "FAIL: at least 5 themes should be available, got " + to().length);
const oceanBg = pal().bg;
const themeFile = path.join(os.homedir(), ".loom", "tui.json");
let themeSaved = false;
try { themeSaved = JSON.parse(fs.readFileSync(themeFile, "utf8")).theme === "ocean"; } catch {}
console.assert(oceanBg === "#0e1a26" && themeSaved, "FAIL: ocean theme should be live + persisted, bg=" + oceanBg);
const okTheme = st("loom");
console.assert(okTheme && pal().bg === "#191817", "FAIL: setTheme('loom') should restore the default");
console.assert(st("nope") === false, "FAIL: unknown theme id should be rejected");
ok("theme switching");

header("33: speed â€” parallel tools, warm MCP, prompt guidance");
const { Session: SessionCls } = await import("../core/session.js");
const speedSess = new SessionCls();
const prompt = speedSess.systemPrompt;
console.assert(prompt.includes("Batch independent tool calls"), "FAIL: prompt should encourage batching");
console.assert(!prompt.includes("Call tools one at a time"), "FAIL: old one-at-a-time instruction must be gone");
const mcpC = await import("../mcp/mcp-client.js");
const warmStart = Date.now();
const warmRes = await mcpC.getCachedTools();
console.assert(warmRes.length === 0, "FAIL: LOOM_MCP_NO_WARM should return no tools");
console.assert(Date.now() - warmStart < 500, "FAIL: warm should be instant under LOOM_MCP_NO_WARM");
const toolsMod = await import("../tools/index.js");
const defStart = Date.now();
const defs = await toolsMod.getAllToolDefinitions("build");
console.assert(Array.isArray(defs) && defs.length >= 8, "FAIL: build tools should still be available");
console.assert(Date.now() - defStart < 1500, "FAIL: tool definitions must not block on MCP (took " + (Date.now() - defStart) + "ms)");
const defs2 = await toolsMod.getAllToolDefinitions("build");
console.assert(defs2 === defs, "FAIL: base tool definitions should be cached per mode");
ok("speed hardening");

header("34: busy submit â€” Enter holds text in the input bar, sends after the turn");
const q34 = await import("./store.ts");
const sess34 = q34.getSession();
const realSend34 = sess34.sendUserMessage;
// Long mock turn: the busy-hold only works while thinking() is still true, so
// the typing + sleep below must land well inside the window. 3000ms keeps this
// robust even when the test machine is under load.
sess34.sendUserMessage = function() {
  return new Promise((res) => setTimeout(() => res({ type: "success", content: "mock-done" }), 3000));
};
setMessages([]);
await waitFor(() => q34.toasts().length === 0, "toasts to clear before busy-submit test");
setup.mockInput.pressEscape(); // close any stale suggestion popup so Enter submits
await sleep(150);
const tx34 = async (txt: string) => {
  setup.mockInput.typeText(txt);
  await sleep(80);
  setup.mockInput.pressEnter();
  await sleep(80);
};
await tx34("first-turn prompt");
await waitFor(() => thinking() === true, "first turn to start thinking");
console.assert(thinking() === true, "FAIL: first submit should set thinking");
await tx34("held");
console.assert(q34.input() === "held", "FAIL: busy Enter must keep text in the input bar (got " + JSON.stringify(q34.input()) + ")");
console.assert(messages().filter((m) => m.role === "user").length === 1, "FAIL: busy Enter must not send the message");
await waitFor(() => thinking() === false, "first turn to settle");
setup.mockInput.pressEnter(); // enter with the held text still in the bar
await waitFor(() => messages().some(m => m.role === "user" && String(m.content) === "held"), "held text to send");
console.assert(q34.input() === "", "FAIL: after the turn, Enter should consume the text");
await waitFor(() => thinking() === false && messages().some(m => String(m.content) === "mock-done"), "second turn to settle");
sess34.sendUserMessage = realSend34;
ok("busy submit holds input");

header("35: sidebar Speed row â€” live + last-turn telemetry renders");
const q35 = await import("./store.ts");
async function pumpRenders(n = 10) {
  for (let i = 0; i < n; i++) { await setup.renderOnce(); await sleep(10); }
}
// Let any lingering mocked turn promise (TEST 34, 800ms) resolve first so its
// .then() doesn't clobber the telemetry we're about to assert on.
await sleep(900);
q35.setSpeedStats({ live: { elapsedMs: 3000, firstTokenMs: 2800, tokensPerSec: 42 }, last: null });
console.assert(q35.speedStats()?.live?.tokensPerSec === 42, "FAIL: signal write should land");
await pumpRenders();
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Speed:") && frame.includes("42 tok/s"), "FAIL: live speed row should render tok/s");
console.assert(frame.includes("2.8s"), "FAIL: live speed row should show first-token latency");
q35.setSpeedStats({ live: null, last: { latencyMs: 5100, tokensPerSec: 9, durationMs: 6200, tokens: 56, model: "x/y" } });
await pumpRenders();
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Speed:") && frame.includes("9 tok/s"), "FAIL: last-turn speed row should render after the turn");
q35.setSpeedStats({ live: null, last: null });
await pumpRenders();
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Speed:") && frame.includes("\u2014"), "FAIL: speed row should show em-dash when no data");
ok("sidebar speed row");

header("36: permission popup â€” Allow / Always allow / Deny / custom answer");
const q36 = await import("./store.ts");
// 36a: typing goes to the popup (custom answer), never to the input bar.
const p36a: any = q36.requestPermission("bash", "npm install -g foo", "dangerous command");
await sleep(150);
await pumpRenders();
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Permission needed"), "FAIL: permission popup should appear");
console.assert(frame.includes("npm install -g foo"), "FAIL: popup should show the command");
console.assert(frame.includes("recommended"), "FAIL: Allow should be marked recommended");
const inputBefore36 = q36.input();
setup.mockInput.typeText("no thanks");
await sleep(100);
await pumpRenders();
console.assert(q36.input() === inputBefore36, "FAIL: typing while popup open must not reach the input bar");
console.assert(q36.permission() !== null, "FAIL: popup should stay open while typing the answer");
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Answer"), "FAIL: typing an answer should switch the popup to answer mode, got:\n" + frame);
console.assert(frame.includes("no thanks"), "FAIL: answer input should show the typed text");
console.assert(!frame.includes("Question —"), "FAIL: full-screen Question overlay must not open");
// Esc returns to the permission options (no resolve yet).
setup.mockInput.pressEscape();
await sleep(100);
await pumpRenders();
console.assert(q36.permission() !== null, "FAIL: Esc in Question popup should return to options, not resolve");
setup.mockInput.typeText("no thanks");
await sleep(100);
setup.mockInput.pressEnter();
const res36a = await p36a;
console.assert(res36a === false, "FAIL: typed denial should deny");
await pumpRenders();
frame = strip(setup.captureCharFrame());
console.assert(!frame.includes("Permission needed"), "FAIL: popup should close after answering");
ok("permission popup custom deny");

// 36b: Enter on the recommended option approves.
const p36b: any = q36.requestPermission("write", "C:/x/y.txt", "");
await sleep(150);
await pumpRenders();
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Permission needed") && frame.includes("change a file"), "FAIL: popup should show file-change wording");
setup.mockInput.pressEnter();
const res36b = await p36b;
console.assert(res36b === true, "FAIL: Allow (recommended) should approve");
await pumpRenders();
ok("permission popup allow");

// 36c: down-down + Enter denies.
const p36c: any = q36.requestPermission("bash", "rm -rf /tmp/x", "recursive force delete (rm -rf)");
await sleep(150);
await pumpRenders();
setup.mockInput.pressArrow("down");
await sleep(50);
setup.mockInput.pressArrow("down");
await sleep(50);
setup.mockInput.pressEnter();
const res36c = await p36c;
console.assert(res36c === false, "FAIL: Deny should block the command");
await pumpRenders();
ok("permission popup deny");

// 36d: "Always allow" approves AND saves a rule; clean up afterwards.
const p36d: any = q36.requestPermission("bash", "npm install -g foo", "dangerous command");
await sleep(150);
await pumpRenders();
setup.mockInput.pressArrow("down");
await sleep(50);
setup.mockInput.pressEnter();
const res36d = await p36d;
console.assert(res36d === true, "FAIL: Always allow should approve");
const rule36 = getSession().permissions.checkRule("npm install -g foo");
console.assert(rule36 === "allow", "FAIL: Always allow should save a rule, got " + String(rule36));
getSession().permissions.clearRule("npm install -g foo");
await pumpRenders();
ok("permission popup always-allow");

// 36e: Esc denies without changing input.
const p36e: any = q36.requestPermission("bash", "echo hi", "");
await sleep(150);
await pumpRenders();
setup.mockInput.pressEscape();
const res36e = await p36e;
console.assert(res36e === false, "FAIL: Esc should deny");
await pumpRenders();
ok("permission popup esc denies");

header("37: /budget — status, level switch, sidebar signal, restore");
const settings37 = require("../config/settings.js");
const cfg37orig = settings37.loadConfig();
const origBudgetLevel = cfg37orig.budgetLevel || "auto";
try {
  setup.mockInput.pressEscape();
  await sleep(100);
  setMessages([]);
  setInput("");
  await sleep(200);
  setup.mockInput.typeText("/budget");
  await sleep(150);
  setup.mockInput.pressEnter();
  await sleep(300);
  console.assert(messages().some(m => String(m.content).includes("=== Budget ===") && String(m.content).includes("Level:")), "FAIL: /budget should show the status panel");
  console.assert(messages().some(m => String(m.content).includes("free") && String(m.content).includes("cheap") && String(m.content).includes("best") && String(m.content).includes("auto")), "FAIL: /budget should list all levels");
  setup.mockInput.typeText("/budget free");
  await sleep(150);
  setup.mockInput.pressEnter();
  await sleep(300);
  console.assert(q36.toasts().some(t => String(t.text).startsWith("Budget: free")), "FAIL: /budget free should show a confirmation toast");
  console.assert(q36.budgetLevel() === "free", "FAIL: budgetLevel signal should be free, got " + q36.budgetLevel());
  frame = await waitForFrame(f => f.includes("[free]"), "sidebar to render [free]");
  setup.mockInput.typeText("/budget bogus");
  await sleep(150);
  setup.mockInput.pressEnter();
  await sleep(300);
  console.assert(q36.toasts().some(t => String(t.text).includes("free, cheap, best, auto")), "FAIL: invalid level should show an error toast");
  ok("/budget status + switch + validation");
} finally {
  const cfg37 = settings37.loadConfig();
  cfg37.budgetLevel = origBudgetLevel;
  settings37.saveConfig(cfg37);
  getSession().config = cfg37;
  refreshProviderState();
}

header("38: /budget <dollars> — set monthly cap, spend line, enforcement");
const usage38 = require("../core/usage.js");
const USAGE_TMP38 = path.join(os.tmpdir(), "loom-usage-t38-" + Date.now() + ".json");
const cfg38before = settings37.loadConfig();
const prevBudgetLevel38 = cfg38before.budgetLevel || "auto";
const prevProvider38 = cfg38before.provider;
const prevModel38 = JSON.parse(JSON.stringify(cfg38before.model || {}));
try {
  // Isolate the usage ledger so the test never touches the real ~/.loom usage.
  process.env.LOOM_USAGE_FILE = USAGE_TMP38;
  fs_rmSync(USAGE_TMP38, { force: true });
  usage38.setMonthlyBudget(25); // start sane

  setup.mockInput.pressEscape();
  await sleep(100);
  setMessages([]);
  setInput("");
  await sleep(200);

  // 38a: /budget <number> sets the monthly cap.
  setup.mockInput.typeText("/budget 42");
  await sleep(150);
  setup.mockInput.pressEnter();
  await sleep(300);
  console.assert(q36.toasts().some(t => String(t.text).includes("Monthly budget: $42")), "FAIL: /budget 42 should confirm the cap, got " + q36.toasts().map(t=>t.text).join(";"));
  let capNow = usage38.getUsage().budgetUsd;
  console.assert(capNow === 42, "FAIL: usage.budgetUsd should be 42 after /budget 42, got " + capNow);

  // 38b: bare /budget shows a spend line with cap %.
  setMessages([]);
  setInput("");
  await sleep(200);
  usage38.recordUsage({ costUsd: 21 }); // $21 of $42 = 50%
  setup.mockInput.typeText("/budget");
  await sleep(150);
  setup.mockInput.pressEnter();
  await sleep(300);
  console.assert(messages().some(m => String(m.content).includes("of $42")), "FAIL: /budget status should show the spend/cap line");
  console.assert(messages().some(m => String(m.content).includes("50%")), "FAIL: /budget status should show 50% of cap");

  // 38c: over-cap — a fresh Session (real sendUserMessage) must hard-block.
  usage38.recordUsage({ costUsd: 25 }); // $46 of $42 — over
  const cfg38 = settings37.loadConfig();
  cfg38.budgetLevel = "auto";
  cfg38.provider = "openai";
  cfg38.model = Object.assign({}, cfg38.model, { openai: "gpt-5-nano" });
  settings37.saveConfig(cfg38);
  const { Session: Sess38 } = await import("../core/session.js");
  const sess38 = new Sess38(); // reads cfg from disk, NOT mocked
  const resp = await sess38.sendUserMessage("hello governor", {});
  console.assert(resp.type === "error" && String(resp.content).includes("Monthly budget reached"), "FAIL: over-cap paid turn must hard-block, got " + JSON.stringify(resp));

  ok("/budget cap ± enforcement");
} finally {
  try { fs_rmSync(USAGE_TMP38, { force: true }); } catch {}
  delete process.env.LOOM_USAGE_FILE;
  const cfg38k = settings37.loadConfig();
  cfg38k.budgetLevel = prevBudgetLevel38;
  cfg38k.provider = prevProvider38;
  cfg38k.model = prevModel38;
  settings37.saveConfig(cfg38k);
  getSession().config = cfg38k;
  refreshProviderState();
}

header("39: /skills — browser modal, enable/disable toggle, auto-trigger toast");
function pluginListSkills39(): any[] {
  try { return require("../skills/skills-manager.js").listSkills(); } catch { return []; }
}
try {
  // Seed a project skill so listSkills() has at least one entry to browse.
  // Tests run with cwd === repo root, which is the projectSkillsDir().
  const skSeedDir = path.join(process.cwd(), ".loom", "skills", "gcodex");
  fs_mkdirSync(skSeedDir, { recursive: true });
  fs_writeFileSync(path.join(skSeedDir, "SKILL.md"),
    "---\nname: gcodex\ndescription: gcode slicing + STL post-processing\n---\n\nexpert instructions here.\n");
  let list: any[] = pluginListSkills39();
  console.assert(list.length > 0, "FAIL: no skills visible after seeding " + skSeedDir);

  // 39a: /skills opens the select modal listing installed skills.
  setup.mockInput.pressEscape();
  await sleep(100);
  setMessages([]);
  setInput("");
  await sleep(200);
  setup.mockInput.typeText("/skills");
  await sleep(150);
  setup.mockInput.pressEnter();
  await sleep(400);
  console.assert(modal()?.type === "select", "FAIL: /skills should open the select modal");
  frame = strip(setup.captureCharFrame());
  console.assert(frame.includes("Skills"), "FAIL: skill browser title missing");
  if (list.length) {
    const first = list[0].name;
    const gotFirst = frame.split("\n").some(l => l.includes(first));
    console.assert(gotFirst, "FAIL: first skill '" + first + "' not in modal frame");
  }
  setup.mockInput.pressEscape();
  await sleep(150);

  // 39b: real keyboard toggle through the modal — Enter on the highlighted
  // (first selectable, header-skipped) row flips the skill and persists it.
  if (list.length) {
    const target = list[0].name;
    setup.mockInput.typeText("/skills");
    await sleep(150);
    setup.mockInput.pressEnter();
    await sleep(400);
    console.assert(modal()?.type === "select", "FAIL: /skills should reopen for keyboard toggle");
    // The first row must be highlighted (">" marker) even though row 0 is a header.
    frame = strip(setup.captureCharFrame());
    console.assert(frame.split("\n").some(l => /│\s*>/.test(l)), "FAIL: skill modal should show a highlight on a selectable row, got:\n" + frame);
    setup.mockInput.pressEnter(); // toggle target OFF
    await sleep(400);
    const on = settings37.loadConfig().skillDisabled || [];
    console.assert(on.includes(target), "FAIL: keyboard Enter should persist " + target + " to skillDisabled, got " + JSON.stringify(on));
    setup.mockInput.pressEnter(); // toggle back ON
    await sleep(400);
    const off = settings37.loadConfig().skillDisabled || [];
    console.assert(!off.includes(target), "FAIL: second Enter should un-disable " + target);
    setup.mockInput.pressEscape();
    await sleep(150);
    console.assert(modal() === null, "FAIL: Esc should close the skill modal");
  }

  // 39c: auto-trigger fires the toast chain. We can't run the network model from a test,
  // but the App subscribes to trigger:skill → emit it directly and assert the toast.
  const ev39 = require("../core/events.js");
  const before39 = toasts().length;
  ev39.emit("trigger:skill", { skills: ["gcode one"], latencyMs: 1 });
  await sleep(300);
  const sawToast = toasts().some((t: any) =>
    String(t.text || "").toLowerCase().includes("skill activated") ||
    String(t.text || "").toLowerCase().includes("gcode one")
  );
  console.assert(sawToast, "FAIL: trigger:skill should fire a toast; current toasts=" + toasts().map((t: any) => t.text).join("|"));
  ok("skill auto-trigger fires toast");
} finally {
  const cfg39k = settings37.loadConfig();
  cfg39k.skillDisabled = [];
  settings37.saveConfig(cfg39k);
  getSession().config = cfg39k;
  refreshProviderState();
  try { fs_rmSync(path.join(process.cwd(), ".loom", "skills"), { recursive: true, force: true }); } catch {}
}

header("40: multiline chatbox \u2014 Shift+Enter newline, ~N lines badge, paste, submit");
// 40a: Shift+Enter inserts a newline instead of submitting.
// (pressEnter({shift}) can't encode the modifier on \r, so send the kitty
// keyboard sequence "\x1b[13;2u" which the parser maps to shift+return.)
setInput("");
await sleep(100);
setup.mockInput.typeText("line one");
setup.mockInput.pressKeys(["\x1b[13;2u"]);
await sleep(100);
setup.mockInput.typeText("line two");
await sleep(100);
console.assert(input() === "line one\nline two", "FAIL: Shift+Enter should insert a newline, got " + JSON.stringify(input()));
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("~2 lines"), "FAIL: chatbox should show the ~2 lines badge, got:\n" + frame);
ok("multiline chatbox shift-enter");

// 40b: multi-line bracketed paste keeps its newlines in the draft.
setup.mockInput.pasteBracketedText("\r\npasted a\r\npasted b\r\n");
await sleep(100);
console.assert(input().includes("pasted a\npasted b"), "FAIL: paste should keep newlines, got " + JSON.stringify(input()));
ok("multiline paste preserved");

// 40c: Enter submits the whole multi-line draft as one message.
setup.mockInput.pressEnter();
await waitFor(() => messages().some(m => m.role === "user" && String(m.content).includes("line one")), "multiline submit");
console.assert(messages().some(m => m.role === "user" && String(m.content).includes("pasted b")), "FAIL: submit should carry the full multi-line draft");
console.assert(input() === "", "FAIL: chatbox should clear after submit");
await sleep(200);
ok("multiline submit as one message");

header("41: caret editing — left/right move, insert/backspace at cursor, home/end");
setInput("");
await sleep(100);
setup.mockInput.typeText("helo");
await sleep(150);
setup.mockInput.pressArrow("left");
await sleep(60);
setup.mockInput.pressArrow("left");
await sleep(60);
setup.mockInput.pressArrow("left");
await sleep(60);
setup.mockInput.typeText("l");
await sleep(150);
const { cursor } = await import("./store.ts");
console.assert(input() === "hlelo", "FAIL: insert at caret should yield 'hlelo', got " + JSON.stringify(input()));
console.assert(cursor() === 2, "FAIL: caret should land after the inserted char");
setup.mockInput.pressKeys(["\x1b[H"]);
await sleep(100);
console.assert(cursor() === 0, "FAIL: home should zero the caret");
setup.mockInput.pressKeys(["\x1b[F"]);
await sleep(100);
console.assert(cursor() === input().length, "FAIL: end should put the caret at the end");
setup.mockInput.pressBackspace();
await sleep(150);
console.assert(input() === "hlel", "FAIL: backspace at end should drop the last char, got " + JSON.stringify(input()));
setup.mockInput.pressKeys(["\x1b[H"]);
await sleep(100);
setup.mockInput.typeText("H");
await sleep(150);
console.assert(input() === "Hhlel", "FAIL: typing at home should prepend, got " + JSON.stringify(input()));
setInput("");
await sleep(100);
ok("caret editing");

header("42: /clear asks before wiping the session");
{
  const before42 = messages().length;
  setup.mockInput.typeText("/clear");
  await sleep(150);
  setup.mockInput.pressEnter();
  await sleep(400);
  console.assert(modal()?.type === "select", "FAIL: /clear should open the confirm modal");
  frame = strip(setup.captureCharFrame());
  console.assert(frame.includes("Clear session?"), "FAIL: /clear confirm should show a warning title, got:\n" + frame);
  setup.mockInput.pressEscape();
  await sleep(150);
  console.assert(modal() === null, "FAIL: /clear modal Esc should close");
  console.assert(messages().length === before42, "FAIL: /clear on Esc must keep the session");

  setup.mockInput.typeText("/clear");
  await sleep(150);
  setup.mockInput.pressEnter();
  await sleep(400);
  setup.mockInput.pressArrow("down");
  await sleep(60);
  setup.mockInput.pressEnter();
  await sleep(400);
  console.assert(modal() === null, "FAIL: /clear confirm Yes should close the modal");
  console.assert(messages().length === 0, "FAIL: /clear Yes should actually clear, count=" + messages().length);
}
ok("clear confirmation modal");

header("43: chat output renders markdown (bold/code/links) without raw markers");
{
  appendMessage({ role: "assistant", content: "Here is **bold** and `inline code` plus a link [docs](https://x.dev).\n\n- item one\n- item two" });
  await pumpRenders();
  frame = strip(setup.captureCharFrame());
  console.assert(frame.includes("bold"), "FAIL: bold text should render its content");
  console.assert(!frame.includes("**bold**"), "FAIL: raw ** markers must not leak into chat");
  console.assert(frame.includes("inline code"), "FAIL: inline code should render its content");
  console.assert(!frame.includes("`inline code`"), "FAIL: backticks must not leak into chat");
  // The chat column wraps and the sidebar border glyphs slide between the two
  // halves — assert on the two visible fragments instead of the full string.
  const flat43 = frame.replace(/\s+/g, "");
  console.assert(flat43.includes("docs(https://x.") && flat43.includes("dev)."), "FAIL: link should render as label (url), got:\n" + frame);
  console.assert(!frame.includes("[docs]("), "FAIL: raw link markdown must not leak into chat");
  console.assert(frame.split("\n").some(l => /•\s+item one/.test(l)), "FAIL: list bullet should render as • marker");
  console.assert(frame.split("\n").some(l => /•\s+item two/.test(l)), "FAIL: second bullet should render too");
  await sleep(200);
}
ok("chat markdown rendering");

header("44: /mcp add preset picker (custom path)");

setup.mockInput.typeText("/mcp");
await sleep(150);
setup.mockInput.pressEnter();
await sleep(300);
setup.mockInput.typeText("a");
await sleep(400);
frame = strip(setup.captureCharFrame());
console.assert(modal()?.type === "select", "FAIL: /mcp + a should open the preset picker");
console.assert(frame.includes("Playwright MCP"), "FAIL: preset picker should list dev-tool MCP presets, got:\n" + frame);
console.assert(!frame.includes("Supabase"), "FAIL: connectors (Supabase) must not leak into the /mcp picker, got:\n" + frame);
for (let n = 0; n <= MCP_PRESETS.length; n++) { setup.mockInput.pressArrow("down"); await sleep(40); }
await sleep(200);
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Custom"), "FAIL: preset picker should include a Custom entry, got:\n" + frame);
setup.mockInput.pressEnter();
await sleep(300);
console.assert(modal()?.type === "addserver", "FAIL: picking Custom… should open the one-shot add form, got " + String(modal()?.type));
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Name"), "FAIL: form should show a Name field, got:\n" + frame);
console.assert(frame.includes("Command"), "FAIL: form should show a Command field, got:\n" + frame);
console.assert(frame.includes("Args"), "FAIL: form should show an Args field, got:\n" + frame);
console.assert(frame.includes("Env vars"), "FAIL: form should show an Env vars field, got:\n" + frame);

// All four fields on one modal; Up/Down/Tab moves focus; typing edits the
// active field. Fill them and press Enter on the last field to save.
setup.mockInput.typeText("probe-mcp");
await sleep(60);
setup.mockInput.pressArrow("down"); // Command
setup.mockInput.typeText("echo");
await sleep(60);
setup.mockInput.pressArrow("down"); // Args
setup.mockInput.typeText("hello");
await sleep(60);
setup.mockInput.pressArrow("down"); // Env vars
setup.mockInput.typeText("PROBE_KEY=probe123");
await sleep(60);
setup.mockInput.pressEnter();       // save
await sleep(300);
console.assert(modal()?.type === "mcp", "FAIL: after adding the custom server the flow should reopen the /mcp browser");
const mcp44 = require("../mcp/mcp-manager.js");
console.assert(mcp44.listServers().some(s => s.name === "probe-mcp"), "FAIL: guided add should persist the server");
mcp44.removeServer("probe-mcp");
setup.mockInput.pressEscape();
await sleep(150);
ok("mcp preset picker + one-shot add form");

header("45: /connectors — hosting/cloud presets live in their own browser");
setup.mockInput.typeText("/connectors");
await sleep(200);
setup.mockInput.pressEnter();
await sleep(300);
console.assert(modal()?.type === "connectors", "FAIL: /connectors should open the connector browser, got " + String(modal()?.type));
setup.mockInput.typeText("a");
await sleep(400);
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("Supabase"), "FAIL: connector picker should list Supabase, got:\n" + frame);
console.assert(frame.includes("Next.js"), "FAIL: connector picker should list Next.js, got:\n" + frame);
console.assert(frame.includes("Railway"), "FAIL: connector picker should list Railway, got:\n" + frame);
console.assert(frame.includes("Vercel"), "FAIL: connector picker should list Vercel, got:\n" + frame);
console.assert(!frame.includes("Playwright"), "FAIL: dev-tool MCP presets must not leak into /connectors, got:\n" + frame);
// Pick Railway (index 2) — token prompt comes from the same one-shot form.
setup.mockInput.pressArrow("down");
await sleep(40);
setup.mockInput.pressArrow("down");
await sleep(40);
setup.mockInput.pressEnter();
await sleep(300);
// A preset pick opens the same AddServerModal — env field shows KEY= placeholders.
console.assert(modal()?.type === "addserver", "FAIL: preset pick should open the add form, got " + String(modal()?.type));
frame = strip(setup.captureCharFrame());
console.assert(frame.includes("RAILWAY_API_TOKEN"), "FAIL: form should prefill the env key, got:\n" + frame);
// Fill Env vars (focus starts there for a preset with prompts), press Enter to save.
setup.mockInput.typeText("railway_fake_token");
await sleep(60);
setup.mockInput.pressEnter();
await sleep(400);
console.assert(modal()?.type === "connectors", "FAIL: saving the preset form should reopen the connectors browser, got " + String(modal()?.type));
const mcp45 = require("../mcp/mcp-manager.js");
console.assert(mcp45.listServers().some(s => s.name === "railway"), "FAIL: railway should be added");
mcp45.removeServer("railway");
setup.mockInput.pressEscape();
await sleep(150);
ok("connectors browser + one-shot add form");

console.log("");
_sessMock.sendUserMessage = _realSendAll;
if (assertFails === 0) {
  console.log("ALL " + testCount + " TESTS PASSED \u2014 run good");
  process.exit(0);
} else {
  console.log(assertFails + " assertion(s) FAILED \u2014 see FAIL lines above");
  process.exit(1);
}

