const crypto = require('crypto');
const { ensureFreshAuth, credentialFor, isChatGPT } = require('../auth');
const { decodeJwt } = require('../auth/oauth');
const { wrapErr, withTimeout, isAbortError } = require('./openai-compat');

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const SESSION_ID = crypto.randomUUID();

function baseUrl() {
  const value = process.env.LOOM_CODEX_BASE_URL || DEFAULT_BASE_URL;
  return String(value).replace(/\/+$/, '');
}

function responsesUrl() {
  const base = baseUrl();
  return /\/responses$/.test(base) ? base : base + '/responses';
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part) return '';
      if (typeof part === 'string') return part;
      if (typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  if (content === undefined || content === null) return '';
  return String(content);
}

function formatInput(messages) {
  const input = [];
  for (const m of messages || []) {
    if (!m || m.role === 'system') continue;
    if (m.role === 'tool') {
      const callId = m.toolCallId || m.tool_call_id;
      if (!callId) continue;
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: textFromContent(m.content),
      });
      continue;
    }
    if (m.role === 'assistant') {
      const text = textFromContent(m.content);
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
      for (const call of (m.toolCalls || m.tool_calls) || []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: typeof call.input === 'string' ? call.input : JSON.stringify(call.input || {}),
        });
      }
      continue;
    }
    input.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: textFromContent(m.content) }],
    });
  }
  return input;
}

function formatTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema || { type: 'object', properties: {} },
    strict: false,
  }));
}

function buildRequest(messages, options) {
  const body = /** @type {any} */ ({
    model: options.model,
    input: formatInput(messages),
    tools: formatTools(options.tools),
    tool_choice: options.toolChoice === 'required' ? 'required' :
      options.toolChoice === 'none' ? 'none' : 'auto',
    parallel_tool_calls: options.maxParallelTools !== 1,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  });
  if (options.system) body.instructions = options.system;
  if (Number(options.maxTokens) > 0) body.max_output_tokens = Number(options.maxTokens);
  if (options.reasoning) {
    body.reasoning = { effort: 'high', summary: 'auto' };
  }
  if (!body.tools || !body.tools.length) {
    delete body.tools;
    delete body.tool_choice;
    delete body.parallel_tool_calls;
  }
  return body;
}

function accountIdFor(cred) {
  if (cred.accountId) return cred.accountId;
  const claims = decodeJwt(cred.accessToken);
  return (
    (claims && claims['https://api.openai.com/auth'] && claims['https://api.openai.com/auth'].chatgpt_account_id) ||
    (claims && claims.chatgpt_account_id) ||
    null
  );
}

async function authHeaders() {
  await ensureFreshAuth('openai');
  const cred = credentialFor('openai');
  if (!cred || cred.type !== 'oauth' || !cred.accessToken || cred.method !== 'chatgpt') {
    throw new Error('ChatGPT is not connected. Run "loom auth login openai".');
  }
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: 'Bearer ' + cred.accessToken,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    'session_id': SESSION_ID,
    'User-Agent': 'loom-code/1.7.4',
    'x-codex-exclude': 'tools',
  };
  const accountId = accountIdFor(cred);
  if (accountId) headers['chatgpt-account-id'] = accountId;
  return { headers, accountId };
}

async function post(body, options) {
  let auth = await authHeaders();
  let refreshed = false;
  const maxTries = 4;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const resp = await fetch(responsesUrl(), {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (resp.ok) return resp;
    if (resp.status === 401 && !refreshed) {
      refreshed = true;
      await ensureFreshAuth('openai', { force: true });
      auth = await authHeaders();
      attempt--;
      continue;
    }
    if (![429, 500, 502, 503, 529].includes(resp.status) || attempt === maxTries - 1) {
      const text = await resp.text().catch(() => '');
      let detail = resp.statusText || 'request failed';
      try {
        const parsed = JSON.parse(text);
        detail = parsed.error?.message || parsed.message || detail;
      } catch {
        if (text && text.length < 2000) detail = text;
      }
      const err = new Error(
        resp.status === 401 || resp.status === 403
          ? 'ChatGPT session was rejected (' + resp.status + '). Run "loom auth login openai" to sign in again.'
          : 'ChatGPT error ' + resp.status + ': ' + detail
      );
      /** @type {any} */ (err).status = resp.status;
      const ra = resp.headers.get('retry-after');
      if (ra) {
        const secs = Number(ra);
        if (Number.isFinite(secs) && secs >= 0) /** @type {any} */ (err).retryAfterMs = Math.min(secs * 1000, 60000);
      }
      throw err;
    }
    const retryAfter = Number(resp.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter >= 0
      ? Math.min(retryAfter * 1000, 60000)
      : Math.min(1000 * Math.pow(2, attempt), 30000);
    await new Promise((resolve) => setTimeout(resolve, delay + Math.floor(Math.random() * 250)));
    if (options.signal && options.signal.aborted) {
      const err = new Error('Request aborted');
      err.name = 'AbortError';
      throw err;
    }
  }
  throw new Error('ChatGPT request failed.');
}

function processEvent(evt, state, onDelta, onReasoning) {
  if (!evt || typeof evt !== 'object') return;
  const type = evt.type || '';
  if (type === 'response.output_text.delta') {
    const text = evt.delta || '';
    if (text) {
      state.content += text;
      if (onDelta) onDelta(text);
    }
    return;
  }
  if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    const text = evt.delta || '';
    if (text) {
      state.reasoning += text;
      if (onReasoning) onReasoning(text);
    }
    return;
  }
  if (type === 'response.output_item.done' && evt.item && evt.item.type === 'function_call') {
    const call = evt.item;
    const id = call.call_id || call.id;
    if (id && !state.toolIds.has(id)) {
      state.toolIds.add(id);
      let input = {};
      try { input = JSON.parse(call.arguments || '{}'); } catch {}
      state.toolCalls.push({ id, name: call.name, input });
    }
    return;
  }
  if (type === 'response.completed') {
    state.completed = true;
    const response = evt.response || {};
    state.usage = response.usage || state.usage;
    if (response.status === 'incomplete') state.incomplete = true;
    for (const item of response.output || []) {
      if (item && item.type === 'function_call') {
        const id = item.call_id || item.id;
        if (id && !state.toolIds.has(id)) {
          state.toolIds.add(id);
          let input = {};
          try { input = JSON.parse(item.arguments || '{}'); } catch {}
          state.toolCalls.push({ id, name: item.name, input });
        }
      }
    }
    return;
  }
  if (type === 'response.failed') {
    const detail = evt.response?.error?.message || evt.error?.message || 'ChatGPT response failed';
    throw new Error(detail);
  }
  if (type === 'error') {
    throw new Error(evt.error?.message || evt.message || 'ChatGPT stream error');
  }
}

async function stream(messages, options = {}, onDelta, onReasoning) {
  const body = buildRequest(messages, options);
  let resp;
  try {
    resp = await post(body, options);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw wrapErr(err, options.model || '?', 'ChatGPT', responsesUrl());
  }
  if (!resp.body) throw new Error('ChatGPT stream: empty response body');
  const decoder = new TextDecoder('utf-8');
  const firstChunkMs = Number(options.firstChunkTimeoutMs) > 0 ? Number(options.firstChunkTimeoutMs) : 180000;
  const idleMs = Number(options.idleTimeoutMs) > 0 ? Number(options.idleTimeoutMs) : 180000;
  const state = {
    content: '',
    reasoning: '',
    toolCalls: [],
    toolIds: new Set(),
    usage: null,
    completed: false,
    incomplete: false,
  };
  let buf = '';
  /** @type {any} */
  let iter;
  try { iter = resp.body[Symbol.asyncIterator] ? resp.body[Symbol.asyncIterator]() : resp.body; } catch { iter = resp.body; }
  let sawChunk = false;

  try {
    for (;;) {
      const step = await withTimeout(
        iter.next(),
        sawChunk ? idleMs : firstChunkMs,
        sawChunk ? 'the stream stalled mid-response' : 'the first token never arrived'
      );
      if (step.done) break;
      sawChunk = true;
      buf += decoder.decode(step.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }
        processEvent(evt, state, onDelta, onReasoning);
      }
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (err && err.permanent) throw err;
    throw wrapErr(err, options.model || '?', 'ChatGPT', responsesUrl());
  }

  if (!state.completed && !state.content && !state.toolCalls.length && !state.reasoning) {
    throw new Error('ChatGPT stream ended before the response completed. Try again.');
  }
  return {
    content: state.content,
    reasoning: state.reasoning,
    toolCalls: state.toolCalls,
    usage: state.usage,
    finishReason: state.toolCalls.length ? 'tool_calls' : state.incomplete ? 'length' : 'stop',
  };
}

async function chat(messages, options = {}) {
  return stream(messages, options);
}

module.exports = {
  chat,
  stream,
  buildRequest,
  formatInput,
  formatTools,
  responsesUrl,
  isChatGPT,
};
