const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Session, MEMORY_TEMPLATE } = require('./session');
const { connect, disconnect, status } = require('../config/provider-cmd');
const { loadConfig, saveConfig, LOOM_DIR } = require('../config/settings');
const { ProviderRouter, PROVIDERS } = require('../providers');
const { saveSession, loadSession } = require('./session-store');
const { defaultMcpInstall } = require('./plugin-cmd');

const LOOM_BASE = `
 ██╗      ██████╗  ██████╗ ███╗   ███╗      ██████╗ ██████╗ ██████╗ ███████╗
 ██║     ██╔═══██╗██╔═══██╗████╗ ████║     ██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ██║     ██║   ██║██║   ██║██╔████╔██║     ██║     ██║   ██║██║  ██║█████╗
 ██║     ██║   ██║██║   ██║██║╚██╔╝██║     ██║     ██║   ██║██║  ██║██╔══╝
 ███████╗╚██████╔╝╚██████╔╝██║ ╚═╝ ██║     ╚██████╗██████╔╝██████╔╝███████╗
 ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝     ╚═╝      ╚═════╝╚═════╝ ╚═════╝ ╚══════╝`;

class LoomCLI {
  /** @type {import('readline').Interface} */
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[36m> \x1b[0m',
    completer: (line) => this.completer(line),
    terminal: true,
  });
  /** @type {import('./session').Session} */
  session = new Session();
  constructor() {
    this.running = true;
    this.config = loadConfig();
    this.initialPrompt = null;
    this.initialSession = null;
  }

  async start() {
    console.log(LOOM_BASE);
    console.log(`\n  Loom Code v1.0.0 — AI Coding Agent for the terminal`);
    console.log(`  Press Ctrl+C or ESC to interrupt | /help for commands\n`);

    process.stdin.on('keypress', (str, key) => {
      if (key && key.name === 'escape') {
        this.onEscape();
      }
    });

    if (this.initialSession) {
      this.session.messages = this.initialSession.messages || [];
      this.session.conversationId = this.initialSession.id || this.session.conversationId;
    }
    this.running = true;

    this.showPrompt();
    if (this.initialPrompt) {
      const prompt = this.initialPrompt;
      this.initialPrompt = null;
      setImmediate(() => this.rl.emit('line', prompt));
    }
    return this.runLoop();
  }

  onEscape() {
    if (this.session) {
      this.session.interrupt();
    }
  }

  showPrompt() {
    process.stdout.write(`\n👁 > `);
  }

  async runLoop() {
    return new Promise((resolve) => {
      this.rl.on('line', async (line) => {
        try {
          const trimmed = line.trim();
          if (!trimmed) { this.showPrompt(); return; }

          if (trimmed.startsWith('/')) {
            await this.handleSlashCommand(trimmed);
          } else {
            await this.handleMessage(trimmed);
          }
        } catch (err) {
          console.log(`\nError: ${err.message}`);
        }
        this.showPrompt();
      });
    });
  }

  async handleMessage(text) {
    console.log(`\n[You] ${text}`);
    console.log('\n[Loom is thinking...]');

    try {
      const resp = await this.session.sendUserMessage(text);
      this.printResponse(resp);
    } catch (err) {
      console.log(`\nError: ${err.message}`);
    }
  }

  printResponse(resp) {
    if (!resp) return console.log('(no response)');
    if (resp.type === 'text') {
      console.log(`\n[Loom] ${resp.content}`);
    } else if (resp.type === 'error') {
      console.log(`\n[Error] ${resp.content}`);
    } else if (resp.type === 'tool_call') {
      console.log(`\n[Tool: ${resp.name}(${JSON.stringify(resp.params)})]`);
    } else {
      console.log('(no response)');
    }
  }

  async headless(text) {
    if (!text) {
      console.error('Usage: loom -p "query"');
      process.exit(1);
    }
    this.session = new Session();
    const resp = await this.session.sendUserMessage(text);
    if (resp.type === 'text') {
      process.stdout.write(resp.content + '\n');
    } else if (resp.type === 'error') {
      console.error(resp.content);
      process.exit(1);
    }
    process.exit(0);
  }

  async handleSlashCommand(cmd) {
    const parts = cmd.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (command) {
      case 'help':
        return this.cmdHelp();
      case 'init':
        return this.cmdInit();
      case 'memory':
        return this.cmdMemory();
      case 'connect':
        return this.cmdConnect(args);
      case 'model':
        return this.cmdModel(args);
      case 'models':
        return this.cmdModels();
      case 'status':
        return this.cmdStatus();
      case 'clear':
        return this.cmdClear();
      case 'compact':
        return this.cmdCompact();
      case 'undo':
        return this.cmdUndo();
      case 'reset':
        return this.cmdReset();
      case 'doctor':
        return this.cmdDoctor();
      case 'skills':
        return this.cmdSkills(args);
      case 'mcp':
        return this.cmdMcp(args);
      case 'providers':
        return this.cmdProviders();
      case 'format':
        return this.cmdFormat(args);
      case 'lsp':
        return this.cmdLsp(args);
      case 'graph':
        return this.cmdGraph(args);
      case 'quit':
      case 'exit':
        return this.cmdExit();
      default:
        console.log(`Unknown command: /${command}. Type /help for commands.`);
    }
  }

  cmdHelp() {
    console.log(`
  ┌────────────────────────────────────────────────┐
  │              Loom Code Commands                  │
  ├────────────────────────────────────────────────┤
  │ /help        Show this help                    │
  │ /init        (Re)create LOOM.md memory file     │
  │ /memory      View/edit LOOM.md memory file     │
  │ /connect     Connect to an AI provider         │
  │ /model       Set the active model              │
  │ /models      List available models             │
  │ /status      Show connection status            │
  │ /clear       Clear conversation history        │
  │ /compact     Compact conversation              │
  │ /undo        Undo last change                  │
  │ /reset       Reset entire session              │
  │ /doctor      Run diagnostics                   │
  │ /providers   List all supported providers      │
  │ /format      Manage formatters (file auto-fmt) │
  │ /lsp         Manage LSP servers + diagnostics  │
  │ /exit        Exit Loom Code                    │
  │                                                │
  │ ESC          Interrupt current operation       │
  │ Ctrl+C       Exit Loom Code                    │
  └────────────────────────────────────────────────┘
    `);
  }

  async cmdInit() {
    const cwd = process.cwd();
    const loomMdPath = path.join(cwd, 'LOOM.md');
    if (fs.existsSync(loomMdPath)) {
      console.log(`LOOM.md already exists at ${loomMdPath}`);
      return;
    }
    fs.writeFileSync(loomMdPath, MEMORY_TEMPLATE);
    console.log(`Created LOOM.md at ${loomMdPath}`);
    console.log('Edit this file with your project conventions and standards.');
  }

  async cmdMemory() {
    const locations = [
      path.join(process.cwd(), 'LOOM.md'),
      path.join(process.cwd(), '.loom', 'LOOM.md'),
      path.join(os.homedir(), '.loom', 'LOOM.md'),
    ];
    console.log('\nMemory file locations:');
    for (const loc of locations) {
      const exists = fs.existsSync(loc);
      console.log(`  ${exists ? '✓' : '✗'} ${loc}${exists ? ' (' + fs.statSync(loc).size + ' bytes)' : ''}`);
    }
    const target = locations[0];
    if (!fs.existsSync(target)) fs.writeFileSync(target, MEMORY_TEMPLATE);
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'win32') execSync('start "" "' + target + '"', { stdio: 'ignore', windowsHide: true });
      else if (process.platform === 'darwin') execSync('open "' + target + '"', { stdio: 'ignore' });
      else execSync('xdg-open "' + target + '"', { stdio: 'ignore' });
      console.log(`Opened ${target} in your default editor.`);
    } catch (e) {
      console.log(`Edit it yourself: ${target}`);
    }
  }

  async cmdConnect(args) {
    const provider = args[0];
    if (!provider) {
      console.log('Usage: /connect <provider> [api-key]');
      console.log('Run /providers to list every supported provider (built-ins + models.dev registry).');
      return;
    }
    const key = args[1];
    const result = connect(provider, key);
    console.log(result);
    if (!key) {
      const { envNamesFor } = require('../providers/registry');
      const envHint = (envNamesFor(provider) || [])[0] || provider.toUpperCase() + '_API_KEY';
      console.log(`Set API key with environment variable: ${envHint}`);
    }
  }

  async cmdModel(args) {
    const provider = this.session?.provider?.active?.name || 'anthropic';
    const models = PROVIDERS[provider]?.models || [];
    if (!args.length) {
      console.log(`Available models for ${provider}:`);
      models.forEach(m => console.log(`  ${m.id} — ${m.name}`));
      return;
    }
    this.config.model = this.config.model || {};
    this.config.model[provider] = args[0];
    saveConfig(this.config);
    console.log(`Model set to: ${args[0]}`);
  }

  async cmdModels() {
    const provider = this.session?.provider?.active?.name || 'anthropic';
    const models = PROVIDERS[provider]?.models || [];
    console.log(`\nModels available for ${provider}:`);
    models.forEach(m => console.log(`  ${m.id} — ${m.name}`));
  }

  async cmdStatus() {
    const s = status();
    console.log(`\nProvider: ${s.provider}`);
    console.log(`Model: ${s.model}`);
    console.log(`API Key: ${s.hasKey ? 'configured' : 'NOT SET'}`);
  }

  async cmdClear() {
    this.session.reset();
    console.log('Conversation cleared.');
  }

  async cmdCompact() {
    this.session.messages = this.session.messages.slice(-10);
    console.log('Conversation compacted - keeping last 10 messages.');
  }

  cmdUndo() {
    if (this.session.messages.length >= 2) {
      this.session.messages.pop();
      this.session.messages.pop();
      console.log('Last exchange undone.');
    } else {
      console.log('Nothing to undo.');
    }
  }

  async cmdReset() {
    this.session = new Session();
    console.log('Session fully reset.');
  }

  async cmdDoctor() {
    console.log('\n=== Loom Code Diagnostics ===');
    console.log(`Node: ${process.version}`);
    console.log(`Platform: ${os.platform()} ${os.arch()}`);
    console.log(`Home: ${os.homedir()}`);
    console.log(`CWD: ${process.cwd()}`);
    console.log(`Config: ${path.join(os.homedir(), '.loom', 'config.json')}`);
    const config = loadConfig();
    console.log(`Provider: ${config.provider}`);
    const hasKeys = Object.keys(config.apiKeys || {}).length > 0;
    console.log(`Has API keys: ${hasKeys ? 'Yes (' + Object.keys(config.apiKeys).join(', ') + ')' : 'No'}`);
    const hasMemory = fs.existsSync(path.join(process.cwd(), 'LOOM.md'));
    console.log(`LOOM.md in project: ${hasMemory ? 'Yes' : 'No'}`);
    console.log('\nSupported providers:');
    for (const [name, mod] of Object.entries(PROVIDERS)) {
      const hasModels = (mod.models?.length || 0) > 0;
      console.log(`  ${name} — ${hasModels ? mod.models.length + ' models' : 'no models'}`);
    }
  }

  cmdProviders() {
    console.log('\nSupported AI Providers:');
    for (const [name, mod] of Object.entries(PROVIDERS)) {
      const count = mod.models?.length || 0;
      console.log(`  ${name}: ${count} models`);
      if (mod.models) {
        mod.models.slice(0, 5).forEach(m => console.log(`    - ${m.id}`));
      }
    }
    console.log('\nConnect with: /connect <provider>');
  }

  cmdFormat(args) {
    const plugin = require('./plugin-cmd');
    console.log(plugin.formatCmd(args));
  }

  async cmdLsp(args) {
    const plugin = require('./plugin-cmd');
    console.log(await plugin.lspCmd(args));
  }

  async cmdGraph(args) {
    // /graph — rebuild the memory graph and display it as text.
    // Writes graph.json to .loom/graph/ for the TUI to consume.
    // Dynamic import avoids static analysis by tsc (graph.ts has loose types).
    const mod = await import('../core/graph.js');
    const { buildGraph, renderGraphText } = mod;
    const cwd = process.cwd();
    const graph = buildGraph(cwd);
    const outDir = path.join(cwd, '.loom', 'graph');
    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, 'graph.json');
    fs.writeFileSync(jsonPath, JSON.stringify(graph, null, 2));
    console.log(renderGraphText(graph));
    console.log('');
    console.log('Graph data written to ' + jsonPath);
    if (args[0] === 'open' || args[0] === '--open') {
      await this.openGraphBrowser(graph);
    } else {
      console.log('Run /graph in the TUI for the interactive view, or "loom graph open" for the browser graph.');
    }
  }

  /**
   * Serve the browser-based force-directed graph view (design doc: Loom
   * Graph View Design) and open it in the default browser.
   * @param {{ nodes: any[], edges: any[] }} graph
   * @returns {Promise<void>}
   */
  async openGraphBrowser(graph) {
    const http = require('http');
    const template = fs.readFileSync(path.join(__dirname, '..', 'web', 'graph-view.html'), 'utf8');
    const html = template.replace('window.__GRAPH__ || { nodes: [], edges: [] }', JSON.stringify(graph).replace(/<\/script/gi, '<\\/script'));
    const server = http.createServer((req, res) => {
      const p = req.url || '/';
      if (p === '/' || p === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else if (p === '/graph.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(graph));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    const port = /** @type {any} */ (server.address()).port;
    const url = 'http://127.0.0.1:' + port + '/';
    console.log('Graph view: ' + url + '  (Ctrl+C to stop the server)');
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'win32') execSync('start "" "' + url + '"', { stdio: 'ignore', windowsHide: true });
      else if (process.platform === 'darwin') execSync('open "' + url + '"', { stdio: 'ignore' });
      else execSync('xdg-open "' + url + '"', { stdio: 'ignore' });
    } catch { /* browser open failed; the URL was printed above */ }
  }

  cmdSkills(args) {
    const plugin = require('./plugin-cmd');
    if (args[0] === 'install') console.log(plugin.installSkillCmd(args.slice(1)));
    else if (args[0] === 'remove') console.log(plugin.removeSkillCmd(args.slice(1)));
    else if (args[0] === 'help') console.log(plugin.skillHelp());
    else console.log(plugin.listSkillsText());
  }

  cmdMcp(args) {
    const plugin = require('./plugin-cmd');
    if (args[0] === 'add') console.log(plugin.mcpAddCmd(args.slice(1)));
    else if (args[0] === 'remove') console.log(plugin.mcpRemoveCmd(args.slice(1)));
    else if (args[0] === 'toggle') console.log(plugin.mcpToggleCmd(args.slice(1)));
    else if (args[0] === 'help') console.log(plugin.mcpHelp());
    else console.log(plugin.listMcpText());
  }

  cmdExit() {
    if (this.session) {
      const res = saveSession(this.session);
      console.log('\nSession saved as: ' + res.id);
      console.log('Resume with: loom -s ' + res.id);
    }
    console.log('\nGoodbye from Loom Code!');
    process.exit(0);
  }

  completer(line) {
    const commands = [
      '/help', '/init', '/memory', '/connect', '/model', '/models',
      '/status', '/clear', '/compact', '/undo', '/reset', '/doctor',
      '/providers', '/skills', '/mcp', '/format', '/lsp', '/exit'
    ];
    const hits = commands.filter(c => c.startsWith(line));
    return [hits.length ? hits : commands, line];
  }
}

function findBun() {
  // Check common installation paths
  const paths = [
    path.join(os.homedir(), '.bun', 'bin', 'bun.exe'),
    path.join(os.homedir(), '.bun', 'bin', 'bun'),
    '/usr/local/bin/bun',
    '/opt/homebrew/bin/bun',
    '/usr/bin/bun',
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  // Search PATH (Windows: where.exe, POSIX: which)
  try {
    const { execSync } = require('child_process');
    const isWin = process.platform === 'win32';
    const result = execSync(isWin ? 'where.exe bun 2>nul' : 'which bun 2>/dev/null', { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    if (result && fs.existsSync(result.split('\n')[0].trim())) return result.split('\n')[0].trim();
  } catch {}
  return null;
}

async function main() {
  const cli = new LoomCLI();

  const args = process.argv.slice(2);
  const VERSION = require('../../package.json').version;

  const printIdx = args.indexOf('-p');
  const printLongIdx = args.indexOf('--print');
  const printMode = printIdx !== -1 || printLongIdx !== -1;
  const autoMode = args.includes('--auto') || args.includes('-a');
  if (autoMode) cli.session.permissions.setAuto(true);

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`loom-code v${VERSION}`);
    process.exit(0);
  }
if (args.includes('--help') || args.includes('-h')) {
    console.log('loom - AI coding agent for the terminal');
    console.log('Usage: loom [options] [prompt...]');
    console.log('  loom                    Start interactive TUI session');
    console.log('  loom "prompt"           Start with initial prompt');
    console.log('  loom -p "query"         Run one-shot, print result, exit');
    console.log('  loom --basic            Use basic line-mode REPL (no TUI)');
    console.log('  loom --auto             Auto-approve permission prompts');
    console.log('  loom acp                ACP server (JSON-RPC over stdio, for editor plugins)');
    console.log('  loom web                Browser interface (HTTP server, opens the browser)');
    console.log('  loom attach <url>       Attach the terminal to a running `loom web` server');
    console.log('  loom -s <session-id>    Resume a saved session');
    console.log('  loom --version           Show version');
    console.log('  loom --help              Show this help');
    process.exit(0);
  }

  const sIndex = args.indexOf('-s');
  const sessionId = sIndex !== -1 ? args[sIndex + 1] : null;

  // loom graph [open] — memory graph subcommand.
  //   loom graph         rebuild + print the graph as text, exit
  //   loom graph open    serve the browser graph view and open it
  if (args[0] === 'graph') {
    const open = args[1] === 'open' || args[1] === '--open';
    await cli.cmdGraph(open ? ['open'] : []);
    if (!open) process.exit(0);
    return;
  }

  if (sessionId && sIndex !== -1) {
    const data = loadSession(sessionId);
    if (data && data.messages && data.messages.length) {
      console.log(`Resuming session ${sessionId} (${data.messages.length} messages)`);
      cli.initialSession = data;
    } else {
      console.error('Session not found: ' + sessionId);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => {
    if (cli.session) {
      const id = saveSession(cli.session).id;
      console.log('\nSession saved: ' + id);
      console.log('Resume with: loom -s ' + id);
    }
    process.exit(0);
  });
  defaultMcpInstall();

  const promptArgs = args.filter(a => !a.startsWith('-'));

  if (printMode) {
    await cli.headless(promptArgs.join(' '));
    return;
  }

  if ((args.includes('--tui') || (!args.includes('--basic') && process.stdin.isTTY))) {
    const canRaw = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';
    if (canRaw) {
      // Launch new OpenTUI TUI via bun
      const bunPath = findBun();
      const tuiEntry = path.join(__dirname, '..', 'tui-open.tsx');
      if (bunPath && fs.existsSync(tuiEntry)) {
        const { spawnSync } = require('child_process');
        // Start bun from the package root so it discovers bunfig.toml /
        // tsconfig.json (Solid JSX preloader) even for global installs;
        // LOOM_START_CWD restores the user's project dir in tui-bootstrap.js.
        const pkgRoot = path.join(__dirname, '..', '..');
        process.env.LOOM_START_CWD = process.cwd();
        process.env.LOOM_BIN_NAME = "loom";
        // --conditions=browser pins Solid to its client build (see
        // bin/loom-tui.js) — without it the SSR build loads and the TUI
        // renders one static frame then never updates.
        const tuiArgs = [tuiEntry];
        if (sessionId) tuiArgs.push('-s', sessionId);
        if (autoMode) tuiArgs.push('--auto');
        const prompt = promptArgs.join(' ');
        if (prompt) tuiArgs.push(...prompt.split(/\s+/));
        process.exit(spawnSync(bunPath, tuiArgs, { stdio: 'inherit', cwd: pkgRoot, env: process.env }).status ?? 0);
      }
      console.error('[loom] bun not found — full TUI requires bun (https://bun.sh/). Falling back to line-mode REPL.');
      console.error('[loom] Use --basic to skip this warning.\n');
    }
  }

  cli.initialPrompt = promptArgs.join(' ');
  await cli.start();
}

module.exports = { main, LoomCLI };