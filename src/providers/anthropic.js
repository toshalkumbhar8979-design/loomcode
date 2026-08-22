const { getApiKey, getBaseUrl } = require('../config/settings');

function getKey() {
  return getApiKey('anthropic') || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
}

function getApiUrl() {
  const base = getBaseUrl('anthropic') || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  return base.replace(/\/$/, '') + '/v1/messages';
}

function formatContentText(text) {
  return Array.isArray(text)
    ? text
    : [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) }];
}

/**
 * @typedef {Object} AnthropicBody
 * @property {string} model
 * @property {number} max_tokens
 * @property {Array<Object>} messages
 * @property {string|Array<{type: string, text: string, cache_control?: {type: string}}>=} system
 * @property {number=} temperature
 * @property {Array<Object>=} tools
 * @property {{ type: 'enabled', budget_tokens: number }=} thinking
 * @property {boolean=} cache
 */

/**
 * @param {Array<Object>} messages
 * @param {Object} options
 * @returns {AnthropicBody}
 */
function buildBody(messages, options) {
  const systemMsgs = [];
  const out = [];
  // Prompt-caching opt-out (on by default — cache_control is ignored by
  // providers that don't support it and billed at write once, read cheap).
  const useCache = options.cache !== false;

  // System prompt comes from options.system (session.systemPrompt); also
  // accept role:'system' entries in the message history.
  if (options.system) systemMsgs.push(options.system);

  for (const m of messages) {
    if (m.role === 'system') { systemMsgs.push(m.content); continue; }
    if (m.role === 'user') {
      out.push({ role: 'user', content: formatContentText(m.content) });
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content) }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      // History may carry raw Anthropic content blocks (e.g. from a
      // restored session): keep thinking blocks (with their signature)
      // so the extended-thinking tool-use flow can resend them.
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
          else if (b.type === 'thinking') blocks.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
          else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input || {} });
        }
      } else if (m.content) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const tc of m.toolCalls || []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input || {} });
      }
      out.push({ role: 'assistant', content: blocks });
    }
  }

  /** @type {AnthropicBody} */
  const body = {
    model: options.model,
    max_tokens: options.maxTokens || 8192,
    messages: out,
    ...(systemMsgs.length && {
      system: useCache
        ? [{ type: 'text', text: systemMsgs.join('\n\n'), cache_control: { type: 'ephemeral' } }]
        : systemMsgs.join('\n\n'),
    }),
    ...(options.temperature !== undefined && { temperature: options.temperature }),
  };

  // Prompt caching (Anthropic): a cache breakpoint on the system prompt and
  // on the LAST message means each turn re-reads the stable prefix from the
  // cache instead of re-paying full input cost. Opt out with options.cache === false.
  // cache_control is NOT valid on thinking blocks — skip those when picking
  // the breakpoint block, else the API 400s and the turn dies mid-session.
  if (useCache && out.length) {
    const last = out[out.length - 1];
    if (Array.isArray(last.content) && last.content.length) {
      for (let ci = last.content.length - 1; ci >= 0; ci--) {
        const lb = last.content[ci];
        if (!lb || lb.type === 'thinking') continue;
        if (!lb.cache_control) lb.cache_control = { type: 'ephemeral' };
        break;
      }
    } else if (typeof last.content === 'string' && last.content) {
      last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
    }
  }

  // Extended thinking (Claude reasons BEFORE every reply, including after
  // each tool result — the opencode-style multi-pass thinking). Only enabled
  // when the active model supports it (options.reasoning set by the session
  // from the model's 'reasoning' tag). Anthropic requires temperature unset
  // and max_tokens comfortably above the budget.
  if (options.reasoning) {
    let maxTokens = options.maxTokens || 8192;
    // Explicit per-turn budget (/think low|medium|high) wins over the default.
    const budget = options.thinkingBudget
      ? Math.min(32768, Math.max(1024, Number(options.thinkingBudget)))
      : Math.min(8192, Math.max(1024, maxTokens - 4096));
    // budget_tokens must be strictly less than max_tokens (API requirement),
    // so lift max_tokens when a small configured limit would collide.
    if (budget >= maxTokens) maxTokens = budget + 1;
    body.max_tokens = maxTokens;
    body.thinking = { type: 'enabled', budget_tokens: budget };
    delete body.temperature;
  }

  if (options.tools && options.tools.length) {
    body.tools = options.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema || { type: 'object', properties: {} },
    }));
  }

  return body;
}

function normalizeBlocks(contentBlocks) {
  const textParts = [];
  const toolCalls = [];
  for (const block of contentBlocks) {
    if (block.type === 'text') textParts.push(block.text);
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input || {} });
    }
  }
  return { content: textParts.join(''), toolCalls };
}

async function post(body, options) {
  const key = getKey();
  if (!key) throw new Error("Anthropic API key not set. Use /connect anthropic or set ANTHROPIC_API_KEY.");
  const apiUrl = getApiUrl();
  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!resp.ok) {
    /** @type {any} */
    const err = await resp.json().catch(() => ({}));
    const detail = err.error?.message || resp.statusText;
    if (resp.status === 401) throw new Error("Anthropic 401 Unauthorized: the API key is invalid or expired. Run /connect anthropic and paste a new key.");
    if (resp.status === 403) throw new Error("Anthropic 403 Forbidden: the API key is not authorized for this model. Check the model name and your account access.");
    throw new Error(`Anthropic API error ${resp.status}: ${detail}`);
  }
  return resp;
}

async function chat(messages, options = {}) {
  const body = buildBody(messages, options);
  const resp = await post(body, options);
  /** @type {any} */
  const data = await resp.json();
  return { ...normalizeBlocks(data.content || []), usage: data.usage };
}

async function stream(messages, options = {}, onDelta, onReasoning) {
  const body = { ...buildBody(messages, options), stream: true };
  const resp = await post(body, options);
  if (!resp.body) throw new Error('Anthropic stream: empty response body');
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  const toolAcc = new Map();

  for await (const chunk of resp.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6);
      if (raw === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(raw); } catch { continue; }
      if (evt.type === 'message_delta' && evt.usage) usage = evt.usage;
      if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
        toolAcc.set(evt.index, { id: evt.content_block.id, name: evt.content_block.name, input: '' });
      } else if (evt.type === 'content_block_delta') {
        const d = evt.delta || {};
        if (d.type === 'text_delta') {
          content += d.text;
          if (onDelta) onDelta(d.text);
        } else if (d.type === 'thinking_delta') {
          reasoning += d.thinking || '';
          if (onReasoning) onReasoning(d.thinking || '');
        } else if (d.type === 'input_json_delta') {
          if (!toolAcc.has(evt.index)) toolAcc.set(evt.index, { id: '', name: '', input: '' });
          toolAcc.get(evt.index).input += d.partial_json;
        }
      }
    }
  }

  const toolCalls = [];
  for (const acc of toolAcc.values()) {
    let input = {};
    try { input = JSON.parse(acc.input || '{}'); } catch {}
    toolCalls.push({ id: acc.id, name: acc.name, input });
  }

  return { content, reasoning, toolCalls, usage };
}

const models = [
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', context: 200000, priceIn: 3, priceOut: 15, tags: ['reasoning'] },
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'anthropic', context: 200000, priceIn: 15, priceOut: 75, tags: ['reasoning'] },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'anthropic', context: 200000, priceIn: 0.8, priceOut: 4 },
];

module.exports = { chat, stream, models, buildBody, normalizeBlocks };