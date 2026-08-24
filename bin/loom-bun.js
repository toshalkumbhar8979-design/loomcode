#!/usr/bin/env bun
// npm invokes bin targets through Node on Windows, so re-launch under Bun
// when this file was not started by Bun itself.
const path = require("path");
const { spawnSync } = require("child_process");

// Bun discovers bunfig.toml ONLY from its starting cwd, and the Solid JSX
// plugin ONLY works when loaded through that bunfig preload phase — runtime
// registration from another cwd silently no-ops (proven). So unless bun is
// ALREADY sitting in the package root, respawn it there once. The user's
// real directory rides along in LOOM_START_CWD and is restored by
// tui-open.tsx after its imports finish loading.
const pkgRoot = path.join(__dirname, "..");
const underBun = typeof Bun !== "undefined" && !!process.versions.bun;
const inPkgRoot = path.resolve(process.cwd()) === path.resolve(pkgRoot);
if (!underBun || !inPkgRoot) {
  const result = spawnSync(
    process.platform === "win32" ? "bun.exe" : "bun",
    [__filename, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      cwd: pkgRoot,
      env: { ...process.env, LOOM_START_CWD: process.env.LOOM_START_CWD || process.cwd() },
      windowsHide: false,
    }
  );
  if (result.error) {
    console.error("[loom] Bun is required for the full CLI. Install it from https://bun.sh/");
    process.exit(1);
  }
  process.exit(result.status == null ? 1 : result.status);
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
