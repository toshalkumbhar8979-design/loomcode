const { createOpenAICompatProvider } = require('./openai-compat');
const { getApiKey } = require('../config/settings');

function getKey() {
  return getApiKey('local') || process.env.LOCAL_API_KEY || 'local';
}

const provider = createOpenAICompatProvider({
  getKey,
  providerId: 'local',
  envKeyHint: 'LOCAL',
});

provider.models = [
  { id: 'llama3.2', name: 'Llama 3.2 (local)', provider: 'local', tags: ['local'], context: 131072, priceIn: 0, priceOut: 0 },
  { id: 'llama3.2:1b', name: 'Llama 3.2 1B (local)', provider: 'local', tags: ['local', 'small'], context: 131072, priceIn: 0, priceOut: 0 },
  { id: 'mistral', name: 'Mistral 7B (local)', provider: 'local', tags: ['local'], context: 32768, priceIn: 0, priceOut: 0 },
  { id: 'codellama', name: 'CodeLlama 7B (local)', provider: 'local', tags: ['local', 'coding'], context: 16384, priceIn: 0, priceOut: 0 },
  { id: 'gemma2', name: 'Gemma 2 (local)', provider: 'local', tags: ['local'], context: 8192, priceIn: 0, priceOut: 0 },
  { id: 'phi4', name: 'Phi-4 14B (local)', provider: 'local', tags: ['local'], context: 16384, priceIn: 0, priceOut: 0 },
  { id: 'deepseek-coder', name: 'DeepSeek-Coder 6.7B (local)', provider: 'local', tags: ['local', 'coding'], context: 16384, priceIn: 0, priceOut: 0 },
  { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder 14B (local)', provider: 'local', tags: ['local', 'coding'], context: 131072, priceIn: 0, priceOut: 0 },
  { id: 'starcoder2', name: 'StarCoder2 7B (local)', provider: 'local', tags: ['local', 'coding'], context: 16384, priceIn: 0, priceOut: 0 },
];

module.exports = provider;
