const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSION_SCHEMA_VERSION = 4;

const LOOM_DIR = path.join(os.homedir(), '.loom');

/**
 * @typedef {Object} ListSessionsOptions
 * @property {boolean} [allProjects] Include sessions from other directories.
 * @property {boolean} [includeEmpty] Include sessions with no messages.
 * @property {string} [directory] Project directory to scope the list to.
 */

/**
 * @typedef {Object} SessionSummary
 * @property {string} id
 * @property {string} [title]
 * @property {string|null} createdAt
 * @property {string|null} updatedAt
 * @property {string|null} mtime
 * @property {number} messageCount
 * @property {string|null} provider
 * @property {string|null} model
 * @property {string|null} directory
 * @property {string} source
 */

// Re-evaluated on every call so tests can isolate with LOOM_CONFIG_DIR.
//
// New sessions live in the global store:
//
//   ~/.loom/sessions/<id>/session.json    metadata (includes project directory)
//   ~/.loom/sessions/<id>/messages.jsonl  one message per line
//
// The old per-project files (<project>/.loom/sessions/<id>/...) and flat
// legacy files (<store>/<id>.json, schema v1/v2) stay readable. A resumed
// session is rewritten into the global store, so its id keeps working even
// when `loom -s <id>` is run from another directory.
function dataDir() {
  return process.env.LOOM_CONFIG_DIR || LOOM_DIR;
}

function baseDir() {
  return path.join(dataDir(), 'sessions');
}

function ensureDir() {
  const d = baseDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function convId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

// Session IDs become folder names - keep them strictly alphanumeric to rule
// out path traversal via loadSession/deleteSession (e.g. "../../secrets").
const ID_RX = /^[a-zA-Z0-9_-]{3,128}$/;
function isValidSessionId(id) {
  return typeof id === 'string' && ID_RX.test(id);
}

function resolveDir(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

// OpenCode-style project scope: use the git worktree root when available,
// otherwise the launch directory. Sessions saved from a subdirectory still
// belong to the same project.
function projectRoot() {
  const start = resolveDir(process.cwd());
  let cur = start;
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return start;
    cur = parent;
  }
}

function projectLocalDir() {
  if (process.env.LOOM_CONFIG_DIR) return null;
  return path.join(projectRoot(), '.loom', 'sessions');
}

function sameDir(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(String(a));
  const right = path.resolve(String(b));
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

// Coerce whatever came off disk (hand-edited, corrupt, older schema) into the
// guaranteed current shape: { id, createdAt, schemaVersion, messages } with
// every message having { role, content } while preserving metadata and extras.
// Snake-case tool fields from old saves are aliased to camelCase so a resumed
// session can always rebuild a valid provider payload (toolCallId is sent as
// tool_call_id / tool_use_id - losing it 400s on strict providers).
function normalizeSession(data) {
  if (!data || typeof data !== 'object') return null;
  const raw = Array.isArray(data.messages) ? data.messages : [];
  const messages = raw.map((m) => {
    if (!m || typeof m !== 'object') return { role: 'user', content: '' };
    const { role, content, ...rest } = m;
    const out = { role: role || 'user', content: typeof content === 'undefined' ? '' : content, ...rest };
    if (!out.toolCalls && Array.isArray(rest.tool_calls)) out.toolCalls = rest.tool_calls;
    if (!out.toolCallId && rest.tool_call_id) out.toolCallId = rest.tool_call_id;
    return out;
  });
  return {
    ...data,
    id: typeof data.id === 'string' ? data.id : null,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
    schemaVersion: typeof data.schemaVersion === 'number' ? data.schemaVersion : 1,
    messages,
  };
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === 'string') parts.push(p);
      else if (p && typeof p === 'object') {
        if (typeof p.text === 'string') parts.push(p.text);
        else if (typeof p.content === 'string') parts.push(p.content);
      }
    }
    return parts.join(' ');
  }
  return '';
}

// A compact, terminal-safe session title taken from the first user message.
function sessionTitle(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let first = null;
  for (const m of list) {
    if (m && m.role === 'user' && messageText(m.content).trim()) { first = m; break; }
  }
  if (!first) {
    for (const m of list) {
      if (m && typeof m === 'object' && messageText(m.content).trim()) { first = m; break; }
    }
  }
  if (!first) return 'Untitled session';
  const text = messageText(first.content)
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/[#>*_`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'Untitled session';
  return text.length > 72 ? text.slice(0, 71).trimEnd() + '…' : text;
}

function hasConversation(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.some((m) => m && (m.role === 'user' || m.role === 'assistant'));
}

function countMessageLines(file) {
  try {
    const body = fs.readFileSync(file, 'utf8');
    if (!body) return 0;
    let n = 0;
    for (const line of body.split('\n')) if (line.trim()) n++;
    return n;
  } catch {
    return 0;
  }
}

function readFolderMeta(id, root) {
  const dir = path.join(root, id);
  const metaFile = path.join(dir, 'session.json');
  if (!fs.existsSync(metaFile)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const norm = normalizeSession({ ...raw, messages: [] });
    if (!norm) return null;
    norm.id = norm.id || id;
    norm.messages = [];
    norm.file = metaFile;
    norm.dir = dir;
    const msgFile = path.join(dir, 'messages.jsonl');
    if (typeof norm.messageCount !== 'number') {
      norm.messageCount = countMessageLines(msgFile);
    }
    if (typeof norm.title !== 'string' || !norm.title) {
      norm.title = titleFromFile(msgFile);
    }
    return norm;
  } catch {
    return null;
  }
}

function titleFromFile(file) {
  try {
    const body = fs.readFileSync(file, 'utf8');
    if (!body) return null;
    const msgs = [];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const m = JSON.parse(t);
        msgs.push(m);
        if (m && m.role === 'user' && messageText(m.content).trim()) break;
      } catch {}
    }
    const title = sessionTitle(msgs);
    return title === 'Untitled session' ? null : title;
  } catch {
    return null;
  }
}

function readFolderSession(id, root) {
  const dir = path.join(root, id);
  const metaFile = path.join(dir, 'session.json');
  if (!fs.existsSync(metaFile)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const messages = [];
    const msgFile = path.join(dir, 'messages.jsonl');
    if (fs.existsSync(msgFile)) {
      const lines = fs.readFileSync(msgFile, 'utf8').split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try { messages.push(JSON.parse(t)); } catch {}
      }
    }
    const norm = normalizeSession({ ...meta, messages });
    if (!norm) return null;
    norm.id = norm.id || id;
    norm.file = metaFile;
    norm.dir = dir;
    return norm;
  } catch {
    return null;
  }
}

function readFlatSession(root, id) {
  const f = path.join(root, id + '.json');
  if (!fs.existsSync(f)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const norm = normalizeSession(raw);
    if (!norm) return null;
    norm.id = norm.id || id;
    norm.file = f;
    return norm;
  } catch {
    return null;
  }
}

function loadSessionMeta(id) {
  if (!isValidSessionId(id)) return null;
  let meta = readFolderMeta(id, baseDir());
  if (!meta) {
    const local = projectLocalDir();
    if (local) meta = readFolderMeta(id, local);
  }
  if (!meta) meta = readFlatSession(baseDir(), id);
  if (!meta) {
    const local = projectLocalDir();
    if (local) meta = readFlatSession(local, id);
  }
  return meta;
}

/**
 * @typedef {Object} SaveSessionResult
 * @property {string} id
 * @property {string|null} file
 * @property {string|null} dir
 * @property {boolean} skipped
 */

/**
 * @typedef {Object} SaveSessionOptions
 * @property {boolean} [append] Append only new messages to the existing JSONL
 *   file instead of rewriting the whole transcript. Ignored when the prior
 *   save is not in the global store or the message list shrank.
 */

function messageJsonl(messages) {
  return messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '');
}

function buildSaveData(session, id, prev, now, messages) {
  const createdAt = prev && typeof prev.createdAt === 'string' ? prev.createdAt : now;
  const title = prev && typeof prev.title === 'string' && prev.title !== 'Untitled session'
    ? prev.title
    : sessionTitle(messages);
  return {
    id,
    schemaVersion: SESSION_SCHEMA_VERSION,
    title,
    directory: prev && prev.directory ? resolveDir(String(prev.directory)) : projectRoot(),
    createdAt,
    updatedAt: now,
    provider: session.config ? session.config.provider : null,
    model: session.config && session.config.model ? session.config.model[session.config.provider] : null,
    messageCount: messages.length,
  };
}

function prepareSave(session) {
  const now = new Date().toISOString();
  const id = isValidSessionId(session.conversationId) ? session.conversationId : convId();
  const messages = Array.isArray(session.messages) ? session.messages : [];
  // Metadata only: reading the entire messages.jsonl here made every save
  // O(transcript) and froze the TUI on long sessions.
  const prev = loadSessionMeta(id);
  if (!hasConversation(messages)) {
    return { id, prev, messages, skipped: true, data: null, dir: null, now };
  }
  return {
    id,
    prev,
    messages,
    skipped: false,
    data: buildSaveData(session, id, prev, now, messages),
    dir: path.join(baseDir(), id),
    now,
  };
}

function saveSession(session) {
  const prepared = prepareSave(session);
  const { id, prev, messages } = prepared;
  // Do not create a session just because the TUI opened and closed. Empty
  // sessions used to fill /sessions with rows that could never be resumed.
  if (prepared.skipped) {
    return { id, file: prev ? prev.file || null : null, dir: prev ? prev.dir || null : null, skipped: true };
  }
  ensureDir();
  const dir = /** @type {string} */ (prepared.dir);
  fs.mkdirSync(dir, { recursive: true });
  const metaFile = path.join(dir, 'session.json');
  // Write messages first, metadata last: a crash mid-save leaves the old
  // session.json pointing at a complete messages file, never the reverse.
  const msgFile = path.join(dir, 'messages.jsonl');
  const msgTmp = msgFile + '.tmp';
  fs.writeFileSync(msgTmp, messageJsonl(messages));
  fs.renameSync(msgTmp, msgFile);
  const metaTmp = metaFile + '.tmp';
  fs.writeFileSync(metaTmp, JSON.stringify(prepared.data, null, 2));
  fs.renameSync(metaTmp, metaFile);
  return { id, file: metaFile, dir, skipped: false };
}

/**
 * Save without blocking the UI thread. Live turn saves append only the new
 * messages; structural changes (undo/redo, compaction, quit) pass
 * `{ append: false }` and rewrite the transcript from scratch.
 * @param {any} session
 * @param {SaveSessionOptions=} options
 * @returns {Promise<SaveSessionResult>}
 */
async function saveSessionAsync(session, options) {
  const opts = options || {};
  const prepared = prepareSave(session);
  const { id, prev, messages } = prepared;
  if (prepared.skipped) {
    return { id, file: prev ? prev.file || null : null, dir: prev ? prev.dir || null : null, skipped: true };
  }
  const dir = /** @type {string} */ (prepared.dir);
  const metaFile = path.join(dir, 'session.json');
  const msgFile = path.join(dir, 'messages.jsonl');
  await fs.promises.mkdir(dir, { recursive: true });
  let appended = false;
  // Only append when the previous save lives in this exact directory and the
  // transcript only grew. Legacy/local files and shrinks get a clean rewrite.
  if (opts.append !== false && prev && prev.dir && sameDir(prev.dir, dir) &&
      typeof prev.messageCount === 'number' && prev.messageCount > 0 &&
      messages.length > prev.messageCount && fs.existsSync(msgFile)) {
    try {
      await fs.promises.appendFile(msgFile, messageJsonl(messages.slice(prev.messageCount)));
      appended = true;
    } catch {}
  }
  if (!appended) {
    const msgTmp = msgFile + '.tmp';
    await fs.promises.writeFile(msgTmp, messageJsonl(messages));
    await fs.promises.rename(msgTmp, msgFile);
  }
  const metaTmp = metaFile + '.tmp';
  await fs.promises.writeFile(metaTmp, JSON.stringify(prepared.data, null, 2));
  await fs.promises.rename(metaTmp, metaFile);
  return { id, file: metaFile, dir, skipped: false };
}

function addListed(out, entry, source, options) {
  if (!entry || !isValidSessionId(entry.id)) return;
  const count = typeof entry.messageCount === 'number'
    ? entry.messageCount
    : Array.isArray(entry.messages) ? entry.messages.length : 0;
  if (!options.includeEmpty && count <= 0) return;
  const directory = entry.directory
    ? resolveDir(String(entry.directory))
    : source === 'project' ? options.directory : null;
  if (!options.allProjects && source !== 'project') {
    if (!directory) return;
    if (!sameDir(directory, options.directory)) return;
  }
  if (out.has(entry.id)) return;
  let mtime = null;
  try { mtime = fs.statSync(entry.file).mtime.toISOString(); } catch {}
  out.set(entry.id, {
    id: entry.id,
    title: typeof entry.title === 'string' ? entry.title : null,
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
    mtime,
    messageCount: count,
    provider: entry.provider || null,
    model: entry.model || null,
    directory: directory || null,
    source,
  });
}

/**
 * List resumable sessions. By default only non-empty sessions from the
 * current project are returned, newest first.
 * @param {ListSessionsOptions} [opts]
 * @returns {SessionSummary[]}
 */
function listSessions(opts) {
  const options = {
    allProjects: !!(opts && opts.allProjects),
    includeEmpty: !!(opts && opts.includeEmpty),
    directory: resolveDir(opts && opts.directory ? opts.directory : projectRoot()),
  };
  ensureDir();
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(baseDir()); } catch {}
  // New global sessions first; same-id legacy copies are shadowed below.
  for (const name of names) {
    const meta = readFolderMeta(name, baseDir());
    if (!meta) continue;
    meta.messageCount = typeof meta.messageCount === 'number'
      ? meta.messageCount
      : countMessageLines(path.join(baseDir(), name, 'messages.jsonl'));
    if (!options.allProjects && !meta.directory && process.env.LOOM_CONFIG_DIR) {
      meta.directory = options.directory;
    }
    addListed(out, meta, 'global', options);
  }
  const local = projectLocalDir();
  if (local && fs.existsSync(local)) {
    let localNames = [];
    try { localNames = fs.readdirSync(local); } catch {}
    for (const name of localNames) {
      const meta = readFolderMeta(name, local);
      if (meta) addListed(out, meta, 'project', options);
    }
  }
  const list = [...out.values()];
  const stamp = (s) => s.updatedAt || s.createdAt || s.mtime || '';
  return list.sort((a, b) => (stamp(b) < stamp(a) ? -1 : stamp(b) > stamp(a) ? 1 : 0));
}

/**
 * Newest resumable session for the current project, or null.
 * @param {ListSessionsOptions} [opts]
 * @returns {SessionSummary|null}
 */
function latestSession(opts) {
  return listSessions(opts)[0] || null;
}

function loadSession(id) {
  if (!isValidSessionId(id)) return null;
  let data = readFolderSession(id, baseDir());
  if (!data) {
    const local = projectLocalDir();
    if (local) data = readFolderSession(id, local);
  }
  if (!data) data = readFlatSession(baseDir(), id);
  if (!data) {
    const local = projectLocalDir();
    if (local) data = readFlatSession(local, id);
  }
  return data;
}

function deleteSession(id) {
  if (!isValidSessionId(id)) return false;
  let removed = false;
  const roots = [baseDir()];
  const local = projectLocalDir();
  if (local) roots.push(local);
  for (const root of new Set(roots)) {
    const dir = path.join(root, id);
    if (fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); removed = true; } catch {}
    }
    const f = path.join(root, id + '.json');
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); removed = true; } catch {}
    }
  }
  return removed;
}

function exportChat(session, format) {
  const type = format || 'md';
  const msgs = session.messages || [];
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(process.cwd(), 'loom-chat-' + ts + '.' + type);
  if (type === 'md') {
    const lines = ['# Loom Code Chat Export', '', '**Date:** ' + new Date().toLocaleString(), ''];
    for (const m of msgs) {
      const role = m.role || 'unknown';
      lines.push('### ' + role.charAt(0).toUpperCase() + role.slice(1));
      lines.push('');
      lines.push(m.content || '(empty)');
      lines.push('');
    }
    fs.writeFileSync(file, lines.join('\n'));
  } else {
    const exportLines = msgs.map((m) => m.role + ': ' + (m.content || ''));
    fs.writeFileSync(file, exportLines.join('\n'));
  }
  return file;
}

module.exports = {
  saveSession,
  saveSessionAsync,
  listSessions,
  latestSession,
  loadSession,
  deleteSession,
  exportChat,
  normalizeSession,
  sessionTitle,
  isValidSessionId,
  SESSION_SCHEMA_VERSION,
};
