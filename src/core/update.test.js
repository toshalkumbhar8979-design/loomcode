import { test, expect } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

// Isolate the throttle stamp so tests never touch the real ~/.loom and never
// leak state between runs.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-update-"));
process.env.LOOM_CONFIG_DIR = tmpDir;
process.env.LOOM_NO_UPDATE_CHECK = ""; // ensure enabled for these tests
delete process.env.LOOM_NO_UPDATE_CHECK;

const { updateCheck, isNewer, parseVersion } = require("./update.js");

test("parseVersion extracts major.minor.patch tuple", () => {
  expect(parseVersion("1.5.0")).toEqual([1, 5, 0]);
  expect(parseVersion("v2.0.1")).toEqual([2, 0, 1]);
  expect(parseVersion("1.5.0-beta.1")).toEqual([1, 5, 0]);
});

test("parseVersion returns null for garbage", () => {
  expect(parseVersion("abc")).toBe(null);
  expect(parseVersion("")).toBe(null);
  expect(parseVersion(undefined)).toBe(null);
  expect(parseVersion(42)).toBe(null);
});

test("isNewer compares by tuple, not string", () => {
  expect(isNewer("1.5.1", "1.5.0")).toBe(true);
  expect(isNewer("1.6.0", "1.5.9")).toBe(true);
  expect(isNewer("2.0.0", "1.9.9")).toBe(true);
  expect(isNewer("1.5.0", "1.5.1")).toBe(false);
  expect(isNewer("1.5.0", "1.5.0")).toBe(false); // equal is not newer
  expect(isNewer("0.9.9", "1.0.0")).toBe(false);
});

test("isNewer is false when either side is unparseable", () => {
  expect(isNewer("not-a-version", "1.0.0")).toBe(false);
  expect(isNewer("1.0.0", "not-a-version")).toBe(false);
});

test("LOOM_NO_UPDATE_CHECK short-circuits without touching the network", async () => {
  process.env.LOOM_NO_UPDATE_CHECK = "1";
  const out = await updateCheck();
  expect(out).toBe(null);
  delete process.env.LOOM_NO_UPDATE_CHECK;
});

test("updateCheck throttles to one probe per day (stamp file written)", async () => {
  // First call claims the 24h slot. It may return null (offline / up-to-date /
  // network blocked) — that's fine; what matters is the stamp gets written so
  // a second immediate call short-circuits WITHOUT another network attempt.
  const first = await updateCheck();
  expect(first === null || typeof first === "string").toBe(true);

  const stampPath = path.join(tmpDir, "update-check.json");
  expect(fs.existsSync(stampPath)).toBe(true);
  const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
  expect(typeof stamp.at).toBe("number");
  expect(Date.now() - stamp.at).toBeLessThan(60_000);

  // Second call, right after: stamp is fresh → returns null and (critically)
  // does not re-probe. We can't observe the network directly, but a fresh
  // stamp means the throttle path was taken.
  const second = await updateCheck();
  expect(second).toBe(null);
});

test("stamp file records the checked version for diagnostics", async () => {
  const stampPath = path.join(tmpDir, "update-check.json");
  const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
  const pkg = require("../../package.json");
  expect(stamp.checked).toBe(pkg.version);
});
