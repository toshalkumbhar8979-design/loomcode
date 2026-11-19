// Plain-text reports that land in the transcript (help, providers, agents).
import { appendMessage, SLASH_LIST, PROVIDERS, PROVIDER_ORDER, PROVIDER_LABELS } from "./store.ts";
import * as kbs from "./keybinds.ts";

export function showHelpText() {
  const lines = ["COMMANDS", ""];
  for (const c of SLASH_LIST) {
    lines.push("  /" + c.cmd.padEnd(14) + "  " + c.desc + (c.args ? "  (" + c.args + ")" : ""));
  }
  lines.push(
    "",
    "  " + kbs.label("session_interrupt") + " interrupt / clear",
    "  " + kbs.label("app_exit") + " quit",
    "  " + kbs.label("command_list") + " command deck",
    kbs.leaderKey() ? "  " + kbs.leaderKey() + " leader (then h/j/m/s/n/l/x/c/u/r/b/p/t/d/e/q)" : "  leader disabled",
    "",
    "  Customize keybinds in ~/.loom/tui.json, then relaunch."
  );
  appendMessage({ role: "system", content: lines.join("\n") });
}

export function showProvidersText() {
  const lines = ["PROVIDERS", ""];
  for (const p of PROVIDER_ORDER) {
    const mods = PROVIDERS[p]?.models?.length || 0;
    lines.push("  " + p.padEnd(12) + String(mods).padEnd(4) + "models   " + (PROVIDER_LABELS[p] || p));
  }
  lines.push("", "  /connect to pick one interactively.");
  appendMessage({ role: "system", content: lines.join("\n") });
}

export function showAgentsText() {
  const { loadAgents } = require("../core/agents.js");
  const agents = loadAgents() as Record<string, any>;
  const lines = ["AGENTS", ""];
  for (const a of Object.values(agents)) {
    const mode = a.mode === "primary" ? "primary" : "subagent";
    const tools = a.tools && a.tools.length ? "[" + a.tools.join(" ") + "]" : "[*]";
    const model = a.model ? " model=" + a.model : "";
    lines.push("  " + a.id.padEnd(10) + " " + mode.padEnd(9) + " " + tools.padEnd(24) + model);
    lines.push("      " + a.description);
  }
  lines.push(
    "",
    "  The main agent delegates with the task tool; spawn_agents fans out several.",
    "  Manual: type @<agent> in the prompt (e.g. @explore find the bug).",
    "  Configure in ~/.loom/config.json → agents: { name: { mode, description, tools, model, prompt } }"
  );
  appendMessage({ role: "system", content: lines.join("\n") });
}
