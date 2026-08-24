#!/usr/bin/env bun
// npm invokes bin targets through Node on Windows, so re-launch under Bun
// when this file was not started by Bun itself.
const path = require("path");
const { spawnSync } = require("child_process");

// Node-shim path only — never respawn when already under bun (see
// bin/loom-bun.js for why: the console handoff breaks OpenTUI's terminal
// capability handshake and freezes the splash).
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
		console.error("[loom] Bun is required for the TUI. Install it from https://bun.sh/");
		process.exit(1);
	}
	process.exit(result.status == null ? 1 : result.status);
}

// Under bun at the user's cwd — bunfig.toml wasn't discovered, so register
// the preload chain manually (same order as bunfig.toml).
require(path.join(__dirname, "..", "src", "tui-preload.js"));
require("@opentui/solid/preload");

if (process.env.LOOM_START_CWD) {
	try { process.chdir(process.env.LOOM_START_CWD); } catch {}
}

(async () => { await import("../src/tui-open.tsx"); })();
