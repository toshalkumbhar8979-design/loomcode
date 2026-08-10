// Unit tests for the usage governor (src/core/usage.js).
// Runs with:  bun test src/core/usage.test.js
import { test, expect, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let usage;
let file;

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "loom-usage-")), "usage.json");
  process.env.LOOM_USAGE_FILE = file;
  usage = require("./usage");
});

afterAll(() => {
  delete process.env.LOOM_USAGE_FILE;
});

test("recordUsage: accrues to totals, month, and day", () => {
  usage.recordUsage({ inputTokens: 1000, outputTokens: 2000, costUsd: 1.5 });
  const u = usage.getUsage();
  expect(u.totals.costUsd).toBeCloseTo(1.5);
  expect(u.month.costUsd).toBeCloseTo(1.5);
  expect(u.day.costUsd).toBeCloseTo(1.5);
  expect(u.day.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  usage.recordUsage({ costUsd: 0.5 });
  expect(usage.getUsage().totals.costUsd).toBeCloseTo(2.0);
  expect(usage.getUsage().day.costUsd).toBeCloseTo(2.0);
});

test("setMonthlyBudget: preserves day ledger and honors 0 (disabled)", () => {
  usage.recordUsage({ costUsd: 3 });
  usage.setMonthlyBudget(42);
  expect(usage.getUsage().budgetUsd).toBe(42);
  expect(usage.getUsage().day.costUsd).toBeCloseTo(3);
  usage.setMonthlyBudget(0);
  expect(usage.budgetStatus().over).toBe(false);
});

test("dayStatus: alerts once the daily threshold is crossed, 0 disables", () => {
  usage.setDailyAlert(5);
  usage.recordUsage({ costUsd: 4.99 });
  expect(usage.dayStatus().alert).toBe(false);
  usage.recordUsage({ costUsd: 0.02 });
  expect(usage.dayStatus().alert).toBe(true);
  usage.setDailyAlert(0);
  expect(usage.dayStatus().alert).toBe(false);
});

test("budgetStatus: over only when cap > 0 is reached", () => {
  usage.setMonthlyBudget(10);
  usage.recordUsage({ costUsd: 12 });
  expect(usage.budgetStatus().over).toBe(true);
  expect(usage.budgetStatus().pct).toBe(120);
  usage.setMonthlyBudget(0);
  usage.recordUsage({ costUsd: 100 });
  expect(usage.budgetStatus().over).toBe(false);
});

test("override: one-shot confirmation lets a single turn through", () => {
  usage.setMonthlyBudget(1);
  usage.recordUsage({ costUsd: 5 });
  expect(usage.budgetStatus().over).toBe(true);
  expect(usage.budgetStatus().overrideUsed).toBe(false);
  usage.requestOverride();
  expect(usage.budgetStatus().overrideUsed).toBe(true);
  expect(usage.consumeOverride()).toBe(true);
  expect(usage.budgetStatus().overrideUsed).toBe(false);
  expect(usage.consumeOverride()).toBe(false);
});

test("getUsage: corrupt ledger falls back to defaults without throwing", () => {
  fs.writeFileSync(file, "{not json", "utf8");
  const u = usage.getUsage();
  expect(u.totals.costUsd).toBe(0);
  expect(u.day.alert).toBe(false);
  usage.recordUsage({ costUsd: 1 });
  expect(usage.getUsage().totals.costUsd).toBeCloseTo(1);
});
