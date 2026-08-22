process.env.LOOM_MCP_NO_WARM = "1";
import { test, expect } from "bun:test";
import os from "os"; import fs from "fs"; import path from "path";
const TMP = path.join(os.tmpdir(), "loom-mem-" + process.pid);
const PREV = process.env.LOOM_CONFIG_DIR;
process.env.LOOM_CONFIG_DIR = path.join(TMP, "cfg");
import * as mem from "./memory.js";
test("global + project layers with @imports", () => {
  fs.mkdirSync(path.join(TMP, "cfg"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "cfg", "LOOM.md"), "# Global rules\n@glossary.md");
  fs.writeFileSync(path.join(TMP, "cfg", "glossary.md"), "- loom: the agent");
  const oldCwd = process.cwd();
  try {
    process.chdir(os.tmpdir());
    fs.writeFileSync(path.join(os.tmpdir(), "LOOM.md"), "# Project\nuse bun");
    const m = mem.loadMemory();
    expect(m).toContain("# Global rules");
    expect(m).toContain("- loom: the agent");
    expect(m).toContain("## Project memory");
    expect(m).toContain("use bun");
    fs.rmSync(path.join(os.tmpdir(), "LOOM.md"));
  } finally { process.chdir(oldCwd); }
});

test("appendMemory writes dated bullets under ## Remembered", () => {
  const oldCwd2 = process.cwd();
  try {
    process.chdir(os.tmpdir());
    fs.rmSync(path.join(os.tmpdir(), "LOOM.md"), { force: true });
    expect(mem.appendMemory("likes bun", "project")).toBe(true);
    expect(mem.appendMemory("hates yaml", "project")).toBe(true);
    const body = fs.readFileSync(path.join(os.tmpdir(), "LOOM.md"), "utf8");
    expect(body).toContain("## Remembered");
    expect(body).toContain("- [");
    expect(body).toContain("likes bun");
    expect(body.split("\n").filter(l => l.startsWith("- [")).length).toBe(2);
    // loads back through the normal memory pipeline
    expect(mem.loadMemory()).toContain("hates yaml");
    fs.rmSync(path.join(os.tmpdir(), "LOOM.md"), { force: true });
  } finally { process.chdir(oldCwd2); }
});