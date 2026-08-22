// Background tasks — long-running shell commands that don't block the agent
// loop. The bash tool starts them with background:true; /tasks lists status.
// Output is capped per task; finished tasks linger until cleared.
const { spawn } = require('child_process');
const { emit } = require('./events');

/** @type {Map<string, object>} */
const tasks = new Map();
let seq = 0;
// Per-task output cap (matches the foreground 10 MB spirit; smaller here).
const MAX_BUF = 2 * 1024 * 1024;

/**
 * Start a command in the background.
 * @param {string} command
 * @returns {{ id: string }|{ error: string }} or { error } on spawn failure
 */
function startBackgroundTask(command) {
  const id = 'bt-' + (++seq) + '-' + Date.now().toString(36);
  /** @type {{id:string,command:string,status:string,startedAt:number,endedAt:number|null,exitCode:number|null,output:string,truncated:boolean,_child:any}} */
  const entry = {
    id,
    command: String(command || ''),
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    output: '',
    truncated: false,
    _child: null,
  };
  let child;
  try {
    child = spawn(entry.command, { shell: true, windowsHide: true, detached: process.platform !== 'win32' });
  } catch (e) {
    return { error: e.message };
  }
  const pushOut = (d) => {
    if (entry.truncated) return;
    if (entry.output.length + d.length > MAX_BUF) {
      entry.output += d.slice(0, Math.max(0, MAX_BUF - entry.output.length));
      entry.output += '\n[output truncated at 2 MB]';
      entry.truncated = true;
      return;
    }
    entry.output += d;
  };
  child.stdout.on('data', pushOut);
  child.stderr.on('data', pushOut);
  child.on('error', (e) => {
    entry.status = 'error';
    entry.endedAt = Date.now();
    entry.output += '\n[spawn error] ' + e.message;
    emit('tasks:changed', { id });
  });
  child.on('close', (code) => {
    if (entry.status === 'killed') return;
    entry.status = code === 0 ? 'done' : 'error';
    entry.exitCode = code;
    entry.endedAt = Date.now();
    emit('tasks:changed', { id });
  });
  entry._child = child;
  tasks.set(id, entry);
  return { id };
}

/** Get one task (without the child handle). */
function getBackgroundTask(id) {
  const t = tasks.get(id);
  if (!t) return null;
  const { _child, ...rest } = t;
  return rest;
}

/**
 * List tasks, newest first. opts.running only running ones.
 * @param {{ running?: boolean }} [opts]
 */
function listBackgroundTasks(opts) {
  let all = [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  if (opts && opts.running) all = all.filter(t => t.status === 'running');
  return all.map(({ _child, ...rest }) => rest);
}

/** Kill a running task. Returns true when found+signalled. */
function killBackgroundTask(id) {
  const t = tasks.get(id);
  if (!t || t.status !== 'running') return false;
  t.status = 'killed';
  try { t._child.kill(); } catch {}
  t.endedAt = Date.now();
  return true;
}

/** Drop finished/errored/killed tasks from the list. */
function clearFinishedTasks() {
  for (const [id, t] of tasks) {
    if (t.status !== 'running') tasks.delete(id);
  }
}

module.exports = { startBackgroundTask, getBackgroundTask, listBackgroundTasks, killBackgroundTask, clearFinishedTasks };
