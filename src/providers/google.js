const { createOpenAICompatProvider } = require('./openai-compat');
const { getApiKey } = require('../config/settings');

function getKey() {
  return getApiKey('google') || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
}

const provider = {
  ...createOpenAICompatProvider({
    getKey,
    providerId: 'google',
    envKeyHint: 'GOOGLE',
  }),
  models: [
  // ── Gemini 4 / 3.x (current) ──
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', provider: 'google', tags: ['frontier', 'reasoning'], context: 1048576, priceIn: 2, priceOut: 10 },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', provider: 'google', tags: ['frontier', 'reasoning'], context: 1048576, priceIn: 2, priceOut: 12 },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', provider: 'google', tags: ['fast', 'reasoning'], context: 1048576, priceIn: 0.75, priceOut: 3.75 },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', provider: 'google', tags: ['fast', 'reasoning'], context: 1048576, priceIn: 0.75, priceOut: 3.75 },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', provider: 'google', tags: ['fast', 'reasoning'], context: 1048576, priceIn: 0.75, priceOut: 3.75 },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'google', tags: ['reasoning'], context: 1048576, priceIn: 1.5, priceOut: 9 },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', provider: 'google', tags: ['fast', 'cheap', 'reasoning'], context: 1048576, priceIn: 0.3, priceOut: 2.5 },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', provider: 'google', tags: ['fast', 'cheap', 'reasoning'], context: 1048576, priceIn: 0.25, priceOut: 1.5 },
  // ── Aliases ──
  { id: 'gemini-flash-latest', name: 'Gemini Flash (Latest)', provider: 'google', tags: ['fast', 'reasoning'], context: 1048576, priceIn: 0.75, priceOut: 3.75 },
  { id: 'gemini-flash-lite-latest', name: 'Gemini Flash-Lite (Latest)', provider: 'google', tags: ['fast', 'cheap', 'reasoning'], context: 1048576, priceIn: 0.3, priceOut: 2.5 },
  // ── Gemini 2.5 (stable) ──
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', tags: ['frontier'], context: 1048576, priceIn: 1.25, priceOut: 10 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', tags: ['fast'], context: 1048576, priceIn: 0.3, priceOut: 2.5 },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', provider: 'google', tags: ['fast', 'cheap'], context: 1048576, priceIn: 0.1, priceOut: 0.4 },
  // ── Gemma (open weights) ──
  { id: 'gemma-4-31b-it', name: 'Gemma 4 31B IT', provider: 'google', tags: ['reasoning'], context: 262144, priceIn: 0.2, priceOut: 0.8 },
  { id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B IT', provider: 'google', tags: ['fast', 'reasoning'], context: 262144, priceIn: 0.2, priceOut: 0.8 },
  ],
};

module.exports = provider;
