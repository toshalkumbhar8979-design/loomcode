// Shared tui.json access (theme.ts, store.ts, keybinds.ts): one path
// resolution honoring LOOM_CONFIG_DIR, with read-modify-write saves so
// concurrent updates never clobber each other's fields.
import fs from "fs";
import os from "os";
import path from "path";

export function tuiStatePath(): string {
  return process.env.LOOM_CONFIG_DIR
    ? path.join(process.env.LOOM_CONFIG_DIR, "tui.json")
    : path.join(os.homedir(), ".loom", "tui.json");
}

export function loadTuiJson(): any {
  try {
    const p = tuiStatePath();
    return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) || {}) : {};
  } catch { return {}; }
}

export function saveTuiJson(patch: any): void {
  try {
    const p = tuiStatePath();
    const data = Object.assign({}, loadTuiJson(), patch);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch {}
}