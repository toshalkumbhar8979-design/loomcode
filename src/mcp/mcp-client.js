const { spawn } = require('child_process');
const { loadServers } = require('./mcp-manager');

let toolCachePromise = null;

// Kill the whole process tree. On Windows, spawn kill leaves grandchildren
// (npx -> node) running as orphans that hold ports and memory. On POSIX the
// child is spawned detached as a process-group leader, so killing the group
// (-pid) takes down every descendant.
function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore', windowsHide: true });
      return;
    } catch {}
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  child.kill('SIGKILL');
}

function connectToJson(cfg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.command, cfg.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, cfg.env || {}),
      // No console window for stdio MCP servers: on Windows spawn() would
      // otherwise pop a flashing console up and down while chats happen.
      windowsHide: true,
      // POSIX only: make the server a process-group leader so killTree can
      // kill the whole tree (npx + its node child) with one -pid signal.
      detached: process.platform !== 'win32',
    });
    // A server that dies mid-conversation can emit EPIPE on stdin — without
    // a listener that 'error' would crash the whole app.
    child.stdin.on('error', () => {});
    const timeout = setTimeout(() => {
      killTree(child);
      reject(new Error('Timed out connecting to ' + (cfg.command || '') + ' (is it installed?)'));
    }, timeoutMs || 8000);
    child.on('error', (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.once('spawn', () => {
      clearTimeout(timeout);
      resolve(child);
    });
  });
}

let rpcSeq = 0;
const DEFAULT_RPC_TIMEOUT = 60000;

function callRpc(child, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = (rpcSeq += 1);
    let buf = '';
    let timer = null;
    let settled = false;
    const onStderr = () => {};
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onStderr);
      child.off('close', onClose);
      child.off('error', onChildError);
    };
    const onClose = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('MCP server exited (code ' + code + (signal ? ', signal ' + signal : '') + ') during ' + method));
    };
    const onChildError = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };
    const onData = (chunk) => {
      if (settled) return; // safely ignore anything after resolve/reject
      let text = chunk.toString();
      // Some Windows stdio servers emit a UTF-8 BOM on the first line, which
      // would break JSON.parse and stall the RPC until timeout.
      if (!buf) text = text.replace(/^﻿/, '');
      buf += text;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        // Some servers (or broken MCP packages) send non-object lines like
        // `null`, `[]`, or strings — never crash on them.
        if (msg && typeof msg === 'object' && msg.id === id) {
          settled = true;
          cleanup();
          if (msg.error) reject(new Error((msg.error && msg.error.message) || 'MCP error'));
          else resolve(msg.result);
        }
      }
    };
    timer = setTimeout(() => {
      settled = true;
      cleanup();
      reject(new Error('MCP RPC timed out: ' + method));
    }, timeoutMs || DEFAULT_RPC_TIMEOUT);
    child.stdout.on('data', onData);
    child.stderr.on('data', onStderr);
    child.once('close', onClose);
    child.once('error', onChildError);
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    } catch (e) {
      settled = true;
      cleanup();
      reject(e);
    }
  });
}

function notify(child, method, params) {
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  } catch {}
}

async function getTools() {
  const { servers } = loadServers();
  const out = [];
  const failed = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.enabled === false) continue;
    const entry = { server: name };
    let child;
    try {
      child = await connectToJson(cfg, 8000);
      await callRpc(child, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'loom', version: '1.0.0' } }, 10000).catch(() => ({}));
      notify(child, 'notifications/initialized', {});
      const toolsRes = await callRpc(child, 'tools/list', {}, 10000).catch(() => ({ tools: [] }));
      entry.tools = (toolsRes && toolsRes.tools) || [];
    } catch (e) {
      entry.error = e.message;
      failed.push({ server: name, error: e.message });
    } finally {
      killTree(child);
    }
    out.push(entry);
  }
  if (failed.length) {
    try { require('../core/events').emit('mcp:failed', { servers: failed }); } catch {}
  }
  return out;
}

async function callTool(server, toolName, input) {
  const cfg = loadServers().servers[server];
  if (!cfg) return { error: 'MCP server not found: ' + server };
  let child;
  try {
    child = await connectToJson(cfg, 8000);
    await callRpc(child, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'loom', version: '1.0.0' } }, 10000).catch(() => ({}));
    notify(child, 'notifications/initialized', {});
    const res = await callRpc(child, 'tools/call', { name: toolName, arguments: input }, DEFAULT_RPC_TIMEOUT).catch(() => ({ isError: true, content: [] }));
    if (res === undefined || res.isError) {
      const text = ((res && res.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return { error: text || 'MCP tool error' };
    }
    const text = ((res && res.content) || []).map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
    return { result: text || '(empty result)' };
  } catch (e) {
    return { error: e.message };
  } finally {
    killTree(child);
  }
}

function clearCache() {
  toolCachePromise = null;
}

// Kick off tool discovery in the background (spawning servers can take seconds
// on first run). The first turn awaits it with a deadline via getAllToolDefinitions.
function warm() {
  if (process.env.LOOM_MCP_NO_WARM) return Promise.resolve([]);
  if (!toolCachePromise) toolCachePromise = getTools();
  return toolCachePromise;
}

function buildToolName(server, tool) {
  return 'mcp__' + server + '__' + tool;
}

function getCachedTools() {
  return warm();
}

module.exports = { getTools, getCachedTools, clearCache, buildToolName, callTool, warm, callRpc, killTree };