const AnthropicProvider = require('./anthropic');
const OpenAIProvider = require('./openai');
const NVIDIAProvider = require('./nvidia');
const GoogleProvider = require('./google');
const OpenRouterProvider = require('./openrouter');
const TokenRouterProvider = require('./tokenrouter');
const LocalProvider = require('./local');
const { createOpenAICompatProvider } = require('./openai-compat');
const { loadRegistry, fetchRegistry, isRegistryFresh, envNamesFor, SDK_BASE_URLS } = require('./registry');
const { loadConfig, getApiKey } = require('../config/settings');

const PROVIDERS = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  nvidia: NVIDIAProvider,
  google: GoogleProvider,
  openrouter: OpenRouterProvider,
  tokenrouter: TokenRouterProvider,
  local: LocalProvider,
};

// Providers shipped in code (always available, always listed in /models even
// without a key). Everything else comes from the models.dev registry.
const BUILTIN_PROVIDERS = Object.keys(PROVIDERS);
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

// ── models.dev registry providers ──
// Fetched once and cached at ~/.loom/models-dev.json (opencode uses the same
// dataset for its 75+ providers). Each provider becomes an OpenAI-compatible
// runtime provider with its real model list, prices, and context windows.
// Built-in providers always win the merge; registry entries without models
// are skipped.

/**
 * @param {import('./registry').RegistryProvider} rp
 * @returns {import('./openai-compat').Provider}
 */
function makeDynamicProvider(rp) {
  const provider = createOpenAICompatProvider({
    getKey: () => getApiKey(rp.id),
    providerId: rp.id,
    envKeyHint: rp.name,
    defaultBaseUrl: rp.baseURL || SDK_BASE_URLS[rp.npm] || undefined,
  });
  provider.models = rp.models.map((m) => ({
    id: m.id,
    name: m.name,
    provider: rp.id,
    context: m.context,
    priceIn: m.priceIn,
    priceOut: m.priceOut,
    tags: m.tags,
  }));
  return provider;
}

/**
 * Merge the cached registry into PROVIDERS/PROVIDER_ORDER/PROVIDER_LABELS
 * (in place, so existing imports keep working). Returns the number of
 * providers added.
 * @returns {number}
 */
function mergeRegistry() {
  const reg = loadRegistry();
  if (!reg) return 0;
  let added = 0;
  for (const [id, rp] of Object.entries(reg)) {
    if (PROVIDERS[id] || PROVIDER_LABELS[id]) continue;
    if (!rp.models.length) continue;
    PROVIDERS[id] = makeDynamicProvider(rp);
    PROVIDER_LABELS[id] = rp.name;
    PROVIDER_ORDER.push(id);
    added++;
  }
  PROVIDER_ORDER.sort((a, b) => {
    const ai = BUILTIN_PROVIDERS.indexOf(a);
    const bi = BUILTIN_PROVIDERS.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return String(a).localeCompare(String(b));
  });
  return added;
}

let registryPromise = null;

/**
 * Make sure the models.dev registry is available: reuse a fresh cache, else
 * fetch once (background-friendly, never throws). Returns the number of
 * providers currently merged.
 * @param {boolean=} force  bypass the freshness check
 * @returns {Promise<number>}
 */
function ensureRegistry(force = false) {
  if (!force && isRegistryFresh()) return Promise.resolve(mergeRegistry());
  if (!registryPromise) {
    registryPromise = fetchRegistry().then((count) => {
      registryPromise = null;
      if (count) mergeRegistry();
      return count;
    });
  }
  return registryPromise;
}

// Merge whatever cache exists at boot (first run has none — ensureRegistry()
// fetches it the first time the provider picker opens).
mergeRegistry();

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
    this.providers[providerName] = PROVIDERS[providerName];
    this.active = { name: providerName, key: getApiKey(providerName) };
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

module.exports = {
  ProviderRouter, PROVIDERS, PROVIDER_ORDER, PROVIDER_LABELS, BUILTIN_PROVIDERS,
  getModelMeta, ensureRegistry, mergeRegistry, envNamesFor,
};