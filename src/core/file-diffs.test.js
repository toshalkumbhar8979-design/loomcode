// Unit tests for the file-diff capture layer (src/core/file-diffs.js).
// Runs with:  bun test src/core/file-diffs.test.js
import { test, expect, beforeEach, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildFileDiff,
  snapshotBefore,
  snapshotAfter,
  clearFileDiffs,
  formatDiffCount,
  toSideBySide,
} from "./file-diffs.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-diffs-"));

beforeEach(() => {
  clearFileDiffs();
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test("buildFileDiff splits multi-line hunks into individual rows", () => {
  const d = buildFileDiff(path.join(tmpDir, "multi.txt"), "alpha\nbeta\n", "alpha\nBETA\ngamma\n");
  expect(d.added).toBe(2);
  expect(d.removed).toBe(1);
  expect(d.lines.filter(l => l.kind === "add").map(l => l.text)).toEqual(["BETA", "gamma"]);
  expect(d.lines.filter(l => l.kind === "del").map(l => l.text)).toEqual(["beta"]);
  expect(formatDiffCount(d)).toBe("+2 -1");
});

test("buildFileDiff treats a missing before snapshot as a new file", () => {
  const d = buildFileDiff(path.join(tmpDir, "new.txt"), null, "first\nsecond\n");
  expect(d.isNew).toBe(true);
  expect(d.added).toBe(2);
  expect(d.removed).toBe(0);
  expect(d.lines.filter(l => l.kind === "add").map(l => l.text)).toEqual(["first", "second"]);
});

test("toSideBySide pairs deletions with additions and keeps context on both sides", () => {
  const rows = toSideBySide([
    { kind: "ctx", text: "same" },
    { kind: "del", text: "old one" },
    { kind: "del", text: "old two" },
    { kind: "add", text: "new one" },
    { kind: "add", text: "new two" },
    { kind: "add", text: "new three" },
    { kind: "ctx", text: "tail" },
  ]);
  expect(rows[0]).toEqual({ left: { kind: "ctx", text: "same" }, right: { kind: "ctx", text: "same" } });
  expect(rows[1]).toEqual({ left: { kind: "del", text: "old one" }, right: { kind: "add", text: "new one" } });
  expect(rows[2]).toEqual({ left: { kind: "del", text: "old two" }, right: { kind: "add", text: "new two" } });
  expect(rows[3]).toEqual({ left: null, right: { kind: "add", text: "new three" } });
  expect(rows[4].left.text).toBe("tail");
  expect(rows[4].right.text).toBe("tail");
});

test("snapshotBefore keeps the original baseline for repeated edits", () => {
  const file = path.join(tmpDir, "cumulative.txt");
  fs.writeFileSync(file, "one\ntwo\nthree\n");
  snapshotBefore(file);
  fs.writeFileSync(file, "one\nTWO\nthree\n");
  snapshotAfter(file);

  snapshotBefore(file);
  fs.writeFileSync(file, "one\nTWO\nTHREE\n");
  const d = snapshotAfter(file);

  expect(d.removed).toBe(2);
  expect(d.added).toBe(2);
  expect(d.lines.filter(l => l.kind === "del").map(l => l.text)).toEqual(["two", "three"]);
  expect(d.lines.filter(l => l.kind === "add").map(l => l.text)).toEqual(["TWO", "THREE"]);
});
