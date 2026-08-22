// Restore points — snapshot the project's file tree on every user prompt so
// the user can /restore to any earlier state if the agent breaks something.
const fs = require('fs');
const path = require('path');
const os = require('os');

const RESTORE_FILE = process.env.LOOM_RESTORE_FILE || path.join(os.homedir(), '.loom', 'restore.json');
const MAX_POINTS = 20;

// Mirrors the TUI file walker's ignore list (node_modules, .git, dist, …).
const IGNORE_RX = /(^|[\/])(node_modules|\.git|dist|build|\.next|\.venv|venv|coverage|__pycache__|\.loom|\.idea|\.vscode)([\/]|$)/i;

const cwd = process.cwd();

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

// Per-file content cap: larger files (lockfiles, bundles, big data) are not
// snapshotted — they are recorded as null and left untouched by a restore.
const FILE_CAP = 200 * 1024;
// Total snapshot cap: keeps restore.json small (~MBs, not hundreds of MBs).
// Once the budget is spent, remaining files are recorded as null.
const TOTAL_CAP = 2 * 1024 * 1024;
// Store-wide budget: when the restore file exceeds this, the oldest points
// are dropped on load (20 x TOTAL_CAP would otherwise mean 40MB on disk).
const FILE_BUDGET = 8 * 1024 * 1024;

// Snapshot current project: rel path -> content.
//   - string  = file was captured (small, text); restore overwrites it.
//   - null    = file existed but was NOT captured (too big / unreadable /
//               budget exhausted); restore must leave it alone.
//   - absent  = file did not exist at the point; restore deletes it if it
//               appeared later.
function snapshotProject(base) {
  const list = [];
  walkFiles(base, 0, list);
  const files = {};
  let budget = TOTAL_CAP;
  for (const abs of list) {
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    let content = null;
    try {
      const st = fs.statSync(abs);
      if (st.size <= FILE_CAP && st.size <= budget) {
        const raw = fs.readFileSync(abs, 'utf8');
        if (!raw.includes('\u0000')) {
          content = raw;
          budget -= st.size;
        }
      }
    } catch {}
    files[rel] = content;
  }
  return files;
}

function loadPoints() {
  let points;
  try { points = JSON.parse(fs.readFileSync(RESTORE_FILE, 'utf8')); } catch { return []; }
  if (!Array.isArray(points)) return [];
  // Self-heal: older points could snapshot whole trees (huge files, hundreds
  // of MB). Compacting here keeps the file small forever after the first load.
  let size = 0;
  let needsCompact = points.length > MAX_POINTS;
  for (const p of points) {
    if (!p || typeof p.files !== 'object') continue;
    for (const c of Object.values(p.files)) {
      if (typeof c === 'string') {
        size += c.length;
        if (c.length > FILE_CAP) needsCompact = true;
      }
    }
  }
  // File-level budget: drop the oldest points until the whole store fits.
  // MAX_POINTS caps count; this caps bytes (20 x 2MB snapshots would be 40MB).
  if (size > FILE_BUDGET) {
    needsCompact = true;
    while (points.length > 1 && size > FILE_BUDGET) {
      const oldest = points.shift();
      if (oldest && typeof oldest.files === 'object') {
        for (const c of Object.values(oldest.files)) {
          if (typeof c === 'string') size -= c.length;
        }
      }
    }
  }
  if (needsCompact) {
    points = points.slice(-MAX_POINTS).map(p => {
      if (!p || typeof p.files !== 'object') return p;
      const files = {};
      for (const [rel, c] of Object.entries(p.files)) {
        if (typeof c === 'string' && c.length > FILE_CAP) files[rel] = null;
        else files[rel] = c;
      }
      return Object.assign({}, p, { files });
    });
    savePoints(points);
  }
  return points;
}

function savePoints(points) {
  try {
    fs.mkdirSync(path.dirname(RESTORE_FILE), { recursive: true });
    fs.writeFileSync(RESTORE_FILE, JSON.stringify(points, null, 1));
    try { fs.chmodSync(RESTORE_FILE, 0o600); } catch {}
  } catch {}
}

// Create a restore point labeled with the user prompt. Keeps the last
// MAX_POINTS, oldest dropped.
export function createRestorePoint(label, base) {
  base = base || cwd;
  const files = snapshotProject(base);
  const point = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: Date.now(),
    label: String(label || '').slice(0, 80),
    cwd: base,
    files,
  };
  const points = loadPoints();
  points.push(point);
  while (points.length > MAX_POINTS) points.shift();
  savePoints(points);
  return point;
}

// Newest first, for the picker. Only points belonging to the current project
// (matched by cwd) are shown, so switching projects can't restore the wrong tree.
export function listRestorePoints(base) {
  base = base || cwd;
  return loadPoints().filter(p => p.cwd === base).slice().reverse();
}

export function getRestorePoint(id) {
  return loadPoints().find(p => p.id === id) || null;
}

// Restore the project to the state captured at `id`: overwrite captured files,
// re-create ones that were deleted since, and remove files that were created
// after the point. Files recorded as null (too big to snapshot) are left alone.
// Returns a summary of what changed.
export function restoreTo(id, base) {
  base = base || cwd;
  const point = getRestorePoint(id);
  if (!point) return { ok: false, error: 'Restore point not found.' };

  const restored = [];
  const deleted = [];
  const errors = [];

  // 1. Overwrite / re-create captured files; skip the ones recorded as null
  //    (they existed but were not snapshotted — never touch them).
  for (const [rel, content] of Object.entries(point.files)) {
    if (content === null) continue;
    const abs = path.join(base, rel);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      restored.push(rel);
    } catch (e) {
      errors.push(rel + ': ' + String(e.message || e).slice(0, 80));
    }
  }

  // 2. Remove files created after the point (not present in the snapshot).
  const nowList = [];
  walkFiles(base, 0, nowList);
  for (const abs of nowList) {
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    if (!(rel in point.files)) {
      try { fs.rmSync(abs); deleted.push(rel); } catch {}
    }
  }

  // 3. Best-effort cleanup of now-empty directories (max depth 5, safe).
  for (let depth = 5; depth >= 0; depth--) {
    const dirs = [];
    walkDirs(base, 0, depth, dirs);
    for (const d of dirs) {
      try { if (fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch {}
    }
  }

  return { ok: true, restored, deleted, errors, fileCount: Object.keys(point.files).length };
}

function walkDirs(root, curDepth, maxDepth, out) {
  if (curDepth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (IGNORE_RX.test(full)) continue;
    if (e.isDirectory()) { out.push(full); walkDirs(full, curDepth + 1, maxDepth, out); }
  }
}
