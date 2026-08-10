const AnthropicProvider = require('./anthropic');
const OpenAIProvider = require('./openai');
const NVIDIAProvider = require('./nvidia');
const GoogleProvider = require('./google');
const OpenRouterProvider = require('./openrouter');
const TokenRouterProvider = require('./tokenrouter');
const LocalProvider = require('./local');
const { loadConfig } = require('../config/settings');

const PROVIDERS = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  nvidia: NVIDIAProvider,
  google: GoogleProvider,
  openrouter: OpenRouterProvider,
  tokenrouter: TokenRouterProvider,
  local: LocalProvider,
};

const PROVIDER_ORDER = ['anthropic', 'openai', 'nvidia', 'google', 'openrouter', 'tokenrouter', 'local'];
const PROVIDER_LABELS = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  nvidia: 'NVIDIA NIM',
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  tokenrouter: 'Token Router',
  local: 'Local (Ollama/LM Studio)',
};

class ProviderRouter {
  constructor() {
    this.providers = {};
    this.active = null;
  }

  init(providerName) {
    const config = loadConfig();
    const name = providerName || config.provider || 'anthropic';
    if (!PROVIDERS[name]) {
      throw new Error(`Unknown provider: ${name}. Available: ${PROVIDER_ORDER.join(', ')}`);
    }
    return this.use(name);
  }

  // Transient switch: activate a provider without persisting anything to the
  // config (the budget router swaps providers per turn; setModel() persists).
  use(providerName) {
    if (!PROVIDERS[providerName]) return null;
    const config = loadConfig();
    const apiKey = config.apiKeys?.[providerName] || process.env[`${providerName.toUpperCase()}_API_KEY`];
    this.providers[providerName] = PROVIDERS[providerName];
    this.active = { name: providerName, key: apiKey };
    return this.active;
  }

  getChatFn() {
    if (!this.active) this.init();
    const active = this.active;
    if (!active) throw new Error('No active provider');
    return this.providers[active.name].chat;
  }

  getStreamFn() {
    if (!this.active) this.init();
    const active = this.active;
    if (!active) throw new Error('No active provider');
    return this.providers[active.name].stream;
  }

  getModels(providerName) {
    const name = providerName || this.active?.name || 'anthropic';
    if (!PROVIDERS[name]) return [];
    return PROVIDERS[name].models || [];
  }
}

// Look up model metadata (context window, $/1M token prices) for pricing/billing display.
function getModelMeta(providerName, modelId) {
  if (!providerName || !modelId) return null;
  const list = (PROVIDERS[providerName] && PROVIDERS[providerName].models) || [];
  return list.find((m) => m.id === modelId) || null;
}

module.exports = { ProviderRouter, PROVIDERS, PROVIDER_ORDER, PROVIDER_LABELS, getModelMeta };
