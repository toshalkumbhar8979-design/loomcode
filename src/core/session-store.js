const fs = require('fs');
const path = require('path');
const os = require('os');

const LOOM_DIR = path.join(os.homedir(), '.loom');
const SESSIONS_DIR = path.join(LOOM_DIR, 'sessions');

function ensureDir() {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function convId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function saveSession(session) {
  ensureDir();
  const id = session.conversationId || convId();
  const data = {
    id,
    createdAt: new Date().toISOString(),
    messages: session.messages || [],
    provider: session.config ? session.config.provider : null,
    model: session.config && session.config.model ? session.config.model[session.config.provider] : null,
  };
  const f = path.join(SESSIONS_DIR, id + '.json');
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
  return { id, file: f };
}

function listSessions() {
  ensureDir();
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
  return files.map((f) => {
    const p = path.join(SESSIONS_DIR, f);
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return {
        id: data.id || f.replace('.json', ''),
        createdAt: data.createdAt,
        messageCount: (data.messages || []).length,
        provider: data.provider,
        model: data.model,
      };
    } catch {
      return { id: f.replace('.json', ''), createdAt: null, messageCount: 0 };
    }
  });
}

function loadSession(id) {
  const f = path.join(SESSIONS_DIR, id + '.json');
  if (!fs.existsSync(f)) return null;
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  return data;
}

function deleteSession(id) {
  const f = path.join(SESSIONS_DIR, id + '.json');
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

module.exports = { saveSession, listSessions, loadSession, deleteSession, exportChat, SESSIONS_DIR };