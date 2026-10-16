// Memory — layered steering files injected into every session's system prompt.
// Layers: global (~/.loom/LOOM.md), then project steering: LOOM.md and
// AGENTS.md in <cwd> plus up to 3 parent directories (monorepo repos carry
// steering at the root). CLAUDE.md loads only when the cwd has neither
// LOOM.md nor AGENTS.md (back-compat shim). Any file may pull in others with
// `@relative/path.md` lines (depth-capped, cycle-safe).
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_IMPORT_DEPTH = 3;
// Cap each layer so a runaway memory file can't eat the context window.
const MAX_CHARS_PER_LAYER = 12000;
// Hard cap for the whole project section (4 dirs × 2 filenames worst case).
const MAX_CHARS_PROJECT = 24000;
// How many directories up from cwd carry steering files.
const MAX_PARENT_DEPTH = 3;

function globalMemoryPath() {
  const base = process.env.LOOM_CONFIG_DIR || path.join(os.homedir(), '.loom');
  return path.join(base, 'LOOM.md');
}

/**
 * Read one markdown file and expand @imports.
 * @param {string} file
 * @param {number} depth
 * @param {Set<string>} seen
 * @returns {string}
 */
function loadFile(file, depth, seen) {
  const abs = path.resolve(file);
  if (seen.has(abs)) return '';
  let raw = '';
  try { raw = fs.readFileSync(abs, 'utf8'); } catch { return ''; }
  seen.add(abs);
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*@([\w.\-/\\]+\.md)\s*$/);
    if (m && depth < MAX_IMPORT_DEPTH) {
      out.push(loadFile(path.join(path.dirname(abs), m[1]), depth + 1, seen));
      continue;
    }
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * Collect project steering files: cwd + up to MAX_PARENT_DEPTH parents,
 * LOOM.md then AGENTS.md per directory, nearest first. Returns
 * [{ file, body }] with imports expanded.
 * @returns {Array<{file: string, body: string}>}
 */
function collectProjectSteering() {
  const chunks = [];
  const seen = new Set();
  let dir = process.cwd();
  for (let depth = 0; depth <= MAX_PARENT_DEPTH; depth++) {
    const names = depth === 0
      ? ['LOOM.md', '.loom/LOOM.md', 'AGENTS.md']
      : ['LOOM.md', 'AGENTS.md'];
    for (const name of names) {
      const p = path.join(dir, name);
      const abs = path.resolve(p);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const body = loadFile(p, 0, new Set());
      if (body) chunks.push({ file: abs, body });
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chunks;
}

/**
 * Build the full memory block: "## Global memory" + "## Project memory"
 * sections with imports expanded. Empty string when no memory exists.
 * @returns {string}
 */
function loadMemory() {
  const parts = [];
  const g = loadFile(globalMemoryPath(), 0, new Set());
  if (g) parts.push('## Global memory\n\n' + g.slice(0, MAX_CHARS_PER_LAYER));
  let chunks = collectProjectSteering();
  // CLAUDE.md parity: only when no LOOM.md/AGENTS.md steering exists in cwd
  // or its parents — a repo that already steers via LOOM/AGENTS wins.
  if (!chunks.length) {
    const p = path.join(process.cwd(), '.claude', 'CLAUDE.md');
    const body = loadFile(p, 0, new Set());
    if (body) chunks.push({ file: p, body });
  }
  if (chunks.length) {
    const content = chunks
      .map((c) => '### ' + c.file + '\n\n' + c.body.slice(0, MAX_CHARS_PER_LAYER))
      .join('\n\n')
      .slice(0, MAX_CHARS_PROJECT);
    parts.push('## Project memory\n\n' + content);
  }
  return parts.join('\n\n');
}

/**
 * Append a remembered fact as a dated bullet under "## Remembered" in the
 * chosen layer's LOOM.md (default: project). Creates the file/heading.
 * @param {string} text
 * @param {'project'|'global'} [layer]
 * @returns {boolean}
 */
function appendMemory(text, layer) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  const file = layer === 'global'
    ? globalMemoryPath()
    : path.join(process.cwd(), 'LOOM.md');
  let body = '';
  try { body = fs.readFileSync(file, 'utf8'); } catch {}
  if (!/^\s*##\s*Remembered\s*$/m.test(body)) {
    body = (body ? body.replace(/\s*$/, '\n\n') : '') + '## Remembered\n';
  }
  const stamp = new Date().toISOString().slice(0, 10);
  body = body.replace(/(##\s*Remembered\s*\n)/, '$1- [' + stamp + '] ' + clean.replace(/\s*\n+\s*/g, ' ') + '\n');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return true;
  } catch {
    return false;
  }
}

module.exports = { loadMemory, globalMemoryPath, appendMemory };
