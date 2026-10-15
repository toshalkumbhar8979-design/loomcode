const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSION_SCHEMA_VERSION = 3;

const LOOM_DIR = path.join(os.homedir(), '.loom');

// Re-evaluated on every call so tests can isolate with LOOM_CONFIG_DIR.
// Layout is claude-code/opencode style: one folder per session inside the
// PROJECT's .loom/ directory:
//
//   <project>/.loom/sessions/<id>/session.json    metadata
//   <project>/.loom/sessions/<id>/messages.jsonl  one message per line
//
// Flat legacy files (~/.loom/sessions/<id>.json, schema v1/v2) stay
// readable; the next saveSession migrates them into the project folder.
function baseDir() {
  if (process.env.LOOM_CONFIG_DIR) return path.join(process.env.LOOM_CONFIG_DIR, 'sessions');
  return path.join(process.cwd(), '.loom', 'sessions');
}

// The pre-v3 global store. Same as baseDir() under LOOM_CONFIG_DIR (tests),
// the user's old ~/.loom/sessions otherwise.
function legacyDir() {
  if (process.env.LOOM_CONFIG_DIR) return path.join(process.env.LOOM_CONFIG_DIR, 'sessions');
  return path.join(LOOM_DIR, 'sessions');
}

function ensureDir() {
  const d = baseDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function convId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

// Session IDs become folder names — keep them strictly alphanumeric to rule
// out path traversal via loadSession/deleteSession (e.g. "../../secrets").
const ID_RX = /^[a-zA-Z0-9_-]{3,128}$/;
function isValidSessionId(id) {
  return typeof id === 'string' && ID_RX.test(id);
}

// Coerce whatever came off disk (hand-edited, corrupt, older schema) into the
// guaranteed current shape: { id, createdAt, schemaVersion, messages } with
// every message having { role, content } while preserving any extra fields.
// Snake-case tool fields from old saves are aliased to camelCase so a resumed
// session can always rebuild a valid provider payload (toolCallId is sent as
// tool_call_id / tool_use_id — losing it 400s on strict providers).
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
    id: typeof data.id === 'string' ? data.id : null,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
    schemaVersion: typeof data.schemaVersion === 'number' ? data.schemaVersion : 1,
    messages,
  };
}

function sessionFolder(id) {
  return path.join(baseDir(), id);
}

function readFolderSession(id) {
  const dir = sessionFolder(id);
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

function readFlatSession(dir, id) {
  const f = path.join(dir, id + '.json');
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

function saveSession(session) {
  ensureDir();
  const id = isValidSessionId(session.conversationId) ? session.conversationId : convId();
  const now = new Date().toISOString();
  // Overwriting an existing session keeps its original createdAt (it is the
  // same conversation); updatedAt always reflects this write.
  let createdAt = now;
  const prev = readFolderSession(id) || readFlatSession(baseDir(), id) || readFlatSession(legacyDir(), id);
  if (prev && typeof prev.createdAt === 'string') createdAt = prev.createdAt;
  const messages = session.messages || [];
  const data = {
    id,
    schemaVersion: SESSION_SCHEMA_VERSION,
    createdAt,
    updatedAt: now,
    provider: session.config ? session.config.provider : null,
    model: session.config && session.config.model ? session.config.model[session.config.provider] : null,
    messageCount: messages.length,
  };
  const dir = sessionFolder(id);
  fs.mkdirSync(dir, { recursive: true });
  const metaFile = path.join(dir, 'session.json');
  // Write messages first, metadata last: a crash mid-save leaves the old
  // session.json pointing at a complete messages file, never the reverse.
  const msgFile = path.join(dir, 'messages.jsonl');
  const tmp = msgFile + '.tmp';
  fs.writeFileSync(tmp, messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : ''));
  fs.renameSync(tmp, msgFile);
  fs.writeFileSync(metaFile, JSON.stringify(data, null, 2));
  return { id, file: metaFile, dir };
}

function listDir(dir, fromFolder) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (fromFolder) {
      const entry = readFolderSession(name);
      if (entry && isValidSessionId(entry.id)) out.push(entry);
    } else if (name.endsWith('.json')) {
      const id = name.replace(/\.json$/, '');
      const entry = readFlatSession(dir, id);
      if (entry && isValidSessionId(entry.id)) out.push(entry);
    }
  }
  return out;
}

function listSessions() {
  ensureDir();
  // Newest first by the last write time (updatedAt, else createdAt). Folder
  // sessions shadow same-id flat files (a migrated session must not appear
  // twice). Legacy ~/.loom/sessions files stay listed so old history remains
  // reachable after upgrading to the per-project folder layout.
  const byId = new Map();
  for (const s of listDir(legacyDir(), false)) byId.set(s.id, s);
  for (const s of listDir(baseDir(), false)) byId.set(s.id, s);
  for (const s of listDir(baseDir(), true)) byId.set(s.id, s);
  const list = [...byId.values()].map((data) => {
    let mtime = null;
    try { mtime = fs.statSync(data.file).mtime.toISOString(); } catch {}
    return {
      id: data.id,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      mtime,
      messageCount: data.messageCount || (data.messages || []).length,
      provider: data.provider,
      model: data.model,
    };
  });
  const stamp = (s) => s.updatedAt || s.createdAt || s.mtime || '';
  return list.sort((a, b) => (stamp(b) < stamp(a) ? -1 : stamp(b) > stamp(a) ? 1 : 0));
}

function loadSession(id) {
  if (!isValidSessionId(id)) return null;
  return readFolderSession(id) || readFlatSession(baseDir(), id) || readFlatSession(legacyDir(), id);
}

function deleteSession(id) {
  if (!isValidSessionId(id)) return false;
  let removed = false;
  const dir = sessionFolder(id);
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); removed = true; } catch {}
  }
  for (const d of new Set([baseDir(), legacyDir()])) {
    const f = path.join(d, id + '.json');
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
  listSessions,
  loadSession,
  deleteSession,
  exportChat,
  normalizeSession,
  isValidSessionId,
  SESSION_SCHEMA_VERSION,
};
