const readline = require('readline');
const oauth = require('./oauth');
const store = require('./store');
const { getAuthProvider, getMethod } = require('./providers');

const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function plainLine(text) {
  process.stdout.write(text + '\n');
}

async function promptLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
  } finally {
    rl.close();
  }
}

async function promptSecret(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return promptLine(question);
  }
  process.stdout.write(question);
  const stdin = process.stdin;
  const previousRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    function cleanup() {
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      try { stdin.setRawMode(previousRaw || false); } catch {}
      stdin.pause();
    }
    function onData(buf) {
      const text = buf.toString('utf8');
      for (const ch of text) {
        if (ch === '\u0003') {
          cleanup();
          const err = new Error('Cancelled.');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          value += ch;
          process.stdout.write('*');
        }
      }
    }
    stdin.on('data', onData);
  });
}

/**
 * @param {Array<{ id: string, label: string, description?: string, connected?: boolean, recommended?: boolean }>} items
 * @param {{ title: string, searchable?: boolean, footer?: string }} opts
 * @returns {Promise<{ id: string, label: string } | null>}
 */
function selectItem(items, opts) {
  if (!items.length) return Promise.resolve(null);
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.resolve(items[0]);
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const previousRaw = stdin.isRaw;
    let query = '';
    let selected = 0;
    let rendered = 0;
    let done = false;
    const searchable = opts.searchable !== false;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write('\x1b[?25l');

    function filtered() {
      if (!searchable || !query) return items;
      const q = query.toLowerCase();
      return items.filter((item) =>
        (item.label + ' ' + item.id + ' ' + (item.description || '')).toLowerCase().includes(q)
      );
    }

    function frame() {
      const list = filtered();
      if (selected >= list.length) selected = Math.max(0, list.length - 1);
      const width = Math.max(40, Math.min(100, (stdout.columns || 80) - 2));
      const lines = [];
      lines.push(BOLD + opts.title + RESET);
      if (searchable) lines.push(CYAN + '> ' + RESET + (query || DIM + 'type to search' + RESET));
      if (!list.length) {
        lines.push(DIM + '  No matching providers.' + RESET);
      } else {
        const maxRows = 12;
        let start = Math.max(0, Math.min(selected - Math.floor(maxRows / 2), list.length - maxRows));
        const end = Math.min(list.length, start + maxRows);
        for (let i = start; i < end; i++) {
          const item = list[i];
          const marker = i === selected ? CYAN + '>' + RESET : ' ';
          const dot = item.connected ? GREEN + '●' + RESET : DIM + '○' + RESET;
          const rec = item.recommended ? '  ' + GREEN + 'recommended' + RESET : '';
          const desc = item.description ? '  ' + DIM + '- ' + item.description + RESET : '';
          const line = marker + ' ' + dot + ' ' + item.label + rec + desc;
          lines.push(line.length > width + 80 ? line.slice(0, width + 80) : line);
        }
      }
      const footer = opts.footer || '↑/↓ to select · Enter: confirm · Type to search · Esc: cancel';
      lines.push(DIM + footer + RESET);
      if (rendered > 0) {
        stdout.write('\r\x1b[' + rendered + 'A\x1b[0J');
      }
      stdout.write(lines.join('\n') + '\n');
      rendered = lines.length;
    }

    function cleanup() {
      if (done) return;
      done = true;
      stdin.removeListener('keypress', onKey);
      try { stdin.setRawMode(previousRaw || false); } catch {}
      if (rendered > 0) {
        stdout.write('\r\x1b[' + rendered + 'A\x1b[0J');
      }
      stdout.write('\x1b[?25h');
      stdin.pause();
    }

    function finish(value) {
      cleanup();
      resolve(value);
    }

    function onKey(str, key) {
      if (!key) return;
      if (key.ctrl && key.name === 'c') return finish(null);
      if (key.name === 'escape') return finish(null);
      if (key.name === 'up') {
        const list = filtered();
        if (list.length) selected = (selected - 1 + list.length) % list.length;
        frame();
        return;
      }
      if (key.name === 'down') {
        const list = filtered();
        if (list.length) selected = (selected + 1) % list.length;
        frame();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const list = filtered();
        return finish(list[selected] || null);
      }
      if (searchable && (key.name === 'backspace' || key.name === 'delete')) {
        query = query.slice(0, -1);
        selected = 0;
        frame();
        return;
      }
      if (searchable && !key.ctrl && !key.meta && str && str >= ' ' && str.length === 1) {
        query += str;
        selected = 0;
        frame();
      }
    }

    stdin.on('keypress', onKey);
    frame();
  });
}

async function chooseProvider() {
  const { getMenuProviders } = require('./providers');
  const providers = getMenuProviders();
  const connected = new Set(store.listCredentials().map((c) => c.provider));
  const items = providers.map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    connected: connected.has(p.provider),
    recommended: !!p.recommended,
  }));
  const picked = await selectItem(items, { title: 'Add credential · Select a provider' });
  if (!picked) return null;
  return getAuthProvider(picked.id);
}

async function chooseMethod(provider) {
  if (provider.methods.length === 1) return provider.methods[0];
  const items = provider.methods.map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
  }));
  const picked = await selectItem(items, {
    title: 'Add credential · ' + provider.label,
    searchable: false,
    footer: '↑/↓ to select · Enter: confirm · Esc: cancel',
  });
  if (!picked) return null;
  return getMethod(provider, picked.id);
}

function printUrl(url) {
  plainLine('');
  plainLine('Open this URL in your browser:');
  plainLine('  ' + url);
  plainLine('');
}

async function waitForOpenRouter(method, opts) {
  const pkce = oauth.createPkce();
  const state = oauth.randomState();
  const server = await oauth.startLoopbackServer({ state, requireState: false });
  try {
    const authUrl = oauth.buildUrl(oauth.OPENROUTER_AUTHORIZE_URL, {
      callback_url: server.redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
    printUrl(authUrl);
    if (!opts.noBrowser && !oauth.openBrowser(authUrl)) {
      plainLine('Could not open the browser automatically. Open the URL above.');
    }
    const { code } = await server.wait;
    return oauth.exchangeOpenRouter(code, pkce.verifier, server.redirectUri);
  } finally {
    server.close();
  }
}

async function waitForAnthropic(method, opts) {
  const pkce = oauth.createPkce();
  const authUrl = oauth.buildUrl(oauth.ANTHROPIC_AUTHORIZE_URL, {
    response_type: 'code',
    client_id: oauth.ANTHROPIC_CLIENT_ID,
    redirect_uri: oauth.ANTHROPIC_REDIRECT_URI,
    scope: 'org:create_api_key user:profile user:inference',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.verifier,
  });
  printUrl(authUrl);
  if (!opts.noBrowser && !oauth.openBrowser(authUrl)) {
    plainLine('Could not open the browser automatically. Open the URL above.');
  }
  plainLine('After approving access, copy the code shown by Anthropic.');
  const code = await promptLine('Authorization code: ');
  if (!code) throw new Error('No authorization code was entered.');
  return oauth.exchangeAnthropic(code, pkce.verifier);
}

async function waitForGoogle(method, opts) {
  if (!oauth.googleOAuthConfigured()) {
    throw new Error('Google OAuth is not configured. Use "loom auth login google --method api" or set LOOM_GOOGLE_OAUTH_CLIENT_ID and LOOM_GOOGLE_OAUTH_CLIENT_SECRET.');
  }
  const pkce = oauth.createPkce();
  const state = oauth.randomState();
  const server = await oauth.startLoopbackServer({ state, path: '/oauth2callback' });
  try {
    const authUrl = oauth.buildUrl(oauth.GOOGLE_AUTHORIZE_URL, {
      response_type: 'code',
      client_id: oauth.GOOGLE_CLIENT_ID,
      redirect_uri: server.redirectUri,
      scope: oauth.GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
    });
    printUrl(authUrl);
    if (!opts.noBrowser && !oauth.openBrowser(authUrl)) {
      plainLine('Could not open the browser automatically. Open the URL above.');
    }
    const { code } = await server.wait;
    const credential = await oauth.exchangeGoogle(code, pkce.verifier, server.redirectUri);
    const project = process.env.LOOM_GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
    if (project) credential.projectId = project;
    return credential;
  } finally {
    server.close();
  }
}

async function waitForChatGPT(method, opts) {
  const pkce = oauth.createPkce();
  const state = oauth.randomState();
  let server;
  try {
    server = await oauth.startLoopbackServer({
      port: 1455,
      path: '/auth/callback',
      state,
      timeoutMs: 5 * 60 * 1000,
    });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      throw new Error('Port 1455 is already in use. Close any running Codex login, then try again.');
    }
    throw err;
  }
  try {
    const authUrl = oauth.buildUrl(oauth.OPENAI_ISSUER + '/oauth/authorize', {
      response_type: 'code',
      client_id: oauth.OPENAI_CLIENT_ID,
      redirect_uri: server.redirectUri,
      scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    });
    printUrl(authUrl);
    if (!opts.noBrowser && !oauth.openBrowser(authUrl)) {
      plainLine('Could not open the browser automatically. Open the URL above.');
    }
    const { code } = await server.wait;
    return oauth.exchangeChatGPT(code, pkce.verifier, server.redirectUri);
  } finally {
    server.close();
  }
}

async function waitForCopilot(method, opts) {
  const device = await oauth.startCopilotDeviceFlow();
  plainLine('');
  plainLine('Open this URL in your browser:');
  plainLine('  ' + (device.verification_uri || 'https://github.com/login/device'));
  plainLine('');
  plainLine('Enter this code: ' + BOLD + (device.user_code || '') + RESET);
  plainLine('');
  if (!opts.noBrowser) oauth.openBrowser(device.verification_uri || 'https://github.com/login/device');
  plainLine('Waiting for GitHub authorization...');
  const githubToken = await oauth.pollCopilotDeviceFlow(device, { signal: opts.signal });
  return oauth.exchangeCopilot(githubToken);
}

async function login(providerInput, opts) {
  const options = opts || {};
  let provider;
  if (providerInput) {
    provider = getAuthProvider(providerInput);
  } else {
    provider = await chooseProvider();
    if (!provider) return null;
  }
  // Google OAuth only exists when the user supplies their own OAuth client;
  // without it, offer the working API-key method instead of a dead end.
  const methods = provider.methods.filter((m) => m.kind !== 'google' || oauth.googleOAuthConfigured());
  let method = options.method ? getMethod({ ...provider, methods }, options.method) : null;
  if (options.method && !method) {
    const why = provider.methods.some((m) => m.id === options.method && m.kind === 'google')
      ? ' Google OAuth needs LOOM_GOOGLE_OAUTH_CLIENT_ID and LOOM_GOOGLE_OAUTH_CLIENT_SECRET, or use --method api.'
      : '';
    throw new Error('Unknown method "' + options.method + '" for ' + provider.label + '.' + why);
  }
  if (!method && methods.length > 1 && !process.stdin.isTTY) {
    throw new Error('Choose a method for ' + provider.label + ': ' +
      methods.map((m) => m.id).join(', ') + '.');
  }
  if (!method) method = methods.length === 1 ? methods[0] : await chooseMethod({ ...provider, methods });
  if (!method) return null;

  /** @type {Partial<import('./store').StoredCredential>} */
  let credential;
  if (method.kind === 'api') {
    const key = options.apiKey || await promptSecret('Paste the ' + provider.label + ' API key: ');
    if (!key) throw new Error('No API key was entered.');
    credential = {
      type: 'api',
      method: 'api',
      apiKey: key,
      label: provider.label + ' API key',
      ...(method.envHint ? { extra: { envHint: method.envHint } } : {}),
    };
  } else if (method.kind === 'openrouter') {
    credential = await waitForOpenRouter(method, options);
  } else if (method.kind === 'anthropic') {
    credential = await waitForAnthropic(method, options);
  } else if (method.kind === 'google') {
    credential = await waitForGoogle(method, options);
  } else if (method.kind === 'chatgpt') {
    credential = await waitForChatGPT(method, options);
  } else if (method.kind === 'copilot') {
    credential = await waitForCopilot(method, options);
  } else {
    throw new Error('Unsupported authentication method: ' + method.kind);
  }

  const saved = store.saveCredential(provider.provider, {
    ...credential,
    provider: provider.provider,
  });
  return { provider: provider.provider, label: provider.label, method: method.id, credential: saved };
}

module.exports = {
  login,
  chooseProvider,
  chooseMethod,
  promptSecret,
  selectItem,
};
