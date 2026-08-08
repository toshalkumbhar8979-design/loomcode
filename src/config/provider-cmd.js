const { loadConfig, saveConfig } = require('./settings');

function connect(provider, apiKey) {
  const valid = ['anthropic', 'openai', 'nvidia', 'google', 'local'];
  if (!valid.includes(provider)) {
    throw new Error(`Unknown provider: ${provider}. Valid: ${valid.join(', ')}`);
  }
  const config = loadConfig();
  config.provider = provider;
  config.apiKeys = config.apiKeys || {};
  if (apiKey) config.apiKeys[provider] = apiKey;
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
    hasKey: !!(config.apiKeys?.[config.provider] || 
      process.env[`${config.provider.toUpperCase()}_API_KEY`])
  };
}

module.exports = { connect, disconnect, status };