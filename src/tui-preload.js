// Loaded via bunfig.toml preload BEFORE any app code, so this replaces the
// old CJS bootstrap hop entirely: the launch chain stays a plain direct
// "bun src/tui-open.tsx" (identical shape to repo runs) while we still get
// to restore the user's project directory early and keep the crash
// black-box watching.
const fs = require("fs");
const os = require("os");
const path = require("path");

if (process.platform === "win32") {
  // UTF-8 console codepage: legacy CPs render the box-drawing logo as "?"
  // garbage and can mangle VT input sequences.
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

if (process.env.LOOM_START_CWD) {
  try { process.chdir(process.env.LOOM_START_CWD); } catch {}
}

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
globalThis.__loomTrace = record;
process.on("uncaughtException", (e) => record("uncaughtException", e));
process.on("unhandledRejection", (r) => record("unhandledRejection", r));

const __hbStart = Date.now();
let __hbTick = 0;
let __hbScheduled = __hbStart;
const __hbTimer = setInterval(() => {
  const now = Date.now();
  record("heartbeat", new Error(`tick=${++__hbTick} lag=${now - __hbScheduled}ms uptime=${now - __hbStart}ms`));
  __hbScheduled = now + 3000;
}, 3000);
try { __hbTimer.unref?.(); } catch {}
process.on("exit", () => { try { record("exit", new Error(`uptime=${Date.now() - __hbStart}ms ticks=${__hbTick}`)); } catch {} });
