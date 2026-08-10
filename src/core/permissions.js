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

class PermissionManager {
  constructor() {
    this.sessionRules = new Map();
    this.pendingRequest = null;
    // Hook fired when a rule is persisted (wired up by the session to save
    // "always allow"/"never" choices into ~/.loom/config.json).
    this.onRuleChange = null;
  }

  // Import previously-saved rules (from config.permissionRules).
  loadRules(rules) {
    if (!rules || typeof rules !== 'object') return;
    for (const [key, value] of Object.entries(rules)) {
      if (value === 'allow' || value === 'never') this.sessionRules.set(key, value);
    }
  }

  _match(cmd, patterns) {
    const lower = (cmd || '').toLowerCase();
    for (const p of patterns) {
      if (p.re.test(lower)) return p.label;
    }
    return null;
  }

  isAdmin(cmd) {
    return !!this._match(cmd, ADMIN_PATTERNS);
  }

  isDangerous(cmd) {
    return !!this._match(cmd, DANGER_PATTERNS) || this.isAdmin(cmd);
  }

  getDangerLabel(cmd) {
    return this._match(cmd, ADMIN_PATTERNS) || this._match(cmd, DANGER_PATTERNS) || 'dangerous command';
  }

  getRule(key) {
    return this.sessionRules.get(key);
  }

  setRule(key, value, persist) {
    this.sessionRules.set(key, value);
    if (persist && this.onRuleChange) this.onRuleChange(key, value);
  }

  // Remove a saved rule (by exact command, or '*' for the catch-all).
  clearRule(key) {
    this.sessionRules.delete(key);
    if (this.onRuleChange) this.onRuleChange(key, null);
  }

  checkRule(key) {
    if (this.sessionRules.has('*')) return this.sessionRules.get('*');
    if (this.sessionRules.has(key)) return this.sessionRules.get(key);
    return null;
  }

  async check(cmd) {
    // Saved rules (exact command or '*') win over heuristics — "Always allow"
    // must be able to bypass admin/danger detection, and "Never" must hold.
    const rule = this.checkRule(cmd);
    if (rule) return rule;

    if (this.isDangerous(cmd)) return 'ask';

    return 'allow';
  }

  reset() {
    this.sessionRules.clear();
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

module.exports = { PermissionManager, ADMIN_PATTERNS, DANGER_PATTERNS, commandRiskLabel };