const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_ISSUER = 'https://auth.openai.com';
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const ANTHROPIC_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const OPENROUTER_AUTHORIZE_URL = 'https://openrouter.ai/auth';
const OPENROUTER_TOKEN_URL = 'https://openrouter.ai/api/v1/auth/keys';
const GOOGLE_CLIENT_ID = process.env.LOOM_GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.LOOM_GOOGLE_OAUTH_CLIENT_SECRET || '';
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/generative-language.retriever',
];
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const COPILOT_DEVICE_URL = 'https://github.com/login/device/code';
const COPILOT_GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function createPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function randomState() {
  return base64url(crypto.randomBytes(32));
}

function buildUrl(endpoint, params) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function decodeJwt(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function chatgptAccountId(tokens) {
  const claims = decodeJwt(tokens && tokens.id_token);
  return (
    (claims && claims['https://api.openai.com/auth'] && claims['https://api.openai.com/auth'].chatgpt_account_id) ||
    (claims && claims.chatgpt_account_id) ||
    (claims && claims.organizations && claims.organizations[0] && claims.organizations[0].id) ||
    null
  );
}

function emailFromIdToken(token) {
  const claims = decodeJwt(token);
  return typeof claims.email === 'string' ? claims.email : null;
}

function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd.exe', ['/c', 'start', '""', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function successPage(title, message) {
  return '<!doctype html><meta charset="utf-8"><title>' + title + '</title>' +
    '<body style="font-family:system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1.5rem">' +
    '<h1>' + title + '</h1><p>' + message + '</p></body>';
}

/**
 * Start a one-shot loopback OAuth callback server.
 * @param {{ port?: number, path?: string, state: string, timeoutMs?: number, requireState?: boolean }} opts
 * @returns {Promise<{ redirectUri: string, wait: Promise<{ code: string, state: string }>, close: () => void }>}
 */
function startLoopbackServer(opts) {
  const port = Number.isFinite(Number(opts.port)) ? Number(opts.port) : 0;
  const callbackPath = opts.path || '/callback';
  const state = opts.state;
  const requireState = opts.requireState !== false;
  const timeoutMs = opts.timeoutMs || 5 * 60 * 1000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    /** @type {(value: { code: string, state: string }) => void} */
    let resolveWait = () => {};
    /** @type {(reason?: any) => void} */
    let rejectWait = () => {};
    const wait = new Promise((res, rej) => {
      resolveWait = res;
      rejectWait = rej;
    });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== callbackPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      if (url.searchParams.get('error')) {
        const code = url.searchParams.get('error') || 'oauth_error';
        const description = url.searchParams.get('error_description') || 'Authorization was denied.';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successPage('Sign-in failed', 'The provider returned an error. You can close this window.'));
        finish(new Error(code + ': ' + description));
        return;
      }
      const receivedState = url.searchParams.get('state') || '';
      if (requireState && !safeEqual(receivedState, state)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successPage('Sign-in failed', 'OAuth state did not match. You can close this window.'));
        finish(new Error('OAuth state mismatch. Possible CSRF attack.'));
        return;
      }
      const code = url.searchParams.get('code') || '';
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successPage('Sign-in failed', 'No authorization code was returned.'));
        finish(new Error('No authorization code returned by the provider.'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(successPage('Signed in', 'Loom received the authorization. You can close this window.'));
      finish(null, { code, state });
    });
    function close() {
      try { server.close(); } catch {}
    }
    function finish(err, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      close();
      if (err) rejectWait(err);
      else resolveWait(value);
    }
    server.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
      rejectWait(err);
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        finish(new Error('Could not allocate an OAuth callback port.'));
        return;
      }
      timer = setTimeout(() => {
        finish(new Error('Authentication timed out after 5 minutes.'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      resolve({
        redirectUri: 'http://127.0.0.1:' + address.port + callbackPath,
        wait,
        close,
      });
    });
  });
}

async function requestJson(url, init, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
      const detail = body && (body.error_description || body.error || body.message) || res.statusText || 'request failed';
      const err = new Error(String(detail));
      /** @type {any} */ (err).status = res.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function postForm(url, fields, headers, timeoutMs) {
  return requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...(headers || {}),
    },
    body: new URLSearchParams(fields).toString(),
  }, timeoutMs);
}

function expiresAtFrom(tokens) {
  const seconds = Number(tokens && tokens.expires_in);
  return Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : undefined;
}

function googleOAuthConfigured() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function googleOAuthMissingError() {
  return new Error(
    'Google account sign-in needs an OAuth client. Set LOOM_GOOGLE_OAUTH_CLIENT_ID and ' +
    'LOOM_GOOGLE_OAUTH_CLIENT_SECRET, or use "loom auth login google --method api".'
  );
}

/**
 * @param {string} code
 * @param {string} verifier
 * @param {string} redirectUri
 * @returns {Promise<Partial<import('./store').StoredCredential>>}
 */
async function exchangeOpenRouter(code, verifier, redirectUri) {
  const body = await requestJson(OPENROUTER_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: 'S256',
      redirect_uri: redirectUri,
    }),
  });
  if (!body.key) throw new Error('OpenRouter did not return an API key.');
  return {
    type: 'api',
    method: 'oauth',
    apiKey: body.key,
    label: 'OpenRouter OAuth',
  };
}

/**
 * @param {string} code
 * @param {string} verifier
 * @returns {Promise<Partial<import('./store').StoredCredential>>}
 */
async function exchangeAnthropic(code, verifier) {
  const parts = String(code || '').split('#');
  const body = await postForm(ANTHROPIC_TOKEN_URL, {
    grant_type: 'authorization_code',
    code: parts[0],
    client_id: ANTHROPIC_CLIENT_ID,
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    code_verifier: verifier,
    ...(parts[1] ? { state: parts[1] } : {}),
  });
  if (!body.access_token) throw new Error('Anthropic did not return an access token.');
  return {
    type: 'oauth',
    method: 'oauth',
    accessToken: body.access_token,
    refreshToken: body.refresh_token || undefined,
    expiresAt: expiresAtFrom(body),
    tokenType: body.token_type || 'Bearer',
    scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : undefined,
    label: 'Claude account',
  };
}

/**
 * @param {string} code
 * @param {string} verifier
 * @param {string} redirectUri
 * @returns {Promise<Partial<import('./store').StoredCredential>>}
 */
async function exchangeGoogle(code, verifier, redirectUri) {
  if (!googleOAuthConfigured()) throw googleOAuthMissingError();
  const body = await postForm(GOOGLE_TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (!body.access_token) throw new Error('Google did not return an access token.');
  const claims = decodeJwt(body.id_token);
  return {
    type: 'oauth',
    method: 'oauth',
    accessToken: body.access_token,
    refreshToken: body.refresh_token || undefined,
    expiresAt: expiresAtFrom(body),
    tokenType: body.token_type || 'Bearer',
    scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : undefined,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    label: typeof claims.email === 'string' ? claims.email : 'Google account',
  };
}

/**
 * @param {string} code
 * @param {string} verifier
 * @param {string} redirectUri
 * @returns {Promise<Partial<import('./store').StoredCredential>>}
 */
async function exchangeChatGPT(code, verifier, redirectUri) {
  const body = await postForm(OPENAI_ISSUER + '/oauth/token', {
    grant_type: 'authorization_code',
    code,
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (!body.access_token) throw new Error('OpenAI did not return an access token.');
  const accountId = chatgptAccountId(body);
  return {
    type: 'oauth',
    method: 'chatgpt',
    accessToken: body.access_token,
    refreshToken: body.refresh_token || undefined,
    expiresAt: expiresAtFrom(body),
    tokenType: body.token_type || 'Bearer',
    accountId: accountId || undefined,
    email: emailFromIdToken(body.id_token) || undefined,
    label: emailFromIdToken(body.id_token) || 'ChatGPT account',
    clientId: OPENAI_CLIENT_ID,
  };
}

async function startCopilotDeviceFlow() {
  const body = await postForm(COPILOT_DEVICE_URL, {
    client_id: COPILOT_CLIENT_ID,
    scope: 'read:user',
  }, { Accept: 'application/json' });
  if (!body.device_code) throw new Error('GitHub did not return a device code.');
  return body;
}

async function pollCopilotDeviceFlow(device, opts) {
  const intervalMs = Math.max(1, Number(device.interval) || 5) * 1000;
  const expiresAt = Date.now() + (Number(device.expires_in) || 900) * 1000;
  const timeoutMs = opts && opts.timeoutMs ? opts.timeoutMs : Math.max(30000, expiresAt - Date.now());
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error('GitHub device authorization timed out.');
    await new Promise((r) => setTimeout(r, intervalMs));
    if (opts && opts.signal && opts.signal.aborted) {
      const err = new Error('Request aborted');
      err.name = 'AbortError';
      throw err;
    }
    const body = await postForm(COPILOT_GITHUB_TOKEN_URL, {
      client_id: COPILOT_CLIENT_ID,
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, { Accept: 'application/json' });
    if (body.access_token) return body.access_token;
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (body.error === 'expired_token') throw new Error('The GitHub device code expired. Start sign-in again.');
    if (body.error === 'access_denied') throw new Error('GitHub sign-in was denied.');
    throw new Error('GitHub device authorization failed: ' + (body.error_description || body.error || 'unknown error'));
  }
}

/**
 * @param {string} githubToken
 * @returns {Promise<Partial<import('./store').StoredCredential>>}
 */
async function exchangeCopilot(githubToken) {
  const body = await requestJson(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + githubToken,
      Accept: 'application/json',
      'User-Agent': 'GitHubCopilotChat/0.26.7',
      'Copilot-Integration-Id': 'vscode-chat',
      'Editor-Version': 'vscode/1.99.3',
      'Editor-Plugin-Version': 'copilot-chat/0.26.7',
    },
  });
  if (!body.token) throw new Error('GitHub Copilot did not return an access token.');
  return {
    type: 'oauth',
    method: 'device',
    accessToken: body.token,
    refreshToken: githubToken,
    expiresAt: Number(body.expires_at) > 0 ? Number(body.expires_at) * 1000 : Date.now() + 20 * 60 * 1000,
    tokenType: 'Bearer',
    label: 'GitHub Copilot',
    extra: body.endpoints ? { endpoints: JSON.stringify(body.endpoints) } : {},
  };
}

/**
 * @param {string} provider
 * @param {import('./store').StoredCredential} cred
 * @returns {Promise<Partial<import('./store').StoredCredential>>}
 */
async function refreshCredential(provider, cred) {
  if (!cred || !cred.refreshToken) throw new Error('No refresh token is available for ' + provider + '. Sign in again.');
  if (provider === 'openai' || provider === 'chatgpt') {
    const body = await postForm(OPENAI_ISSUER + '/oauth/token', {
      grant_type: 'refresh_token',
      client_id: cred.clientId || OPENAI_CLIENT_ID,
      refresh_token: cred.refreshToken,
    });
    if (!body.access_token) throw new Error('OpenAI token refresh did not return an access token.');
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || cred.refreshToken,
      expiresAt: expiresAtFrom(body),
      tokenType: body.token_type || 'Bearer',
      accountId: chatgptAccountId(body) || cred.accountId,
      method: 'chatgpt',
    };
  }
  if (provider === 'anthropic') {
    const body = await postForm(ANTHROPIC_TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: ANTHROPIC_CLIENT_ID,
      refresh_token: cred.refreshToken,
    });
    if (!body.access_token) throw new Error('Anthropic token refresh did not return an access token.');
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || cred.refreshToken,
      expiresAt: expiresAtFrom(body),
      tokenType: body.token_type || 'Bearer',
      scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : cred.scopes,
    };
  }
  if (provider === 'google') {
    if (!googleOAuthConfigured()) throw googleOAuthMissingError();
    const body = await postForm(GOOGLE_TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: cred.clientId || GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: cred.refreshToken,
    });
    if (!body.access_token) throw new Error('Google token refresh did not return an access token.');
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || cred.refreshToken,
      expiresAt: expiresAtFrom(body),
      tokenType: body.token_type || 'Bearer',
      scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : cred.scopes,
    };
  }
  if (provider === 'github-copilot') {
    return exchangeCopilot(cred.refreshToken);
  }
  throw new Error('This credential does not support automatic refresh. Sign in again.');
}

module.exports = {
  OPENAI_CLIENT_ID,
  OPENAI_ISSUER,
  ANTHROPIC_CLIENT_ID,
  ANTHROPIC_AUTHORIZE_URL,
  ANTHROPIC_TOKEN_URL,
  ANTHROPIC_REDIRECT_URI,
  OPENROUTER_AUTHORIZE_URL,
  OPENROUTER_TOKEN_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_SCOPES,
  googleOAuthConfigured,
  COPILOT_CLIENT_ID,
  COPILOT_DEVICE_URL,
  COPILOT_GITHUB_TOKEN_URL,
  COPILOT_TOKEN_URL,
  createPkce,
  randomState,
  buildUrl,
  decodeJwt,
  openBrowser,
  startLoopbackServer,
  requestJson,
  postForm,
  expiresAtFrom,
  exchangeOpenRouter,
  exchangeAnthropic,
  exchangeGoogle,
  exchangeChatGPT,
  startCopilotDeviceFlow,
  pollCopilotDeviceFlow,
  exchangeCopilot,
  refreshCredential,
};
