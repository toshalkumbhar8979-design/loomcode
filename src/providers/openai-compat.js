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
      // A tool row without its id would be rejected by the API ("missing
      // field tool_call_id" — NVIDIA is strict about this). Skip orphans
      // from hand-edited/resumed sessions instead of failing the turn.
      const tcid = m.toolCallId || m.tool_call_id;
      if (tcid) out.push({ role: 'tool', tool_call_id: tcid, content: String(m.content) });
      continue;
    }
    const msg = { role: m.role, content: m.content || '' };
    const calls = m.toolCalls || m.tool_calls;
    if (calls && calls.length) {
      msg.tool_calls = calls.map(tc => ({
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

function buildRequest(messages, options, providerId) {
  const body = {
    model: options.model,
    messages: formatMessages(messages, options),
    tools: formatTools(options.tools),
    max_tokens: options.maxTokens || 8192,
    temperature: options.temperature ?? 0.7,
  };
  // OpenRouter/TokenRouter prompt caching: top-level "cache_control" true
  // (auto-detects prefix-cache-capable models, ignores it otherwise). Cuts
  // input cost on cache hits (~10% of full price) after the first turn.
  if (providerId === 'openrouter' || providerId === 'tokenrouter') {
    body.cache_control = true;
  }
  // Reasoning models (o1/o3/o4/gpt-5, tagged 'reasoning' by the session):
  // push the effort to "high" so the model reasons deeply on every step —
  // opencode-style multi-pass thinking. Other reasoning families (DeepSeek
  // R1, Qwen QwQ, Kimi K2) emit reasoning_content on their own and don't
  // accept the param, so only the OpenAI effort-capable ids get it. OpenAI
  // effort models also reject a temperature != 1, so drop it.
  if (options.reasoning && /^(o1|o3|o4|gpt-5)/.test(String(options.model || ''))) {
    body.reasoning_effort = 'high';
    // Reasoning models reject max_tokens; the limit moves to
    // max_completion_tokens unchanged.
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    delete body.temperature;
  }
  return body;
}

function normalize(resp) {
  const choice = resp.choices?.[0];
  const message = choice?.message || {};
  const toolCalls = parseToolCalls(message);
  return {
    content: message.content || '',
    toolCalls,
    usage: resp.usage,
    finishReason: choice?.finish_reason || undefined,
  };
}

// Some providers (NVIDIA NIM, Akamai) return an HTML error page for bad model
// IDs. Strip the tags so the TUI shows a readable line instead of raw markup.
function sanitizeErrBody(msg) {
  if (!msg || !/<\/?\w+[^>]*>/.test(msg)) return msg;
  const stripped = String(msg)
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || msg;
}

function wrapErr(err, modelId, envKeyHint, baseURL) {
  const raw = err.message || 'Unknown error';
  const msg = sanitizeErrBody(raw);
  // Carry the HTTP status + Retry-After onto the wrapped error so the
  // session loop can tell a rate-limit (wait+retry) from a quota switch.
  const out = /** @type {any} */ (!err.status ? new Error(`${envKeyHint || 'API'} error: ${msg}`) : (() => {
    const status = Number(err.status);
    const hint = String(envKeyHint || 'api').toLowerCase();
    if (status === 401) {
      return new Error(`${envKeyHint || 'API'} 401 Unauthorized: the API key is invalid or expired. Run /connect ${hint} and paste a new key.`);
    }
    if (status === 403) {
      return new Error(`${envKeyHint || 'API'} 403 Forbidden: the API key is not authorized for ${modelId || 'this model'}. You may need to accept the model's terms on the provider site or use a key with access. Run /connect ${hint} to change the key.`);
    }
    if (status === 402) return new Error(`${envKeyHint || 'API'} quota exceeded (${err.status}). The model may not be available on your billing tier for model ${(modelId || '?')}.`);
    if (status === 404) {
      const modelHint = modelId ? ` ${modelId}` : '';
      return new Error(`${envKeyHint || 'API'} 404: model${modelHint} does not exist (or was removed) on this provider. Try /models and pick a listed model, or /model ${modelId ? 'to switch' : ''}.`);
    }
    if (err.error && err.error.message) return new Error(`${envKeyHint || 'API'} error ${status}: ${sanitizeErrBody(err.error.message)}`);
    if (err.body && err.body.message) return new Error(`${envKeyHint || 'API'} error ${status}: ${sanitizeErrBody(err.body.message)}`);
    if (!msg || msg.indexOf('no body') >= 0) {
      const modelHint = modelId ? ` (model: ${modelId})` : '';
      return new Error(`${envKeyHint || 'API'} error ${status}${modelHint}. Check model name or URL:\n${baseURL || '(default)'}`);
    }
    return new Error(`${envKeyHint || 'API'} error ${status}: ${msg}`);
  })());
  out.status = err.status ? Number(err.status) : undefined;
  // Retry-After from the openai SDK error headers (seconds or HTTP-date).
  const hdrs = err.headers;
  const ra = hdrs && (typeof hdrs.get === 'function' ? hdrs.get('retry-after') : hdrs['retry-after']);
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) out.retryAfterMs = Math.min(secs * 1000, 60000);
    else {
      const t = Date.parse(ra);
      if (Number.isFinite(t)) out.retryAfterMs = Math.min(Math.max(0, t - Date.now()), 60000);
    }
  }
  return out;
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
      if (status !== 429 && status !== 503 && status !== 502 && status !== 529) throw lastErr;
      {
        // Honor Retry-After when the provider sends one (even on the first
        // retry); otherwise the first retry is immediate (transient blip)
        // and later ones back off exponentially. Jitter avoids a thundering
        // herd of parallel retries.
        let delay = attempt > 0 ? Math.min(1000 * Math.pow(3, attempt - 1), 30000) : 0;
        const hdrs = err.headers;
        const ra = hdrs && (typeof hdrs.get === 'function' ? hdrs.get('retry-after') : hdrs['retry-after']);
        if (ra) {
          const secs = Number(ra);
          if (Number.isFinite(secs) && secs >= 0) delay = Math.min(secs * 1000, 60000);
        }
        await new Promise((resolve) => setTimeout(resolve, delay + (delay > 0 ? Math.floor(Math.random() * 250) : 0)));
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
 * @param {{ getKey: () => string|undefined, providerId: string, envKeyHint: string, clientFactory?: () => any, defaultBaseUrl?: string }} config
 * @returns {Provider}
 */
function createOpenAICompatProvider({ getKey, providerId, envKeyHint, clientFactory, defaultBaseUrl }) {
  function getClient() {
    if (clientFactory) return clientFactory();
    const key = getKey();
    if (!key) throw new Error(`${envKeyHint || 'API'} key not set. Use /connect or set the ${envKeyHint || 'API'}_API_KEY env var.`);
    const baseURL = getBaseUrl(providerId) || defaultBaseUrl || getDefaultBaseUrl(providerId);
    return new OpenAI({ apiKey: key, baseURL });
  }

  async function chat(messages, options = {}) {
    const client = getClient();
    const req = buildRequest(messages, options, providerId);
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
    const req = { ...buildRequest(messages, options, providerId), stream: true, stream_options: { include_usage: true } };
    const requestOpts = { signal: options.signal };
    try {
      const s = await retryWithBackoff(() => client.chat.completions.create(req, requestOpts), 4, envKeyHint);
      let content = '';
      let reasoning = '';
      let usage = null;
      let finishReason = null;
      const toolAcc = new Map();

      for await (const chunk of s) {
        if (chunk.usage) usage = chunk.usage;
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
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

      return { content, reasoning, toolCalls, usage, finishReason: finishReason || undefined };
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

module.exports = { createOpenAICompatProvider, wrapErr, buildRequest, formatMessages, formatTools, parseToolCalls, normalize, retryWithBackoff, sanitizeErrBody };
