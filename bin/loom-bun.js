#!/usr/bin/env bun
// Loom Code primary launcher — runs under BUN directly (npm cmd-shims honor
// this shebang). One process owns stdin/stdout end-to-end.
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Ensure Bun finds our bunfig.toml (which loads @opentui/solid/preload)
// regardless of the user's current working directory.
const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.BUN_CONFIG = join(__dirname, "..", "bunfig.toml");

import { createRequire } from "module";
const require = createRequire(import.meta.url);
process.title = "loom-code";
try {
  const { main } = require("../src/core/cli.js");
  await main();
} catch (err) {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
}