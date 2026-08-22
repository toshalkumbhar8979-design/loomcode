const { createOpenAICompatProvider } = require('./openai-compat');
const { getApiKey } = require('../config/settings');

function getKey() {
  return getApiKey('nvidia') || process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY;
}

// Model IDs below are a curated subset of NVIDIA's live GET /v1/models registry
// (fetched 2026-08-13). Stale IDs — e.g. meta/llama-3.1-405b-instruct,
// deepseek-ai/deepseek-v4-flash, minimax-ai/minimax-m2.7 — return 404/410 and
// were deliberately removed. Re-verify against /v1/models before adding any ID.
const provider = {
  ...createOpenAICompatProvider({
    getKey,
    providerId: 'nvidia',
    envKeyHint: 'NVIDIA',
  }),
  models: [
  // ── DeepSeek ──
  { id: 'deepseek-ai/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash', provider: 'nvidia', tags: ['free', 'fast'], context: 200000, priceIn: 0, priceOut: 0 },
  { id: 'deepseek-ai/deepseek-coder-6.7b-instruct', name: 'DeepSeek Coder 6.7B', provider: 'nvidia', tags: ['coding'], context: 16384, priceIn: 0.10, priceOut: 0.10 },

  // ── Meta Llama ──
  { id: 'meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B Instruct', provider: 'nvidia', tags: ['fast'], context: 128000, priceIn: 0.05, priceOut: 0.08 },
  { id: 'meta/llama-3.1-70b-instruct', name: 'Llama 3.1 70B Instruct', provider: 'nvidia', tags: ['general'], context: 128000, priceIn: 0.35, priceOut: 0.40 },
  { id: 'meta/llama-3.2-3b-instruct', name: 'Llama 3.2 3B Instruct', provider: 'nvidia', tags: ['fast'], context: 128000, priceIn: 0.02, priceOut: 0.02 },
  { id: 'meta/llama-3.2-11b-vision-instruct', name: 'Llama 3.2 11B Vision', provider: 'nvidia', tags: ['vision', 'fast'], context: 128000, priceIn: 0.055, priceOut: 0.055 },
  { id: 'meta/llama-3.2-90b-vision-instruct', name: 'Llama 3.2 90B Vision', provider: 'nvidia', tags: ['vision'], context: 128000, priceIn: 0.35, priceOut: 0.40 },
  { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct', provider: 'nvidia', tags: ['general'], context: 128000, priceIn: 0.35, priceOut: 0.40 },
  { id: 'meta/codellama-70b', name: 'CodeLlama 70B', provider: 'nvidia', tags: ['coding'], context: 16384, priceIn: 0.30, priceOut: 0.30 },
  { id: 'meta/muse-glimmer-30b', name: 'Llama Muse Glimmer 30B', provider: 'nvidia', tags: ['creative'], context: 32768, priceIn: 0.20, priceOut: 0.20 },

  // ── NVIDIA Nemotron ──
  { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Llama 3.1 Nemotron 70B', provider: 'nvidia', tags: ['general'], context: 128000, priceIn: 0.35, priceOut: 0.40 },
  { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', name: 'Nemotron Ultra 253B', provider: 'nvidia', tags: ['frontier'], context: 128000, priceIn: 1.50, priceOut: 6.00 },
  { id: 'nvidia/llama-3.3-nemotron-super-49b-v1', name: 'Nemotron Super 49B', provider: 'nvidia', tags: ['reasoning'], context: 128000, priceIn: 0.25, priceOut: 0.90 },
  { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', name: 'Nemotron Super 49B v1.5', provider: 'nvidia', tags: ['reasoning'], context: 128000, priceIn: 0.25, priceOut: 0.90 },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra 550B', provider: 'nvidia', tags: ['frontier'], context: 256000, priceIn: 2.00, priceOut: 8.00 },
  { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B', provider: 'nvidia', tags: ['frontier'], context: 256000, priceIn: 1.00, priceOut: 4.00 },
  { id: 'nvidia/nemotron-3-nano-30b-a3b', name: 'Nemotron 3 Nano 30B', provider: 'nvidia', tags: ['fast'], context: 128000, priceIn: 0.10, priceOut: 0.40 },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', name: 'Nemotron 3 Nano Omni (Reasoning)', provider: 'nvidia', tags: ['reasoning', 'small'], context: 128000, priceIn: 0.10, priceOut: 0.40 },
  { id: 'nvidia/nemotron-4-340b-instruct', name: 'Nemotron-4 340B Instruct', provider: 'nvidia', tags: ['frontier'], context: 4096, priceIn: 1.00, priceOut: 3.00 },
  { id: 'nvidia/nemotron-mini-4b-instruct', name: 'Nemotron Mini 4B', provider: 'nvidia', tags: ['fast'], context: 32768, priceIn: 0.03, priceOut: 0.03 },
  { id: 'nvidia/nemotron-nano-3-30b-a3b', name: 'Nemotron Nano 3 30B', provider: 'nvidia', tags: ['fast'], context: 128000, priceIn: 0.10, priceOut: 0.40 },
  { id: 'nvidia/nemotron-nano-12b-v2-vl', name: 'Nemotron Nano 12B V2 VL', provider: 'nvidia', tags: ['vision'], context: 128000, priceIn: 0.10, priceOut: 0.40 },
  { id: 'nvidia/nvidia-nemotron-nano-9b-v2', name: 'Nemotron Nano 9B V2', provider: 'nvidia', tags: ['fast'], context: 128000, priceIn: 0.05, priceOut: 0.20 },

  // ── Mistral ──
  { id: 'mistralai/mistral-7b-instruct-v0.3', name: 'Mistral 7B Instruct', provider: 'nvidia', tags: ['fast'], context: 32768, priceIn: 0.05, priceOut: 0.05 },
  { id: 'mistralai/mistral-large', name: 'Mistral Large', provider: 'nvidia', tags: ['frontier'], context: 128000, priceIn: 2.00, priceOut: 6.00 },
  { id: 'mistralai/mistral-large-2-instruct', name: 'Mistral Large 2 Instruct', provider: 'nvidia', tags: ['frontier'], context: 128000, priceIn: 2.00, priceOut: 6.00 },
  { id: 'mistralai/codestral-22b-instruct-v0.1', name: 'Codestral 22B', provider: 'nvidia', tags: ['coding'], context: 32768, priceIn: 0.30, priceOut: 0.60 },
  { id: 'mistralai/mixtral-8x22b-v0.1', name: 'Mixtral 8x22B', provider: 'nvidia', tags: [], context: 65536, priceIn: 0.60, priceOut: 0.60 },
  { id: 'nv-mistralai/mistral-nemo-12b-instruct', name: 'Mistral NeMo 12B', provider: 'nvidia', tags: ['fast'], context: 128000, priceIn: 0.05, priceOut: 0.05 },

  // ── Microsoft ──
  { id: 'microsoft/phi-3.5-moe-instruct', name: 'Phi 3.5 MoE', provider: 'nvidia', tags: ['fast'], context: 128000, priceIn: 0.05, priceOut: 0.05 },
  { id: 'microsoft/phi-3-vision-128k-instruct', name: 'Phi 3 Vision 128K', provider: 'nvidia', tags: ['vision'], context: 128000, priceIn: 0.05, priceOut: 0.05 },

  // ── Google ──
  { id: 'google/gemma-3-4b-it', name: 'Gemma 3 4B IT', provider: 'nvidia', tags: ['fast'], context: 32768, priceIn: 0.03, priceOut: 0.03 },
  { id: 'google/gemma-3-12b-it', name: 'Gemma 3 12B IT', provider: 'nvidia', tags: ['general'], context: 128000, priceIn: 0.10, priceOut: 0.10 },
  { id: 'google/gemma-4-31b-it', name: 'Gemma 4 31B IT', provider: 'nvidia', tags: ['general'], context: 32768, priceIn: 0.20, priceOut: 0.80 },
  { id: 'google/codegemma-1.1-7b', name: 'CodeGemma 1.1 7B', provider: 'nvidia', tags: ['coding', 'fast'], context: 16384, priceIn: 0.05, priceOut: 0.05 },

  // ── OpenAI ──
  { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', provider: 'nvidia', tags: ['openai', 'general'], context: 131072, priceIn: 0.25, priceOut: 1.00 },
  { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B', provider: 'nvidia', tags: ['openai', 'fast'], context: 131072, priceIn: 0.10, priceOut: 0.30 },

  // ── Other ──
  { id: 'z-ai/glm-5.2', name: 'GLM-5.2', provider: 'nvidia', tags: [], context: 131072, priceIn: 0.30, priceOut: 1.20 },
  { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', provider: 'nvidia', tags: [], context: 128000, priceIn: 0.20, priceOut: 0.80 },
  { id: 'minimaxai/minimax-m3', name: 'MiniMax M3', provider: 'nvidia', tags: [], context: 200000, priceIn: 0.40, priceOut: 1.60 },
  { id: 'poolside/laguna-xs-2.1', name: 'Laguna XS 2.1', provider: 'nvidia', tags: ['free', 'coding'], context: 131072, priceIn: 0, priceOut: 0 },
  { id: 'stepfun-ai/step-3.7-flash', name: 'Step 3.7 Flash', provider: 'nvidia', tags: ['fast'], context: 128000, priceIn: 0.15, priceOut: 0.40 },
  { id: '01-ai/yi-large', name: 'Yi Large', provider: 'nvidia', tags: [], context: 32768, priceIn: 0.30, priceOut: 0.90 },
  { id: 'ai21labs/jamba-1.5-large-instruct', name: 'Jamba 1.5 Large', provider: 'nvidia', tags: [], context: 256000, priceIn: 0.20, priceOut: 0.80 },
  { id: 'databricks/dbrx-instruct', name: 'DBRX Instruct', provider: 'nvidia', tags: [], context: 32768, priceIn: 0.60, priceOut: 0.60 },
  { id: 'ibm/granite-3.0-8b-instruct', name: 'Granite 3.0 8B', provider: 'nvidia', tags: ['fast'], context: 32768, priceIn: 0.05, priceOut: 0.05 },
  { id: 'ibm/granite-34b-code-instruct', name: 'Granite 34B Code', provider: 'nvidia', tags: ['coding'], context: 16384, priceIn: 0.20, priceOut: 0.20 },
  { id: 'zyphra/zamba2-7b-instruct', name: 'Zamba2 7B', provider: 'nvidia', tags: ['fast'], context: 32768, priceIn: 0.05, priceOut: 0.05 },
],
};

module.exports = provider;
