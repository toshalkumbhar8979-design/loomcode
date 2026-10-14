// Loom Code — VS Code extension (zero-build, plain CommonJS).
//
// Bridges VS Code to the locally installed `loom` CLI:
//   1. loomcode.openTerminal — full interactive TUI in an integrated terminal
//   2. loomcode.ask          — headless `loom -p` on the selection/question
//   3. loomcode.openWebUi    — runs `loom web` (fixed since v1.2.36) and docks
//                              its browser UI as an editor pane
//   4. loomcode.stopWebUi    — shuts that local server down
//
// No bundler, no typecheck step: `main` is this file directly, so F5 just works.
'use strict';

const vscode = require('vscode');
const { spawn, spawnSync } = require('child_process');
const http = require('http');

let webProc = null;
let webPort = null;

function outputChannel() {
  return vscode.window.createOutputChannel('Loom Code');
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : undefined;
}

function loomMissing() {
  const probe = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    ['loom'],
    { encoding: 'utf8' }
  );
  return probe.status !== 0;
}

/** Spawn loom with args, capture combined stdout/stderr as one string. */
function runLoom(args, timeoutSec) {
  return new Promise((resolve) => {
    const p = spawn('loom', args, {
      shell: process.platform === 'win32',
      cwd: workspaceRoot(),
    });
    let buf = '';
    const timer = setTimeout(() => {
      try { p.kill(); } catch {}
      resolve(buf.trim() + '\n(loom: timed out)');
    }, (timeoutSec || 180) * 1000);
    p.stdout.on('data', (d) => { buf += d; });
    p.stderr.on('data', (d) => { buf += d; });
    p.on('error', () => {
      clearTimeout(timer);
      resolve('[loom] not found. Install with: npm i -g loom-agent');
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(buf.trim() || `(loom exited with ${code})`);
    });
  });
}

/** True when /api/health on 127.0.0.1:port answers 200. */
function healthOk(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 1200 },
      (res) => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Start (or reuse) `loom web`, wait until healthy, resolve the port. */
async function ensureWebServer(port) {
  if (webProc && !webProc.killed && webPort === port && (await healthOk(port))) {
    return port;
  }
  await stopWebServer();
  const channel = outputChannel();
  channel.appendLine(`[loom web] starting on 127.0.0.1:${port}`);
  webProc = spawn('loom', ['web', '--port', String(port), '--no-open'], {
    shell: process.platform === 'win32',
    cwd: workspaceRoot(),
  });
  webProc.stdout.on('data', (d) => channel.append('[loom web] ' + d));
  webProc.stderr.on('data', (d) => channel.append('[loom web!] ' + d));
  webProc.on('exit', (code) => {
    channel.appendLine(`[loom web] exited (${code})`);
    if (webProc === null || webProc.pid === undefined) {} // noop guard
    webProc = null;
  });
  for (let i = 0; i < 40; i++) {
    if (!webProc) break;
    if (await healthOk(port)) { webPort = port; return port; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    'loom web did not become healthy on port ' + port +
    ' — check the Loom Code output channel.'
  );
}

async function stopWebServer() {
  if (webProc) {
    try { webProc.kill(); } catch {}
    webProc = null;
    webPort = null;
    return true;
  }
  return false;
}

function activate(context) {
  const channel = outputChannel();

  const openChatTerminal = vscode.commands.registerCommand('loomcode.openTerminal', async () => {
    if (loomMissing()) {
      const go = await vscode.window.showWarningMessage(
        'Loom CLI not found on PATH.', 'Install instructions'
      );
      if (go) vscode.env.openExternal(vscode.Uri.parse('https://www.npmjs.com/package/loom-agent'));
      return;
    }
    const term = vscode.window.createTerminal({ name: 'Loom Code', cwd: workspaceRoot() });
    term.show(true);
    term.sendText('loom', true);
  });

  const askAboutSelection = vscode.commands.registerCommand('loomcode.ask', async () => {
    if (loomMissing()) {
      vscode.window.showWarningMessage('Loom CLI not found on PATH.');
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const selText = editor && !editor.selection.isEmpty
      ? editor.document.getText(editor.selection)
      : '';
    const fileName = editor ? editor.document.uri.path.split('/').pop() : '';
    const question = await vscode.window.showInputBox({
      prompt: selText ? `Ask Loom about the selection in ${fileName}` : 'Ask Loom',
      placeHolder: 'e.g. explain what this does / find the bug / write tests',
    });
    if (!question) return;
    const prompt = selText
      ? `${question}\n\nFile: ${fileName}\n\`\`\`\n${selText}\n\`\`\``
      : question;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Asking Loom…' },
      async () => {
        const timeoutSec = Number(vscode.workspace.getConfiguration('loomcode').get('printTimeoutSeconds')) || 180;
        const answer = await runLoom(['-p', prompt], timeoutSec);
        channel.appendLine('── ' + new Date().toLocaleTimeString() + ' ──────────────────');
        channel.appendLine('Q: ' + question);
        channel.appendLine(answer);
        channel.appendLine('');
        channel.show(true);
      }
    );
  });

  const openWebUi = vscode.commands.registerCommand('loomcode.openWebUi', async () => {
    if (loomMissing()) {
      vscode.window.showWarningMessage('Loom CLI not found on PATH.');
      return;
    }
    const port = Number(vscode.workspace.getConfiguration('loomcode').get('webPort')) || 4399;
    try {
      await ensureWebServer(port);
    } catch (e) {
      vscode.window.showErrorMessage(String((e && e.message) || e));
      channel.show(true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'loomcodeWebUi', 'Loom Code', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html =
      '<!DOCTYPE html><html><head>' +
      '<meta http-equiv="Content-Security-Policy" content="frame-src http://127.0.0.1:*">' +
      '<style>html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style>' +
      '</head><body><iframe src="http://127.0.0.1:' + port + '" allow="clipboard-write"></iframe></body></html>';
  });

  const stopUi = vscode.commands.registerCommand('loomcode.stopWebUi', async () => {
    if (await stopWebServer()) {
      vscode.window.showInformationMessage('Loom local server stopped.');
    } else {
      vscode.window.showInformationMessage('No Loom server was started by this window.');
    }
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.text = '$(sparkle) Loom';
  status.tooltip = 'Loom Code — open chat terminal';
  status.command = 'loomcode.openTerminal';
  status.show();

  context.subscriptions.push(openChatTerminal, askAboutSelection, openWebUi, stopUi, status, channel);

  // Reap a server this window started when VS Code closes.
  context.subscriptions.push({ dispose: stopWebServer });
}

function deactivate() {
  stopWebServer();
}

module.exports = { activate, deactivate };


