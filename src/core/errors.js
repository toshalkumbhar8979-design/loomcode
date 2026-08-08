class LoomError extends Error {
  constructor(message, code = 'LOOM_ERR') {
    super(message);
    this.name = 'LoomError';
    this.code = code;
  }
}

class ProviderError extends LoomError {
  constructor(message, provider) {
    super(message, 'PROVIDER_ERR');
    this.provider = provider;
  }
}

class ToolError extends LoomError {
  constructor(message, tool) {
    super(message, 'TOOL_ERR');
    this.tool = tool;
  }
}

class ConfigError extends LoomError {
  constructor(message) {
    super(message, 'CONFIG_ERR');
  }
}

module.exports = { LoomError, ProviderError, ToolError, ConfigError };