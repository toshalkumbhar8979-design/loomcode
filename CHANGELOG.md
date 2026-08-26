# Changelog

All notable changes to **Loom Code** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.35] — security hardening

### Fixed
- **webfetch SSRF guard (`src/tools/index.js`).** The fetch tool is driven by
  the model, and prompt-injected page content could steer it at cloud
  metadata (`169.254.169.254`), localhost services, or internal hosts.
  webfetch now allows only `http:`/`https:` (no `file:`/`ftp:`/`data:`),
  refuses loopback, RFC1918, CGNAT, link-local/metadata, IPv6 ULA/link-local
  and IPv4-mapped targets, **resolves DNS before connecting** so
  hostname→internal-IP tricks fail, follows redirects manually and re-checks
  every hop, and fails closed on unresolvable hosts.
- **MCP servers no longer inherit the full shell environment**
  (`src/mcp/mcp-client.js`). Every spawned MCP server used to receive all of
  `process.env` — provider API keys, cloud tokens, cookies — handing them to
  whatever npm package a config starts. Servers now get a minimal OS/runtime
  baseline (PATH, ComSpec, TEMP/HOME, proxy vars) plus only what their own
  config explicitly declares (`cfg.env`). Secrets are opt-in per server.
- **Skills install name traversal blocked (`src/skills/skills-manager.js`).**
  A remote-provided install name like `../../escapee` was joined raw onto
  `~/.loom/skills`. Names are now a strict allowlist
  (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`); traversal attempts error instead of
  silently renaming or escaping the skills directory.

### Added
- **`loom web` session hardening (`src/web/web-server.js`).** Login tokens
  previously lived until server restart; they now expire after **12 h**
  (tunable via `LOOM_SERVER_TOKEN_TTL_MS`, cookie `Max-Age` kept in sync), a
  lazy sweep drops expired tokens, and new **`POST /api/auth/logout`**
  revokes the presented token immediately.
- **Security headers on every response:** `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`; the browser UI
  additionally ships a strict `Content-Security-Policy`
  (`default-src 'none'; connect-src 'self'` — the page is self-contained).
- **LAN-exposure warning:** `loom web --hostname 0.0.0.0` (or `::`) without
  `LOOM_SERVER_PASSWORD` now prints an explicit warning that anyone on the
  network can run an agent and reach its tools/files.
- **New regression suite `src/tools/security.test.js`** plus five web-server
  hardening tests (headers, CSP, token TTL expiry, Max-Age sync, logout).

## [1.2.34] — bundle bun with the npm install

### Added
- **`npm i -g loom-agent` now brings its own bun.** The `@oven/bun-<platform>`
  binaries (pinned to bun 1.3.14, the version the project builds against) ship
  as `optionalDependencies`; npm downloads only the one matching the user's
  OS/arch, and no install scripts are involved (npm allow-scripts policies
  cannot break it). The postinstall rewrites the `loom` shims to prefer the
  bundled binary, then `bun` from PATH.
- **No-bun users are never stranded:** if neither the bundled binary nor a
  PATH bun exists, the shim falls back to `node bin/loom.js` (the line-mode
  REPL) with a hint — instead of dying with "'bun' is not recognized".
  `findBun()` and the bin respawn paths check the bundled location first too.

## [1.2.33] — fix frozen splash on global installs + stable model picker

### Fixed
- **Global npm installs froze on the splash screen** ("Build … no key", no
  keyboard input) while repo checkouts worked. Root cause: the launch chain
  started Bun at the package root and later ran `process.chdir()` back to the
  user's project inside `tui-open.tsx`. That mid-flight chdir killed OpenTUI's
  repaint/input pipeline after the first frame — signals kept updating and
  Solid effects kept firing (verified with runtime instrumentation), but no
  frame ever reached the terminal again.
- The launcher now registers the Solid JSX preloader with **absolute
  `--preload` paths** and starts Bun **directly in the user's project
  directory**, so no chdir ever happens: `bin/loom-bun.js`, `bin/loom-tui.js`,
  the postinstall-rewritten shims, and the core-CLI TUI spawn
  (`src/core/cli.js`) were all switched to that scheme.
- **Model picker jitter** — scrolling `/models` (and every `SelectModal`:
  `/connect`, theme pickers, MCP preset picker) bounced the whole modal.
  Section headers added an extra margin row, so the centered frame's height
  flipped between 12/13/14 rows on every page of a header-heavy list. The
  list window is now a fixed 12 rows (headers are plain one-row entries), the
  window is computed once per change instead of mutating during render, and
  mouse-hover no longer yanks the selection while a keyboard/wheel scroll is
  settling. Regression test added (29b: modal title row must never move while
  scrolling).

## [Unreleased]

### Added
- **Data-driven tool display** — the chat renderer no longer checks tool
  *names* anywhere: every tool's icon, pending text, spinner, label,
  block/diff/todos/check/subagent flags and file-vs-bash diff behavior come
  from one display registry (`src/tui/tool-display.ts`), keyed by the tool
  name with a **GenericTool fallback** for anything unregistered (opencode
  and Cline behave the same way — the UI never hardcodes a tool list).
  `src/tui/toolname.ts` keeps only generic formatters. The agent loop no
  longer branches on `name === "write"` / `"bash"` either — it reads the
  registry's `diffs` flag.
- **Full-chat session restore** — `/sessions` (and `-s <id>`) restores the
  **whole conversation**, not just the text: thinking text, every tool row
  with its saved output, diffs, todos, error/interrupt flags. Older saves
  that only carry `toolCalls` are reconstructed (tool rows rebuilt from the
  calls, results attached), and saving now merges the TUI display parts into
  the session file so the restore is lossless.
- **Session picker sorted by recency** — `/sessions` now lists sessions by
  their last write time (updatedAt → createdAt → file mtime) instead of
  file name, which had legacy `share-*` exports pinned to the top forever
  and hid the real conversations; legacy files without a timestamp now show
  their file date.
- **Loop hardening** — the todos listener registers *before* the turn starts
  (a fast first update can't be missed), and a provider that throws
  synchronously now finishes the turn with an error bubble instead of
  leaving the chat stuck on "Thinking" forever.
- **Companion pets removed** — the ASCII pet, OpenPets desktop sync, and
  `/companion` are gone (declared useless); the sidebar row now shows the
  **Auto-approve** status instead ("on — no asks" / "off — asks per command",
  Shift+Tab toggles). The `@open-pets/client` dependency was dropped.
- **Tool activity in the chat** — a faithful port of opencode's chat-area
  layout: **every tool call gets its own row** (`→ Read src/a.ts`,
  `← Edit src/b.ts`, `$ git status`, `✱ Glob "**/*.ts"` … — never one merged
  patch for all commands) and rows are packed **tightly**, opencode's
  "always separate" rule: consecutive single-line rows share no gap, only
  the first row after the reasoning/text part and anything around a block
  get one. While running, most tools show the quiet `~ Preparing edit...`
  pending text (deeper indent, no spinner glyph, no accent — opencode only
  spins read/task/execute rows, which show `⠋ Read src/a.ts`). Once done,
  the row flips to a muted `icon label` line that **stays** in the
  transcript. A finished write/edit/bash that actually changed a file
  **replaces its row with the patch** — opencode's Edit renders only its
  BlockTool once the diff exists: a panel on `bgPanelAlt` with a subtle
  left border, titled `← Edit src/b.ts` / `# Wrote {path}`, with the
  `+2 -1` counts and the colored +/- hunks — right where the edit happened,
  then the message continues normally. The assistant answer has **no
  bubble**: reasoning streams as its own full-width part (`⠋ Thinking`
  spinner with the body live while the turn runs, collapsing to a clickable
  `+ Thought · 4.2s` once done), tool rows, then the plain text part. The
  **`# Todos` block** (same BlockTool panel) renders after the last block,
  opencode TodoWrite-style (sidebar keeps its own copy). A `task` subagent
  shows as an opencode InlineTool row — `│ @explore Task` spinning while
  the child runs, flipping to `✓ @explore Task` once done, with `↳ tool
  log` and the streamed body beneath, ending in `↳ finished · done`. Tool
  rows are throttled (first tool of a burst renders immediately, the rest
  ride the 100 ms stream flush) so fast bursts no longer re-render or
  reflow the whole message (that reflow was what made fast output jitter).
- **Chatbox vibration fixed** — the caret blink now swaps *color*, never
  the character. The cell always renders a full block (`█`); when the blink
  is off its `fg` matches the background behind it (`bgInput`, or `primary`
  inside a selection) so the block is invisible without changing text
  length. TUI renderers commonly trim trailing whitespace per line, which
  made the earlier "space-when-off" caret shorten the last wrapped line at
  blink rate and vibrate the box height while typing; swapping color
  instead means the wrap is identical in both blink phases and the box
  stays smooth while typing, opencode-style.
- **One-time session permissions prompt** — every new session asks once:
  "Allow all commands in this session?" or "Ask each time" — no more
  per-command prompts slowing the loop. **Shift+Tab** toggles session-wide
  auto-approval on/off any time (a muted `· auto` indicator in the status
  line shows the state; the popup answers it too).
- **Browser memory graph** — `loom graph open` (or `/graph open`) renders the
  LOOM.md knowledge graph as a force-directed canvas view in the default
  browser: drag nodes, wheel zoom, pan the background, click a node for its
  details, filter by type, and search. The TUI `/graph` modal also now shows
  the `##`/`###` heading hierarchy as a browsable tree (17 nodes, 4 links in
  LOOM.md).
- **First-run welcome tips** — a small dismissible (✕) card in the sidebar for
  new users only: "Loom supports 180+ providers — /connect to add a key".
  Dismissal persists in `~/.loom/tui.json`, so it never comes back.
- **Borderless panel UI** — the breadcrumb bar, sidebar, and chatbox no longer
  draw box-drawing borders. Panels separate via background color, so terminal
  text selection (copy) is never snagged on grid lines.
- **opencode-style layout** — the chatbox now lives in the chat column with a
  breathing gap between it and the sidebar (no shared bottom edge); the
  sidebar is a full-height, locked column with its own internal scroll; the
  chatbox grows to 14 rows and its wrap-width math matches the real box width
  so the text no longer vibrates at wrap boundaries.
- **Roomier, calmer chatbox** — the resting chatbox is 5 rows tall (splash
  screen included, centered like opencode) and grows smoothly with the draft;
  the mode name ("Build · all tools") sits at the chatbox bottom instead of a
  single-letter "B" header, and the text always starts one row below the top
  edge (the old empty header row collapsed, pushing text against the top).
  The status line below is one clean opencode-style row — cwd · usage
  ("53.7K (27%) · $8.17") · "ctrl+p commands" — instead of three rows of
  clutter. Wrap-width math is exact (integer-snapped to the measured box
  width), so the height never oscillates and the box never vibrates the
  screen while typing; past the limit the draft scrolls instead of hiding
  lines. Pasted drafts past 10 lines render compressed — first 10 lines plus
  a "pasted ~N lines" badge — instead of blowing the box up; any keystroke
  expands the full text back.
- **Instant /models** — the registry cache was re-parsed (a multi-MB JSON
  file) once per provider on every model-list open, stalling the picker for
  seconds. `loadRegistry()` is now memoized per process (invalidated only
  when a fresh fetch lands): `/models` and the provider picker open
  instantly again.
- **Fewer permission prompts** — bash now auto-allows normal commands by
  default (dangerous ones — `sudo`, `rm -rf`, `git push --force`, global
  installs … — still ask, defense in depth stays). Edit/task/skill asks are
  unchanged; `/auto` still flips full auto-approve on/off.
- **Extended thinking on every step (opencode-style)** — when the active
  model supports reasoning, Loom now asks it to think before EVERY reply,
  including after each tool result, so complex tasks get multiple thinking
  passes instead of a single one. Anthropic extended thinking
  (`thinking: enabled`) is enabled for Sonnet 4/Opus 4 (temperature is
  dropped, which the API requires); OpenAI effort models (o1/o3/o4/gpt-5)
  get `reasoning_effort: high`; DeepSeek R1 / Qwen QwQ / Kimi K2 already
  emit reasoning on their own. Each pass streams live into the "+Thought"
  panel. The system prompt now tells the model to re-evaluate after every
  tool result on complex tasks instead of rushing the answer.
- **The ask tool (questions, not permissions)** — the model can now ask you a
  question with up to 3 answer options (or let you type your own) when it
  genuinely needs input. The permission popup splits into two clear modes:
  permissions (bash/write/…) show only **Allow · Always allow · Deny** — and
  for commands a fourth row, **Allow all commands in this session** (flips
  auto-approve on for the rest of the session, `/auto` to turn it back off) —
  while the ask tool shows the question, its options, and a "Type your
  answer…" row. Typing on a permission popup is now ignored instead of
  opening a bogus answer editor, and the answer you pick or type is fed back
  to the model as the tool result.
- **Floating dialogs (no more "new window")** — `/models`, `/mcp`,
  `/connectors`, `/settings`, and the rest now render as a compact centered
  panel with no full-screen backdrop, so the chat and any running agent stay
  visible and untouched while you browse — the agent keeps working behind the
  dialog, exactly like opencode's palette.
- **Guided key entry for connectors** — presets that need a secret
  (Supabase, Railway, Vercel, GitHub, …) no longer dump a raw
  `-e KEY= railway -- npx …` command line into your face. They ask one
  masked "Paste your token" field per secret (URLs/IDs are shown unmasked so
  you can see them) and build the server command automatically. Click-free,
  paste-friendly, and the token never lands in the visible command.
- **Todos live in the sidebar** — the todo list no longer renders inside the
  chat bubble; the chat uses the full area for the conversation while the
  Todos tab shows live progress, opencode-style.
- **Memory graph (`/graph`)** — type `/graph` in the TUI to open a full-screen
  interactive view of your project's memory graph. Nodes represent decisions,
  conventions, bugfixes, and notes extracted from LOOM.md (and any
  `.loom/graph/nodes/*.md` files); edges show `[[wikilink]]` relationships.
  The graph auto-generates from your memory files and saves a `graph.json`
  to `.loom/graph/` for fast reload. Navigate with arrow keys, PgUp/PgDn,
  Home/End; press ESC to return to the chat view. In the CLI, `/graph`
  prints a text summary and writes `graph.json` for the TUI to consume.
- **opencode-scale provider registry (models.dev)** — Loom now supports the
  same 180+ providers as opencode via the models.dev dataset, fetched once and
  cached at `~/.loom/models-dev.json` (7-day freshness). Registry providers
  become OpenAI-compatible runtimes with their real model lists, prices, and
  context windows; `/models` shows every model grouped by provider once the
  provider's key env var is set (`/connect` hints the exact var name).
  - Built-in providers (Anthropic, OpenAI, NVIDIA, Google, OpenRouter, Token
    Router, Local) always win the merge; registry entries without models are
    skipped; `/providers` lists everything.
  - The provider picker fetches the registry on first open and re-opens with
    the full list when a fetch lands mid-session.
  - `/connect <provider>` in the CLI accepts any registry provider (not just
    the built-in five).
- **Editor integration via the Agent Client Protocol (ACP)** — `loom acp`
  subprocess mode (JSON-RPC over stdio) so Zed, JetBrains, and Neovim
  (Avante.nvim / CodeCompanion.nvim) can drive Loom as their coding agent.
  - `docs/acp.md`: transport + methods reference, Zed/JetBrains/Neovim configs,
    protocol walkthrough, ACP Registry publishing notes.
  - `scripts/acp-smoke.js`: end-to-end self-test client (`npm run smoke:acp`)
    that drives initialize → connect → sendChatRequest → fetchAgentEvent.
- **Web interface** — `loom web` runs Loom in the browser via a zero-
  dependency Node HTTP server that serves a single-page UI and drives the same
  core `Session` loop as the TUI/ACP. Same providers, tools, MCP servers, and
  saved sessions; chat streams live over Server-Sent Events.
  - The UI is terminal-native and on-brand: warm-charcoal + terracotta palette
    lifted from the TUI themes, monospace-led typography, a **thread rail**
    connecting turns in the transcript, a **status row** (provider · model ·
    budget · live stream rate) as the header, light/dark toggle, escape-first
    markdown renderer with copy buttons, and responsive down to mobile.
  - Flags: `--port`, `--hostname`, `--mdns` / `--mdns-domain` (implies
    `0.0.0.0`), `--cors`, `--no-open`; config-file `server` block; CLI flags
    take precedence.
  - Password auth via `LOOM_SERVER_PASSWORD` / `LOOM_SERVER_USERNAME` (cookie
    `loom_token`); mDNS advertising via the new `bonjour-service` dependency.
  - `loom attach <url>`: line-mode terminal client that shares the running
    web server's sessions/state (the OpenTUI SolidJS app still runs in-process).
  - `src/web/web-server.js`, `src/web/index.html`, `src/web/attach.js`;
  - `src/web/web-server.test.js` (13 tests: options, health, sessions, auth,
    CORS, mDNS) registered in `test:unit`.
  - `docs/web.md`.
- **Configurable keybinds** — every TUI key is rebindable from
  `~/.loom/tui.json` (`keybinds`, `leader`, `leader_timeout`), opencode-style:
  `<leader>X` prefix, string/array/`{key}`/`"none"`/`false` binding values,
  and opencode-compatible action aliases (`session_interrupt`,
  `prompt.autocomplete.next`, `dialog.select.*`, …).
  - All legacy defaults preserved; `modal_cancel` mirrors
    `session_interrupt` so ESC keeps clearing the input and closing dialogs.
  - `/keybinds` prints every action with its current key; unknown action
    names are reported as warnings.
  - `src/tui/keybinds.ts` (dependency-free engine, `reload()` reads
    `LOOM_CONFIG_DIR`), table-driven dispatch in `App.tsx`, dialogs wired
    through the engine.
  - `src/tui/keybinds.test.ts` (16 tests) registered in `test:unit`;
    interactive suite covers custom palette key, custom leader,
    `session_interrupt` rebind, `modal_cancel` mirror, disabled leader, and
    config restore (61 → 62 tests).
  - `docs/keybinds.md`.
- **Claude-compatible `/mcp add` one-liner** — add any stdio MCP server with
  `claude mcp add` syntax: `/mcp add [-e KEY=V] <name> [--] <command> [args...]`
  (e.g. `/mcp add stm32 -- "C:\stm32-mcp\.venv\Scripts\python.exe" -m
  stm32_mcp.server`). The `--` separator is optional; slash commands now
  tokenize quoted paths so paths with spaces survive; `-e`/`--env` flags set
  server env vars, and `$KEY` placeholders in args resolve from them.
- **One-line MCP/connector adding in the TUI** — the four-field add-server
  form is gone. In the `/mcp` and `/connectors` browsers, `A` now opens a
  single-line input using the same `claude mcp add` syntax (leading `add` /
  `mcp add` forgiven); presets open pre-filled with their `-e KEY=` placeholders
  and the caret parked right after the last `=` (←/→/Home/End to move), so
  filling a token is a single typing burst. `mcpAddLineCmd`
  in `src/core/plugin-cmd.js` is the shared engine for both the slash command
  and the modal. `src/mcp/mcp-manager.test.js` (+4 tests) registered in
  `test:unit`.
- **OpenCode-style permission system**.
  - `config.permission` tree with per-key rules, granular pattern objects
    (last-match-wins, `*`/`?` wildcards, `~`/`$HOME` expansion),
    per-agent overrides via `agent.<id>.permission`, and sane defaults
    (most tools allow; `edit`/`bash`/`task`/`skill` ask; `read` denies
    `*.env`/`*.env.*` except `*.env.example`).
  - Gates every tool call in the session loop (`resolve` → allow/ask/deny),
    plus `external_directory` checks for paths outside the working directory
    and a `doom_loop` guard that flags three identical tool calls in a row.
  - `loom --auto` / `/permissions auto` to auto-approve `ask` results
    (explicit denies still block); muted `auto` indicator in the status row.
  - `src/core/permissions.test.js` (10 tests covering defaults, precedence,
    wildcards, expansions, external_directory, doom_loop, legacy API).
- **New-file writes are visible** — a `write` (or any tool) that creates a
  brand-new file now renders its own block titled `# Wrote {path}` with the
  fresh content marked `+` (previously new files showed nothing, opencode's
  Edit-only rule made a new file indistinguishable from "nothing happened").
- **Interleaved parts, opencode-style** — the assistant message is no longer
  a fixed layout ("thinking on top, tools below, answer last"). Every
  reasoning, tool and text event streams as its OWN part in exact arrival
  order, so a turn reads as a flow: `⠋ Thinking` → `→ Read src/a.ts` →
  a *second* `⠋ Thinking` below it → `~ Preparing edit...` → the
  `← Edit src/b.ts` patch → the reply — the model "thinks on the read, then
  decides, then edits, then answers". Each settled reasoning part collapses
  to its own clickable `+ Thought` line (expandable independently), tool
  rows keep one-per-line persistence, `~ Preparing edit...` runs in place
  and flips to the patch block (`← Edit` / `# Wrote`) when the diff lands,
  and text appears where the model actually said it.
- **Thinking collapsible mid-turn** — the streaming `⠋ Thinking` header is
  clickable while the turn is still running: clicking collapses the live
  body (the header stays), clicking again reopens it; after the turn each
  part still settles to its clickable `+ Thought · Ns` line (opencode
  toggles reasoning at any time, even mid-stream).
- **Tool-use cap removed** — the 50-iteration `MAX_TOOL_ITERATIONS` ceiling
  (and its "(reached tool limit…)" failure message) is gone; a turn runs
  until the model stops calling tools. Esc-interrupt remains the stop
  switch for runaway loops, and the existing doom-loop guard (three
  identical calls in a row) still asks/denies as configured.
- **Tool output blocks** — a finished `bash` call with output swaps its row
  for the `$ command` block (opencode's Shell BlockTool), collapsed to the
  first 10 lines with a click-to-expand hint; ANY other tool (MCP, custom)
  renders through the generic fallback as a `# {tool} {args}` block with its
  output (3-line preview). Quiet generic tools without output keep their
  single `⚙ label` row. Completed blocks persist in the transcript.
- **`/details` toggle** — completed tool parts hide when tool details are
  off (opencode's `shouldHide`): running rows, errors, and pending rows
  always stay. Default is on. The chat re-renders from a filtered message
  stream, so the toggle applies instantly without stale rows.

### Fixed
- **Chat froze / crashed on later messages** — an orphan raw-text node
  (same-line whitespace between two JSX elements inside a box) made the
  reconciler throw "Orphan text error" on every message append after the
  splash left, killing the renderer and the test suite mid-run.
- **`/details` never hid tool rows** — the hide rule read the toggle inside
  the chat subtree, which never re-renders on that signal; the filter now
  lives in a memo over the message stream at the app root, the one path
  that provably re-renders the chat.
- **Splash logo corruption** — the "LOOM CODE" box-drawing logo had been
  mojibaked by an encoding round-trip (scattered letters on the splash
  screen); restored byte-exact from the last clean tree.
- **`/restore` was slow and dangerous** — every prompt snapshotted the whole
  project tree into `~/.loom/restore.json` (tens of MB), so `/restore` froze
  for seconds parsing it; worse, files too big to snapshot (> 1 MB) were
  recorded as `null` and then **deleted** on restore (silent data loss).
  Snapshots now cap at 200 KB per file / 2 MB per point, uncaptured files are
  recorded as "leave alone" and never touched by a restore, and the store
  self-compacts on load (oldest points dropped until the file fits an 8 MB
  budget). The existing oversized restore file is compacted automatically on
  the first load.
- **`/sessions` never jumped** — it only printed a text list of session ids.
  It now opens a searchable picker; Enter loads the chosen session into the
  live chat (same code path as `loom -s <id>` resume on start).

### Removed
- **15 unused slash commands** — `/share`, `/export`, `/undo`, `/redo`,
  `/reset`, `/compact`, `/doctor`, `/diff`, `/debug`, `/editor`, `/fork`,
  `/format`, `/lsp`, `/init`, `/keybinds` are gone from the slash popup and
  the help screen. Kept: build/plan/chat, connect, key, baseurl, model,
  models, providers, status, usage, budget, new, clear, restore, settings,
  sessions, thinking, details, theme, memory, graph, permissions, skills,
  mcp, connectors, help, agents, exit.

## [1.2.0] — 2026-08-12

### Added
- **agent system** (`/agents`).
  - Three **primary agents** matched to the active mode: `build` (all tools),
    `plan` (read-only + delegation), `chat` (no tools).
  - Three **subagents**: `explore` (read-only codebase search),
    `scout` (external/web research), `general` (autonomous, all tools except
    delegation). Subagents can never call the `task` tool, so delegation always
    terminates (no recursion).
  - **`task` tool** — the primary agent calls it automatically when a subtask
    warrants a focused subagent. Progress streams into a dedicated chat panel
    showing the child's status, tool log, and streamed text.
  - **`@agent` mentions** — prefix a message with `@explore`, `@scout`, etc. to
    delegate the whole turn manually. The mention is stripped from the rendered
    user bubble; type `@` for an autocomplete of available subagents.
  - **Custom agents** — define your own subagents or override/disable built-ins
    via `~/.loom/config.json` → `agents`. Tool patterns use last-match-wins
    semantics (`["*"]`, `["read","glob"]`, `["*","!task"]`, `["mcp__*"]`).
- `/agents` slash command listing the active registry (id, mode, tools, model).
- Sidebar Todos tab — markdown checklists (`- [x]`, `[ ]`, `[+]`, `[-]`,
  `1. [~]`) the model writes in its reply now drive the sidebar todo list and
  are clickable to toggle done; reads/writes back to the session todo store.

### Changed
- Sidebar relayouted for deterministic rendering under the OpenTUI yoga layout:
  info rows, companion, tabs, and content area are now pinned with explicit
  heights and `flexShrink={0}` so the pet's speech-bubble animation no longer
  overlaps or clips the todo/file rows.
- Companion pet is now a fixed-height block (height 7) so the sidebar content
  area stays stable whether or not the pet is speaking.
- Interactive test suite hardened with a `waitForFrame` polling helper, fixing
  flaky frame-capture assertions (`child findings`, `finished`, `[free]`,
  `+Thought` toggle).

### Fixed
- `setSidebarTab` was missing from `Sidebar.tsx` imports — clicking a tab threw
  `ReferenceError`, which cascaded and killed the interactive suite at test 27.
- OpenTUI `TextNode` crash on nested `<text>` inside `<text>` — todo rows now
  emit a single string with a row color instead of nested styled elements.
- Sidebar text-garble (`Model:er:`, overlapping todo rows) caused by yoga
  shrinking text nodes to zero width — explicit `width={34}` on todo/file rows
  and explicit `height={1}` on info rows.

### Tests
- Interactive suite: **58/58 passing** (splash, slash popup, paste, busy-submit
  hold, caret editing, markdown rendering, permission popup, `/budget`,
  `/skills`, `/mcp`, `/connectors`, sidebar todos/files, `/agents`,
  `@explore` delegation, bash diff detection, restore points, model picker,
  MCP seeding, themes, speed hardening, multiline, caret editing, `/clear`).
- Unit suite: **97 pass / 2 skip / 0 fail** across 8 files, including the new
  `src/core/agents.test.js` (registry shape, tool-pattern filters, config
  merge/disable, `runSubagent` error paths, usage accumulation, agent-turn
  gating).
- `lint:core` (`tsc -p tsconfig.core.json`) clean — strict JSDoc typing across
  `src/core`, `src/providers`, `src/mcp`, `src/skills`, `src/tools`,
  `src/config`.

### Removed
- GitLab CI configuration (`.gitlab-ci.yml`) — the project is no longer using
  GitLab CI going forward.

## [1.1.0]

- Drag-to-copy selections, paste support, blinking cursor.
- Companion pet (OpenPets) integration.
- `/themes`, `/companion`, `/budget` (free/cheap/best/auto), `/skills`,
  `/mcp`, `/connectors` slash commands.
- One-shot print mode: `loom -p "query"`.

## [1.0.0]

- Initial public release.
- Full OpenTUI interface with slash commands and autocomplete.
- Build / Plan / Chat modes.
- Multi-provider support: Anthropic, OpenAI, NVIDIA, Google Gemini, OpenRouter,
  Local (Ollama).
- Built-in tools: `read`, `write`, `edit`, `bash`, `grep`, `glob`, `webfetch`,
  `todowrite`.
- Agentic tool loop (multiple tool calls per turn, up to 50 iterations).
- MCP (Model Context Protocol) server integration.
- Session memory, `/undo`, `/redo`, `/compact`, `/reset`, `/fork`, `/share`.
- LOOM.md project memory file.
- Usage & billing tracking per session + lifetime.

[1.2.0]: https://npmjs.com/package/loom-code
[1.1.0]: https://npmjs.com/package/loom-code
[1.0.0]: https://npmjs.com/package/loom-code
