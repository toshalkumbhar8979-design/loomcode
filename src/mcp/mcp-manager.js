const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const LOOM_DIR = path.join(os.homedir(), '.loom');
const MCP_FILE = path.join(LOOM_DIR, 'mcp.json');

function loadServers() {
  if (!fs.existsSync(MCP_FILE)) return { servers: {}, seeded: false };
  try {
    const raw = fs.readFileSync(MCP_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { servers: data.servers || {}, seeded: data.seeded === true };
  } catch {
    return { servers: {}, seeded: false };
  }
}

function saveServers(data) {
  if (!fs.existsSync(LOOM_DIR)) fs.mkdirSync(LOOM_DIR, { recursive: true });
  fs.writeFileSync(MCP_FILE, JSON.stringify(data, null, 2));
}

function listServers() {
  const { servers } = loadServers();
  return Object.entries(servers).map(([name, cfg]) => ({
    name,
    command: cfg.command || '',
    args: cfg.args || [],
    enabled: cfg.enabled !== false,
  }));
}

function clearMcpCache() {
  try { require('./mcp-client').clearCache(); } catch {}
}

function addServer(name, command, args, opts) {
  if (!name || !command) return { error: 'Usage: /mcp add <name> <command> [args...]' };
  const data = loadServers();
  data.servers[name] = {
    name,
    command,
    args: args || [],
    enabled: !opts || opts.enabled !== false,
  };
  if (opts && opts.env) data.servers[name].env = opts.env;
  saveServers(data);
  clearMcpCache();
  return { added: name, command, args: data.servers[name].args };
}

function seedDefaults() {
  const data = loadServers();
  if (data.seeded) return { skipped: true };
  const isWin = process.platform === 'win32';
  // npx on Windows must be wrapped: cmd /c npx -y <pkg>
  const npx = (pkg) => (isWin ? { command: 'cmd', args: ['/c', 'npx', '-y', pkg] } : { command: 'npx', args: ['-y', pkg] });
  // Key-free servers — enabled out of the box. Minimal on purpose: models
  // speculate with thinking/time tools and waste turns, so they start disabled.
  const enabled = {
    fetch: npx('@modelcontextprotocol/server-fetch'),
    memory: npx('@modelcontextprotocol/server-memory'),
  };
  // Servers that need a key/token/path or invite speculative calls — installed
  // but disabled, toggle on after setup (/mcp toggle <name>).
  const optional = {
    time: npx('@modelcontextprotocol/server-time'),
    'sequential-thinking': npx('@modelcontextprotocol/server-sequential-thinking'),
    github: {
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    },
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
    },
    'brave-search': {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: { BRAVE_API_KEY: '' },
    },
  };
  const count = Object.keys(enabled).length + Object.keys(optional).length;
  for (const [name, cfg] of Object.entries(enabled)) {
    if (data.servers[name]) continue;
    data.servers[name] = Object.assign({ name, enabled: true }, cfg);
  }
  for (const [name, cfg] of Object.entries(optional)) {
    if (data.servers[name]) continue;
    data.servers[name] = Object.assign({ name, enabled: false }, cfg);
  }
  data.seeded = true;
  saveServers(data);
  clearMcpCache();
  return { seeded: count };
}

function removeServer(name) {
  const data = loadServers();
  if (!data.servers[name]) return { error: 'MCP server not found: ' + name };
  delete data.servers[name];
  saveServers(data);
  clearMcpCache();
  return { removed: name };
}

function toggleServer(name) {
  const data = loadServers();
  if (!data.servers[name]) return { error: 'MCP server not found: ' + name };
  data.servers[name].enabled = data.servers[name].enabled === false;
  saveServers(data);
  return { name, enabled: data.servers[name].enabled };
}

function stdioClient(cfg) {
  const child = spawn(cfg.command, cfg.args || [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, cfg.env || {}),
  });
  return child;
}

module.exports = {
  loadServers,
  saveServers,
  listServers,
  addServer,
  removeServer,
  toggleServer,
  stdioClient,
  seedDefaults,
  MCP_FILE,
};