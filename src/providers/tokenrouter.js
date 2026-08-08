const { createOpenAICompatProvider } = require('./openai-compat');
const { getApiKey } = require('../config/settings');

function getKey() {
  return getApiKey('tokenrouter') || process.env.TOKENROUTER_API_KEY;
}

const provider = createOpenAICompatProvider({
  getKey,
  providerId: 'tokenrouter',
  envKeyHint: 'TOKENROUTER',
});

provider.models = [
  { id: 'moonshotai/kimi-k3-free', name: 'Kimi K3 Free', provider: 'tokenrouter', tags: ['free'], context: 128000, priceIn: 0, priceOut: 0 },
];

module.exports = provider;