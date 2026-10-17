// Startup update check — a quiet, non-blocking "is there a newer version of
// loom-agent on npm?" probe that runs once per day and prints at most one line
// to stderr before the TUI/REPL takes over the terminal.
//
// Design constraints:
//   - Non-blocking: runs concurrently with `main()`, never gates startup, and
//     any failure (offline, registry down, malformed body) is swallowed — this
//     must never break the app or add latency to first render.
//   - Throttled: one network probe per 24h, tracked by a stamp file so it
//     survives across runs.
//   - Silent when up-to-date; silent when disabled via LOOM_NO_UPDATE_CHECK.
//     Only prints when a strictly newer version is actually available.
//   - Compare is a plain semver-ish tuple compare (major.minor.patch), not a
//     library — enough for the "newer than installed?" question without a dep.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PKG = require('../../package.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h between probes
const FETCH_TIMEOUT_MS = 4000; // fail fast — this is best-effort only

function stampFile() {
  const dir = process.env.LOOM_CONFIG_DIR || path.join(os.homedir(), '.loom');
  return path.join(dir, 'update-check.json');
}

// Extract a comparable version tuple. Returns null for anything unparseable.
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// True when `latest` is strictly newer than `current`. Pre-release / build
// suffixes are ignored (treated as the base triple) — good enough here.
function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

// Read the last-check timestamp; returns 0 if absent/corrupt (so the very
// first run after install always checks).
function lastCheckAt() {
  try {
    const raw = fs.readFileSync(stampFile(), 'utf8');
    const n = Number(JSON.parse(raw).at);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function markChecked() {
  try {
    const file = stampFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), checked: PKG.version }));
  } catch {
    // Throttle stamp is best-effort — a failure just means we probe again
    // next run, never breaks startup.
  }
}

/**
 * Probe npm for the latest `loom-agent` version and, if it's newer than the
 * installed one, print a one-line upgrade hint to stderr. Throttled to one
 * probe per 24h. Never throws, never blocks, and returns the newer version
 * string (or null) so tests can assert the decision without inspecting
 * stderr.
 *
 * @returns {Promise<string|null>} latest version when an upgrade exists, else null
 */
async function updateCheck() {
  if (process.env.LOOM_NO_UPDATE_CHECK) return null;

  const now = Date.now();
  if (now - lastCheckAt() < CHECK_INTERVAL_MS) return null;

  // Claim the slot BEFORE the fetch: even if the network call fails we don't
  // want to retry on every startup when offline.
  markChecked();

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch('https://registry.npmjs.org/loom-agent/latest', { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) return null;
    const body = /** @type {{version?: unknown}} */ (await res.json());
    const latest = typeof body?.version === 'string' ? body.version : null;
    if (!isNewer(latest, PKG.version)) return null;

    process.stderr.write(
      `\n[loom] New version available: ${PKG.version} → ${latest}\n` +
      `[loom] Upgrade with: npm install -g ${PKG.name}@latest\n\n`
    );
    return latest;
  } catch {
    return null;
  }
}

module.exports = { updateCheck, isNewer, parseVersion };
