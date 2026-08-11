// File-diff capture for the chat area — right-side visual panel showing
// which files the agent edited and the actual +/- hunks.
// Snapshot BEFORE a write/edit/bash tool runs, then record AFTER to build the diff.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { diffLines } = require('diff');

const cwd = process.cwd();

// Binary content (png/pdf/zip/exe…) read as utf8 is meaningless garbage, and
// diffing it fills the panel with noise. Detect it up front and show a short
// "(binary file)" line instead of the hunks.
function looksBinary(text) {
  if (!text) return false;
  const sample = text.slice(0, 8192);
  if (sample.indexOf('\0') >= 0) return true;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 8) bad++;
  }
  return bad / Math.max(1, sample.length) > 0.02;
}

// Mirrors the TUI file walker's ignore list (node_modules, .git, dist, …).
const IGNORE_RX = /(^|[\/])(node_modules|\.git|dist|build|\.next|\.venv|venv|coverage|__pycache__|\.loom|\.idea|\.vscode)([\/]|$)/i;

function relPath(abs) {
  const rel = path.relative(cwd, abs).replace(/\\/g, '/');
  return rel || abs;
}

// Read file content, or null if missing.
function readFileOrNull(abs) {
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

// Track edits per session: abs path -> { before, after }
const edits = new Map();

export function snapshotBefore(filePath) {
  const abs = path.resolve(filePath);
  const before = readFileOrNull(abs);
  edits.set(abs, { before, after: before });
  return { abs, before };
}

// After the tool finished, re-read the file and build the diff vs. the
// pre-edit snapshot. Accumulates: if the same file is edited twice in one
// turn, diff is always against the ORIGINAL snapshot (cumulative view).
export function snapshotAfter(filePath) {
  const abs = path.resolve(filePath);
  const prev = edits.get(abs) || { before: null };
  const after = readFileOrNull(abs);
  prev.after = after;
  edits.set(abs, prev);
  return buildFileDiff(abs, prev.before, prev.after);
}

// ─── Bash tool detection ───
// The bash tool can modify files outside write/edit (sed -i, git apply, npm
// install, scaffolders, …). Snapshot the repo state before the call, then
// diff after it: git repos use `git diff` (accurate, no content copies);
// non-git directories snapshot small file contents + mtimes.
let bashBefore = null; // { git: bool, files: Map<abs, {content|null, mtimeMs, size}>, untracked: Set<abs> }

function walkFiles(root, depth, out) {
  if (depth > 5 || out.length > 400) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (IGNORE_RX.test(full)) continue;
    if (e.isDirectory()) walkFiles(full, depth + 1, out);
    else out.push(full);
  }
}

function git(args) {
  try {
    return execSync('git ' + args, { cwd: process.cwd(), encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    return null;
  }
}

export function snapshotBashBefore() {
  const isGit = git('rev-parse --is-inside-work-tree') === 'true';
  const files = new Map();
  if (isGit) {
    const untracked = new Set();
    const st = git('status --porcelain');
    for (const line of String(st || '').split('\n')) {
      if (/^\?\?/.test(line)) untracked.add(path.resolve(cwd, line.slice(3).trim()));
    }
    bashBefore = { git: true, files, untracked };
  } else {
    const list = [];
    walkFiles(cwd, 0, list);
    for (const f of list) {
      try {
        const st = fs.statSync(f);
        let content = null;
        if (st.size <= 1024 * 1024) content = readFileOrNull(f);
        files.set(f, { content, mtimeMs: st.mtimeMs, size: st.size });
      } catch {}
    }
    bashBefore = { git: false, files, untracked: new Set() };
  }
  return isGit;
}

// After the bash tool finished, return diffs for everything it changed.
export function diffBashAfter() {
  if (!bashBefore) return [];
  const out = [];
  if (bashBefore.git) {
    const diffText = git('diff --no-color --no-ext-diff') || '';
    for (const d of parseGitDiff(diffText)) out.push(d);
    // New untracked files → all-added diffs.
    const st = git('status --porcelain') || '';
    for (const line of st.split('\n')) {
      if (!/^\?\?/.test(line)) continue;
      const abs = path.resolve(cwd, line.slice(3).trim());
      if (bashBefore.untracked.has(abs)) continue; // was already there
      const d = buildFileDiff(abs, null, readFileOrNull(abs));
      if (d.added || d.removed) out.push(d);
    }
  } else {
    const list = [];
    walkFiles(cwd, 0, list);
    const now = new Map();
    for (const f of list) {
      try {
        const st = fs.statSync(f);
        now.set(f, { mtimeMs: st.mtimeMs, size: st.size });
      } catch {}
    }
    // Changed or deleted files.
    const changed = [];
    for (const [abs, st] of bashBefore.files) {
      const cur = now.get(abs);
      if (!cur || cur.mtimeMs !== st.mtimeMs || cur.size !== st.size) changed.push(abs);
    }
    for (const abs of now.keys()) {
      if (!bashBefore.files.has(abs)) changed.push(abs); // newly created
    }
    for (const abs of changed) {
      const before = bashBefore.files.get(abs)?.content;
      const after = readFileOrNull(abs);
      const d = buildFileDiff(abs, before, after);
      if (d.added || d.removed) out.push(d);
    }
  }
  bashBefore = null;
  return out;
}

// Parse a unified `git diff` into per-file { path, added, removed, lines }.
function parseGitDiff(text) {
  const out = [];
  const filePat = /^diff --git a\/(.*) b\/(.*)$/;
  let cur = null;
  const lines = String(text).split('\n');
  for (const line of lines) {
    const fm = line.match(filePat);
    if (fm) {
      if (cur && (cur.added || cur.removed)) out.push(cur);
      const p = fm[2].replace(/^"|"$/g, '');
      cur = { path: p, abs: path.resolve(cwd, p), added: 0, removed: 0, lines: /** @type {Array<{kind: string, text: string}>} */ ([]) };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('\\')) continue;
    if (/^Binary files/.test(line)) { cur.added++; cur.removed++; cur.lines.push({ kind: 'ctx', text: '(binary file changed)' }); continue; }
    if (line.startsWith('+')) { if (looksBinary(line.slice(1))) continue; cur.added++; cur.lines.push({ kind: 'add', text: line.slice(1) }); }
    else if (line.startsWith('-')) { if (looksBinary(line.slice(1))) continue; cur.removed++; cur.lines.push({ kind: 'del', text: line.slice(1) }); }
    else { if (looksBinary(line.slice(1))) continue; cur.lines.push({ kind: 'ctx', text: line.slice(1) }); }
  }
  if (cur && (cur.added || cur.removed)) out.push(cur);
  for (const d of out) {
    d.lines = trimContext(d.lines, 2);
    d.lines = d.lines.length > 24 ? d.lines.slice(0, 24) : d.lines;
  }
  return out;
}

// Build a compact visual diff: counts + colored hunk lines.
export function buildFileDiff(abs, before, after) {
  if (looksBinary(after) || looksBinary(before)) {
    // Unchanged binary file (snapshot taken before a tool that didn't touch
    // it) → empty diff; don't show a bogus "0 bytes changed" entry.
    if (before !== null && after !== null && before === after) {
      return { path: relPath(abs), abs, added: 0, removed: 0, lines: [], isNew: false };
    }
    const beforeBytes = before ? Buffer.byteLength(before, 'utf8') : 0;
    const afterBytes = after ? Buffer.byteLength(after, 'utf8') : 0;
    const bytesChanged = Math.max(0, Math.abs(afterBytes - beforeBytes));
    return {
      path: relPath(abs),
      abs,
      added: 1,
      removed: 0,
      lines: [{ kind: 'ctx', text: '(binary file, ' + bytesChanged + ' bytes changed)' }],
      isNew: before === null && after !== null,
    };
  }
  const parts = diffLines(before || '', after || '');
  let added = 0;
  let removed = 0;
  const hunks = [];
  for (const part of parts) {
    if (part.added) { added += part.count; }
    else if (part.removed) { removed += part.count; }
  }
  // Line-by-line with kind markers; trim context to keep the panel compact.
  const lines = diffToLines(parts);
  const trimmed = trimContext(lines, 2);
  const shown = trimmed.length > 24 ? trimmed.slice(0, 24) : trimmed;
  return {
    path: relPath(abs),
    abs,
    added,
    removed,
    lines: shown,
    isNew: before === null && after !== null,
  };
}

function diffToLines(parts) {
  const out = [];
  for (const part of parts) {
    if (part.added) out.push({ kind: 'add', text: part.value });
    else if (part.removed) out.push({ kind: 'del', text: part.value });
    else out.push({ kind: 'ctx', text: part.value });
  }
  return out;
}

// Keep 2 context lines around each hunk, drop the rest (ellipsis marker).
function trimContext(lines, ctx) {
  if (!lines.length) return lines;
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'ctx') {
      for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
        if (!keep.includes(j)) keep.push(j);
      }
    }
  }
  keep.sort((a, b) => a - b);
  if (!keep.length) return [];
  const out = [];
  let last = -10;
  for (const i of keep) {
    if (i - last > 1) out.push({ kind: 'ctx', text: '…' });
    out.push(lines[i]);
    last = i;
  }
  return out;
}

export function clearFileDiffs() { edits.clear(); }
export function getFileDiffs() {
  const out = [];
  for (const [abs, e] of edits) {
    const d = buildFileDiff(abs, e.before, e.after);
    if (d.added || d.removed) out.push(d);
  }
  return out;
}
export function formatDiffCount(d) {
  const parts = [];
  if (d.added) parts.push('+' + d.added);
  if (d.removed) parts.push('-' + d.removed);
  return parts.join(' ') || '±0';
}

export { parseGitDiff };
