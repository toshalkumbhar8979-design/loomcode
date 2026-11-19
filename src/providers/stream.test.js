// Real HTTP integration tests for the OpenAI-compatible transport. The unit
// tests inject a fake client, which cannot catch SDK semantics — most notably
// that `timeout: 0` made the OpenAI SDK abort every streaming request
// immediately ("Request timed out.") for every compatible provider.
const { test, expect } = require('bun:test');
const http = require('http');
const { createOpenAICompatProvider } = require('./openai-compat');

function sseChunk(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        baseURL: 'http://127.0.0.1:' + port + '/v1',
        close: () => new Promise((res) => {
          try { server.closeAllConnections?.(); } catch {}
          server.close(() => res());
        }),
      });
    });
  });
}

function sseHandler(mode) {
  return (req, res) => {
    if (mode === 'hang') return; // never send headers
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (mode === 'stall') {
        res.write(sseChunk({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'partial' } }] }));
        return; // keep the connection open with no more data
      }
      res.write(sseChunk({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }));
      res.write(sseChunk({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hello ' } }] }));
      res.write(sseChunk({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'world' } }] }));
      res.write(sseChunk({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  };
}

function providerFor(baseURL) {
  return createOpenAICompatProvider({
    getKey: () => 'test-key',
    providerId: 'loomtest',
    envKeyHint: 'LOOMTEST',
    defaultBaseUrl: baseURL,
  });
}

test('stream: real SSE response streams content (regression: timeout 0)', async () => {
  const srv = await startServer(sseHandler('ok'));
  try {
    const provider = providerFor(srv.baseURL);
    const deltas = [];
    const resp = await provider.stream(
      [{ role: 'user', content: 'hi' }],
      { model: 'test-model', firstChunkTimeoutMs: 5000, idleTimeoutMs: 5000 },
      (d) => deltas.push(d),
    );
    expect(deltas.join('')).toBe('hello world');
    expect(resp.content).toBe('hello world');
    expect(resp.finishReason).toBe('stop');
    expect(resp.usage.total_tokens).toBe(7);
  } finally {
    await srv.close();
  }
});

test('chat: real non-streaming response returns content and usage', async () => {
  const srv = await startServer(sseHandler('ok'));
  try {
    const provider = providerFor(srv.baseURL);
    const resp = await provider.chat([{ role: 'user', content: 'hi' }], { model: 'test-model', requestTimeoutMs: 5000 });
    expect(resp.content).toBe('hello world');
    expect(resp.usage.total_tokens).toBe(7);
  } finally {
    await srv.close();
  }
});

test('stream: header watchdog reports a stalled endpoint instead of hanging', async () => {
  const srv = await startServer(sseHandler('hang'));
  try {
    const provider = providerFor(srv.baseURL);
    let err = null;
    try {
      await provider.stream(
        [{ role: 'user', content: 'hi' }],
        { model: 'test-model', firstChunkTimeoutMs: 120, idleTimeoutMs: 120, requestTimeoutMs: 10000 },
      );
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(String(err.message)).toContain('timed out');
  } finally {
    await srv.close();
  }
});

test('stream: idle watchdog reports a mid-stream stall', async () => {
  const srv = await startServer(sseHandler('stall'));
  try {
    const provider = providerFor(srv.baseURL);
    let err = null;
    try {
      await provider.stream(
        [{ role: 'user', content: 'hi' }],
        { model: 'test-model', firstChunkTimeoutMs: 2000, idleTimeoutMs: 120, requestTimeoutMs: 10000 },
      );
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(String(err.message)).toContain('stalled');
  } finally {
    await srv.close();
  }
});
