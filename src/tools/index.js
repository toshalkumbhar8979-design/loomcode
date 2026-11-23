const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { glob: globLib } = require('glob');
const { commandRiskLabel } = require('../core/permissions');
const { loadConfig } = require('../config/settings');
const { withDeadline } = require('../core/deadline');
const dnsPromises = require('dns').promises;

const cwd = process.cwd();

function globIgnore(full) {
  const abs = full.startsWith('/') || /^[a-zA-Z]:/.test(full);
  if (!abs) return ['**/node_modules/**', '**/.git/**'];
  const base = path.posix.dirname(full);
  return ['node_modules', '.git'].map((n) => path.posix.join(base, '**', n, '**'));
}

function unquoteToken(token) {
  const t = String(token || '');
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function shellTokens(command) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '`' && quote !== "'") {
      cur += ch;
      if (i + 1 < command.length) cur += command[++i];
      has = true;
      continue;
    }
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        tokens.push(cur);
        cur = '';
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) tokens.push(cur);
  return tokens;
}

function isFlagToken(token) {
  return /^--?[A-Za-z]/.test(String(token || ''));
}

function commandTargets(args) {
  const targets = [];
  let stop = false;
  for (const t of args) {
    if (!stop && t === '--') {
      stop = true;
      continue;
    }
    if (!stop && isFlagToken(t)) continue;
    targets.push(t);
  }
  return targets;
}

function arrayArg(tokens) {
  return tokens.length > 1 ? `@(${tokens.join(',')})` : tokens[0];
}

function hasFlag(args, re) {
  return args.some((t) => re.test(unquoteToken(t)));
}

function splitRedirections(args) {
  const clean = [];
  const redirects = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^(?:[12]?>>?|\*>>?|&>>?)$/.test(a)) {
      redirects.push(a);
      if (i + 1 < args.length) redirects.push(args[++i]);
      continue;
    }
    if (/^(?:[12]?>>?|\*>>?|&>>?).+/.test(a) || /^[12]>&[12]$/.test(a)) {
      redirects.push(a);
      continue;
    }
    clean.push(a);
  }
  return { args: clean, redirects };
}

function lineCount(args, fallback) {
  for (let i = 0; i < args.length; i++) {
    const a = unquoteToken(args[i]);
    const m = /^--lines=(\d+)$/.exec(a) || /^-n(\d+)$/.exec(a) || /^-(\d+)$/.exec(a);
    if (m) return Number(m[1]);
    if ((a === '-n' || a === '--lines') && i + 1 < args.length) {
      const n = Number(unquoteToken(args[i + 1]));
      if (Number.isFinite(n) && n > 0) return n;
      i++;
    }
  }
  return fallback;
}

function fileTargets(args) {
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = unquoteToken(args[i]);
    if (a === '-n' || a === '--lines') {
      i++;
      continue;
    }
    if (/^--lines=/.test(a) || /^-n\d+$/.test(a) || /^-\d+$/.test(a)) continue;
    if (a === '-f' || a === '--follow' || a === '-q' || a === '--quiet' || a === '-v' || a === '--verbose') continue;
    if (isFlagToken(a)) continue;
    files.push(args[i]);
  }
  return files;
}

function normalizeRedirections(command) {
  return String(command || '')
    .replace(/&>\s*\/dev\/null/gi, '*> $null')
    .replace(/2>\s*\/dev\/null/gi, '2> $null')
    .replace(/1>\s*\/dev\/null/gi, '> $null')
    .replace(/>\s*\/dev\/null/gi, '> $null')
    .replace(/2>\s*NUL\b/gi, '2> $null')
    .replace(/>\s*NUL\b/gi, '> $null');
}

function splitCommandOps(command) {
  /** @type {Array<{cmd?: string, op?: string}>} */
  const out = [];
  let buf = '';
  let quote = null;
  let depth = 0;
  const flush = () => {
    const t = buf.trim();
    if (t) out.push({ cmd: t });
    buf = '';
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '`' && quote !== "'") {
      buf += ch;
      if (i + 1 < command.length) buf += command[++i];
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(' || ch === '{') {
      depth++;
      buf += ch;
      continue;
    }
    if (ch === ')' || ch === '}') {
      depth = Math.max(0, depth - 1);
      buf += ch;
      continue;
    }
    if (depth === 0) {
      const two = command.slice(i, i + 2);
      if (two === '&&' || two === '||') {
        flush();
        out.push({ op: two });
        i++;
        continue;
      }
      if (ch === ';' || ch === '|') {
        flush();
        out.push({ op: ch });
        continue;
      }
    }
    buf += ch;
  }
  flush();
  return out;
}

/**
 * Translate one POSIX-flavoured command into Windows PowerShell 5.1.
 * Models routinely emit `ls -la`, `cat file`, or `mkdir -p dir`; PowerShell
 * rejects those flags before the command runs. Only the leading utility is
 * rewritten; PowerShell cmdlets pass through untouched.
 * @param {string} command
 * @returns {string}
 */
function translateWindowsPart(command) {
  const c = String(command || '').trim();
  if (!c) return c;
  const tokens = shellTokens(c);
  if (!tokens.length) return c;
  const name = unquoteToken(tokens[0]).toLowerCase();
  const rawArgs = tokens.slice(1);
  const split = splitRedirections(rawArgs);
  const args = split.args;
  const targets = commandTargets(args);
  const redirects = split.redirects.length ? ' ' + split.redirects.join(' ') : '';
  const done = (out) => (out === c ? out : out + redirects);

  switch (name) {
    case 'ls': {
      const force = args.some((t) => {
        const a = unquoteToken(t);
        return a === '--all' || /^-[a-zA-Z]*a/.test(a);
      });
      return done(`Get-ChildItem${force ? ' -Force' : ''}${targets.length ? ' -Path ' + arrayArg(targets) : ''}`);
    }
    case 'cat':
      return targets.length ? done(`Get-Content ${arrayArg(targets)}`) : c;
    case 'pwd':
      return done('Get-Location');
    case 'cd': {
      const rest = args.filter((t) => unquoteToken(t) !== '/d');
      if (!rest.length) return done('Set-Location');
      if (rest.length > 1) return c;
      return done(`Set-Location -LiteralPath ${rest[0]}`);
    }
    case 'mkdir':
      return targets.length ? done(`New-Item -ItemType Directory -Force -Path ${arrayArg(targets)}`) : c;
    case 'rm': {
      const recursive = hasFlag(args, /^-[a-zA-Z]*r/i) || args.some((t) => unquoteToken(t) === '--recursive');
      const force = hasFlag(args, /^-[a-zA-Z]*f/i) || args.some((t) => unquoteToken(t) === '--force');
      if (!targets.length) return c;
      return done(`Remove-Item${recursive ? ' -Recurse' : ''}${force ? ' -Force' : ''} -LiteralPath ${arrayArg(targets)}`);
    }
    case 'cp': {
      const recursive = hasFlag(args, /^-[a-zA-Z]*r/i) || args.some((t) => unquoteToken(t) === '--recursive');
      if (!targets.length) return c;
      if (targets.length === 1) return done(`Copy-Item${recursive ? ' -Recurse' : ''} -Force ${targets[0]}`);
      if (targets.length === 2) return done(`Copy-Item${recursive ? ' -Recurse' : ''} -Force ${targets[0]} ${targets[1]}`);
      return done(`Copy-Item${recursive ? ' -Recurse' : ''} -Force -Path ${arrayArg(targets.slice(0, -1))} -Destination ${targets[targets.length - 1]}`);
    }
    case 'mv': {
      if (!targets.length) return c;
      if (targets.length === 1) return done(`Move-Item -Force ${targets[0]}`);
      if (targets.length === 2) return done(`Move-Item -Force ${targets[0]} ${targets[1]}`);
      return done(`Move-Item -Force -Path ${arrayArg(targets.slice(0, -1))} -Destination ${targets[targets.length - 1]}`);
    }
    case 'touch':
      return targets.length ? done(`New-Item -ItemType File -Force -Path ${arrayArg(targets)}`) : c;
    case 'which':
    case 'whereis': {
      const target = targets[0] || unquoteToken(args[0] || '');
      return target ? done(`(Get-Command ${target} -ErrorAction SilentlyContinue).Source`) : c;
    }
    case 'head': {
      const n = lineCount(args, 10);
      const files = fileTargets(args);
      if (!files.length) return done(`Select-Object -First ${n}`);
      return done(`Get-Content -LiteralPath ${arrayArg(files)} -TotalCount ${n}`);
    }
    case 'tail': {
      const n = lineCount(args, 10);
      const follow = args.some((t) => {
        const a = unquoteToken(t);
        return a === '-f' || a === '--follow';
      });
      const files = fileTargets(args);
      if (!files.length) return done(`Select-Object -Last ${n}`);
      return done(`Get-Content -LiteralPath ${arrayArg(files)} -Tail ${n}${follow ? ' -Wait' : ''}`);
    }
    case 'grep': {
      let recursive = false;
      let ignoreCase = false;
      let list = false;
      let invert = false;
      let fixed = false;
      const rest = [];
      for (let i = 0; i < args.length; i++) {
        const a = unquoteToken(args[i]);
        if (a === '--') {
          rest.push(...args.slice(i + 1));
          break;
        }
        if (a === '--recursive' || a === '--dereference-recursive') {
          recursive = true;
          continue;
        }
        if (a === '--ignore-case') {
          ignoreCase = true;
          continue;
        }
        if (a === '--files-with-matches') {
          list = true;
          continue;
        }
        if (a === '--invert-match') {
          invert = true;
          continue;
        }
        if (a === '--fixed-strings') {
          fixed = true;
          continue;
        }
        if (a === '-e' || a === '--regexp') {
          if (i + 1 < args.length) rest.push(args[++i]);
          continue;
        }
        if (isFlagToken(a)) {
          for (const ch of a.slice(1)) {
            if (ch === 'r' || ch === 'R') recursive = true;
            else if (ch === 'i') ignoreCase = true;
            else if (ch === 'l') list = true;
            else if (ch === 'v') invert = true;
            else if (ch === 'F') fixed = true;
          }
          continue;
        }
        rest.push(args[i]);
      }
      const pattern = rest.shift();
      if (!pattern) return c;
      const paths = rest;
      const opts = [];
      if (!ignoreCase) opts.push('-CaseSensitive');
      if (list) opts.push('-List');
      if (invert) opts.push('-NotMatch');
      if (fixed) opts.push('-SimpleMatch');
      const optText = opts.length ? ' ' + opts.join(' ') : '';
      if (recursive) {
        const pathText = paths.length ? ` -Path ${arrayArg(paths)}` : '';
        return done(`Get-ChildItem${pathText} -Recurse -File | Select-String -Pattern ${pattern}${optText}`);
      }
      const pathText = paths.length ? ` -Path ${arrayArg(paths)}` : '';
      return done(`Select-String${pathText} -Pattern ${pattern}${optText}`);
    }
    case 'find': {
      let dir = '.';
      let name = null;
      let type = null;
      let depth = null;
      let pathSeen = false;
      for (let i = 0; i < args.length; i++) {
        const a = unquoteToken(args[i]);
        if (a === '-name' || a === '-iname') {
          if (i + 1 < args.length) name = args[++i];
          continue;
        }
        if (a === '-type') {
          if (i + 1 < args.length) type = unquoteToken(args[++i]);
          continue;
        }
        if (a === '-maxdepth' || a === '-depth') {
          if (i + 1 < args.length) depth = unquoteToken(args[++i]);
          continue;
        }
        if (a === '-mindepth') {
          i++;
          continue;
        }
        if (isFlagToken(a)) return c;
        if (pathSeen) return c;
        dir = args[i];
        pathSeen = true;
      }
      let out = `Get-ChildItem -Path ${dir} -Recurse`;
      if (type === 'f') out += ' -File';
      else if (type === 'd') out += ' -Directory';
      if (name) out += ` -Filter ${name}`;
      if (depth) out += ` -Depth ${depth}`;
      return done(out);
    }
    case 'dir': {
      let recursive = false;
      let bare = false;
      let force = false;
      let translated = false;
      const paths = [];
      for (const t of args) {
        const a = unquoteToken(t);
        if (/^\/[a-zA-Z]+$/.test(a)) {
          translated = true;
          for (const ch of a.slice(1).toLowerCase()) {
            if (ch === 's') recursive = true;
            else if (ch === 'b') bare = true;
            else if (ch === 'a') force = true;
            else if (ch === 'w' || ch === 'p' || ch === 'q' || ch === 'o' || ch === 't') continue;
            else return c;
          }
        } else if (isFlagToken(a)) {
          return c;
        } else {
          paths.push(t);
        }
      }
      if (!translated) return c;
      let out = 'Get-ChildItem';
      if (paths.length) out += ` -Path ${arrayArg(paths)}`;
      if (recursive) out += ' -Recurse';
      if (force) out += ' -Force';
      if (bare) out += ' -Name';
      return done(out);
    }
    case 'env':
      return done('Get-ChildItem Env:');
    case 'date':
      return done('Get-Date');
    case 'ps':
      return done('Get-Process');
    case 'kill':
      return targets.length ? done(`Stop-Process -Id ${arrayArg(targets)} -Force`) : c;
    case 'export': {
      const assigns = args.map(unquoteToken).filter((a) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
      if (!assigns.length) return c;
      const out = assigns.map((a) => {
        const eq = a.indexOf('=');
        const key = a.slice(0, eq);
        const value = a.slice(eq + 1).replace(/`/g, '``').replace(/"/g, '`"');
        return `$env:${key} = "${value}"`;
      }).join('; ');
      return done(out);
    }
    case 'source':
      return targets.length ? done(`. ${targets[0]}`) : c;
    default:
      return c;
  }
}

/**
 * Normalize a command for Windows PowerShell 5.1: translate common Unix
 * utilities and rewrite `a && b` / `a || b` into PowerShell conditionals.
 * @param {string} command
 * @returns {string}
 */
function windowsShellCommand(command) {
  const c = normalizeRedirections(String(command || '').trim());
  if (!c) return c;
  const parts = splitCommandOps(c);
  /** @type {Array<{connector: string|null, segments: string[]}>} */
  const pipelines = [];
  /** @type {{connector: string|null, segments: string[]}|null} */
  let current = null;
  /** @type {string|null} */
  let pending = null;
  for (const part of parts) {
    if (part.op) {
      pending = part.op;
      continue;
    }
    const translated = translateWindowsPart(part.cmd || '');
    if (pending === '|' && current) {
      current.segments.push(translated);
    } else {
      if (current) pipelines.push(current);
      current = { connector: pending, segments: [translated] };
    }
    pending = null;
  }
  if (current) pipelines.push(current);
  if (!pipelines.length) return c;
  let out = pipelines[0].segments.join(' | ');
  for (let i = 1; i < pipelines.length; i++) {
    const p = pipelines[i];
    const body = p.segments.join(' | ');
    if (p.connector === '&&') out += `; if ($?) { ${body} }`;
    else if (p.connector === '||') out += `; if (-not $?) { ${body} }`;
    else out += `; ${body}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSRF guard (webfetch)
//
// The agent model decides which URLs webfetch opens, and prompt-injected page
// content can steer it toward "check http://169.254.169.254/latest/meta-data"
// or "read localhost:5984/_config". Those must fail closed:
//   - only http/https, never file:/ftp:/data: transport tricks
//   - loopback, link-local (cloud metadata!), RFC1918 private ranges, CGNAT,
//     IPv6 ULA/link-local and IPv4-mapped addresses are refused
//   - hostnames are resolved BEFORE connecting so a DNS name pointing into
//     internal space is caught (checking the literal hostname is not enough)
//   - redirects are followed manually and every hop re-checked, because a
//     public URL can bounce straight at an internal one
// ---------------------------------------------------------------------------
/**
 * True when an IPv4/IPv6 address string falls in a range the agent must never
 * fetch (loopback, link-local/metadata, private, CGNAT, malformed).
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateAddress(ip) {
  const s = String(ip || '').toLowerCase();
  // IPv6 handling first: exact forms and prefix families we care about.
  if (s.includes(':')) {
    let bare = s.replace(/^\[|\]$/g, '');
    if (bare === '::' || bare === '::1') return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;      // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;      // fe80::/10 link-local
    if (/^2001:db8:/.test(bare)) return true;              // documentation
    return false;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return true;                 // malformed → refuse
  const [a, b] = o;
  return (
    a === 0 ||                                             // this-network
    a === 10 ||                                            // RFC1918
    a === 127 ||                                           // loopback
    (a === 100 && b >= 64 && b <= 127) ||                  // CGNAT 100.64/10
    (a === 169 && b === 254) ||                            // link-local / metadata
    (a === 172 && b >= 16 && b <= 31) ||                   // RFC1918
    (a === 192 && b === 168)                               // RFC1918
  );
}

/**
 * Resolve a URL's host and report whether every resolved address is public.
 * Unresolvable hosts fail closed (false).
 * @param {URL} u
 * @returns {Promise<boolean>}
 */
async function urlIsPublic(u) {
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (isPrivateAddress(host)) return false;
  let addrs;
  try {
    addrs = /** @type {{address: string}[]} */ (await dnsPromises.lookup(host, { all: true }));
  } catch {
    return false;
  }
  return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
}

const MODES = ['build', 'plan', 'chat'];

// Tools that never mutate the filesystem/state — safe to expose in plan mode.
// task delegates to a read-only-or-not subagent, so from the CALLER's side it
// is safe in plan mode (the subagent's own tool list gates what it may do).
const READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'webfetch', 'websearch', 'todowrite', 'todoread', 'task', 'spawn_agents'];

// Optional path sandbox: when config.sandbox.paths is set, filesystem tools
// only operate inside those roots (defense in depth on top of permissions).
function sandboxRoots() {
  const cfg = loadConfig();
  const paths = cfg.sandbox && Array.isArray(cfg.sandbox.paths) ? cfg.sandbox.paths : null;
  return paths && paths.length ? paths : null;
}

function pathAllowed(absPath) {
  const roots = sandboxRoots();
  if (!roots) return true;
  const abs = path.resolve(absPath);
  return roots.some((r) => {
    const root = path.resolve(r);
    return abs === root || abs.startsWith(root + path.sep);
  });
}

function sandboxDenied(toolName, absPath) {
  return `Blocked by sandbox: ${toolName} on ${absPath} is outside config sandbox.paths (${sandboxRoots().join(', ')})`;
}

const TOOLS = {
  read: {
    name: 'read',
    description: 'Read a file from the local filesystem.',
    parameters: {
      filePath: { type: 'string', required: true, description: 'Absolute path to the file' },
      offset: { type: 'number', required: false, description: 'Line number to start reading from' },
      limit: { type: 'number', required: false, description: 'Max lines to read' },
    },
    async execute(params) {
      const filePath = path.resolve(params.filePath);
      if (!pathAllowed(filePath)) return { error: sandboxDenied('read', filePath) };
      if (!fsSync.existsSync(filePath)) return { error: `File not found: ${filePath}` };
      // Binary detection: a NUL byte in the first 8 KB means this isn't text —
      // reading it as utf8 produces garbage that poisons the context.
      const stat = fsSync.statSync(filePath);
      if (stat.size > 0) {
        const fd = fsSync.openSync(filePath, 'r');
        try {
          const head = Buffer.alloc(Math.min(8192, stat.size));
          fsSync.readSync(fd, head, 0, head.length, 0);
          if (head.includes(0)) {
            return `[binary file: ${filePath} — ${stat.size} bytes, content omitted]`;
          }
        } catch {
          // Unreadable head (device/fifo?) — fall through and try normally.
        } finally {
          fsSync.closeSync(fd);
        }
      }
      // Size cap: huge files are read up to 2000 lines (or the requested
      // window) instead of slurping megabytes into the context.
      const MAX_FILE_BYTES = 512 * 1024;
      const content = stat.size > MAX_FILE_BYTES && !params.offset && !params.limit
        ? (await fs.readFile(filePath, 'utf8')).split('\n').slice(0, 2000).join('\n') +
          `\n[file truncated at 2000 lines (${stat.size} bytes total) — pass offset/limit to read more]`
        : await fs.readFile(filePath, 'utf8');
      const lines = content.split('\n');
      const start = (params.offset || 1) - 1;
      const end = params.limit ? start + params.limit : lines.length;
      const result = lines.slice(start, end).map((l,i) => `${start+i+1}: ${l}`).join('\n');
      return result;
    }
  },
  write: {
    name: 'write',
    description: 'Write a file to the local filesystem. Creates or completely replaces a file and any missing parent directories. Prefer the edit tool for targeted changes to an existing file; use write when creating a new file or replacing the whole file.',
    parameters: {
      filePath: { type: 'string', required: true, description: 'Absolute path to the file' },
      content: { type: 'string', required: true, description: 'Content to write' },
    },
    async execute(params) {
      const dest = path.resolve(params.filePath);
      if (!pathAllowed(dest)) return { error: sandboxDenied('write', dest) };
      const dir = path.dirname(dest);
      if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
      await fs.writeFile(dest, params.content, 'utf8');
      let extra = '';
      try { extra = await require('../core/format').formatAfterWrite(dest); } catch {}
      return `File written: ${dest}${extra}`;
    }
  },
  edit: {
    name: 'edit',
    description: 'Performs exact string replacements in files. Use edit for targeted changes: oldString must match exactly and must occur exactly once unless replaceAll is true, and oldString/newString must differ. Pass either oldString/newString for one replacement, or an edits array of {oldString, newString, replaceAll?} entries applied in order (prefer this over several edit calls on the same file).',
    parameters: {
      filePath: { type: 'string', required: true, description: 'Absolute path to the file' },
      oldString: { type: 'string', required: false, description: 'Exact text to replace (single edit)' },
      newString: { type: 'string', required: false, description: 'Replacement text (must differ from oldString)' },
      edits: { type: 'array', required: false, description: 'Multiple edits applied in order: [{oldString, newString, replaceAll?}, ...]' },
      replaceAll: { type: 'boolean', required: false, description: 'Replace all occurrences of oldString (default false)' },
      dryRun: { type: 'boolean', required: false, description: 'Preview the edit without writing' },
    },
    async execute(params) {
      const filePath = path.resolve(params.filePath);
      if (!pathAllowed(filePath)) return { error: sandboxDenied('edit', filePath) };
      if (!fsSync.existsSync(filePath)) return { error: `File not found: ${filePath}` };
      let content = await fs.readFile(filePath, 'utf8');
      // Apply each {oldString, newString} in order against the in-memory copy,
      // then write once. Sequential application means a later edit can target
      // text an earlier edit inserted. Every entry must be a real change with a
      // unique match (unless replaceAll) — silently replacing the first of
      // several matches is how files get corrupted.
      const multi = Array.isArray(params.edits) && params.edits.length > 0;
      const edits = multi
        ? params.edits
        : (params.oldString != null || params.newString != null
          ? [{ oldString: params.oldString, newString: params.newString, replaceAll: params.replaceAll }]
          : []);
      if (!edits.length) return { error: 'edit needs oldString/newString or an edits array' };
      const applied = [];
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i] || {};
        const oldStr = e.oldString;
        const newStr = e.newString;
        const prefix = multi ? `edits[${i}]: ` : '';
        if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
          return { error: `${prefix}oldString and newString must be strings` };
        }
        if (oldStr === '') {
          return { error: `${prefix}oldString cannot be empty when editing an existing file — use write for a full-file replacement` };
        }
        if (oldStr === newStr) {
          return { error: `${prefix}oldString and newString are identical — no changes to apply` };
        }
        const count = content.split(oldStr).length - 1;
        if (count === 0) return { error: `${prefix}oldString not found in content` };
        if (e.replaceAll) {
          content = content.split(oldStr).join(newStr);
          applied.push(`replaced ${count} occurrences`);
        } else {
          if (count > 1) {
            return { error: `${prefix}found ${count} matches for oldString — provide more context to make it unique, or set replaceAll to true` };
          }
          content = content.replace(oldStr, newStr.replace(/\$/g, '$$$$'));
          applied.push('replaced 1 occurrence');
        }
      }
      if (params.dryRun) {
        return `Dry run — would edit ${filePath}: ${applied.join('; ')} (file not modified).\n${content.slice(0, 4000)}`;
      }
      await fs.writeFile(filePath, content, 'utf8');
      let extra = '';
      try { extra = await require('../core/format').formatAfterWrite(filePath); } catch {}
      return `Edited ${filePath}: ${applied.join('; ')}${extra}`;
    }
  },
  bash: {
    name: 'bash',
    description: 'Execute a shell command on the user\'s machine. On Windows this runs Windows PowerShell 5.1: prefer PowerShell cmdlets (Get-ChildItem, Get-Content, New-Item, Select-String) and avoid Unix-only flags. Common Unix commands (ls/cat/mkdir/rm/cp/mv/touch/grep/find/head/tail), pipes, &&/||, ;, and /dev/null redirections are translated automatically, but PowerShell syntax is safer. Pass workdir instead of cd — each call starts a fresh shell. Pass sandbox:true to run it INSIDE the Docker sandbox instead (docker exec into loom-sandbox, project at /workspace) — required for anything the user asks to run "in the sandbox".',
    parameters: {
      command: { type: 'string', required: true, description: 'The command to execute' },
      workdir: { type: 'string', required: false, description: 'Working directory' },
      timeoutMs: { type: 'number', required: false, description: 'Kill the command after this many ms (default 60000, max 600000)' },
      background: { type: 'boolean', required: false, description: 'Run without waiting (dev servers, long builds). Returns a task id immediately; check with the /tasks panel or the tasks tool.' },
      sandbox: { type: 'boolean', required: false, description: 'Run this command inside the Docker sandbox container only when the user explicitly asked for sandbox/isolation; otherwise omit it and run on the host.' },
    },
    async execute(params, ctx) {
      // Sandbox opt-in: the SAME command goes through docker exec into the
      // loom-sandbox container — never a silent host fallback if the
      // container is unavailable (the error tells the model what to do).
      if (params.sandbox && !params.background) {
        const sandbox = require('../core/sandbox');
        const risk = params._approved ? null : commandRiskLabel(params.command);
        if (risk) return { error: `Blocked by safety filter: ${risk}. Approve it via the permission prompt to run it anyway.` };
        const stream = ctx && typeof ctx.stream === 'function' ? ctx.stream : null;
        const res = await sandbox.runInSandbox(params.command, {
          workdir: params.workdir || cwd,
          timeoutMs: typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? Math.min(params.timeoutMs, 600000) : 120000,
          onChunk: stream ? (text, which) => stream(text, which) : undefined,
        });
        if ('error' in res) return { error: res.error };
        let out = res.output;
        if (res.code !== 0) out += `\n[exit code: ${res.code}]`;
        return out || 'command completed';
      }
      // Host commands on Windows go through PowerShell 5.1. Translate the
      // Unix idioms models habitually emit (ls -la, cat, &&) before they hit
      // the shell; sandbox commands below stay untouched (Linux container).
      const hostCommand = process.platform === 'win32' ? windowsShellCommand(params.command) : params.command;
      // Background mode: fire-and-forget via the task registry.
      if (params.background) {
        const bt = require('../core/background-tasks');
        if (!pathAllowed(params.workdir || cwd)) return { error: sandboxDenied('bash', params.workdir || cwd) };
        const risk = params._approved ? null : commandRiskLabel(params.command);
        if (risk) return { error: `Blocked by safety filter: ${risk}. Approve it via the permission prompt to run it anyway.` };
        const res = /** @type {{id:string}|{error:string}} */ (bt.startBackgroundTask(hostCommand));
        if ('error' in res) return { error: res.error };
        return `Started background task ${res.id}. Keep working; check output with /tasks (or bash background:false re-run).`;
      }
      // Live terminal execution: when the TUI is watching, prefer a PTY so
      // the command sees a real terminal (colors, progress, interactive CLIs)
      // and chunks stream into the transcript as they arrive. If the PTY
      // cannot be created, fall through to the pipe implementation below.
      const stream = ctx && typeof ctx.stream === 'function' ? ctx.stream : null;
      if (stream && process.env.LOOM_PTY !== '0') {
        const pty = require('../core/pty');
        if (pty.available()) {
          const dir = params.workdir || cwd;
          if (!pathAllowed(dir)) return { error: sandboxDenied('bash', dir) };
          const risk = params._approved ? null : commandRiskLabel(params.command);
          if (risk) return { error: `Blocked by safety filter: ${risk}. Approve it via the permission prompt to run it anyway.` };
          if (!params.command.trim()) return 'command completed (empty)';
          const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 60000, 1000), 600000);
          const res = await pty.run(hostCommand, {
            cwd: dir,
            timeoutMs,
            signal: ctx && ctx.signal,
            onChunk: (text) => { try { stream(text, 'out'); } catch {} },
          });
          if (!res.fallback) {
            let out = res.output;
            if (res.timedOut) out += `\n[timed out after ${Math.round(timeoutMs / 1000)}s — killed]`;
            else if (res.aborted) out += '\n[aborted by user]';
            else if (res.code !== 0) out += `\n[exit code: ${res.code}]`;
            return out || 'command completed';
          }
        }
      }
      return new Promise((resolve) => {
        const dir = params.workdir || cwd;
        if (!pathAllowed(dir)) { resolve({ error: sandboxDenied('bash', dir) }); return; }
        const risk = params._approved ? null : commandRiskLabel(params.command);
        if (risk) {
          resolve({ error: `Blocked by safety filter: ${risk}. Approve it via the permission prompt to run it anyway.` });
          return;
        }
        try {
          if (!params.command.trim()) { resolve('command completed (empty)'); return; }
          const opts = { cwd: dir, windowsHide: true };
          const isWin = process.platform === 'win32';
          const child = isWin
            ? spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + hostCommand], opts)
            : spawn('/bin/sh', ['-c', params.command], opts);
          // Kill after timeoutMs (default 60s, cap 600s) so a hung command
          // can never wedge the turn forever.
          const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 60000, 1000), 600000);
          let timedOut = false;
          let aborted = false;
          const killChild = () => {
            if (isWin) {
              // taskkill can itself block while a process tree is unwinding;
              // launching it asynchronously preserves the tool's deadline.
              try {
                const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
                killer.unref();
              } catch {}
            }
            try { child.kill('SIGKILL'); } catch {}
          };
          let killTimer = null;
          // ESC/interrupt: the session's abort signal kills the running
          // command so the user isn't left waiting on a zombie process.
          const sig = ctx && ctx.signal;
          if (sig) {
            if (sig.aborted) { aborted = true; killChild(); }
            else {
              const onAbort = () => {
                aborted = true;
                if (killTimer) clearTimeout(killTimer);
                killChild();
                setTimeout(() => finish(null), 250);
              };
              try { sig.addEventListener('abort', onAbort, { once: true }); child.on('close', () => { try { sig.removeEventListener('abort', onAbort); } catch {} }); } catch {}
            }
          }
          let stdout = '';
          let stderr = '';
          let truncated = false;
          const MAX_OUT = 10 * 1024 * 1024;
          // Live terminal output: every chunk is relayed to the UI (the TUI
          // streams it in a collapsible block) while the command runs, and the
          // final accumulated output still lands in the tool result. The
          // accumulated copy is capped at 10 MB; the live stream keeps going.
          const stream = ctx && typeof ctx.stream === 'function' ? ctx.stream : null;
          child.stdout.on('data', d => {
            const t = d.toString();
            if (!truncated) {
              if (stdout.length + t.length > MAX_OUT) { stdout = stdout.slice(0, MAX_OUT); truncated = true; }
              else stdout += t;
            }
            if (stream) { try { stream(t, 'out'); } catch {} }
          });
          child.stderr.on('data', d => {
            const t = d.toString();
            if (!truncated) {
              if (stderr.length + t.length > MAX_OUT) { stderr = stderr.slice(0, MAX_OUT); truncated = true; }
              else stderr += t;
            }
            if (stream) { try { stream(t, 'err'); } catch {} }
          });
          let settled = false;
          const finish = (code) => {
            if (settled) return;
            settled = true;
            if (killTimer) clearTimeout(killTimer);
            let result = '';
            if (stdout) result += stdout;
            if (stderr) result += `\n[stderr]\n${stderr}`;
            if (timedOut) result += `\n[timed out after ${Math.round(timeoutMs / 1000)}s — killed]`;
            else if (aborted) result += '\n[aborted by user]';
            else if (code !== 0) result += `\n[exit code: ${code}]`;
            if (truncated) result += '\n[output truncated at 10 MB]';
            resolve(result || 'command completed');
          };
          // Windows sometimes keeps the PowerShell pipe open after taskkill.
          // Resolve shortly after killing so a tool timeout is always bounded.
          killTimer = setTimeout(() => {
            timedOut = true;
            killChild();
            setTimeout(() => finish(null), 250);
          }, timeoutMs);
          child.on('close', finish);
          child.on('error', (err) => {
            if (settled) return;
            settled = true;
            if (killTimer) clearTimeout(killTimer);
            resolve({ error: `Error executing command: ${err.message}` });
          });
        } catch (e) {
          resolve({ error: `Error executing command: ${e.message}` });
        }
      });
    }
  },
  sandbox: {
    name: 'sandbox',
    description: 'Run a shell command INSIDE the Docker sandbox via `docker exec loom-sandbox sh -lc "<command>"` (isolated Linux container, project at /workspace). Use only when the user explicitly asks for the sandbox or isolation. Equivalent to bash with sandbox:true. One command per call.',
    parameters: {
      command: { type: 'string', required: true, description: 'The Linux shell command to run inside the container' },
      workdir: { type: 'string', required: false, description: 'Working directory inside the container (host paths under the project map to /workspace/...)' },
      timeoutMs: { type: 'number', required: false, description: 'Kill the command after this many ms (default 120000)' },
    },
    async execute(params, ctx) {
      // Opt-in isolation path: nothing is routed here automatically. The
      // container is revived/re-mounted on demand, then torn back to idle.
      const sandbox = require('../core/sandbox');
      const risk = params._approved ? null : commandRiskLabel(params.command);
      if (risk) return { error: `Blocked by safety filter: ${risk}. Approve it via the permission prompt to run it anyway.` };
      const stream = ctx && typeof ctx.stream === 'function' ? ctx.stream : null;
      const res = await sandbox.runInSandbox(params.command, {
        workdir: params.workdir || cwd,
        timeoutMs: typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : undefined,
        onChunk: stream ? (text, which) => stream(text, which) : undefined,
      });
      if ('error' in res) return { error: res.error };
      let out = res.output;
      if (res.code !== 0) out += `\n[exit code: ${res.code}]`;
      return out || 'command completed';
    }
  },
  grep: {
    name: 'grep',
    description: 'Search file contents using regular expressions.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regex pattern to search for' },
      path: { type: 'string', required: false, description: 'Directory to search in' },
      include: { type: 'string', required: false, description: 'File pattern to include' },
    },
    async execute(params) {
      const dir = (params.path || cwd).replace(/\\/g, '/');
      const include = (params.include || '**/*').replace(/\\/g, '/');
      const regex = new RegExp(params.pattern);
      const full = include.startsWith('/') || /^[a-zA-Z]:/.test(include)
        ? include
        : path.posix.join(dir, include);
      if (!pathAllowed(dir) || !pathAllowed(full)) return { error: sandboxDenied('grep', full) };
      const files = globLib.sync(full, { nodir: true, ignore: globIgnore(full) });
      const results = [];
      for (const file of files.slice(0, 50)) {
        try {
          const content = await fs.readFile(file, 'utf8');
          const lines = content.split('\n');
          lines.forEach((line, i) => {
            if (regex.test(line)) results.push(`${file}:${i+1}: ${line.trim().slice(0, 200)}`);
          });
        } catch {}
      }
      return results.join('\n') || 'No matches found';
    }
  },
  glob: {
    name: 'glob',
    description: 'Find files matching pattern.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Glob pattern' },
      path: { type: 'string', required: false, description: 'Directory to search in' },
    },
    async execute(params) {
      const dir = (params.path || cwd).replace(/\\/g, '/');
      const pattern = params.pattern.replace(/\\/g, '/');
      const full = pattern.startsWith('/') || /^[a-zA-Z]:/.test(pattern)
        ? pattern
        : path.posix.join(dir, pattern);
      if (!pathAllowed(dir) || !pathAllowed(full)) return { error: sandboxDenied('glob', full) };
      const files = globLib.sync(full, { nodir: true, ignore: globIgnore(full) });
      return files.slice(0, 100).join('\n') || 'No files found';
    }
  },
  webfetch: {
    name: 'webfetch',
    description: 'Fetch content from a URL.',
    parameters: {
      url: { type: 'string', required: true, description: 'URL to fetch' },
    },
    async execute(params, ctx) {
      let u;
      try {
        u = new URL(String(params.url || ''));
      } catch {
        return { error: 'Invalid URL' };
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { error: 'Blocked by webfetch policy: only http/https URLs are allowed' };
      }
      try {
        // Follow redirects manually so every hop passes the SSRF guard — a
        // public URL may legitimately bounce into an internal address.
        let current = u;
        // ESC/interrupt kills the in-flight fetch (ctx.signal) alongside the
        // 15s timeout so the turn never hangs on a stalled connection.
        const timeoutSignal = AbortSignal.timeout(15000);
        const signal = (ctx && ctx.signal) ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
        for (let hop = 0; hop < 5; hop++) {
          if (!(await urlIsPublic(current))) {
            return { error: `Blocked by webfetch policy: ${current.hostname} resolves to a private/reserved address (SSRF guard)` };
          }
          const resp = await fetch(current.toString(), { redirect: 'manual', signal });
          if ([301, 302, 303, 307, 308].includes(resp.status)) {
            const loc = resp.headers.get('location');
            try { resp.body && resp.body.cancel(); } catch {}
            if (!loc) return { error: `Fetch failed: redirect ${resp.status} without Location header` };
            current = new URL(loc, current);
            continue;
          }
          const text = await resp.text();
          return text.slice(0, 10000);
        }
        return { error: 'Fetch failed: too many redirects' };
      } catch (e) {
        return { error: `Fetch failed: ${e.message}` };
      }
    }
  },
  websearch: {
    name: 'websearch',
    description: 'Web search. Uses Brave (BRAVE_API_KEY) or Tavily (TAVILY_API_KEY) when configured, then open-source SearXNG (set SEARXNG_URL or use public instances), then the DuckDuckGo HTML endpoint and Wikipedia — all no-key fallbacks. Returns top results with titles, URLs and snippets.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query' },
      count: { type: 'number', required: false, description: 'Max results 1-10 (default 6)' },
    },
    async execute(params) {
      const q = String(params.query || '').trim();
      if (!q) return { error: 'websearch needs a non-empty query.' };
      const n = Math.max(1, Math.min(10, Number(params.count) || 6));
      const decode = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      try {
        // 1) Brave
        if (process.env.BRAVE_API_KEY) {
          const r = await fetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(q) + '&count=' + n, { headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
          const j = /** @type {{web?: {results?: any[]}}} */ (await r.json());
          const rows = (j.web && j.web.results || []).slice(0, n).map((x, i) => `${i + 1}. ${decode(x.title)}\n   ${x.url}\n   ${decode(x.description).slice(0, 220)}`);
          return rows.length ? rows.join('\n') : 'No results for "' + q + '".';
        }
        // 2) Tavily
        if (process.env.TAVILY_API_KEY) {
          const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: q, max_results: n }), signal: AbortSignal.timeout(15000) });
          const j = /** @type {{results?: any[]}} */ (await r.json());
          const rows = (j.results || []).slice(0, n).map((x, i) => `${i + 1}. ${decode(x.title)}\n   ${x.url}\n   ${decode(x.content).slice(0, 220)}`);
          return rows.length ? rows.join('\n') : 'No results for "' + q + '".';
        }
        // 3) Open-source SearXNG (no key). Use SEARXNG_URL for a self-hosted
        // instance, SEARXNG_INSTANCES for a comma list, else a few public ones.
        const envUrl = String(process.env.SEARXNG_URL || '').trim();
        const envList = String(process.env.SEARXNG_INSTANCES || '').split(',').map(s => s.trim()).filter(Boolean);
        const searx = envUrl ? [envUrl] : envList.length ? envList : [
          'https://searx.be',
          'https://search.inetol.net',
          'https://searx.tiekoetter.com',
          'https://priv.au',
        ];
        for (const base of searx) {
          try {
            const endpoint = new URL(String(base).replace(/\/+$/, '') + '/search');
            endpoint.searchParams.set('q', q);
            endpoint.searchParams.set('format', 'json');
            endpoint.searchParams.set('safesearch', '1');
            const r = await fetch(endpoint.toString(), {
              signal: AbortSignal.timeout(6000),
              headers: { Accept: 'application/json', 'User-Agent': 'LoomCode/1.7 (+https://github.com/toshalkumbhar8979-design/loomcode)' },
            });
            if (!r.ok) continue;
            const j = /** @type {{results?: any[]}} */ (await r.json());
            const rows = (j.results || []).slice(0, n).map((x, i) =>
              `${i + 1}. ${decode(x.title)}\n   ${x.url}\n   ${decode(x.content || x.snippet).slice(0, 220)}`);
            if (rows.length) return rows.join('\n');
          } catch {}
        }

        // 4) DuckDuckGo HTML fallback (no key)
        try {
          const resp = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
          const html = await resp.text();
          const rows = [];
          const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
          let m;
          while ((m = re.exec(html)) && rows.length < n) {
            let url = m[1];
            const u = url.match(/[?&]uddg=([^&]+)/);
            if (u) url = decodeURIComponent(u[1]);
            rows.push(`${rows.length + 1}. ${decode(m[2])}\n   ${url}`);
          }
          const snips = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map(x => decode(x[1]));
          const out = rows.map((r2, i) => snips[i] ? r2 + '\n   ' + snips[i].slice(0, 220) : r2);
          if (out.length) return out.join('\n');
        } catch {}

        // 5) Wikipedia OpenSearch — free, keyless, and reliable for factual
        // queries when every general search backend is blocked.
        try {
          const api = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=' + n + '&srsearch=' + encodeURIComponent(q);
          const r = await fetch(api, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'LoomCode/1.7' } });
          const j = /** @type {{query?: {search?: any[]}}} */ (await r.json());
          const rows = (j.query && j.query.search || []).slice(0, n).map((x, i) =>
            `${i + 1}. ${decode(x.title)} (Wikipedia)\n   https://en.wikipedia.org/wiki/${encodeURIComponent(String(x.title).replace(/ /g, '_'))}\n   ${decode(x.snippet).slice(0, 220)}`);
          if (rows.length) return rows.join('\n');
        } catch {}

        return 'No results for "' + q + '" (set SEARXNG_URL to a self-hosted instance, or BRAVE_API_KEY / TAVILY_API_KEY for reliable search).';
      } catch (e) {
        return { error: 'websearch failed: ' + e.message };
      }
    }
  },
  todowrite: {
    name: 'todowrite',
    description: 'Create and maintain a structured task list for the current session. Tracks progress for multi-step work. Use when the task requires 3+ distinct steps or the user requests a todo list.',
    parameters: {
      todos: { type: 'array', required: true, description: 'Array of todo items with content, status (pending/in_progress/completed/cancelled), and priority (high/medium/low)' },
    },
    async execute(params) {
      const todos = Array.isArray(params.todos) ? params.todos : [];
      if (!todos.length) return '(no todos provided)';
      const statuses = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
      const lines = ['## Todo List', ''];
      for (const t of todos) {
        const status = t.status || 'pending';
        statuses[status] = (statuses[status] || 0) + 1;
        const icon = status === 'completed' ? '[x]' : status === 'in_progress' ? '[>]' : status === 'cancelled' ? '[-]' : '[ ]';
        const priority = t.priority ? ` [${t.priority}]` : '';
        lines.push(`${icon}${priority} ${t.content || '(unnamed)'}`);
      }
      lines.push('');
      lines.push(`Summary: ${statuses.completed} done, ${statuses.in_progress} in-progress, ${statuses.pending} pending, ${statuses.cancelled} cancelled`);
      return lines.join('\n');
    }
  },
  todoread: {
    name: 'todoread',
    description: 'Read the current session todo list (the same list todowrite maintains). Use to check task progress without overwriting it.',
    parameters: {},
    async execute(params, ctx) {
      const todos = (ctx && ctx.parentSession && ctx.parentSession.todos) || [];
      if (!todos.length) return '(no todos yet)';
      const statuses = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
      const lines = ['## Todo List', ''];
      for (const t of todos) {
        const status = t.status || 'pending';
        statuses[status] = (statuses[status] || 0) + 1;
        const icon = status === 'completed' ? '[x]' : status === 'in_progress' ? '[>]' : status === 'cancelled' ? '[-]' : '[ ]';
        const priority = t.priority ? ` [${t.priority}]` : '';
        lines.push(`${icon}${priority} ${t.content || '(unnamed)'}`);
      }
      lines.push('');
      lines.push(`Summary: ${statuses.completed} done, ${statuses.in_progress} in-progress, ${statuses.pending} pending, ${statuses.cancelled} cancelled`);
      return lines.join('\n');
    }
  },
  tasks: {
    name: 'tasks',
    description: 'Inspect and manage background tasks started with bash background:true. Actions: list (all tasks with status), output (recent output of one task by id), kill (stop a running task). Use when a background command may have finished, or the user asks about dev servers/builds running in the background.',
    parameters: {
      action: { type: 'string', required: true, description: '"list" | "output" | "kill"' },
      id: { type: 'string', required: false, description: 'Task id (for output/kill), e.g. bt-1-abc' },
      tailLines: { type: 'number', required: false, description: 'How many trailing lines of output to return (default 80)' },
    },
    async execute(params) {
      const bt = require('../core/background-tasks');
      const action = String(params.action || 'list').toLowerCase();
      if (action === 'list') {
        const rows = bt.listBackgroundTasks();
        if (!rows.length) return 'No background tasks. Start one with bash {background: true}.';
        return rows.map((t) => `${t.id}  [${t.status}]${t.exitCode != null ? ' exit ' + t.exitCode : ''}  ${String(t.command).slice(0, 120)}`).join('\n');
      }
      if (action === 'output') {
        const t = bt.getBackgroundTask(String(params.id || ''));
        if (!t) return { error: 'Unknown task id. Use action="list" to see ids.' };
        const lines = String(t.output || '').split('\n');
        const n = Math.min(Math.max(Number(params.tailLines) || 80, 1), 500);
        const tail = lines.slice(-n).join('\n');
        return `[${t.id} — ${t.status}${t.exitCode != null ? ', exit ' + t.exitCode : ''}]\n` + (tail || '(no output yet)');
      }
      if (action === 'kill') {
        const ok = bt.killBackgroundTask(String(params.id || ''));
        if (!ok) return { error: 'Task not found or not running: ' + (params.id || '(none)') };
        return 'Killed ' + params.id + '.';
      }
      return { error: 'Unknown action "' + action + '". Use list, output, or kill.' };
    }
  },
  ask: {
    name: 'ask',
    description: 'Ask the user a question when you genuinely need their input (missing info, a decision between approaches, or confirmation of intent). Provide up to 3 concise options when the answer is likely one of a few choices — the user can pick one OR type their own answer. Use sparingly: prefer deciding and acting yourself; never ask what you can determine from the codebase.',
    parameters: {
      question: { type: 'string', required: true, description: 'The question for the user, one or two sentences' },
      options: { type: 'array', required: false, description: 'Up to 3 short answer options the user can click', items: { type: 'string' } },
    },
    async execute(params) {
      // Handled entirely by the session's permission gate (the popup answer
      // becomes the tool result); this executor is a safety fallback.
      return String(params.question || '');
    }
  },
  task: {
    name: 'task',
    description: 'Delegate a self-contained subtask to a subagent that runs fully autonomously and returns its final answer. Use when a piece of work can run independently (parallelizable), needs a focused toolset, or benefits from a different model. Pick the smallest suitable agent (see the agent param). Pass a COMPLETE, self-contained instruction: the goal, relevant file paths, and exactly what to return. The subagent may run tools autonomously; fold its findings into your own answer afterwards.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete instructions for the subagent — goal, relevant file paths, and the exact output to return' },
      agent: { type: 'string', required: false, description: 'Subagent id: general (default), explore, scout, research, architect, coder, reviewer, tester, web, or a custom configured agent' },
      model: { type: 'string', required: false, description: 'Optional model override "provider/model-id" for this delegation' },
      timeoutMs: { type: 'number', required: false, description: 'Maximum runtime in ms (default from subagentTimeoutMs; max 1800000)' },
    },
    async execute(params, ctx) {
      const { runSubagent } = require('../core/agents');
      const res = await runSubagent({
        agentId: params.agent || 'general',
        prompt: params.prompt,
        model: params.model,
        parentSession: ctx && ctx.parentSession,
        onProgress: ctx && ctx.progress,
        signal: ctx && ctx.signal,
        timeoutMs: typeof params.timeoutMs === 'number' ? Math.min(Math.max(params.timeoutMs, 1000), 1800000) : undefined,
      });
      if ('error' in res) return { error: res.error };
      const ms = res.durationMs;
      const usage = `[${res.agent} finished in ${(ms / 1000).toFixed(1)}s \u00B7 ${res.tokensIn + res.tokensOut} tokens \u00B7 ${res.costUsd > 0.001 ? '$' + res.costUsd.toFixed(4) : 'free'}]`;
      return usage + '\n\n' + res.content;
    }
  },
  spawn_agents: {
    name: 'spawn_agents',
    description: 'Fan out a batch of independent subtasks to subagents that run CONCURRENTLY and return their reports together. Use this instead of sequential task calls whenever you can split work into 2+ independent packages (explore separate areas, review separate modules, test separate features). Each task is fully autonomous. Keep each prompt complete and self-contained: goal, file paths, and exactly what to return. Prefer explore for read-only investigation, coder for isolated implementation, reviewer/tester for verification.',
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description: '1-8 independent delegations. Each item: { agent, prompt, model? }. Agent ids: general, explore, scout, research, architect, coder, reviewer, tester, web, or a configured custom agent.',
        items: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: 'Subagent id (default general)' },
            prompt: { type: 'string', description: 'Complete, self-contained instructions and the exact output to return' },
            model: { type: 'string', description: 'Optional "provider/model-id" override' },
            timeoutMs: { type: 'number', description: 'Optional per-task timeout in ms' },
          },
          required: ['prompt'],
        },
      },
      concurrency: { type: 'number', required: false, description: 'Max subagents running at once (1-6, default 3)' },
    },
    async execute(params, ctx) {
      const tasks = Array.isArray(params.tasks) ? params.tasks.slice(0, 8) : [];
      if (!tasks.length) return { error: 'spawn_agents needs at least one task.' };
      const { runSubagents } = require('../core/agents');
      const { batchId, results } = await runSubagents({
        tasks,
        concurrency: params.concurrency,
        parentSession: ctx && ctx.parentSession,
        onProgress: ctx && ctx.progress,
        signal: ctx && ctx.signal,
      });
      const sections = results.map((res, i) => {
        const name = 'agent' in res && res.agent ? res.agent : (tasks[i].agent || 'agent');
        const head = '### [' + (i + 1) + '/' + results.length + '] ' + name;
        if (res.error) return head + ' — FAILED\n' + res.error;
        const ok = /** @type {import('../core/agents').SubagentResult} */ (res);
        const secs = (ok.durationMs / 1000).toFixed(1);
        const cost = ok.costUsd > 0.001 ? '$' + ok.costUsd.toFixed(4) : 'free';
        return head + ' — ' + secs + 's · ' + (ok.tokensIn + ok.tokensOut) + ' tokens · ' + cost + '\n\n' + ok.content;
      });
      return '[batch ' + batchId.slice(0, 8) + ' · ' + results.length + ' agents]\n\n' + sections.join('\n\n');
    }
  },
  browser: {
    name: 'browser',
    description: 'Drive a real headless browser (Playwright). Actions: goto (open an http/https url), click (CSS selector), fill (selector + text), press (key like Enter), text (visible page text + title/url), eval (JS expression in the page context), links (list page links), screenshot (save PNG, returns the file path), close. The browser stays open between calls so you can navigate, interact, and re-read the page. Prefer this over webfetch when the page needs JavaScript rendering or interaction.',
    parameters: {
      action: { type: 'string', required: true, description: '"goto" | "click" | "fill" | "press" | "text" | "eval" | "links" | "screenshot" | "close"' },
      url: { type: 'string', required: false, description: 'Page url (action=goto)' },
      selector: { type: 'string', required: false, description: 'CSS selector (action=click or fill)' },
      text: { type: 'string', required: false, description: 'Text to type into the selector (action=fill)' },
      key: { type: 'string', required: false, description: 'Key to press, e.g. Enter (action=press)' },
      script: { type: 'string', required: false, description: 'JS expression evaluated in the page (action=eval)' },
      path: { type: 'string', required: false, description: 'Screenshot destination path (action=screenshot; default: OS temp dir)' },
    },
    async execute(params) {
      return require('./browser').run(params);
    }
  },
  mcp: {
    name: 'mcp',
    description: 'Manage MCP (tool) servers for this workspace: list, add, remove, enable, disable. Use when the user asks to add a connector or when a task needs tools the session lacks yet (a DB, a browser, a ticketing system). Adding a server needs a stdio command (e.g. "npx -y <pkg>"); it stays disabled until enabled. If unsure a package exists, verify it with webfetch on the registry before installing — never run an unverified npm package.',
    parameters: {
      action: { type: 'string', required: true, description: '"list" | "add" | "remove" | "enable" | "disable"' },
      name: { type: 'string', required: false, description: 'MCP server name, letters/digits/-/_ (e.g. supabase)' },
      command: { type: 'string', required: false, description: 'Command to start the stdio server (add only), e.g. "npx" or "cmd" on Windows' },
      args: { type: 'string', required: false, description: 'Space-separated args (add only), e.g. "-y @supabase/mcp-server-supabase --access-token TOKEN". Never put real secrets in chat text; prefer env vars.' },
      env: { type: 'string', required: false, description: 'Optional env vars as space-separated KEY=VAL pairs (add only), e.g. "RAILWAY_API_TOKEN=token123"' },
    },
    async execute(params) {
      const mgr = require('../mcp/mcp-manager');
      const action = String(params.action || '').toLowerCase();
      if (action === 'list') {
        const rows = mgr.listServers();
        if (!rows.length) return 'No MCP servers configured.';
        return rows.map((s) => {
          const cmd = s.command + ' ' + (s.args || []).join(' ');
          return (s.enabled ? '[on]  ' : '[off] ') + s.name + ' \u2014 ' + cmd.trim();
        }).join('\n');
      }
      if (action === 'add') {
        if (!params.name || !params.command) return { error: 'add needs name + command' };
        // Adding a server spawns arbitrary processes with env secrets — same
        // safety filter as bash; the session gate prompts interactively and
        // marks the call approved before it reaches this layer.
        if (!params._approved) {
          const risk = commandRiskLabel(params.command + ' ' + (params.args || ''));
          if (risk) {
            return { error: `Blocked by safety filter: ${risk}. Approve it via the permission prompt to run it anyway.` };
          }
        }
        const args = params.args ? params.args.split(/\s+/) : [];
        const env = {};
        if (params.env) {
          for (const kv of params.env.trim().split(/\s+/)) {
            const eq = kv.indexOf('=');
            if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
          }
        }
        const res = mgr.addServer(params.name, params.command, args, Object.keys(env).length ? { env } : undefined);
        if (res && res.error) return { error: res.error };
        return 'Added MCP server "' + params.name + '". It is enabled by default; the new tools are available on the next turn (run /mcp to browse).';
      }
      if (action === 'remove') {
        if (!params.name) return { error: 'remove needs name' };
        const res = mgr.removeServer(params.name);
        if (res && res.error) return { error: res.error };
        return 'Removed MCP server "' + params.name + '".';
      }
      if (action === 'enable' || action === 'disable') {
        if (!params.name) return { error: action + ' needs name' };
        const servers = mgr.listServers();
        const cur = servers.find((s) => s.name === params.name);
        if (!cur) return { error: 'MCP server not found: ' + params.name + ' (use action="list" to see what is configured).' };
        const wantOn = action === 'enable';
        if (cur.enabled === wantOn) return 'MCP "' + params.name + '" already ' + (wantOn ? 'enabled' : 'disabled') + '.';
        const res = mgr.toggleServer(params.name);
        if (res && res.error) return { error: res.error };
        return 'MCP "' + params.name + '" is now ' + (res.enabled ? 'enabled' : 'disabled') + '.';
      }
      return { error: 'Unknown action "' + action + '". Use list, add, remove, enable, or disable.' };
    },
  },
  lsp: {
    name: 'lsp',
    description: 'Run a Language Server Protocol diagnostic check on a file and return any errors/warnings. Use this to get language-server feedback (syntax, types, lint) after writing or editing code. Configure which servers run via config.json "lsp": true.',
    parameters: {
      filePath: { type: 'string', required: true, description: 'Absolute path to the file to check' },
    },
    async execute(params) {
      const lsp = require('../core/lsp');
      const res = await lsp.checkFile(path.resolve(params.filePath));
      if (!res.ok) return { error: res.error };
      if (!res.diagnostics.length) return `LSP (${res.id}): no diagnostics for ${params.filePath}`;
      const errors = res.diagnostics.filter((d) => d.severity === 'error');
      const warnings = res.diagnostics.filter((d) => d.severity === 'warning');
      const lines = res.diagnostics.map((d) =>
        `${d.severity === 'error' ? 'E' : d.severity === 'warning' ? 'W' : 'I'} ${d.line + 1}:${d.character + 1} [${d.source || res.id}] ${d.message}`);
      return `LSP (${res.id}) — ${errors.length} error(s), ${warnings.length} warning(s):\n` + lines.join('\n');
    }
  },
};

function getToolDefinitions(mode = 'build') {
  const names = mode === 'chat' ? [] : mode === 'plan' ? READ_ONLY_TOOLS : Object.keys(TOOLS);
  return names.map(t => {
    const tool = TOOLS[t];
    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object',
        properties: tool.parameters,
        required: Object.keys(tool.parameters).filter(k => tool.parameters[k].required),
      },
    };
  });
}

// Session-level tool-result cap: a tool that returns megabytes (huge bash
// output, MCP payloads, giant file reads) poisons the context window and can
// even break the provider request. Cap at 100k chars, head+tail so both the
// start AND the error tail survive.
const TOOL_RESULT_CAP = 100 * 1000;

function truncateToolText(text) {
  const s = String(text);
  if (s.length <= TOOL_RESULT_CAP) return s;
  const head = Math.floor(TOOL_RESULT_CAP * 0.6);
  const tail = TOOL_RESULT_CAP - head - 100;
  return s.slice(0, head) +
    `\n\n[…truncated ${s.length - head - tail} chars — full output was ${s.length} chars; re-run with narrower scope]\n\n` +
    s.slice(-tail);
}

/** Execute one tool. `ctx` is passed through to tool executors that need
 *  session context (parent session, abort signal, subagent progress relay).
 *  @param {string} [toolName]
 *  @param {object} [params]
 *  @param {string} [mode]
 *  @param {object} [ctx] */
async function executeTool(toolName, params, mode = 'build', ctx = null) {
  if (mode && mode !== 'build') {
    if (mode === 'chat') {
      return { error: 'Blocked in chat mode: no tools are available. Switch to Build mode to use tools.' };
    }
    if (toolName && toolName.indexOf('mcp__') === 0) {
      return { error: `Blocked in ${mode} mode: MCP tools are not available outside Build mode.` };
    }
    if (toolName && !READ_ONLY_TOOLS.includes(toolName)) {
      return { error: `Blocked in ${mode} mode: ${toolName} is not read-only. Switch to Build mode to use it.` };
    }
  }
  if (toolName && toolName.indexOf('mcp__') === 0) {
    try {
      const mcp = require('../mcp/mcp-client');
      const idx = toolName.indexOf('__', 5);
      if (idx < 0) return { error: 'Malformed MCP tool name: ' + toolName };
      const server = toolName.slice(5, idx);
      const tool = toolName.slice(idx + 2);
      const timeoutMs = Number(ctx && ctx.toolTimeoutMs) || 180000;
      const res = await withDeadline('MCP tool "' + toolName + '"', timeoutMs, ctx && ctx.signal, (signal) =>
        mcp.callTool(server, tool, params || {}, { signal })
      );
      if (res && typeof res === 'object' && res.error) return { error: truncateToolText(res.error) };
      if (res && typeof res === 'object' && typeof res.result === 'string') return { result: truncateToolText(res.result) };
      return res;
    } catch (e) {
      return { error: truncateToolText('MCP error: ' + e.message) };
    }
  }
  const tool = TOOLS[toolName];
  if (!tool) return { error: `Unknown tool: ${toolName}` };
  try {
    const timeoutMs = toolName === 'task'
      ? (Number(ctx && ctx.subagentTimeoutMs) || 900000)
      : (Number(ctx && ctx.toolTimeoutMs) || 180000);
    const result = await withDeadline('Tool "' + toolName + '"', timeoutMs, ctx && ctx.signal, (signal) =>
      tool.execute(params, { ...(ctx || {}), signal })
    );
    if (result && typeof result === 'object' && result.error) return { error: truncateToolText(result.error) };
    return { result: typeof result === 'string' ? truncateToolText(result) : result };
  } catch (e) {
    return { error: truncateToolText(e.message) };
  }
}

const baseDefsCache = { build: null, plan: null };
async function getAllToolDefinitions(mode = 'build') {
  if (mode === 'chat') return [];
  // Tool schemas are static — build the base list once per mode.
  const base = baseDefsCache[mode] || (baseDefsCache[mode] = getToolDefinitions(mode));
  if (mode === 'plan') return base; // no MCP tools in plan mode (unknown side effects)
  try {
    const mcp = require('../mcp/mcp-client');
    // Warm discovery started at session boot; wait at most 2s so the first
    // turn never blocks on npx downloads, then proceed without MCP tools.
    const servers = await Promise.race([
      mcp.getCachedTools().catch(() => []),
      new Promise(res => setTimeout(() => res(null), 2000)),
    ]);
    if (!servers || !servers.length) return base;
    const mcpDefs = [];
    for (const s of servers) {
      if (s.error) continue;
      for (const t of s.tools || []) {
        mcpDefs.push({
          name: mcp.buildToolName(s.server, t.name),
          description: (t.description || ('MCP tool ' + t.name + ' from ' + s.server)).slice(0, 500),
          input_schema: t.inputSchema || { type: 'object', properties: {} },
        });
      }
    }
    return base.concat(mcpDefs);
  } catch (e) {
    return base;
  }
}

module.exports = { TOOLS, MODES, READ_ONLY_TOOLS, getToolDefinitions, getAllToolDefinitions, executeTool, isPrivateAddress, truncateToolText, windowsShellCommand };
