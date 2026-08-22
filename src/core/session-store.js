const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSION_SCHEMA_VERSION = 2;

const LOOM_DIR = path.join(os.homedir(), '.loom');
const SESSIONS_DIR = path.join(LOOM_DIR, 'sessions');

// Re-evaluated on every call so tests can isolate with LOOM_CONFIG_DIR.
function sessionsDir() {
  return path.join(process.env.LOOM_CONFIG_DIR || LOOM_DIR, 'sessions');
}

function ensureDir() {
  const d = sessionsDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function convId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

// Coerce whatever came off disk (hand-edited, corrupt, older schema) into the
// guaranteed current shape: { id, createdAt, schemaVersion, messages } with
// every message having { role, content } while preserving any extra fields.
function normalizeSession(data) {
  if (!data || typeof data !== 'object') return null;
  const raw = Array.isArray(data.messages) ? data.messages : [];
  const messages = raw.map((m) => {
    if (!m || typeof m !== 'object') return { role: 'user', content: '' };
    const { role, content, ...rest } = m;
    return { role: role || 'user', content: typeof content === 'undefined' ? '' : content, ...rest };
  });
  return {
    id: typeof data.id === 'string' ? data.id : null,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
    schemaVersion: typeof data.schemaVersion === 'number' ? data.schemaVersion : 1,
    messages,
  };
}

// Session IDs become file names — keep them strictly alphanumeric to rule out
// path traversal via loadSession/deleteSession (e.g. "../../secrets").
const ID_RX = /^[a-zA-Z0-9_-]{3,128}$/;
function isValidSessionId(id) {
  return typeof id === 'string' && ID_RX.test(id);
}

function saveSession(session) {
  ensureDir();
  const id = isValidSessionId(session.conversationId) ? session.conversationId : convId();
  const now = new Date().toISOString();
  // Overwriting an existing session keeps its original createdAt (it is the
  // same conversation); updatedAt always reflects this write.
  let createdAt = now;
  const existingFile = path.join(sessionsDir(), id + '.json');
  if (fs.existsSync(existingFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(existingFile, 'utf8'));
      if (prev && typeof prev.createdAt === 'string') createdAt = prev.createdAt;
    } catch {}
  }
  const data = {
    id,
    schemaVersion: SESSION_SCHEMA_VERSION,
    createdAt,
    updatedAt: now,
    messages: session.messages || [],
    provider: session.config ? session.config.provider : null,
    model: session.config && session.config.model ? session.config.model[session.config.provider] : null,
  };
  const f = path.join(sessionsDir(), id + '.json');
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
  return { id, file: f };
}

function listSessions() {
  ensureDir();
  const files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json'));
  const list = files.map((f) => {
    const p = path.join(sessionsDir(), f);
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      let mtime = null;
      try { mtime = fs.statSync(p).mtime.toISOString(); } catch {}
      return {
        id: data.id || f.replace('.json', ''),
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        mtime,
        messageCount: (data.messages || []).length,
        provider: data.provider,
        model: data.model,
      };
    } catch {
      let mtime = null;
      try { mtime = fs.statSync(p).mtime.toISOString(); } catch {}
      return { id: f.replace('.json', ''), createdAt: null, updatedAt: null, mtime, messageCount: 0 };
    }
  });
  // Newest first by the last write time (updatedAt, else createdAt, else the
  // file's own mtime). Sorting by file NAME put legacy "share-*" exports on
  // top forever ("s" > "m"), burying the real, recent conversations.
  const stamp = (s) => s.updatedAt || s.createdAt || s.mtime || '';
  return list.filter((s) => isValidSessionId(s.id)).sort((a, b) => (stamp(b) < stamp(a) ? -1 : stamp(b) > stamp(a) ? 1 : 0));
}

function loadSession(id) {
  if (!isValidSessionId(id)) return null;
  const f = path.join(sessionsDir(), id + '.json');
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

function deleteSession(id) {
  if (!isValidSessionId(id)) return false;
  const f = path.join(sessionsDir(), id + '.json');
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    return true;
  }
  return false;
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
  SESSIONS_DIR,
  SESSION_SCHEMA_VERSION,
};
