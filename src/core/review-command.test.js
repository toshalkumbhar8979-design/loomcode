// Unit tests for the built-in /review prompt builder (src/core/review-command.js).
import { test, expect } from "bun:test";

const { REVIEW_TEMPLATE, buildReviewPrompt } = require("./review-command.js");

test("review prompt: defaults to uncommitted changes", () => {
  const prompt = buildReviewPrompt("");
  expect(prompt).toContain("Input: (none - review uncommitted changes)");
  expect(prompt).toContain("git diff");
  expect(prompt).toContain("git diff --cached");
  expect(prompt).toContain("git status --short");
  expect(prompt).not.toContain("$ARGUMENTS");
});

test("review prompt: substitutes a commit hash everywhere", () => {
  const prompt = buildReviewPrompt("abc1234");
  expect(prompt).toContain("Input: abc1234");
  expect(prompt).toContain("git show abc1234");
  expect(prompt).toContain("git diff abc1234...HEAD");
  expect(prompt).not.toContain("$ARGUMENTS");
});

test("review prompt: supports PR targets and trims input", () => {
  const prompt = buildReviewPrompt("  https://github.com/org/repo/pull/42  ");
  expect(prompt).toContain("Input: https://github.com/org/repo/pull/42");
  expect(prompt).toContain("gh pr view https://github.com/org/repo/pull/42");
  expect(prompt).toContain("gh pr diff https://github.com/org/repo/pull/42");
});

test("review prompt: keeps review-only, severity-ranked output rules", () => {
  expect(REVIEW_TEMPLATE).toContain("Only review the changes");
  expect(REVIEW_TEMPLATE).toContain("severity");
  expect(REVIEW_TEMPLATE).toContain("file:line");
  expect(REVIEW_TEMPLATE).toContain("If there are no issues, say so explicitly");
});
