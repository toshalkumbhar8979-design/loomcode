const os = require('os');

let cache = null;

function detect() {
  if (cache) return cache;
  const p = os.platform();
  const r = os.release();
  const a = os.arch();
  let wsl = false;
  if (p === 'linux') {
    try {
      const low = r.toLowerCase();
      if (low.includes('microsoft') || low.includes('wsl')) wsl = true;
    } catch (e) {}
  }
  cache = { platform: p, release: r, arch: a, isWSL: wsl };
  return cache;
}

function verifyCommand(cmd) {
  const info = detect();
  if (info.platform === 'win32') return 'cmd /c "' + cmd + '"';
  return cmd;
}

function shellEnv() {
  const info = detect();
  if (info.platform === 'win32') return 'powershell';
  return '/bin/bash';
}

module.exports = { detect, verifyCommand, shellEnv };