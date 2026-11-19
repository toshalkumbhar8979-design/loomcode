// Cancellation-aware time limits used at every production boundary.
// A Promise.race alone only stops waiting; this helper also aborts the work.

class DeadlineExceededError extends Error {
  /** @param {string} label @param {number} timeoutMs */
  constructor(label, timeoutMs) {
    super(`${label} timed out after ${Math.ceil(timeoutMs / 1000)}s.`);
    this.name = 'DeadlineExceededError';
    this.code = 'LOOM_TIMEOUT';
    this.permanent = true;
  }
}

/** @param {AbortSignal|undefined|null} parent @param {AbortSignal} local */
function mergeSignals(parent, local) {
  if (!parent) return local;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any([parent, local]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted || local.aborted) abort();
  else {
    parent.addEventListener('abort', abort, { once: true });
    local.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

/**
 * @template T
 * @param {string} label
 * @param {number} timeoutMs
 * @param {AbortSignal|undefined|null} parentSignal
 * @param {(signal: AbortSignal) => Promise<T>} work
 * @returns {Promise<T>}
 */
async function withDeadline(label, timeoutMs, parentSignal, work) {
  const limit = Number(timeoutMs);
  if (!Number.isFinite(limit) || limit <= 0) return work(parentSignal || new AbortController().signal);
  const local = new AbortController();
  const signal = mergeSignals(parentSignal, local.signal);
  let timer;
  // Attach a rejection handler before the race can settle. If a transport
  // ignores AbortSignal and rejects later, it must not become unhandled after
  // the caller has already received the timeout.
  const pending = Promise.resolve().then(() => work(signal));
  pending.catch(() => {});
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          local.abort();
          reject(new DeadlineExceededError(label, limit));
        }, limit);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { DeadlineExceededError, withDeadline, mergeSignals };
