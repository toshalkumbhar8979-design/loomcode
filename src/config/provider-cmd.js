const { loadConfig, saveConfig } = require('./settings');
const { loadRegistry, envNamesFor } = require('../providers/registry');

function connect(provider, apiKey) {
  const valid = ['anthropic', 'openai', 'nvidia', 'google', 'local'];
  const reg = loadRegistry() || {};
  if (!valid.includes(provider) && !reg[provider]) {
    throw new Error(`Unknown provider: ${provider}. Run /providers to list every supported provider.`);
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
    hasKey: !!(config.apiKeys?.[config.provider] || (envNamesFor(config.provider) || []).some(n => !!process.env[n]))
  };
}

module.exports = { connect, disconnect, status };