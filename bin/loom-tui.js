#!/usr/bin/env bun
// Loom TUI direct entry — runs under BUN in-process (see bin/loom-bun.js).
import "../src/tui-preload.js";
await import("../src/tui-open.tsx");
