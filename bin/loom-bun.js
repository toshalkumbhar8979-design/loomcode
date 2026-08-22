#!/usr/bin/env bun
// Loom Code primary launcher — runs under BUN directly (npm cmd-shims honor
// this shebang). One process owns stdin/stdout end-to-end, so the Windows
// console mode problems caused by the previous node -> spawnSync(bun) chain
// cannot occur.
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