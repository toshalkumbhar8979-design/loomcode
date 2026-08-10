# AGENTS.md — Loom Code developer runbook

## Toolchain (pinned)

- **Bun 1.3.14** — the project runs and tests on Bun. Do NOT upgrade the pinned
  version without updating BOTH `bunup.sh` and `.gitlab-ci.yml`, regenerating
  the SHA-256 hashes from the release's official SHASUMS256.txt, and running
  the full test gate.
- **Node 22** — only for `tsc` typechecks and plain `node` runs.
- POSIX install/upgrade of the pinned Bun: `./bunup.sh` (downloads the pinned
  release zip and verifies its SHA-256). Windows CI does the equivalent inline
  in `.gitlab-ci.yml` (`test:windows` job).

## The full test gate — run before every push

Exactly: `bun run test` — must exit 0. It runs three stages:

1. `bun run src/tui/test-interactive.tsx` — 50 keyboard-interaction tests of
   the OpenTUI interface (splash, slash popup, paste, busy-submit hold, caret
   editing, markdown rendering, permission popup, /budget, /skills, /mcp …).
2. `bun run test:unit` — `bun test` over the 7 core test files
   (87 pass / 2 skip). When you add a test file under `src/`, register it in
   the `test:unit` script in `package.json` or it will NOT run in CI.
3. `bun run lint:core` — `tsc -p tsconfig.core.json`: strict typecheck of the
   core JSDoc layer ONLY (`src/core`, `src/providers`, `src/mcp`, `src/skills`,
   `src/tools`, `src/config`). New exports there need `@typedef` JSDoc types
   (see `SpeedStats` in `src/core/session.js` for the pattern).

Useful partial runs:
- `bun run test:unit` — unit tests only (fast).
- `bun run lint:core` — strict core typecheck only.
- `bun run lint` — full (non-strict) `tsc --noEmit` over everything; this is
  NOT part of the gate because the TUI layer is deliberately lax.

## Conventions

- `dist/`, `.loom/`, and `node_modules/` are gitignored local artifacts.
- Core layer (`src/core/...`) is plain ESM JavaScript with strict-JSDoc types;
  the TUI (`src/tui/...`) is SolidJS + TSX on OpenTUI.
- Keep `bun.lock` and `package-lock.json` in sync when changing dependencies.
