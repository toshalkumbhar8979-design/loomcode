// Formatters — run language-specific formatters on files after the agent
// writes/edits them (OpenCode-style). Disabled by default; enable via
// config.json `formatter`: true (all built-ins) or an object of per-formatter
// overrides / custom formatters.
//
//   formatter: false                      → all disabled (default)
//   formatter: true                       → all built-ins enabled
//   formatter: { ... }                    → built-ins enabled + overrides
//   formatter: { prettier: { disabled: true } }            → disable one
//   formatter: { gofmt: { command: ["gofmt","-w","$FILE"], extensions: [".go"] } }  → override
//   formatter: { myfmt: { command: ["fmt", "$FILE"], extensions: [".zzz"] } }        → custom
//
// The `$FILE` placeholder is replaced with the formatted file's path. When a
// command has no `$FILE`, the path is appended as the final argument.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig } = require('../config/settings');

/** @typedef {Object} FormatterDef
 *  @property {Array<string>} command
 *  @property {Array<string>} extensions
 */

/** @typedef {Object} FormatResult
 *  @property {boolean} formatted
 *  @property {string} [id]
 *  @property {Array<string>} [command]
 *  @property {string} [reason]
 */

/** @type {Record<string, FormatterDef>} */
const DEFAULT_FORMATTERS = {
  prettier: {
    command: ['npx', 'prettier', '--write', '$FILE'],
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.html', '.css', '.scss', '.md', '.json', '.json5', '.yaml', '.yml'],
  },
  biome: {
    command: ['npx', 'biome', 'format', '--write', '$FILE'],
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.html', '.css', '.json', '.jsonc', '.md'],
  },
  gofmt: { command: ['gofmt', '-w', '$FILE'], extensions: ['.go'] },
  rustfmt: { command: ['rustfmt', '--edition', '2021', '$FILE'], extensions: ['.rs'] },
  ruff: { command: ['ruff', 'format', '$FILE'], extensions: ['.py', '.pyi'] },
  uv: { command: ['uv', 'fmt', '$FILE'], extensions: ['.py', '.pyi'] },
  clangformat: {
    command: ['clang-format', '-i', '$FILE'],
    extensions: ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.ino', '.m', '.mm'],
  },
  shfmt: { command: ['shfmt', '-w', '$FILE'], extensions: ['.sh', '.bash'] },
  ktlint: { command: ['ktlint', '-F', '$FILE'], extensions: ['.kt', '.kts'] },
  dart: { command: ['dart', 'format', '$FILE'], extensions: ['.dart'] },
  terraform: { command: ['terraform', 'fmt', '$FILE'], extensions: ['.tf', '.tfvars'] },
  mix: { command: ['mix', 'format', '$FILE'], extensions: ['.ex', '.exs', '.eex', '.heex', '.leex', '.neex'] },
  gleam: { command: ['gleam', 'format', '$FILE'], extensions: ['.gleam'] },
  zig: { command: ['zig', 'fmt', '$FILE'], extensions: ['.zig', '.zon'] },
  nixfmt: { command: ['nixfmt', '$FILE'], extensions: ['.nix'] },
  ormolu: { command: ['ormolu', '--mode', 'inplace', '$FILE'], extensions: ['.hs'] },
  ocamlformat: { command: ['ocamlformat', '--inplace', '$FILE'], extensions: ['.ml', '.mli'] },
  rubocop: { command: ['rubocop', '-a', '$FILE'], extensions: ['.rb', '.rake', '.gemspec', '.ru'] },
  standardrb: { command: ['standardrb', '--fix', '$FILE'], extensions: ['.rb', '.rake', '.gemspec', '.ru'] },
  htmlbeautifier: { command: ['htmlbeautifier', '$FILE'], extensions: ['.erb'] },
};

/**
 * Resolve the enabled formatter set from config + built-ins.
 * @returns {{enabled: boolean, formatters: Record<string, FormatterDef>}}
 */
function enabledFormatters() {
  const cfg = loadConfig();
  const f = cfg.formatter;
  if (f === false || f === undefined || f === null) return { enabled: false, formatters: /** @type {Record<string, FormatterDef>} */ ({}) };
  if (f === true) return { enabled: true, formatters: { ...DEFAULT_FORMATTERS } };
  if (f && typeof f === 'object') {
    const out = /** @type {Record<string, FormatterDef>} */ ({});
    for (const [id, def] of Object.entries(DEFAULT_FORMATTERS)) {
      const u = f[id];
      const merged = { command: def.command, extensions: def.extensions, ...(u && typeof u === 'object' ? u : {}) };
      if (merged.disabled) continue;
      out[id] = /** @type {FormatterDef} */ ({ command: merged.command, extensions: merged.extensions });
    }
    // Custom formatters: any object key that isn't built-in with command+extensions.
    for (const [id, u] of Object.entries(f)) {
      if (!u || typeof u !== 'object') continue;
      if (u.command && Array.isArray(u.extensions)) {
        if (!u.disabled) out[id] = /** @type {FormatterDef} */ ({ command: u.command, extensions: u.extensions });
      }
    }
    return { enabled: true, formatters: out };
  }
  return { enabled: false, formatters: /** @type {Record<string, FormatterDef>} */ ({}) };
}

/** Substitute the $FILE placeholder (or append the path) in a command.
 * @param {Array<string>} command
 * @param {string} filePath
 * @returns {Array<string>} */
function buildCommand(command, filePath) {
  if (command.includes('$FILE')) {
    return command.map((a) => (a === '$FILE' ? filePath : a));
  }
  return command.concat([filePath]);
}

/** Pick the first enabled formatter that handles the given extension.
 * @param {string} ext
 * @returns {{found: boolean, id?: string, command?: Array<string>, reason?: string}} */
function resolveFormatter(ext) {
  const { enabled, formatters } = enabledFormatters();
  if (!enabled) return { found: false, reason: 'formatters are disabled (set config formatter: true to enable)' };
  const extLower = ext.toLowerCase();
  const ids = Object.keys(formatters).sort();
  for (const id of ids) {
    const def = formatters[id];
    if (def.extensions.some((e) => e.toLowerCase() === extLower)) {
      // Return the raw template — the $FILE placeholder is substituted with the
      // real path in formatFile (resolveFormatter has no path yet).
      return { found: true, id, command: def.command.slice() };
    }
  }
  return { found: false, reason: `no enabled formatter handles extension "${ext}"` };
}

/** Run the file through its formatter in place.
 * @param {string} filePath
 * @returns {Promise<FormatResult>} */
function formatFile(filePath) {
  const ext = path.extname(filePath);
  const resolved = resolveFormatter(ext);
  if (!resolved.found) return Promise.resolve({ formatted: false, reason: resolved.reason });
  const template = resolved.command;
  const id = resolved.id;
  if (!template || !id) return Promise.resolve({ formatted: false, reason: 'formatter not resolved' });
  const command = buildCommand(template, filePath);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command[0], command.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ formatted: false, reason: e && e.message ? e.message : String(e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (res) => { if (!settled) { settled = true; clearTimeout(timer); resolve(res); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ formatted: false, reason: `${id} timed out after 30000ms` });
    }, 30000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      const errCode = err && 'code' in err ? err.code : undefined;
      if (errCode === 'ENOENT') {
        done({ formatted: false, reason: `formatter command not found: ${command[0]}. Install it or disable the ${id} formatter.` });
      } else {
        done({ formatted: false, reason: err && err.message ? err.message : String(err) });
      }
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const msg = String(stderr || stdout || '').trim();
        done({ formatted: false, reason: `${id} exited ${code}: ${msg.slice(0, 300)}` });
        return;
      }
      done({ formatted: true, id, command });
    });
  });
}

/** Convenience for the tool layer: format a file just written; on success
 *  return a short note to append to the tool result.
 * @param {string} filePath
 * @returns {Promise<string>} */
async function formatAfterWrite(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const res = await formatFile(filePath);
  return res.formatted ? `\n[formatted by ${res.id}]` : '';
}

/** A names/status summary of the current formatter setup (for /format).
 * @returns {Array<string>} */
function formatStatusLines() {
  const { enabled, formatters } = enabledFormatters();
  const lines = [`Formatters: ${enabled ? 'ENABLED' : 'DISABLED'} (set config.json "formatter": true to enable)`];
  if (enabled) {
    for (const [id, def] of Object.entries(formatters)) {
      lines.push(`  ${id.padEnd(16)} ${def.extensions.join(' ')}`);
    }
  }
  return lines;
}

module.exports = {
  DEFAULT_FORMATTERS,
  enabledFormatters,
  resolveFormatter,
  buildCommand,
  formatFile,
  formatAfterWrite,
  formatStatusLines,
};
