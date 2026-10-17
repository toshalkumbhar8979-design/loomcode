const { createOpenAICompatProvider } = require('./openai-compat');

function getKey() {
  return process.env.OPENAI_API_KEY;
}

const provider = {
  ...createOpenAICompatProvider({
    getKey,
    providerId: 'openai',
    envKeyHint: 'OPENAI',
  }),
  models: [
  // ── GPT-6 Series ──
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', provider: 'openai', tags: ['frontier', 'reasoning'], context: 1050000, priceIn: 10, priceOut: 50 },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', provider: 'openai', tags: ['reasoning'], context: 1050000, priceIn: 2, priceOut: 10 },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', provider: 'openai', tags: ['reasoning'], context: 1050000, priceIn: 2, priceOut: 10 },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', provider: 'openai', tags: ['fast', 'cheap', 'reasoning'], context: 1050000, priceIn: 0.1, priceOut: 0.5 },

  // ── GPT-5.6 / 5.5 / 5.4 ──
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai', tags: ['reasoning'], context: 1050000, priceIn: 4, priceOut: 20 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'openai', tags: ['reasoning'], context: 1050000, priceIn: 2, priceOut: 12 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'openai', tags: ['fast', 'cheap', 'reasoning'], context: 1050000, priceIn: 0.2, priceOut: 1.2 },
  { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai', tags: ['frontier', 'reasoning'], context: 1050000, priceIn: 5, priceOut: 30 },
  { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', provider: 'openai', tags: ['reasoning', 'pro'], context: 1050000, priceIn: 30, priceOut: 180 },
  { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai', tags: ['reasoning'], context: 1050000, priceIn: 2.5, priceOut: 15 },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openai', tags: ['fast', 'reasoning'], context: 400000, priceIn: 0.75, priceOut: 4.5 },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', provider: 'openai', tags: ['cheap', 'fast', 'reasoning'], context: 400000, priceIn: 0.2, priceOut: 1.25 },
  { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro', provider: 'openai', tags: ['reasoning', 'pro'], context: 1050000, priceIn: 30, priceOut: 180 },

  // ── GPT-5 Codex (coding) ──
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', provider: 'openai', tags: ['coding', 'reasoning'], context: 400000, priceIn: 1.75, priceOut: 14 },
  { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', provider: 'openai', tags: ['coding', 'reasoning'], context: 400000, priceIn: 1.75, priceOut: 14 },
  { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', provider: 'openai', tags: ['coding', 'reasoning'], context: 400000, priceIn: 1.75, priceOut: 14 },
  { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', provider: 'openai', tags: ['coding', 'reasoning'], context: 400000, priceIn: 1.25, priceOut: 10 },
  { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', provider: 'openai', tags: ['coding', 'fast', 'reasoning'], context: 400000, priceIn: 0.25, priceOut: 2 },
  { id: 'gpt-5-codex', name: 'GPT-5 Codex', provider: 'openai', tags: ['coding', 'reasoning'], context: 400000, priceIn: 1.25, priceOut: 10 },

  // ── GPT-5 Series ──
  { id: 'gpt-5.2', name: 'GPT-5.2', provider: 'openai', tags: ['reasoning'], context: 400000, priceIn: 1.75, priceOut: 14 },
  { id: 'gpt-5.2-pro', name: 'GPT-5.2 Pro', provider: 'openai', tags: ['reasoning', 'pro'], context: 400000, priceIn: 21, priceOut: 168 },
  { id: 'gpt-5.1', name: 'GPT-5.1', provider: 'openai', tags: ['reasoning'], context: 400000, priceIn: 1.25, priceOut: 10 },
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai', tags: ['frontier', 'reasoning'], context: 400000, priceIn: 1.25, priceOut: 10 },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', provider: 'openai', tags: ['fast', 'reasoning'], context: 400000, priceIn: 0.25, priceOut: 2 },
  { id: 'gpt-5-nano', name: 'GPT-5 Nano', provider: 'openai', tags: ['cheap', 'fast', 'reasoning'], context: 400000, priceIn: 0.05, priceOut: 0.4 },
  { id: 'gpt-5-pro', name: 'GPT-5 Pro', provider: 'openai', tags: ['reasoning', 'pro'], context: 400000, priceIn: 15, priceOut: 120 },

  // ── O-Series (Reasoning, legacy) ──
  { id: 'o3', name: 'o3', provider: 'openai', tags: ['reasoning', 'legacy'], context: 200000, priceIn: 2, priceOut: 8 },
  { id: 'o3-mini', name: 'o3 Mini', provider: 'openai', tags: ['reasoning', 'fast', 'legacy'], context: 200000, priceIn: 1.1, priceOut: 4.4 },
  { id: 'o4-mini', name: 'o4 Mini', provider: 'openai', tags: ['reasoning', 'fast', 'legacy'], context: 200000, priceIn: 1.1, priceOut: 4.4 },

  // ── GPT-4.1 / 4o (legacy) ──
  { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai', tags: ['legacy'], context: 1047576, priceIn: 2, priceOut: 8 },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', provider: 'openai', tags: ['fast', 'legacy'], context: 1047576, priceIn: 0.4, priceOut: 1.6 },
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', provider: 'openai', tags: ['cheap', 'fast', 'legacy'], context: 1047576, priceIn: 0.1, priceOut: 0.4 },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', tags: ['legacy', 'multimodal'], context: 128000, priceIn: 2.5, priceOut: 10 },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', tags: ['fast', 'multimodal', 'legacy'], context: 128000, priceIn: 0.15, priceOut: 0.6 },
],
};

module.exports = provider;
