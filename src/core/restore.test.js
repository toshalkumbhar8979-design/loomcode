// Restore-point tests. The TUI now uses the async variant so large snapshots
// do not block streaming input.
// Runs with:  bun test src/core/restore.test.js
import { test, expect, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

let tmp;
let base;
let restore;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-restore-"));
  base = path.join(tmp, "project");
  fs.mkdirSync(path.join(base, "src"), { recursive: true });
  fs.mkdirSync(path.join(base, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(base, "src", "small.txt"), "hello restore\n");
  fs.writeFileSync(path.join(base, "src", "big.txt"), "x".repeat(300 * 1024));
  fs.writeFileSync(path.join(base, "src", "binary.bin"), "a\u0000b");
  fs.writeFileSync(path.join(base, "node_modules", "pkg", "ignored.js"), "ignored");
  process.env.LOOM_RESTORE_FILE = path.join(tmp, "restore.json");
  restore = require("./restore.js");
});

afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test("createRestorePointAsync captures small text and marks big/binary files null", async () => {
  const point = await restore.createRestorePointAsync("first prompt", base);
  expect(point.id).toBeTruthy();
  expect(point.label).toBe("first prompt");
  expect(point.files["src/small.txt"]).toBe("hello restore\n");
  expect(point.files["src/big.txt"]).toBe(null);
  expect(point.files["src/binary.bin"]).toBe(null);
  expect(point.files["node_modules/pkg/ignored.js"]).toBeUndefined();
  expect(fs.existsSync(process.env.LOOM_RESTORE_FILE)).toBe(true);
  // Compact on-disk representation, not pretty-printed multi-MB JSON.
  const raw = fs.readFileSync(process.env.LOOM_RESTORE_FILE, "utf8");
  expect(raw).not.toContain("\n  ");
});

test("restoreTo rewrites snapshotted files and removes later files", async () => {
  const point = await restore.createRestorePointAsync("second prompt", base);
  fs.writeFileSync(path.join(base, "src", "small.txt"), "broken\n");
  fs.writeFileSync(path.join(base, "src", "created-later.txt"), "new\n");
  const result = restore.restoreTo(point.id, base);
  expect(result.ok).toBe(true);
  expect(fs.readFileSync(path.join(base, "src", "small.txt"), "utf8")).toBe("hello restore\n");
  expect(fs.existsSync(path.join(base, "src", "created-later.txt"))).toBe(false);
  expect(fs.existsSync(path.join(base, "src", "big.txt"))).toBe(true);
});

test("listRestorePoints filters by cwd and returns newest first", async () => {
  const other = path.join(tmp, "other");
  fs.mkdirSync(other, { recursive: true });
  await restore.createRestorePointAsync("other project", other);
  const points = restore.listRestorePoints(base);
  expect(points.length).toBeGreaterThanOrEqual(2);
  expect(points[0].label).toBe("second prompt");
  expect(points.every((p) => p.cwd === base)).toBe(true);
});

test("the sync createRestorePoint still works for CLI callers", () => {
  const point = restore.createRestorePoint("sync", base);
  expect(restore.getRestorePoint(point.id)).toBeTruthy();
});
