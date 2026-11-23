const store = require('./store');
const oauth = require('./oauth');
const providers = require('./providers');

const REFRESH_SKEW_MS = 90 * 1000;

/**
 * @param {string} provider
 * @returns {import('./store').StoredCredential | null}
 */
function credentialFor(provider) {
  return store.getCredential(provider);
}

/**
 * @param {string} provider
 * @returns {boolean}
 */
function hasAuth(provider) {
  if (!provider) return false;
  try {
    const cred = store.getCredential(provider);
    if (!cred) return false;
    if (cred.type === 'api') return !!cred.apiKey;
    return !!cred.accessToken || !!cred.refreshToken;
  } catch {
    return false;
  }
}

/**
 * Generic API keys may come from API-type credentials only. OAuth access
 * tokens must never be sent to an endpoint that expects an API key.
 * @param {string} provider
 * @returns {string | null}
 */
function getApiKey(provider) {
  return store.getApiKeyCredential(provider);
}

/**
 * @param {string} provider
 * @returns {string | null}
 */
function authMethod(provider) {
  try {
    const cred = store.getCredential(provider);
    return cred ? cred.method : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} provider
 * @returns {boolean}
 */
function isChatGPT(provider) {
  const cred = credentialFor(provider);
  return !!cred && cred.method === 'chatgpt' && cred.type === 'oauth';
}

/**
 * @param {import('./store').StoredCredential} cred
 * @returns {boolean}
 */
function needsRefresh(cred) {
  if (!cred || cred.type !== 'oauth') return false;
  if (!cred.expiresAt) return false;
  return Number(cred.expiresAt) - REFRESH_SKEW_MS <= Date.now();
}

/**
 * Refresh an OAuth credential if it is close to expiry.
 * @param {string} provider
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<import('./store').StoredCredential | null>}
 */
async function ensureFreshAuth(provider, opts) {
  const cred = credentialFor(provider);
  if (!cred || cred.type !== 'oauth') return cred;
  if (!opts || !opts.force) {
    if (!needsRefresh(cred)) return cred;
  }
  if (!cred.refreshToken) {
    throw new Error(
      'Your ' + provider + ' session has expired. Run "loom auth login ' + provider + '" to sign in again.'
    );
  }
  try {
    const patch = await oauth.refreshCredential(provider, cred);
    const saved = store.saveCredential(provider, {
      ...cred,
      ...patch,
      type: 'oauth',
      label: cred.label,
      provider,
    });
    store.audit('refresh', provider, saved.method, 'ok');
    return saved;
  } catch (err) {
    store.audit('refresh', provider, cred.method, 'failed');
    const detail = err && err.message ? err.message : 'token refresh failed';
    throw new Error(
      'Could not refresh the ' + provider + ' session (' + detail + '). ' +
      'Run "loom auth login ' + provider + '" to sign in again.'
    );
  }
}

/**
 * @param {string} provider
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<string>}
 */
async function getAccessToken(provider, opts) {
  const cred = await ensureFreshAuth(provider, opts);
  if (!cred || !cred.accessToken) {
    throw new Error('No OAuth session found for ' + provider + '. Run "loom auth login ' + provider + '".');
  }
  return cred.accessToken;
}

/**
 * @param {string} provider
 * @returns {Object<string, string>}
 */
function headersFor(provider) {
  const cred = credentialFor(provider);
  if (!cred || cred.type !== 'oauth' || !cred.accessToken) return {};
  /** @type {Object<string, string>} */
  const headers = { Authorization: 'Bearer ' + cred.accessToken };
  if (provider === 'anthropic') headers['anthropic-beta'] = 'oauth-2025-04-20';
  if (provider === 'openai' && cred.accountId) headers['chatgpt-account-id'] = cred.accountId;
  if (provider === 'google') {
    const project = cred.projectId || process.env.LOOM_GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
    if (project) headers['x-goog-user-project'] = project;
  }
  if (provider === 'github-copilot') {
    headers['Copilot-Integration-Id'] = 'vscode-chat';
    headers['Editor-Version'] = 'vscode/1.99.3';
    headers['Editor-Plugin-Version'] = 'copilot-chat/0.26.7';
    headers['User-Agent'] = 'GitHubCopilotChat/0.26.7';
    headers['X-Initiator'] = 'user';
  }
  return headers;
}

/**
 * @param {string} provider
 * @returns {boolean}
 */
function isExpired(provider) {
  try {
    const cred = credentialFor(provider);
    return !!cred && cred.type === 'oauth' && needsRefresh(cred);
  } catch {
    return false;
  }
}

module.exports = {
  ...store,
  ...oauth,
  ...providers,
  REFRESH_SKEW_MS,
  credentialFor,
  hasAuth,
  getApiKey,
  authMethod,
  isChatGPT,
  needsRefresh,
  ensureFreshAuth,
  getAccessToken,
  headersFor,
  isExpired,
};
