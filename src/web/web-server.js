// loom web — browser interface for Loom. A single Node `http` server (no build
// step, no framework): serves a small single-page UI, lists saved sessions,
// and lets you chat from the browser by driving the same core Session loop the
// TUI/ACP use. Streaming is plain Server-Sent Events.
//
//   loom web                         # 127.0.0.1, random port, opens the browser
//   loom web --port 4096             # fixed port
//   loom web --hostname 0.0.0.0      # reachable on the LAN
//   loom web --mdns                  # advertise as loom.local (implies 0.0.0.0)
//   loom web --mdns-domain proj.local
//   loom web --cors https://example.com
//   LOOM_SERVER_PASSWORD=secret loom web     # password-protect (user: LOOM_SERVER_USERNAME, default "loom")
//
// Config file: { "server": { "port": 4096, "hostname": "0.0.0.0", "mdns": true,
//   "cors": ["https://example.com"] } } — CLI flags take precedence.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Session } = require('../core/session');
const { loadConfig } = require('../config/settings');
const { listSessions, loadSession, saveSession, isValidSessionId } = require('../core/session-store');

const DEFAULT_USERNAME = 'loom';
const INDEX_FILE = path.join(__dirname, 'index.html');

// ── Option resolution: CLI flags win over config.server ────────────────

function resolveOptions(argv = []) {
  const cfg = loadConfig();
  const srv = (cfg && cfg.server) || {};
  const at = (name) => argv.indexOf(name);
  const val = (name, fb) => {
    const i = at(name);
    return i !== -1 && argv[i + 1] != null && !String(argv[i + 1]).startsWith('-') ? argv[i + 1] : fb;
  };
  const has = (name) => argv.includes(name);

  let port = has('--port') ? parseInt(val('--port', '0'), 10) : (srv.port != null ? srv.port : 0);
  if (Number.isNaN(port) || port < 0) port = 0;

  const mdns = has('--mdns') ? true : (srv.mdns === true);
  const mdnsDomain = has('--mdns-domain') ? String(val('--mdns-domain', '')).replace(/\.local$/i, '') : null;
  const useMdns = mdns || mdnsDomain != null;

  let hostname = has('--hostname') ? String(val('--hostname', '')) : (srv.hostname != null ? srv.hostname : '127.0.0.1');
  if (useMdns && (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '')) hostname = '0.0.0.0';

  let cors = [];
  const corsFlag = at('--cors');
  if (corsFlag !== -1) {
    cors = String(argv[corsFlag + 1] || '').split(',').filter(Boolean);
  } else if (Array.isArray(srv.cors)) {
    cors = srv.cors.filter((x) => typeof x === 'string');
  }

  return {
    port,
    hostname,
    cors,
    mdns: useMdns,
    mdnsDomain: mdnsDomain || 'loom',
    noOpen: has('--no-open'),
    singleUser: has('--single-user') || !process.env.LOOM_SERVER_PASSWORD,
  };
}

// ── LAN address discovery (for the 0.0.0.0 / mDNS banner) ──────────────

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && net.address) out.push(net.address);
    }
  }
  return [...new Set(out)];
}

function addressesFor(opts, port) {
  const local = 'http://localhost:' + port;
  if (opts.hostname === '0.0.0.0' || opts.hostname === '::') {
    const lan = lanAddresses().map((a) => 'http://' + a + ':' + port);
    return [{ label: 'Local access', url: local }, ...lan.map((u) => ({ label: 'Network access', url: u }))];
  }
  return [{ label: 'Local access', url: 'http://' + opts.hostname + ':' + port }];
}

// ── Small helpers ───────────────────────────────────────────────────────

function readBody(req, limit = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign(securityHeaders(), {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }));
  res.end(body);
}

function sendText(res, status, text, extra) {
  const headers = Object.assign(securityHeaders(), {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  }, extra || {});
  res.writeHead(status, headers);
  res.end(text);
}

// Baseline hardening on every response: stops MIME sniffing, clickjacking
// and referrer leakage. The API is JSON-only and index.html is a single
// self-contained page (one inline script, no external assets), so this
// cannot break the UI.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};
const HTML_SECURITY_HEADERS = Object.assign({}, SECURITY_HEADERS, {
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
});
/** @returns {Record<string,string>} fresh copy so callers can extend safely */
function securityHeaders() {
  return Object.assign({}, SECURITY_HEADERS);
}

// ── The web server ──────────────────────────────────────────────────────

function createWebServer(opts) {
  const tokens = new Map(); // token -> issued-at ms (auth is server-lifetime, per-token TTL)
  const password = process.env.LOOM_SERVER_PASSWORD || '';
  const username = process.env.LOOM_SERVER_USERNAME || DEFAULT_USERNAME;
  const tokenTtlMs =
    Number((opts && opts.tokenTtlMs) || process.env.LOOM_SERVER_TOKEN_TTL_MS) || 12 * 60 * 60 * 1000;
  const hub = new Map(); // sessionId -> { session, active }
  const stats = { requests: 0, sessionsCreated: 0, messagesRun: 0 };
  const authFails = new Map(); // ip -> { count, lockedUntil }
  const AUTH_MAX_ATTEMPTS = 5;
  const AUTH_LOCKOUT_MS = 60000;

  function authAttemptAllowed(ip) {
    const rec = authFails.get(ip);
    if (!rec) return true;
    if (rec.lockedUntil > Date.now()) return false;
    authFails.delete(ip);
    return true;
  }

  function authAttemptFailed(ip) {
    const rec = authFails.get(ip) || { count: 0, lockedUntil: 0 };
    rec.count++;
    if (rec.count >= AUTH_MAX_ATTEMPTS) {
      rec.count = 0;
      rec.lockedUntil = Date.now() + AUTH_LOCKOUT_MS;
    }
    authFails.set(ip, rec);
  }

  function passwordMatches(a, b) {
    const ba = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  }

  const isAllowedOrigin = (origin) => !origin || opts.cors.length === 0 || opts.cors.includes(origin) || opts.cors.includes('*');

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (!origin || opts.cors.length === 0) return false;
    if (opts.cors.includes('*')) { res.setHeader('Access-Control-Allow-Origin', '*'); }
    else if (opts.cors.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    else { return false; }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return true;
  }

  function authOk(req) {
    if (!password) return true;
    sweepTokens();
    const cookieHeader = req.headers.cookie || '';
    const token = /(?:^|;\s*)loom_token=([^;\s]+)/.exec(cookieHeader)?.[1]
      || new URL(req.url, 'http://x').searchParams.get('token');
    return !!(token && tokenIsLive(token));
  }

  // Tokens are stamped at issue time and expire after tokenTtlMs (default 12h,
  // env LOOM_SERVER_TOKEN_TTL_MS). Sweep runs opportunistically on each auth
  // check — the map holds only this server's logins, so it stays tiny.
  function tokenIsLive(token) {
    const issuedAt = tokens.get(token);
    if (typeof issuedAt !== 'number') return false;
    return Date.now() - issuedAt <= tokenTtlMs && Date.now() >= issuedAt - 60_000;
  }
  function sweepTokens() {
    if (!tokens.size) return;
    const now = Date.now();
    for (const [tok, issuedAt] of tokens) {
      if (typeof issuedAt === 'number' && now - issuedAt > tokenTtlMs) tokens.delete(tok);
    }
  }

  function requireAuth(req, res) {
    if (authOk(req)) return true;
    sendJson(res, 401, { error: 'unauthorized', authRequired: true });
    return false;
  }

  function publicPath(url) {
    try { return decodeURIComponent(new URL(url, 'http://x').pathname); } catch { return url; }
  }

  function getWebSession(id) {
    if (hub.has(id)) return hub.get(id);
    const saved = (id && isValidSessionId(id)) ? loadSession(id) : null;
    if (!saved) return null;
    const session = new Session();
    session.conversationId = id;
    for (const m of saved.messages || []) {
      try { session.addMessage({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }); } catch {}
    }
    const entry = { session, active: false, mode: 'build' };
    hub.set(id, entry);
    return entry;
  }

  function newWebSession(mode) {
    const session = new Session();
    let id = 'web-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    session.conversationId = id;
    try { if (mode === 'plan' || mode === 'chat' || mode === 'build') session.setMode(mode); } catch {}
    const entry = { session, active: false, mode: session.mode };
    hub.set(id, entry);
    stats.sessionsCreated++;
    return entry;
  }

  async function runChat(entry, text, res) {
    const { session } = entry;
    entry.active = true;
    stats.messagesRun++;
    const write = (type, payload) => { try { res.write('data: ' + JSON.stringify({ type, ...payload }) + '\n\n'); } catch {} };
    const onClose = () => { if (!res.writableEnded) { try { session.interrupt(); } catch {} } };
    res.on('close', onClose);
    write('session.updated', { type: 'requested', id: session.conversationId });
    try {
      const resp = await session.sendUserMessage(text, {
        onDelta: (t) => write('delta', { text: t, id: session.conversationId }),
        onReasoning: (t) => write('reasoning', { text: t, id: session.conversationId }),
        onTool: (toolName, input) => write('tool.use', { name: toolName, input, id: session.conversationId }),
        onToolResult: (toolName, out, input) =>
          write('tool.result', { name: toolName, input, result: out && out.result != null ? out.result : (out && out.error), id: session.conversationId }),
      });
      if (resp.interrupted) {
        write('request.error', { message: '(interrupted)', id: session.conversationId });
      } else if (resp.type === 'error') {
        write('request.error', { message: String(resp.content || '') , id: session.conversationId });
      } else {
        write('message.completed', { id: session.conversationId });
        write('request.completed', { response: { type: 'text', text: String(resp.content || '') }, id: session.conversationId });
      }
    } catch (e) {
      write('request.error', { message: e && e.message ? e.message : String(e), id: session.conversationId });
    } finally {
      res.removeListener('close', onClose);
      entry.active = false;
      try { saveSession(session); } catch {}
      write('session.updated', { type: 'saved', id: session.conversationId });
      write('done', {});
      try { res.end(); } catch {}
    }
  }

  function handleApi(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = publicPath(url.toString());
    const seg = p.split('/').filter(Boolean); // ["api", ...]

    // /api/auth
    if (seg[0] === 'api' && seg.length === 2 && seg[1] === 'auth') {
      if (req.method === 'POST') {
        if (!password) return sendJson(res, 200, { required: false });
        return (async () => {
          const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
          if (!authAttemptAllowed(ip)) return sendJson(res, 429, { error: 'too many failed attempts; try again later' });
          const body = await readBody(req).catch(() => ({}));
          if (body.username === username && passwordMatches(body.password, password)) {
            authFails.delete(ip);
            const token = crypto.randomBytes(24).toString('hex');
            tokens.set(token, Date.now());
            res.setHeader('Set-Cookie', 'loom_token=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(tokenTtlMs / 1000));
            return sendJson(res, 200, { ok: true, username });
          }
          authAttemptFailed(ip);
          return sendJson(res, 401, { error: 'invalid credentials' });
        })();
      }
      return sendJson(res, 200, { required: !password ? false : true, username: password ? username : null });
    }

    // POST /api/auth/logout — revoke the presented session token immediately.
    if (seg[0] === 'api' && seg.length === 3 && seg[1] === 'auth' && seg[2] === 'logout') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      const cookieHeader = req.headers.cookie || '';
      const token = /(?:^|;\s*)loom_token=([^;\s]+)/.exec(cookieHeader)?.[1];
      if (token) tokens.delete(token);
      res.setHeader('Set-Cookie', 'loom_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }

    if (seg[0] === 'api' && seg[1] === 'health') return sendJson(res, 200, { ok: true });

    if (!requireAuth(req, res)) return;

    if (seg[0] !== 'api' || seg.length < 2) return sendJson(res, 404, { error: 'not found' });

    // GET /api/sessions | POST /api/sessions
    if (seg[1] === 'sessions' && seg.length === 2) {
      if (req.method === 'POST') {
        return (async () => {
          const body = await readBody(req).catch(() => ({}));
          const entry = newWebSession(body.mode);
          return sendJson(res, 200, { id: entry.session.conversationId, mode: entry.mode });
        })();
      }
      if (req.method === 'GET') {
        const rows = listSessions().map((s) => ({ ...s, active: hub.has(s.id) }));
        return sendJson(res, 200, { sessions: rows });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // GET /api/sessions/:id
    if (seg[1] === 'sessions' && seg.length === 3) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const saved = isValidSessionId(seg[2]) ? loadSession(seg[2]) : null;
      if (!saved) return sendJson(res, 404, { error: 'session not found' });
      return sendJson(res, 200, { session: saved });
    }

    // POST /api/chat  { id?, message, mode? }
    if (seg[1] === 'chat' && seg.length === 2) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      return (async () => {
        const body = await readBody(req).catch(() => ({}));
        const text = String(body.message || '').trim();
        if (!text) return sendJson(res, 400, { error: 'message is empty' });
        let entry = body.id && hub.has(body.id) ? hub.get(body.id) : null;
        if (!entry && body.id) entry = getWebSession(body.id);
        if (!entry) entry = newWebSession(body.mode);
        if (entry.active) return sendJson(res, 409, { error: 'session is busy; wait for the current request to finish' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('\n');
        await runChat(entry, text, res);
      })();
    }

    // POST /api/cancel { id }
    if (seg[1] === 'cancel' && seg.length === 2) {
      return (async () => {
        const body = await readBody(req).catch(() => ({}));
        const entry = hub.get(String(body.id || ''));
        if (entry) { try { entry.session.interrupt(); } catch {} return sendJson(res, 200, { ok: true }); }
        return sendJson(res, 404, { error: 'session not found' });
      })();
    }

    // GET /api/servers
    if (seg[1] === 'servers' && seg.length === 2) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      let servers = [];
      try {
        const mgr = require('../mcp/mcp-manager');
        servers = (mgr.listServers() || []).map((s) => ({ name: s.name, command: s.command, args: s.args || [], enabled: !!s.enabled }));
      } catch {}
      return sendJson(res, 200, { servers });
    }

    // GET /api/config
    if (seg[1] === 'config' && seg.length === 2) {
      const cfg = loadConfig();
      return sendJson(res, 200, {
        authRequired: !!password,
        username: password ? username : null,
        provider: cfg.provider || null,
        model: (cfg.model && cfg.model[cfg.provider]) || null,
        budget: cfg.budgetLevel || 'auto',
        version: require('../../package.json').version,
      });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    stats.requests++;
    applyCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const p = publicPath(req.url ? new URL(req.url, 'http://x').pathname : '/');

    if (p === '/' || p === '/index.html') {
      fs.readFile(INDEX_FILE, 'utf8', (err, html) => {
        if (err) return sendText(res, 500, 'index.html missing: ' + err.message);
        res.writeHead(200, Object.assign(HTML_SECURITY_HEADERS, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
        }));
        res.end(html);
      });
      return;
    }

    if (p.startsWith('/api/')) return handleApi(req, res);

    sendJson(res, 404, { error: 'not found' });
  });

  server.getStats = () => stats;
  server.getHub = () => hub;
  server.getTokens = () => tokens;

  return { server, opts: { ...opts, password, username } };
}

// ── mDNS advertising (bonjour-service) ─────────────────────────────────

function advertiseMdns(opts, port, onError) {
  let Bonjour;
  try { Bonjour = require('bonjour-service').Bonjour; } catch { onError && onError('bonjour-service not installed; mDNS skipped'); return null; }
  let instance;
  let svc;
  try {
    instance = new Bonjour();
    svc = instance.publish({ name: opts.mdnsDomain || 'loom', type: 'http', port, txt: { path: '/' } });
  } catch (e) {
    try { instance && instance.destroy(); } catch {}
    onError && onError('mDNS error: ' + (e && e.message));
    return null;
  }
  return { instance, svc };
}

function openBrowser(url) {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') execSync('start "" "' + url + '"', { stdio: 'ignore', windowsHide: true });
    else if (process.platform === 'darwin') execSync('open "' + url + '"', { stdio: 'ignore' });
    else execSync('xdg-open "' + url + '"', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// ── listen helper (also used by tests) ─────────────────────────────────

function listen(opts) {
  return new Promise((resolve, reject) => {
    const { server, opts: o } = createWebServer(opts);
    const onError = (err) => { server.removeListener('listening', onListen); reject(err); };
    const onListen = () => {
      server.removeListener('error', onError);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : o.port;
      resolve({ server, port, opts: o, addresses: addressesFor(o, port) });
    };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(o.port, o.hostname === '::' ? '::' : o.hostname);
  });
}

// ── CLI entry: loom web ────────────────────────────────────────────────

async function main() {
  const opts = resolveOptions(process.argv.slice(2));
  const { server, port, addresses, opts: o } = await listen(opts);

  process.title = 'loom-web';

  console.log('Loom Web — version ' + require('../../package.json').version);
  if (o.password) console.log('Authentication required — user: ' + o.username + ' (LOOM_SERVER_USERNAME)');
  const exposedToLan = o.hostname === '0.0.0.0' || o.hostname === '::';
  if (exposedToLan) {
    console.log('! NETWORK EXPOSURE WARNING !');
    if (!o.password) {
      console.log('! Binding ' + o.hostname + ' WITHOUT a password: anyone on your LAN can run an AI agent ');
      console.log('! on this machine and reach its tools/files. Set LOOM_SERVER_PASSWORD before exposing.');
    } else {
      console.log('! Bound to ' + o.hostname + ' — protected by login, but keep the port firewalled where possible.');
    }
  }
  for (const a of addresses) console.log('  ' + a.label + ':      ' + a.url);
  if (o.mdns) {
    const m = advertiseMdns(o, port, (msg) => console.error('[loom web] ' + msg));
    console.log('  mDNS:         ' + (m ? (o.mdnsDomain + '.local') : 'not advertised'));
    o.__mdns = m;
  }
  console.log('\nPress Ctrl+C to stop.');

  if (!o.noOpen) {
    const first = addresses[0] && addresses[0].url;
    setTimeout(() => { if (first && !openBrowser(first)) console.log('Open ' + first + ' in your browser.'); }, 200);
  }

  const shutdown = () => {
    try { o.__mdns && o.__mdns.instance.destroy(); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createWebServer, resolveOptions, listen, advertiseMdns, openBrowser, lanAddresses, main };
