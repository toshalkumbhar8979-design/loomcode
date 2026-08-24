#!/usr/bin/env bun
// npm invokes bin targets through Node on Windows, so re-launch under Bun
// when this file was not started by Bun itself.
const path = require("path");
const { spawnSync } = require("child_process");

// Node-shim path: bun is required for plugins/JSX, so hand off ONCE.
// We deliberately do NOT respawn when already under bun — respawning hands
// the console to a child and OpenTUI's terminal-capability handshake
// (DA1/OSC/DECRQM queries) then gets echoed instead of consumed, leaving a
// frozen splash. Instead we register the Solid JSX plugin programmatically
// below, which is exactly what the bunfig preload would have done.
if (!(typeof Bun !== "undefined" && process.versions.bun)) {
  const result = spawnSync(
    process.platform === "win32" ? "bun.exe" : "bun",
    [__filename, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
      windowsHide: false,
    }
  );
  if (result.error) {
    console.error("[loom] Bun is required for the full CLI. Install it from https://bun.sh/");
    process.exit(1);
  }
  process.exit(result.status == null ? 1 : result.status);
}

// Running under bun at the USER's cwd. bunfig.toml was therefore NOT loaded
// (bun only discovers it from its starting cwd), so register its preload
// chain manually, in the same order, before any app module loads:
//   1. our crash black-box / console fixes
//   2. @opentui/solid/preload — the Solid JSX transform plugin
require(path.join(__dirname, "..", "src", "tui-preload.js"));
require("@opentui/solid/preload");

// Restore the user's project directory before app modules evaluate.
if (process.env.LOOM_START_CWD) {
  try { process.chdir(process.env.LOOM_START_CWD); } catch {}
}

process.title = "loom-code";
(async () => {
  try {
    const { main } = require("../src/core/cli.js");
    await main();
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
})();
