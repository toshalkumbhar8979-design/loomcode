// Lifecycle hooks — user-configured shell commands fired at key points in the
// agent loop (Claude Code-style). Config lives in config.json:
//
//   "hooks": {
//     "userPromptSubmit": "node .loom/hooks/ctx.js", // may BLOCK the prompt or inject context
//     "preToolUse":  "node .loom/hooks/guard.js",   // may BLOCK the tool call
//     "postToolUse": "node .loom/hooks/audit.js",   // informational (gets tool_response)
//     "stop":        "node .loom/hooks/notify.js",  // fires when a turn ends
//     "subagentStop": "node .loom/hooks/done.js"    // fires when a subagent finishes
//   }
//
// Contract: the command receives JSON on stdin ({ hook, tool, input,
// tool_response } for pre/post, { hook, prompt } for userPromptSubmit,
// { hook, reason } for stop/subagentStop) plus LOOM_HOOK / LOOM_TOOL /
// LOOM_TOOL_INPUT env vars (Windows one-liner friendly). Exit code non-zero,
// or stdout containing {"decision":"deny"|"block","reason":"..."}, blocks a
// preToolUse tool call or a userPromptSubmit prompt. userPromptSubmit stdout
// may also carry {"hookSpecificOutput":{"additionalContext":"..."}} (or a
// top-level additionalContext) which is appended to the user's message.
// A 10s timeout counts as a failure-to-run (allowed through) rather than a
// deny — hooks must not wedge the loop.
const { spawn } = require('child_process');
const { loadConfig } = require('../config/settings');

/** @typedef {'preToolUse'|'postToolUse'|'stop'|'userPromptSubmit'|'subagentStop'} HookName */

/**
 * Run one configured hook.
 * @param {HookName} name
 * @param {{ tool?: string, input?: object, reason?: string, prompt?: string, tool_response?: string, agent?: string, runId?: string, interrupted?: boolean }} payload
 * @returns {Promise<{ blocked: boolean, reason?: string, ran: boolean, additionalContext?: string }>}
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
      // Structured deny wins over exit codes; plain non-zero also blocks
      // preToolUse and userPromptSubmit.
      let denyReason = null;
      let additionalContext = null;
      const m = out.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const j = JSON.parse(m[0]);
          if (j && (j.decision === 'deny' || j.decision === 'block')) {
            denyReason = String(j.reason || 'blocked by hook');
          }
          const ctxText = j && (j.additionalContext
            || (j.hookSpecificOutput && j.hookSpecificOutput.additionalContext));
          if (ctxText) additionalContext = String(ctxText);
        } catch {}
      }
      const blockable = name === 'preToolUse' || name === 'userPromptSubmit';
      if (blockable && (denyReason || code !== 0)) {
        done({ blocked: true, reason: denyReason || ('hook exited ' + code), ran: true });
        return;
      }
      done({ blocked: false, ran: true, additionalContext: additionalContext || undefined });
    });
  });
}

module.exports = { runHook };
