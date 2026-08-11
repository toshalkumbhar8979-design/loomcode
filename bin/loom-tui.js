#!/usr/bin/env node
// Loom Code — TUI launcher. Prefers bun for the TSX/JSX pipeline; falls back to
// plain node for environments without bun (the TUI will tell the user to install
// bun first).
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function findBun() {
  const candidates = [
    // Common install locations
    path.join(os.homedir(), '.bun', 'bin', 'bun.exe'),
    path.join(os.homedir(), '.bun', 'bin', 'bun'),
    '/usr/local/bin/bun',
    '/opt/homebrew/bin/bun',
    path.join(os.homedir(), 'bin', 'bun'),
    path.join(os.homedir(), '.local', 'bin', 'bun'),
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  // PATH lookup (fast)
  try {
    const out = require('child_process').execSync('bun --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim();
    if (out) return 'bun';
  } catch {}
  return null;
}

const entry = path.join(__dirname, '..', 'src', 'tui-open.tsx');
const bun = findBun();

if (bun) {
  const result = spawnSync(bun, ['run', entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });
  process.exit(result.status ?? 0);
}

console.log('Loom TUI requires bun (https://bun.sh) to run the TSX/JSX pipeline.');
console.log('Install bun first, then use: bun run ' + entry);
process.exit(1);
