const { createOpenAICompatProvider } = require('./openai-compat');
const { getApiKey } = require('../config/settings');

function getKey() {
  return getApiKey('google') || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
}

const provider = createOpenAICompatProvider({
  getKey,
  providerId: 'google',
  envKeyHint: 'GOOGLE',
});

provider.models = [
  // ── Frontier ──
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', tags: ['frontier'], context: 1000000, priceIn: 1.25, priceOut: 10 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', tags: ['fast'], context: 1000000, priceIn: 0.3, priceOut: 2.5 },
  // ── Flash ──
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'google', tags: [], context: 1000000, priceIn: 0.1, priceOut: 0.4 },
  { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', provider: 'google', tags: ['free', 'fast'], context: 1000000, priceIn: 0.075, priceOut: 0.3 },
  // ── Legacy ──
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', provider: 'google', tags: [], context: 1000000, priceIn: 0.075, priceOut: 0.3 },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'google', tags: [], context: 2000000, priceIn: 1.25, priceOut: 5 },
  // ── Gemma (Local / On-device) ──
  { id: 'gemma-4-31b-it', name: 'Gemma 4 31B IT', provider: 'google', tags: ['small'], context: 32768, priceIn: 0.2, priceOut: 0.8 },
];

module.exports = provider;
