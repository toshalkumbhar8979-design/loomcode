#!/usr/bin/env node
// ACP smoke-test client — drives `loom acp` the way an editor would and prints
// the resulting event stream. Verifies the protocol end-to-end (initialize ->
// connect -> sendChatRequest -> fetchAgentEvent -> cancel/complete).
//
//   node scripts/acp-smoke.js [prompt] [--cancel] [--mode plan|chat|build]
//
// Requires a configured provider key (same as the TUI). Exits 0 on a clean
// request.completed, non-zero on protocol error / request.error / timeout.
'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

const args = process.argv.slice(2);
const cancel = args.includes('--cancel');
const modeIdx = args.indexOf('--mode');
const mode = modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1] : 'build';
const prompt = args.filter((a) => a !== '--cancel' && a !== '--mode' && (modeIdx === -1 || a !== args[modeIdx + 1]))[0]
  || 'Say hello, then list up to five files in this repository.';

const root = path.resolve(__dirname, '..');
const child = spawn(process.execPath, [path.join('bin', 'loom.js'), 'acp'], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, LOOM_MCP_NO_WARM: '1', LOOM_MEM_AUTO: '0' },
});

const pending = new Map();
let seq = 0;
let stderrBuf = '';
let sawEvent = false;

child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const trimmed = String(line).trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    const h = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(h.t);
    h.resolve(msg);
  }
});
child.on('error', (e) => { console.error('[spawn error]', e.message); process.exit(1); });
child.on('exit', (code) => { if (pending.size && !finishing) { console.error('[server exited early] code=' + code + ' stderr=' + stderrBuf.slice(-400)); process.exit(1); } });

function send(method, params) {
  return new Promise((resolve, reject) => {
    const rid = ++seq;
    const t = setTimeout(() => { pending.delete(rid); reject(new Error('timeout waiting for ' + method)); }, 30000);
    pending.set(rid, { t, resolve });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params: params || {} }) + '\n');
  });
}

let finishing = false;
function finish(code) {
  finishing = true;
  try { child.stdin.end(); } catch {}
  setTimeout(() => { try { child.kill(); } catch {} process.exit(code); }, 100).unref();
}

function show(e) {
  sawEvent = true;
  switch (e.event) {
    case 'agent.message':
      console.log('  ' + (e.content && e.content.type === 'reasoning' ? '(reasoning) ' : '') + (e.content && e.content.content != null ? String(e.content.content) : ''));
      break;
    case 'tool.use':
      console.log('[tool.use] ' + e.toolName + ' ' + safeJSON(e.input));
      break;
    case 'tool.result': {
      const r = e.result;
      const s = typeof r === 'string' ? r : safeJSON(r);
      console.log('[tool.result] ' + e.toolName + ' ' + s.slice(0, 160) + (s.length > 160 ? '…' : ''));
      break;
    }
    case 'request.completed':
      console.log('[request.completed] ' + (e.response && e.response.text ? String(e.response.text) : ''));
      break;
    case 'request.error':
      console.log('[request.error] ' + (e.message || ''));
      break;
    case 'session.updated':
      console.log('[session.updated:' + e.type + ']');
      break;
    default:
      console.log('[' + e.event + ']');
  }
}

function safeJSON(v) {
  if (v == null) return String(v);
  if (typeof v !== 'object') return String(v);
  try { const s = JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + '…' : s; } catch { return String(v); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const init = await send('initialize');
  if (init.error) throw new Error('initialize failed: ' + JSON.stringify(init.error) + '\nstderr: ' + stderrBuf.slice(-300));
  console.log('provider ok — protocolVersion ' + init.result.protocolVersion + ', tools ' + init.result.toolSchemas.length + ', builtin ' + init.result.agentConfig.builtInTools.length);

  const conn = await send('connect', { agentConfig: { mode, instructions: 'You are connected to a smoke-test client. Keep replies brief.' } });
  if (conn.error) throw new Error('connect failed: ' + JSON.stringify(conn.error));
  const taskId = conn.result.taskId;

  const req = await send('sendChatRequest', { taskId, message: { content: prompt } });
  if (req.error) throw new Error('sendChatRequest failed: ' + JSON.stringify(req.error));
  console.log('prompt: ' + prompt);
  console.log('mode: ' + mode + (cancel ? ' (cancel demo)' : ''));

  let cursor = 0;
  let state = 'running';
  const cancelTimer = cancel ? setTimeout(() => {
    if (state === 'running') { state = 'cancelling'; console.log('[cancelling]'); send('cancelCurrentTask', { taskId }).catch(() => {}); }
  }, 3000) : null;

  const started = Date.now();
  while (state === 'running' || state === 'cancelling') {
    if (Date.now() - started > 120000) { console.error('[timeout] no terminal event within 120s'); finish(1); return; }
    const resp = await send('fetchAgentEvent', { taskId, cursor });
    if (resp.error) throw new Error('fetchAgentEvent failed: ' + JSON.stringify(resp.error));
    for (const e of resp.result.events) show(e);
    cursor = resp.result.cursor;
    const terminal = resp.result.events.find((e) => e.event === 'request.completed' || e.event === 'request.error');
    if (terminal) {
      const ok = terminal.event === 'request.completed' || (cancel && /interrupt/i.test(terminal.message || ''));
      console.log(ok ? '[PASS]' : '[FAIL] request ended with ' + terminal.event + (terminal.message ? ': ' + terminal.message : ''));
      if (cancelTimer) clearTimeout(cancelTimer);
      finish(ok ? 0 : 1);
      return;
    }
    await sleep(120);
  }
  if (cancelTimer) clearTimeout(cancelTimer);
  finish(sawEvent ? 0 : 1);
})().catch((e) => {
  console.error('[smoke error]', e.message);
  finish(1);
});
