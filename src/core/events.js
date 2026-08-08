// Tiny synchronous event bus. Core emits lifecycle events (turn start/end,
// model switch, tool calls, cost recorded); features like the pet, toasts, and
// telemetry subscribe without coupling.
const listeners = new Map();

function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

function off(event, fn) {
  listeners.get(event)?.delete(fn);
}

function emit(event, data) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of Array.from(set)) {
    try { fn(data); } catch {}
  }
}

module.exports = { on, off, emit };
