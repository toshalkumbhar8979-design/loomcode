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

// Windows VT-mode re-enable — OPT-IN via LOOM_FORCE_VT=1.
// Off by default: OpenTUI manages its own console modes, and forcing flags
// underneath it can desync its input parsing. Only enable when debugging
// console-mode issues on a specific terminal.
if (process.platform === "win32" && process.env.LOOM_FORCE_VT === "1") {
  try {
    const { dlopen } = require("bun:ffi");
    const k32 = dlopen("kernel32.dll", {
      GetStdHandle: { args: ["int"], returns: "ptr" },
      GetConsoleMode: { args: ["ptr", "ptr"], returns: "int" },
      SetConsoleMode: { args: ["ptr", "uint"], returns: "int" },
    });
    const STD_INPUT_HANDLE = -10;
    const STD_OUTPUT_HANDLE = -11;

    // Output: processed + wrap-at-EOL + VT processing (so ANSI repaints work).
    const ENABLE_PROCESSED_OUTPUT = 0x0001;
    const ENABLE_WRAP_AT_EOL_OUTPUT = 0x0002;
    const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
    // Input: raw-ish mode for OpenTUI — VT input + processed + mouse + window,
    // with line/echo/quick-edit cleared so keys stream and don't echo.
    const ENABLE_PROCESSED_INPUT = 0x0001;
    const ENABLE_MOUSE_INPUT = 0x0010;
    const ENABLE_WINDOW_INPUT = 0x0008;
    const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
    const ENABLE_QUICK_EDIT_MODE = 0x0040;
    const ENABLE_LINE_INPUT = 0x0002;
    const ENABLE_ECHO_INPUT = 0x0004;

    const outH = k32.symbols.GetStdHandle(STD_OUTPUT_HANDLE);
    const inH = k32.symbols.GetStdHandle(STD_INPUT_HANDLE);
    const modeBuf = new Uint32Array(1);
    const modePtr = Bun.ptr(modeBuf);

    if (outH && !outH.isNull && k32.symbols.GetConsoleMode(outH, modePtr)) {
      const cur = modeBuf[0];
      const next = cur | ENABLE_PROCESSED_OUTPUT | ENABLE_WRAP_AT_EOL_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING;
      if (next !== cur) k32.symbols.SetConsoleMode(outH, next);
    }
    if (inH && !inH.isNull && k32.symbols.GetConsoleMode(inH, modePtr)) {
      const cur = modeBuf[0];
      const next = (cur | ENABLE_PROCESSED_INPUT | ENABLE_MOUSE_INPUT | ENABLE_WINDOW_INPUT | ENABLE_VIRTUAL_TERMINAL_INPUT)
        & ~(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_QUICK_EDIT_MODE);
      if (next !== cur) k32.symbols.SetConsoleMode(inH, next);
    }
  } catch {}
}

// NOTE: LOOM_START_CWD is deliberately NOT applied here. Changing the working
// directory before the app's module graph loads breaks how Bun resolves the
// Solid JSX transform (proven: identical entry paints 19KB from repo cwd,
// 0 bytes from a foreign cwd). The restore happens in tui-open.tsx instead —
// as a module-body statement, i.e. AFTER every import has finished loading.

const crashPath = () => path.join(os.homedir(), ".loom", "tui-crash.log");
const MAX_LOG_BYTES = 1024 * 1024; // 1 MB cap, then rotate to .old
function rotateIfNeeded() {
  try {
    const p = crashPath();
    if (fs.existsSync(p) && fs.statSync(p).size > MAX_LOG_BYTES) {
      fs.renameSync(p, p + ".old");
    }
  } catch {}
}
function record(kind, err) {
  try {
    fs.mkdirSync(path.dirname(crashPath()), { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(
      crashPath(),
      `[${new Date().toISOString()}] ${kind}: ${(err && (err.stack || err.message)) || String(err)}\n`
    );
  } catch {}
}
globalThis.__loomTrace = record;
process.on("uncaughtException", (e) => record("uncaughtException", e));
process.on("unhandledRejection", (r) => record("unhandledRejection", r));

// stdout byte-counter: frames flowing = counter climbs. This splits the two
// remaining frozen-splash suspects with certainty — if the counter climbs but
// the screen is frozen, the console is dropping VT repaints (mode flags); if
// the counter is flat, the renderer flush-loop itself is stalled.
let __stdoutBytes = 0;
const __origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, ...rest) {
  try {
    if (typeof chunk === "string") __stdoutBytes += Buffer.byteLength(chunk, "utf8");
    else if (chunk && chunk.length) __stdoutBytes += chunk.length;
  } catch {}
  return __origWrite(chunk, ...rest);
};

const __hbStart = Date.now();
let __hbTick = 0;
let __hbScheduled = __hbStart;
const __hbTimer = setInterval(() => {
  const now = Date.now();
  record("heartbeat", new Error(`tick=${++__hbTick} lag=${now - __hbScheduled}ms uptime=${now - __hbStart}ms stdoutBytes=${__stdoutBytes}`));
  __hbScheduled = now + 3000;
}, 3000);
try { __hbTimer.unref?.(); } catch {}
process.on("exit", () => { try { record("exit", new Error(`uptime=${Date.now() - __hbStart}ms ticks=${__hbTick} stdoutBytes=${__stdoutBytes}`)); } catch {} });