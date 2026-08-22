// LSP — tiny Language Server Protocol client that surfaces diagnostics to the
// agent (OpenCode-style). Disabled by default; enable via config.json `lsp`:
//
//   lsp: true   → all built-in servers enabled
//   lsp: { ... } → built-ins + overrides / custom servers
//   lsp: { typescript: { command: ["npx","typescript-language-server","--stdio"], extensions: [".ts"] } } → override
//   lsp: { myls: { command: ["my-ls","--stdio"], extensions: [".zzz"] } } → custom
//   lsp: { typescript: { disabled: true } } → disable one
//
// JSON-RPC runs over the server's stdio using Content-Length framing (the LSP
// wire format). Diagnostics pushed as textDocument/publishDiagnostics are
// captured per document.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig } = require('../config/settings');

/** @typedef {Object} LspServerDef
 *  @property {Array<string>} command
 *  @property {Array<string>} extensions
 */

/** @typedef {Object} LspDiagnostic
 *  @property {string} message
 *  @property {string} source
 *  @property {string} severity   error | warning | info | hint
 *  @property {number} severityCode
 *  @property {number} line
 *  @property {number} character
 *  @property {number} endLine
 *  @property {number} endCharacter
 *  @property {string} [code]
 */

/** @type {Record<string, LspServerDef>} */
const DEFAULT_LSP = {
  typescript: {
    command: ['npx', 'typescript-language-server', '--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  },
  eslint: {
    command: ['npx', 'vscode-langservers-extracted', '--stdio'],
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue'],
  },
  pyright: {
    command: ['npx', 'pyright-langserver', '--stdio'],
    extensions: ['.py', '.pyi'],
  },
  bash: { command: ['bash-language-server', 'start'], extensions: ['.sh', '.bash', '.zsh', '.ksh'] },
  gopls: { command: ['gopls', 'serve'], extensions: ['.go'] },
  rust: { command: ['rust-analyzer'], extensions: ['.rs'] },
  dart: { command: ['dart', 'language-server'], extensions: ['.dart'] },
  yaml: { command: ['yaml-language-server', '--stdio'], extensions: ['.yaml', '.yml'] },
  terraform: { command: ['terraform-ls', 'serve'], extensions: ['.tf', '.tfvars'] },
  clangd: { command: ['clangd', '--background-index'], extensions: ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.ino'] },
  zig: { command: ['zls'], extensions: ['.zig', '.zon'] },
  lua: { command: ['lua-language-server'], extensions: ['.lua'] },
};

/** Resolve the enabled LSP servers from config + built-ins.
 * @returns {{enabled: boolean, servers: Record<string, LspServerDef>}} */
function enabledServers() {
  const cfg = loadConfig();
  const l = cfg.lsp;
  if (l === false || l === undefined || l === null) return { enabled: false, servers: /** @type {Record<string, LspServerDef>} */ ({}) };
  if (l === true) return { enabled: true, servers: { ...DEFAULT_LSP } };
  if (l && typeof l === 'object') {
    const out = /** @type {Record<string, LspServerDef>} */ ({});
    for (const [id, def] of Object.entries(DEFAULT_LSP)) {
      const u = l[id];
      const merged = { command: def.command, extensions: def.extensions, ...(u && typeof u === 'object' ? u : {}) };
      if (merged.disabled) continue;
      out[id] = /** @type {LspServerDef} */ ({ command: merged.command, extensions: merged.extensions });
    }
    for (const [id, u] of Object.entries(l)) {
      if (!u || typeof u !== 'object') continue;
      if (u.command && Array.isArray(u.extensions)) {
        if (!u.disabled) out[id] = /** @type {LspServerDef} */ ({ command: u.command, extensions: u.extensions });
      }
    }
    return { enabled: true, servers: out };
  }
  return { enabled: false, servers: /** @type {Record<string, LspServerDef>} */ ({}) };
}

/** Pick the server that handles an extension (deterministic id order).
 * @param {string} ext
 * @returns {{found: boolean, id?: string, def?: LspServerDef, reason?: string}} */
function findServerForExt(ext) {
  const { enabled, servers } = enabledServers();
  if (!enabled) return { found: false, reason: 'LSP is disabled (set config lsp: true to enable)' };
  const extLower = ext.toLowerCase();
  const ids = Object.keys(servers).sort();
  for (const id of ids) {
    if (servers[id].extensions.some((e) => e.toLowerCase() === extLower)) {
      return { found: true, id, def: servers[id] };
    }
  }
  return { found: false, reason: `no enabled LSP server handles extension "${ext}"` };
}

let nextId = 1;
const connections = new Map();

/** Incremental parser for Content-Length framed JSON-RPC messages. */
class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }
  /** Append a chunk and return any fully framed messages.
   * @param {Buffer|string} chunk
   * @returns {Array<object>} */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')]);
    const out = [];
    let idx;
    while ((idx = this.buffer.indexOf('\r\n\r\n')) !== -1) {
      const header = this.buffer.slice(0, idx).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      const headLen = idx + 4;
      if (!m) {
        this.buffer = this.buffer.slice(headLen);
        continue;
      }
      const len = Number(m[1]);
      if (this.buffer.length < headLen + len) break;
      const body = this.buffer.slice(headLen, headLen + len);
      this.buffer = this.buffer.slice(headLen + len);
      try {
        out.push(JSON.parse(body.toString('utf8')));
      } catch {}
    }
    return out;
  }
}

/** A single LSP server process with pending-request routing. */
class LspConnection {
  /**
   * @param {string} id
   * @param {LspServerDef} def
   */
  constructor(id, def) {
    this.id = id;
    this.def = def;
    this.child = null;
    this.decoder = new FrameDecoder();
    this.pending = new Map();
    this.diagnostics = new Map(); // uri -> array of diagnostics
    this.ready = null;
    this.openedFiles = new Set();
  }

  start() {
    if (this.child) return this.ready || Promise.resolve();
    const def = this.def;
    const isWin = process.platform === 'win32';
    // npx on Windows must go through cmd so the shim resolves.
    const cmd = def.command[0];
    const rest = def.command.slice(1);
    this.child = isWin && cmd === 'npx'
      ? spawn('cmd', ['/c', 'npx', ...rest], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(cmd, rest, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.on('data', (d) => {
      for (const msg of this.decoder.push(d)) this.handleMessage(msg);
    });
    const initTimer = setTimeout(() => {
      if (this._readyReject) this._readyReject(new Error(`LSP server ${this.id} initialize timed out`));
    }, 30000);
    this.ready = new Promise((resolve, reject) => {
      this._readyResolve = (v) => { clearTimeout(initTimer); resolve(v); };
      this._readyReject = (e) => { clearTimeout(initTimer); reject(e); };
    });
    this.child.on('error', (err) => {
      if (this._readyReject) this._readyReject(err && err.message ? err : new Error(`LSP server ${this.id} failed to start`));
      this.stop();
    });
    this.child.on('exit', () => {
      this.child = null;
      if (this._readyReject) this._readyReject(new Error(`LSP server ${this.id} exited`));
      for (const p of this.pending.values()) p.reject(new Error(`LSP server ${this.id} exited`));
      this.pending.clear();
    });
    // initialize handshake
    this.sendRequest('initialize', {
      processId: process.pid,
      rootUri: pathToUri(process.cwd()),
      capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } }, workspace: {} },
    }).then(() => {
      this.sendNotification('initialized', {});
      if (this._readyResolve) this._readyResolve(null);
    }).catch((e) => {
      if (this._readyReject) this._readyReject(e);
    });
    return this.ready;
  }

  /** Route a parsed frame to a response or a notification handler.
   * @param {object} msg */
  handleMessage(msg) {
    if (msg.id != null) {
      const p = this.pending.get(String(msg.id));
      if (p) {
        this.pending.delete(String(msg.id));
        if (msg.error) p.reject(new Error(msg.error.message || 'LSP error'));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      const uri = msg.params && msg.params.uri;
      if (uri) this.diagnostics.set(uri, msg.params.diagnostics || []);
    }
  }

  /** @param {string} method
   *  @param {object} params
   *  @returns {Promise<any>} */
  sendRequest(method, params) {
    if (!this.child) return Promise.reject(new Error('LSP server not started'));
    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id: Number(id), method, params: params || {} });
    });
  }

  /** @param {string} method
   *  @param {object} params */
  sendNotification(method, params) {
    if (!this.child) return;
    this.write({ jsonrpc: '2.0', method, params: params || {} });
  }

  /** @param {object} obj */
  write(obj) {
    if (!this.child) return;
    const body = JSON.stringify(obj);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  /** @param {string} filePath */
  async didOpen(filePath) {
    if (this.openedFiles.has(filePath)) return;
    const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const languageId = {
      '.ts': 'typescript', '.tsx': 'typescriptreact',
      '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
      '.py': 'python',
    }[path.extname(filePath).toLowerCase()] || 'plaintext';
    this.sendNotification('textDocument/didOpen', {
      textDocument: { uri: pathToUri(filePath), languageId, version: 1, text },
    });
    this.openedFiles.add(filePath);
  }

  /** @param {string} uri
   * @returns {Array<LspDiagnostic>} */
  getDiagnosticsForUri(uri) {
    return normalizeDiagnostics(this.diagnostics.get(uri) || []);
  }

  stop() {
    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill();
      } catch {}
      this.child = null;
    }
    this.ready = null;
  }
}

/** @param {string} p
 * @returns {string} */
function pathToUri(p) {
  const abs = path.resolve(p).replace(/\\/g, '/');
  return 'file://' + (abs.startsWith('/') ? '' : '/') + abs;
}

/** Map LSP severity ints to readable labels.
 * @param {Array<object>} diags
 * @returns {Array<LspDiagnostic>} */
function normalizeDiagnostics(diags) {
  return (diags || []).map((d) => {
    const sev = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }[d.severity] || 'info';
    const r = d.range || { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    return {
      message: String(d.message || '').replace(/\s+/g, ' ').trim(),
      source: String(d.source || ''),
      severity: sev,
      severityCode: d.severity || 0,
      line: (r.start && r.start.line) || 0,
      character: (r.start && r.start.character) || 0,
      endLine: (r.end && r.end.line) || 0,
      endCharacter: (r.end && r.end.character) || 0,
      code: d.code != null ? String(d.code) : undefined,
    };
  });
}

const STALE = new Map(); // filePath -> last diagnostics
const OPEN_TIMER = new Map();

/** Run diagnostics for a file: start the server if needed, open the doc,
 *  wait for publishDiagnostics, cache it, and return it.
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok: boolean, diagnostics: Array<LspDiagnostic>, id?: string, error?: string}>} */
async function checkFile(filePath, opts = {}) {
  const timeoutMs = opts.timeoutMs || 4000;
  const ext = path.extname(filePath);
  const found = findServerForExt(ext);
  if (!found.found) return { ok: false, diagnostics: [], error: found.reason };
  if (found.id == null || found.def == null) return { ok: false, diagnostics: [], error: 'server not resolved' };
  const id = found.id;
  const def = found.def;
  if (!connections.has(id)) connections.set(id, new LspConnection(id, def));
  const conn = connections.get(id);
  try {
    await conn.start();
  } catch (e) {
    connections.delete(id);
    return { ok: false, diagnostics: [], error: `failed to start ${id}: ${e && e.message ? e.message : e}` };
  }
  await conn.didOpen(filePath);
  const uri = pathToUri(filePath);
  // Give the server a window to push diagnostics (may already be cached).
  if (!conn.diagnostics.has(uri)) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      OPEN_TIMER.set(uri, t);
    });
    OPEN_TIMER.delete(uri);
  }
  const diags = conn.getDiagnosticsForUri(uri);
  STALE.set(filePath, diags);
  return { ok: true, diagnostics: diags, id };
}

/** @param {string} filePath
 * @returns {Array<LspDiagnostic>} */
function cachedDiagnostics(filePath) {
  return STALE.get(filePath) || [];
}

/** @returns {Array<string>} */
function statusLines() {
  const { enabled, servers } = enabledServers();
  const lines = [`LSP: ${enabled ? 'ENABLED' : 'DISABLED'} (set config.json "lsp": true to enable)`];
  if (enabled) {
    for (const [id, def] of Object.entries(servers)) {
      lines.push(`  ${id.padEnd(14)} ${(def.command[0] + ' ...') || ''}  [${def.extensions.join(' ')}]`);
    }
  }
  return lines;
}

function shutdownAll() {
  for (const conn of connections.values()) {
    try {
      conn.sendNotification('shutdown');
      conn.sendNotification('exit');
    } catch {}
    conn.stop();
  }
  connections.clear();
}

process.once('exit', shutdownAll);

module.exports = {
  DEFAULT_LSP,
  enabledServers,
  findServerForExt,
  checkFile,
  cachedDiagnostics,
  statusLines,
  shutdownAll,
  LspConnection,
  FrameDecoder,
  pathToUri,
};
