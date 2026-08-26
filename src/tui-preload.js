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

// Global npm installs live INSIDE node_modules, and @opentui/solid's loader
// filter deliberately skips every node_modules path — so for installs the
// app's own TSX would fall through to Bun's default React JSX transform and
// crash at startup ("Cannot find module 'react/jsx-dev-runtime'").
//
// This preload is THE single registration point for the TUI launch chain
// (shims and respawns pass ONLY this file via --preload, with an absolute
// path), so it registers both plugins itself:
//   1. The Solid JSX plugin — via the bare "@opentui/solid/bun-plugin"
//      specifier, which resolves by walking up from this file and therefore
//      works whether the dependency is nested inside the package or hoisted
//      to the install root. Idempotent (symbol-guarded upstream).
//   2. A supplemental loader scoped to THIS package's src directory only —
//      real dependencies are never touched. It is a no-op in repo checkouts,
//      where the solid plugin (non-node_modules paths) already handles these
//      files first.
if (typeof Bun !== "undefined" && Bun.plugin) {
  try {
    require("@opentui/solid/bun-plugin").ensureSolidTransformPlugin();
  } catch {}
  if (!globalThis.__loomAppTsxPlugin) {
    try {
      globalThis.__loomAppTsxPlugin = true;
      const pkgSrc = __dirname; // tui-preload.js lives in src/
      const pkgRoot = path.join(pkgSrc, "..");
      const esc = pkgSrc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Layout-proof transform lookup: nested (npm i -g default observed)
      // and hoisted (top-level install node_modules) candidates.
      const candidates = [
        path.join(pkgRoot, "node_modules", "@opentui", "solid", "scripts", "solid-transform.js"),
        path.join(pkgRoot, "..", "..", "@opentui", "solid", "scripts", "solid-transform.js"),
      ];
      let transformSolidSource = null;
      for (const c of candidates) {
        try { transformSolidSource = require(c).transformSolidSource; break; } catch {}
      }
      if (transformSolidSource) {
        Bun.plugin({
          name: "loom-app-solid-tsx",
          setup(build) {
            build.onLoad({ filter: new RegExp("^" + esc + "[\\\\/].+\\.tsx$") }, async (args) => {
              const code = await Bun.file(args.path).text();
              const contents = await transformSolidSource(code, {
                filename: args.path,
                moduleName: "@opentui/solid",
              });
              return { contents, loader: "js" };
            });
          },
        });
      }
    } catch {}
  }
}

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