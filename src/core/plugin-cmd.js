const { listSkills, installSkill, removeSkill } = require('../skills/skills-manager');
const { loadServers, addServer, removeServer, listServers, toggleServer, seedDefaults } = require('../mcp/mcp-manager');
const sessionStore = require('./session-store');

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
  const res = require('../skills/skills-manager').installSkill(target, name, { trust: trust ? (pendingTrust.get(target) || true) : false });
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
    '  /mcp add <name> <command> [args...]   Add a stdio server',
    '  /mcp remove <name>                    Remove a server',
    '  /mcp toggle <name>                    Enable/disable a server',
    '  /connectors     Browse hosting/cloud connectors (Supabase, Railway, Vercel, Netlify, Cloudflare, Next.js)',
    '',
    'Default servers (installed once, first launch):',
    '  enabled:  fetch, memory',
    '  disabled: time, sequential-thinking, github, filesystem, brave-search (toggle on after setup)',
    '',
    'Example: /mcp add github docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server',
    'Servers needing env vars (API keys) can be set by editing ~/.loom/mcp.json.',
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

function mcpAddCmd(args) {
  if (args.length < 2) return 'Usage: /mcp add <name> <command> [args...]';
  const name = args[0];
  const command = args[1];
  const mcpArgs = args.slice(2);
  const res = addServer(name, command, mcpArgs);
  if (res.error) return res.error;
  return 'Added MCP server "' + name + '" -> ' + command + ' ' + res.args.join(' ');
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

module.exports = {
  skillHelp,
  listSkillsText,
  installSkillCmd,
  removeSkillCmd,
  mcpHelp,
  listMcpText,
  mcpAddCmd,
  mcpRemoveCmd,
  mcpToggleCmd,
  diffCmd,
  debugCmd,
  editorCmd,
  exportCmd,
  sessionsCmd,
  forkCmd,
  defaultMcpInstall,
};