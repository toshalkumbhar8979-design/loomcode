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
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-5-fast',
    nvidia: 'meta/llama-3.1-8b-instruct',
    google: 'gemini-2.5-flash',
    openrouter: 'anthropic/claude-sonnet-4',
    tokenrouter: 'moonshotai/kimi-k3-free',
    local: 'llama3.2',
  },
  maxTokens: 16384,
  temperature: 0.3,
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

function loadConfig() {
  ensureLoomDir();
  const file = configFile();
  if (fs.existsSync(file)) {
    try { fs.chmodSync(file, 0o600); } catch {}
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return { ...DEFAULTS, ...JSON.parse(raw) };
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

function getApiKey(provider) {
  const { envNamesFor } = require('../providers/registry');
  const envNames = envNamesFor(provider) || [];
  for (const key of envNames) {
    if (process.env[key]) return process.env[key];
  }

  const config = loadConfig();
  return config.apiKeys?.[provider] || null;
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
