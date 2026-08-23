#!/usr/bin/env bun
// Loom TUI direct entry — runs under BUN in-process (see bin/loom-bun.js).
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.BUN_CONFIG = join(__dirname, "..", "bunfig.toml");

import "../src/tui-preload.js";
await import("../src/tui-open.tsx");
