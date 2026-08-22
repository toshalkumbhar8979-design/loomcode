const { listSkills, installSkill, removeSkill } = require('../skills/skills-manager');
const { loadServers, addServer, parseMcpAddArgs, removeServer, listServers, toggleServer, seedDefaults } = require('../mcp/mcp-manager');
const sessionStore = require('./session-store');

// Quote-aware CLI tokenizer for slash commands, so paths with spaces survive:
//   /mcp add stm32 -- "C:\stm32-mcp\.venv\Scripts\python.exe" -m stm32_mcp.server
/**
 * @param {string} s
 * @returns {string[]}
 */
function tokenizeCli(s) {
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function skillHelp() {
  return [
    'Skill commands:',
    '  /skills                    List installed skills',
    '  /skills install <dir|git>  Install a skill (local folder or git URL)',
    '  /skills install <git-url> --trust   Approve + install a remote skill (pinned to its commit)',
    '  /skills remove <name>      Uninstall a skill',
    '',
    'Skills live in ~/.loom/skills and are injected into the system prompt',
  ].join('\n');
}

function listSkillsText() {
  const skills = listSkills();
  if (!skills.length) return 'No skills installed yet. Use /skills install <dir|git-url>.\n\n' + skillHelp();
  const { loadConfig } = require('../config/settings');
  const disabled = (loadConfig().skillDisabled || []);
  const lines = ['Installed skills (' + skills.length + '):', ''];
  for (const s of skills) {
    const status = disabled.includes(s.name) ? 'OFF' : 'ON';
    lines.push('  [' + status + '] ' + s.name.padEnd(26) + ' [' + s.source + ']  ' + s.description);
  }
  lines.push('', 'Toggle via /skills modal, or add the name to config.json skillDisabled[].');
  return lines.join('\n');
}

// A trust approval must be bound to the exact commit that was shown in the
// block message — approving "the URL" again after the remote moved would
// bless content the user never reviewed. Remember url → commit from the last
// trustRequired response and require a matching --trust before installing.
const pendingTrust = new Map();

function installSkillCmd(args) {
  const rest = args.filter((a) => a !== '--trust' && a !== '-t');
  const trust = rest.length !== args.length;
  const target = rest[0];
  const name = rest[1];
  if (!target) return 'Usage: /skills install <folder-path|git-url> [name] [--trust]';
  const pending = trust ? pendingTrust.get(target) : undefined;
  const trustValue = typeof pending === 'string' ? pending : false;
  const res = require('../skills/skills-manager').installSkill(target, name, { trust: trustValue });
  if (res.error) {
    if (res.trustRequired) {
      pendingTrust.set(res.trustRequired.url, res.trustRequired.commit);
      const lines = [
        'Install blocked: ' + res.error + '.',
        '',
        'Remote skills run with full tool access, so the exact content must be',
        'reviewed and approved once. Approval is pinned to the commit hash.',
        '',
        '  source:  ' + res.trustRequired.url,
        '  commit:  ' + res.trustRequired.commit,
      ];
      if (res.trustRequired.previous) {
        lines.push(
          '',
          '  WARNING: this content differs from the approved version:',
          '    approved: ' + res.trustRequired.previous + ' (' + (res.trustRequired.approvedAt || '?') + ')',
          '    now:      ' + res.trustRequired.commit
        );
      }
      lines.push('', 'If you trust this source, approve this exact commit:');
      lines.push('  /skills install ' + res.trustRequired.url + ' --trust');
      return lines.join('\n');
    }
    pendingTrust.delete(target);
    return 'Install failed: ' + res.error;
  }
  pendingTrust.delete(target);
  return 'Installed skill "' + res.name + '" to ' + res.dir;
}

function removeSkillCmd(args) {
  const name = args[0];
  if (!name) return 'Usage: /skills remove <name>';
  const res = removeSkill(name);
  return res.error ? res.error : 'Removed skill: ' + res.removed;
}

function mcpHelp() {
  return [
    'MCP (Model Context Protocol) connector commands:',
    '  /mcp            List MCP servers & tools',
    '  /mcp add [-e KEY=V] <name> [--] <command> [args...]   Add a stdio server',
    '  /mcp remove <name>                    Remove a server',
    '  /mcp toggle <name>                    Enable/disable a server',
    '  /connectors     Browse hosting/cloud connectors (Supabase, Railway, Vercel, Netlify, Cloudflare, Next.js)',
    '',
    'Default servers (installed once, first launch):',
    '  enabled:  fetch, memory',
    '  disabled: time, sequential-thinking, github, filesystem, brave-search (toggle on after setup)',
    '',
    'Example (claude-compatible): /mcp add stm32 -- "C:\\stm32-mcp\\.venv\\Scripts\\python.exe" -m stm32_mcp.server',
    'Example with env: /mcp add -e BRAVE_API_KEY=x brave-search -- npx -y @modelcontextprotocol/server-brave-search',
    'The "--" separator is optional; quote any path with spaces. Env keys are usable as $KEY in args.',
    'In the /mcp and /connectors browsers, press A to add with the same one-liner syntax.',
  ].join('\n');
}

function listMcpText() {
  const servers = listServers();
  if (!servers.length) return 'No MCP servers configured. Use /mcp add <name> <command> [args].\n\n' + mcpHelp();
  const lines = ['MCP servers (' + servers.length + '):', ''];
  for (const s of servers) {
    lines.push('  ' + (s.enabled ? '[on] ' : '[off] ') + s.name + '  ->  ' + s.command + ' ' + s.args.join(' '));
  }
  lines.push('', 'Tools refresh on your next message. Use /mcp add, /mcp remove, /mcp toggle.');
  return lines.join('\n');
}

// Shared engine for /mcp add and the TUI one-line add modal. Takes the
// argv-level parse, resolves any $KEY placeholder in args from the -e env,
// wraps npx for Windows (cmd /c npx ...), persists, and returns a message.
function addServerFromArgv(argv) {
  const parsed = parseMcpAddArgs(argv);
  if ('error' in parsed) return parsed.error;
  const env = parsed.env || {};
  let cmd = parsed.command;
  let args = parsed.args.map(a =>
    typeof a === 'string' && a.startsWith('$') && env[a.slice(1)] !== undefined ? env[a.slice(1)] : a
  );
  if (process.platform === 'win32' && cmd === 'npx') { cmd = 'cmd'; args = ['/c', 'npx'].concat(args); }
  const res = addServer(parsed.name, cmd, args, Object.keys(env).length ? { env } : undefined);
  if (res.error) return res.error;
  let line = 'Added MCP server "' + parsed.name + '" -> ' + cmd + ' ' + args.join(' ');
  if (Object.keys(env).length) line += '  [env: ' + Object.keys(env).join(', ') + ']';
  return line;
}

function mcpAddCmd(args) {
  return addServerFromArgv(args);
}

// Same thing, from a single raw line (the TUI one-line add input). Forgiving
// of a leading "add" / "mcp add" prefix, and quote-aware via tokenizeCli.
function mcpAddLineCmd(line) {
  let argv = tokenizeCli(String(line || '').trim());
  if (argv[0] === 'add') argv = argv.slice(1);
  else if (argv[0] === 'mcp' && argv[1] === 'add') argv = argv.slice(2);
  return addServerFromArgv(argv);
}

function mcpRemoveCmd(args) {
  const name = args[0];
  if (!name) return 'Usage: /mcp remove <name>';
  const res = removeServer(name);
  return res.error ? res.error : 'Removed MCP server: ' + name;
}

function mcpToggleCmd(args) {
  const name = args[0];
  if (!name) return 'Usage: /mcp toggle <name>';
  const res = toggleServer(name);
  return res.error ? res.error : 'MCP server "' + name + '" now ' + (res.enabled ? 'enabled' : 'disabled');
}

function diffCmd() {
  const { execSync } = require('child_process');
  try {
    const stat = execSync('git diff --stat', { cwd: process.cwd(), encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    if (!stat) return 'No changes to show (clean working tree).';
    const full = execSync('git diff', { cwd: process.cwd(), encoding: 'utf8', timeout: 5000, maxBuffer: 500 * 1024, windowsHide: true }).trim();
    return '## Git Diff\n\n```\n' + full.slice(0, 8000) + '\n```';
  } catch {
    return 'Not a git repository or git is not available. Run in a git project directory.';
  }
}

function debugCmd() {
  const os = require('os');
  const c = require('../config/settings').loadConfig();
  const lines = [
    '=== Debug Info ===',
    'Node: ' + process.version + ' on ' + os.platform() + '-' + os.arch(),
    'CWD: ' + process.cwd(),
    'Config provider: ' + (c.provider || 'none'),
    'Config keys: ' + (c.apiKeys ? Object.keys(c.apiKeys).join(',') : 'none'),
    'Default provider: ' + (c.provider || 'none'),
    'Default model: ' + ((c.model && c.model[c.provider]) || 'none'),
  ];
  return lines.join('\n');
}

function editorCmd() {
  const path = require('path');
  const fs = require('fs');
  const { execSync } = require('child_process');
  const { MEMORY_TEMPLATE } = require('./session');
  const loomMd = path.join(process.cwd(), 'LOOM.md');
  if (!fs.existsSync(loomMd)) {
    fs.writeFileSync(loomMd, MEMORY_TEMPLATE);
  }
  try {
    if (process.platform === 'win32') {
      execSync('start "" "' + loomMd + '"', { stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') {
      execSync('open "' + loomMd + '"', { stdio: 'ignore' });
    } else {
      execSync('xdg-open "' + loomMd + '"', { stdio: 'ignore' });
    }
    return 'Opening LOOM.md in default editor...';
  } catch (e) {
    return 'Could not open editor: ' + e.message;
  }
}

function exportCmd(messages) {
  try {
    const file = sessionStore.exportChat({ messages: messages || [] }, 'md');
    return 'Exported chat to: ' + file;
  } catch (e) {
    return 'Export failed: ' + e.message;
  }
}

function sessionsCmd() {
  const list = sessionStore.listSessions();
  if (!list.length) return 'No saved sessions. Type /exit or /fork to save current.';
  const lines = ['Saved sessions (resume with: loom -s <id>):', ''];
  for (const s of list) {
    lines.push('  ' + s.id + '  [ ' + (s.createdAt || 'unknown') + ' ]  ' + s.messageCount + ' messages');
  }
  return lines.join('\n');
}

function forkCmd(session) {
  if (!session) return 'No active session to fork.';
  const dup = { conversationId: session.conversationId, messages: session.messages.slice(), config: session.config };
  const saved = sessionStore.saveSession(dup);
  return 'Forked session saved as: ' + saved.id + '\nResume with: loom -s ' + saved.id;
}

function defaultMcpInstall() {
  return seedDefaults();
}

// ─── Formatters / LSP (OpenCode-style, enabled via config.json) ───
const format = require('./format');
const lsp = require('./lsp');

function formatHelp() {
  return [
    'Formatter commands:',
    '  /format                   Show formatter status + built-ins',
    '  /format on                Enable all built-in formatters',
    '  /format off               Disable all formatters',
    '  /format <id> on|off       Toggle one formatter (prettier, gofmt, ruff, ...)',
    '',
    'Formatters run automatically in the background after the agent writes or',
    'edits a file. Custom formatters: config.json "formatter": { "<name>":',
    '{ "command": ["cmd", "$FILE"], "extensions": [".ext"] } }. The $FILE',
    'placeholder is replaced with the file path.',
  ].join('\n');
}

function formatCmd(args) {
  const { loadConfig, saveConfig } = require('../config/settings');
  const state = args[0];
  if (state === 'help') return formatHelp();
  let cfg = loadConfig();
  if (state === 'on') { cfg.formatter = true; saveConfig(cfg); return 'Formatters enabled (all built-ins).'; }
  if (state === 'off') { cfg.formatter = false; saveConfig(cfg); return 'Formatters disabled.'; }
  if (args.length === 2 && /^(on|off)$/.test(args[1])) {
    const id = args[0];
    if (!(id in format.DEFAULT_FORMATTERS)) {
      return 'Unknown formatter: ' + id + '. Known: ' + Object.keys(format.DEFAULT_FORMATTERS).join(', ');
    }
    const f = cfg.formatter === true ? {} : (cfg.formatter && typeof cfg.formatter === 'object' ? cfg.formatter : {});
    f[id] = { ...(f[id] || {}), disabled: args[1] === 'off' };
    cfg.formatter = f;
    saveConfig(cfg);
    return 'Formatter "' + id + '" now ' + (args[1] === 'on' ? 'enabled' : 'disabled') + '.';
  }
  return format.formatStatusLines().join('\n') + '\n\n' + formatHelp();
}

function lspHelp() {
  return [
    'LSP commands:',
    '  /lsp                   Show LSP server status + built-ins',
    '  /lsp on                Enable all built-in LSP servers',
    '  /lsp off               Disable LSP',
    '  /lsp check <file>      Run diagnostics on a file',
    '  /lsp <id> on|off       Toggle one server (typescript, pyright, ...)',
    '',
    'Custom servers: config.json "lsp": { "<name>": { "command": [...],',
    '"extensions": [".ext"] } }. The agent can also call the "lsp" tool.',
  ].join('\n');
}

function lspCmd(args) {
  const { loadConfig, saveConfig } = require('../config/settings');
  const state = args[0];
  if (state === 'help') return lspHelp();
  let cfg = loadConfig();
  if (state === 'on') { cfg.lsp = true; saveConfig(cfg); return 'LSP enabled (all built-in servers).'; }
  if (state === 'off') { cfg.lsp = false; saveConfig(cfg); return 'LSP disabled.'; }
  if (state === 'check') {
    const file = args[1];
    if (!file) return 'Usage: /lsp check <file>';
    return lsp.checkFile(file).then((res) => {
      if (!res.ok) return 'LSP check failed: ' + res.error;
      if (!res.diagnostics.length) return 'LSP (' + res.id + '): no diagnostics for ' + file;
      const errs = res.diagnostics.filter((d) => d.severity === 'error').length;
      const warns = res.diagnostics.filter((d) => d.severity === 'warning').length;
      const lines = res.diagnostics.map((d) =>
        (d.severity === 'error' ? 'E' : d.severity === 'warning' ? 'W' : 'I') +
        ' ' + (d.line + 1) + ':' + (d.character + 1) + ' [' + (d.source || res.id) + '] ' + d.message);
      return 'LSP (' + res.id + ') - ' + errs + ' error(s), ' + warns + ' warning(s):\n' + lines.join('\n');
    }).catch((e) => 'LSP check failed: ' + (e && e.message ? e.message : e));
  }
  if (args.length === 2 && /^(on|off)$/.test(args[1])) {
    const id = args[0];
    if (!(id in lsp.DEFAULT_LSP)) {
      return 'Unknown LSP server: ' + id + '. Known: ' + Object.keys(lsp.DEFAULT_LSP).join(', ');
    }
    const lv = cfg.lsp === true ? {} : (cfg.lsp && typeof cfg.lsp === 'object' ? cfg.lsp : {});
    lv[id] = { ...(lv[id] || {}), disabled: args[1] === 'off' };
    cfg.lsp = lv;
    saveConfig(cfg);
    return 'LSP server "' + id + '" now ' + (args[1] === 'on' ? 'enabled' : 'disabled') + '.';
  }
  return lsp.statusLines().join('\n') + '\n\n' + lspHelp();
}

module.exports = {
  tokenizeCli,
  skillHelp,
  listSkillsText,
  installSkillCmd,
  removeSkillCmd,
  mcpHelp,
  listMcpText,
  mcpAddCmd,
  mcpAddLineCmd,
  mcpRemoveCmd,
  mcpToggleCmd,
  diffCmd,
  debugCmd,
  editorCmd,
  exportCmd,
  sessionsCmd,
  forkCmd,
  defaultMcpInstall,
  formatHelp,
  formatCmd,
  lspHelp,
  lspCmd,
};