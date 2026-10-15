// Docker sandbox — a lightweight, isolated OS for the agent's shell commands.
//
// Flow (guided in the TUI via the /sandbox modal):
//   1. Step 1 checks Docker. If missing, the modal shows the download link
//      (installLink) + "open download page", sets config.sandbox.pending,
//      and the user can later say "docker is ready" or run /sandbox again.
//   2. Step 2 picks an OS from OS_CATALOG (alpine/debian/ubuntu — all
//      node images, ~250–900 MB). Step 3 pulls it, creates the single
//      GLOBAL loom-sandbox container with the PROJECT mounted at /workspace,
//      installs essentials (+ headless chromium when offered, best-effort)
//      and keeps the container idle-running.
//   3. With sandbox.enabled, the bash tool routes every command through
//      `docker exec` into that container instead of the host shell. File
//      tools stay on the host — the mount is the same directory, so reads
//      and writes are shared while side effects of commands stay contained.
//      ensureProjectMount() re-creates the container when the active project
//      changes, so every session/agent shares one sandbox.
//
// Security posture: no --privileged, no host network, only the project dir
// is mounted (rw), container runs as the image's default non-root user when
// possible. It is a blast-radius reducer, not a hostile-VM boundary.
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const { loadConfig, saveConfig } = require('../config/settings');

const CONTAINER = 'loom-sandbox';
const DEFAULT_IMAGE = 'node:20-alpine';
// Essentials installed on first setup: a POSIX shell with the tools the
// agent actually reaches for. node is already in the image. Chromium is a
// separate best-effort install (see setupSandbox).
const BASE_PACKAGES = 'git bash curl ripgrep coreutils';

/**
 * OS catalog offered by the /sandbox modal. All are lightweight, rootless-
 * friendly Linux userlands; the agent gets a full shell + headless browser
 * inside whichever it picks. `pkg` selects the package manager path.
 * @type {Array<{ id: string, label: string, image: string, sizeNote: string, pkg: 'apk'|'apt', browser: boolean }>}
 */
const OS_CATALOG = [
  { id: 'alpine', label: 'Alpine Linux', image: 'node:20-alpine', sizeNote: 'smallest & fastest (~250 MB)', pkg: 'apk', browser: true },
  { id: 'debian', label: 'Debian Slim', image: 'node:20-slim', sizeNote: 'broad binary compatibility (~600 MB)', pkg: 'apt', browser: true },
  { id: 'ubuntu', label: 'Ubuntu', image: 'node:20', sizeNote: 'full userland (~900 MB)', pkg: 'apt', browser: false },
];

/** @typedef {'not_installed'|'no_daemon'|'ready'} DockerState */

/**
 * Detect the Docker CLI + daemon. Injectable runner for tests.
 * @param {(cmd: string, args: string[]) => string} [runner]
 * @returns {{ state: DockerState, version: string }}
 */
function detectDocker(runner) {
  const run = runner || ((cmd, args) => execFileSync(cmd, args, {
    encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim());
  let version = '';
  try {
    version = run('docker', ['version', '--format', '{{.Server.Version}}']);
  } catch {
    // CLI missing entirely vs daemon down: `docker version` errors on both,
    // but `docker --version` still succeeds when only the daemon is down.
    try {
      run('docker', ['--version']);
      return { state: 'no_daemon', version: '' };
    } catch {
      return { state: 'not_installed', version: '' };
    }
  }
  if (!version) return { state: 'no_daemon', version: '' };
  return { state: 'ready', version };
}

/**
 * Platform-appropriate Docker install guide shown before the user leaves to
 * install. Mentions the restart when the installer requires one, and the
 * exact phrase that resumes setup after they come back.
 * @returns {string}
 */
function installGuide() {
  const plat = process.platform;
  const link = installLink();
  const steps = [];
  if (plat === 'win32') {
    steps.push('1. Download Docker Desktop for Windows: ' + link);
    steps.push('2. Run the installer. If it asks to enable WSL 2 / restart Windows — accept and RESTART your computer when it finishes.');
    steps.push('3. Start Docker Desktop and wait for it to say "running" in the tray (first start can take a minute).');
  } else if (plat === 'darwin') {
    steps.push('1. Download Docker Desktop for Mac: ' + link + ' (Apple chip or Intel — pick yours).');
    steps.push('2. Drag it to Applications and open it. Accept the terms; if macOS asks for a restart of privileges, let it.');
    steps.push('3. Wait for the whale icon to settle — Docker is ready when the dashboard shows "running".');
  } else {
    steps.push('1. Install Docker Engine: ' + link + ' (Ubuntu: `curl -fsSL https://get.docker.com | sh` then `sudo usermod -aG docker $USER` and log out/in).');
    steps.push('2. Start it: `sudo systemctl enable --now docker`.');
  }
  steps.push('4. Come back to THIS session and say: docker is ready');
  steps.push('   (or run /sandbox setup). Loom will build the sandbox automatically.');
  return [
    'Docker is not set up yet — install it once and the sandbox becomes permanent.',
    '',
    ...steps,
    '',
    'Your session is kept: nothing is lost while you install. Say "docker is ready" when done.',
  ].join('\n');
}

/**
 * Download page for the current platform (shown in the /sandbox modal).
 * @returns {string}
 */
function installLink() {
  if (process.platform === 'win32') return 'https://docs.docker.com/desktop/setup/install/windows-install/';
  if (process.platform === 'darwin') return 'https://docs.docker.com/desktop/setup/install/mac-install/';
  return 'https://docs.docker.com/engine/install/';
}

/**
 * Try to open the Docker download page in the user's default browser.
 * Best-effort — the URL is always printed as a fallback.
 * @returns {boolean} true if a browser spawn was attempted
 */
function openInstallPage() {
  const url = installLink();
  const { spawn } = require('child_process');
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true }).unref();
    else spawn('xdg-open', [url], { detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Current sandbox lifecycle state for display + gating.
 * @returns {{ docker: DockerState, dockerVersion: string, enabled: boolean, pending: boolean, container: 'running'|'stopped'|'absent', image: string, osId: string, projectRoot: string }}
 */
function sandboxStatus() {
  const cfg = loadConfig();
  const sandboxCfg = cfg.sandbox || {};
  const { state, version } = detectDocker();
  let container = /** @type {'running'|'stopped'|'absent'} */ ('absent');
  if (state === 'ready') {
    try {
      const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER],
        { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      container = out === 'true' ? 'running' : 'stopped';
    } catch {
      container = 'absent';
    }
  }
  return {
    docker: state,
    dockerVersion: version,
    enabled: !!sandboxCfg.enabled && container === 'running',
    pending: !!sandboxCfg.pending,
    container,
    image: sandboxCfg.image || DEFAULT_IMAGE,
    osId: sandboxCfg.osId || 'alpine',
    projectRoot: sandboxCfg.projectRoot || '',
  };
}

/**
 * Map a host working directory to its path inside the container. The project
 * root is mounted at /workspace; subdirectories map underneath it. Anything
 * OUTSIDE the project falls back to /workspace (the container has no other
 * mounts by design).
 * @param {string} [hostDir]
 * @param {string} [projectRoot]
 * @returns {string}
 */
function toSandboxPath(hostDir, projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  const dir = path.resolve(hostDir || root);
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '/workspace';
  return '/workspace/' + rel.split(path.sep).join('/');
}

/**
 * Run a shell command inside the sandbox container. Streams output via
 * onChunk('out'|'err') while running; resolves with { output, code } or
 * { error }.
 * @param {string} command
 * @param {{ workdir?: string, projectRoot?: string, timeoutMs?: number, onChunk?: (text: string, stream: 'out'|'err') => void }} [opts]
 * @returns {Promise<{ output: string, code: number }|{ error: string }>}
 */
function runInSandbox(command, opts) {
  const o = opts || {};
  // Shared container follows the active project (no-op when unchanged).
  const remount = ensureProjectMount(o.projectRoot);
  if (!remount.ok && remount.error !== 'sandbox disabled') {
    return Promise.resolve({ error: 'sandbox re-mount failed: ' + remount.error });
  }
  const wd = toSandboxPath(o.workdir, o.projectRoot);
  const timeoutMs = o.timeoutMs || 120000;
  return new Promise((resolve) => {
    let child;
    try {
      // sh -lc keeps pipes/redirections working; -i is not needed because
      // every exec is a fresh non-interactive shell.
      child = spawn('docker', ['exec', '-w', wd, CONTAINER, 'sh', '-lc', String(command || '')],
        { windowsHide: true });
    } catch (e) {
      resolve({ error: 'sandbox exec failed: ' + (e && e.message) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    let output = '';
    const MAX_OUT = 10 * 1024 * 1024;
    let truncated = false;
    const push = (/** @type {Buffer} */ d, /** @type {'out'|'err'} */ stream) => {
      const t = d.toString();
      if (!truncated) {
        if (output.length + t.length > MAX_OUT) { output = output.slice(0, MAX_OUT); truncated = true; }
        else output += t;
      }
      if (o.onChunk) { try { o.onChunk(t, stream); } catch {} }
    };
    child.stdout.on('data', (d) => push(d, 'out'));
    child.stderr.on('data', (d) => push(d, 'err'));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (truncated) output += '\n[output truncated at 10 MB]';
      resolve({ output: output || 'command completed', code: code == null ? 1 : code });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: 'sandbox exec failed: ' + err.message });
    });
  });
}

/**
 * Build the sandbox: pull the chosen OS image, (re)create the container with
 * the project mounted, install essentials (+ headless chromium when the OS
 * offers it). Idempotent — re-running refreshes. The container is a single
 * GLOBAL resource (~/.loom/config.json records it), so every session and
 * every agent shares the same sandbox; only the mounted project follows the
 * working directory via ensureProjectMount().
 * @param {{ osId?: string, projectRoot?: string, onLog?: (line: string) => void }} [opts]
 * @returns {Promise<{ ok: true, container: string }|{ ok: false, error: string }>}
 */
async function setupSandbox(opts) {
  const o = opts || {};
  const root = path.resolve(o.projectRoot || process.cwd());
  const log = o.onLog || (() => {});
  const { state, version } = detectDocker();
  if (state === 'not_installed') return { ok: false, error: 'Docker is not installed. Run /sandbox guide for setup steps.' };
  if (state === 'no_daemon') {
    return { ok: false, error: 'Docker is installed but the daemon is not running. Start Docker Desktop (or `sudo systemctl start docker`), then run /sandbox setup again.' };
  }
  const osEntry = OS_CATALOG.find((x) => x.id === o.osId) || OS_CATALOG[0];
  const image = osEntry.image;
  log('Docker ' + version + ' detected — using ' + osEntry.label + ' (' + image + ').');
  try {
    log('Pulling ' + image + ' (first run only)…');
    execFileSync('docker', ['pull', image], { encoding: 'utf8', windowsHide: true, timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
    // Recreate from scratch so image updates + mount changes always apply.
    try { execFileSync('docker', ['rm', '-f', CONTAINER], { windowsHide: true, timeout: 30000, stdio: 'ignore' }); } catch {}
    log('Creating container ' + CONTAINER + ' with ' + root + ' mounted at /workspace…');
    execFileSync('docker', [
      'create',
      '--name', CONTAINER,
      // Isolation: project dir only, no host network, no extra privileges.
      '-v', root + ':/workspace',
      '-w', '/workspace',
      // Idle-forever main process; every agent command is a docker exec.
      image, 'sleep', 'infinity',
    ], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('docker', ['start', CONTAINER], { windowsHide: true, timeout: 60000, stdio: 'ignore' });
    const pkgCmd = osEntry.pkg === 'apk'
      ? 'apk add --no-cache ' + BASE_PACKAGES
      : 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends ' + BASE_PACKAGES + ' && rm -rf /var/lib/apt/lists/*';
    log('Installing essentials (' + BASE_PACKAGES + ')…');
    execFileSync('docker', ['exec', CONTAINER, 'sh', '-lc', pkgCmd],
      { encoding: 'utf8', windowsHide: true, timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
    // Headless browser, when the chosen OS offers one — best-effort so a
    // missing chromium package never fails the whole setup.
    if (osEntry.browser) {
      const browserCmd = osEntry.pkg === 'apk'
        ? 'apk add --no-cache chromium'
        : 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*';
      log('Installing a headless Chromium (best-effort)…');
      try {
        execFileSync('docker', ['exec', CONTAINER, 'sh', '-lc', browserCmd],
          { encoding: 'utf8', windowsHide: true, timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        log('Chromium unavailable in this image — browser tooling will be limited (sandbox continues).');
      }
    }
    const cfg = loadConfig();
    cfg.sandbox = Object.assign({}, cfg.sandbox, {
      enabled: true, pending: false, image, osId: osEntry.id, projectRoot: root,
    });
    saveConfig(cfg);
    log('Sandbox ready' + (osEntry.browser ? ' — including a headless Chromium for the browser tool' : '') + '.');
    log('Agent commands now run inside ' + CONTAINER + ' (/workspace = this project). Every session and agent shares it.');
    return { ok: true, container: CONTAINER };
  } catch (e) {
    return { ok: false, error: 'Sandbox setup failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * Make sure the shared container mounts the CURRENT project. Sessions in
 * different directories share one sandbox — when the active project changes
 * we just re-create the container with the new mount (image stays cached).
 * Cheap no-op when the mount already matches.
 * @param {string} [projectRoot]
 * @returns {{ ok: true }|{ ok: false, error: string }}
 */
function ensureProjectMount(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  const cfg = loadConfig();
  if (!cfg.sandbox || !cfg.sandbox.enabled) return { ok: false, error: 'sandbox disabled' };
  if (cfg.sandbox.projectRoot === root) return { ok: true };
  const image = cfg.sandbox.image || DEFAULT_IMAGE;
  try {
    try { execFileSync('docker', ['rm', '-f', CONTAINER], { windowsHide: true, timeout: 30000, stdio: 'ignore' }); } catch {}
    execFileSync('docker', [
      'create', '--name', CONTAINER,
      '-v', root + ':/workspace', '-w', '/workspace',
      image, 'sleep', 'infinity',
    ], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('docker', ['start', CONTAINER], { windowsHide: true, timeout: 60000, stdio: 'ignore' });
    cfg.sandbox.projectRoot = root;
    saveConfig(cfg);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 're-mount failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * Should the bash tool route this command through the sandbox? Cheap config
 * check — container liveness is verified at setup time, and exec errors
 * surface per command.
 * @returns {boolean}
 */
function shouldUseSandbox() {
  if (process.env.LOOM_SANDBOX === '0') return false;
  const cfg = loadConfig();
  return !!(cfg.sandbox && cfg.sandbox.enabled);
}

/**
 * Toggle sandbox command routing (container keeps running either way).
 * @param {boolean} on
 */
function setSandboxEnabled(on) {
  const cfg = loadConfig();
  cfg.sandbox = Object.assign({}, cfg.sandbox, { enabled: !!on });
  saveConfig(cfg);
}

/**
 * Arm the "waiting for Docker install" flow: the TUI shows the guide and
 * tells the user to come back with "docker is ready".
 */
function markInstallPending() {
  const cfg = loadConfig();
  cfg.sandbox = Object.assign({}, cfg.sandbox, { pending: true });
  saveConfig(cfg);
}

/**
 * True when the user's message is the "docker is ready" resume signal while
 * an install is pending (or they explicitly ask to set up the sandbox).
 * @param {string} text
 * @returns {boolean}
 */
function isReadySignal(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 120) return false;
  if (t.endsWith('?')) return false; // a question ("is docker ready yet?") is not an announcement
  return /\bdocker\b/.test(t) && /\b(ready|installed|done|running|set ?up|finished)\b/.test(t);
}

module.exports = {
  CONTAINER,
  DEFAULT_IMAGE,
  OS_CATALOG,
  detectDocker,
  installGuide,
  installLink,
  openInstallPage,
  sandboxStatus,
  toSandboxPath,
  runInSandbox,
  setupSandbox,
  ensureProjectMount,
  shouldUseSandbox,
  setSandboxEnabled,
  markInstallPending,
  isReadySignal,
};
