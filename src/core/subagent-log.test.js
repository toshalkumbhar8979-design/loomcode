// Unit tests for the subagent run log (src/core/subagent-log.js).
process.env.LOOM_MCP_NO_WARM = "1";
process.env.LOOM_MEM_AUTO = "0";
import { test, expect, beforeAll, afterAll } from "bun:test";
import os from "os";
import fs from "fs";
import path from "path";

const CFG_TMP = path.join(os.tmpdir(), "loom-subagent-log-" + process.pid + "-" + Date.now());
const PREV_CFG_DIR = process.env.LOOM_CONFIG_DIR;
process.env.LOOM_CONFIG_DIR = CFG_TMP;

import * as log from "./subagent-log.js";

function entry(over) {
  return Object.assign({
    runId: "run-" + Math.random().toString(36).slice(2, 8),
    agent: "Explore",
    agentId: "explore",
    prompt: "find it",
    status: "done",
    startTime: Date.now(),
    endTime: Date.now() + 1000,
    durationMs: 1000,
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.001,
    interrupted: false,
    content: "answer",
    toolLog: ["grep"],
    sessionId: "conv-1",
  }, over || {});
}

beforeAll(() => {
  fs.mkdirSync(CFG_TMP, { recursive: true });
});

afterAll(() => {
  try { fs.rmSync(CFG_TMP, { recursive: true, force: true }); } catch {}
  if (PREV_CFG_DIR === undefined) delete process.env.LOOM_CONFIG_DIR;
  else process.env.LOOM_CONFIG_DIR = PREV_CFG_DIR;
});

test("save + load roundtrip persists entries to disk", () => {
  expect(log.clearSubagentRuns()).toBe(true);
  const t0 = Date.now();
  const e1 = entry({ runId: "r-1", startTime: t0 });
  const e2 = entry({ runId: "r-2", status: "error", startTime: t0 + 5, endTime: t0 + 1005 });
  expect(log.saveSubagentRun(e1)).toBe(true);
  expect(log.saveSubagentRun(e2)).toBe(true);
  // fresh read from disk (no in-memory cache)
  const rows = log.loadSubagentRuns();
  expect(rows.length).toBe(2);
  // newest first
  expect(rows[0].runId).toBe("r-2");
  expect(rows[1].runId).toBe("r-1");
  expect(JSON.parse(fs.readFileSync(log.subagentLogPath(), "utf8")).length).toBe(2);
});

test("loadSubagentRuns filters by since/sessionId and honors limit", () => {
  log.clearSubagentRuns();
  const t0 = Date.now();
  log.saveSubagentRun(entry({ runId: "old", startTime: t0 - 10000 }));
  log.saveSubagentRun(entry({ runId: "new", startTime: t0, sessionId: "other" }));
  log.saveSubagentRun(entry({ runId: "mid", startTime: t0 - 5000 }));
  expect(log.loadSubagentRuns({ since: t0 - 6000 }).map(r => r.runId)).toEqual(["new", "mid"]);
  expect(log.loadSubagentRuns({ sessionId: "other" }).map(r => r.runId)).toEqual(["new"]);
  expect(log.loadSubagentRuns({ limit: 1 }).length).toBe(1);
});

test("saveSubagentRun rejects entries without runId and prunes beyond MAX_ENTRIES", () => {
  log.clearSubagentRuns();
  expect(log.saveSubagentRun(null)).toBe(false);
  expect(log.saveSubagentRun({ agent: "x" })).toBe(false);
  for (let i = 0; i < log.MAX_ENTRIES + 25; i++) {
    log.saveSubagentRun(entry({ runId: "bulk-" + i, startTime: Date.now() + i }));
  }
  const rows = log.loadSubagentRuns();
  expect(rows.length).toBeLessThanOrEqual(log.MAX_ENTRIES);
  // oldest dropped first — bulk-0 must be gone
  expect(rows.some(r => r.runId === "bulk-0")).toBe(false);
});

test("pruneSubagentRuns drops entries older than the age window", () => {
  log.clearSubagentRuns();
  log.saveSubagentRun(entry({ runId: "ancient", startTime: Date.now() - 40 * 24 * 60 * 60 * 1000 }));
  log.saveSubagentRun(entry({ runId: "fresh", startTime: Date.now() }));
  const kept = log.pruneSubagentRuns(30 * 24 * 60 * 60 * 1000);
  expect(kept).toBe(1);
  expect(log.loadSubagentRuns().map(r => r.runId)).toEqual(["fresh"]);
});

test("missing/corrupt log file reads as empty and recovers on next write", () => {
  log.clearSubagentRuns();
  fs.writeFileSync(log.subagentLogPath(), "{not json");
  expect(log.loadSubagentRuns()).toEqual([]);
  expect(log.saveSubagentRun(entry({ runId: "recovered" }))).toBe(true);
  expect(log.loadSubagentRuns().length).toBe(1);
});
