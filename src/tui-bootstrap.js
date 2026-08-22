// Bootstrap shim for globally-installed launches.
//
// Bun only discovers bunfig.toml / tsconfig.json by walking UP from its
// working directory. When installed via npm the package lives outside the
// user's project tree, so launchers start bun from the PACKAGE root (where
// those files ship) and hand the real project directory through
// LOOM_START_CWD. This file must stay import-free so the chdir happens
// before any Loom module (which may read cwd at import time) executes.
const fs = require("fs");
const os = require("os");
const path = require("path");

if (process.env.LOOM_START_CWD) {
  try { process.chdir(process.env.LOOM_START_CWD); } catch {}
}

// Windows consoles default to a legacy codepage where the box-drawing /
// block glyphs used across the TUI render as "?" garbage, and VT input
// sequences (arrows, ctrl combos, bracketed paste) may never arrive. Switch
// both console CPs to UTF-8 before anything renders or reads stdin.
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

// Crash black-box: OpenTUI swallows post-render errors, leaving users stuck
// on the splash with no clue why. Persist every uncaught failure to disk so
// a frozen TUI can be diagnosed after the fact.
const crashPath = () => path.join(os.homedir(), ".loom", "tui-crash.log");
function record(kind, err) {
  try {
    fs.mkdirSync(path.dirname(crashPath()), { recursive: true });
    fs.appendFileSync(
      crashPath(),
      `[${new Date().toISOString()}] ${kind}: ${(err && (err.stack || err.message)) || String(err)}\n`
    );
  } catch {}
}
process.on("uncaughtException", (e) => { record("uncaughtException", e); });
process.on("unhandledRejection", (r) => { record("unhandledRejection", r); });
globalThis.__loomTrace = record;

// Watchdog: append a heartbeat every 3s carrying measured event-loop lag.
// A synchronous hang shows up as a timestamp gap exactly covering the
// blocking phase; markers around it name the guilty step.
const __hbStart = Date.now();
let __hbTick = 0;
let __hbScheduled = __hbStart;
const __hbTimer = setInterval(() => {
  const now = Date.now();
  const lag = now - __hbScheduled;
  record("heartbeat", new Error(`tick=${++__hbTick} lag=${lag}ms uptime=${now - __hbStart}ms`));
  __hbScheduled = now + 3000;
}, 3000);
try { __hbTimer.unref?.(); } catch {}
process.on("exit", () => { try { record("exit", new Error(`uptime=${Date.now() - __hbStart}ms ticks=${__hbTick}`)); } catch {} });

record("boot", new Error(
  `argv=${JSON.stringify(process.argv.slice(1))} cwd=${process.cwd()} ` +
  `startCwd=${process.env.LOOM_START_CWD || "-"} bun=${process.version} ` +
  `node=${process.versions.node || "-"} platform=${process.platform}`
));
if (process.env.LOOM_TUI_TRACE) globalThis.__loomTrace = record;

await import("./tui-open.tsx");
