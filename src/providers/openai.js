const { createOpenAICompatProvider } = require('./openai-compat');

function getKey() {
  return process.env.OPENAI_API_KEY;
}

const provider = createOpenAICompatProvider({
  getKey,
  providerId: 'openai',
  envKeyHint: 'OPENAI',
});

provider.models = [
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai', tags: ['frontier'], context: 400000, priceIn: 1.25, priceOut: 10 },
  { id: 'gpt-5-fast', name: 'GPT-5 Fast', provider: 'openai', tags: ['fast'], context: 400000, priceIn: 1.25, priceOut: 10 },
  { id: 'gpt-5-pro', name: 'GPT-5 Pro', provider: 'openai', tags: ['frontier', 'pro'], context: 400000, priceIn: 1.25, priceOut: 10 },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', provider: 'openai', tags: [], context: 400000, priceIn: 0.25, priceOut: 2 },
  { id: 'gpt-5-nano', name: 'GPT-5 Nano', provider: 'openai', tags: ['cheap'], context: 400000, priceIn: 0.1, priceOut: 0.4 },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', tags: ['legacy'], context: 128000, priceIn: 2.5, priceOut: 10 },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', tags: [], context: 128000, priceIn: 0.15, priceOut: 0.6 },
  { id: 'o3', name: 'O3', provider: 'openai', tags: ['reasoning'], context: 200000, priceIn: 2, priceOut: 8 },
  { id: 'o3-pro', name: 'O3 Pro', provider: 'openai', tags: ['reasoning', 'pro'], context: 200000, priceIn: 10, priceOut: 40 },
  { id: 'o3-mini', name: 'O3 Mini', provider: 'openai', tags: ['reasoning'], context: 200000, priceIn: 1.1, priceOut: 4.4 },
  { id: 'o1', name: 'O1', provider: 'openai', tags: ['reasoning'], context: 200000, priceIn: 15, priceOut: 60 },
];

module.exports = provider;
