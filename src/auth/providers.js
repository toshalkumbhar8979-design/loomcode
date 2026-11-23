const { loadRegistry } = require('../providers/registry');

const BUILTIN_LABELS = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  nvidia: 'NVIDIA NIM',
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  tokenrouter: 'Token Router',
  local: 'Local (Ollama/LM Studio)',
};

/**
 * @typedef {Object} AuthMethod
 * @property {string} id
 * @property {string} label
 * @property {'api'|'openrouter'|'anthropic'|'google'|'chatgpt'|'copilot'} kind
 * @property {string=} description
 * @property {string=} envHint
 */

/**
 * @typedef {Object} AuthProvider
 * @property {string} id
 * @property {string} provider
 * @property {string} label
 * @property {string} description
 * @property {boolean=} recommended
 * @property {Array<AuthMethod>} methods
 */

/** @type {Array<AuthProvider>} */
const MENU_PROVIDERS = [
  {
    id: 'opencode',
    provider: 'opencode',
    label: 'OpenCode',
    description: 'OpenCode Zen hosted models',
    recommended: true,
    methods: [
      { id: 'api', label: 'API key', kind: 'api', description: 'Paste an OpenCode API key', envHint: 'OPENCODE_API_KEY' },
    ],
  },
  {
    id: 'openai',
    provider: 'openai',
    label: 'OpenAI',
    description: 'ChatGPT account or OpenAI API key',
    methods: [
      { id: 'chatgpt', label: 'ChatGPT account', kind: 'chatgpt', description: 'Sign in with your ChatGPT account' },
      { id: 'api', label: 'API key', kind: 'api', description: 'Paste an OpenAI API key', envHint: 'OPENAI_API_KEY' },
    ],
  },
  {
    id: 'github-copilot',
    provider: 'github-copilot',
    label: 'GitHub Copilot',
    description: 'Use a Copilot subscription',
    methods: [
      { id: 'device', label: 'GitHub device login', kind: 'copilot', description: 'Authorize with your GitHub account' },
    ],
  },
  {
    id: 'google',
    provider: 'google',
    label: 'Google',
    description: 'Gemini account or Gemini API key',
    methods: [
      { id: 'oauth', label: 'Google account', kind: 'google', description: 'Sign in with Google in your browser' },
      { id: 'api', label: 'API key', kind: 'api', description: 'Paste a Gemini API key', envHint: 'GOOGLE_API_KEY' },
    ],
  },
  {
    id: 'anthropic',
    provider: 'anthropic',
    label: 'Anthropic',
    description: 'Claude account or Anthropic API key',
    methods: [
      { id: 'oauth', label: 'Claude account', kind: 'anthropic', description: 'Sign in with your Claude account' },
      { id: 'api', label: 'API key', kind: 'api', description: 'Paste an Anthropic API key', envHint: 'ANTHROPIC_API_KEY' },
    ],
  },
  {
    id: 'openrouter',
    provider: 'openrouter',
    label: 'OpenRouter',
    description: 'One key for many hosted models',
    methods: [
      { id: 'oauth', label: 'OpenRouter sign-in', kind: 'openrouter', description: 'Create a key through OpenRouter' },
      { id: 'api', label: 'API key', kind: 'api', description: 'Paste an OpenRouter API key', envHint: 'OPENROUTER_API_KEY' },
    ],
  },
  {
    id: 'vercel',
    provider: 'vercel',
    label: 'Vercel AI Gateway',
    description: 'Vercel AI Gateway models',
    methods: [
      { id: 'api', label: 'API key', kind: 'api', description: 'Paste a Vercel AI Gateway key', envHint: 'AI_GATEWAY_API_KEY' },
    ],
  },
];

const ALIASES = {
  chatgpt: 'openai',
  claude: 'anthropic',
  gemini: 'google',
  copilot: 'github-copilot',
  'github-copilot-chat': 'github-copilot',
  vercel_ai_gateway: 'vercel',
  'vercel-ai-gateway': 'vercel',
  opencode_zen: 'opencode',
};

/**
 * @param {string} id
 * @returns {string}
 */
function normalizeProviderId(id) {
  const value = String(id || '').trim().toLowerCase();
  return ALIASES[value] || value;
}

/**
 * @param {string} id
 * @returns {AuthProvider}
 */
function getAuthProvider(id) {
  const normalized = normalizeProviderId(id);
  const menu = MENU_PROVIDERS.find((p) => p.id === normalized);
  if (menu) return menu;
  const reg = loadRegistry() || {};
  const rp = reg[normalized];
  const label = BUILTIN_LABELS[normalized] || (rp && rp.name) || normalized;
  const envHint = (rp && rp.env && rp.env[0]) || normalized.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY';
  return {
    id: normalized,
    provider: normalized,
    label,
    description: 'API-key provider',
    methods: [
      { id: 'api', label: 'API key', kind: 'api', description: 'Paste the provider API key', envHint },
    ],
  };
}

/**
 * @returns {Array<AuthProvider>}
 */
function getMenuProviders() {
  return MENU_PROVIDERS.slice();
}

/**
 * @param {AuthProvider} provider
 * @returns {AuthMethod}
 */
function defaultMethod(provider) {
  return provider.methods[0];
}

/**
 * @param {AuthProvider} provider
 * @param {string} methodId
 * @returns {AuthMethod | null}
 */
function getMethod(provider, methodId) {
  return provider.methods.find((m) => m.id === methodId) || null;
}

/**
 * @param {string} providerId
 * @returns {string}
 */
function providerLabel(providerId) {
  const provider = getAuthProvider(providerId);
  return provider.label;
}

module.exports = {
  MENU_PROVIDERS,
  normalizeProviderId,
  getAuthProvider,
  getMenuProviders,
  defaultMethod,
  getMethod,
  providerLabel,
};
