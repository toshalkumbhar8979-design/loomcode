// Isolate the entire interactive suite from the developer's real home
// configuration: create a throwaway HOME/USERPROFILE BEFORE the App and its
// theme/store/keybind modules initialize, so tui.json, keybinds.json, and
// session prefs are read and written inside the temp dir only.
import fs from "fs";
import path from "path";
import os from "os";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-suite-home-"));
process.env.HOME = dir;
process.env.USERPROFILE = dir;
process.env.LOOM_CONFIG_DIR = path.join(dir, ".loom");
fs.mkdirSync(process.env.LOOM_CONFIG_DIR, { recursive: true });
// Seed one harmless MCP server: the /mcp popup test toggles servers[0] and
// the /sessions picker renders the MCP status column — both need a server.
fs.writeFileSync(path.join(process.env.LOOM_CONFIG_DIR, "mcp.json"), JSON.stringify({
  servers: { "suite-local": { command: "echo", args: ["suite-mcp-ok"], enabled: true } },
}, null, 2));

(globalThis as any).__LOOM_SUITE_HOME = dir;