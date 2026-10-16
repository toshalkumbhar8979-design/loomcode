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
  // ── Anthropic ──
  { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5 (via OpenRouter)', provider: 'openrouter', tags: ['frontier', 'reasoning'], context: 1000000, priceIn: 4, priceOut: 20 },
  { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8 (via OpenRouter)', provider: 'openrouter', tags: ['frontier', 'reasoning'], context: 1000000, priceIn: 5, priceOut: 25 },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5 (via OpenRouter)', provider: 'openrouter', tags: ['reasoning'], context: 1000000, priceIn: 2, priceOut: 10 },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (via OpenRouter)', provider: 'openrouter', tags: ['reasoning'], context: 1000000, priceIn: 3, priceOut: 15 },
  { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5 (via OpenRouter)', provider: 'openrouter', tags: ['fast', 'reasoning'], context: 1000000, priceIn: 0.1, priceOut: 0.5 },

  // ── OpenAI ──
  { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra (via OpenRouter)', provider: 'openrouter', tags: ['frontier', 'reasoning'], context: 1050000, priceIn: 10, priceOut: 50 },
  { id: 'openai/gpt-6-sol', name: 'GPT-6 Sol (via OpenRouter)', provider: 'openrouter', tags: ['reasoning'], context: 1050000, priceIn: 2, priceOut: 10 },
  { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna (via OpenRouter)', provider: 'openrouter', tags: ['fast', 'cheap', 'reasoning'], context: 1050000, priceIn: 0.1, priceOut: 0.5 },
  { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol (via OpenRouter)', provider: 'openrouter', tags: ['reasoning'], context: 1050000, priceIn: 4, priceOut: 20 },
  { id: 'openai/gpt-5.6-terra', name: 'GPT-5.6 Terra (via OpenRouter)', provider: 'openrouter', tags: ['reasoning'], context: 1050000, priceIn: 2, priceOut: 12 },
  { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna (via OpenRouter)', provider: 'openrouter', tags: ['fast', 'cheap', 'reasoning'], context: 1050000, priceIn: 0.2, priceOut: 1.2 },
  { id: 'openai/gpt-5.5', name: 'GPT-5.5 (via OpenRouter)', provider: 'openrouter', tags: ['frontier', 'reasoning'], context: 1050000, priceIn: 5, priceOut: 30 },
  { id: 'openai/gpt-5.4', name: 'GPT-5.4 (via OpenRouter)', provider: 'openrouter', tags: ['reasoning'], context: 1050000, priceIn: 2.5, priceOut: 15 },
  { id: 'openai/gpt-5.3-codex', name: 'GPT-5.3 Codex (via OpenRouter)', provider: 'openrouter', tags: ['coding', 'reasoning'], context: 400000, priceIn: 1.75, priceOut: 14 },
  { id: 'openai/o3', name: 'o3 (via OpenRouter)', provider: 'openrouter', tags: ['reasoning', 'legacy'], context: 200000, priceIn: 2, priceOut: 8 },

  // ── Google ──
  { id: 'google/gemini-4-argon', name: 'Gemini 4 Argon (via OpenRouter)', provider: 'openrouter', tags: ['frontier', 'reasoning'], context: 1048576, priceIn: 2, priceOut: 10 },
  { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview (via OpenRouter)', provider: 'openrouter', tags: ['frontier', 'reasoning'], context: 1048576, priceIn: 2, priceOut: 12 },
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash (via OpenRouter)', provider: 'openrouter', tags: ['fast', 'reasoning'], context: 1048576, priceIn: 0.82, priceOut: 4.12 },
  { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash (via OpenRouter)', provider: 'openrouter', tags: ['reasoning'], context: 1048576, priceIn: 1.5, priceOut: 9 },

  // ── DeepSeek ──
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (via OpenRouter)', provider: 'openrouter', tags: ['fast', 'reasoning'], context: 1048576, priceIn: 0.04, priceOut: 0.64 },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro (via OpenRouter)', provider: 'openrouter', tags: ['reasoning'], context: 1048576, priceIn: 0.3, priceOut: 0.59 },

  // ── Moonshot / Z.ai / Qwen / MiniMax ──
  { id: 'moonshotai/kimi-k3', name: 'Kimi K3 (via OpenRouter)', provider: 'openrouter', tags: ['frontier', 'reasoning'], context: 1048576, priceIn: 0.3, priceOut: 11.94 },
  { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6 (via OpenRouter)', provider: 'openrouter', tags: ['reasoning'], context: 262144, priceIn: 0.65, priceOut: 3.41 },
  { id: 'z-ai/glm-5.3', name: 'GLM-5.3 (via OpenRouter)', provider: 'openrouter', tags: ['reasoning'], context: 1048576, priceIn: 0.08, priceOut: 4.8 },
  { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash (via OpenRouter)', provider: 'openrouter', tags: ['fast', 'reasoning'], context: 1048576, priceIn: 0.03, priceOut: 0.58 },
  { id: 'qwen/qwen3.5-397b-a17b', name: 'Qwen3.5 397B A17B (via OpenRouter)', provider: 'openrouter', tags: ['reasoning'], context: 262144, priceIn: 0.5, priceOut: 3.6 },
  { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder 480B (via OpenRouter)', provider: 'openrouter', tags: ['coding'], context: 262144, priceIn: 0.3, priceOut: 1 },
  { id: 'qwen/qwen3-coder-flash', name: 'Qwen3 Coder Flash (via OpenRouter)', provider: 'openrouter', tags: ['coding', 'fast'], context: 1000000, priceIn: 0.2, priceOut: 0.98 },
  { id: 'minimax/minimax-m3', name: 'MiniMax M3 (via OpenRouter)', provider: 'openrouter', tags: ['reasoning'], context: 1048576, priceIn: 0.3, priceOut: 1.2 },

  // ── xAI / Meta / Mistral / Cohere / Writer ──
  { id: 'x-ai/grok-4.7', name: 'Grok 4.7 (via OpenRouter)', provider: 'openrouter', tags: ['frontier', 'reasoning'], context: 500000, priceIn: 2, priceOut: 6 },
  { id: 'x-ai/grok-4.3', name: 'Grok 4.3 (via OpenRouter)', provider: 'openrouter', tags: ['reasoning'], context: 1000000, priceIn: 1.25, priceOut: 2.5 },
  { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick (via OpenRouter)', provider: 'openrouter', tags: [], context: 1048576, priceIn: 0.19, priceOut: 0.65 },
  { id: 'meta-llama/llama-4-scout', name: 'Llama 4 Scout (via OpenRouter)', provider: 'openrouter', tags: ['fast'], context: 1310720, priceIn: 0.1, priceOut: 0.3 },
  { id: 'mistralai/mistral-large-4-0', name: 'Mistral Large 4 (via OpenRouter)', provider: 'openrouter', tags: ['frontier'], context: 1048576, priceIn: 0.68, priceOut: 2.09 },
  { id: 'cohere/command-a', name: 'Command A (via OpenRouter)', provider: 'openrouter', tags: [], context: 256000, priceIn: 2.5, priceOut: 10 },
  { id: 'writer/palmyra-x5', name: 'Palmyra X5 (via OpenRouter)', provider: 'openrouter', tags: [], context: 1040000, priceIn: 0.6, priceOut: 6 },

  // ── Free tiers (genuinely free slugs) ──
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super (free, via OpenRouter)', provider: 'openrouter', tags: ['free', 'reasoning'], context: 262144, priceIn: 0, priceOut: 0 },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra (free, via OpenRouter)', provider: 'openrouter', tags: ['free', 'reasoning'], context: 1000000, priceIn: 0, priceOut: 0 },
  { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning (free, via OpenRouter)', provider: 'openrouter', tags: ['free', 'fast', 'reasoning'], context: 1000000, priceIn: 0, priceOut: 0 },
  { id: 'nvidia/nemotron-3.5-super-vl:free', name: 'Nemotron 3.5 Super VL (free, via OpenRouter)', provider: 'openrouter', tags: ['free', 'vision', 'reasoning'], context: 1000000, priceIn: 0, priceOut: 0 },
  { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (free, via OpenRouter)', provider: 'openrouter', tags: ['free', 'reasoning'], context: 262144, priceIn: 0, priceOut: 0 },
  { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B A4B (free, via OpenRouter)', provider: 'openrouter', tags: ['free', 'fast', 'reasoning'], context: 262144, priceIn: 0, priceOut: 0 },
],
};

module.exports = provider;
