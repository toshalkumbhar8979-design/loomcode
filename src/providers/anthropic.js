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
      // tool_use_id is required by the API — skip orphaned tool rows from
      // resumed/hand-edited sessions rather than failing the whole turn.
      const tcid = m.toolCallId || m.tool_call_id;
      if (tcid) {
        // is_error marks a failed tool call so the model treats the string
        // content as an error report, not a successful result (parity with
        // the OpenAI-compat is_error/tool-result semantics).
        out.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: tcid,
            content: String(m.content),
            ...(m.isError ? { is_error: true } : {}),
          }],
        });
      }
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
      for (const tc of (m.toolCalls || m.tool_calls) || []) {
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

// Retry-After header (seconds) or rate-limit reset timestamps → wait ms.
function retryAfterMs(resp) {
  const ra = resp && resp.headers && resp.headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60000);
  }
  return null;
}

// Retryable: rate limits (429) and transient server errors (5xx/529).
function isRetryableStatus(status) {
  return status === 429 || status === 529 || (status >= 500 && status < 600);
}

async function post(body, options) {
  const key = getKey();
  if (!key) throw new Error("Anthropic API key not set. Use /connect anthropic or set ANTHROPIC_API_KEY.");
  const apiUrl = getApiUrl();
  const maxTries = 4;
  let resp = null;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (resp.ok) return resp;
    if (!isRetryableStatus(resp.status) || attempt === maxTries - 1) break;
    // Honor the provider's Retry-After (seconds); else exponential backoff
    // with jitter so parallel retries don't stampede.
    const waitMs = retryAfterMs(resp) ?? Math.min(1000 * Math.pow(2, attempt), 30000);
    const jitter = Math.floor(Math.random() * 250);
    await new Promise((r) => setTimeout(r, waitMs + jitter));
    if (options.signal && options.signal.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
  }
  if (!resp) throw new Error('Anthropic API error: no response');
  /** @type {any} */
  const err = await resp.json().catch(() => ({}));
  const detail = err.error?.message || resp.statusText;
  if (resp.status === 401) throw new Error("Anthropic 401 Unauthorized: the API key is invalid or expired. Run /connect anthropic and paste a new key.");
  if (resp.status === 403) throw new Error("Anthropic 403 Forbidden: the API key is not authorized for this model. Check the model name and your account access.");
  const e = new Error(`Anthropic API error ${resp.status}: ${detail}`);
  /** @type {any} */ (e).status = resp.status;
  /** @type {any} */ (e).retryAfterMs = retryAfterMs(resp);
  throw e;
}

// Anthropic stop_reason → the finishReason vocabulary the session loop knows
// ('length' drives truncation auto-continue; 'tool_use'/'end_turn' are no-ops).
function mapStopReason(stopReason) {
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'tool_use') return 'tool_calls';
  return stopReason || undefined;
}

async function chat(messages, options = {}) {
  const body = buildBody(messages, options);
  const resp = await post(body, options);
  /** @type {any} */
  const data = await resp.json();
  return {
    ...normalizeBlocks(data.content || []),
    usage: data.usage,
    finishReason: mapStopReason(data.stop_reason),
  };
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
  let finishReason;
  let sawEnd = false;
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
      // Mid-stream error events (content filter, overloaded after start)
      // previously vanished — the turn dead-ended with empty content. Throw
      // so the session retry/error path handles it.
      if (evt.type === 'error') {
        const emsg = evt.error?.message || 'unknown stream error';
        const e = new Error(`Anthropic stream error: ${emsg}`);
        /** @type {any} */ (e).status = evt.error?.type === 'overloaded_error' ? 529 : undefined;
        throw e;
      }
      if (evt.type === 'message_start' && evt.message?.usage) {
        // message_start carries input_tokens (prompt) — without it, a turn
        // that ends in message_delta only undercounts input to zero.
        usage = { ...evt.message.usage };
      }
      if (evt.type === 'message_delta') {
        if (evt.usage) usage = { ...(usage || {}), ...evt.usage };
        if (evt.delta && evt.delta.stop_reason) finishReason = mapStopReason(evt.delta.stop_reason);
        sawEnd = true;
      }
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

  // A stream that never delivered message_delta AND produced nothing was
  // truncated (network reset mid-body). Surface it as an error instead of a
  // silent empty reply. Partial content with no trailing message_delta is
  // kept (the session can continue from it).
  if (!sawEnd && !usage && !content && !toolAcc.size) {
    throw new Error('Anthropic stream truncated: connection ended before message_delta');
  }

  const toolCalls = [];
  for (const acc of toolAcc.values()) {
    let input = {};
    try { input = JSON.parse(acc.input || '{}'); } catch {}
    toolCalls.push({ id: acc.id, name: acc.name, input });
  }

  return { content, reasoning, toolCalls, usage, finishReason };
}

// Current Anthropic lineup, verified against the models.dev registry
// (2026-10-17). Dated snapshots kept for back-compat with saved configs.
const models = [
  // ── Opus ──
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic', context: 1000000, priceIn: 4, priceOut: 20, tags: ['frontier', 'reasoning'] },
  { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'anthropic', context: 1000000, priceIn: 5, priceOut: 25, tags: ['frontier', 'reasoning'] },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', provider: 'anthropic', context: 1000000, priceIn: 5, priceOut: 25, tags: ['frontier', 'reasoning'] },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', provider: 'anthropic', context: 200000, priceIn: 5, priceOut: 25, tags: ['frontier', 'reasoning'] },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', provider: 'anthropic', context: 1000000, priceIn: 10, priceOut: 50, tags: ['frontier', 'reasoning'] },
  { id: 'claude-fable-5', name: 'Claude Fable 5', provider: 'anthropic', context: 1000000, priceIn: 10, priceOut: 50, tags: ['frontier', 'reasoning'] },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'anthropic', context: 1000000, priceIn: 5, priceOut: 25, tags: ['frontier', 'reasoning'] },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', context: 1000000, priceIn: 5, priceOut: 25, tags: ['frontier', 'reasoning'] },
  // ── Sonnet ──
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', provider: 'anthropic', context: 1000000, priceIn: 2, priceOut: 10, tags: ['reasoning'] },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic', context: 1000000, priceIn: 2, priceOut: 10, tags: ['reasoning'] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', context: 1000000, priceIn: 3, priceOut: 15, tags: ['reasoning'] },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic', context: 200000, priceIn: 3, priceOut: 15, tags: ['reasoning'] },
  // ── Haiku ──
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', provider: 'anthropic', context: 1000000, priceIn: 0.1, priceOut: 0.5, tags: ['fast', 'cheap', 'reasoning'] },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic', context: 200000, priceIn: 1, priceOut: 5, tags: ['fast', 'reasoning'] },
  // ── Legacy snapshots ──
  // Retired models verified against Anthropic's model-deprecations page
  // (2026-10-17): claude-sonnet-4-20250514 and claude-opus-4-20250514 were
  // retired 2026-06-15, claude-3-5-haiku-20241022 retired 2026-02-19 — they
  // 404 and are no longer listed. claude-mythos-5/5.1 exist but are limited
  // to verified organizations, so they are not offered in the picker.
];

module.exports = { chat, stream, models, buildBody, normalizeBlocks };