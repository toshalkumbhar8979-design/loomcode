const fs = require('fs');
const path = require('path');
const os = require('os');

const LOOM_DIR = path.join(os.homedir(), '.loom');
const CONFIG_FILE = path.join(LOOM_DIR, 'config.json');
const GLOBAL_LOOM_MD = path.join(LOOM_DIR, 'LOOM.md');

// Re-evaluated on every call so tests/CI can point config elsewhere with
// LOOM_CONFIG_DIR; the exported LOOM_DIR/CONFIG_FILE constants keep the
// default for display purposes.
function loomDir() {
  return process.env.LOOM_CONFIG_DIR || LOOM_DIR;
}

function configFile() {
  return path.join(loomDir(), 'config.json');
}

const DEFAULTS = {
  provider: 'anthropic',
  model: {
    // claude-sonnet-4-20250514 was retired 2026-06-15 (404); Anthropic's
    // recommended replacement is claude-sonnet-5-5.
    anthropic: 'claude-sonnet-5-5',
    // Defaults must be IDs that exist on the LIVE provider APIs (verified
    // 2026-10-17): gpt-5-fast and meta/llama-3.1-8b-instruct returned 404,
    // anthropic/claude-sonnet-4 and moonshotai/kimi-k3-free are gone too.
    openai: 'gpt-5',
    nvidia: 'nvidia/nemotron-3-super-120b-a12b',
    google: 'gemini-2.5-flash',
    openrouter: 'anthropic/claude-sonnet-5.5',
    tokenrouter: 'z-ai/glm-5.3-free',
    local: 'llama3.2',
  },
  maxTokens: 16384,
  temperature: 0.3,
  // Hard service-level limits. A stuck provider, tool, or child cannot hold a
  // production turn indefinitely.
  requestTimeoutMs: 600000,
  // Streaming watchdogs. Generous by default: reasoning models and cold local
  // servers routinely need minutes before the first token. The outer
  // requestTimeoutMs remains the hard ceiling.
  firstChunkTimeoutMs: 180000,
  idleTimeoutMs: 180000,
  toolTimeoutMs: 180000,
  subagentTimeoutMs: 900000,
  maxParallelTools: 8,
  compactThreshold: 0.75,
  budgetLevel: 'auto', // free | cheap | best | auto (explicit picks)
  apiKeys: {},
  customEndpoints: {},
  recentModels: [],
  skillDisabled: [],
  // OpenCode-style formatters / LSP. false = disabled (default). true = enable
  // all built-ins. object = built-ins + per-id overrides/customs.
  formatter: false,
  lsp: false,
  baseUrls: {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com/v1',
    nvidia: 'https://integrate.api.nvidia.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    openrouter: 'https://openrouter.ai/api/v1',
    tokenrouter: 'https://api.tokenrouter.com/v1',
    local: 'http://localhost:11434/v1',
  },
};

function ensureLoomDir() {
  const dir = loomDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Deep-merge the nested maps (model/baseUrls/apiKeys/customEndpoints) so a
// config that customizes one provider keeps the defaults for every other one.
function mergeConfig(raw) {
  const out = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  for (const key of ['model', 'baseUrls', 'apiKeys', 'customEndpoints']) {
    const base = DEFAULTS[key];
    const over = raw && typeof raw === 'object' ? raw[key] : null;
    if (base && typeof base === 'object' && !Array.isArray(base)) {
      out[key] = { ...base, ...(over && typeof over === 'object' ? over : {}) };
    }
  }
  return out;
}

function loadConfig() {
  ensureLoomDir();
  const file = configFile();
  if (fs.existsSync(file)) {
    try { fs.chmodSync(file, 0o600); } catch {}
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return mergeConfig(JSON.parse(raw));
    } catch {
      return { ...DEFAULTS };
    }
  }
  return { ...DEFAULTS };
}

function saveConfig(config) {
  ensureLoomDir();
  const file = configFile();
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  try { fs.chmodSync(file, 0o600); } catch {}
}

// Explicitly configured keys win over ambient env vars. Otherwise a stale
// environment key silently shadows a freshly connected key and every request
// fails with a 401 even though the UI says the provider is connected.
function getApiKey(provider) {
  const config = loadConfig();
  const saved = config.apiKeys?.[provider];
  if (saved) return saved;
  const { envNamesFor } = require('../providers/registry');
  for (const key of (envNamesFor(provider) || [])) {
    if (process.env[key]) return process.env[key];
  }
  return null;
}

function setApiKey(provider, key) {
  const config = loadConfig();
  config.apiKeys = config.apiKeys || {};
  config.apiKeys[provider] = key;
  saveConfig(config);
}

function resolveApiKey(provider) {
  const key = getApiKey(provider);
  if (!key) {
    throw new Error(
      `No API key found for ${provider}. Set the env variable or run: loom connect ${provider} <key>`
    );
  }
  return key;
}

function getBaseUrl(provider) {
  const envMap = {
    anthropic: ['ANTHROPIC_BASE_URL'],
    openai: ['OPENAI_BASE_URL'],
    nvidia: ['NVIDIA_BASE_URL'],
    google: ['GOOGLE_BASE_URL'],
    openrouter: ['OPENROUTER_BASE_URL'],
    tokenrouter: ['TOKENROUTER_BASE_URL'],
  };
  for (const env of (envMap[provider] || [])) {
    if (process.env[env]) return process.env[env];
  }
  const cfg = loadConfig();
  return cfg.baseUrls?.[provider] || cfg.customEndpoints?.[provider] || DEFAULTS.baseUrls?.[provider] || null;
}

function setBaseUrl(provider, url) {
  const config = loadConfig();
  config.baseUrls = config.baseUrls || {};
  config.baseUrls[provider] = url;
  saveConfig(config);
}

// Remember which provider+model was used, most recent first (deduped, capped).
function recordModelUse(provider, modelId) {
  if (!provider || !modelId) return;
  const config = loadConfig();
  const list = (config.recentModels || []).filter(r => !(r.provider === provider && r.model === modelId));
  list.unshift({ provider, model: modelId, at: Date.now() });
  config.recentModels = list.slice(0, 8);
  saveConfig(config);
}

function getRecentModels() {
  const cfg = loadConfig();
  return (cfg.recentModels || []).slice(0, 8);
}

// Whether a usable key exists for a provider (or it's a keyless local backend).
function hasApiKey(provider) {
  if (provider === 'local') return true;
  const { envNamesFor } = require('../providers/registry');
  const cfg = loadConfig();
  if (cfg.apiKeys?.[provider]) return true;
  return (envNamesFor(provider) || []).some(n => !!process.env[n]);
}

module.exports = {
  LOOM_DIR, CONFIG_FILE, GLOBAL_LOOM_MD, DEFAULTS,
  loadConfig, saveConfig,
  getApiKey, setApiKey, resolveApiKey,
  ensureLoomDir, getBaseUrl, setBaseUrl,
  recordModelUse, getRecentModels, hasApiKey
};
