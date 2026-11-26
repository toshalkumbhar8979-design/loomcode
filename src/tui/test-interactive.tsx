// Interactive verification for the Loom opencode-style TUI: splash, composer,
// slash/file autocomplete, streaming turn rendering, tools, markdown, gates,
// pickers and keybind dispatch. Quiet mode: prints test names, OK lines and a
// self-diagnosing failure summary.
process.env.LOOM_MCP_NO_WARM = "1";
process.env.LOOM_MEM_AUTO = "0";
process.env.LOOM_NO_CLIPBOARD = "1";
process.env.LOOM_NO_SESSION_PROMPT = "1";
process.env.LOOM_SANDBOX = "0";
process.env.LOOM_PTY = "0";
import "./suite-home.ts";
import { testRender } from "@opentui/solid";
import { App } from "./App.tsx";
import {
  input, setDraft, suggestions, autoKind, autoIndex, messages, setMessages, modal,
  closeModal, getSession, inputMode, setInputMode, thinking, setThinking,
  showToolDetails, setShowToolDetails, showThinking, setShowThinking,
  permission, requestPermission, toasts, setSuggestions, setAutoKind, setAutoIndex,
  setUserExpandedIdx, vimMode, vimNormal, autoPerm, pointer,
} from "./store.ts";
import { palette, setTheme, themeName, themeOptions, THEMES, WORDMARK, SPLASH_ART, ROBOT_FRAMES } from "./design.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

setShowToolDetails(true);
setShowThinking(true);

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) {
      console.assert(false, "FAIL: timed out waiting for " + what);
      return;
    }
    await sleep(40);
  }
}

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
let curTest = "(boot)";
const failures: Array<{ test: string; msg: string; frameTail: string }> = [];
let testCount = 0;
let curTestStart = Date.now();
const timings: Array<{ name: string; ms: number }> = [];

function frameTailSafe(n: number): string {
  try {
    const lines = strip(setup.captureCharFrame()).split("\n");
    return lines.slice(Math.max(0, lines.length - n)).join("\n");
  } catch { return ""; }
}

const _rawAssert = console.assert.bind(console);
console.assert = function(cond: any, msg: string) {
  if (!cond) {
    assertFails++;
    failures.push({ test: curTest, msg: msg || "assertion failed", frameTail: frameTailSafe(12) });
    _rawAssert(false, msg || "assertion failed");
    if (process.env.TEST_BAIL) { printSummary(); process.exit(1); }
  }
} as any;

process.on("SIGINT", () => {
  console.log("\n--- INTERRUPTED (SIGINT) — partial summary follows ---");
  printSummary();
  process.exit(130);
});

function printSummary() {
  const passed = testCount - new Set(failures.map(f => f.test)).size;
  console.log("\n========== SUMMARY ==========");
  console.log("tests: " + testCount + "  passed-without-failures: " + passed + "  failed-assertions: " + assertFails);
  if (failures.length) {
    console.log("--- FAILURES ---");
    for (const f of failures) {
      console.log("[" + f.test + "] " + f.msg);
      if (f.frameTail) console.log("  frame tail:\n" + f.frameTail.split("\n").map(l => "    | " + l).join("\n"));
    }
  }
  const slow = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log("--- SLOWEST 5 ---");
  for (const t of slow) console.log((t.ms + "ms").padStart(7) + "  " + t.name);
}

function header(name: string) {
  if (testCount > 0) timings.push({ name: curTest, ms: Date.now() - curTestStart });
  curTest = name;
  curTestStart = Date.now();
  testCount++;
  console.log("\n=== TEST " + name + " ===");
}
function ok(name: string) { console.log("  OK — " + name); }

function resetUi() {
  setMessages([]);
  setDraft("");
  setSuggestions([]);
  setAutoKind("none");
  setAutoIndex(0);
  setThinking(false);
  setShowToolDetails(true);
  setShowThinking(true);
  setUserExpandedIdx(null);
  closeModal();
  setInputMode("build");
  getSession().setMode("build");
  setTheme("loom");
}

async function runSlash(cmd: string) {
  setup.mockInput.typeText(cmd);
  await sleep(120);
  setup.mockInput.pressEnter();
  await sleep(250);
}

header("1: splash renders anchored robot, tagline and composer");
const setup = await testRender(() => <App />, { width: 100, height: 32 });
await sleep(400);
{
  const f = await waitForFrame(x => x.includes("What can I do for you?"), "splash tagline");
  console.assert(f.includes("Use / for slash commands"), "FAIL: splash hint missing");
  console.assert(f.includes("What can I do for you?"), "FAIL: splash prompt missing");
  console.assert(f.includes("(0 ctx)"), "FAIL: a new session must not start with preloaded context");
  console.assert(f.includes("ctx)"), "FAIL: context gauge should label live context tokens");
  console.assert(SPLASH_ART.length === 13, "FAIL: robot art should be thirteen rows");
  console.assert(SPLASH_ART.join("\n").includes("@@@@@@@@@"), "FAIL: robot art missing");
  console.assert(f.includes("@@@@@@@@@"), "FAIL: robot not rendered");
  console.assert(WORDMARK.length === 5, "FAIL: exit wordmark should be five rows");
  const names = ["center", "up", "up-right", "right", "down-right", "down", "down-left", "left", "up-left", "blink"] as const;
  console.assert(names.every(n => ROBOT_FRAMES[n]?.length === 13), "FAIL: all ten 30x13 frames should be present");
  console.assert(new Set(names.map(n => ROBOT_FRAMES[n].join("\n"))).size === 10, "FAIL: all ten robot frames should be distinct");
  const artTop = f.split("\n").findIndex(l => l.includes("=*##*="));
  console.assert(artTop >= 0, "FAIL: robot art top not found");
  const midY = artTop + Math.floor(SPLASH_ART.length / 2);
  const topY = Math.max(0, artTop - 1);
  const bottomY = artTop + SPLASH_ART.length + 1;
  const look = async (x: number, y: number, snippet: string, what: string) => {
    await setup.mockMouse.moveTo(x, y);
    await sleep(120);
    const frame = await waitForFrame(x => x.includes(snippet), what);
    console.assert(frame.includes(snippet), "FAIL: " + what);
    return frame;
  };
  const center = f;
  const right = await look(90, midY, "###=#@@@@@@@#*=*#*", "right gaze frame");
  console.assert(pointer().seen && pointer().x === 90 && pointer().y === midY, "FAIL: mouse move did not reach the splash");
  const left = await look(10, midY, "##*=#@@@@@@@#*=###", "left gaze frame");
  const up = await look(50, topY, "###-*@@@@@@@@@#+-###", "up gaze frame");
  const down = await look(50, bottomY, "##*-*#@@@@@@@@#+-###", "down gaze frame");
  const upRight = await look(90, topY, "##*  #@@@@@@@@#+##-", "up-right gaze frame");
  const downRight = await look(90, bottomY, "=##*@@@@@@@@#*  +#*", "down-right gaze frame");
  const upLeft = await look(10, topY, "=##*@@@@@@@@@*  ###", "up-left gaze frame");
  const downLeft = await look(10, bottomY, "##+  #@@@@@@@@####-", "down-left gaze frame");
  console.assert(new Set([center, right, left, up, down, upRight, downRight, upLeft, downLeft]).size === 9, "FAIL: all nine gaze frames should be reachable");
  await setup.mockMouse.moveTo(50, 2);
  await sleep(120);
  setup.mockInput.typeText("h");
  await sleep(200);
  const typingFrame = await waitForFrame(x => x.includes("##+  #@@@@@@@@####-"), "down-left composer gaze");
  console.assert(typingFrame.includes("##+  #@@@@@@@@####-"), "FAIL: robot did not look at composer");
  setDraft("");
  await sleep(80);
  console.assert(themeOptions().length >= 5, "FAIL: expected at least five themes");
  ok("splash + all 9 gaze frames + blink data + typing + hint");
}

// Deterministic turn engine: never hit a real provider.
const sessMock = getSession();
const realSendAll = sessMock.sendUserMessage;
sessMock.sendUserMessage = function(text: string, callbacks: any) {
  this.interrupted = false;
  this.addMessage({ role: "user", content: text });
  this.turnCount++;
  if (callbacks && callbacks.onReasoning) callbacks.onReasoning("Considering " + String(text).slice(0, 28));
  if (callbacks && callbacks.onDelta) callbacks.onDelta("Here is the answer to " + String(text).slice(0, 28));
  return new Promise((res) => setTimeout(() => res({ type: "success", content: "Here is the answer to " + String(text).slice(0, 28) }), 100));
};

header("2: slash popup opens");
{
  resetUi();
  setup.mockInput.typeText("/");
  await sleep(180);
  console.assert(suggestions().length > 0 && autoKind() === "slash", "FAIL: slash autocomplete did not populate");
  const f = await waitForFrame(x => x.includes("/help"), "slash popup rows");
  console.assert(f.includes("/help"), "FAIL: /help row missing");
  ok("slash popup");
}

header("3: slash popup filters");
{
  resetUi();
  setup.mockInput.typeText("/");
  await sleep(120);
  setup.mockInput.typeText("com");
  await sleep(160);
  console.assert(input() === "/com", "FAIL: input mismatch, got " + JSON.stringify(input()));
  console.assert(suggestions().length > 0, "FAIL: no filtered suggestions");
  console.assert(suggestions().every(s => s.label.startsWith("/com")), "FAIL: filter leaked non-matching rows");
  ok("popup filters");
}

header("4: escape closes the popup");
{
  resetUi();
  setup.mockInput.typeText("/");
  await sleep(120);
  setup.mockInput.pressEscape();
  await sleep(150);
  console.assert(suggestions().length === 0 && autoKind() === "none", "FAIL: escape should close the popup");
  ok("escape closes popup");
}

header("5: tab moves the popup selection");
{
  resetUi();
  setup.mockInput.typeText("/");
  await sleep(140);
  setup.mockInput.pressTab();
  await sleep(140);
  console.assert(autoIndex() > 0, "FAIL: tab should advance autoIndex, got " + autoIndex());
  setup.mockInput.pressEscape();
  await sleep(200);
  ok("tab navigates popup");
}

header("6: /help executes and docks the composer");
{
  resetUi();
  setup.mockInput.typeText("/help");
  await sleep(200);
  setup.mockInput.pressEnter();
  await sleep(350);
  console.assert(messages().length > 0, "FAIL: /help should append a system message");
  const f = await waitForFrame(x => x.includes("Ask anything..."), "docked composer");
  console.assert(f.includes("Ask anything..."), "FAIL: composer should dock after the first message");
  const help = messages().map((m: any) => String(m.content || "")).join("\n");
  console.assert(help.includes("/help"), "FAIL: help text missing from the transcript");
  ok("/help renders and docks composer");
}

header("7: plain prompt runs a mock turn");
{
  resetUi();
  setup.mockInput.typeText("hello world");
  await sleep(100);
  setup.mockInput.pressEnter();
  await waitFor(() => messages().length >= 2 && !thinking(), "mock turn");
  const f = await waitForFrame(x => x.includes("Here is the answer"), "assistant reply");
  console.assert(f.includes("> hello world"), "FAIL: user bar missing");
  console.assert(f.includes("Here is the answer"), "FAIL: assistant reply missing");
  ok("prompt renders user bar + reply");
}

header("8: thinking row expands on click");
{
  resetUi();
  setMessages([{
    role: "assistant", content: "done", parts: [
      { type: "reasoning", text: "step one\nstep two\nstep three\nhidden-tail", thinkMs: 12 },
    ],
  }]);
  await sleep(200);
  const f0 = await waitForFrame(x => x.includes("Thinking"), "thinking row");
  console.assert(f0.includes("step one"), "FAIL: thinking preview missing");
  console.assert(!f0.includes("hidden-tail"), "FAIL: collapsed thinking leaked its tail");
  const rows = f0.split("\n");
  const y = rows.findIndex(l => l.includes("Thinking"));
  const x = rows[y].indexOf("Thinking") + 2;
  await setup.mockMouse.click(x, y);
  const f1 = await waitForFrame(x => x.includes("hidden-tail"), "expanded thinking");
  console.assert(f1.includes("hidden-tail"), "FAIL: click should expand thinking");
  const rows1 = f1.split("\n");
  const y1 = rows1.findIndex(l => l.includes("Thinking"));
  const x1 = rows1[y1].indexOf("Thinking") + 2;
  await setup.mockMouse.click(x1, y1);
  const f2 = await waitForFrame(x => !x.includes("hidden-tail"), "collapsed thinking");
  console.assert(!f2.includes("hidden-tail"), "FAIL: second click should collapse thinking");
  console.assert(f2.includes("step one"), "FAIL: collapsed preview should remain");
  ok("thinking toggles open and closed");
}

header("9: running tool streams live output");
{
  resetUi();
  setMessages([{
    role: "assistant", content: "", parts: [
      { type: "tool", tool: { name: "bash", label: "echo hi", status: "running", liveOutput: "alpha\nbeta" } },
    ],
  }]);
  const f = await waitForFrame(x => x.includes("alpha") && x.includes("beta"), "live tool output");
  console.assert(f.includes("echo hi"), "FAIL: tool label missing");
  console.assert(f.includes("2 lines"), "FAIL: live line counter missing");
  ok("live output streams");
}

header("10: completed tool renders an output block");
{
  resetUi();
  const out = Array.from({ length: 14 }, (_, i) => "out line " + (i + 1)).join("\n");
  setMessages([{
    role: "assistant", content: "", parts: [
      { type: "tool", tool: { name: "bash", label: "run tests", status: "done", output: out } },
    ],
  }]);
  const f = await waitForFrame(x => x.includes("out line 1"), "tool output block");
  console.assert(f.includes("run tests"), "FAIL: completed tool label missing");
  console.assert(!f.includes("out line 14"), "FAIL: output block should clip past maxLines");
  console.assert(/more — click|click/.test(f), "FAIL: overflow hint missing");
  ok("completed tool output");
}

header("11: markdown headings, bullets and code");
{
  resetUi();
  setMessages([{ role: "assistant", content: "## Heading\n\n- one\n- two\n\n```js\nconst x = 1;\n```" }]);
  const f = await waitForFrame(x => x.includes("Heading") && x.includes("const x = 1;"), "markdown body");
  console.assert(f.includes("Heading"), "FAIL: heading missing");
  console.assert(f.includes("one") && f.includes("two"), "FAIL: bullets missing");
  console.assert(f.includes("┌─ js"), "FAIL: fenced code language missing");
  ok("markdown renders");
}

header("12: markdown inline bold and code");
{
  resetUi();
  setMessages([{ role: "assistant", content: "This is **bold** and `inline-code`." }]);
  const f = await waitForFrame(x => x.includes("bold") && x.includes("inline-code"), "inline markdown");
  console.assert(f.includes("bold"), "FAIL: bold text missing");
  console.assert(f.includes("inline-code"), "FAIL: inline code missing");
  ok("inline markdown");
}

header("13: patch block renders diff lines");
{
  resetUi();
  setMessages([{
    role: "assistant", content: "", fileDiffs: [{
      path: "src/a.ts", added: 1, removed: 1,
      lines: [{ kind: "add", text: "new line" }, { kind: "del", text: "old line" }],
    }],
  }]);
  const f = await waitForFrame(x => x.includes("src/a.ts"), "patch block");
  console.assert(f.includes("+ new line"), "FAIL: added line missing");
  console.assert(f.includes("- old line"), "FAIL: removed line missing");
  ok("patch block");
}

header("14: todo block renders tasks");
{
  resetUi();
  setMessages([{
    role: "assistant", content: "", todos: [
      { text: "step one", done: true },
      { text: "step two", inProgress: true },
    ],
  }]);
  const f = await waitForFrame(x => x.includes("step one") && x.includes("step two"), "todo block");
  console.assert(f.includes("tasks"), "FAIL: todo title missing");
  ok("todo block");
}

header("15: long prompt collapses and ctrl+e expands");
{
  resetUi();
  const long = Array.from({ length: 20 }, (_, i) => "prompt line " + (i + 1)).join("\n");
  setMessages([{ role: "user", content: long }]);
  const f0 = await waitForFrame(x => x.includes("20 lines"), "collapsed prompt");
  console.assert(f0.includes("prompt line 1"), "FAIL: prompt preview missing");
  console.assert(!f0.includes("prompt line 20"), "FAIL: long prompt should collapse");
  setup.mockInput.pressKey("e", { ctrl: true });
  const f1 = await waitForFrame(x => x.includes("prompt line 20"), "expanded prompt");
  console.assert(f1.includes("prompt line 20"), "FAIL: ctrl+e should expand the prompt");
  ok("prompt collapse/expand");
}

header("16: permission gate approves with 1");
{
  resetUi();
  const p = requestPermission("bash", "echo hi", "Run echo");
  const f = await waitForFrame(x => x.includes("Permission needed") && x.includes("echo hi"), "permission gate");
  console.assert(f.includes("Permission needed"), "FAIL: gate title missing");
  setup.mockInput.typeText("1");
  const r = await p;
  console.assert(r.approved === true, "FAIL: pressing 1 should approve");
  await waitFor(() => !permission(), "gate closed");
  ok("permission approve");
}

header("17: permission gate denies with escape");
{
  resetUi();
  const p = requestPermission("bash", "rm -rf build", "Remove build");
  await waitForFrame(x => x.includes("rm -rf build"), "deny gate");
  setup.mockInput.pressEscape();
  const r = await p;
  console.assert(r.approved === false, "FAIL: escape should deny");
  await waitFor(() => !permission(), "gate closed");
  ok("permission deny");
}

header("18: settings modal toggles tool details and vim");
{
  resetUi();
  await runSlash("/settings");
  console.assert(modal()?.type === "settings", "FAIL: /settings should open the settings modal");
  const f = await waitForFrame(x => x.includes("Tool details"), "settings modal");
  console.assert(f.includes("Thinking"), "FAIL: thinking toggle missing");
  console.assert(f.includes("Vim editing"), "FAIL: vim toggle missing");
  const vimBefore = vimMode();
  setup.mockInput.typeText("v");
  await sleep(120);
  console.assert(vimMode() !== vimBefore, "FAIL: v should toggle vim editing");
  setup.mockInput.typeText("v");
  await sleep(120);
  console.assert(vimMode() === vimBefore, "FAIL: v should toggle vim editing back");
  setup.mockInput.typeText("d");
  await sleep(120);
  console.assert(showToolDetails() === false, "FAIL: d should toggle tool details off");
  setup.mockInput.pressEscape();
  await sleep(120);
  console.assert(modal() == null, "FAIL: escape should close settings");
  setShowToolDetails(true);
  ok("settings modal");
}

header("19: /connect opens the provider picker");
{
  resetUi();
  await runSlash("/connect");
  console.assert(modal()?.type === "provider", "FAIL: /connect should open the provider picker");
  const f = await waitForFrame(x => /Anthropic|OpenAI|Google/.test(x), "provider rows");
  console.assert(/Anthropic|OpenAI|Google/.test(f), "FAIL: provider labels missing");
  closeModal();
  ok("provider picker");
}

header("20: /models opens the model picker");
{
  resetUi();
  await runSlash("/models");
  console.assert(modal()?.type === "select", "FAIL: /models should open a select modal");
  console.assert(String(modal()?.title || "").includes("Model"), "FAIL: model picker title missing");
  closeModal();
  ok("model picker");
}

header("21: /agents reports available agents");
{
  resetUi();
  await runSlash("/agents");
  const text = messages().map(m => String(m.content || "")).join("\n");
  console.assert(text.length > 0, "FAIL: /agents should append a report");
  console.assert(/general|explore|scout/i.test(text), "FAIL: agent list missing from report");
  ok("agents report");
}

header("22: /mcp opens the MCP modal");
{
  resetUi();
  await runSlash("/mcp");
  console.assert(modal()?.type === "mcp", "FAIL: /mcp should open the MCP modal");
  const f = await waitForFrame(x => x.toLowerCase().includes("mcp"), "mcp modal");
  console.assert(f.toLowerCase().includes("mcp"), "FAIL: MCP title missing");
  closeModal();
  ok("mcp modal");
}

header("23: /sandbox opens the sandbox wizard");
{
  resetUi();
  await runSlash("/sandbox");
  console.assert(modal()?.type === "sandbox", "FAIL: /sandbox should open the sandbox modal");
  closeModal();
  ok("sandbox wizard");
}

header("24: /subagents opens the panel without recursion");
{
  resetUi();
  await runSlash("/subagents");
  console.assert(modal()?.type === "subagents", "FAIL: /subagents should open the subagent panel");
  const before = messages().length;
  await sleep(250);
  console.assert(messages().length === before, "FAIL: /subagents must not recurse or append messages");
  closeModal();
  ok("subagents panel");
}

header("25: /editor reports the configured editor");
{
  resetUi();
  await runSlash("/editor");
  const text = messages().map(m => String(m.content || "")).join("\n");
  console.assert(text.length > 0, "FAIL: /editor should append the editor command");
  console.assert(/editor|code|vim|nano|notepad/i.test(text), "FAIL: editor command missing");
  ok("editor command");
}

header("26: /theme picker lists themes and switches");
{
  resetUi();
  await runSlash("/theme");
  console.assert(modal()?.type === "select", "FAIL: /theme should open a select modal");
  const opts = modal()?.options || [];
  console.assert(opts.length === themeOptions().length, "FAIL: theme options mismatch");
  const ids = opts.map((o: any) => String(o.value || o.label).toLowerCase()).join(",");
  for (const id of Object.keys(THEMES)) {
    console.assert(ids.includes(id), "FAIL: missing theme " + id);
  }
  const before = palette().bg;
  setup.mockInput.pressArrow("down");
  await sleep(120);
  setup.mockInput.pressEnter();
  await sleep(250);
  console.assert(themeName() !== "loom", "FAIL: selecting another theme should change themeName, got " + themeName());
  console.assert(palette().bg !== before, "FAIL: palette should change with the theme");
  setTheme("loom");
  ok("theme switch");
}

header("27: /plan switches the mode row");
{
  resetUi();
  await runSlash("/plan");
  console.assert(inputMode() === "plan", "FAIL: /plan should switch input mode");
  const f = await waitForFrame(x => x.includes("Plan") && x.includes("Act"), "mode row");
  console.assert(f.includes("Plan"), "FAIL: Plan label missing");
  setup.mockInput.pressTab();
  await sleep(150);
  console.assert(inputMode() === "chat", "FAIL: tab should cycle plan -> chat, got " + inputMode());
  await runSlash("/build");
  console.assert(inputMode() === "build", "FAIL: /build should restore build mode");
  ok("mode cycling");
}

header("28: shift+tab toggles auto-approve");
{
  resetUi();
  setup.mockInput.pressTab({ shift: true });
  await sleep(180);
  console.assert(autoPerm() === true, "FAIL: shift+tab should enable auto-approve");
  const f1 = await waitForFrame(x => x.includes("Auto-approve all enabled"), "auto on row");
  console.assert(f1.includes("Auto-approve all enabled"), "FAIL: auto-on status missing");
  setup.mockInput.pressTab({ shift: true });
  await sleep(180);
  console.assert(autoPerm() === false, "FAIL: shift+tab should disable auto-approve");
  const f2 = await waitForFrame(x => x.includes("Auto-approve off"), "auto off row");
  console.assert(f2.includes("Auto-approve off"), "FAIL: auto-off status missing");
  ok("auto-approve toggle");
}

header("29: long paste compresses in the composer");
{
  resetUi();
  const big = Array.from({ length: 15 }, (_, i) => "paste line " + (i + 1)).join("\r\n");
  setup.mockInput.pasteBracketedText(big);
  await sleep(200);
  const f = await waitForFrame(x => x.includes("pasted ~15 lines"), "compressed paste");
  console.assert(f.includes("paste line 1"), "FAIL: paste preview missing");
  console.assert(input().split("\n").length === 15, "FAIL: full pasted draft should be preserved");
  setup.mockInput.pressEscape();
  await sleep(250);
  ok("paste compression");
}

header("30: ctrl+p opens the command deck");
{
  resetUi();
  setup.mockInput.pressKey("p", { ctrl: true });
  await sleep(200);
  console.assert(modal()?.type === "palette", "FAIL: ctrl+p should open the command deck");
  const f = await waitForFrame(x => /command/i.test(x), "command deck");
  console.assert(/command/i.test(f), "FAIL: command deck content missing");
  closeModal();
  ok("command deck");
}

header("31: @ mention popup lists agents");
{
  resetUi();
  setup.mockInput.typeText("@exp");
  await sleep(220);
  console.assert(autoKind() === "at", "FAIL: @ should switch autocomplete to at-mode, got " + autoKind());
  console.assert(suggestions().some(s => s.label.startsWith("@explore")), "FAIL: @explore suggestion missing");
  setup.mockInput.pressEscape();
  await sleep(200);
  ok("@ mention popup");
}

header("32: /clear asks before wiping the session");
{
  resetUi();
  await runSlash("/clear");
  console.assert(modal()?.type === "select", "FAIL: /clear should open a confirm modal");
  console.assert(String(modal()?.title || "").includes("Clear session"), "FAIL: confirm title missing");
  setup.mockInput.pressEscape();
  await sleep(120);
  console.assert(messages().length === 0, "FAIL: escape must keep the session");
  ok("clear confirm");
}

header("33: /vim toggles vim mode and NORMAL edits work");
{
  resetUi();
  await runSlash("/vim");
  console.assert(vimMode() === true, "FAIL: /vim should enable vim mode");
  setup.mockInput.typeText("abc");
  await sleep(100);
  setup.mockInput.pressEscape();
  await sleep(100);
  console.assert(vimNormal() === true, "FAIL: escape should enter vim NORMAL");
  setup.mockInput.typeText("0");
  setup.mockInput.typeText("x");
  await sleep(100);
  console.assert(input() === "bc", "FAIL: vim x should delete under cursor, got " + JSON.stringify(input()));
  setup.mockInput.typeText("i");
  await sleep(80);
  console.assert(vimNormal() === false, "FAIL: i should return to INSERT");
  setDraft("");
  await runSlash("/vim");
  console.assert(vimMode() === false, "FAIL: /vim should disable vim mode");
  ok("vim toggle + normal edits");
}

header("34: API key editor shows plaintext while typing");
{
  resetUi();
  await runSlash("/key");
  console.assert(modal()?.type === "input", "FAIL: /key should open an input modal");
  setup.mockInput.pasteBracketedText("sk-plain-123");
  await sleep(200);
  const f = await waitForFrame(x => x.includes("sk-plain-123"), "plaintext key");
  console.assert(f.includes("sk-plain-123"), "FAIL: API key should render as plaintext");
  console.assert(!f.includes("xxxxxxxx"), "FAIL: API key must not be masked");
  setup.mockInput.pressEscape();
  await sleep(250);
  ok("plaintext key");
}

header("35: custom model id flow accepts arbitrary ids");
{
  resetUi();
  await runSlash("/models");
  const m = modal();
  const custom = (m?.options || []).find((o: any) => o.value === "__custom__");
  console.assert(!!custom, "FAIL: custom model option missing");
  if (custom) {
    m.onPick("__custom__", custom);
    await sleep(150);
    console.assert(modal()?.type === "input", "FAIL: custom option should open an input modal");
    setup.mockInput.pasteBracketedText("deepseek-ai/deepseek-v4-flash");
    await sleep(150);
    setup.mockInput.pressEnter();
    await sleep(250);
    const t = toasts().map(x => String(x.text)).join("|");
    console.assert(/deepseek-ai\/deepseek-v4-flash|Model:/.test(t), "FAIL: custom model id toast missing, got: " + t);
  }
  closeModal();
  ok("custom model id");
}

header("36: long transcripts scroll without crashing");
{
  resetUi();
  setMessages(Array.from({ length: 70 }, (_, i) => ({ role: "user", content: "message " + (i + 1) })));
  const f = await waitForFrame(x => x.includes("message 70"), "tail of long transcript");
  console.assert(f.includes("message 70"), "FAIL: newest message should be visible");
  setup.mockInput.pressArrow("up");
  await sleep(120);
  setup.mockInput.pressArrow("down");
  await sleep(120);
  ok("long transcript scroll");
}

header("37: escape on a question cancels without inventing an answer");
{
  resetUi();
  const p = requestPermission("ask", "Pick a path", "", true, ["Alpha", "Beta"]);
  await waitForFrame(x => x.includes("Pick a path"), "question gate");
  setup.mockInput.pressEscape();
  const r = await p;
  console.assert(r.approved === false, "FAIL: escape should cancel the question");
  console.assert(r.note === "", "FAIL: escape must not feed '(esc)' back as the answer, got: " + r.note);
  ok("question escape");
}

header("38: permission selection resets between requests");
{
  resetUi();
  const p1 = requestPermission("bash", "echo one", "Run one");
  await waitForFrame(x => x.includes("echo one"), "first gate");
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressEscape();
  const r1 = await p1;
  console.assert(r1.approved === false, "FAIL: escape should deny the first request");
  const p2 = requestPermission("bash", "echo two", "Run two");
  await waitForFrame(x => x.includes("echo two"), "second gate");
  setup.mockInput.pressEnter();
  const r2 = await p2;
  console.assert(r2.approved === true, "FAIL: second request should start at Allow once, not a stale Deny");
  console.assert(autoPerm() === false, "FAIL: stale selection must not enable auto-approve");
  ok("permission selection reset");
}

header("39: concurrent permission requests queue instead of overwriting");
{
  resetUi();
  const p1 = requestPermission("bash", "echo first", "Run first");
  await waitForFrame(x => x.includes("echo first"), "first queued gate");
  const p2 = requestPermission("bash", "echo second", "Run second");
  await sleep(80);
  console.assert(permission()?.command === "echo first", "FAIL: second request should wait for the first");
  setup.mockInput.typeText("1");
  const r1 = await p1;
  console.assert(r1.approved === true, "FAIL: first queued request should approve");
  await waitForFrame(x => x.includes("echo second"), "second queued gate");
  setup.mockInput.typeText("3");
  const r2 = await p2;
  console.assert(r2.approved === false, "FAIL: second queued request should deny");
  ok("permission queue");
}

header("40: numeric keys answer question options");
{
  resetUi();
  const p = requestPermission("ask", "Pick a color", "", true, ["Red", "Green"]);
  await waitForFrame(x => x.includes("Pick a color"), "question options");
  setup.mockInput.typeText("2");
  const r = await p;
  console.assert(r.approved === true, "FAIL: picking an option should answer the question");
  console.assert(r.note === "Green", "FAIL: numeric option should resolve to Green, got: " + r.note);
  ok("question numeric options");
}

header("41: compaction row expands on click like thinking");
{
  resetUi();
  setMessages([
    { role: "user", content: "long task" },
    {
      role: "system",
      content: "Compacted (summary): summarized 24 earlier messages.",
      compaction: {
        method: "summary",
        removed: 24,
        tokensBefore: 80000,
        tokensAfter: 12000,
        summary: "step one\nstep two\nstep three\nhidden-compaction-tail",
      },
    },
  ]);
  await sleep(200);
  const f0 = await waitForFrame(x => x.includes("Compaction"), "compaction row");
  console.assert(f0.includes("step one"), "FAIL: compaction preview missing");
  console.assert(!f0.includes("hidden-compaction-tail"), "FAIL: collapsed compaction leaked its summary tail");
  const rows = f0.split("\n");
  const y = rows.findIndex(l => l.includes("Compaction"));
  const x = rows[y].indexOf("Compaction") + 2;
  await setup.mockMouse.click(x, y);
  const f1 = await waitForFrame(x => x.includes("hidden-compaction-tail"), "expanded compaction");
  console.assert(f1.includes("hidden-compaction-tail"), "FAIL: click should expand the compaction summary");
  const rows1 = f1.split("\n");
  const y1 = rows1.findIndex(l => l.includes("Compaction"));
  const x1 = rows1[y1].indexOf("Compaction") + 2;
  await setup.mockMouse.click(x1, y1);
  const f2 = await waitForFrame(x => !x.includes("hidden-compaction-tail"), "collapsed compaction");
  console.assert(!f2.includes("hidden-compaction-tail"), "FAIL: second click should collapse the compaction summary");
  console.assert(f2.includes("step one"), "FAIL: collapsed compaction preview should remain");
  ok("compaction toggles open and closed");
}

header("42: /review runs the reviewer agent with the review prompt");
{
  resetUi();
  const before = getSession().messages.length;
  await runSlash("/review");
  await waitFor(
    () => !thinking() && messages().some(m => m.role === "assistant" && m.agentLabel === "reviewer"),
    "review turn"
  );
  const ui = messages();
  const userBubble = ui.find(m => m.role === "user" && String(m.content || "").startsWith("/review"));
  console.assert(!!userBubble, "FAIL: /review should show a concise user bubble");
  const asst = ui.find(m => m.role === "assistant" && m.agentLabel === "reviewer");
  console.assert(!!asst, "FAIL: /review should run as the reviewer agent");
  const sent = getSession().messages.slice(before).map((m: any) => String(m.content || "")).join("\n");
  console.assert(sent.includes("You are a code reviewer"), "FAIL: review prompt missing");
  console.assert(sent.includes("uncommitted changes"), "FAIL: default review target missing");
  console.assert(!sent.includes("$ARGUMENTS"), "FAIL: review prompt left $ARGUMENTS unsubstituted");
  ok("review command");
}

console.log("");
sessMock.sendUserMessage = realSendAll;
timings.push({ name: curTest, ms: Date.now() - curTestStart });
if (assertFails === 0) {
  console.log("ALL " + testCount + " TESTS PASSED — run good");
  printSummary();
  process.exit(0);
} else {
  console.log(assertFails + " assertion(s) FAILED");
  printSummary();
  process.exit(1);
}
