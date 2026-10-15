// Docker sandbox — a lightweight, isolated Linux OS the agent can use ON
// DEMAND. It is NOT a routing layer: host commands (bash tool) keep running
// on the user's machine exactly as before. When the agent needs isolation
// (user asked for the sandbox, a risky command, a Linux-only tool), it calls
// the dedicated `sandbox` tool, which runs that ONE command via `docker exec`
// into a shared idle-running container.
//
// Flow (guided in the TUI via the /sandbox modal):
//   1. Step 1 checks Docker. If missing, the modal shows the download link
//      (installLink) + "open download page", sets config.sandbox.pending,
//      and the user can later say "docker is ready" or run /sandbox again.
//   2. Step 2 picks an OS from OS_CATALOG (alpine/debian/ubuntu — all
//      node images, ~250–900 MB). Step 3 pulls it, creates the single
//      GLOBAL loom-sandbox container with the PROJECT mounted at /workspace,
//      installs essentials (+ headless chromium when offered, best-effort)
//      and keeps the container idle-running in the background.
//   3. With sandbox.enabled, the sandbox TOOL becomes available. Each call
//      revives the container if it stopped (e.g. after a Docker restart) and
//      re-mounts the current project, then runs just that command. File
//      tools stay on the host — the mount is the same directory, so reads
//      and writes are shared while side effects of the command stay contained.
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
 * Run ONE shell command inside the sandbox container (used by the sandbox
 * tool — host commands stay on the bash tool). Revives the container if it
 * stopped and re-mounts the current project, then streams output via
 * onChunk('out'|'err'); resolves with { output, code } or { error }.
 * @param {string} command
 * @param {{ workdir?: string, projectRoot?: string, timeoutMs?: number, onChunk?: (text: string, stream: 'out'|'err') => void }} [opts]
 * @returns {Promise<{ output: string, code: number }|{ error: string }>}
 */
async function runInSandbox(command, opts) {
  const o = opts || {};
  // Bring the container back if the daemon restarted, then make sure it
  // mounts the CURRENT project (cheap no-op when both already match).
  const alive = await ensureContainerAlive();
  if (!alive.ok) return { error: alive.error };
  const remount = await ensureProjectMount(o.projectRoot);
  if (!remount.ok) return { error: 'sandbox re-mount failed: ' + remount.error };
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
 * Spawn a host command, line-buffer its output, never block the event loop.
 * Used by setupSandbox so the TUI keeps rendering (and the progress UI keeps
 * updating) while docker pull / package installs run.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, onLine?: (line: string, stream: 'out'|'err') => void }} [opts]
 * @returns {Promise<{ code: number, out: string }>}
 */
function spawnAsync(cmd, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, out: (e && e.message) || String(e) });
      return;
    }
    const timer = o.timeoutMs
      ? setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, o.timeoutMs)
      : null;
    let out = '';
    const MAX_OUT = 4 * 1024 * 1024;
    const feed = (/** @type {Buffer} */ d, /** @type {'out'|'err'} */ stream) => {
      const t = d.toString();
      if (out.length < MAX_OUT) out += t;
      if (!o.onLine) return;
      // Line-buffer: docker writes progress with \r on TTYs and \n otherwise;
      // treat both as separators so the UI gets fresh rows, not one blob.
      const lines = t.split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        try { o.onLine(line.replace(/\x1b\[[0-9;]*m/g, ''), stream); } catch {}
      }
    };
    child.stdout.on('data', (d) => feed(d, 'out'));
    child.stderr.on('data', (d) => feed(d, 'err'));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, out: (out ? out + '\n' : '') + err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code == null ? 1 : code, out });
    });
  });
}

// "12.34MB" / "951kB" / "1.2GB" → bytes (docker prints SI-style units).
function parseBytes(str, unit) {
  const n = parseFloat(str);
  if (!isFinite(n)) return 0;
  const u = String(unit || '').toLowerCase();
  if (u === 'gb') return n * 1e9;
  if (u === 'mb') return n * 1e6;
  if (u === 'kb') return n * 1e3;
  return n;
}

/**
 * Fold one docker-pull stdout line into the per-layer progress map. Layers
 * report "Downloading [bar] X/Y", "Extracting [bar] X/Y", then "Pull complete".
 * @param {string} line
 * @param {Map<string, number>} layers layer-id → fraction 0..1
 */
function trackPullLine(line, layers) {
  const done = /^([0-9a-f]{8,64}):\s+(?:Download complete|Pull complete)\s*$/i.exec(line);
  if (done) { layers.set(done[1], 1); return; }
  // "Waiting" = queued layer, no bytes yet.
  const waiting = /^([0-9a-f]{8,64}):\s+Waiting\s*$/i.exec(line);
  if (waiting) { layers.set(waiting[1], 0); return; }
  const active = /^([0-9a-f]{8,64}):\s+(?:Downloading|Extracting)\s+(?:\[[^\]]*\]\s+)?([\d.]+)([kmgt]?b)(?:\/([\d.]+)([kmgt]?b))?/i.exec(line);
  if (active) {
    const id = active[1];
    if (active[4]) {
      const total = parseBytes(active[4], active[5]);
      const cur = parseBytes(active[2], active[3]);
      if (total > 0) layers.set(id, Math.min(1, cur / total));
    } else if (!layers.has(id)) {
      layers.set(id, 0);
    }
  }
}

function pullPercent(layers) {
  if (!layers.size) return null;
  let sum = 0;
  for (const frac of layers.values()) sum += frac;
  return Math.min(99, Math.round((sum / layers.size) * 100));
}

/**
 * Build the sandbox: pull the chosen OS image, (re)create the container with
 * the project mounted, install essentials (+ headless chromium when the OS
 * offers it). Fully ASYNC — every docker call streams, so the TUI never
 * freezes and onProgress/onLog deliver live updates. The container is a
 * single GLOBAL resource (~/.loom/config.json records it), so every session and
 * every agent shares the same sandbox; only the mounted project follows the
 * working directory via ensureProjectMount().
 * @param {{ osId?: string, projectRoot?: string, onLog?: (line: string) => void, onProgress?: (p: { stage: string, pct: number|null, step: number, total: number }) => void }} [opts]
 * @returns {Promise<{ ok: true, container: string }|{ ok: false, error: string }>}
 */
async function setupSandbox(opts) {
  const o = opts || {};
  const root = path.resolve(o.projectRoot || process.cwd());
  const log = o.onLog || (() => {});
  const prog = o.onProgress || (() => {});
  const { state, version } = detectDocker();
  if (state === 'not_installed') return { ok: false, error: 'Docker is not installed. Run /sandbox guide for setup steps.' };
  if (state === 'no_daemon') {
    return { ok: false, error: 'Docker is installed but the daemon is not running. Start Docker Desktop (or `sudo systemctl start docker`), then run /sandbox setup again.' };
  }
  const osEntry = OS_CATALOG.find((x) => x.id === o.osId) || OS_CATALOG[0];
  const image = osEntry.image;
  log('Docker ' + version + ' detected — using ' + osEntry.label + ' (' + image + ').');
  // Stages reported to onProgress: pull → create → start → essentials → browser → done.
  const stages = ['pull', 'create', 'start', 'essentials'].concat(osEntry.browser ? ['browser'] : [], ['done']);
  const stageIdx = (/** @type {string} */ s) => { const i = stages.indexOf(s); return i < 0 ? 0 : i; };
  prog({ stage: 'pull', pct: 0, step: stageIdx('pull'), total: stages.length });

  // ── Stage 1: pull the image (real per-layer progress, async + streamed) ──
  log('Pulling ' + image + ' (first run only)…');
  const layers = new Map();
  let lastPct = -1;
  const pull = await spawnAsync('docker', ['pull', image], {
    timeoutMs: 600000,
    onLine: (line) => {
      trackPullLine(line, layers);
      const pct = pullPercent(layers);
      if (pct != null && pct !== lastPct) {
        lastPct = pct;
        prog({ stage: 'pull', pct, step: stageIdx('pull'), total: stages.length });
      }
      if (/^status:|^digest:|up to date/i.test(line)) log(line);
    },
  });
  if (pull.code !== 0) {
    return { ok: false, error: 'docker pull failed (exit ' + pull.code + '): ' + pull.out.slice(-400) };
  }
  prog({ stage: 'pull', pct: 100, step: stageIdx('pull'), total: stages.length });

  // ── Stage 2: recreate the container from scratch (image updates + mount) ──
  prog({ stage: 'create', pct: null, step: stageIdx('create'), total: stages.length });
  await spawnAsync('docker', ['rm', '-f', CONTAINER], { timeoutMs: 30000 });
  log('Creating container ' + CONTAINER + ' with ' + root + ' mounted at /workspace…');
  const create = await spawnAsync('docker', [
    'create',
    '--name', CONTAINER,
    // Isolation: project dir only, no host network, no extra privileges.
    '-v', root + ':/workspace',
    '-w', '/workspace',
    // Idle-forever main process; every agent command is a docker exec.
    image, 'sleep', 'infinity',
  ], { timeoutMs: 60000 });
  if (create.code !== 0) {
    return { ok: false, error: 'docker create failed (exit ' + create.code + '): ' + create.out.slice(-300) };
  }

  // ── Stage 3: start it (stays idle in the background until the sandbox
  // tool is explicitly invoked) ──
  prog({ stage: 'start', pct: null, step: stageIdx('start'), total: stages.length });
  const start = await spawnAsync('docker', ['start', CONTAINER], { timeoutMs: 60000 });
  if (start.code !== 0) {
    return { ok: false, error: 'docker start failed (exit ' + start.code + '): ' + start.out.slice(-300) };
  }

  // ── Stage 4: install essentials (streamed so the UI shows life) ──
  prog({ stage: 'essentials', pct: null, step: stageIdx('essentials'), total: stages.length });
  const pkgCmd = osEntry.pkg === 'apk'
    ? 'apk add --no-cache ' + BASE_PACKAGES
    : 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends ' + BASE_PACKAGES + ' && rm -rf /var/lib/apt/lists/*';
  log('Installing essentials (' + BASE_PACKAGES + ')…');
  const install = await spawnAsync('docker', ['exec', CONTAINER, 'sh', '-lc', pkgCmd], {
    timeoutMs: 600000,
    onLine: (line) => { if (!/^\s*$/.test(line)) log(line); },
  });
  if (install.code !== 0) {
    return { ok: false, error: 'package install failed (exit ' + install.code + '): ' + install.out.slice(-400) };
  }

  // ── Stage 5: headless browser when the OS offers one — best-effort, so a
  // missing chromium package never fails the whole setup. ──
  if (osEntry.browser) {
    prog({ stage: 'browser', pct: null, step: stageIdx('browser'), total: stages.length });
    const browserCmd = osEntry.pkg === 'apk'
      ? 'apk add --no-cache chromium'
      : 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*';
    log('Installing a headless Chromium (best-effort)…');
    const browser = await spawnAsync('docker', ['exec', CONTAINER, 'sh', '-lc', browserCmd], {
      timeoutMs: 600000,
      onLine: (line) => { if (!/^\s*$/.test(line)) log(line); },
    });
    if (browser.code !== 0) {
      log('Chromium unavailable in this image — browser tooling will be limited (sandbox continues).');
    }
  }

  prog({ stage: 'done', pct: 100, step: stageIdx('done'), total: stages.length });
  const cfg = loadConfig();
  cfg.sandbox = Object.assign({}, cfg.sandbox, {
    enabled: true, pending: false, image, osId: osEntry.id, projectRoot: root,
  });
  saveConfig(cfg);
  log('Sandbox ready' + (osEntry.browser ? ' — including a headless Chromium for the browser tool' : '') + '.');
  log('Container ' + CONTAINER + ' idles in the background; the sandbox tool uses it only when the agent needs a Linux environment.');
  return { ok: true, container: CONTAINER };
}

/**
 * Make sure the shared container mounts the CURRENT project. Sessions in
 * different directories share one sandbox — when the active project changes
 * we just re-create the container with the new mount (image stays cached).
 * Cheap no-op when the mount already matches. Fully async (never blocks the
 * TUI event loop).
 * @param {string} [projectRoot]
 * @returns {Promise<{ ok: true }|{ ok: false, error: string }>}
 */
async function ensureProjectMount(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  const cfg = loadConfig();
  if (!cfg.sandbox || !cfg.sandbox.enabled) return { ok: false, error: 'sandbox disabled' };
  if (cfg.sandbox.projectRoot === root) return { ok: true };
  const image = cfg.sandbox.image || DEFAULT_IMAGE;
  try {
    await spawnAsync('docker', ['rm', '-f', CONTAINER], { timeoutMs: 30000 });
    const create = await spawnAsync('docker', [
      'create', '--name', CONTAINER,
      '-v', root + ':/workspace', '-w', '/workspace',
      image, 'sleep', 'infinity',
    ], { timeoutMs: 60000 });
    if (create.code !== 0) return { ok: false, error: 're-mount create failed: ' + create.out.slice(-200) };
    const start = await spawnAsync('docker', ['start', CONTAINER], { timeoutMs: 60000 });
    if (start.code !== 0) return { ok: false, error: 're-mount start failed: ' + start.out.slice(-200) };
    cfg.sandbox.projectRoot = root;
    saveConfig(cfg);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 're-mount failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * Make sure the container exists and is RUNNING before a sandbox-tool call.
 * Revives a stopped container (Docker Desktop restart, reboot) with a quick
 * `docker start`; never recreates (image/mount are setup-time concerns).
 * @returns {Promise<{ ok: true }|{ ok: false, error: string }>}
 */
async function ensureContainerAlive() {
  const cfg = loadConfig();
  if (!cfg.sandbox || !cfg.sandbox.enabled) {
    return { ok: false, error: 'Sandbox is not set up. Run /sandbox (or /sandbox setup) first — it only takes a minute and is needed once.' };
  }
  if (process.env.LOOM_SANDBOX === '0') {
    return { ok: false, error: 'Sandbox disabled via LOOM_SANDBOX=0.' };
  }
  const inspect = await spawnAsync('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { timeoutMs: 15000 });
  if (inspect.code !== 0 || !inspect.out.trim()) {
    return { ok: false, error: 'Sandbox container is missing (deleted?). Run /sandbox setup again.' };
  }
  if (inspect.out.trim() === 'true') return { ok: true };
  const start = await spawnAsync('docker', ['start', CONTAINER], { timeoutMs: 60000 });
  if (start.code !== 0) {
    return { ok: false, error: 'Sandbox container exists but could not be started: ' + start.out.slice(-200) + '. If Docker was restarted, start it and try again.' };
  }
  return { ok: true };
}

/**
 * Is the sandbox TOOL available (set up and not kill-switched)? Used by the
 * sandbox tool to decide between running and a helpful "run /sandbox first"
 * error — NOT to route ordinary bash commands (those stay on the host).
 * @returns {boolean}
 */
function shouldUseSandbox() {
  if (process.env.LOOM_SANDBOX === '0') return false;
  const cfg = loadConfig();
  return !!(cfg.sandbox && cfg.sandbox.enabled);
}

/**
 * Toggle sandbox availability (the container idles either way).
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
  ensureContainerAlive,
  shouldUseSandbox,
  trackPullLine,
  pullPercent,
  setSandboxEnabled,
  markInstallPending,
  isReadySignal,
};
