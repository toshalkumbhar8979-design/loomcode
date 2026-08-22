// loom attach <url> — terminal client for a running `loom web` server. Shares
// the same sessions and state: pick an existing session (or create a new one),
// then chat from the terminal. Streaming is plain Server-Sent Events parsed
// from a fetch ReadableStream.
//
//   loom attach http://localhost:4096
//   loom attach http://loom.local:80
//   LOOM_SERVER_PASSWORD=... loom attach http://localhost:4096
//   loom attach http://localhost:4096 --username me --password secret
//
// This is a line-mode attach (not the full OpenTUI): the SolidJS TUI runs in-
// process and isn't rewired to a remote server yet, so terminal attach is the
// honest v1 that actually shares state with the browser.
'use strict';

const readline = require('readline');

const COLOR = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  blue: '\x1b[34m', gray: '\x1b[90m', cyan: '\x1b[36m',
  yellow: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m',
};

function parseArgs(argv) {
  const out = { url: null, username: process.env.LOOM_SERVER_USERNAME || null, password: process.env.LOOM_SERVER_PASSWORD || null, sessionId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--username' || a === '-u') out.username = argv[++i];
    else if (a === '--password' || a === '-p') out.password = argv[++i];
    else if (a === '--session' || a === '-s') out.sessionId = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-') && !out.url) out.url = a;
  }
  return out;
}

async function jsonFetch(client, path, options) {
  const opts = options ? { ...options, headers: { ...(options.headers || {}), ...(client.cookie ? { Cookie: client.cookie } : {}) } }
    : (client.cookie ? { headers: { Cookie: client.cookie } } : undefined);
  const res = await fetch(new URL(path, client.base), opts);
  if (res.status === 401) {
    const err = new Error('unauthorized');
    err.unauthorized = true;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body && body.error ? body.error : res.statusText);
  return body;
}

async function ensureAuth(client) {
  // Try fetching /api/auth: if required and we have credentials, POST /api/auth/login.
  let info;
  try { info = await jsonFetch(client, '/api/auth'); } catch (e) { if (e.unauthorized) throw e; info = { required: false }; }
  if (!info.required) { client.cookie = null; return; }
  if (!client.username || !client.password) {
    console.error('Server is password-protected. Pass --username and --password, or set LOOM_SERVER_USERNAME / LOOM_SERVER_PASSWORD.');
    process.exit(2);
  }
  const res = await fetch(new URL('/api/auth', client.base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: client.username, password: client.password }),
  });
  if (!res.ok) {
    console.error('Login failed (' + res.status + ').');
    process.exit(2);
  }
  const sc = res.headers.get('set-cookie') || '';
  const token = /(?:^|;\s*)loom_token=([^;\s]+)/.exec(sc)?.[1];
  client.cookie = token ? 'loom_token=' + token : null;
}

function makeClient(args) {
  if (!args.url) { console.error('Usage: loom attach <url> [--username U --password P] [--session ID]'); process.exit(2); }
  let u;
  try { u = new URL(args.url); } catch { console.error('Invalid URL: ' + args.url); process.exit(2); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { console.error('Only http/https URLs are supported.'); process.exit(2); }
  return { base: u, cookie: null, username: args.username, password: args.password };
}

async function chooseSession(client) {
  const { sessions } = await jsonFetch(client, '/api/sessions');
  if (!sessions.length) {
    console.log(COLOR.gray + '(no saved sessions — a new chat will be created)' + COLOR.reset);
    return { id: null };
  }
  console.log(COLOR.bold + 'Sessions' + COLOR.reset);
  sessions.forEach((s, i) => {
    const when = s.createdAt ? new Date(s.createdAt).toLocaleString() : 'unknown';
    const meta = [when, (s.messageCount || 0) + ' msgs', s.provider ? s.provider : '', s.model ? s.model : ''].filter(Boolean).join(' · ');
    console.log('  ' + COLOR.cyan + (i + 1) + COLOR.reset + ') ' + s.id + '  ' + COLOR.gray + meta + COLOR.reset + (s.active ? ' ' + COLOR.green + '(active)' + COLOR.reset : ''));
  });
  console.log('  ' + COLOR.cyan + '0' + COLOR.reset + ') New chat');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((resolve) => rl.question(COLOR.bold + 'Choose [0-' + sessions.length + ']: ' + COLOR.reset, (v) => { rl.close(); resolve(v.trim()); }));
  const n = parseInt(ans, 10);
  if (!isNaN(n) && n >= 1 && n <= sessions.length) {
    const chosen = sessions[n - 1];
    return { id: chosen.id, transcript: chosen };
  }
  return { id: null };
}

async function loadTranscript(client, id) {
  try {
    const { session } = await jsonFetch(client, '/api/sessions/' + id);
    if (session && session.messages && session.messages.length) {
      console.log(COLOR.gray + '\nTranscript (' + session.messages.length + ' messages):' + COLOR.reset);
      for (const m of session.messages) {
        const who = m.role === 'user' ? COLOR.blue + 'you' : COLOR.green + 'loom';
        const content = String(m.content || '');
        console.log('  ' + who + COLOR.reset + ': ' + content.split('\n').join('\n      '));
      }
      console.log('');
    }
  } catch (e) {
    if (!e.unauthorized) console.error(COLOR.gray + '(could not load transcript: ' + e.message + ')' + COLOR.reset);
  }
}

async function createSession(client) {
  const { id } = await jsonFetch(client, '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'build' }) });
  return id;
}

async function streamChat(client, id, text, rlState) {
  const headers = { 'Content-Type': 'application/json' };
  if (client.cookie) headers.Cookie = client.cookie;
  let res;
  try {
    res = await fetch(new URL('/api/chat', client.base), {
      method: 'POST', headers,
      body: JSON.stringify({ id, message: text }),
    });
  } catch (e) {
    console.error(COLOR.red + 'Network error: ' + e.message + COLOR.reset);
    return { error: e.message };
  }
  if (res.status === 401) { ensureAuth(client).catch(() => {}); return { unauthorized: true }; }
  if (!res.ok) { const body = await res.text().catch(() => ''); console.error(COLOR.red + 'Server ' + res.status + ': ' + body + COLOR.reset); return { error: body }; }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text_started = false;
  process.stdout.write(COLOR.green + 'loom' + COLOR.reset + ': ');
  const flushTextStart = () => { if (!text_started) { text_started = true; } };
  const newline = () => { if (text_started) process.stdout.write('\n'); };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      switch (ev.type) {
        case 'delta': flushTextStart(); process.stdout.write(ev.text || ''); break;
        case 'reasoning': flushTextStart(); process.stdout.write(COLOR.gray + (ev.text || '') + COLOR.reset); break;
        case 'tool.use':
          newline();
          console.log(COLOR.dim + '  ↳ tool: ' + COLOR.yellow + ev.name + COLOR.reset + COLOR.dim + ' ' + (() => { try { return JSON.stringify(ev.input); } catch { return ''; } })().slice(0, 200) + COLOR.reset);
          break;
        case 'tool.result':
          newline();
          console.log(COLOR.dim + '  ↳ result: ' + String(ev.result != null ? (typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result)) : '').slice(0, 240) + COLOR.reset);
          break;
        case 'request.error': newline(); console.error(COLOR.red + 'error: ' + (ev.message || '') + COLOR.reset); return { error: ev.message };
        case 'request.completed': newline(); break;
        case 'done': newline(); return { ok: true };
      }
    }
  }
  newline();
  return { ok: true };
}

async function cancelCurrent(client, id) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (client.cookie) headers.Cookie = client.cookie;
    await fetch(new URL('/api/cancel', client.base), { method: 'POST', headers, body: JSON.stringify({ id }) });
  } catch {}
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: loom attach <url> [options]');
    console.log('  --username, -u   Username for password-protected server');
    console.log('  --password, -p   Password (or set LOOM_SERVER_PASSWORD)');
    console.log('  --session, -s    Resume a specific session id without prompting');
    process.exit(0);
  }
  const client = makeClient(args);
  await ensureAuth(client);

  // Try to verify the server is reachable.
  try {
    const { ok } = await jsonFetch(client, '/api/health');
    if (!ok) throw new Error('health failed');
  } catch (e) {
    if (e.unauthorized) { /* auth handled above; ok */ }
    else { console.error(COLOR.red + 'Cannot reach ' + client.base + ' (' + e.message + ').' + COLOR.reset); process.exit(2); }
  }

  let sessionId = args.sessionId || null;
  if (!sessionId) {
    const pick = await chooseSession(client);
    sessionId = pick.id;
    if (!sessionId) sessionId = await createSession(client);
  }
  console.log(COLOR.gray + 'Attached to ' + client.base + ' — session ' + sessionId + COLOR.reset);
  if (!args.sessionId) await loadTranscript(client, sessionId);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let busy = false;
  let stopping = false;
  rl.on('SIGINT', () => {
    if (busy) { stopping = true; cancelCurrent(client, sessionId).catch(() => {}); console.log(COLOR.gray + '\n(stopping)' + COLOR.reset); }
    else { console.log(COLOR.gray + '\nbye.' + COLOR.reset); rl.close(); process.exit(0); }
  });
  const ask = () => new Promise((resolve) => rl.question(COLOR.bold + '> ' + COLOR.reset, (v) => resolve(v.trim())));
  for (;;) {
    let text;
    try { text = await ask(); } catch { break; }
    if (!text) continue;
    if (text === '/exit' || text === ':q') { console.log(COLOR.gray + 'bye.' + COLOR.reset); break; }
    busy = true; stopping = false;
    console.log(COLOR.blue + 'you' + COLOR.reset + ': ' + text);
    await streamChat(client, sessionId, text, {});
    busy = false;
  }
  rl.close();
  process.exit(0);
}

module.exports = { main };
