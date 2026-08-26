#!/usr/bin/env bun
// npm invokes bin targets through Node on Windows, so re-launch under Bun
// when this file was not started by Bun itself.
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

// The Solid JSX transform must register in Bun's preload phase, so the
// preloads are passed as ABSOLUTE paths. That lets Bun start directly in the
// user's project directory — the old "spawn at the package root, then chdir
// to the project inside tui-open.tsx" dance froze the TUI after the first
// frame (splash paints once, then no repaints and no keyboard input; proven
// by A/B-launching the identical entry with and without the mid-flight
// process.chdir). No chdir ever happens now: LOOM_START_CWD always equals
// the starting directory, so the restore in tui-open.tsx is a no-op kept
// only as a safety net.
const pkgRoot = path.join(__dirname, "..");
const underBun = typeof Bun !== "undefined" && !!process.versions.bun;
if (!underBun) {
  // Prefer the bundled @oven bun binary (shipped as an optional dep), then
  // whatever bun is on PATH. Without either, still respawn so the inner
  // failure message can guide the user.
  const OVEN = {
    "win32-x64": "bun-windows-x64",
    "win32-arm64": "bun-windows-aarch64",
    "darwin-x64": "bun-darwin-x64",
    "darwin-arm64": "bun-darwin-aarch64",
    "linux-x64": "bun-linux-x64",
    "linux-arm64": "bun-linux-aarch64",
  };
  let bunCmd = process.platform === "win32" ? "bun.exe" : "bun";
  const short = OVEN[process.platform + "-" + process.arch];
  const exe = process.platform === "win32" ? "bun.exe" : "bun";
  const ovenCandidates = short ? [
    path.join(pkgRoot, "node_modules", "@oven", short, "bin", exe),
    path.join(pkgRoot, "..", "@oven", short, "bin", exe),
  ] : [];
  for (const c of ovenCandidates) {
    if (fs.existsSync(c)) { bunCmd = c; break; }
  }
  const result = spawnSync(
    bunCmd,
    [
      "--preload", path.join(pkgRoot, "src", "tui-preload.js"),
      __filename,
      ...process.argv.slice(2),
    ],
    {
      stdio: "inherit",
      cwd: process.env.LOOM_START_CWD || process.cwd(),
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
    // The npm bin entry bypasses src/index.js, so load dotenv here for both
    // the package environment and the project from which `loom` was run.
    const dotenv = require("dotenv");
    dotenv.config({ path: path.join(__dirname, "..", ".env") });
    const startCwd = process.env.LOOM_START_CWD || process.cwd();
    const projectEnv = path.join(startCwd, ".env");
    if (fs.existsSync(projectEnv)) dotenv.config({ path: projectEnv, override: false });
    // The npm global shim can start Bun outside the package directory, so do
    // not depend on bunfig.toml discovery for Windows console setup.
    await import("../src/tui-preload.js");
    const args = process.argv.slice(2);
    const coreMode = args.includes("--basic") || args.includes("-p") || args.includes("--print")
      || args.includes("--help") || args.includes("-h") || args.includes("--version") || args.includes("-v")
      || ["acp", "web", "attach", "graph"].includes(args[0]);
    if (!coreMode) {
      await import("@opentui/solid/preload");
      await import("../src/tui-open.tsx");
      return;
    }
    // Subcommands that must never reach the interactive CLI/TUI: cli.main()
    // has no handler for them and would fall through to launching the full
    // screen app (`loom web` painted the splash instead of serving HTTP).
    if (args[0] === "web") {
      require("../src/web/web-server.js").main();
      return;
    }
    if (args[0] === "acp") {
      require("../src/acp/acp-server.js").main();
      return;
    }
    if (args[0] === "attach") {
      require("../src/web/attach.js").main();
      return;
    }
    const { main } = require("../src/core/cli.js");
    await main();
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
})();