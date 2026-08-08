const { spawn } = require('child_process');
const { loadServers } = require('./mcp-manager');

let toolCachePromise = null;

function connectToJson(cfg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.command, cfg.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, cfg.env || {}),
    });
    const timeout = setTimeout(() => {
      child.kill();
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

function callRpc(child, method, params) {
  return new Promise((resolve, reject) => {
    const id = (callRpc.__seq = (callRpc.__seq || 0) + 1);
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === id) {
          child.stdout.off('data', onData);
          if (msg.error) reject(new Error((msg.error && msg.error.message) || 'MCP error'));
          else resolve(msg.result);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', () => {});
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    } catch (e) {
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
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.enabled === false) continue;
    const entry = { server: name };
    let child;
    try {
      child = await connectToJson(cfg, 8000);
      await callRpc(child, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'loom', version: '1.0.0' } }).catch(() => ({}));
      notify(child, 'notifications/initialized', {});
      const toolsRes = await callRpc(child, 'tools/list', {}).catch(() => ({ tools: [] }));
      entry.tools = (toolsRes && toolsRes.tools) || [];
    } catch (e) {
      entry.error = e.message;
    } finally {
      if (child) child.kill();
    }
    out.push(entry);
  }
  return out;
}

async function callTool(server, toolName, input) {
  const cfg = loadServers().servers[server];
  if (!cfg) return { error: 'MCP server not found: ' + server };
  let child;
  try {
    child = await connectToJson(cfg, 8000);
    await callRpc(child, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'loom', version: '1.0.0' } }).catch(() => ({}));
    notify(child, 'notifications/initialized', {});
    const res = await callRpc(child, 'tools/call', { name: toolName, arguments: input }).catch(() => ({ isError: true, content: [] }));
    if (res === undefined || res.isError) {
      const text = ((res && res.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return { error: text || 'MCP tool error' };
    }
    const text = ((res && res.content) || []).map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
    return { result: text || '(empty result)' };
  } catch (e) {
    return { error: e.message };
  } finally {
    if (child) child.kill();
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

module.exports = { getTools, getCachedTools, clearCache, buildToolName, callTool, warm };