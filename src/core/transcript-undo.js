// Transcript undo/redo — the conversation-level counterpart to /restore
// (which rewinds the FILE TREE). Each undoable step is one user turn: the
// full transcript (UI messages + session messages + todos) captured right
// before the turn ran, plus the restore-point id created for that same turn
// so an undo can also offer to roll the working tree back.
//
// Pure engine, no TUI/reactivity — the App owns the stacks and passes plain
// snapshots in, which keeps this unit-testable.

const MAX_UNDO = 50;

// A snapshot is an opaque object the caller builds (it knows how to clone its
// own UI + session state). We only ever store and hand back references.
// shape: { ui: any[], session: any[], todos: any[], restoreId?: string, label?: string }

function cloneSnap(snap) {
  // structuredClone is available on Node 18+/Bun; fall back to JSON for the
  // plain-JSON session data (never holds functions or DOM handles).
  if (typeof structuredClone === 'function') {
    try { return structuredClone(snap); } catch {}
  }
  return JSON.parse(JSON.stringify(snap));
}

class TranscriptUndo {
  constructor(max = MAX_UNDO) {
    this.max = max;
    this.undoStack = [];
    this.redoStack = [];
  }

  // Record the state as it was BEFORE a turn ran. Clears the redo stack (a
  // fresh action diverges history, like any editor). Returns the step object
  // so callers can attach late-bound data (e.g. a restore-point id created in
  // a background setTimeout) without relying on a fragile stack index.
  push(beforeSnap, label) {
    const step = cloneSnap(beforeSnap);
    step.label = label || '';
    this.undoStack.push(step);
    if (this.undoStack.length > this.max) this.undoStack.shift();
    // A new action invalidates the future.
    this.redoStack.length = 0;
    return step;
  }

  // Move one turn backward. `currentSnap` is the state we are leaving — it
  // goes onto the redo stack so the undo can be re-done. Returns the snapshot
  // to restore, or null when there is nothing to undo.
  undo(currentSnap) {
    if (!this.undoStack.length) return null;
    const target = this.undoStack.pop();
    if (currentSnap) this.redoStack.push(cloneSnap(currentSnap));
    if (this.redoStack.length > this.max) this.redoStack.shift();
    return target;
  }

  // Move one turn forward again. Returns the snapshot to restore, or null.
  redo(currentSnap) {
    if (!this.redoStack.length) return null;
    const target = this.redoStack.pop();
    if (currentSnap) this.undoStack.push(cloneSnap(currentSnap));
    if (this.undoStack.length > this.max) this.undoStack.shift();
    return target;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  peekUndo() { return this.undoStack[this.undoStack.length - 1] || null; }
  peekRedo() { return this.redoStack[this.redoStack.length - 1] || null; }
  depth() { return { undo: this.undoStack.length, redo: this.redoStack.length }; }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; }
}

module.exports = { TranscriptUndo, MAX_UNDO };
