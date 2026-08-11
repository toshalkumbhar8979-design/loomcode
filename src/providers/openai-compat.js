/** @type {typeof import('openai').default} */
const OpenAI = /** @type {any} */ (require('openai'));
const { getBaseUrl } = require('../config/settings');

function formatMessages(messages, options) {
  const out = [];
  // System prompt comes from options.system (session.systemPrompt).
  if (options?.system) out.push({ role: 'system', content: options.system });
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content) });
      continue;
    }
    const msg = { role: m.role, content: m.content || '' };
    if (m.toolCalls && m.toolCalls.length) {
      msg.tool_calls = m.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {}) },
      }));
    }
    out.push(msg);
  }
  return out;
}

function parseToolCalls(message) {
  const toolCalls = [];
  for (const tc of message.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
    toolCalls.push({ id: tc.id, name: tc.function.name, input });
  }
  return toolCalls;
}

function formatTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function buildRequest(messages, options) {
  return {
    model: options.model,
    messages: formatMessages(messages, options),
    tools: formatTools(options.tools),
    max_tokens: options.maxTokens || 8192,
    temperature: options.temperature ?? 0.7,
  };
}

function normalize(resp) {
  const choice = resp.choices?.[0];
  const message = choice?.message || {};
  const toolCalls = parseToolCalls(message);
  return {
    content: message.content || '',
    toolCalls,
    usage: resp.usage,
  };
}

function wrapErr(err, modelId, envKeyHint, baseURL) {
  const msg = err.message || 'Unknown error';
  if (!err.status) return new Error(`${envKeyHint || 'API'} error: ${msg}`);
  const status = Number(err.status);
  const hint = String(envKeyHint || 'api').toLowerCase();
  if (status === 401) {
    return new Error(`${envKeyHint || 'API'} 401 Unauthorized: the API key is invalid or expired. Run /connect ${hint} and paste a new key.`);
  }
  if (status === 403) {
    return new Error(`${envKeyHint || 'API'} 403 Forbidden: the API key is not authorized for ${modelId || 'this model'}. You may need to accept the model's terms on the provider site or use a key with access. Run /connect ${hint} to change the key.`);
  }
  if (status === 402) return new Error(`${envKeyHint || 'API'} quota exceeded (${err.status}). The model may not be available on your billing tier for model ${(modelId || '?')}.`);
  if (err.error && err.error.message) return new Error(`${envKeyHint || 'API'} error ${status}: ${err.error.message}`);
  if (err.body && err.body.message) return new Error(`${envKeyHint || 'API'} error ${status}: ${err.body.message}`);
  if (!msg || msg.indexOf('no body') >= 0) {
    const modelHint = modelId ? ` (model: ${modelId})` : '';
    return new Error(`${envKeyHint || 'API'} error ${status}${modelHint}. Check model name or URL:\n${baseURL || '(default)'}`);
  }
  return new Error(`${envKeyHint || 'API'} error ${status}: ${msg}`);
}

async function retryWithBackoff(fn, maxTries, envKeyHint) {
  let lastErr;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isAbortError(err)) throw err;
      const status = err.status || err.code;
      if (status !== 429 && status !== 503 && status !== 502) throw lastErr;
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(3, attempt - 1), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}

// Aborts surface as AbortError, APIUserAbortError (openai SDK), or wrapped
// messages containing "aborted". Never let an interrupt be retried or wrapped.
function isAbortError(err) {
  if (!err) return false;
  const name = String(err.name || err.error?.name || '');
  if (name === 'AbortError' || name === 'APIUserAbortError') return true;
  return /aborted|cancel(led|ed)/i.test(String(err.message || ''));
}

/**
 * @typedef {Object} ProviderModel
 * @property {string} id
 * @property {string} name
 * @property {string} provider
 * @property {Array<string>=} tags
 * @property {number} context
 * @property {number} priceIn
 * @property {number} priceOut
 */

/**
 * @typedef {Object} Provider
 * @property {(messages: Array<Object>, options: Object) => Promise<Object>} chat
 * @property {(messages: Array<Object>, options: Object, onDelta?: (text: string) => void) => Promise<Object>} stream
 * @property {Array<ProviderModel>} models
 */

/**
 * @param {{ getKey: () => string|undefined, providerId: string, envKeyHint: string, clientFactory?: () => any }} config
 * @returns {Provider}
 */
function createOpenAICompatProvider({ getKey, providerId, envKeyHint, clientFactory }) {
  function getClient() {
    if (clientFactory) return clientFactory();
    const key = getKey();
    if (!key) throw new Error(`${envKeyHint || 'API'} key not set. Use /connect or set the ${envKeyHint || 'API'}_API_KEY env var.`);
    const baseURL = getBaseUrl(providerId) || getDefaultBaseUrl(providerId);
    return new OpenAI({ apiKey: key, baseURL });
  }

  async function chat(messages, options = {}) {
    const client = getClient();
    const req = buildRequest(messages, options);
    const requestOpts = { signal: options.signal };
    try {
      const resp = await retryWithBackoff(() => client.chat.completions.create(req, requestOpts), 4, envKeyHint);
      return normalize(resp);
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw wrapErr(err, options.model || '?', envKeyHint, getBaseUrl(providerId));
    }
  }

  async function stream(messages, options = {}, onDelta, onReasoning) {
    const client = getClient();
    const req = { ...buildRequest(messages, options), stream: true, stream_options: { include_usage: true } };
    const requestOpts = { signal: options.signal };
    try {
      const s = await retryWithBackoff(() => client.chat.completions.create(req, requestOpts), 4, envKeyHint);
      let content = '';
      let reasoning = '';
      let usage = null;
      const toolAcc = new Map();

      for await (const chunk of s) {
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta || {};
        // DeepSeek-style reasoning_content / OpenRouter reasoning deltas.
        const rt = delta.reasoning_content || delta.reasoning;
        if (typeof rt === 'string' && rt) {
          reasoning += rt;
          if (onReasoning) onReasoning(rt);
          continue;
        }
        if (delta.content) {
          content += delta.content;
          if (onDelta) onDelta(delta.content);
          continue;
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolAcc.has(tc.index)) toolAcc.set(tc.index, { id: '', name: '', args: '' });
            const acc = toolAcc.get(tc.index);
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
          }
        }
      }

      const toolCalls = [];
      for (const acc of toolAcc.values()) {
        let input = {};
        try { input = JSON.parse(acc.args || '{}'); } catch {}
        toolCalls.push({ id: acc.id, name: acc.name, input });
      }

      return { content, reasoning, toolCalls, usage };
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw wrapErr(err, options.model || '?', envKeyHint, getBaseUrl(providerId));
    }
  }

  return { chat, stream, models: /** @type {Array<ProviderModel>} */ ([]) };
}

function getDefaultBaseUrl(providerId) {
  const defaults = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com/v1',
    nvidia: 'https://integrate.api.nvidia.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    openrouter: 'https://openrouter.ai/api/v1',
    tokenrouter: 'https://api.tokenrouter.com/v1',
    local: 'http://localhost:11434/v1',
  };
  return defaults[providerId] || undefined;
}

module.exports = { createOpenAICompatProvider, wrapErr, buildRequest, formatMessages, formatTools, parseToolCalls, normalize, retryWithBackoff };
