const { createOpenAICompatProvider } = require('./openai-compat');
const { getApiKey } = require('../config/settings');

function getKey() {
  return getApiKey('openrouter') || process.env.OPENROUTER_API_KEY;
}

const provider = {
  ...createOpenAICompatProvider({
    getKey,
    providerId: 'openrouter',
    envKeyHint: 'OPENROUTER',
  }),
  models: [
  // Anthropic Models
  { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus (via OpenRouter)', provider: 'openrouter', context: 200000, priceIn: 15, priceOut: 75 },
  
  // OpenAI Models
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini (via OpenRouter)', provider: 'openrouter', context: 128000, priceIn: 0.15, priceOut: 0.60 },
  { id: 'openai/gpt-4o', name: 'GPT-4o (via OpenRouter)', provider: 'openrouter', context: 128000, priceIn: 2.50, priceOut: 10.00 },
  { id: 'openai/o3-mini-high', name: 'O3 Mini High (via OpenRouter)', provider: 'openrouter', context: 200000, priceIn: 1.10, priceOut: 4.40 },
  { id: 'openai/o1', name: 'O1 (via OpenRouter)', provider: 'openrouter', context: 200000, priceIn: 15, priceOut: 60 },
  
  // Google Models
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro (via OpenRouter)', provider: 'openrouter', context: 1048576, priceIn: 1.25, priceOut: 10 },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash (via OpenRouter)', provider: 'openrouter', context: 1048576, priceIn: 0.15, priceOut: 1.25 },
  
  // DeepSeek
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash (via OpenRouter)', provider: 'openrouter', context: 1048576, priceIn: 0.07, priceOut: 0.18 },
  
  // NVIDIA free-tier variants (the :free slugs are genuinely free on
  // OpenRouter; the un-suffixed Nemotron IDs are paid and must not be tagged free)
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super (free, via OpenRouter)', provider: 'openrouter', tags: ['free'], context: 262144, priceIn: 0, priceOut: 0 },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra (free, via OpenRouter)', provider: 'openrouter', tags: ['free'], context: 1048576, priceIn: 0, priceOut: 0 },
  
  // Other Top-Tier Alternatives
  { id: 'zhipuai/glm-4-plus', name: 'GLM-4 Plus (via OpenRouter)', provider: 'openrouter', context: 128000, priceIn: 1.5, priceOut: 1.5 },
  { id: 'minimax/minimax-01', name: 'MiniMax-01 (via OpenRouter)', provider: 'openrouter', context: 1000000, priceIn: 0.14, priceOut: 1.4 },
  { id: 'mistralai/mistral-large-2411', name: 'Mistral Large 2411 (via OpenRouter)', provider: 'openrouter', context: 128000, priceIn: 2, priceOut: 6 }
]
};

module.exports = provider;
