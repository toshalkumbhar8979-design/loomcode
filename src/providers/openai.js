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
  // Flagship / GPT-5 Series
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai', tags: ['frontier'], context: 400000, priceIn: 1.25, priceOut: 10 },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', provider: 'openai', tags: ['fast'], context: 400000, priceIn: 0.25, priceOut: 2.00 },
  { id: 'gpt-5-nano', name: 'GPT-5 Nano', provider: 'openai', tags: ['cheap', 'fast'], context: 400000, priceIn: 0.10, priceOut: 0.40 },
  { id: 'gpt-5-chat-latest', name: 'GPT-5 Chat (Latest)', provider: 'openai', tags: ['frontier'], context: 400000, priceIn: 5.00, priceOut: 30.00 },

  // GPT-4 Series & Omni Models
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', tags: ['legacy', 'multimodal'], context: 128000, priceIn: 2.50, priceOut: 10.00 },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', tags: ['fast', 'multimodal'], context: 128000, priceIn: 0.15, priceOut: 0.60 },
  { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai', tags: ['frontier'], context: 1048576, priceIn: 2.00, priceOut: 8.00 },

  // O-Series (Reasoning) Models
  { id: 'o3', name: 'o3', provider: 'openai', tags: ['reasoning', 'frontier'], context: 200000, priceIn: 2.00, priceOut: 8.00 },
  { id: 'o3-mini', name: 'o3 Mini', provider: 'openai', tags: ['reasoning', 'fast'], context: 200000, priceIn: 1.10, priceOut: 4.40 },
  { id: 'o4-mini', name: 'o4 Mini', provider: 'openai', tags: ['reasoning', 'fast'], context: 200000, priceIn: 1.10, priceOut: 4.40 },
  { id: 'o1', name: 'o1', provider: 'openai', tags: ['reasoning'], context: 200000, priceIn: 15.00, priceOut: 60.00 },
  { id: 'o1-pro', name: 'o1 Pro', provider: 'openai', tags: ['reasoning', 'pro'], context: 200000, priceIn: 150.00, priceOut: 600.00 },
  { id: 'o1-mini', name: 'o1 Mini', provider: 'openai', tags: ['reasoning', 'cheap'], context: 128000, priceIn: 1.10, priceOut: 4.40 },
],
};

module.exports = provider;
