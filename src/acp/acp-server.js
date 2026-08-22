// Agent Client Protocol (ACP) server — lets ACP-compatible editors (Zed,
// JetBrains, Avante.nvim, CodeCompanion.nvim, ...) drive Loom as a subprocess.
//
// Transport: JSON-RPC 2.0 messages, one per line (newline-delimited JSON) over
// stdio. The editor sends requests on stdin; Loom answers on stdout and queues
// agent events that the client retrieves with fetchAgentEvent.
//
// Implemented methods (subset of the ACP spec):
//   initialize, connect, storeMessage, sendChatRequest, fetchAgentEvent,
//   cancelCurrentTask, updateAgentConfig, changeDefaultMode, enableToolUse,
//   disposeTool
//
// Run with: loom acp   (or:  bun src/acp/acp-server.js)
const readline = require('readline');
const os = require('os');
const path = require('path');
const { Session, isAbortError } = require('../core/session');
const { getToolDefinitions } = require('../tools');
const { loadConfig, saveConfig } = require('../config/settings');

const ACP_METHODS = new Set([
  'initialize',
  'connect',
  'storeMessage',
  'sendChatRequest',
  'fetchAgentEvent',
  'cancelCurrentTask',
  'updateAgentConfig',
  'changeDefaultMode',
  'enableToolUse',
  'disposeTool',
]);

/** @typedef {Object} AcpTask
 *  @property {Session} session
 *  @property {boolean} active
 *  @property {Array<object>} events
 *  @property {string} mode
 */

class AcpServer {
  /**
   * @param {object} [opts]
   * @param {NodeJS.ReadableStream|any} [opts.input]
   * @param {NodeJS.WritableStream|any} [opts.output]
   */
  constructor(opts = {}) {
    this.input = opts.input || process.stdin;
    this.output = opts.output || process.stdout;
    /** @type {Map<string, AcpTask>} */
    this.tasks = new Map();
    this.rl = null;
  }

  start() {
    this.rl = readline.createInterface({ input: this.input, terminal: false });
    this.rl.on('line', (line) => {
      const trimmed = String(line).trim();
      if (!trimmed) return;
      let req;
      try { req = JSON.parse(trimmed); } catch { return; }
      this.handleRequest(req).catch((e) => {
        if (req && req.id != null) this.reply(req.id, null, { code: -32603, message: e && e.message ? e.message : String(e) });
      });
    });
  }

  /** @param {object} req */
  async handleRequest(req) {
    if (!req || typeof req.method !== 'string') return;
    const method = req.method;
    const params = req.params || {};
    const id = req.id != null ? req.id : null;
    if (!ACP_METHODS.has(method)) {
      if (id != null) this.reply(id, null, { code: -32601, message: 'Method not found: ' + method });
      return;
    }
    if (id == null) {
      // Notification — methods that expect a response still work; ignore result.
      try { await this[method](params); } catch {}
      return;
    }
    try {
      const result = await this[method](params);
      this.reply(id, result === undefined ? null : result, null);
    } catch (e) {
      this.reply(id, null, { code: -32603, message: e && e.message ? e.message : String(e) });
    }
  }

  /** @param {number|string|null} id
   *  @param {*} result
   *  @param {{code:number, message:string}|null} error */
  reply(id, result, error) {
    const msg = { jsonrpc: '2.0', id };
    if (error) msg.error = error;
    else msg.result = result !== undefined ? result : null;
    this.write(msg);
  }

  /** @param {object} obj */
  write(obj) {
    try { this.output.write(JSON.stringify(obj) + '\n'); } catch {}
  }

  // ── ACP methods ──

  initialize() {
    const defs = getToolDefinitions('build');
    return {
      protocolVersion: 1,
      capabilities: { openai: true, customInstructions: true },
      toolSchemas: defs.map((d) => ({
        type: 'function',
        function: {
          name: d.name,
          description: d.description,
          parameters: d.input_schema || { type: 'object', properties: {} },
        },
      })),
      agentConfig: {
        builtInTools: defs.map((d) => d.name),
        customInstructions: null,
        includeAgentContext: false,
      },
    };
  }

  /**
   * @param {{taskId?: string, agentConfig?: object}} params
   */
  connect(params) {
    const taskId = params.taskId || 'task-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const session = new Session();
    const agentConfig = params.agentConfig || {};
    if (agentConfig.mode === 'plan' || agentConfig.mode === 'chat' || agentConfig.mode === 'build') {
      session.setMode(agentConfig.mode);
    }
    if (typeof agentConfig.instructions === 'string' && agentConfig.instructions.trim()) {
      session._agentBlock = '\n\n[ACP session instructions]\n' + agentConfig.instructions.trim() + '\n';
    }
    /** @type {AcpTask} */
    const task = { session, active: false, events: [], mode: session.mode };
    this.tasks.set(taskId, task);
    this.pushEvent(task, 'session.updated', { type: 'created' });
    return { taskId };
  }

  /**
   * @param {{taskId: string, message: object}} params
   */
  storeMessage(params) {
    const task = this.getTask(params.taskId);
    const msg = params.message || {};
    task.session.addMessage({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: String(msg.content || '') });
    this.pushEvent(task, 'session.updated', { type: 'expanded' });
    return null;
  }

  /**
   * @param {{taskId: string, message: {content?: string}}} params
   */
  async sendChatRequest(params) {
    const task = this.getTask(params.taskId);
    if (task.active) throw new Error('Task already has an active request; wait for it to complete or cancel it.');
    const text = String((params.message && params.message.content) || '');
    if (!text.trim()) throw new Error('Message content is empty.');
    const requestId = 'req-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    const messageId = 'msg-' + Date.now().toString(36);
    task.active = true;
    this.pushEvent(task, 'session.updated', { type: 'expanded' });
    (() => {
      task.session.sendUserMessage(text, {
        onDelta: (t) => this.pushEvent(task, 'agent.message', { messageId, content: { type: 'text', content: t } }),
        onReasoning: (t) => this.pushEvent(task, 'agent.message', { messageId: messageId + '-r', content: { type: 'reasoning', content: t } }),
        onTool: (toolName, input) => this.pushEvent(task, 'tool.use', { toolName, id: 'tool-' + Date.now().toString(36), input }),
        onToolResult: (toolName, out, input) =>
          this.pushEvent(task, 'tool.result', { toolName, input, result: out && out.result != null ? out.result : (out && out.error) }),
      }).then((resp) => {
        this.pushEvent(task, 'session.updated', { type: 'expanded' });
        if (resp.interrupted) {
          this.pushEvent(task, 'request.error', { requestId, message: '(interrupted)' });
        } else if (resp.type === 'error') {
          this.pushEvent(task, 'request.error', { requestId, message: String(resp.content || '') });
        } else {
          this.pushEvent(task, 'agent.message.completed', { messageId });
          this.pushEvent(task, 'request.completed', { requestId, response: { type: 'text', text: String(resp.content || '') } });
        }
      }).catch((e) => {
        this.pushEvent(task, 'session.updated', { type: 'expanded' });
        if (isAbortError(e)) {
          this.pushEvent(task, 'request.error', { requestId, message: '(interrupted)' });
        } else {
          this.pushEvent(task, 'request.error', { requestId, message: e && e.message ? e.message : String(e) });
        }
      }).finally(() => {
        task.active = false;
      });
    })();
    return { requestId };
  }

  /**
   * @param {{taskId: string, cursor?: number}} params
   */
  fetchAgentEvent(params) {
    const task = this.getTask(params.taskId);
    const cursor = Number(params.cursor || 0);
    const events = task.events.slice(cursor);
    return { events, cursor: cursor + events.length };
  }

  /**
   * @param {{taskId: string}} params
   */
  cancelCurrentTask(params) {
    const task = this.getTask(params.taskId);
    try { task.session.interrupt(); } catch {}
    return null;
  }

  /**
   * @param {{taskId: string, agentConfig?: object}} params
   */
  updateAgentConfig(params) {
    const task = this.getTask(params.taskId);
    const agentConfig = params.agentConfig || {};
    if (typeof agentConfig.instructions === 'string' && agentConfig.instructions.trim()) {
      task.session._agentBlock = '\n\n[ACP session instructions]\n' + agentConfig.instructions.trim() + '\n';
    }
    return null;
  }

  /**
   * @param {{taskId: string, mode?: string}} params
   */
  changeDefaultMode(params) {
    const task = this.getTask(params.taskId);
    if (params.mode === 'plan' || params.mode === 'chat' || params.mode === 'build') {
      task.session.setMode(params.mode);
      task.mode = params.mode;
    }
    return null;
  }

  enableToolUse() {
    // All built-in tools + MCP tools are enabled by default; nothing to gate.
    return null;
  }

  disposeTool() {
    return null;
  }

  /** @param {string} taskId
   * @returns {AcpTask} */
  getTask(taskId) {
    const task = this.tasks.get(String(taskId));
    if (!task) throw new Error('Unknown task: ' + taskId);
    return task;
  }

  /** @param {AcpTask} task
   *  @param {string} event
   *  @param {object} payload */
  pushEvent(task, event, payload) {
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), event, ...payload };
    task.events.push(item);
    return item;
  }
}

/** Print a tiny readiness line to stderr (never corrupts the stdio protocol). */
function announce() {
  const c = loadConfig();
  const loc = process.env.LOOM_CONFIG_DIR || path.join(os.homedir(), '.loom', 'config.json');
  process.stderr.write(`[loom acp] started — provider: ${c.provider}, config: ${loc}\n`);
}

function main() {
  announce();
  const server = new AcpServer();
  server.start();
  process.stdin.resume();
}

module.exports = { AcpServer, main };
