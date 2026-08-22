// Memory — layered LOOM.md files injected into every session's system prompt.
// Layers: global (~/.loom/LOOM.md) then project (<cwd>/LOOM.md). Any file may
// pull in others with `@relative/path.md` lines (depth-capped, cycle-safe).
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_IMPORT_DEPTH = 3;
// Cap each layer so a runaway memory file can't eat the context window.
const MAX_CHARS_PER_LAYER = 12000;

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
 * Build the full memory block: "## Global memory" + "## Project memory"
 * sections with imports expanded. Empty string when no memory exists.
 * @returns {string}
 */
function loadMemory() {
  const parts = [];
  const g = loadFile(globalMemoryPath(), 0, new Set());
  if (g) parts.push('## Global memory\n\n' + g.slice(0, MAX_CHARS_PER_LAYER));
  let p = loadFile(path.join(process.cwd(), 'LOOM.md'), 0, new Set());
  if (!p) p = loadFile(path.join(process.cwd(), '.loom', 'LOOM.md'), 0, new Set());
  if (p) parts.push('## Project memory\n\n' + p.slice(0, MAX_CHARS_PER_LAYER));
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
