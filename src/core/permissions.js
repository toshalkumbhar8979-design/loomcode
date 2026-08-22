const path = require('path');
const os = require('os');

const ADMIN_PATTERNS = [
  { re: /\bsudo\b/, label: 'sudo detected' },
  { re: /\brunas\b/, label: 'runas/administrator detected' },
  { re: /\bdoas\b/, label: 'doas detected' },
  { re: /\bchmod\s+[0-7]/, label: 'chmod with octal mode' },
  { re: /\bchown\s+/, label: 'chown detected' },
  { re: /\bshutdown\b/, label: 'shutdown command' },
  { re: /\breboot\b/, label: 'reboot command' },
  { re: /\bnpm\s+(install|i)\s+-g\b/, label: 'npm global install' },
  { re: /\bkill\s+-9\b/, label: 'force kill (-9)' },
  { re: /\bmkfs\b/, label: 'make filesystem (mkfs)' },
  { re: /\bdd\s+if=/, label: 'disk destroy (dd)' },
];

const DANGER_PATTERNS = [
  { re: /\brm\s+-rf\b/, label: 'recursive force delete (rm -rf)' },
  { re: /\bgit\s+push\s+--force\b/, label: 'force push to git remote' },
  { re: /\bgit\s+reset\s+--hard\b/, label: 'hard git reset (destructive)' },
  { re: /\bdocker\s+(rmi|system prune)\b/, label: 'destructive docker command' },
  { re: /DROP\s+(TABLE|DATABASE)/i, label: 'SQL table/database drop' },
  { re: /\bscp\b.*\blocalhost\b|\bscp\b.*\/etc\//, label: 'potentially dangerous scp' },
];

// OpenCode-style permission keys and their defaults. Most tools default to
// allow; edit/task/skill/doom_loop/external_directory default to ask, and
// bash allows normal commands but STILL asks for dangerous ones (the
// ADMIN/DANGER heuristics below are enforced regardless of the tree, so
// "git push --force", "rm -rf", "sudo …", etc. always prompt unless the user
// saved an exact rule). read allows everything except .env files (denied by
// default — the built-in .*env rules below are part of the default tree, not
// user config).
const PERMISSION_KEYS = [
  'read', 'edit', 'glob', 'grep', 'bash', 'task', 'skill', 'lsp', 'question',
  'webfetch', 'websearch',
  'external_directory', 'doom_loop',
];

const DEFAULT_PERMISSIONS = {
  '*': 'allow',
  bash: 'allow',
  edit: 'ask',
  task: 'ask',
  skill: 'ask',
  question: 'ask',
  doom_loop: 'ask',
  external_directory: 'ask',
  read: {
    '*': 'allow',
    '*.env': 'deny',
    '*.env.*': 'deny',
    '*.env.example': 'allow',
  },
};

// Tools that write files map onto the "edit" permission (OpenCode semantics:
// edit covers edit, write and patch).
const TOOL_TO_PERMISSION = {
  read: 'read',
  edit: 'edit',
  write: 'edit',
  glob: 'glob',
  grep: 'grep',
  bash: 'bash',
  task: 'task',
  skill: 'skill',
  lsp: 'lsp',
  question: 'question',
  ask: 'question',
  webfetch: 'webfetch',
  websearch: 'websearch',
  todowrite: null,   // never prompts
  mcp: null,         // wired by the session (only the "add" action prompts)
};

function expandHome(p, home) {
  const h = home || os.homedir();
  if (p === '~') return h;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(h, p.slice(2));
  if (p.startsWith('$HOME/') || p.startsWith('$HOME\\')) return path.join(h, p.slice(6));
  return p;
}

// '*' matches any run of chars (including /), '?' matches exactly one; all
// other characters are literal. Case-insensitive on Windows paths.
function wildcardToRegExp(pattern) {
  const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const parts = [];
  for (const ch of String(pattern)) {
    if (ch === '*') parts.push('.*');
    else if (ch === '?') parts.push('.');
    else parts.push(esc(ch));
  }
  return new RegExp('^' + parts.join('') + '$', process.platform === 'win32' ? 'i' : '');
}

// Match `arg` against a permission node (string | object of pattern→action).
// Returns the action or null when nothing matched.
function matchNode(node, arg) {
  if (node == null) return null;
  if (typeof node === 'string') return normalizeAction(node);
  if (typeof node !== 'object') return null;
  let winner = null; // last match wins
  const a = String(arg ?? '');
  for (const [pat, action] of Object.entries(node)) {
    // Normalize the expanded pattern the same way args are normalized
    // (forward slashes) so ~/... patterns match on Windows too.
    const expanded = expandHome(pat).replace(/\\/g, '/');
    if (wildcardToRegExp(expanded).test(a)) winner = normalizeAction(action);
  }
  return winner;
}

function normalizeAction(a) {
  if (a === 'never') return 'deny'; // legacy popup value
  return a === 'allow' || a === 'ask' || a === 'deny' ? a : null;
}

// Normalize any path-like argument for matching: absolute, forward slashes.
function normPathArg(arg, cwd) {
  if (!arg) return '';
  let p = expandHome(String(arg));
  if (!path.isAbsolute(p)) p = path.resolve(cwd || process.cwd(), p);
  return p.replace(/\\/g, '/');
}

class PermissionManager {
  constructor() {
    this.sessionRules = new Map(); // legacy exact-command rules (popup picks)
    this.pendingRequest = null;
    this.onRuleChange = null;      // session wires this to persist          // popup choices into ~/.loom/config.json (config.permissionRules)
    this.config = null;            // loadConfig snapshot (config.permission, config.agent)
    this.agentId = null;           // current agent for agent-scoped rules
    this.auto = false;             // auto-approve mode (off by default)
    this.cwd = process.cwd();
  }

  loadRules(rules) {
    if (!rules || typeof rules !== 'object') return;
    for (const [key, value] of Object.entries(rules)) {
      const v = normalizeAction(value);
      if (v) this.sessionRules.set(key, v);
    }
  }

  loadConfig(cfg) {
    this.config = cfg || null;
  }

  setAgent(agentId) { this.agentId = agentId || null; }
  setAuto(on) { this.auto = !!on; }

  _match(cmd, patterns) {
    const lower = (cmd || '').toLowerCase();
    for (const p of patterns) if (p.re.test(lower)) return p.label;
    return null;
  }

  isAdmin(cmd) { return !!this._match(cmd, ADMIN_PATTERNS); }
  isDangerous(cmd) { return !!this._match(cmd, DANGER_PATTERNS) || this.isAdmin(cmd); }
  getDangerLabel(cmd) {
    return this._match(cmd, ADMIN_PATTERNS) || this._match(cmd, DANGER_PATTERNS) || 'dangerous command';
  }

  getRule(key) { return this.sessionRules.get(key); }

  setRule(key, value, persist) {
    this.sessionRules.set(key, value);
    if (persist && this.onRuleChange) this.onRuleChange(key, value);
  }

  clearRule(key) {
    this.sessionRules.delete(key);
    if (this.onRuleChange) this.onRuleChange(key, null);
  }

  checkRule(key) {
    if (this.sessionRules.has('*')) return this.sessionRules.get('*');
    if (this.sessionRules.has(key)) return this.sessionRules.get(key);
    return null;
  }

  // Legacy pre-OpenCode check: an exact command string. Kept for callers that
  // still think in commands (the bash session gate) — see resolve() for the
  // general tool layer.
  async check(cmd) {
    const rule = this.checkRule(cmd);
    if (rule) return rule === 'deny' ? 'deny' : rule;
    if (this.isDangerous(cmd)) return 'ask';
    return 'allow';
  }

  reset() { this.sessionRules.clear(); }

  // ── OpenCode-style resolution ──────────────────────────────────────────

  /**
   * Resolve the action for (toolName, arg) given the current agent, config and
   * session rules. arg is the command for bash, the file path for read/edit,
   * the agent id for task, the skill name for skill, etc. Returns
   * 'allow' | 'ask' | 'deny'.
   */
  resolve(toolName, arg) {
    const key = TOOL_TO_PERMISSION[toolName] !== undefined ? TOOL_TO_PERMISSION[toolName] : toolName;
    if (!key) return 'allow';

    // Safety heuristics always run for dangerous shell commands — even when
    // a rule would allow the rest (defense in depth; unavoidable on
    // "git push --force" unless the user explicitly disabled them).
    if (key === 'bash' && this.isDangerous(String(arg || ''))) {
      // An exact session rule overrides heuristics ("Always allow" picked in
      // the popup for this very command).
      const exact = this.sessionRules.get(String(arg || ''));
      if (exact === 'allow') return 'allow';
      if (exact === 'deny') return 'deny';
      return 'ask';
    }

    // 1. Legacy exact session rule (popup "Always allow"/"Never") — the
    //    strongest signal; the user picked it for this exact command/path.
    const exact = this.sessionRules.get(String(arg ?? ''));
    if (exact) return exact;
    if (key === 'bash' && this.sessionRules.has('*')) return this.sessionRules.get('*');

    const cfgPerm = this.config && this.config.permission;
    // 2. Agent-scoped rules take precedence over the global permission tree.
    const agentTree = this.agentId && this.config && this.config.agent && this.config.agent[this.agentId]
      ? this.config.agent[this.agentId].permission
      : null;
    if (agentTree) {
      const v = matchNode(agentTree[key] ?? agentTree['*'], arg);
      if (v) return v;
    }

    // 3. Global permission tree from config.permission.
    if (cfgPerm != null) {
      const v = matchNode(typeof cfgPerm === 'string' ? cfgPerm : (cfgPerm[key] ?? cfgPerm['*']), arg);
      if (v) return v;
    }

    // 4. Defaults.
    const def = DEFAULT_PERMISSIONS[key];
    const d = matchNode(def ?? DEFAULT_PERMISSIONS['*'], arg) ?? matchNode(DEFAULT_PERMISSIONS['*'], arg);
    return d || 'allow';
  }

  /**
   * External-directory check: resolvedPath is an absolute normalized path; if
   * it lies outside the session cwd, consult permission.external_directory
   * patterns (matched against the normalized absolute path). Returns
   * 'allow' when inside or a pattern allowed it, otherwise the rule's action
   * (default 'ask').
   */
  checkExternal(resolvedPath) {
    const cwd = (this.cwd || process.cwd()).replace(/\\/g, '/');
    const p = String(resolvedPath || '').replace(/\\/g, '/');
    if (!p || p === cwd || p.startsWith(cwd.replace(/\/+$/, '') + '/')) return 'allow';
    const rule = this.resolveKey('external_directory', p);
    return rule;
  }

  /**
   * Resolved rule for an arbitrary permission key (used by external_directory
   * and doom_loop which aren't tool names).
   */
  resolveKey(permKey, arg) {
    const cfgPerm = this.config && this.config.permission;
    const agentTree = this.agentId && this.config && this.config.agent && this.config.agent[this.agentId]
      ? this.config.agent[this.agentId].permission
      : null;
    if (agentTree) {
      const v = matchNode(agentTree[permKey] ?? agentTree['*'], arg);
      if (v) return v;
    }
    if (cfgPerm != null) {
      const v = matchNode(typeof cfgPerm === 'string' ? cfgPerm : (cfgPerm[permKey] ?? cfgPerm['*']), arg);
      if (v) return v;
    }
    const def = DEFAULT_PERMISSIONS[permKey];
    const d = matchNode(def ?? DEFAULT_PERMISSIONS['*'], arg) ?? matchNode(DEFAULT_PERMISSIONS['*'], arg);
    return d || 'allow';
  }

  /** The argument a permission key is matched against for a given tool call. */
  permissionArg(toolName, input, cwdOverride) {
    const cwd = cwdOverride || this.cwd || process.cwd();
    const inp = input || {};
    switch (toolName) {
      case 'bash': return String(inp.command ?? inp.args ?? '');
      case 'read': return normPathArg(inp.filePath || inp.path || '', cwd);
      case 'edit':
      case 'write': return normPathArg(inp.filePath || inp.path || '', cwd);
      case 'glob': return String(inp.pattern ?? '');
      case 'grep': return String(inp.pattern ?? '');
      case 'task': return String(inp.agent ?? inp.subagent ?? inp.agentId ?? '');
      case 'skill': return String(inp.name ?? inp.skill ?? '');
      case 'lsp': return String(inp.query ?? '');
      case 'question':
      case 'ask': return String(inp.question ?? inp.text ?? '');
      case 'webfetch': return String(inp.url ?? '');
      case 'websearch': return String(inp.query ?? '');
      default: return String(inp.command ?? inp.filePath ?? inp.path ?? inp.pattern ?? inp.url ?? '');
    }
  }
}

// Defense-in-depth label used by the tool layer: same heuristics as the
// permission manager, so tools can refuse destructive commands even when the
// session gate is bypassed (direct calls). Returns the label or null.
function commandRiskLabel(cmd) {
  const lower = (cmd || '').toLowerCase();
  for (const p of ADMIN_PATTERNS.concat(DANGER_PATTERNS)) {
    if (p.re.test(lower)) return p.label;
  }
  return null;
}

module.exports = {
}

module.exports = {
  PermissionManager, ADMIN_PATTERNS, DANGER_PATTERNS, commandRiskLabel,
  PERMISSION_KEYS, DEFAULT_PERMISSIONS, TOOL_TO_PERMISSION,
  expandHome, wildcardToRegExp, matchNode, normPathArg,
};
