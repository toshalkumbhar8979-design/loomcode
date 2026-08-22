// Lifecycle hooks — user-configured shell commands fired at key points in the
// agent loop (Claude Code-style). Config lives in config.json:
//
//   "hooks": {
//     "preToolUse":  "node .loom/hooks/guard.js",   // may BLOCK the tool call
//     "postToolUse": "node .loom/hooks/audit.js",   // informational
//     "stop":        "node .loom/hooks/notify.js"   // fires when a turn ends
//   }
//
// Contract: the command receives JSON on stdin ({ hook, tool, input } for
// pre/post, { hook, reason } for stop) plus LOOM_HOOK / LOOM_TOOL /
// LOOM_TOOL_INPUT env vars (Windows one-liner friendly). Exit code non-zero,
// or stdout containing {"decision":"deny","reason":"..."}, blocks a
// preToolUse hook's tool call. A 10s timeout counts as a failure-to-run
// (allowed through) rather than a deny — hooks must not wedge the loop.
const { spawn } = require('child_process');
const { loadConfig } = require('../config/settings');

/** @typedef {'preToolUse'|'postToolUse'|'stop'} HookName */

/**
 * Run one configured hook.
 * @param {HookName} name
 * @param {{ tool?: string, input?: object, reason?: string }} payload
 * @returns {Promise<{ blocked: boolean, reason?: string, ran: boolean }>}
 */
async function runHook(name, payload) {
  let cmd = '';
  try {
    const cfg = loadConfig();
    cmd = String((cfg.hooks || {})[name] || '');
  } catch {}
  if (!cmd.trim()) return { blocked: false, ran: false };

  return await new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(cmd, {
        shell: true,
        windowsHide: true,
        env: Object.assign({}, process.env, {
          LOOM_HOOK: name,
          LOOM_TOOL: payload.tool || '',
          LOOM_TOOL_INPUT: payload.input ? JSON.stringify(payload.input) : '',
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      done({ blocked: false, ran: false });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ blocked: false, ran: true });
    }, 10000);
    try { child.stdin.write(JSON.stringify({ hook: name, ...payload })); child.stdin.end(); } catch {}
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('error', () => { clearTimeout(timer); done({ blocked: false, ran: false }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Structured deny wins over exit codes; plain non-zero also blocks preToolUse.
      let denyReason = null;
      const m = out.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const j = JSON.parse(m[0]);
          if (j && j.decision === 'deny') denyReason = String(j.reason || 'blocked by hook');
        } catch {}
      }
      if (name === 'preToolUse' && (denyReason || code !== 0)) {
        done({ blocked: true, reason: denyReason || ('hook exited ' + code), ran: true });
        return;
      }
      done({ blocked: false, ran: true });
    });
  });
}

module.exports = { runHook };
