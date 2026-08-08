const { createOpenAICompatProvider } = require('./openai-compat');
const { getApiKey } = require('../config/settings');

function getKey() {
  return getApiKey('openrouter') || process.env.OPENROUTER_API_KEY;
}

const provider = createOpenAICompatProvider({
  getKey,
  providerId: 'openrouter',
  envKeyHint: 'OPENROUTER',
});

provider.models = [
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 (via OpenRouter)', provider: 'openrouter', context: 200000, priceIn: 3, priceOut: 15 },
  { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4 (via OpenRouter)', provider: 'openrouter', context: 200000, priceIn: 15, priceOut: 75 },
  { id: 'openai/gpt-5-fast', name: 'GPT-5 Fast (via OpenRouter)', provider: 'openrouter', context: 400000, priceIn: 1.25, priceOut: 10 },
  { id: 'openai/gpt-5-pro', name: 'GPT-5 Pro (via OpenRouter)', provider: 'openrouter', context: 400000, priceIn: 1.25, priceOut: 10 },
  { id: 'openai/o3', name: 'O3 (via OpenRouter)', provider: 'openrouter', context: 200000, priceIn: 2, priceOut: 8 },
  { id: 'openai/o1', name: 'O1 (via OpenRouter)', provider: 'openrouter', context: 200000, priceIn: 15, priceOut: 60 },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro (via OpenRouter)', provider: 'openrouter', context: 1000000, priceIn: 1.25, priceOut: 10 },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash (via OpenRouter)', provider: 'openrouter', context: 1000000, priceIn: 0.3, priceOut: 2.5 },
  { id: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek V4 Flash (via OpenRouter)', provider: 'openrouter', tags: ['free'], context: 200000, priceIn: 0, priceOut: 0 },
  { id: 'nvidia/nemotron-3-super', name: 'Nemotron 3 Super (via OpenRouter)', provider: 'openrouter', context: 256000, priceIn: 1.5, priceOut: 6 },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra 550B (via OpenRouter)', provider: 'openrouter', context: 256000, priceIn: 2, priceOut: 8 },
  { id: 'zai-org/glm-5.2', name: 'GLM-5.2 (via OpenRouter)', provider: 'openrouter', context: 131072, priceIn: 0.3, priceOut: 1.2 },
  { id: 'minimax-ai/minimax-m3', name: 'MiniMax-M3 (via OpenRouter)', provider: 'openrouter', context: 200000, priceIn: 0.4, priceOut: 1.6 },
  { id: 'mistralai/mistral-large-3-675b-instruct-2512', name: 'Mistral Large 3 (via OpenRouter)', provider: 'openrouter', context: 128000, priceIn: 0.8, priceOut: 3.2 },
];

module.exports = provider;
