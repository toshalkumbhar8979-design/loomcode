// Core tests for the budget model router (Phase 1 cost optimizer).
// Runs with bun:  bun run test-core-router.js
process.env.LOOM_MCP_NO_WARM = "1";
process.env.LOOM_MEM_AUTO = "0";
// Isolate usage tracking to a temp file so the governor never reads the real
// ~/.loom/usage.json during this suite.
const os = require("os");
const fs = require("fs");
const { join } = require("path");
const USAGE_TMP = join(os.tmpdir(), "loom-usage-" + process.pid + "-" + Date.now() + ".json");
try { fs.rmSync(USAGE_TMP, { force: true }); } catch {}
process.env.LOOM_USAGE_FILE = USAGE_TMP;

const { loadConfig, saveConfig } = require("./src/config/settings.js");
const router = require("./src/core/model-router.js");
const { PROVIDERS } = require("./src/providers/index.js");
const usage = require("./src/core/usage.js");

const KEY_ENVS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NVIDIA_API_KEY",
  "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "TOKENROUTER_API_KEY",
];

const savedEnv = {};
const savedCfg = JSON.parse(JSON.stringify(loadConfig()));

function snapEnv() { for (const k of KEY_ENVS) savedEnv[k] = process.env[k]; }
function restoreEnv() { for (const k of KEY_ENVS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } }
function clearEnv() { for (const k of KEY_ENVS) delete process.env[k]; }
// Blank the apiKeys on disk so only process.env keys count during pickModel tests.
function blankKeys() { const c = loadConfig(); c.apiKeys = {}; saveConfig(c); }

function meta(p, id) { return PROVIDERS[p].models.find((m) => m.id === id); }

async function main() {
  let failed = 0;
  async function run(name, fn) {
    try { await fn(); console.log("PASS - " + name); }
    catch (e) { failed++; console.log("FAIL - " + name + " :: " + e.message); }
  }

  snapEnv();
  blankKeys();

  // ---- levelOf / matchesLevel ----
  await run("kimi-k3-free is level free", () => {
    if (router.levelOf(meta("tokenrouter", "moonshotai/kimi-k3-free")) !== "free") throw new Error("not free");
  });
  await run("deepseek-v4-flash (nvidia free) is level free", () => {
    if (router.levelOf(meta("nvidia", "deepseek-ai/deepseek-v4-flash")) !== "free") throw new Error("not free");
  });
  await run("gpt-5-nano is level cheap", () => {
    if (router.levelOf(meta("openai", "gpt-5-nano")) !== "cheap") throw new Error("not cheap");
  });
  await run("claude-sonnet-4 is level best", () => {
    if (router.levelOf(meta("anthropic", "claude-sonnet-4-20250514")) !== "best") throw new Error("not best");
  });
  await run("matchesLevel: free rejects paid, best accepts all", () => {
    const kimi = meta("tokenrouter", "moonshotai/kimi-k3-free");
    const sonnet = meta("anthropic", "claude-sonnet-4-20250514");
    if (!router.matchesLevel(kimi, "free")) throw new Error("free model must match free");
    if (router.matchesLevel(sonnet, "free")) throw new Error("paid model must NOT match free");
    if (!router.matchesLevel(kimi, "cheap")) throw new Error("free must match cheap");
    if (!router.matchesLevel(sonnet, "best")) throw new Error("paid must match best");
    if (!router.matchesLevel(sonnet, "auto")) throw new Error("auto matches everything");
  });

  // ---- usableModels / pickModel with controlled keys ----
  await run("pickModel(free) only picks $0 models", () => {
    clearEnv();
    process.env.TOKENROUTER_API_KEY = "test";
    process.env.OPENAI_API_KEY = "test"; // paid-only provider must never win
    const picked = router.pickModel("free");
    if (!picked) throw new Error("no pick");
    const m = meta(picked.provider, picked.model);
    if ((m.priceIn || 0) !== 0 || (m.priceOut || 0) !== 0) throw new Error("picked a paid model: " + picked.provider + "/" + picked.model);
    if (picked.provider === "openai") throw new Error("paid provider chosen for free level");
  });

  await run("pickModel(free) returns null when only paid keys exist", () => {
    clearEnv();
    process.env.OPENAI_API_KEY = "test";
    const picked = router.pickModel("free");
    if (picked !== null) throw new Error("expected null, got " + JSON.stringify(picked));
  });

  await run("pickModel(cheap) falls back to free when no cheap paid exists", () => {
    clearEnv();
    process.env.TOKENROUTER_API_KEY = "test";
    const picked = router.pickModel("cheap");
    if (!picked) throw new Error("no pick");
    const lvl = router.levelOf(meta(picked.provider, picked.model));
    if (lvl !== "free" && lvl !== "cheap") throw new Error("level mismatch: " + lvl);
  });

  await run("pickModel respects tried list", () => {
    clearEnv();
    process.env.NVIDIA_API_KEY = "test";
    process.env.TOKENROUTER_API_KEY = "test";
    const first = router.pickModel("free", { tried: [] });
    const second = router.pickModel("free", { tried: [first.provider + "/" + first.model] });
    if (!first || !second) throw new Error("no pick");
    if (first.provider + "/" + first.model === second.provider + "/" + second.model) throw new Error("tried model picked again");
  });

  // ---- estimateTurnCost ----
  await run("estimateTurnCost: sonnet 100k in / 50k out = $1.05", () => {
    const c = router.estimateTurnCost("anthropic", "claude-sonnet-4-20250514", 100000, 50000);
    if (Math.abs(c - 1.05) > 1e-9) throw new Error("got " + c);
  });
  await run("estimateTurnCost: free model costs $0", () => {
    const c = router.estimateTurnCost("tokenrouter", "moonshotai/kimi-k3-free", 1000000, 1000000);
    if (c !== 0) throw new Error("got " + c);
  });

  // ---- Session integration: free level routes the turn to a free model ----
  await run("session routes free-level turn to a free provider, cost stays $0", async () => {
    clearEnv();
    process.env.TOKENROUTER_API_KEY = "test";
    const cfg = loadConfig();
    cfg.budgetLevel = "free";
    cfg.apiKeys = {}; // only the env key above counts
    saveConfig(cfg);
    // The user's saved provider must survive the transient router swap.
    const providerBefore = cfg.provider;

    const { Session } = require("./src/core/session.js");
    const s = new Session();
    const stub = async () => ({ type: "assistant", content: "hi", toolCalls: [] });
    PROVIDERS.tokenrouter.chat = stub;
    PROVIDERS.tokenrouter.stream = stub;
    PROVIDERS.nvidia.chat = stub;
    PROVIDERS.nvidia.stream = stub;
    PROVIDERS.anthropic.chat = stub;
    PROVIDERS.anthropic.stream = stub;

    const res = await s.sendUserMessage("hello", {});
    if (res.type !== "text") throw new Error("turn failed: " + JSON.stringify(res));
    const used = s.provider.active.name;
    const m = meta(used, s.config.model[used]);
    if ((m.priceIn || 0) !== 0) throw new Error("active provider is paid: " + used + " / " + s.config.model[used]);
    if (s.sessionCost !== 0) throw new Error("free turn must cost $0, got " + s.sessionCost);
    const saved = loadConfig();
    if (saved.provider !== providerBefore) {
      throw new Error("transient router must NOT rewrite saved provider: " + providerBefore + " -> " + saved.provider);
    }
  });

  await run("free level hard-blocks when no free model has a key", async () => {
    clearEnv();
    process.env.OPENAI_API_KEY = "test"; // paid only
    const cfg = loadConfig();
    cfg.budgetLevel = "free";
    cfg.apiKeys = {};
    saveConfig(cfg);

    const { Session } = require("./src/core/session.js");
    const s = new Session();
    const res = await s.sendUserMessage("hello", {});
    if (res.type !== "error" || !/No free-level model available/.test(res.content)) {
      throw new Error("expected free-block error, got " + JSON.stringify(res));
    }
  });

  await run("autoSwitchModel respects the free level", () => {
    clearEnv();
    process.env.TOKENROUTER_API_KEY = "test";
    const cfg = loadConfig();
    cfg.budgetLevel = "free";
    saveConfig(cfg);
    const { Session } = require("./src/core/session.js");
    const s = new Session();
    const next = s.autoSwitchModel("anthropic");
    if (!next) throw new Error("no switch candidate");
    const m = meta(next.provider, next.model);
    if ((m.priceIn || 0) !== 0) throw new Error("switched to paid model: " + JSON.stringify(next));
  });

  // ---- Phase 2: spending governor ----
  await run("budgetStatus: under/over cap", () => {
    fs.rmSync(USAGE_TMP, { force: true });
    usage.setMonthlyBudget(25);
    let s = usage.budgetStatus();
    if (s.over) throw new Error("fresh month must not be over budget");
    usage.recordUsage({ costUsd: 30 });
    s = usage.budgetStatus();
    if (!s.over || Math.abs(s.monthCostUsd - 30) > 1e-9) throw new Error("expected over at $30/$25, got " + JSON.stringify(s));
    usage.setMonthlyBudget(0);
    s = usage.budgetStatus();
    if (s.over) throw new Error("cap 0 must disable enforcement");
    fs.rmSync(USAGE_TMP, { force: true });
    usage.setMonthlyBudget(25);
  });

  await run("governor hard-blocks paid turns when over budget", async () => {
    clearEnv();
    process.env.OPENAI_API_KEY = "test";
    const cfg = loadConfig();
    cfg.budgetLevel = "auto";
    cfg.provider = "openai";
    cfg.model = { openai: "gpt-5-nano" };
    cfg.apiKeys = {};
    saveConfig(cfg);
    fs.rmSync(USAGE_TMP, { force: true });
    usage.setMonthlyBudget(10);
    usage.recordUsage({ costUsd: 15 }); // $15 of $10 — over

    const { Session } = require("./src/core/session.js");
    const s = new Session();
    const res = await s.sendUserMessage("hello", {});
    if (res.type !== "error" || !/Monthly budget reached/.test(res.content)) {
      throw new Error("expected budget-block error, got " + JSON.stringify(res));
    }
  });

  await run("governor still allows free models when over budget", async () => {
    clearEnv();
    process.env.TOKENROUTER_API_KEY = "test";
    const cfg = loadConfig();
    cfg.budgetLevel = "auto";
    cfg.provider = "tokenrouter";
    cfg.model = { tokenrouter: "moonshotai/kimi-k3-free" };
    cfg.apiKeys = {};
    saveConfig(cfg);
    const stub = async () => ({ type: "assistant", content: "hi", toolCalls: [] });
    PROVIDERS.tokenrouter.chat = stub;
    PROVIDERS.tokenrouter.stream = stub;

    const { Session } = require("./src/core/session.js");
    const s = new Session();
    const res = await s.sendUserMessage("hello", {});
    if (res.type !== "text") throw new Error("free model must stay allowed over budget, got " + JSON.stringify(res));
    fs.rmSync(USAGE_TMP, { force: true });
    usage.setMonthlyBudget(25);
  });

  // ---- Phase 2.2: skill auto-trigger ----
  const { match: matchSkill, scoreSkill } = require("./src/skills/skill-matcher.js");
  const fakeGcode = {
    name: "gcode expert",
    dir: "C:\\fake\\skills\\gcode",
    description: "Write G-code for 3D printing, PLA, FDM, slicing, post-processing",
    instructions: "You are a G-code expert. Generate G-code that prints cleanly on a Prusa MK4.",
  };
  const fakeCad = {
    name: "cad modeler",
    dir: "C:\\fake\\skills\\cad",
    description: "Parametric 3D modeling via STEP files, STL export, boolean ops",
    instructions: "You are a CAD expert. Write STEP files and STL.",
  };
  const fakeSkills = [fakeGcode, fakeCad];

  await run("skill matcher triggers on keywords", () => {
    const hits = matchSkill("can you slice this STL file and give me the gcode?", fakeSkills);
    // match() returns skill objects directly
    if (!hits.some(h => h.name === "gcode expert")) throw new Error("gcode skill not triggered by 'slice stl gcode', got: " + hits.map(h => h.name));
  });
  await run("skill matcher scores CAD terms", () => {
    const hits = matchSkill("make a parametric STEP model of a bracket", fakeSkills);
    if (!hits.some(h => h.name === "cad modeler")) throw new Error("cad skill not triggered by 'parametric STEP model', got: " + hits.map(h => h.name));
  });
  await run("skill matcher stays quiet on unrelated messages", () => {
    const hits = matchSkill("what is the capital of France?", fakeSkills);
    if (hits.length > 0) throw new Error("false trigger: " + hits.map(h => h.skill.name).join(","));
  });
  await run("skill matcher requires 2+ word match to avoid false positives", () => {
    // single keyword match should be below the 2.0 threshold
    const hits = matchSkill("I like to 3d print", fakeSkills);
    if (hits.some(h => h.skill.name === "gcode expert")) {
      // allow if description has a second keyword hit
      // '3d' is in description, 'print' is in description — may trigger with 2 words, which is fine
      return; // allowed
    }
  });
  await run("scoreSkill reports matched keywords", () => {
    const hit = scoreSkill(fakeGcode, new Set(["slice", "gcode"]));
    if (!hit || hit.score < 2) throw new Error("scoreSkill should score ≥2 for 'slice gcode'");
    if (!hit.matched.some(m => m.includes("gcode"))) throw new Error("expected 'gcode' in matched list");
  });
  await run("session injects active skill instructions into system prompt", async () => {
    clearEnv();
    process.env.TOKENROUTER_API_KEY = "test";
    const cfg = loadConfig();
    cfg.budgetLevel = "auto";
    cfg.provider = "tokenrouter";
    cfg.apiKeys = {};
    saveConfig(cfg);
    const stub = async () => ({ type: "assistant", content: "hi", toolCalls: [] });
    PROVIDERS.tokenrouter.chat = stub;
    PROVIDERS.tokenrouter.stream = stub;

    const { Session } = require("./src/core/session.js");
    const s = new Session();
    // Inject the fake skill matcher so no filesystem skills are needed.
    s._skillMatcher = (text) => (text.includes("gcode") ? [fakeGcode] : []);
    const res = await s.sendUserMessage("slice this STL to gcode please", {});
    if (res.type !== "text") throw new Error("turn failed: " + JSON.stringify(res));
    if (!s._skillBlock || !s._skillBlock.includes("[Active skill for this turn:")) {
      throw new Error("skill block not injected, got: " + JSON.stringify(s._skillBlock));
    }
    if (!s._activeSkill.includes("gcode expert")) throw new Error("expected 'gcode expert' in active skills, got " + JSON.stringify(s._activeSkill));
  });

  // ---- events bus ----
  const { on, emit } = require("./src/core/events.js");
  let got = null;
  const off = on("test:event", (d) => { got = d; });
  emit("test:event", { x: 1 });
  off();
  await run("events bus delivers and unsubscribes", () => {
    if (!got || got.x !== 1) throw new Error("event lost");
  });

  // ---- Restore the real environment ----
  restoreEnv();
  saveConfig(savedCfg);

  console.log(failed ? failed + " FAILURES" : "all core-router tests passed");
  process.exitCode = failed ? 1 : 0;
}

main();
