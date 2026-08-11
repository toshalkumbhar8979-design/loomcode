// Agent registry — OpenCode-style specialized agents.
//
// Two kinds:
//   primary  — full sessions the user talks to (build / plan / chat). The
//              active primary is selected by the session mode, so these exist
//              here mostly for documentation, config and tool-filtering.
//   subagent — focused assistants the main agent delegates to AUTOMATICALLY
//              via the `task` tool, or manually via "@agent" mentions.
//
// Every agent carries:
//   id, name, mode, description, tools (last-match-wins pattern list),
//   optional model ("provider/model-id"), prompt (extra system text), and
//   temperature. User config (~/.loom/config.json → config.agents) merges over
//   the built-ins and can add custom subagents or disable any agent.
const { loadConfig } = require('../config/settings');

// Pattern semantics (last match wins):
//   ['*']            → everything allowed (default for primaries)
//   ['read','glob']  → only those tools
//   ['*','!task']    → everything except task (default for subagents)
//   ['mcp__*','!task'] → wildcards work too
function matchPattern(pat, name) {
  if (pat === name) return true;
  if (pat.includes('*')) {
    const re = new RegExp('^' + pat.split('*').map(escapeRegExp).join('.*') + '$');
    return re.test(name);
  }
  return false;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Built-in registry. Tool lists are resolved lazily so requiring this module
// never drags in the tools layer (no circular imports).
const BUILTIN_AGENTS = {
  build: {
    id: 'build', name: 'Build', mode: 'primary',
    description: 'Full development work with all tools enabled.',
    tools: ['*'],
    prompt: null,
  },
  plan: {
    id: 'plan', name: 'Plan', mode: 'primary',
    description: 'Read-only analysis and planning. Can delegate subagents but never edits files or runs shell commands.',
    tools: () => readOnlyTools(),
    prompt: 'You are the Plan agent. Analyze the request and produce a concrete, ordered plan (exact file paths + what changes). Do not modify anything; delegate heavy investigation to subagents when useful.',
  },
  chat: {
    id: 'chat', name: 'Chat', mode: 'primary',
    description: 'Conversation only, no tools.',
    tools: [],
    prompt: 'You are the Chat agent. Answer conversationally; you have no tools.',
  },
  general: {
    id: 'general', name: 'General', mode: 'subagent',
    description: 'General-purpose subagent with the full toolset (except delegation). Use for self-contained implementation tasks, bug fixes, and multi-step work.',
    tools: ['*', '!task'],
    prompt: null,
  },
  explore: {
    id: 'explore', name: 'Explore', mode: 'subagent',
    description: 'Fast read-only codebase exploration: search symbols, read files, list files. Never modifies anything.',
    // read-only tools, but WITHOUT task — subagents must not delegate (no recursion)
    tools: () => readOnlyTools().filter((t) => t !== 'task'),
    prompt: null,
  },
  scout: {
    id: 'scout', name: 'Scout', mode: 'subagent',
    description: 'External research: fetch docs, check APIs and dependencies. Read-only.',
    tools: ['read', 'glob', 'grep', 'webfetch'],
    prompt: null,
  },
};

function readOnlyTools() {
  const { READ_ONLY_TOOLS } = require('../tools');
  return READ_ONLY_TOOLS.slice();
}

function resolveTools(def) {
  const v = typeof def.tools === 'function' ? def.tools() : def.tools;
  return Array.isArray(v) ? v.slice() : null;
}

function normalizeAgent(id, def) {
  const tools = resolveTools(def);
  return {
    id,
    name: def.name || (id.charAt(0).toUpperCase() + id.slice(1)),
    mode: def.mode === 'primary' ? 'primary' : 'subagent',
    description: String(def.description || ''),
    tools, // null → everything allowed
    model: def.model || null,
    prompt: def.prompt || null,
    temperature: def.temperature != null ? def.temperature : null,
    color: def.color || null,
  };
}

// Built-ins + user config merged (per-agent override, disable, custom agents).
function loadAgents() {
  const cfg = loadConfig();
  const userAgents = (cfg.agents && typeof cfg.agents === 'object') ? cfg.agents : {};
  const out = {};

  for (const [id, base] of Object.entries(BUILTIN_AGENTS)) {
    const u = userAgents[id] || {};
    if (u.disable === true) continue;
    out[id] = normalizeAgent(id, { ...base, ...u });
  }
  // Custom subagents from config (need a description + subagent mode).
  for (const [id, u] of Object.entries(userAgents)) {
    if (out[id] || !u || typeof u !== 'object') continue;
    if (u.disable === true) continue;
    if (u.mode && u.mode !== 'subagent' && u.mode !== 'primary') continue;
    if (!u.description) continue;
    out[id] = normalizeAgent(id, {
      mode: u.mode || 'subagent',
      tools: u.tools || ['*', '!task'],
      description: u.description,
      name: u.name,
      model: u.model,
      prompt: u.prompt,
      temperature: u.temperature,
      color: u.color,
    });
  }
  return out;
}

function resolveAgent(id) {
  return loadAgents()[id] || null;
}

// True when the agent may call the given tool (mcp__server__tool works too).
function agentToolAllowed(agent, toolName) {
  if (!agent) return true;
  const tools = agent.tools;
  if (!tools || !tools.length) return true;
  let allowed = false;
  for (const pat of tools) {
    const p = String(pat);
    if (p === '*') allowed = true;
    else if (p.startsWith('!')) {
      if (matchPattern(p.slice(1), toolName)) allowed = false;
    } else if (matchPattern(p, toolName)) allowed = true;
  }
  return allowed;
}

// Filter a provider tool-definition list down to the agent's allowed set.
function filterToolDefs(agent, defs) {
  if (!agent || !agent.tools || !agent.tools.length) return defs || [];
  return (defs || []).filter((d) => agentToolAllowed(agent, d && d.name));
}

// "You are now <name>" block for a delegateTurn (@agent mention) — the MAIN
// session runs one turn as that agent.
function buildAgentTurnBlock(agent) {
  return '\n\n## Acting as the "' + agent.name + '" agent\n' +
    (agent.description ? agent.description + '\n' : '') +
    'For this turn only you are "' + agent.name + '".\n' +
    (agent.tools && agent.tools.length
      ? '- Allowed tools this turn: ' + agent.tools.join(', ') + '\n'
      : '- No tools are available this turn — answer directly.\n') +
    (agent.prompt ? '- ' + agent.prompt + '\n' : '') +
    '- When done, answer in Markdown with a complete, self-contained result (the delegator cannot see your internal steps).';
}

// Standalone system-prompt block for a child subagent session (task tool).
function buildSubagentBlock(agent) {
  return '\n\n## You are the "' + agent.name + '" subagent\n' +
    (agent.description ? agent.description + '\n' : '') +
    'You were delegated this task by the main Loom agent. Complete it fully and autonomously.\n' +
    (agent.tools && agent.tools.length
      ? '- Allowed tools: ' + agent.tools.join(', ') + '\n'
      : '- No tools are available — answer directly.\n') +
    '- You cannot delegate further (no task tool).\n' +
    (agent.prompt ? '- ' + agent.prompt + '\n' : '') +
    '- Never ask the user questions; work autonomously and report back.\n' +
    '- Your final message is returned verbatim to the delegator: be complete and self-contained. Include exact file paths, line numbers, and code blocks.';
}

// Result of a subagent run (see SpeedStats in session.js for the typedef pattern).
/** @typedef {object} SubagentResult
 *  @property {string} agent          display name of the subagent
 *  @property {string} id             agent id
 *  @property {string} content        final answer (capped at 8000 chars)
 *  @property {number} tokensIn       child session input tokens
 *  @property {number} tokensOut      child session output tokens
 *  @property {number} costUsd        child session cost in USD
 *  @property {number} durationMs     wall time of the run
 *  @property {boolean} interrupted   true when aborted mid-run
 */
/** @typedef {{error: string}} SubagentError */

// Run a child subagent session to completion. Returns
// { agent, id, content, tokensIn, tokensOut, costUsd, durationMs, interrupted }
// or { error } for bad agent ids / non-subagents.
/** @param {object} opts
 *  @param {string} opts.agentId
 *  @param {string} [opts.prompt]
 *  @param {string} [opts.model]
 *  @param {import('./session').Session|null} [opts.parentSession]
 *  @param {AbortSignal|null} [opts.signal]
 *  @param {function} [opts.onProgress]
 *  @returns {Promise<SubagentResult|SubagentError>} */
async function runSubagent(opts) {
  const agent = resolveAgent(opts.agentId);
  if (!agent) {
    return { error: 'Unknown agent: "' + opts.agentId + '". Available: ' + Object.keys(loadAgents()).join(', ') };
  }
  if (agent.mode !== 'subagent') {
    return { error: '"' + agent.name + '" is a primary agent — it cannot be delegated to. Use it directly (Tab / /' + agent.id + ').' };
  }
  const prompt = String(opts.prompt || '').trim();
  if (!prompt) return { error: 'task needs a non-empty prompt.' };

  const parent = opts.parentSession || null;
  const { Session } = require('./session');
  const child = new Session();
  child._isChild = true;
  child.agent = agent;
  if (parent) {
    child.config = {
      ...parent.config,
      model: { ...(parent.config.model || {}) },
      apiKeys: { ...(parent.config.apiKeys || {}) },
    };
  }
  if (agent.temperature != null) child.config.temperature = agent.temperature;

  // Per-agent / per-call model override ("provider/model-id" or bare model id
  // on the current provider).
  const spec = String(opts.model || agent.model || '');
  if (spec && spec.includes('/')) {
    const slash = spec.indexOf('/');
    const prov = spec.slice(0, slash);
    const mid = spec.slice(slash + 1);
    if (prov && mid) {
      try { child.provider.use(prov); } catch {}
      child.config.model[prov] = mid;
    }
  } else if (spec) {
    const prov = child.config.provider || child.provider.active?.name;
    if (prov) child.config.model[prov] = spec;
  }

  child._agentBlock = buildSubagentBlock(agent);

  if (opts.signal) {
    try { opts.signal.addEventListener('abort', () => child.interrupt()); } catch {}
  }

  const progress = (type, text) => {
    try {
      if (opts.onProgress) opts.onProgress({ id: agent.id, agent: agent.name, type, text });
    } catch {}
  };
  progress('status', 'started');

  const t0 = Date.now();
  const resp = await child.sendUserMessage(prompt, {
    onDelta: (t) => progress('delta', t),
    onReasoning: (t) => progress('reasoning', t),
    onTool: (name, inp) => progress('tool', name),
    onToolResult: (name, out) => progress('toolResult', name),
  });
  const durationMs = Date.now() - t0;
  progress('status', resp.interrupted ? 'interrupted' : 'done');

  if (parent) {
    parent.tokensIn += child.tokensIn;
    parent.tokensOut += child.tokensOut;
    parent.tokensUsed += child.tokensUsed;
    parent.sessionCost += child.sessionCost;
  }

  const content = resp.type === 'error'
    ? '[subagent error] ' + String(resp.content || '')
    : String(resp.content || '(no response)');
  return {
    agent: agent.name,
    id: agent.id,
    content: content.slice(0, 8000),
    tokensIn: child.tokensIn,
    tokensOut: child.tokensOut,
    costUsd: child.sessionCost,
    durationMs,
    interrupted: !!resp.interrupted,
  };
}

module.exports = {
  BUILTIN_AGENTS,
  loadAgents,
  resolveAgent,
  agentToolAllowed,
  filterToolDefs,
  buildAgentTurnBlock,
  buildSubagentBlock,
  runSubagent,
};
