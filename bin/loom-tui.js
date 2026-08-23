#!/usr/bin/env bun
// npm invokes bin targets through Node on Windows, so re-launch under Bun
// when this file was not started by Bun itself.
const path = require("path");
const { spawnSync } = require("child_process");

if (!(typeof Bun !== "undefined" && process.versions.bun)) {
	const result = spawnSync(process.platform === "win32" ? "bun.exe" : "bun", [__filename, ...process.argv.slice(2)], {
		stdio: "inherit",
		cwd: process.cwd(),
		env: process.env,
		windowsHide: false,
	});
	if (result.error) {
		console.error("[loom] Bun is required for the TUI. Install it from https://bun.sh/");
		process.exit(1);
	}
	process.exit(result.status == null ? 1 : result.status);
}

process.env.BUN_CONFIG = path.join(__dirname, "..", "bunfig.toml");
require("../src/tui-preload.js");
(async () => { await import("../src/tui-open.tsx"); })();
