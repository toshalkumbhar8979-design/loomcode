import { test, expect } from "bun:test";
const { TranscriptUndo, MAX_UNDO } = require("./transcript-undo.js");

const snap = (ui, label) => ({ ui, session: [...ui], todos: [], label });

test("push then undo returns the prior snapshot", () => {
  const e = new TranscriptUndo();
  const step = e.push(snap(["a"]), "turn a");
  expect(e.canUndo()).toBe(true);
  const out = e.undo(snap(["a", "b"]));
  expect(out.ui).toEqual(["a"]);
  expect(e.canUndo()).toBe(false);
  expect(e.canRedo()).toBe(true);
});

test("redo re-applies the undone state", () => {
  const e = new TranscriptUndo();
  e.push(snap(["a"]));
  e.undo(snap(["a", "b"])); // now at ["a"], redo holds ["a","b"]
  const redone = e.redo(snap(["a"]));
  expect(redone.ui).toEqual(["a", "b"]);
  expect(e.canRedo()).toBe(false);
});

test("undo/redo on empty stacks returns null", () => {
  const e = new TranscriptUndo();
  expect(e.undo(snap(["x"]))).toBe(null);
  expect(e.redo(snap(["x"]))).toBe(null);
});

test("push clears the redo stack (new action diverges history)", () => {
  const e = new TranscriptUndo();
  e.push(snap(["a"]));
  e.undo(snap(["a", "b"]));
  expect(e.canRedo()).toBe(true);
  e.push(snap(["a", "z"]), "diverge");
  expect(e.canRedo()).toBe(false);
});

test("clones snapshots so later mutation cannot corrupt stored state", () => {
  const e = new TranscriptUndo();
  const ui = ["a"];
  e.push(snap(ui));
  ui.push("mutated-after-push");
  const out = e.undo(snap(["a", "b"]));
  expect(out.ui).toEqual(["a"]);
});

test("bounded to max, dropping the oldest", () => {
  const e = new TranscriptUndo(3);
  for (let i = 0; i < 5; i++) e.push(snap(["s" + i]));
  expect(e.depth().undo).toBe(3);
  // Oldest two ("s0","s1") were dropped; top of stack is "s4".
  expect(e.peekUndo().ui).toEqual(["s4"]);
});

test("late-bound restoreId sticks on the returned step reference", () => {
  const e = new TranscriptUndo();
  const step = e.push(snap(["a"]));
  // Simulates App.tsx stitching a restore-point id in a background setTimeout.
  step.restoreId = "rp_123";
  const out = e.undo(snap(["a", "b"]));
  expect(out.restoreId).toBe("rp_123");
});

test("clear empties both stacks", () => {
  const e = new TranscriptUndo();
  e.push(snap(["a"]));
  e.undo(snap(["a", "b"]));
  e.clear();
  expect(e.canUndo()).toBe(false);
  expect(e.canRedo()).toBe(false);
});

test("MAX_UNDO default is 50", () => {
  expect(MAX_UNDO).toBe(50);
  expect(new TranscriptUndo().max).toBe(50);
});
