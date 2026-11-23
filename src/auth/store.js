const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const AAD = Buffer.from('loom.auth.v1');
const VAULT_VERSION = 1;
const KEY_BYTES = 32;
const LOCK_WAIT_MS = 2500;
const LOCK_STALE_MS = 30000;

/**
 * @typedef {Object} StoredCredential
 * @property {string} provider
 * @property {string} label
 * @property {string} method
 * @property {'oauth'|'api'} type
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string} fingerprint
 * @property {string=} apiKey
 * @property {string=} accessToken
 * @property {string=} refreshToken
 * @property {number=} expiresAt
 * @property {string=} tokenType
 * @property {Array<string>=} scopes
 * @property {string=} accountId
 * @property {string=} email
 * @property {string=} plan
 * @property {string=} projectId
 * @property {string=} baseUrl
 * @property {string=} clientId
 * @property {Object<string, string>=} extra
 * @property {boolean=} hasApiKey
 * @property {boolean=} hasAccessToken
 * @property {boolean=} hasRefreshToken
 */

/**
 * @typedef {Object} VaultData
 * @property {number} version
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {{ source: 'file'|'env', kdf: 'none'|'scrypt', salt?: string }} key
 * @property {{ iv: string, tag: string, ciphertext: string }} data
 */

/**
 * @typedef {Object} VaultPlain
 * @property {number} version
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {Object<string, StoredCredential>} credentials
 */

function loomDir() {
  return process.env.LOOM_CONFIG_DIR || path.join(os.homedir(), '.loom');
}

function vaultFile() {
  return path.join(loomDir(), 'auth.json');
}

function keyFile() {
  return path.join(loomDir(), 'auth.key');
}

function lockFile() {
  return path.join(loomDir(), 'auth.lock');
}

function auditFile() {
  return path.join(loomDir(), 'auth-audit.log');
}

function ensureDir() {
  fs.mkdirSync(loomDir(), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(loomDir(), 0o700); } catch {}
}

const securedPaths = new Set();

function securePath(target) {
  if (securedPaths.has(target)) return;
  try { fs.chmodSync(target, 0o600); } catch {}
  if (process.platform !== 'win32' || process.env.LOOM_AUTH_NO_DPAPI === '1') {
    securedPaths.add(target);
    return;
  }
  try {
    const user = os.userInfo().username;
    spawnSync('icacls', [target, '/inheritance:r', '/grant:r', user + ':F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 3000,
    });
  } catch {}
  securedPaths.add(target);
}

function audit(event, provider, method, outcome) {
  try {
    ensureDir();
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      provider: provider || null,
      method: method || null,
      outcome: outcome || 'ok',
    });
    fs.appendFileSync(auditFile(), line + '\n', { mode: 0o600 });
    securePath(auditFile());
  } catch {}
}

function base64(buf) {
  return Buffer.from(buf).toString('base64');
}

function fromBase64(value) {
  return Buffer.from(String(value || ''), 'base64');
}

function useDpapi() {
  return process.platform === 'win32' &&
    process.env.LOOM_AUTH_NO_DPAPI !== '1' &&
    process.env.LOOM_AUTH_DISABLE_KEYRING !== '1';
}

function dpapi(input, protect) {
  const method = protect ? 'Protect' : 'Unprotect';
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    '$p=[System.Security.Cryptography.ProtectedData]::' + method + '($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($p)',
  ].join('; ');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: base64(input),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  if (res.status !== 0 || !res.stdout) throw new Error('Windows DPAPI operation failed');
  return fromBase64(res.stdout.trim());
}

// Decrypting the vault key used to spawn PowerShell (DPAPI) and/or run scrypt
// on every read — several times per model turn once the provider/auth layers
// ask for credentials. Cache both the protected key and the decrypted vault in
// memory, keyed by file stat + env, so the hot path is one small decrypt.
/** @type {{ stamp: string, key: Buffer } | null} */
let keyCache = null;
/** @type {{ stamp: string, plain: VaultPlain } | null} */
let vaultCache = null;

function fileStamp(file) {
  try {
    const st = fs.statSync(file);
    return file + ':' + st.mtimeMs + ':' + st.size;
  } catch {
    return file + ':missing';
  }
}

function envStamp() {
  const phrase = process.env.LOOM_AUTH_KEY || '';
  const phraseMark = phrase ? crypto.createHash('sha256').update(String(phrase)).digest('hex').slice(0, 16) : '';
  return phraseMark + ':' + (process.env.LOOM_AUTH_NO_DPAPI || '') + ':' + (process.env.LOOM_AUTH_DISABLE_KEYRING || '');
}

function readKeyFile() {
  const file = keyFile();
  const stamp = fileStamp(file) + ':' + envStamp();
  if (keyCache && keyCache.stamp === stamp) return keyCache.key;
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return null;
  let key;
  if (raw.startsWith('dpapi:')) {
    if (process.env.LOOM_AUTH_DISABLE_KEYRING === '1') {
      throw new Error('The auth vault key is DPAPI-protected and keyring access is disabled.');
    }
    key = dpapi(fromBase64(raw.slice(6)), false);
  } else {
    key = fromBase64(raw);
  }
  keyCache = { stamp, key };
  return key;
}

function createKeyFile() {
  ensureDir();
  const key = crypto.randomBytes(KEY_BYTES);
  let encoded = base64(key);
  if (useDpapi()) {
    try { encoded = 'dpapi:' + base64(dpapi(key, true)); } catch {}
  }
  const file = keyFile();
  let created = false;
  try {
    fs.writeFileSync(file, encoded + '\n', { mode: 0o600, flag: 'wx' });
    created = true;
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
  }
  securePath(file);
  if (created) {
    keyCache = { stamp: fileStamp(file) + ':' + envStamp(), key };
    return key;
  }
  return readKeyFile() || key;
}

function passphrase() {
  return process.env.LOOM_AUTH_KEY || '';
}

function deriveKey(envelope) {
  const phrase = passphrase();
  if (phrase) {
    const salt = envelope.key && envelope.key.salt;
    if (!salt) throw new Error('Auth vault is missing its key salt.');
    return crypto.scryptSync(phrase, fromBase64(salt), KEY_BYTES);
  }
  const key = readKeyFile();
  if (!key || key.length !== KEY_BYTES) {
    throw new Error('Auth vault key is missing. Run "loom auth logout --all" and sign in again.');
  }
  return key;
}

function encryptVault(plain, createdAt) {
  const phrase = passphrase();
  /** @type {VaultData['key']} */
  let keyInfo;
  let key;
  if (phrase) {
    const salt = crypto.randomBytes(16);
    keyInfo = { source: 'env', kdf: 'scrypt', salt: base64(salt) };
    key = crypto.scryptSync(phrase, salt, KEY_BYTES);
  } else {
    key = createKeyFile();
    keyInfo = { source: 'file', kdf: 'none' };
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plain), 'utf8')),
    cipher.final(),
  ]);
  return {
    version: VAULT_VERSION,
    createdAt: createdAt || Date.now(),
    updatedAt: Date.now(),
    key: keyInfo,
    data: {
      iv: base64(iv),
      tag: base64(cipher.getAuthTag()),
      ciphertext: base64(ciphertext),
    },
  };
}

function decryptVault(envelope) {
  const key = deriveKey(envelope);
  const iv = fromBase64(envelope.data.iv);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(fromBase64(envelope.data.tag));
  const plain = Buffer.concat([
    decipher.update(fromBase64(envelope.data.ciphertext)),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8'));
}

function emptyVault() {
  return { version: 1, createdAt: Date.now(), updatedAt: Date.now(), credentials: {} };
}

/**
 * @returns {VaultPlain}
 */
function cloneVault(plain) {
  return JSON.parse(JSON.stringify(plain));
}

function readVault() {
  const file = vaultFile();
  if (!fs.existsSync(file)) return emptyVault();
  const stamp = fileStamp(file) + ':' + envStamp();
  if (vaultCache && vaultCache.stamp === stamp) return cloneVault(vaultCache.plain);
  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Auth vault is corrupt or unreadable: ' + file);
  }
  if (!envelope || envelope.version !== VAULT_VERSION || !envelope.data) {
    throw new Error('Auth vault has an unsupported format. Run "loom auth logout --all" and sign in again.');
  }
  try {
    const plain = decryptVault(envelope);
    if (!plain || typeof plain !== 'object') return emptyVault();
    if (!plain.credentials || typeof plain.credentials !== 'object') plain.credentials = {};
    vaultCache = { stamp, plain: cloneVault(plain) };
    return plain;
  } catch (err) {
    if (/Unsupported state|unable to authenticate|bad decrypt/i.test(String(err && err.message))) {
      throw new Error('Auth vault could not be decrypted. Check LOOM_AUTH_KEY or run "loom auth logout --all".');
    }
    throw err;
  }
}

function writeVault(plain) {
  ensureDir();
  const file = vaultFile();
  let createdAt = plain.createdAt;
  if (fs.existsSync(file)) {
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (existing && existing.createdAt) createdAt = existing.createdAt;
    } catch {}
  }
  const envelope = encryptVault(plain, createdAt);
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), { mode: 0o600 });
    securePath(tmp);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
  securePath(file);
  vaultCache = { stamp: fileStamp(file) + ':' + envStamp(), plain: cloneVault(plain) };
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(sleepCell, 0, 0, ms); }

function withLock(fn) {
  ensureDir();
  const file = lockFile();
  const started = Date.now();
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      try {
        const age = Date.now() - fs.statSync(file).mtimeMs;
        if (age > LOCK_STALE_MS) { fs.rmSync(file, { force: true }); continue; }
      } catch {}
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error('Auth vault is locked by another process. Try again.');
      }
      sleepSync(25);
    }
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

function fingerprintCredential(cred) {
  const secret = cred.apiKey || cred.refreshToken || cred.accessToken || '';
  if (!secret) return '';
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 12);
}

/**
 * @param {string} provider
 * @returns {StoredCredential | null}
 */
function getCredential(provider) {
  if (!provider) return null;
  const vault = readVault();
  return vault.credentials[provider] || null;
}

/**
 * @param {string} provider
 * @returns {boolean}
 */
function hasCredential(provider) {
  try {
    return !!getCredential(provider);
  } catch {
    return false;
  }
}

/**
 * Only API-type credentials can be used as generic API keys.
 * @param {string} provider
 * @returns {string | null}
 */
function getApiKeyCredential(provider) {
  try {
    const cred = getCredential(provider);
    if (!cred || cred.type !== 'api') return null;
    return cred.apiKey || null;
  } catch {
    return null;
  }
}

/**
 * @returns {Array<StoredCredential>}
 */
function listCredentials() {
  const vault = readVault();
  return Object.values(vault.credentials)
    .sort((a, b) => String(a.provider).localeCompare(String(b.provider)))
    .map((c) => {
      const { apiKey, accessToken, refreshToken, ...rest } = c;
      return {
        ...rest,
        hasApiKey: !!apiKey,
        hasAccessToken: !!accessToken,
        hasRefreshToken: !!refreshToken,
      };
    });
}

/**
 * @param {string} provider
 * @param {Partial<StoredCredential>} input
 * @returns {StoredCredential}
 */
function saveCredential(provider, input) {
  if (!provider || typeof provider !== 'string') throw new Error('A provider is required.');
  if (!input || typeof input !== 'object') throw new Error('Credential data is required.');
  return withLock(() => {
    const vault = readVault();
    const now = Date.now();
    const old = vault.credentials[provider];
    const nextType = input.type || (old && old.type) || 'api';
    const base = old ? { ...old } : {};
    if (old && nextType !== old.type) {
      delete base.apiKey;
      delete base.accessToken;
      delete base.refreshToken;
      delete base.expiresAt;
      delete base.tokenType;
      delete base.scopes;
      delete base.accountId;
      delete base.clientId;
    }
    /** @type {StoredCredential} */
    const cred = {
      ...base,
      provider,
      label: input.label || (old && old.label) || provider,
      method: input.method || (old && old.method) || 'api',
      type: nextType,
      createdAt: (old && old.createdAt) || now,
      updatedAt: now,
      fingerprint: '',
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      ...(input.accessToken !== undefined ? { accessToken: input.accessToken } : {}),
      ...(input.refreshToken !== undefined ? { refreshToken: input.refreshToken } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.tokenType !== undefined ? { tokenType: input.tokenType } : {}),
      ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.plan !== undefined ? { plan: input.plan } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      ...(input.extra !== undefined ? { extra: input.extra } : {}),
    };
    cred.fingerprint = fingerprintCredential(cred);
    vault.credentials[provider] = cred;
    vault.updatedAt = now;
    writeVault(vault);
    audit('save', provider, cred.method, 'ok');
    return cred;
  });
}

/**
 * @param {string} provider
 * @returns {boolean}
 */
function deleteCredential(provider) {
  return withLock(() => {
    const vault = readVault();
    if (!vault.credentials[provider]) return false;
    delete vault.credentials[provider];
    vault.updatedAt = Date.now();
    writeVault(vault);
    audit('delete', provider, null, 'ok');
    return true;
  });
}

function deleteAllCredentials() {
  return withLock(() => {
    let count = 0;
    try {
      count = Object.keys(readVault().credentials).length;
    } catch {}
    const vault = emptyVault();
    vault.credentials = {};
    try {
      writeVault(vault);
    } catch {
      // A corrupt/unreadable key file must not make "--all" impossible. Drop
      // the old key; the user explicitly asked to wipe every credential.
      try { fs.rmSync(keyFile(), { force: true }); } catch {}
      keyCache = null;
      writeVault(vault);
    }
    audit('delete-all', null, null, 'ok');
    return count;
  });
}

module.exports = {
  AAD,
  VAULT_VERSION,
  loomDir,
  vaultFile,
  keyFile,
  auditFile,
  readVault,
  writeVault,
  getCredential,
  hasCredential,
  getApiKeyCredential,
  listCredentials,
  saveCredential,
  deleteCredential,
  deleteAllCredentials,
  fingerprintCredential,
  audit,
};
