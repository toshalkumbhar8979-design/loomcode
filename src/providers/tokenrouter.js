const { createOpenAICompatProvider } = require('./openai-compat');
const { getApiKey } = require('../config/settings');

function getKey() {
  return getApiKey('tokenrouter') || process.env.TOKENROUTER_API_KEY;
}

const provider = {
  ...createOpenAICompatProvider({
    getKey,
    providerId: 'tokenrouter',
    envKeyHint: 'TOKENROUTER',
  }),
  models: [
  // models.dev (2026-10-17): TokenRouter's only listed model is the free
  // GLM-5.3 endpoint; the earlier moonshotai/kimi-k3-free ID is gone and
  // returns an error. Verified against the models.dev registry cache.
  { id: 'z-ai/glm-5.3-free', name: 'GLM 5.3 Free', provider: 'tokenrouter', tags: ['free'], context: 1000000, priceIn: 0, priceOut: 0 },
  ],
};

module.exports = provider;