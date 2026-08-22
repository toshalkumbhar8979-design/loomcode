// models.dev provider/model registry — the same open-source dataset opencode
// uses for its provider + model lists (https://models.dev/api.json). Loom
// fetches it once, caches it at ~/.loom/models-dev.json, and merges every
// provider into the runtime registry. Everything degrades gracefully offline:
// no cache, no network -> the 7 built-in providers keep working.
const fs = require('fs');
const path = require('path');
const os = require('os');

const REGISTRY_URL = 'https://models.dev/api.json';
const REGISTRY_FILE = path.join(path.join(os.homedir(), '.loom'), 'models-dev.json');
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// Re-evaluated on every call (like the other stores) so tests/CI can isolate
// with LOOM_CONFIG_DIR; REGISTRY_FILE keeps the default for display.
function registryFile() {
  return path.join(process.env.LOOM_CONFIG_DIR || path.join(os.homedir(), '.loom'), 'models-dev.json');
}

/**
 * @typedef {Object} RegistryModel
 * @property {string} id
 * @property {string} name
 * @property {number} context
 * @property {number} priceIn  $/1M input tokens
 * @property {number} priceOut $/1M output tokens
 * @property {Array<string>} tags
 */

/**
 * @typedef {Object} RegistryProvider
 * @property {string} id
 * @property {string} name
 * @property {Array<string>} env  accepted API-key env var names
 * @property {string} npm  SDK the provider expects (info only)
 * @property {string=} baseURL  OpenAI-compatible endpoint, when known
 * @property {Array<RegistryModel>} models
 */

/**
 * @param {string} id
 * @param {*} raw
 * @returns {RegistryProvider}
 */
function normalizeProvider(id, raw) {
  /** @type {Array<RegistryModel>} */
  const models = [];
  for (const [mid, m] of Object.entries(raw.models || {})) {
    if (!m || typeof m !== 'object') continue;
    /** @type {Array<string>} */
    const tags = [];
    if (m.reasoning) tags.push('reasoning');
    models.push({
      id: mid,
      name: m.name || mid,
      context: (m.limit && m.limit.context) || 0,
      priceIn: (m.cost && Number(m.cost.input)) || 0,
      priceOut: (m.cost && Number(m.cost.output)) || 0,
      tags,
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return {
    id,
    name: raw.name || id,
    env: Array.isArray(raw.env) && raw.env.length ? raw.env : [id.toUpperCase() + '_API_KEY'],
    npm: raw.npm || '',
    baseURL: typeof raw.api === 'string' ? raw.api : undefined,
    models,
  };
}

// Well-known OpenAI-compatible base URLs for npm SDKs that models.dev lists
// without an `api` field (their SDKs embed the endpoint). A registry `api`
// field always wins over this map.
const SDK_BASE_URLS = {
  '@ai-sdk/openai': 'https://api.openai.com/v1',
  '@ai-sdk/anthropic': 'https://api.anthropic.com',
  '@ai-sdk/google': 'https://generativelanguage.googleapis.com/v1beta/openai/',
  '@ai-sdk/mistral': 'https://api.mistral.ai/v1',
  '@ai-sdk/xai': 'https://api.x.ai/v1',
  '@ai-sdk/groq': 'https://api.groq.com/openai/v1',
  '@ai-sdk/perplexity': 'https://api.perplexity.ai',
  '@ai-sdk/cerebras': 'https://api.cerebras.ai/v1',
  '@ai-sdk/cohere': 'https://api.cohere.com/v2',
  '@openrouter/ai-sdk-provider': 'https://openrouter.ai/api/v1',
};

// Load the cached registry (if any) into normalized providers.
// @returns {Object<string, RegistryProvider> | null}  null when no cache exists
//
// Memoized: the cache file is static within a process, and callers (hasApiKey
// -> envNamesFor, once per provider) would otherwise re-parse the multi-MB
// file hundreds of times — the #1 source of UI stalls (e.g. a 4s /models).
// fetchRegistry() invalidates the memo after writing a fresh cache; tests use
// cache-busted imports, so each fixture gets its own memo.
let registryCache = null;
let registryCacheKey = "";
let registryCacheMtime = 0;
function invalidateRegistryCache() {
  registryCache = null;
  registryCacheKey = "";
  registryCacheMtime = 0;
}
function loadRegistry() {
  const file = registryFile();
  if (!fs.existsSync(file)) return null;
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (registryCache && registryCacheKey === file && registryCacheMtime === mtime) {
      return registryCache;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    /** @type {Object<string, RegistryProvider>} */
    const out = {};
    for (const [id, p] of Object.entries(raw)) {
      if (!p || typeof p !== 'object' || !p.models) continue;
      out[id] = normalizeProvider(id, p);
    }
    registryCache = out;
    registryCacheKey = file;
    registryCacheMtime = mtime;
    return out;
  } catch {
    return null;
  }
}

/**
 * Whether the cached registry is fresh enough to skip a re-fetch.
 * @returns {boolean}
 */
function isRegistryFresh() {
  const file = registryFile();
  if (!fs.existsSync(file)) return false;
  try {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    return age < MAX_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Fetch the registry from models.dev and cache it. Returns the number of
 * providers cached, or 0 on any failure (offline — the previous cache or the
 * built-in providers keep working).
 * @param {number=} timeoutMs
 * @returns {Promise<number>}
 */
async function fetchRegistry(timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(REGISTRY_URL, { signal: ctrl.signal });
    if (!res.ok) return 0;
    const parsed = JSON.parse(await res.text());
    if (!parsed || typeof parsed !== 'object') return 0;
    const count = Object.keys(parsed).length;
    if (!count) return 0;
    const file = registryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(parsed));
    invalidateRegistryCache();
    return count;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

// Env var names that hold a provider's API key. Built-ins keep their legacy
// names; registry providers use the env names models.dev publishes for them.
const BUILTIN_ENV = {
  anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  nvidia: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  tokenrouter: ['TOKENROUTER_API_KEY'],
};

/**
 * @param {string} id
 * @returns {Array<string>}
 */
function envNamesFor(id) {
  if (BUILTIN_ENV[id]) return BUILTIN_ENV[id];
  const reg = loadRegistry();
  if (reg && reg[id] && reg[id].env.length) return reg[id].env;
  return [id.toUpperCase() + '_API_KEY'];
}

module.exports = { REGISTRY_URL, REGISTRY_FILE, loadRegistry, fetchRegistry, isRegistryFresh, envNamesFor, normalizeProvider, SDK_BASE_URLS, invalidateRegistryCache };