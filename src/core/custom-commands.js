// Custom slash commands — markdown files the user drops into
// <cwd>/.loom/commands/*.md or <LOOM_CONFIG_DIR or ~/.loom>/commands/*.md.
// The filename (minus .md) becomes the command: /deploy runs deploy.md.
// $ARGUMENTS in the body is replaced with everything after "/name ".
//
//   # .loom/commands/deploy.md
//   Run the deploy checklist for $ARGUMENTS: build, test, then ship.
//
// Used by the TUI's processSlash + autocomplete; pure functions here so the
// CLI can share them later. Reads are cached for 5s so typing stays snappy.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_TTL_MS = 5000;
/** @type {{at: number, list: {name: string, file: string}[]}} */
let _cache = { at: 0, list: [] };

function commandDirs() {
  const dirs = [path.join(process.cwd(), '.loom', 'commands')];
  const cfgDir = process.env.LOOM_COMMANDS_DIR
    || (process.env.LOOM_CONFIG_DIR ? path.join(process.env.LOOM_CONFIG_DIR, 'commands') : null)
    || path.join(os.homedir(), '.loom', 'commands');
  dirs.push(cfgDir);
  return [...new Set(dirs)];
}

/**
 * List available custom commands: [{ name, file, dir }]
 * @returns {{ name: string, file: string }[]}
 */
function listCustomCommands() {
  if (Date.now() - _cache.at < CACHE_TTL_MS) return _cache.list;
  const out = [];
  for (const dir of commandDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue;
      const name = f.slice(0, -3);
      if (!/^[a-z][\w-]*$/i.test(name)) continue;
      if (out.some(c => c.name === name)) continue; // cwd wins over global
      out.push({ name, file: path.join(dir, f) });
    }
  }
  _cache = { at: Date.now(), list: out };
  return out;
}

/** Invalidate the cache (tests / after editing a command). */
function invalidateCommandCache() {
  _cache = { at: 0, list: [] };
}

/**
 * Expand "/name args" into the prompt text: the md body with $ARGUMENTS
 * substituted. Returns null when the command doesn't exist.
 * @param {string} name
 * @param {string} [argsText]
 * @returns {string|null}
 */
function expandCustomCommand(name, argsText) {
  const cmd = listCustomCommands().find(c => c.name === String(name || '').toLowerCase());
  if (!cmd) return null;
  let body = '';
  try { body = fs.readFileSync(cmd.file, 'utf8'); } catch { return null; }
  return body.replace(/\$ARGUMENTS/g, String(argsText || '').trim()).trim();
}

module.exports = { listCustomCommands, expandCustomCommand, invalidateCommandCache, commandDirs };
