#!/usr/bin/env bun
// npm invokes bin targets through Node on Windows, so re-launch under Bun
// when this file was not started by Bun itself.
const path = require("path");
const { spawnSync } = require("child_process");

// Preloads are ABSOLUTE paths so Bun starts directly in the user's project
// directory — see bin/loom-bun.js for why the package-root + chdir dance is
// gone (it froze the TUI after the first frame).
const pkgRoot = path.join(__dirname, "..");
const underBun = typeof Bun !== "undefined" && !!process.versions.bun;
if (!underBun) {
  // Prefer the bundled @oven bun binary (shipped as an optional dep), then
  // whatever bun is on PATH — same scheme as bin/loom-bun.js.
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
    console.error("[loom] Bun is required for the TUI. Install it from https://bun.sh/");
    process.exit(1);
  }
  process.exit(result.status == null ? 1 : result.status);
}

(async () => {
  await import("../src/tui-preload.js");
  await import("@opentui/solid/preload");
  await import("../src/tui-open.tsx");
})();