#!/usr/bin/env bun
// Loom Code — OpenTUI entry point.
// Usage: bun run src/tui-open.tsx [prompt...]  OR  bun src/tui-open.tsx -s <session-id>
import { render } from "@opentui/solid";
import { App } from "./tui/App.tsx";
import { defaultMcpInstall } from "./core/plugin-cmd.js";

const args = process.argv.slice(2);

// Windows: switch both console codepages to UTF-8 so the box-drawing logo
// and VT input sequences work even when launched without the bootstrap
// shim (bun run src/tui-open.tsx). No-op elsewhere / if FFI is unavailable.
if (process.platform === "win32") {
  try {
    const { dlopen } = require("bun:ffi");
    const k32 = dlopen("kernel32.dll", {
      SetConsoleOutputCP: { args: ["uint"], returns: "int" },
      SetConsoleCP: { args: ["uint"], returns: "int" },
    });
    k32.symbols.SetConsoleOutputCP(65001);
    k32.symbols.SetConsoleCP(65001);
  } catch {}
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(`loom-code v${import.meta.require("../package.json").version}`);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log("loom - AI coding agent (OpenTUI edition)");
  console.log("Usage: bun run src/tui-open.tsx [prompt...]");
  console.log("  bun run src/tui-open.tsx            Start interactive TUI");
  console.log("  bun run src/tui-open.tsx \"prompt\"   Start with prompt");
  console.log("  bun run src/tui-open.tsx -s <id>    Resume session");
  console.log("  bun run src/tui-open.tsx -p \"q\"     Print mode (one-shot)");
  console.log("  bun run src/tui-open.tsx --auto     Auto-approve permissions");
  process.exit(0);
}

const pIdx = args.indexOf("-p");
const printMode = pIdx !== -1;
const sIdx = args.indexOf("-s");
const sessionId = sIdx !== -1 ? args[sIdx + 1] : null;
const autoMode = args.includes("--auto") || args.includes("-a");
const initialPrompt = args.filter((a, i) => !a.startsWith("-") && (sIdx === -1 || i !== sIdx + 1)).join(" ");

try {
  defaultMcpInstall();
} catch (e) {
  globalThis.__loomTrace?.("mcp-install-failed", e);
}

if (printMode) {
  const { Session } = require("./core/session.js");
  const sess = new Session();
  if (autoMode) sess.permissions.setAuto(true);
  const query = args[pIdx + 1] || initialPrompt || "Hello";
  const resp = await sess.sendUserMessage(query);
  if (resp.type === "text") console.log(resp.content);
  else console.error(resp.content || "(error)");
  process.exit(resp.type === "error" ? 1 : 0);
}

globalThis.__loomTrace?.("render-start");
render(() => <App initialPrompt={initialPrompt} resumeSession={sessionId} autoMode={autoMode} />, {
  targetFps: 60,
  useMouse: true,
  autoFocus: true,
  exitOnCtrlC: false,
});
globalThis.__loomTrace?.("render-returned");
