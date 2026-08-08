const { createOpenAICompatProvider } = require('./openai-compat');
const { getApiKey } = require('../config/settings');

function getKey() {
  return getApiKey('nvidia') || process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY;
}

const provider = createOpenAICompatProvider({
  getKey,
  providerId: 'nvidia',
  envKeyHint: 'NVIDIA',
});

provider.models = [
  // ── DeepSeek ──
  { id: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek V4 Flash (Free)', provider: 'nvidia', tags: ['free', 'fast'], context: 200000, priceIn: 0, priceOut: 0 },
  { id: 'deepseek-ai/deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'nvidia', tags: ['pro'], context: 200000, priceIn: 0.45, priceOut: 1.8 },
  { id: 'deepseek-ai/deepseek-v3.2', name: 'DeepSeek V3.2', provider: 'nvidia', tags: [], context: 128000, priceIn: 0.28, priceOut: 0.42 },
  { id: 'deepseek-ai/deepseek-v3.1-terminus', name: 'DeepSeek V3.1 Terminus', provider: 'nvidia', tags: [], context: 128000, priceIn: 0.28, priceOut: 0.42 },
  { id: 'deepseek-ai/deepseek-r1', name: 'DeepSeek R1', provider: 'nvidia', tags: ['reasoning'], context: 128000, priceIn: 0.55, priceOut: 2.19 },
  { id: 'deepseek-ai/deepseek-r1-0528', name: 'DeepSeek R1 0528', provider: 'nvidia', tags: ['reasoning'], context: 128000, priceIn: 0.55, priceOut: 2.19 },
  // ── Qwen ──
  { id: 'qwen/qwen3.5-122b-a10b', name: 'Qwen3.5 122B A10B', provider: 'nvidia', tags: [], context: 256000, priceIn: 0.22, priceOut: 0.9 },
  { id: 'qwen/qwen3-next-80b-a3b-instruct', name: 'Qwen3-Next-80B-A3B-Instruct', provider: 'nvidia', tags: [], context: 256000, priceIn: 0.12, priceOut: 0.3 },
  { id: 'qwen/qwen3.5-397b-a17b', name: 'Qwen3.5-397B-A17B', provider: 'nvidia', tags: [], context: 256000, priceIn: 0.4, priceOut: 1.6 },
  { id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B A35B Instruct', provider: 'nvidia', tags: ['coding'], context: 262144, priceIn: 0.4, priceOut: 1.6 },
  { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B A22B', provider: 'nvidia', tags: [], context: 256000, priceIn: 0.22, priceOut: 0.9 },
  { id: 'qwen/qwen3-32b', name: 'Qwen3 32B', provider: 'nvidia', tags: [], context: 131072, priceIn: 0.1, priceOut: 0.3 },
  // ── Nemotron (NVIDIA) ──
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra 550B A55B', provider: 'nvidia', tags: ['frontier'], context: 256000, priceIn: 2, priceOut: 8 },
  { id: 'nvidia/nemotron-3-super', name: 'Nemotron 3 Super', provider: 'nvidia', tags: ['frontier'], context: 256000, priceIn: 1.5, priceOut: 6 },
  { id: 'nvidia/nemotron-3-flash', name: 'Nemotron 3 Flash', provider: 'nvidia', tags: [], context: 131072, priceIn: 0.25, priceOut: 1 },
  { id: 'nvidia/nemotron-3-nano-omni', name: 'Nemotron 3 Nano Omni', provider: 'nvidia', tags: ['small'], context: 128000, priceIn: 0.1, priceOut: 0.4 },
  // ── MiniMax ──
  { id: 'minimax-ai/minimax-m3', name: 'MiniMax-M3', provider: 'nvidia', tags: [], context: 200000, priceIn: 0.4, priceOut: 1.6 },
  { id: 'minimax-ai/minimax-m2.7', name: 'MiniMax-M2.7', provider: 'nvidia', tags: [], context: 200000, priceIn: 0.3, priceOut: 1.2 },
  // ── Mistral ──
  { id: 'mistralai/mistral-medium-3.5', name: 'Mistral Medium 3.5', provider: 'nvidia', tags: [], context: 128000, priceIn: 0.6, priceOut: 2.4 },
  { id: 'mistralai/mistral-large-3-675b-instruct-2512', name: 'Mistral Large 3 675B Instruct 2512', provider: 'nvidia', tags: [], context: 128000, priceIn: 0.8, priceOut: 3.2 },
  { id: 'mistralai/mistral-medium-3', name: 'Mistral Medium 3', provider: 'nvidia', tags: [], context: 128000, priceIn: 0.6, priceOut: 2.4 },
  { id: 'mistralai/mistral-small-3.2-24b-instruct-2506', name: 'Mistral Small 3.2 24B Instruct 2506', provider: 'nvidia', tags: [], context: 128000, priceIn: 0.1, priceOut: 0.3 },
  // ── Free Models ──
  { id: 'ling-3.0-flash', name: 'Ling-3.0-flash (Free)', provider: 'nvidia', tags: ['free'], context: 128000, priceIn: 0, priceOut: 0 },
  { id: 'luma-ai/laguna-s-2.1', name: 'Laguna S 2.1 (Free)', provider: 'nvidia', tags: ['free'], context: 131072, priceIn: 0, priceOut: 0 },
  // ── Google ──
  { id: 'google/gemma-4-31b-it', name: 'Gemma-4-31B-IT', provider: 'nvidia', tags: [], context: 32768, priceIn: 0.2, priceOut: 0.8 },
  { id: 'google/gemma-3-27b-it', name: 'Gemma-3-27B-IT', provider: 'nvidia', tags: [], context: 32768, priceIn: 0.2, priceOut: 0.8 },
  // ── Meta ──
  { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct', provider: 'nvidia', tags: [], context: 128000, priceIn: 0.3, priceOut: 0.9 },
  { id: 'meta/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick 17B', provider: 'nvidia', tags: [], context: 131072, priceIn: 0.2, priceOut: 0.8 },
  { id: 'meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B', provider: 'nvidia', tags: [], context: 131072, priceIn: 0.1, priceOut: 0.4 },
  // ── OpenAI ──
  { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B', provider: 'nvidia', tags: ['openai'], context: 131072, priceIn: 0.25, priceOut: 1 },
  // ── NVIDIA legacy ──
  { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Llama 3.1 Nemotron 70B', provider: 'nvidia', tags: ['legacy'], context: 131072, priceIn: 0.25, priceOut: 0.9 },
  { id: 'nvidia/llama-3.3-nemotron-super-49b-v1', name: 'Llama 3.3 Nemotron Super 49B', provider: 'nvidia', tags: [], context: 131072, priceIn: 0.25, priceOut: 0.9 },
  // ── Microsoft ──
  { id: 'microsoft/phi-4', name: 'Phi-4 14B', provider: 'nvidia', tags: [], context: 16384, priceIn: 0.1, priceOut: 0.2 },
  // ── Zhipu ──
  { id: 'zai-org/glm-5.2', name: 'GLM-5.2', provider: 'nvidia', tags: [], context: 131072, priceIn: 0.3, priceOut: 1.2 },
];

module.exports = provider;
