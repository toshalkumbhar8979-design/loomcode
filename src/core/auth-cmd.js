const { login } = require('../auth/login');
const store = require('../auth/store');
const { normalizeProviderId, getAuthProvider } = require('../auth/providers');
const { loadConfig, saveConfig } = require('../config/settings');
const { PROVIDERS, ensureRegistry, mergeRegistry } = require('../providers');

function usage() {
  return [
    'Usage: loom auth [command]',
    '',
    '  loom auth                    Add a credential (interactive menu)',
    '  loom auth login [provider]   Sign in to a provider',
    '  loom auth list               List stored credentials',
    '  loom auth status             Show the active provider',
    '  loom auth logout <provider>  Remove one credential',
    '  loom auth logout --all       Remove every stored credential',
    '',
    'Login options:',
    '  --method <id>                Force a method (api, chatgpt, oauth, device)',
    '  --no-browser                 Print the URL instead of opening a browser',
    '  --key-stdin                  Read an API key from stdin',
  ].join('\n');
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function expiryText(cred) {
  if (cred.type !== 'oauth') return '';
  if (!cred.expiresAt) return 'session';
  const left = Number(cred.expiresAt) - Date.now();
  if (left <= 0) return 'expired';
  const mins = Math.round(left / 60000);
  if (mins < 90) return 'in ' + mins + 'm';
  return 'in ' + Math.round(mins / 60) + 'h';
}

function preferredModel(provider, method) {
  const list = (PROVIDERS[provider] && PROVIDERS[provider].models) || [];
  const ids = new Set(list.map((m) => m.id));
  const preferred = provider === 'openai' && method === 'chatgpt'
    ? ['gpt-5.5', 'gpt-5.4', 'gpt-5.2-codex', 'gpt-5.1-codex']
    : provider === 'github-copilot'
      ? ['gpt-5.4', 'gpt-5.5', 'claude-sonnet-5', 'gpt-4.1']
      : provider === 'google'
        ? ['gemini-2.5-flash', 'gemini-2.5-pro']
        : provider === 'anthropic'
          ? ['claude-sonnet-5-5', 'claude-sonnet-5']
          : provider === 'openrouter'
            ? ['anthropic/claude-sonnet-5.5']
            : [];
  for (const id of preferred) {
    if (ids.has(id)) return id;
  }
  return list[0] ? list[0].id : null;
}

async function activate(result) {
  const provider = result.provider;
  // Signing in should never wait on the models.dev catalog up front. Only a
  // registry-only provider needs it to pick a default model, and even then it
  // gets a short leash so a slow network cannot make login look frozen.
  if (!PROVIDERS[provider] || !PROVIDERS[provider].models || !PROVIDERS[provider].models.length) {
    try { await ensureRegistry(false, 6000); mergeRegistry(); } catch {}
  }
  const config = loadConfig();
  config.provider = provider;
  config.model = config.model || {};
  const reg = PROVIDERS[provider];
  const current = config.model[provider];
  const valid = reg && reg.models && reg.models.some((m) => m.id === current);
  if (!valid) {
    const next = preferredModel(provider, result.method);
    if (next) config.model[provider] = next;
  }
  saveConfig(config);
  const label = result.credential && (result.credential.email || result.credential.label);
  console.log('Signed in to ' + result.label + (label ? ' (' + label + ')' : '') + '.');
  console.log('Active provider: ' + provider + (config.model[provider] ? ' - model ' + config.model[provider] : ''));
  console.log('Try: loom "hello"');
}

function parseLoginArgs(args) {
  const out = { provider: null, method: null, noBrowser: false, keyStdin: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-browser' || arg === '--headless') out.noBrowser = true;
    else if (arg === '--key-stdin') out.keyStdin = true;
    else if (arg === '--method') out.method = args[++i] || null;
    else if (arg.startsWith('--method=')) out.method = arg.slice('--method='.length);
    else if (!out.provider && !arg.startsWith('-')) out.provider = arg;
  }
  return out;
}

async function loginCmd(args) {
  const opts = parseLoginArgs(args);
  if (!opts.provider && !process.stdin.isTTY) {
    throw new Error('No provider supplied. Use "loom auth login <provider>".');
  }
  let apiKey = null;
  if (opts.keyStdin) {
    apiKey = await readStdin();
    if (!apiKey) throw new Error('No API key received on stdin.');
  } else if (process.env.LOOM_AUTH_API_KEY) {
    apiKey = process.env.LOOM_AUTH_API_KEY;
  }
  const result = await login(opts.provider, {
    method: opts.method,
    noBrowser: opts.noBrowser,
    apiKey: apiKey || undefined,
  });
  if (!result) {
    console.log('Sign-in cancelled.');
    return;
  }
  await activate(result);
}

function listCmd() {
  let credentials;
  try {
    credentials = store.listCredentials();
  } catch (err) {
    throw new Error(err && err.message ? err.message : String(err));
  }
  if (!credentials.length) {
    console.log('No stored credentials. Run "loom auth" to add one.');
    return;
  }
  console.log('');
  console.log('Provider'.padEnd(18) + 'Method'.padEnd(12) + 'Account'.padEnd(28) + 'Fingerprint'.padEnd(14) + 'Expires');
  console.log('-'.repeat(82));
  for (const cred of credentials) {
    const provider = String(cred.provider || '').padEnd(18);
    const method = String(cred.method || '').padEnd(12);
    const account = String(cred.email || cred.label || '').slice(0, 26).padEnd(28);
    const fingerprint = String(cred.fingerprint || '').padEnd(14);
    console.log(provider + method + account + fingerprint + expiryText(cred));
  }
  console.log('');
}

function statusCmd() {
  const config = loadConfig();
  const provider = config.provider || 'anthropic';
  let cred = null;
  try { cred = store.getCredential(provider); } catch (err) {
    console.log('Auth vault: ' + (err && err.message ? err.message : 'unavailable'));
  }
  console.log('Active provider: ' + provider);
  console.log('Model: ' + (config.model?.[provider] || 'default'));
  if (cred) {
    console.log('Credential: ' + cred.method + (cred.email ? ' (' + cred.email + ')' : '') + ' · ' + expiryText(cred));
  } else {
    console.log('Credential: none in the auth vault');
  }
}

function logoutCmd(args) {
  const target = args.find((a) => !a.startsWith('-'));
  if (args.includes('--all') || target === 'all') {
    const count = store.deleteAllCredentials();
    const config = loadConfig();
    if (config.provider) {
      config.provider = '';
      saveConfig(config);
    }
    console.log('Removed ' + count + ' stored credential' + (count === 1 ? '' : 's') + '.');
    return;
  }
  if (!target) throw new Error('Specify a provider or use --all.');
  const provider = normalizeProviderId(target);
  const removed = store.deleteCredential(provider);
  const config = loadConfig();
  if (removed && config.provider === provider) {
    config.provider = '';
    saveConfig(config);
  }
  console.log(removed ? 'Removed the ' + provider + ' credential.' : 'No credential stored for ' + provider + '.');
}

async function authCmd(args) {
  const command = (args[0] || '').toLowerCase();
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(usage());
    return;
  }
  if (!command || command === 'login' || command === 'add') {
    return loginCmd(rest);
  }
  if (command === 'list' || command === 'ls') return listCmd();
  if (command === 'status') return statusCmd();
  if (command === 'logout' || command === 'remove' || command === 'delete') return logoutCmd(rest);
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  if (command === 'providers') {
    const { getMenuProviders } = require('../auth/providers');
    for (const p of getMenuProviders()) console.log(p.label + ' (' + p.id + ') - ' + p.description);
    return;
  }
  throw new Error('Unknown auth command: ' + command + '\n\n' + usage());
}

module.exports = { authCmd, usage, preferredModel };
