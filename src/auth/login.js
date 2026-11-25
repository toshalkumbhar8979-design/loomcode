const fs = require('fs');
const readline = require('readline');
const oauth = require('./oauth');
const store = require('./store');
const { getAuthProvider, getMethod } = require('./providers');

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function plainLine(text) {
  process.stdout.write(text + '\n');
}

function canUseUI() {
  return Boolean(
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    typeof process.stdin.setRawMode === 'function'
  );
}

let promptsPromise = null;

function uiPrompts() {
  if (!promptsPromise) promptsPromise = import('@clack/prompts');
  return promptsPromise;
}

function abortError(message) {
  const err = new Error(message || 'Sign-in cancelled.');
  err.name = 'AbortError';
  return err;
}

// Piped auth input (tests, scripts, `printf '1\nkey\n' | loom auth login`)
// must survive multiple prompts. A fresh readline per prompt discards the
// already-buffered remaining lines, so non-TTY input is read once and split.
let pipedLines = null;
let pipedLineIndex = 0;

function nextPipedLine() {
  if (pipedLines === null) {
    try { pipedLines = fs.readFileSync(0, 'utf8').split(/\r?\n/); } catch { pipedLines = []; }
  }
  return pipedLines[pipedLineIndex++] ?? '';
}

async function promptLine(question, opts) {
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    const answer = nextPipedLine().trim();
    process.stdout.write((opts && opts.secret ? '********' : answer) + '\n');
    return answer;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
  } finally {
    rl.close();
  }
}

async function promptText(question, opts) {
  if (!canUseUI()) return promptLine(question);
  const p = await uiPrompts();
  const options = {
    message: String(question).replace(/:\s*$/, ''),
    placeholder: opts && opts.placeholder,
  };
  if (opts && opts.validate) options.validate = opts.validate;
  const answer = await p.text(options);
  if (p.isCancel(answer)) throw abortError();
  return String(answer).trim();
}

async function promptSecret(question) {
  if (!canUseUI()) return promptLine(question, { secret: true });
  const p = await uiPrompts();
  const answer = await p.password({
    message: String(question).replace(/:\s*$/, ''),
    mask: '*',
    validate: (value) => (value && String(value).trim() ? undefined : 'Enter a value'),
  });
  if (p.isCancel(answer)) throw abortError();
  return String(answer).trim();
}

async function numberedSelect(items, opts) {
  plainLine('');
  plainLine(BOLD + opts.title + RESET);
  plainLine('');
  items.forEach((item, i) => {
    const rec = item.recommended ? ' (recommended)' : '';
    const desc = item.description ? ' - ' + item.description : '';
    plainLine('  ' + String(i + 1).padStart(2) + ') ' + item.label + rec + desc);
  });
  plainLine('');
  const answer = await promptLine('Select 1-' + items.length + ' (Enter for 1): ');
  if (answer === '') return items[0];
  const n = Number(answer);
  return Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : null;
}

/**
 * @param {Array<{ id: string, label: string, description?: string, connected?: boolean, recommended?: boolean }>} items
 * @param {{ title: string, maxItems?: number, initialValue?: string }} opts
 * @returns {Promise<{ id: string, label: string } | null>}
 */
async function selectItem(items, opts) {
  if (!items.length) return null;
  if (!canUseUI()) return numberedSelect(items, opts);
  const p = await uiPrompts();
  const options = items.map((item) => {
    const hints = [];
    if (item.connected) hints.push('connected');
    if (item.recommended) hints.push('recommended');
    else if (item.description) hints.push(item.description);
    return {
      value: item.id,
      label: item.label,
      hint: hints.length ? hints.join(' - ') : undefined,
    };
  });
  const answer = await p.select({
    message: opts.title,
    options,
    maxItems: opts.maxItems || 8,
    initialValue: opts.initialValue || items[0].id,
  });
  if (p.isCancel(answer)) {
    p.cancel('Sign-in cancelled.');
    return null;
  }
  return items.find((item) => item.id === answer) || null;
}

async function chooseProvider() {
  const { getMenuProviders } = require('./providers');
  const providers = getMenuProviders();
  // An unreadable/corrupt vault must not hide the provider list. Connected
  // markers are a nicety; sign-in can still repair the vault afterwards.
  let credentials = [];
  try { credentials = store.listCredentials(); } catch {}
  const connected = new Set(credentials.map((c) => c.provider));
  const items = providers.map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    connected: connected.has(p.provider),
    recommended: !!p.recommended,
  }));
  items.push({
    id: 'other',
    label: 'Other',
    description: 'Enter a custom provider id',
    connected: false,
    recommended: false,
  });
  const picked = await selectItem(items, { title: 'Select provider' });
  if (!picked) return null;
  if (picked.id !== 'other') return getAuthProvider(picked.id);
  const id = await promptText('Provider id: ', {
    placeholder: 'provider-id',
    validate: (value) => {
      if (!value) return 'Enter a provider id';
      if (!/^[a-z0-9][a-z0-9-]*$/.test(String(value))) return 'Use lowercase letters, numbers, and hyphens';
      return undefined;
    },
  });
  const normalized = String(id || '').replace(/^@ai-sdk\//, '');
  if (!normalized) return null;
  return getAuthProvider(normalized);
}

async function chooseMethod(provider) {
  if (provider.methods.length === 1) return provider.methods[0];
  const items = provider.methods.map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
  }));
  const picked = await selectItem(items, { title: 'Login method' });
  if (!picked) return null;
  return getMethod(provider, picked.id);
}

function printUrl(url) {
  plainLine('');
  plainLine('Open this URL in your browser:');
  plainLine('  ' + url);
  plainLine('');
}

async function showUrl(url, opts) {
  if (!canUseUI()) {
    printUrl(url);
    return;
  }
  const p = await uiPrompts();
  const label = opts && opts.noBrowser ? 'Open this URL in your browser' : 'If the browser did not open';
  p.log.info(label + ':\n' + url);
}

async function openAuthUrl(url, opts) {
  await showUrl(url, opts);
  if (opts && opts.noBrowser) return;
  if (oauth.openBrowser(url)) return;
  if (canUseUI()) {
    const p = await uiPrompts();
    p.log.warn('Could not open the browser automatically. Open the URL above.');
  } else {
    plainLine('Could not open the browser automatically. Open the URL above.');
  }
}

async function ensureGoogleClient() {
  const existing = oauth.getGoogleClient();
  if (existing) return existing;
  if (canUseUI()) {
    const p = await uiPrompts();
    p.note(
      'Create a Desktop app OAuth client in Google Cloud Console:\n' +
      'https://console.cloud.google.com/apis/credentials\n\n' +
      'Enable the Generative Language API for the same project.\n' +
      'If the consent screen is in Testing, add your account as a test user.\n' +
      'Loom stores the client ID and secret in the encrypted auth vault.',
      'Google sign-in setup'
    );
  } else {
    plainLine('');
    plainLine('Google sign-in needs a Desktop app OAuth client.');
    plainLine('Create one at https://console.cloud.google.com/apis/credentials');
    plainLine('');
  }
  const clientId = await promptText('Client ID: ', {
    placeholder: '...apps.googleusercontent.com',
    validate: (value) => {
      if (!value) return 'Enter the OAuth client ID';
      if (!/\.apps\.googleusercontent\.com$/i.test(String(value).trim())) {
        return 'Expected a client ID ending in .apps.googleusercontent.com';
      }
      return undefined;
    },
  });
  const clientSecret = await promptSecret('Client secret: ');
  if (!clientId || !clientSecret) throw new Error('Google OAuth client details are required.');
  if (!/\.apps\.googleusercontent\.com$/i.test(clientId)) {
    throw new Error('Google OAuth client IDs end in .apps.googleusercontent.com.');
  }
  const client = oauth.saveGoogleClient(clientId, clientSecret);
  if (!client) throw new Error('Could not save the Google OAuth client.');
  if (canUseUI()) {
    const p = await uiPrompts();
    p.log.success('Google OAuth client saved.');
  }
  return client;
}

async function waitForOpenRouter(method, opts) {
  const pkce = oauth.createPkce();
  const state = oauth.randomState();
  const server = await oauth.startLoopbackServer({ state, requireState: false });
  const ui = canUseUI() ? await uiPrompts() : null;
  try {
    const authUrl = oauth.buildUrl(oauth.OPENROUTER_AUTHORIZE_URL, {
      callback_url: server.redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
    await openAuthUrl(authUrl, opts);
    const spin = ui ? ui.spinner() : null;
    if (spin) spin.start('Waiting for OpenRouter authorization...');
    try {
      const { code } = await server.wait;
      const credential = await oauth.exchangeOpenRouter(code, pkce.verifier, server.redirectUri);
      if (spin) spin.stop('OpenRouter authorized.');
      return credential;
    } catch (err) {
      if (spin) spin.error('OpenRouter authorization failed.');
      throw err;
    }
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
  await openAuthUrl(authUrl, opts);
  const code = await promptText('Authorization code: ');
  if (!code) throw new Error('No authorization code was entered.');
  return oauth.exchangeAnthropic(code, pkce.verifier);
}

async function waitForGoogle(method, opts) {
  const client = await ensureGoogleClient();
  const pkce = oauth.createPkce();
  const state = oauth.randomState();
  const server = await oauth.startLoopbackServer({ state, path: '/oauth2callback' });
  const ui = canUseUI() ? await uiPrompts() : null;
  try {
    const authUrl = oauth.buildUrl(oauth.GOOGLE_AUTHORIZE_URL, {
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: server.redirectUri,
      scope: oauth.GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
    });
    await openAuthUrl(authUrl, opts);
    const spin = ui ? ui.spinner() : null;
    if (spin) spin.start('Waiting for Google authorization...');
    try {
      const { code } = await server.wait;
      const credential = await oauth.exchangeGoogle(code, pkce.verifier, server.redirectUri);
      if (spin) spin.stop('Google authorized.');
      const project = process.env.LOOM_GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
      if (project) credential.projectId = project;
      return credential;
    } catch (err) {
      if (spin) spin.error('Google authorization failed.');
      throw err;
    }
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
  const ui = canUseUI() ? await uiPrompts() : null;
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
    await openAuthUrl(authUrl, opts);
    const spin = ui ? ui.spinner() : null;
    if (spin) spin.start('Waiting for ChatGPT authorization...');
    try {
      const { code } = await server.wait;
      const credential = await oauth.exchangeChatGPT(code, pkce.verifier, server.redirectUri);
      if (spin) spin.stop('ChatGPT authorized.');
      return credential;
    } catch (err) {
      if (spin) spin.error('ChatGPT authorization failed.');
      throw err;
    }
  } finally {
    server.close();
  }
}

async function waitForCopilot(method, opts) {
  const device = await oauth.startCopilotDeviceFlow();
  const url = device.verification_uri || 'https://github.com/login/device';
  const code = device.user_code || '';
  if (canUseUI()) {
    const p = await uiPrompts();
    p.note(url + '\n\nCode: ' + code, 'Authorize GitHub Copilot');
  } else {
    plainLine('');
    plainLine('Open this URL in your browser:');
    plainLine('  ' + url);
    plainLine('');
    plainLine('Enter this code: ' + BOLD + code + RESET);
    plainLine('');
  }
  if (!opts.noBrowser) oauth.openBrowser(url);
  const ui = canUseUI() ? await uiPrompts() : null;
  const spin = ui ? ui.spinner() : null;
  if (spin) spin.start('Waiting for GitHub authorization...');
  try {
    const githubToken = await oauth.pollCopilotDeviceFlow(device, { signal: opts.signal });
    const credential = await oauth.exchangeCopilot(githubToken);
    if (spin) spin.stop('GitHub Copilot authorized.');
    return credential;
  } catch (err) {
    if (spin) spin.error('GitHub authorization failed.');
    throw err;
  }
}

async function loginFlow(providerInput, options) {
  let provider;
  if (providerInput) {
    provider = getAuthProvider(providerInput);
  } else {
    provider = await chooseProvider();
    if (!provider) return null;
  }
  const methods = provider.methods.slice();
  let method = options.method ? getMethod({ ...provider, methods }, options.method) : null;
  if (options.method && !method) {
    throw new Error('Unknown method "' + options.method + '" for ' + provider.label + '.');
  }
  if (!method && methods.length > 1 && !canUseUI()) {
    throw new Error('Choose a method for ' + provider.label + ': ' +
      methods.map((m) => m.id).join(', ') + '.');
  }
  if (!method) method = methods.length === 1 ? methods[0] : await chooseMethod({ ...provider, methods });
  if (!method) return null;

  /** @type {Partial<import('./store').StoredCredential>} */
  let credential;
  if (method.kind === 'api') {
    const key = options.apiKey || await promptSecret('Enter your ' + provider.label + ' API key: ');
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

async function login(providerInput, opts) {
  const options = opts || {};
  const ui = canUseUI() ? await uiPrompts() : null;
  if (ui) ui.intro('Add credential');
  try {
    return await loginFlow(providerInput, options);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      if (ui) ui.cancel('Sign-in cancelled.');
      return null;
    }
    throw err;
  }
}

module.exports = {
  login,
  chooseProvider,
  chooseMethod,
  promptSecret,
  selectItem,
  canUseUI,
  uiPrompts,
};
