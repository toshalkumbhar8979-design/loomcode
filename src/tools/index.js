const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { glob: globLib } = require('glob');

const cwd = process.cwd();

const MODES = ['build', 'plan', 'chat'];

// Tools that never mutate the filesystem/state — safe to expose in plan mode.
const READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'webfetch', 'todowrite'];

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
      const dir = path.dirname(dest);
      if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
      await fs.writeFile(dest, params.content, 'utf8');
      return `File written: ${dest}`;
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
    },
    async execute(params) {
      const filePath = path.resolve(params.filePath);
      if (!fsSync.existsSync(filePath)) return { error: `File not found: ${filePath}` };
      let content = await fs.readFile(filePath, 'utf8');
      const count = content.split(params.oldString).length - 1;
      if (count === 0) return { error: 'oldString not found in content' };
      if (params.replaceAll) {
        content = content.split(params.oldString).join(params.newString);
      } else {
        content = content.replace(params.oldString, params.newString);
      }
      await fs.writeFile(filePath, content, 'utf8');
      return `Edited ${filePath}: ${params.replaceAll ? `replaced ${count} occurrences` : 'replaced 1 occurrence'}`;
    }
  },
  bash: {
    name: 'bash',
    description: 'Execute a shell command.',
    parameters: {
      command: { type: 'string', required: true, description: 'The command to execute' },
      workdir: { type: 'string', required: false, description: 'Working directory' },
    },
    async execute(params) {
      return new Promise((resolve) => {
        const dir = params.workdir || cwd;
        try {
          const shellQuote = require('shell-quote');
          const parts = shellQuote.parse(params.command);
          if (!parts.length) { resolve('command completed (empty)'); return; }
          const cmd = String(parts[0]);
          const args = parts.slice(1).map(String);
          const opts = { cwd: dir, timeout: 60000, maxBuffer: 10 * 1024 * 1024 };
          const child = spawn(cmd, args, opts);
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', d => stdout += d.toString());
          child.stderr.on('data', d => stderr += d.toString());
          child.on('close', (code) => {
            let result = '';
            if (stdout) result += stdout;
            if (stderr) result += `\n[stderr]\n${stderr}`;
            if (code !== 0) result += `\n[exit code: ${code}]`;
            resolve(result || 'command completed');
          });
          child.on('error', (err) => resolve(`Error executing command: ${err.message}`));
        } catch (e) {
          resolve(`Error parsing command: ${e.message}`);
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
      const files = globLib.sync(full, { nodir: true, ignore: ['**/node_modules/**', '**/.git/**'] });
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
      const files = globLib.sync(full, { nodir: true, ignore: ['**/node_modules/**', '**/.git/**'] });
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
      try {
        const resp = await fetch(params.url, { signal: AbortSignal.timeout(15000) });
        const text = await resp.text();
        return text.slice(0, 10000);
      } catch (e) {
        return { error: `Fetch failed: ${e.message}` };
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

async function executeTool(toolName, params, mode = 'build') {
  if (mode && mode !== 'build') {
    if (mode === 'chat') {
      return { error: 'Blocked in chat mode: no tools are available. Switch to Build mode to use tools.' };
    }
    if (toolName && toolName.indexOf('mcp__') === 0) {
      return { error: `Blocked in ${mode} mode: MCP tools are not available outside Build mode.` };
    }
    if (!READ_ONLY_TOOLS.includes(toolName)) {
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
    const result = await tool.execute(params);
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

module.exports = { TOOLS, MODES, READ_ONLY_TOOLS, getToolDefinitions, getAllToolDefinitions, executeTool };