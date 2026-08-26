const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { glob: globLib } = require('glob');
const { commandRiskLabel } = require('../core/permissions');
const { loadConfig } = require('../config/settings');
const dnsPromises = require('dns').promises;

const cwd = process.cwd();

function globIgnore(full) {
  const abs = full.startsWith('/') || /^[a-zA-Z]:/.test(full);
  if (!abs) return ['**/node_modules/**', '**/.git/**'];
  const base = path.posix.dirname(full);
  return ['node_modules', '.git'].map((n) => path.posix.join(base, '**', n, '**'));
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
const READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'webfetch', 'websearch', 'todowrite', 'task'];

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
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.split('\n');
      const start = (params.offset || 1) - 1;
      const end = params.limit ? start + params.limit : lines.length;
      const result = lines.slice(start, end).map((l,i) => `${start+i+1}: ${l}`).join('\n');
      return result;
    }
  },
  write: {
    name: 'write',
    description: 'Write a file to the local filesystem.',
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
    description: 'Performs exact string replacements in files.',
    parameters: {
      filePath: { type: 'string', required: true, description: 'Absolute path to the file' },
      oldString: { type: 'string', required: true, description: 'Text to replace' },
      newString: { type: 'string', required: true, description: 'Replacement text' },
      replaceAll: { type: 'boolean', required: false, description: 'Replace all occurrences' },
      dryRun: { type: 'boolean', required: false, description: 'Preview the edit without writing' },
    },
    async execute(params) {
      const filePath = path.resolve(params.filePath);
      if (!pathAllowed(filePath)) return { error: sandboxDenied('edit', filePath) };
      if (!fsSync.existsSync(filePath)) return { error: `File not found: ${filePath}` };
      let content = await fs.readFile(filePath, 'utf8');
      const count = content.split(params.oldString).length - 1;
      if (count === 0) return { error: 'oldString not found in content' };
      if (params.replaceAll) {
        content = content.split(params.oldString).join(params.newString);
      } else {
        content = content.replace(params.oldString, params.newString.replace(/\$/g, '$$$$'));
      }
      if (params.dryRun) {
        const changed = params.replaceAll ? `replaced ${count} occurrences` : 'replaced 1 occurrence';
        return `Dry run — would edit ${filePath}: ${changed} (file not modified).\n${content.slice(0, 4000)}`;
      }
      await fs.writeFile(filePath, content, 'utf8');
      let extra = '';
      try { extra = await require('../core/format').formatAfterWrite(filePath); } catch {}
      return `Edited ${filePath}: ${params.replaceAll ? `replaced ${count} occurrences` : 'replaced 1 occurrence'}${extra}`;
    }
  },
  bash: {
    name: 'bash',
    description: 'Execute a shell command.',
    parameters: {
      command: { type: 'string', required: true, description: 'The command to execute' },
      workdir: { type: 'string', required: false, description: 'Working directory' },
      background: { type: 'boolean', required: false, description: 'Run without waiting (dev servers, long builds). Returns a task id immediately; check with the /tasks panel.' },
    },
    async execute(params, ctx) {
      // Background mode: fire-and-forget via the task registry.
      if (params.background) {
        const bt = require('../core/background-tasks');
        if (!pathAllowed(params.workdir || cwd)) return { error: sandboxDenied('bash', params.workdir || cwd) };
        const risk = params._approved ? null : commandRiskLabel(params.command);
        if (risk) return { error: `Blocked by safety filter: ${risk}. Approve it via the permission prompt to run it anyway.` };
        const res = /** @type {{id:string}|{error:string}} */ (bt.startBackgroundTask(params.command));
        if ('error' in res) return { error: res.error };
        return `Started background task ${res.id}. Keep working; check output with /tasks (or bash background:false re-run).`;
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
            ? spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + params.command], opts)
            : spawn('/bin/sh', ['-c', params.command], opts);
          const killTimer = setTimeout(() => {
            if (isWin) {
              try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); } catch {}
            }
            child.kill('SIGKILL');
          }, 60000);
          child.on('close', () => clearTimeout(killTimer));
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
          child.on('close', (code) => {
            let result = '';
            if (stdout) result += stdout;
            if (stderr) result += `\n[stderr]\n${stderr}`;
            if (code !== 0) result += `\n[exit code: ${code}]`;
            if (truncated) result += '\n[output truncated at 10 MB]';
            resolve(result || 'command completed');
          });
          child.on('error', (err) => resolve({ error: `Error executing command: ${err.message}` }));
        } catch (e) {
          resolve({ error: `Error executing command: ${e.message}` });
        }
      });
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
    async execute(params) {
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
        const signal = AbortSignal.timeout(15000);
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
    description: 'Web search. Uses Brave (BRAVE_API_KEY) or Tavily (TAVILY_API_KEY) when configured, else the DuckDuckGo HTML endpoint (no key). Returns top results with titles, URLs and snippets.',
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
        // 3) DuckDuckGo HTML fallback (no key)
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
        return out.length ? out.join('\n') : 'No results for "' + q + '" (DDG returned nothing — set BRAVE_API_KEY or TAVILY_API_KEY for reliable search).';
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
    description: 'Delegate a self-contained subtask to a subagent that runs fully autonomously and returns its final answer. Use when a piece of work can run independently (parallelizable), needs a focused toolset, or benefits from a different model. Pick the smallest suitable agent: explore (fast read-only code search), scout (web/docs research), general (full toolset except delegation). Pass the agent a COMPLETE, self-contained instruction: the goal, relevant file paths, and exactly what to return. The subagent may run tools autonomously; fold its findings into your own answer afterwards.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete instructions for the subagent — goal, relevant file paths, and the exact output to return' },
      agent: { type: 'string', required: false, description: 'Subagent id: general (default), explore, scout, or a custom one from config.agents' },
      model: { type: 'string', required: false, description: 'Optional model override "provider/model-id" for this delegation' },
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
      });
      if ('error' in res) return { error: res.error };
      const ms = res.durationMs;
      const usage = `[${res.agent} finished in ${(ms / 1000).toFixed(1)}s \u00B7 ${res.tokensIn + res.tokensOut} tokens \u00B7 ${res.costUsd > 0.001 ? '$' + res.costUsd.toFixed(4) : 'free'}]`;
      return usage + '\n\n' + res.content;
    }
  },
  mcp: {
    name: 'mcp',
    description: 'Manage MCP (tool) servers for this workspace. Use when the user asks to add/remove/enable/disable an MCP server or connector (e.g. github, filesystem, gmail) or when a task requires tools the session does not have yet. In the TUI, hosting/cloud services (supabase, vercel, nextjs, railway, netlify, cloudflare) live under /connectors; dev-tool MCP servers (playwright, github, sentry, figma, postgres, mongodb, linear, slack, brave-search, exa, context7, filesystem, sqlite, puppeteer) live under /mcp. Common packages: Playwright=@playwright/mcp, Sentry=@sentry/mcp-server (needs --access-token TOKEN), Figma=figma-developer-mcp (env FIGMA_API_KEY), Postgres=@modelcontextprotocol/server-postgres (env DATABASE_URL), MongoDB=mongodb-mcp-server (env MONGODB_CONNECTION_STRING), Linear=linear-mcp-server (env LINEAR_API_KEY), Slack=@modelcontextprotocol/server-slack (env SLACK_BOT_TOKEN + SLACK_TEAM_ID), Brave=@modelcontextprotocol/server-brave-search (env BRAVE_API_KEY), Exa=exa-mcp-server (env EXA_API_KEY), Context7=@upstash/context7-mcp, Vercel=vercel-mcp-server (env VERCEL_TOKEN), Railway=@railway/mcp-server (env RAILWAY_API_TOKEN), Netlify=netlify-mcp-server (env NETLIFY_AUTH_TOKEN), Cloudflare=@cloudflare/mcp-server-cloudflare (env CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID), Supabase=@supabase/mcp-server-supabase (needs --access-token TOKEN), GitHub=ghcr.io/github/github-mcp-server (docker). If unsure about an MCP package, verify it exists first with webfetch (e.g. https://registry.npmjs.org/<pkg>) or web search (fetch or bash curl) — never trust an unverified npm package.',
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
      return await mcp.callTool(server, tool, params || {});
    } catch (e) {
      return { error: 'MCP error: ' + e.message };
    }
  }
  const tool = TOOLS[toolName];
  if (!tool) return { error: `Unknown tool: ${toolName}` };
  try {
    const result = await tool.execute(params, ctx);
    if (result && typeof result === 'object' && result.error) return { error: result.error };
    return { result };
  } catch (e) {
    return { error: e.message };
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

module.exports = { TOOLS, MODES, READ_ONLY_TOOLS, getToolDefinitions, getAllToolDefinitions, executeTool, isPrivateAddress };