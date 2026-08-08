const fs = require('fs');
const path = require('path');
const os = require('os');

const LOOM_DIR = path.join(os.homedir(), '.loom');
const CONFIG_FILE = path.join(LOOM_DIR, 'config.json');
const GLOBAL_LOOM_MD = path.join(LOOM_DIR, 'LOOM.md');

const DEFAULTS = {
  provider: 'anthropic',
  model: {
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-5-fast',
    nvidia: 'deepseek-ai/deepseek-v4-pro',
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
  if (!fs.existsSync(LOOM_DIR)) {
    fs.mkdirSync(LOOM_DIR, { recursive: true });
  }
}

function loadConfig() {
  ensureLoomDir();
  if (fs.existsSync(CONFIG_FILE)) {
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULTS };
    }
  }
  return { ...DEFAULTS };
}

function saveConfig(config) {
  ensureLoomDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
}

function getApiKey(provider) {
const envKeys = {
    anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    nvidia: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'],
    google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
    tokenrouter: ['TOKENROUTER_API_KEY'],
  };

  const envNames = envKeys[provider] || [];
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
  const cfg = loadConfig();
  return !!(cfg.apiKeys?.[provider] || process.env[provider.toUpperCase() + '_API_KEY']);
}

module.exports = {
  LOOM_DIR, CONFIG_FILE, GLOBAL_LOOM_MD, DEFAULTS,
  loadConfig, saveConfig,
  getApiKey, setApiKey, resolveApiKey,
  ensureLoomDir, getBaseUrl, setBaseUrl,
  recordModelUse, getRecentModels, hasApiKey
};
