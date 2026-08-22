// Subagent run log — append-only JSON store of completed subagent runs so the
// /subagents panel (and future analytics) can show history across sessions.
//
// File: <LOOM_CONFIG_DIR or ~/.loom>/subagents.json — a JSON array of entries
// (one per completed run). Pruned to a sliding window so the file stays small.
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE_NAME = 'subagents.json';
// Cap the on-disk log so the file doesn't grow unbounded; pruning drops the
// oldest entries first when this threshold is exceeded.
const MAX_ENTRIES = 500;
// Default age window: drop anything older than this many ms (30 days).
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function subagentLogDir() {
  return process.env.LOOM_CONFIG_DIR || path.join(os.homedir(), '.loom');
}

function subagentLogPath() {
  return path.join(subagentLogDir(), FILE_NAME);
}

function ensureDir() {
  try { fs.mkdirSync(subagentLogDir(), { recursive: true }); } catch {}
}

// Read-modify-write: safe for concurrent appends within a single process
// (the TUI is the only writer). External writers can corrupt the file but
// that matches the pattern used by keybinds/theme tui.json.
function readAll() {
  try {
    const raw = fs.readFileSync(subagentLogPath(), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAll(entries) {
  ensureDir();
  try {
    fs.writeFileSync(subagentLogPath(), JSON.stringify(entries, null, 0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Append a completed subagent run to the log.
 * @param {object} entry
 * @param {string} entry.runId
 * @param {string} entry.agent          display name
 * @param {string} entry.agentId        id (e.g. 'general')
 * @param {string} entry.prompt         delegated instruction
 * @param {'done'|'error'|'cancelled'} entry.status
 * @param {number} entry.startTime      ms since epoch
 * @param {number} entry.endTime        ms since epoch
 * @param {number} entry.durationMs
 * @param {number} entry.tokensIn
 * @param {number} entry.tokensOut
 * @param {number} entry.costUsd
 * @param {boolean} [entry.interrupted]
 * @param {string} [entry.content]      final answer
 * @param {string[]} [entry.toolLog]
 * @param {string} [entry.sessionId]    parent conversation id
 * @returns {boolean} true if written
 */
function saveSubagentRun(entry) {
  if (!entry || !entry.runId) return false;
  const all = readAll();
  all.push(entry);
  // Cap the log size — drop oldest first.
  if (all.length > MAX_ENTRIES) all.splice(0, all.length - MAX_ENTRIES);
  return writeAll(all);
}

/**
 * Load subagent runs. Optional filters narrow the result.
 * @param {object} [opts]
 * @param {number} [opts.since]        only entries with startTime >= since
 * @param {string} [opts.sessionId]    only entries from this parent session
 * @param {number} [opts.limit]        cap on returned entries (newest first)
 * @returns {Array<object>}            newest first
 */
function loadSubagentRuns(opts) {
  const all = readAll();
  let out = all;
  if (opts && opts.since != null) {
    const since = Number(opts.since);
    out = out.filter(e => e && Number(e.startTime) >= since);
  }
  if (opts && opts.sessionId) {
    out = out.filter(e => e && e.sessionId === opts.sessionId);
  }
  // Newest first.
  out.sort((a, b) => Number(b.startTime) - Number(a.startTime));
  if (opts && opts.limit != null && opts.limit > 0) {
    out = out.slice(0, opts.limit);
  }
  return out;
}

/**
 * Drop entries older than maxAgeMs (default 30 days). Rewrites the file.
 * @param {number} [maxAgeMs]
 * @returns {number} count of remaining entries
 */
function pruneSubagentRuns(maxAgeMs) {
  const cutoff = Date.now() - (maxAgeMs || DEFAULT_MAX_AGE_MS);
  const all = readAll();
  const kept = all.filter(e => e && Number(e.startTime) >= cutoff);
  writeAll(kept);
  return kept.length;
}

/** Test helper — wipe the log entirely. */
function clearSubagentRuns() {
  return writeAll([]);
}

module.exports = {
  subagentLogPath,
  loadSubagentRuns,
  saveSubagentRun,
  pruneSubagentRuns,
  clearSubagentRuns,
  // Exposed for tests / callers that want the window.
  MAX_ENTRIES,
  DEFAULT_MAX_AGE_MS,
};