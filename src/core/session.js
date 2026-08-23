const { ProviderRouter } = require('../providers');
const { getModelMeta } = require('../providers');
const { getToolDefinitions, getAllToolDefinitions, executeTool } = require('../tools');
const { agentToolAllowed, filterToolDefs } = require('./agents');
const { loadConfig, saveConfig } = require('../config/settings');
const { PermissionManager, normPathArg } = require('./permissions');
const { emit } = require('./events');
const hooks = require('./hooks');
const { match: matchSkill } = require('../skills/skill-matcher.js');

// Template written when LOOM.md is auto-created (or via /init).
const MEMORY_TEMPLATE =
  '# LOOM.md\n\n' +
  '## Project Overview\n<!-- Describe your project here -->\n\n' +
  '## Build Commands\n<!-- e.g., npm run build, make, etc. -->\n\n' +
  '## Test Commands\n<!-- e.g., npm test, pytest, etc. -->\n\n' +
  '## Code Style\n<!-- Coding conventions, linting rules, etc. -->\n\n' +
  '## Architecture\n<!-- Key architectural decisions and patterns -->\n';

// Compaction: run when the estimated context exceeds this fraction of the model window.
const COMPACT_DEFAULT_THRESHOLD = 0.75;
// Keep this many most-recent messages verbatim; summarize the rest.
const COMPACT_KEEP_MESSAGES = 8;
// Never compact conversations shorter than this.
const COMPACT_MIN_MESSAGES = 6;

/**
 * @typedef {Object} SpeedStats
 * @property {number} _turnStart
 * @property {number} _firstTokenAt
 * @property {number} _liveTokens
 * @property {number|null} lastLatencyMs
 * @property {number|null} lastTokensPerSec
 * @property {number|null} lastDurationMs
 * @property {number|null} lastTokens
 * @property {string} lastModel
 */

// Aborts surface as DOMException AbortError (anthropic fetch), APIUserAbortError
// (openai SDK), or wrapped messages containing "aborted". Never let an interrupt
// leak into a retry or an error bubble.
function isAbortError(err) {
  if (!err) return false;
  const name = String(err.name || err.error?.name || '');
  if (name === 'AbortError' || name === 'APIUserAbortError') return true;
  return /aborted|cancel(led|ed)/i.test(String(err.message || ''));
}

// Quota/credits exhausted errors — the model is out of tokens (free tiers,
// daily limits, billing caps). These are switch-to-another-model triggers.
function isQuotaError(err) {
  if (!err) return false;
  const status = Number(err.status || err.code || err.error?.status || 0);
  if (status === 402) return true;
  if (status === 429) return true;
  const msg = String(err.message || err.error?.message || err.body?.error?.message || '');
  return /quota|exhausted|insufficient.{0,20}(balance|credits|quota)|out of (tokens|credits|balance)|no (more )?(tokens|credits|balance)|rate.?limit|billing limit|payment required|max.?quota|limit reached/i.test(msg);
}

class Session {
  constructor() {
    this.config = loadConfig();
    this.provider = new ProviderRouter();
    this.provider.init();
    this.messages = [];
    this.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.turnCount = 0;
    this.tokensUsed = 0;
    this.tokensIn = 0;
    this.tokensOut = 0;
    this.sessionCost = 0;
    this.permissions = new PermissionManager();
    // OpenCode-style permission tree (config.permission + config.agent.<id>.permission).
    this.permissions.loadConfig(this.config);
    // Restore saved permission rules ("always allow"/"never") and persist new
    // ones chosen through the TUI permission popup.
    this.permissions.loadRules(this.config.permissionRules || {});
    this.permissions.onRuleChange = (key, value) => {
      try {
        const cfg = loadConfig();
        cfg.permissionRules = cfg.permissionRules || {};
        if (value == null) delete cfg.permissionRules[key];
        else cfg.permissionRules[key] = value;
        saveConfig(cfg);
        this.config = cfg;
      } catch {}
    };
    this.interrupted = false;
    this.abortController = null;
    this.mode = 'build';
    // Agent system (OpenCode-style): null = the mode's default primary agent;
    // a subagent def means THIS session (or this turn) is that agent and its
    // tool filter gates every tool call + the provider tool schema.
    this.agent = null;
    this._agentBlock = null;
    this._isChild = false;
    // Auto-create the project memory file (LOOM.md, like CLAUDE.md) on start.
    this.ensureMemoryFile();
    this.systemPrompt = this.buildSystemPrompt();
    this.todos = [];
    this.compactCount = 0;
    this.lastCompact = null;
    // Let the TUI render before starting MCP discovery. The first warm-up can
    // launch npx and download packages, so starting it in the constructor can
    // make startup appear frozen before the renderer gets its first frame.
    setTimeout(() => {
      try { require('../mcp/mcp-client').warm(); } catch {}
    }, 0);
  }

  setMode(mode) {
    if (mode === 'plan' || mode === 'chat' || mode === 'build') {
      if (this.mode === mode) return this.mode; // no rebuild if unchanged
      this.mode = mode;
    this.systemPrompt = this.buildSystemPrompt();
    this._skillBlock = ''; // per-turn skill injection (cleared on each send)
    this._skillMatcher = null; // testable override: function(text) -> [skill]
    }
    return this.mode;
  }

  // Switch provider+model: persist to config, record as recent, and refresh the
  // live router so the change applies immediately (no restart needed).
  setModel(provider, modelId) {
    const { loadConfig, saveConfig, recordModelUse } = require('../config/settings');
    const cfg = loadConfig();
    cfg.provider = provider;
    cfg.model = cfg.model || {};
    cfg.model[provider] = modelId;
    saveConfig(cfg);
    recordModelUse(provider, modelId);
    this.config = loadConfig();
    try { this.provider.init(provider); } catch {}
    emit('model:switch', { from: this.provider.active?.name || '', to: provider + '/' + modelId, reason: 'manual' });
    return this.provider.active;
  }

  // Try to switch to another usable model when the current one runs out of
  // tokens. Prefers recently-used models (except the failing one), then any
  // other provider that has a key and a different model. Returns the new
  // { provider, model } or null when nothing is available.
  autoSwitchModel(excludeProvider) {
    const { loadConfig, getRecentModels, hasApiKey } = require('../config/settings');
    const { PROVIDERS, PROVIDER_ORDER } = require('../providers/index.js');
    const cfg = loadConfig();
    const currentProvider = excludeProvider || cfg.provider;
    const currentModel = cfg.model?.[currentProvider];
    const tried = this._switchedModels || (this._switchedModels = []);
    const keyOf = (p, m) => p + '/' + m;

    // Budget level active: only switch to another model that matches the level.
    if (cfg.budgetLevel && cfg.budgetLevel !== 'auto') {
      const { pickModel } = require('./model-router');
      const picked = pickModel(cfg.budgetLevel, { tried });
      if (picked) {
        tried.push(keyOf(picked.provider, picked.model));
        emit('model:switch', { from: keyOf(currentProvider, currentModel), to: keyOf(picked.provider, picked.model), reason: 'quota', level: cfg.budgetLevel });
        return picked;
      }
    }

    const candidates = [];
    // 1. Recently used models, newest first, skipping the failing one.
    for (const r of getRecentModels()) {
      if (!r || !r.provider || !r.model) continue;
      if (keyOf(r.provider, r.model) === keyOf(currentProvider, currentModel)) continue;
      if (tried.includes(keyOf(r.provider, r.model))) continue;
      if (!hasApiKey(r.provider)) continue;
      candidates.push(r);
    }
    // 2. Any provider (except current) with a key and at least one model.
    if (!candidates.length) {
      for (const p of PROVIDER_ORDER) {
        if (p === currentProvider) continue;
        if (!hasApiKey(p)) continue;
        const mods = (PROVIDERS[p] && PROVIDERS[p].models) || [];
        if (mods.length && !tried.includes(keyOf(p, mods[0].id))) {
          candidates.push({ provider: p, model: mods[0].id });
        }
      }
    }
    const next = candidates[0];
    if (!next) return null;
    tried.push(keyOf(next.provider, next.model));
    this.setModel(next.provider, next.model);
    return { provider: next.provider, model: next.model };
  }

  buildSystemPrompt() {
    const os = require('os');
    const cwd = process.cwd();
    const memory = this.loadMemory();
    const plat = require('./platform').detect();
    const shell = plat.platform === 'win32' ? 'PowerShell 5.1' : 'bash/zsh';
    const hasWSL = plat.isWSL ? ' (WSL)' : '';
    return `You are Loom, a terminal coding agent: fast, terse, action-first.

## Environment
- Working directory: ${cwd}
- OS: ${plat.platform}-${plat.arch}${hasWSL}
- Shell: ${shell}
- Today's date: ${new Date().toLocaleDateString()}

## Memory (from LOOM.md)
${memory}

When the user states a durable preference, correction, or project fact ("we use bun", "never touch X", "deploy via Y"), persist it yourself: append ONE dated bullet under the "## Remembered" heading of ./LOOM.md using the edit tool (create the heading if missing). Keep it terse; don't ask permission for obvious preferences. Don't store secrets or one-off task details.

## Skills
${this.loadSkills()}

## Behavior
- Decide before acting: if the answer needs no external data, reply directly with ZERO tool calls. Simple or conversational questions are answered in one message, nothing runs.
- When tools ARE needed, act first and batch independent calls (e.g., read a file, grep a symbol, glob files at once). Never call tools speculatively or one at a time when they can be batched.
- Never call a time/date tool or a sequential-thinking tool — today's date is already in Environment, and you never need to "think" via a tool.
- Extended thinking is ON when your model supports it: reason BEFORE you act and re-evaluate AFTER every tool result. For complex or multi-step tasks, think hard at each stage (plan → act → check) instead of rushing to the answer — this is what separates a good result from a guessed one.
- Be terse in the final reply: say what changed and nothing else.
- Never narrate ("I will now read the file…"). Just call the tool.
- Prefer edits over full-file writes when the change is small.
- After writing code, run any test/bench command the user has relied on if one exists.

## Formatting
- ALWAYS reply in Markdown. The terminal renders it with colors, so make every reply structured and readable:
- Use **bold** for key terms and important results, \`inline code\` for file paths, symbols and commands, and fenced \`\`\` blocks for any code or config.
- Use ## headings and - bullet lists to organize longer replies; keep code inside fenced blocks, never inline dumps.
- Even one-line answers should still use markdown inline styling where it helps (e.g. "Done — **rewrote** \`src/app.ts\`: \`+12 -4\` lines, tests **pass**.").
- Never reply with a wall of plain unstyled text — the user's UI highlights markdown, and raw text renders as a single flat color.
- Multi-step work MUST be tracked with the todowrite tool (the UI mirrors it live in a sidebar and in the chat): call it up front with the task list, update item statuses (pending/in_progress/completed/cancelled) as you work, and call it one last time when done. Keep the list items terse ("Fix signup bug", not prose).

## Hard rules
- Batch independent tool calls into a single response; never send one tool call at a time.
- You may only issue multiple tool calls if none of them depends on another's result.
- Never guess a tool result — read it before your next call.
- Never commit/push without explicit instruction. Never print API keys.
- When a tool FAILS, do not retry the same call with the same arguments. After the first failure, change the approach: e.g. use read/grep to understand the state before trying an edit again, run a simpler variant of the command, or ask the user for the missing input (API key, path, permission). Three same-goal failures == stop and escalate: say what failed and suggest the fix instead of looping.
- For long outputs (links, large files), stream whatever the tool gave you in one message — do not emit partial/truncated responses piecemeal.

## Mode
You are in ${this.mode === 'build' ? 'BUILD MODE (full agent)' : this.mode === 'plan' ? 'PLAN MODE (read-only analysis)' : 'CHAT MODE (conversation only)'}.
${this.mode === 'build' ? `- You have all tools available: read, write, edit, bash, glob, grep, webfetch, and MCP tools.
- Inspect, edit, and verify the result yourself end-to-end.
- When done, summarize in 1-2 sentences.` : ''}${this.mode === 'plan' ? `- Read-only tools only: read, glob, grep, webfetch, todowrite. No MCP tools.
- Investigate thoroughly, then output a "## Plan" with ordered steps (exact file path + what changes each step makes). No narration.` : ''}${this.mode === 'chat' ? `- No tools available; answer conversationally.
- If the user wants code changes, tell them to switch to Build mode (Tab or /build) and resend.` : ''}${this.config.outputStyle ? `\n\n## Output style\n${this.config.outputStyle}` : ''}`;
  }

  // Create ./LOOM.md with a template when missing, so memory exists from the
  // first turn (Claude Code behavior). Disable with LOOM_MEM_AUTO=0 (tests).
  ensureMemoryFile() {
    if (process.env.LOOM_MEM_AUTO === '0') return null;
    try {
      const fs = require('fs');
      const path = require('path');
      const p = path.join(process.cwd(), 'LOOM.md');
      if (fs.existsSync(p)) return p;
      fs.writeFileSync(p, MEMORY_TEMPLATE);
      return p;
    } catch {
      return null;
    }
  }

  loadMemory() {
    // Layered memory with @imports (src/core/memory.js): global ~/.loom/LOOM.md
    // then project LOOM.md / .loom/LOOM.md, plus CLAUDE.md compatibility.
    const fs = require('fs');
    const path = require('path');
    const cwd = process.cwd();
    let memory = '';
    try { memory = require('./memory').loadMemory(); } catch {}
    for (const p of [path.join(cwd, '.claude', 'CLAUDE.md')]) {
      try {
        if (!memory && fs.existsSync(p)) {
          memory = '## From ' + path.basename(p) + '\n' + fs.readFileSync(p, 'utf8');
        }
      } catch {}
    }
    if (!memory) memory = '(No memory file found.)';
    return memory;
  }

  loadSkills() {
    try {
      const { listSkills } = require('../skills/skills-manager');
      const skills = listSkills();
      if (!skills.length) return '(No skills installed. Run /skills to see options.)';
      // Compact index only — full instructions are injected per-turn by the
      // skill matcher when the user's message matches a skill's keywords.
      return skills
        .map((s) => `- ${s.name} (${s.source}): ${s.description || 'no description'}`)
        .join('\n');
    } catch (e) {
      return '(Skills unavailable: ' + e.message + ')';
    }
  }

  interrupt() {
    this.interrupted = true;
    if (this.abortController) this.abortController.abort();
  }

  refresh() {
    this.config = loadConfig();
    this.provider.init();
  }

  async sendUserMessage(text, callbacks = {}, opts = {}) {
    // Optional agent turn ("@agent ..."): the MAIN session runs this one turn
    // as the named subagent — its tool filter gates tools, its prompt block is
    // appended, and the reply is the subagent's own answer.
    const wasAgent = this.agent;
    if (opts.agentId) {
      const { resolveAgent, buildAgentTurnBlock } = require('./agents');
      const agent = resolveAgent(opts.agentId);
      if (!agent) {
        return { type: 'error', content: `Unknown agent: ${opts.agentId}` };
      }
      if (agent.mode !== 'subagent') {
        return { type: 'error', content: `"${agent.name}" is a primary agent — use it directly (Tab / /${agent.id}).` };
      }
      this.agent = agent;
      this._agentBlock = buildAgentTurnBlock(agent);
      this.permissions.setAgent(agent.id);
    } else {
      this.permissions.setAgent(null);
    }

    // Config is loaded at construction; only provider pivots (setModel, /connect)
    // trigger a refresh. Re-reading disk and re-init'ing the provider on every
    // message was noticeable overhead per turn.
    this.interrupted = false;

    // Skill auto-trigger: if the user's message mentions a skill keyword
    // (e.g. "slice", "gcode", "cad"), load the matched skill's instructions
    // into the system prompt for this turn only. Zero LLM cost — pure
    // keyword matching on frontmatter.
    this._activeSkill = [];
    let skillBlock = '';
    const t0 = Date.now();
    // this._skillMatcher lets tests inject a fake matcher (avoid filesystem deps).
    const hits = (this._skillMatcher || matchSkill)(text)
      .filter(s => !(this.config.skillDisabled || []).includes(s.name));
    if (hits.length) {
      // hits from skill-matcher have shape {skill, score, matched}; test mocks may
      // return plain skill objects. Normalize to plain skill objects.
      this._activeSkill = hits.map(h => (h.skill || h).name); // newest-first for telemetry
      skillBlock = '\n\n[Active skill for this turn: ' + this._activeSkill.join(', ') + ']\n' +
        hits.map(h => (h.skill || h).instructions || (h.skill || h).description || '').join('\n\n') +
        '\n\nFollow these instructions precisely.';
      this._skillBlock = skillBlock;
      emit('trigger:skill', { skills: this._activeSkill, latencyMs: Date.now() - t0 });
    } else {
      this._skillBlock = '';
    }

    this.addMessage({ role: 'user', content: text });
    this.turnCount++;
    const turnAgent = this.agent?.id || null;
    emit('turn:start', { text, agent: turnAgent });
    let resp;
    try {
      resp = await this.runTurn(callbacks);
    } finally {
      // Restore the default primary agent after an agent-scoped turn.
      if (opts.agentId) {
        this.agent = wasAgent;
        this._agentBlock = null;
      }
    }
    // stop hook — fires when the whole turn ends (success, error, interrupt).
    try { await hooks.runHook('stop', { reason: resp?.type || 'end' }); } catch {}
    emit('turn:end', {
      text,
      type: resp?.type,
      cost: this.sessionCost,
      model: (this.provider.active?.name || '') + '/' + (this.config.model?.[this.provider.active?.name] || ''),
      level: this.config.budgetLevel || 'auto',
      skills: this._activeSkill || [],
      agent: turnAgent,
    });
    return resp;
  }

  addMessage(msg) {
    this.messages.push(msg);
  }

  // ─── Todo state ───
  // The todowrite tool persists into the session so the sidebar shows the
  // real, up-to-date task list instead of regex-scanning replies.
  setTodos(items) {
    const valid = ['pending', 'in_progress', 'completed', 'cancelled'];
    const out = [];
    const byContent = new Map();
    for (const t of Array.isArray(items) ? items : []) {
      const content = String(t?.content || '').trim();
      if (!content) continue;
      byContent.set(content, {
        content,
        status: valid.includes(t?.status) ? t.status : 'pending',
        priority: ['high', 'medium', 'low'].includes(t?.priority) ? t.priority : 'medium',
      });
    }
    // Map preserves first-insert order; later entries for the same content
    // override the status/priority (upsert semantics).
    for (const [content, t] of byContent) {
      out.push({
        content,
        status: t.status,
        priority: t.priority,
      });
    }
    this.todos = out;
    return out;
  }

  // ─── Compaction ───
  // Rough token estimate from message text (chars/4) — used to decide when
  // the context window is getting full.
  estimateTokens() {
    let chars = 0;
    for (const m of this.messages) {
      chars += String(m.content || '').length;
      for (const tc of m.toolCalls || []) chars += JSON.stringify(tc.input || {}).length;
    }
    return Math.ceil(chars / 4);
  }

  getContextWindow() {
    const meta = getModelMeta(this.provider.active?.name, this.config.model?.[this.provider.active?.name]);
    return meta?.context || 200000;
  }

  shouldCompact() {
    if (this.messages.length < COMPACT_MIN_MESSAGES) return false;
    const threshold = this.config.compactThreshold ?? COMPACT_DEFAULT_THRESHOLD;
    return this.estimateTokens() > this.getContextWindow() * threshold;
  }

  // Real compaction: summarize the older messages with the model and keep the
  // most recent COMPACT_KEEP_MESSAGES verbatim. Falls back to truncation when
  // no provider/key is available or the summary call fails.
  async compact(callbacks = {}) {
    if (this.messages.length <= COMPACT_KEEP_MESSAGES + 2) {
      return { compacted: false, reason: 'conversation too short', removed: 0, method: 'none' };
    }
    const keep = this.messages.slice(-COMPACT_KEEP_MESSAGES);
    const head = this.messages.slice(0, -COMPACT_KEEP_MESSAGES);
    const before = this.estimateTokens();

    let summary = null;
    const provider = this.provider.active && this.provider.providers[this.provider.active.name];
    if (provider) {
      try {
        const model = this.config.model?.[this.provider.active?.name];
        const resp = await provider.chat(
          head.concat([{
            role: 'user',
            content: 'Summarize the conversation so far between the user and an AI coding agent (Loom). ' +
              'Keep it factual and dense. Preserve: the task being worked on, every file path mentioned, ' +
              'all decisions made, any errors/tests, and unfinished steps. Use bullet points. ' +
              'End with a "## Next steps" section listing exactly what remains. Do not add anything beyond the summary.',
          }]),
          { model, maxTokens: 1500, temperature: 0.2, tools: [], system: 'You are a conversation summarizer. Output only the summary.' }
        );
        summary = resp?.content || null;
      } catch {
        summary = null;
      }
    }

    if (summary) {
      this.messages = [
        { role: 'system', content: '[Compacted — earlier conversation summarized. Ask for details if you need specifics.]\n\n' + summary.slice(0, 8000) },
        ...keep,
      ];
      this.compactCount = (this.compactCount || 0) + 1;
      this.lastCompact = { at: Date.now(), method: 'summary', removed: head.length };
      if (callbacks.onCompact) callbacks.onCompact({ method: 'summary', removed: head.length, summary });
      return { compacted: true, removed: head.length, method: 'summary', summary, tokensBefore: before, tokensAfter: this.estimateTokens() };
    }

    // Fallback: drop the oldest messages, keep the recent tail verbatim.
    this.messages = [
      { role: 'system', content: `[Compacted — ${head.length} earlier messages truncated. Ask for details if you need specifics.]` },
      ...keep,
    ];
    this.compactCount = (this.compactCount || 0) + 1;
    this.lastCompact = { at: Date.now(), method: 'truncate', removed: head.length };
    if (callbacks.onCompact) callbacks.onCompact({ method: 'truncate', removed: head.length, summary: null });
    return { compacted: true, removed: head.length, method: 'truncate', summary: null, tokensBefore: before, tokensAfter: this.estimateTokens() };
  }

  async runTurn(callbacks = {}) {
    let lastContent = '';
    // Doom-loop guard: three identical (tool, args) calls in a row = the model
    // is stuck; the permission.doom_loop rule (default ask) decides.
    /** @type {{ key: string|null, count: number }} */
    let doomRun = { key: null, count: 0 };
    // Accumulate the streamed text so an interrupt preserves partial output
    // instead of returning "(interrupted)" and losing what was already said.
    let streamed = '';
    // Reasoning deltas (o1/deepseek-r1-style extended thinking) streamed ahead
    // of the answer; surfaced to the UI so "+Thought" can show real content.
    let reasoning = '';
    // Per-turn speed telemetry: first-token latency and live tokens/sec.
    /** @type {SpeedStats} */
    const speed = this.speedStats || (this.speedStats = {
      _turnStart: 0, _firstTokenAt: 0, _liveTokens: 0,
      lastLatencyMs: null, lastTokensPerSec: null, lastDurationMs: null, lastTokens: null, lastModel: '',
    });
    const cb = callbacks.onDelta || callbacks.onReasoning
      ? { ...callbacks, onDelta: (txt) => {
          const now = Date.now();
          streamed += txt;
          speed._liveTokens += txt.length / 4;
          if (!speed._firstTokenAt) speed._firstTokenAt = now;
          if (callbacks.onDelta) callbacks.onDelta(txt);
        }, onReasoning: (txt) => {
          reasoning += txt;
          if (callbacks.onReasoning) callbacks.onReasoning(txt);
        } }
      : callbacks;

    // Auto-compact when the context window is getting full. The user's message
    // is already in this.messages, so the recent tail includes it verbatim.
    if (!this.interrupted && this.shouldCompact()) {
      try {
        const res = await this.compact(callbacks);
        if (res.compacted && callbacks.onAutoCompact) callbacks.onAutoCompact(res);
      } catch {}
    }

    const finishInterrupted = () => {
      this.interrupted = false;
      // Keep the partial assistant text in the conversation so the model can
      // resume the task on the next turn ("continue").
      if (streamed) {
        this.addMessage({
          role: 'assistant',
          content: streamed,
          interrupted: true,
        });
      }
      return { type: 'text', content: streamed || '(interrupted)', interrupted: true };
    };

    // No tool-use cap: the model decides when a turn is finished; the user can
    // always Esc-interrupt a runaway loop.
    let ranTools = false;
    let nudged = false;
    while (true) {
      if (this.interrupted) {
        return finishInterrupted();
      }

      let resp;
      speed._turnStart = Date.now();
      speed._firstTokenAt = 0;
      speed._liveTokens = 0;
      try {
        resp = await this.getResponse(cb);
      } catch (err) {
        if (isAbortError(err)) {
          return finishInterrupted();
        }
        // Model ran out of tokens → auto-switch to another model and retry once.
        if (isQuotaError(err)) {
          const fromKey = (this.provider.active?.name || '?') + '/' + (this.config.model?.[this.provider.active?.name] || '?');
          const switched = this.autoSwitchModel(this.provider.active?.name);
          if (switched) {
            if (callbacks.onModelSwitch) {
              callbacks.onModelSwitch({ from: fromKey, to: switched.provider + '/' + switched.model });
            }
            continue;
          }
        }
        return { type: 'error', content: err.message };
      }

      if (resp.interrupted) {
        return finishInterrupted();
      }
      if (resp.toolError) {
        return { type: 'error', content: resp.toolError };
      }
      // Explicit error responses (budget router hard-block, no active provider)
      // must reach the caller as errors, not as text.
      if (resp.type === 'error') {
        return resp;
      }

      if (resp.content) this.lastText = resp.content;

      // Finalize the speed snapshot for this model call (or tool step).
      if (resp && !resp.interrupted) {
        const dur = Date.now() - speed._turnStart;
        const tokens = (streamed.length || String(resp.content || '').length) / 4;
        speed.lastDurationMs = dur;
        speed.lastTokens = Math.round(tokens);
        speed.lastTokensPerSec = dur > 0 ? Math.round((tokens / dur) * 1000) : 0;
        speed.lastLatencyMs = speed._firstTokenAt ? speed._firstTokenAt - speed._turnStart : dur;
        speed.lastModel = (this.provider.active?.name || '') + '/' + (this.config.model?.[this.provider.active?.name] || '');
      }

      // Normalize: assistant message + toolCalls already appended by getResponse
      const toolCalls = resp.toolCalls || [];

      if (!toolCalls.length) {
        const text = String(resp.content || '');
        // Silent-stop guard: models occasionally end a turn with an EMPTY
        // reply right after running tools (truncation / provider hiccup),
        // which reads to the user like "the agent just stopped". One
        // automatic continuation instead of dead-ending with '(no response)'.
        if (!text.trim() && ranTools && !nudged && !this.interrupted) {
          nudged = true;
          this.addMessage({ role: 'user', content: '(your last reply was empty — continue where you left off and finish the task)' });
          continue;
        }
        return { type: 'text', content: text || '(no response)' };
      }
      ranTools = true;

      // Execute independent tool calls in parallel; results are appended in the
      // original call order so the conversation history stays deterministic.
      const outcomes = await Promise.all(toolCalls.map(async (tc) => {
        if (callbacks.onTool) callbacks.onTool(tc.name, tc.input, tc.id);

        // Doom-loop guard: three identical (tool, args) calls in a row means
        // the model is stuck repeating itself. The permission.doom_loop rule
        // (default ask) decides whether to allow the third one.
        const doomKey = tc.name + ':' + JSON.stringify(tc.input || {});
        if (doomRun.key === doomKey) doomRun.count++;
        else { doomRun.key = doomKey; doomRun.count = 1; }
        if (doomRun.count === 3) {
          const dAction = this.permissions.resolveKey('doom_loop', doomKey);
          if (dAction === 'deny') {
            return { tc, outcome: { error: 'Doom-loop detected: ' + tc.name + ' called 3 times with identical input. Permission denied.' } };
          }
          if (dAction === 'ask' && !this.permissions.auto && callbacks.onPermissionRequest) {
            const res = await callbacks.onPermissionRequest(tc.name, String(doomKey), 'repeated identical call (doom loop)');
            const approved = res && typeof res === 'object' ? !!res.approved : !!res;
            if (!approved) {
              return { tc, outcome: { error: 'Doom-loop detected: ' + tc.name + ' called 3 times with identical input.' } };
            }
          }
        }

        // Agent gate (defense in depth — the schema is filtered in getResponse
        // too): a subagent can never call a tool outside its agent's list.
        if (this.agent && !agentToolAllowed(this.agent, tc.name)) {
          return { tc, outcome: { error: `Tool "${tc.name}" is not available to the ${this.agent.name} agent.` } };
        }

        // OpenCode-style permission gate: every named tool resolves through
        // config.permission (+ config.agent.<agent>.permission) with
        // wildcard patterns and the last matching rule winning. ask'able
        // results flow through the TUI popup; doom_loop/external_directory
        // are checked separately where they apply.
        const permKey = { read:'read', edit:'edit', write:'edit', glob:'glob', grep:'grep', bash:'bash',
                          task:'task', skill:'skill', lsp:'lsp', question:'question', ask:'question', webfetch:'webfetch',
                          websearch:'websearch' }[tc.name];
        const isMcpAdd = tc.name === 'mcp' && tc.input && tc.input.action === 'add';
        if (permKey || isMcpAdd) {
          const arg = this.permissions.permissionArg(tc.name, tc.input || {});
          let action = this.permissions.resolve(tc.name, arg);
          // mcp add spawns arbitrary stdio servers with optional env secrets —
          // always ask unless the user saved a rule for the exact command.
          if (isMcpAdd && action === 'allow' && !this.permissions.checkRule(arg)) action = 'ask';
          // External path beyond the working dir? Ask/deny via
          // permission.external_directory, matched against the absolute path.
          if (action === 'allow' && (permKey === 'read' || permKey === 'edit' || permKey === 'glob' || permKey === 'grep') && /[/\\]/.test(arg)) {
            const ext = this.permissions.checkExternal(normPathArg(arg, process.cwd()));
            if (ext !== 'allow') action = ext;
          }
          if (action === 'deny') {
            return { tc, outcome: { error: `Permission denied: ${tc.name} (${permKey || 'mcp add'}).` } };
          }
          if (action === 'ask') {
            if (this.permissions.auto) {
              // Auto mode: only explicit denies are enforced; asks auto-approve.
            } else if (callbacks.onPermissionRequest) {
              const label = this.permissions.getDangerLabel(arg);
              const res = await callbacks.onPermissionRequest(tc.name, arg, label, (tc.input || {}).options);
              // The ask tool is a QUESTION, not a permission: the popup's
              // answer comes back in res.note and becomes the tool result so
              // the model can react to what the user actually said.
              if (tc.name === 'ask') {
                const ans = res && typeof res === 'object' ? (res.note || '') : '';
                if (!ans) return { tc, outcome: { error: 'No answer given.' } };
                return { tc, outcome: { result: ans } };
              }
              const approved = res && typeof res === 'object' ? !!res.approved : !!res;
              if (!approved) {
                const note = res && typeof res === 'object' && res.note ? ' ' + res.note : '';
                return { tc, outcome: { error: 'Permission denied.' + note } };
              }
            } else {
              return { tc, outcome: { error: 'Permission denied — no prompt available.' } };
            }
          }
        }

        // The permission gate above is the interactive check; mark the command
        // as approved so the tool-layer safety filter doesn't double-block
        // commands the user explicitly allowed.
        const input = (tc.name === 'bash' || isMcpAdd) ? { ...tc.input, _approved: true } : tc.input;
        // preToolUse hook: a user-configured command may veto this call.
        try {
          const gate = await hooks.runHook('preToolUse', { tool: tc.name, input: tc.input });
          if (gate.blocked) return { tc, outcome: { error: 'Blocked by preToolUse hook.' + (gate.reason ? ' ' + gate.reason : '') } };
        } catch {}
        const outcome = await executeTool(tc.name, input, this.mode, {
          parentSession: this,
          signal: this.abortController ? this.abortController.signal : null,
          progress: (ev) => {
            // Subagent progress (task tool) — surfaced to the TUI so the live
            // delegation panel can stream deltas, tool calls and status.
            try { if (callbacks.onSubagent) callbacks.onSubagent(ev); } catch {}
          },
          stream: (chunk, kind) => {
            // Live terminal output (bash tool) — relayed to the TUI so the
            // chat can stream a growing output block while the command runs.
            try { if (callbacks.onToolOutput) callbacks.onToolOutput(tc, chunk, kind); } catch {}
          },
        });
        // postToolUse hook (informational — never blocks).
        try { await hooks.runHook('postToolUse', { tool: tc.name, input: tc.input }); } catch {}
        return { tc, outcome };
      }));

      for (const { tc, outcome } of outcomes) {
        const text = outcome.error ? `Error: ${outcome.error}` : String(outcome.result ?? '');
        this.addMessage({ role: 'tool', toolCallId: tc.id, content: text });
        // Persist real todo state when the model uses the todowrite tool.
        if (tc.name === 'todowrite' && !outcome.error) {
          this.setTodos(tc.input && tc.input.todos);
          // Notify observers (sidebar, etc.) over the tiny event bus — the TUI
          // subscribes once and the panel updates without a re-render cycle.
          try { emit('todos:changed', this.todos); } catch {}
        }
        if (callbacks.onToolResult) callbacks.onToolResult(tc.name, outcome, tc.input, tc.id);
      }
    }
  }

  async getResponse(callbacks) {
    const tools = await getAllToolDefinitions(this.mode);
    // Agent-scoped turns (delegation) see only their agent's tool list.
    const toolDefs = this.agent ? filterToolDefs(this.agent, tools) : tools;

    // Budget router: when a level is active (free/cheap/best), pick the model
    // for THIS call without rewriting the user's saved provider/model. "Free"
    // hard-blocks paid models — no key for a free model means no call.
    const budgetLevel = this.config.budgetLevel;
    if (budgetLevel && budgetLevel !== 'auto') {
      const { pickModel } = require('./model-router');
      const picked = pickModel(budgetLevel, { tried: this._switchedModels || [] });
      if (!picked) {
        return {
          type: 'error',
          content: `No ${budgetLevel}-level model available. Add a key for a provider with ${budgetLevel} models (/connect), or switch /budget auto.`,
        };
      }
      if (this.provider.active?.name !== picked.provider) {
        this.provider.use(picked.provider);
        const { recordModelUse } = require('../config/settings');
        recordModelUse(picked.provider, picked.model);
      }
      this.config.model = this.config.model || {};
      this.config.model[picked.provider] = picked.model;
      this.lastPickedModel = picked;
    }

    const provider = this.provider.active && this.provider.providers[this.provider.active.name];
    if (!provider) {
      return { type: 'error', content: 'No active provider. Run /connect.' };
    }

    const model = this.config.model?.[this.provider.active?.name];

    // Spending governor: once the month's cost reaches the cap, paid turns are
    // hard-blocked. Free models stay allowed — /budget free is the escape
    // hatch. An explicit one-shot confirmation (/budget override) lets exactly
    // one paid turn through before blocking again.
    const { budgetStatus, consumeOverride, formatUsd } = require('./usage');
    const spend = budgetStatus();
    if (spend.over) {
      const { getModelMeta } = require('../providers/index.js');
      const meta = getModelMeta(this.provider.active?.name, model);
      const isFree = !meta || ((meta.priceIn || 0) === 0 && (meta.priceOut || 0) === 0);
      if (!isFree && !spend.overrideUsed) {
        return {
          type: 'error',
          content: `Monthly budget reached — ${formatUsd(spend.monthCostUsd)} of ${formatUsd(spend.budgetUsd)} spent. Run /usage, switch /budget free (all-free routing), raise the cap with /budget <dollars>, or confirm exactly one paid turn with /budget override.`,
        };
      }
      if (!isFree && spend.overrideUsed) {
        consumeOverride();
      }
    }

    const opts = {
      model,
      maxTokens: this.config.maxTokens || 8192,
      temperature: this.config.temperature ?? 0.7,
      tools: toolDefs,
      system: this.systemPrompt + (this._skillBlock || '') + (this._agentBlock || ''),
      signal: this.abortController?.signal,
      // Extended thinking: models tagged 'reasoning' reason BEFORE every
      // reply — including after each tool result — so complex tasks get
      // multiple thinking passes (opencode-style), not just the first one.
      // /think off|low|medium|high overrides: 'off' disables reasoning,
      // levels set an explicit budget_tokens for providers that take one.
      reasoning: (() => {
        if (this.config.thinkLevel === 'off') return false;
        const { getModelMeta } = require('../providers/index.js');
        const meta = getModelMeta(this.provider.active?.name, model);
        return !!(meta && meta.tags && meta.tags.includes('reasoning'));
      })(),
      thinkingBudget: ({ low: 2048, medium: 8192, high: 16384 })[this.config.thinkLevel] || undefined,
    };

    this.abortController = new AbortController();
    opts.signal = this.abortController.signal;

    let resp;
    if (callbacks.onDelta || callbacks.onReasoning) {
      resp = await provider.stream(this.messages, opts, callbacks.onDelta, callbacks.onReasoning);
    } else {
      resp = await provider.chat(this.messages, opts);
    }

    if (this.interrupted || (opts.signal && opts.signal.aborted)) {
      return { interrupted: true };
    }

    if (resp.usage) {
      this.tokensUsed += (resp.usage.totalTokens || resp.usage.total_tokens || 0);
    }

    this.addMessage({ role: 'assistant', content: resp.content || '', toolCalls: resp.toolCalls, reasoning: resp.reasoning || '' });
    this.recordUsage(resp.usage, model, this.provider.active?.name);
    return resp;
  }

  // Normalize provider usage (OpenAI: prompt_tokens/completion_tokens, Anthropic: input_tokens/output_tokens)
  // into input/output counts, then add them to the session counters and the persistent lifetime tracker.
  recordUsage(usage, modelId, providerName) {
    if (!usage) return;
    const input = usage.prompt_tokens || usage.input_tokens || usage.promptTokenCount || 0;
    const output = usage.completion_tokens || usage.output_tokens || usage.candidatesTokenCount || 0;
    const total = usage.total_tokens || usage.totalTokens || (input + output);
    if (!input && !output && !total) return;

    this.tokensIn += input;
    this.tokensOut += output;
    this.tokensUsed += total;

    const { getModelMeta } = require('../providers');
    const meta = getModelMeta(providerName, modelId);
    let cost = 0;
    if (meta && (meta.priceIn || meta.priceOut)) {
      cost = (input / 1e6) * (meta.priceIn || 0) + (output / 1e6) * (meta.priceOut || 0);
      this.sessionCost += cost;
    }
    const { recordUsage: persist } = require('./usage');
    persist({ inputTokens: input, outputTokens: output, costUsd: cost });
  }

  // Live + last-turn speed snapshot for the sidebar (tokens/sec, first-token
  // latency). nulls until the first streamed delta.
  getSpeed() {
    /** @type {SpeedStats} */
    const s = this.speedStats || (this.speedStats = {
      _turnStart: 0, _firstTokenAt: 0, _liveTokens: 0,
      lastLatencyMs: null, lastTokensPerSec: null, lastDurationMs: null, lastTokens: null, lastModel: '',
    });
    const now = Date.now();
    const elapsed = now - s._turnStart;
    const liveTps = elapsed > 0 && s._liveTokens > 0 ? Math.round((s._liveTokens / elapsed) * 1000) : 0;
    return {
      live: {
        elapsedMs: elapsed,
        firstTokenMs: s._firstTokenAt ? s._firstTokenAt - s._turnStart : null,
        tokensPerSec: liveTps,
      },
      last: {
        latencyMs: s.lastLatencyMs,
        tokensPerSec: s.lastTokensPerSec,
        durationMs: s.lastDurationMs,
        tokens: s.lastTokens,
        model: s.lastModel,
      },
    };
  }

  reset() {
    this.messages = [];
    this.turnCount = 0;
    this.tokensUsed = 0;
    this.tokensIn = 0;
    this.tokensOut = 0;
    this.sessionCost = 0;
    this.todos = [];
    this.compactCount = 0;
    this.lastCompact = null;
    this.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.speedStats = null;
  }
}

module.exports = { Session, MEMORY_TEMPLATE, isQuotaError, isAbortError };