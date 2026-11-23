const { loadConfig, saveConfig, hasApiKey } = require('./settings');
const { loadRegistry } = require('../providers/registry');
const store = require('../auth/store');

function connect(provider, apiKey) {
  const valid = ['anthropic', 'openai', 'nvidia', 'google', 'local'];
  const reg = loadRegistry() || {};
  if (!valid.includes(provider) && !reg[provider]) {
    throw new Error(`Unknown provider: ${provider}. Run /providers to list every supported provider.`);
  }
  const config = loadConfig();
  if (apiKey) {
    store.saveCredential(provider, { type: 'api', method: 'api', apiKey, label: provider + ' API key' });
    if (config.apiKeys) delete config.apiKeys[provider];
  }
  config.provider = provider;
  saveConfig(config);
  return `Connected to ${provider}.`;
}

function disconnect() {
  const config = loadConfig();
  const old = config.provider;
  config.provider = '';
  config.apiKeys = config.apiKeys || {};
  delete config.apiKeys[old];
  saveConfig(config);
  return `Disconnected from ${old}.`;
}

function status() {
  const config = loadConfig();
  return {
    provider: config.provider,
    model: config.model?.[config.provider] || 'default',
    hasKey: hasApiKey(config.provider),
  };
}

module.exports = { connect, disconnect, status };