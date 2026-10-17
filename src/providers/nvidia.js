const { createOpenAICompatProvider } = require('./openai-compat');
const { getApiKey } = require('../config/settings');

function getKey() {
  return getApiKey('nvidia') || process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY;
}

// Model IDs below are a curated subset of NVIDIA's live GET /v1/models
// registry (fetched + cross-checked against models.dev 2026-10-17, 81 live
// models; only chat/completions-capable IDs kept — embeddings, rerankers,
// safety/guard, document-parse, video/vision-specialist and reward models
// are excluded). Stale IDs — e.g. meta/llama-3.1-8b-instruct,
// deepseek-ai/deepseek-v4-flash-0731, z-ai/glm-5.2, openai/gpt-oss-120b —
// return 404/410 and were removed. Re-verify against /v1/models before
// adding any ID.
//
// NOTE (probed 2026-10-17): GET /v1/models is the GLOBAL catalog — a chat
// POST can still fail with `Function '<id>': Not found for account '<key>'`,
// i.e. the model exists but the key's account hasn't enabled it. On one
// sample key only 9/54 of these IDs answered a chat call (37 account-gated
// 404s, ~6 hang to timeout, 2 return 503 capacity errors), so the picker
// may offer models that 404 for a given account. Availability is
// per-account, so the full curated list stays; NVIDIA's own errors carry
// the account hint.
const provider = {
  ...createOpenAICompatProvider({
    getKey,
    providerId: 'nvidia',
    envKeyHint: 'NVIDIA',
  }),
  models: [
  // ── DeepSeek ──
  { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'nvidia', tags: ['reasoning', 'fast'], context: 1000000, priceIn: 0.14, priceOut: 0.28 },
  { id: 'deepseek-ai/deepseek-coder-6.7b-instruct', name: 'DeepSeek Coder 6.7B', provider: 'nvidia', tags: ['coding'], context: 16384, priceIn: 0.10, priceOut: 0.10 },

  // ── Meta Llama ──
  { id: 'meta/llama-3.2-11b-vision-instruct', name: 'Llama 3.2 11B Vision', provider: 'nvidia', tags: ['vision', 'fast'], context: 128000, priceIn: 0.055, priceOut: 0.055 },
  { id: 'meta/llama-3.2-90b-vision-instruct', name: 'Llama 3.2 90B Vision', provider: 'nvidia', tags: ['vision'], context: 128000, priceIn: 0.35, priceOut: 0.40 },
  { id: 'meta/muse-glimmer-30b', name: 'Llama Muse Glimmer 30B', provider: 'nvidia', tags: ['creative', 'reasoning'], context: 131072, priceIn: 0.20, priceOut: 0.20 },
  { id: 'meta/codellama-70b', name: 'CodeLlama 70B', provider: 'nvidia', tags: ['coding'], context: 16384, priceIn: 0.30, priceOut: 0.30 },
  { id: 'meta/llama2-70b', name: 'Llama 2 70B', provider: 'nvidia', tags: ['legacy'], context: 4096, priceIn: 0.20, priceOut: 0.20 },

  // ── NVIDIA Nemotron ──
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra 550B', provider: 'nvidia', tags: ['frontier', 'reasoning'], context: 1000000, priceIn: 0.50, priceOut: 2.50 },
  { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B', provider: 'nvidia', tags: ['reasoning'], context: 262144, priceIn: 0.25, priceOut: 1.00 },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', name: 'Nemotron 3 Nano Omni (Reasoning)', provider: 'nvidia', tags: ['reasoning', 'fast'], context: 256000, priceIn: 0.10, priceOut: 0.40 },
  { id: 'nvidia/nemotron-nano-3-30b-a3b', name: 'Nemotron Nano 3 30B', provider: 'nvidia', tags: ['fast'], context: 128000, priceIn: 0.10, priceOut: 0.40 },
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'Nemotron 3.5 Lightning 30B', provider: 'nvidia', tags: ['reasoning', 'fast'], context: 262144, priceIn: 0.10, priceOut: 0.40 },
  { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', name: 'Nemotron 3.5 Super VL 120B', provider: 'nvidia', tags: ['vision', 'reasoning'], context: 1000000, priceIn: 0.25, priceOut: 1.00 },
  { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', name: 'Nemotron Ultra 253B', provider: 'nvidia', tags: ['frontier', 'reasoning'], context: 128000, priceIn: 1.50, priceOut: 6.00 },
  { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Llama 3.1 Nemotron 70B', provider: 'nvidia', tags: ['general'], context: 128000, priceIn: 0.35, priceOut: 0.40 },
  { id: 'nvidia/llama-3.1-nemotron-51b-instruct', name: 'Llama 3.1 Nemotron 51B', provider: 'nvidia', tags: ['general'], context: 128000, priceIn: 0.20, priceOut: 0.80 },
  { id: 'nvidia/llama3-chatqa-1.5-70b', name: 'Llama3 ChatQA 1.5 70B', provider: 'nvidia', tags: ['general'], context: 8192, priceIn: 0.30, priceOut: 0.30 },
  { id: 'nvidia/mistral-nemo-minitron-8b-8k-instruct', name: 'Mistral NeMo Minitron 8B', provider: 'nvidia', tags: ['fast'], context: 8192, priceIn: 0.05, priceOut: 0.05 },
  { id: 'nvidia/nemotron-4-340b-instruct', name: 'Nemotron-4 340B Instruct', provider: 'nvidia', tags: ['frontier', 'legacy'], context: 4096, priceIn: 1.00, priceOut: 3.00 },

  // ── Mistral ──
  { id: 'mistralai/mistral-large', name: 'Mistral Large', provider: 'nvidia', tags: ['frontier'], context: 128000, priceIn: 2.00, priceOut: 6.00 },
  { id: 'mistralai/mistral-large-2-instruct', name: 'Mistral Large 2 Instruct', provider: 'nvidia', tags: ['frontier'], context: 128000, priceIn: 2.00, priceOut: 6.00 },
  { id: 'mistralai/mistral-7b-instruct-v0.3', name: 'Mistral 7B Instruct', provider: 'nvidia', tags: ['fast'], context: 65536, priceIn: 0.05, priceOut: 0.05 },
  { id: 'mistralai/codestral-22b-instruct-v0.1', name: 'Codestral 22B', provider: 'nvidia', tags: ['coding'], context: 32768, priceIn: 0.30, priceOut: 0.60 },
  { id: 'mistralai/mixtral-8x22b-v0.1', name: 'Mixtral 8x22B', provider: 'nvidia', tags: [], context: 65536, priceIn: 0.60, priceOut: 0.60 },
  { id: 'nv-mistralai/mistral-nemo-12b-instruct', name: 'Mistral NeMo 12B', provider: 'nvidia', tags: ['fast'], context: 128000, priceIn: 0.05, priceOut: 0.05 },

  // ── Microsoft ──
  { id: 'microsoft/phi-3.5-moe-instruct', name: 'Phi 3.5 MoE', provider: 'nvidia', tags: ['fast'], context: 128000, priceIn: 0.05, priceOut: 0.05 },
  { id: 'microsoft/phi-3-vision-128k-instruct', name: 'Phi 3 Vision 128K', provider: 'nvidia', tags: ['vision'], context: 128000, priceIn: 0.05, priceOut: 0.05 },

  // ── Google ──
  { id: 'google/gemma-4-31b-it', name: 'Gemma 4 31B IT', provider: 'nvidia', tags: ['general', 'reasoning'], context: 256000, priceIn: 0.20, priceOut: 0.80 },
  { id: 'google/gemma-3-12b-it', name: 'Gemma 3 12B IT', provider: 'nvidia', tags: ['general'], context: 131072, priceIn: 0.10, priceOut: 0.10 },
  { id: 'google/gemma-3-4b-it', name: 'Gemma 3 4B IT', provider: 'nvidia', tags: ['fast'], context: 131072, priceIn: 0.03, priceOut: 0.03 },
  { id: 'google/diffusiongemma-26b-a4b-it', name: 'DiffusionGemma 26B', provider: 'nvidia', tags: ['reasoning'], context: 250000, priceIn: 0.20, priceOut: 0.80 },
  { id: 'google/codegemma-1.1-7b', name: 'CodeGemma 1.1 7B', provider: 'nvidia', tags: ['coding', 'fast'], context: 16384, priceIn: 0.05, priceOut: 0.05 },
  { id: 'google/codegemma-7b', name: 'CodeGemma 7B', provider: 'nvidia', tags: ['coding'], context: 16384, priceIn: 0.05, priceOut: 0.05 },

  // ── OpenAI ──
  { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B', provider: 'nvidia', tags: ['openai', 'reasoning', 'fast'], context: 131072, priceIn: 0.10, priceOut: 0.30 },

  // ── Z.ai / Moonshot ──
  { id: 'z-ai/glm-5.3', name: 'GLM-5.3', provider: 'nvidia', tags: ['reasoning'], context: 1000000, priceIn: 0.30, priceOut: 1.20 },
  { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash', provider: 'nvidia', tags: ['fast', 'reasoning'], context: 1000000, priceIn: 0.05, priceOut: 0.20 },
  { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', provider: 'nvidia', tags: ['reasoning'], context: 262144, priceIn: 0.20, priceOut: 0.80 },

  // ── Other ──
  { id: 'poolside/laguna-xs-2.1', name: 'Laguna XS 2.1', provider: 'nvidia', tags: ['free', 'coding', 'reasoning'], context: 262144, priceIn: 0, priceOut: 0 },
  { id: 'stepfun-ai/step-5-preview', name: 'Step 5 Preview', provider: 'nvidia', tags: ['reasoning'], context: 256000, priceIn: 0.30, priceOut: 1.20 },
  { id: 'writer/palmyra-creative-122b', name: 'Palmyra Creative 122B', provider: 'nvidia', tags: ['creative'], context: 128000, priceIn: 0.90, priceOut: 0.90 },
  { id: 'writer/palmyra-fin-70b-32k', name: 'Palmyra Fin 70B', provider: 'nvidia', tags: ['finance'], context: 32768, priceIn: 0.90, priceOut: 0.90 },
  { id: 'writer/palmyra-med-70b', name: 'Palmyra Med 70B', provider: 'nvidia', tags: ['medical'], context: 128000, priceIn: 0.90, priceOut: 0.90 },
  { id: 'writer/palmyra-med-70b-32k', name: 'Palmyra Med 70B 32K', provider: 'nvidia', tags: ['medical'], context: 32768, priceIn: 0.90, priceOut: 0.90 },
  { id: '01-ai/yi-large', name: 'Yi Large', provider: 'nvidia', tags: [], context: 32768, priceIn: 0.30, priceOut: 0.90 },
  { id: 'ai21labs/jamba-1.5-large-instruct', name: 'Jamba 1.5 Large', provider: 'nvidia', tags: [], context: 256000, priceIn: 0.20, priceOut: 0.80 },
  { id: 'aisingapore/sea-lion-7b-instruct', name: 'Sea-Lion 7B Instruct', provider: 'nvidia', tags: ['fast'], context: 8192, priceIn: 0.05, priceOut: 0.05 },
  { id: 'databricks/dbrx-instruct', name: 'DBRX Instruct', provider: 'nvidia', tags: [], context: 32768, priceIn: 0.60, priceOut: 0.60 },
  { id: 'ibm/granite-3.0-8b-instruct', name: 'Granite 3.0 8B', provider: 'nvidia', tags: ['fast'], context: 32768, priceIn: 0.05, priceOut: 0.05 },
  { id: 'ibm/granite-3.0-3b-a800m-instruct', name: 'Granite 3.0 3B MoE', provider: 'nvidia', tags: ['fast'], context: 32768, priceIn: 0.03, priceOut: 0.03 },
  { id: 'ibm/granite-34b-code-instruct', name: 'Granite 34B Code', provider: 'nvidia', tags: ['coding'], context: 16384, priceIn: 0.20, priceOut: 0.20 },
  { id: 'ibm/granite-8b-code-instruct', name: 'Granite 8B Code', provider: 'nvidia', tags: ['coding', 'fast'], context: 16384, priceIn: 0.10, priceOut: 0.10 },
  { id: 'nvidia/riva-translate-4b-instruct', name: 'Riva Translate 4B', provider: 'nvidia', tags: ['fast', 'translation'], context: 32768, priceIn: 0.05, priceOut: 0.05 },
  { id: 'nvidia/riva-translate-4b-instruct-v2', name: 'Riva Translate 4B v2', provider: 'nvidia', tags: ['fast', 'translation'], context: 32768, priceIn: 0.05, priceOut: 0.05 },
  { id: 'zyphra/zamba2-7b-instruct', name: 'Zamba2 7B', provider: 'nvidia', tags: ['fast'], context: 32768, priceIn: 0.05, priceOut: 0.05 },
],
};

module.exports = provider;
