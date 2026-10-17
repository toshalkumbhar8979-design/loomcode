# Changelog

All notable changes to **Loom Code** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.0] — 2026-10-17

### Added
- **Transcript undo / redo (`/undo`, `/redo`, `/undo-files`).** The
  conversation-level counterpart to `/restore` (which rewinds the *file
  tree*): each user turn now pushes a full transcript snapshot — UI messages,
  session messages, and todos — onto a bounded stack (last 50 turns). `/undo`
  steps the transcript back one turn and `/redo` steps forward again. When the
  undone turn also created a restore point, `/undo-files` rolls the *working
  tree* back to that same point so files match the rewound conversation. The
  engine (`src/core/transcript-undo.js`) is a pure, unit-tested stack that
  snapshots-and-clones so later mutation can't corrupt stored state, clears
  the redo branch on a new action (like any editor), and returns the step
  *reference* so a restore-point id created in a background `setTimeout` can
  be stitched onto it without relying on a fragile stack index. Wired into
  `processSlash` and registered in `SLASH_LIST`; the existing `<leader>u` /
  `<leader>r` keybinds now resolve to working commands instead of falling
  through to "Unknown command". Undo/redo persist via the normal
  `saveSession` path, so a rewind survives restart.
- **Startup update check.** `updateCheck()` (previously a no-op stub) now
  probes the npm registry once every 24 hours with a 4s timeout and, when a
  strictly newer `loom-agent` is published, prints a single stderr notice
  (`New version available: 1.5.0 → 1.6.0` + the upgrade command) before the
  TUI starts. Non-blocking and failure-silent by design: offline, slow, or
  malformed responses never delay startup, the throttle stamp lives in
  `~/.loom/update-check.json`, and `LOOM_NO_UPDATE_CHECK=1` disables it
  entirely. Version comparison is a small tuple compare (no new dependency).
  Unit-tested (`update.test.js`, registered in `test:unit`).
- **`/export` — transcript as markdown.** Writes the conversation (roles,
  message text, tool rows, error flags) to `.loom/exports/<session>.md`, the
  plain-text counterpart to `/share` (HTML). Bound to the existing
  `<leader>x` keybind, which previously resolved to a slash command with no
  handler.

### Fixed
- **Model catalogs verified against live provider APIs.** Every model ID the
  picker ships was checked against the authoritative source (OpenAI,
  NVIDIA, OpenRouter and Groq `/v1/models`; Anthropic's official pricing +
  deprecation pages; the models.dev cache for registry providers), and every
  dead ID was removed or repointed:
  - **NVIDIA** (the reported failure): the default active model
    `nvidia/llama-3.3-nemotron-super-49b-v1.5` did not exist and 404'd on
    every request — repointed to `nvidia/nemotron-3-super-120b-a12b`
    (54/54 catalog models live).
  - **OpenAI:** dropped phantom `gpt-5.6`, `gpt-5.3-codex-spark`, `o3-pro`;
    added live `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`,
    `gpt-5.1-codex-mini`, `gpt-5.2-codex`, `gpt-5.2-pro` (34/34 live).
  - **Anthropic:** dropped models Anthropic retired in 2026
    (`claude-sonnet-4-20250514`, `claude-opus-4-20250514`,
    `claude-3-5-haiku-20241022`); added live `claude-fable-5`,
    `claude-opus-4-7`, `claude-opus-4-6` (14 models, all prices matched to
    the official pricing table; Mythos 5/5.1 omitted — verification-program
    accounts only).
  - **Defaults:** `settings.js` DEFAULTS and the shipped model map no longer
    name dead IDs (`gpt-5-fast`, `meta/llama-3.1-8b-instruct`,
    `anthropic/claude-sonnet-4`, `moonshotai/kimi-k3-free` → `gpt-5`,
    `nemotron-3-super-120b-a12b`, `claude-sonnet-5-5`,
    `z-ai/glm-5.3-free`); OpenRouter 42/42 and TokenRouter (models.dev's
    single `z-ai/glm-5.3-free`) verified live.
  - Usage/context tests now pin a deterministic model/window so future
    default-model changes can't shift their expectations.
- **Speed telemetry now ticks during the thinking phase.** Reasoning deltas
  count as first-token + generation tokens, so the sidebar latency gauge
  starts when the model starts *thinking* instead of reading "waiting…"
  through the entire thinking phase (measured on nemotron-3-super: ~7s to
  the first thinking token, then +16s of thought before any visible text —
  the response looked hung while the model was working). `last.latencyMs`
  and `last.tokensPerSec` now reflect true time-to-first-model-output and
  full generation throughput, including reasoning tokens. Regression test
  in `session.test.js`.
- **NVIDIA catalog note: `/v1/models` is not account availability.** The
  endpoint lists NVIDIA's global catalog, but chat POSTs can return
  `Function '…': Not found for account '…'` when the key's account hasn't
  enabled that model (probed 2026-10-17: 9/54 curated IDs answered chat on
  one key — 37 account-gated 404s, ~6 hung to timeout, 2 returned 503).
  Availability is per-account, so the curated list stays; the caveat is
  now documented in `nvidia.js`.

### Changed
- **Orchestrator now delegates by default.** The build agent's standing
  instructions were rewritten to make fan-out the first move on any broad
  SEARCH / ANALYSIS / OPTIMIZATION request ("find what causes X", "where is
  Y", "how does Z work", "optimize W", "audit/investigate/locate"): it
  splits the scope into independent questions and dispatches them as
  **parallel `task` calls** (one `explore` subagent per disjoint area of the
  codebase), then reads a file itself only to resolve a single ambiguous
  line a subagent's report left open. This closes the gap where the agent
  defaulted to reading files serially on its own. The plumbing already
  existed (`task` tool, `runSubagent`, per-run cancellation, token rollup,
  `Promise.all` execution) — this change makes using it the default rather
  than an afterthought. Pinned by new assertions in `agents.test.js`.
- **Token optimization — prompt caching, cache-accurate pricing, and leaner
  context (7 changes across the request path):**
  - **OpenRouter/TokenRouter prompt caching:** the request body now sends
    top-level `"cache_control": true`, so cache-capable models re-read the
    cached prefix instead of re-paying full input cost each turn.
  - **Cache-aware usage accounting + pricing:** `recordUsage` parses
    `prompt_tokens_details.cached_tokens` / `cache_read_input_tokens` /
    `cache_creation_input_tokens` / `cachedContentTokenCount` and prices
    cached reads at **0.1×** and writes at **1.25×** the input rate instead
    of the full rate. OpenAI/OpenRouter's cached count is treated as a
    *subset* of the prompt total; Anthropic's is additive. Adds
    `cacheReadTokens` / `cacheWriteTokens` session counters.
  - **Cache-stable system prompt:** the per-turn skill block moved out of the
    system string (injected into the last user message of a wire copy
    instead), so the system prefix stays byte-identical across turns and
    Anthropic's cache breakpoint keeps hitting even when the matched skill
    changes.
  - **Mode-specific system prompts:** chat and plan modes drop the skills
    index, the todowrite mandate, and the tool-batching/behavior rules they
    can't act on, cutting thousands of tokens per turn for tool-less modes.
  - **Tool-result aging:** tool results older than the last 12 messages are
    elided to a 2000/400 head/tail slice before they reach the provider
    (kept verbatim in memory for the TUI), so a huge `read`/`grep` output
    stops costing full input price every later call.
  - **Slimmer tool schemas:** `mcp`, `task`, and `sandbox` descriptions
    trimmed (package catalogs and per-agent rosters removed) — these ship in
    every request's tool list.
  - **Accurate `estimateTokens` / `/context`:** the estimate now includes the
    per-turn agent/primary/sandbox/skill blocks and tool schemas, and the
    `/context` command gained a `Schemas+turn` line so its total matches the
    live window estimate.

### Security
- **All dependency advisories cleared — `npm audit` reports 0
  vulnerabilities** (was 7: 4 critical, 1 high, 2 low):
  - `@opentui/solid` / `@opentui/core` (+ all platform binaries)
    0.5.3 → **0.5.17** — fixes the `@babel/core` arbitrary-file-read
    advisory and the `solid-js`/`seroval` critical chain.
  - `seroval` + `seroval-plugins` forced to **1.6.9** via npm `overrides`
    (solid-js is peer-pinned to 1.9.12 by @opentui/solid; 1.6.9 is exactly
    the seroval line solid 1.9.17 itself moved to — fixes the critical
    `fromJSON()` thenable-assimilation + memory-exhaustion advisories).
  - `shell-quote` **removed** — it was an unused direct dependency carrying
    a critical `quote()` command-injection advisory.
  - `diff` ^7 → **^9.0.0** (we only use `diffLines`, unchanged; 9.x ships
    CJS exports) — fixes the parsePatch/applyPatch DoS advisory.
  - `brace-expansion` re-resolved to **5.0.12** (transitive, via
    `npm audit fix`) — fixes the DoS/recursion advisories.

### Added
- **Full model-catalog refresh across every built-in provider (verified
  2026-10-17).** NVIDIA rebuilt from the live authenticated
  `GET /v1/models` registry (81 live endpoints, chat-capable IDs only —
  embeddings/guard/parse/video models excluded): **54 models** including
  Nemotron 3.5 Lightning/Super VL, DeepSeek V4.1 Flash, GLM-5.3/Flash,
  Gemma 4, DiffusionGemma, Kimi K2.6, Step 5 Preview, Palmyra (creative/
  fin/med), Riva Translate and GPT-OSS 20B; 14 stale IDs (Llama 3.1/3.2/3.3
  instruct, Nemotron Super 49B, GLM-5.2, GPT-OSS 120B, MiniMax M3, …) removed.
  Anthropic 3 → **14 models** (Opus 5.5/5/4.8/4.5, Fable 5.1, Sonnet
  5.5/5/4.6/4.5, Haiku 5.5/4.5 + legacy dated snapshots). OpenAI 12 →
  **31** (GPT-6 Astra/Sol/Luna, GPT-5.6/5.5/5.4 families incl. Pro and
  Codex, o3/o4 legacy, GPT-4.1/4o). Google 7 → **15** (Gemini 4 Argon,
  3.1 Pro Preview, 3.8→3.5 Flash lines, latest-aliases, Gemma 4 31B/26B
  A4B). OpenRouter 11 → **42** curated live slugs (Claude 5.5, GPT-6/5.6,
  Gemini 4/3.x, Kimi K3, Qwen3.5/Coder, GLM-5.3, Grok 4.7, Llama 4,
  Mistral Large 4, plus verified `:free` tiers). Context windows and
  $/1M prices cross-checked against models.dev and the OpenRouter public
  catalog.
- **Provider resilience — retries with backoff and honest error classes
  (`src/providers/anthropic.js`, `openai-compat.js`).** Anthropic requests
  retry 429/529/5xx up to 4 tries with jitter, honoring `Retry-After`;
  openai-compat retries 429/502/503/529 exponentially (first retry is
  immediate unless `Retry-After` says otherwise). Provider errors now carry
  `.status`/`.retryAfterMs` so the session loop can act on them: rate limits
  **wait and retry** (honoring `Retry-After`, capped 30s) before falling back
  to model switching, `isQuotaError` (402/insufficient balance) still
  auto-switches models, and `isContextOverflowError` **compacts and retries
  once per turn**. Mid-stream SSE `error` events and fully-truncated streams
  now throw instead of silently yielding an empty answer; Anthropic
  `stop_reason` maps through to `finish_reason` (`max_tokens`→`length`,
  `tool_use`→`tool_calls`) and tool results carry `is_error` on both the wire
  and the history row (`isError`).
- **Session-loop resilience + context hygiene (`src/core/session.js`).**
  `_normalizeHistory()` slices every provider call from the first user row
  (no more leading orphan assistant/tool rows), compaction summaries are
  stored as **user-role rows** — openai-compat drops `role:'system'` history
  rows, so the summary used to silently vanish before the model ever saw it —
  `estimateTokens()` counts the system prompt and tool schemas,
  `contextEstimate()` backs a live `/context` window, and auto-compaction
  triggers at the context threshold mid-turn (once per turn). Failed tool
  outcomes are marked `isError` in history.
- **Two new tools — `todoread` and `tasks`** — read the current todo list,
  and list/output/kill background tasks (`bg:*` handles, auto-gone after
  10min finished). Tool results are capped at **100k chars** (head + tail
  with a `[…truncated N chars…]` marker) across text, errors, and MCP
  payloads; `read` detects binaries and caps at 512KB / 2000 lines; `bash`
  takes `timeoutMs` (default 60s) and is killed by Ctrl-C; `webfetch`
  aborts with the session; `edit` gains a multi-edit `edits` array (each
  entry enforces a unique match — the single `oldString` path keeps its
  replace-first behavior).
- **MCP tools are permission-gated** — new `mcp` permission key (default
  `ask`); patterns match the full tool name (`mcp__github__*`, exact names,
  denies), and `todoread` maps to the `read` rule.
- **Project steering reads `AGENTS.md` (`src/core/memory.js`)** — global
  LOOM.md plus cwd `LOOM.md`/`.loom/LOOM.md`/`AGENTS.md` and up to 3 parent
  directories (per-file 12k, project-section 24k caps), with `CLAUDE.md` as
  a fallback when no LOOM/AGENTS file exists.
- **Hooks: `userPromptSubmit` and `subagentStop` (`src/core/hooks.js`).**
  `userPromptSubmit` runs before a prompt hits the model and can block the
  prompt (`decision:"block"` or a non-zero exit with stderr) or inject
  `<user-prompt-submit-hook>` context; `subagentStop` fires after a
  subagent finishes; `postToolUse` now receives `tool_response` (capped 4k).
- **TUI/CLI:** a `/compact` slash command (also Ctrl+X c), `/context` shows
  a live context-window estimate (tokens / window / %), background-task
  completions surface as toasts, and per-turn autosave keeps saved sessions
  current. `loom`'s `/compact` now uses the real `session.compact()`.
- **Easier connector installs — `loom add connector` + a visible "+ Add
  connector…" row (`src/mcp/connector-presets.js`, `connectorAddLineCmd`).**
  The connector preset catalog moved from the TUI into the core layer so the
  shell and the TUI picker share one source. From the shell (or
  `/connectors add`), a preset name plus `-e KEY=V` flags expands to the full
  one-liner — `loom add connector supabase -e SUPABASE_ACCESS_TOKEN=xxx` —
  and missing keys fail with the exact `-e` flag and where to get the token
  instead of persisting a broken server. Leftover tokens append as trailing
  args (`… supabase --project-ref abcdef`), and anything that is not a preset
  name falls through to the generic `[-e KEY=V] <name> [--] <command>
  [args...]` form. The `/connectors` and `/mcp` browsers now pin a "+ Add …"
  row under the list (Enter opens the preset picker; `A` still works), and
  the one-line add editor accepts a bare preset name.
- **Docker sandbox with a guided `/sandbox` wizard (`src/core/sandbox.js`,
  `SandboxModal`).** `/sandbox` (or `/sandbox setup`) opens a three-step
  modal: (1) Docker check — if missing, shows the platform install link with
  an "open download page" action and remembers the pending install; (2) OS
  pick — Alpine (~250 MB, apk), Debian Slim (~600 MB, apt) or Ubuntu
  (~900 MB, apt); (3) live build with a real progress UI: per-stage
  checklist (pull → create → start → essentials → browser → ready), a
  percentage bar driven by actual docker-pull layer bytes, and streamed
  install logs. Setup is fully asynchronous — the TUI never freezes — and
  the wizard can be esc'd while setup continues in the background. Setup
  pulls the chosen `node:20-*` image, creates the single shared
  `loom-sandbox` container with the project mounted at `/workspace`,
  installs essentials (git, bash, curl, ripgrep, coreutils) plus a headless
  Chromium where offered (best-effort). Isolation: project dir only, no host
  network, no `--privileged`. The container idles in the background; the
  dedicated **`sandbox` tool** runs one command inside it only when the
  agent decides isolation is needed (see Changed). `LOOM_SANDBOX=0` is a
  hard kill-switch. Saying "docker is ready" after installing reopens the
  wizard at the OS step.
- **Drive-to-completion harness (`src/core/session.js`).** When the model ends
  a turn with todos still pending/in_progress (the "stops between tasks"
  failure), the loop injects a continuation listing the unfinished items — up
  to 5 nudges per turn, build mode only, only when the turn actually wrote
  todos. Cancelled/completed items via todowrite stop the nudging cleanly.
  Child subagent sessions inherit the same guard.
- **Transient provider-error retry.** Network blips / 5xx / stream resets now
  retry the model call twice (side-effect free) instead of killing the turn
  mid-task.
- **Specialist subagents (`src/core/agents.js`)**: `research` (multi-source
  investigation, sourced report), `coder` (isolated implementation),
  `reviewer` (severity-ranked code review), `tester` (reproduce → test →
  green), `web` (headless-browser work). All non-delegating (`no task tool`).
- **Main orchestrator prompt.** The `build` primary agent now carries an
  orchestrator role prompt (todo-first, delegate-to-specialists, verify,
  finish). Primary-agent prompts are actually wired into the system prompt now
  (`Session._primaryBlock()`) — previously `build`/`plan`/`chat` prompts were
  registry-only and never reached the model.
- **`browser` tool (`src/tools/browser.js`).** Headless Chromium control via
  Playwright: goto/click/fill/press/text/eval/links/screenshot/close. Engine:
  bundled `playwright` if installed, else `playwright-core` + system
  Chrome/Edge. The page singleton persists across calls. Permissions: passive
  reads allow, interactive click/fill/press ask.

### Fixed
- **Unit tests no longer read the developer's real `~/.loom` config**
  (`src/core/session.test.js`, `agents.test.js`). `session.test.js` never set
  `LOOM_CONFIG_DIR`, and the config-merge test in `agents.test.js` DELETED
  the variable instead of restoring its temp dir — so once the local config
  picked a dynamic models.dev provider (or any provider the test process
  hadn't merged), every `new Session()` failed with `Unknown provider` and
  the whole `bun run test:unit` stage went red (36 failures). Both files now
  run hermetically against a temp config dir (restored/cleaned in
  `afterAll`).
- **Agent loop no longer stops in the middle of work** (`src/core/session.js`
  continuation guards — opencode/Claude-Code parity):
  - **Truncation auto-continue.** `finish_reason=length` (output budget
    exhausted — the #1 cause of mid-task stops with reasoning models, where
    thinking eats max_tokens and the answer never streams) now continues
    the turn with a "continue exactly from where it stopped" nudge instead
    of dead-ending with a placeholder — up to 5 continuations per turn.
    Empty truncated replies also drop the empty assistant row from history
    (Anthropic 400s on empty assistant messages, which silently killed
    subsequent calls).
  - **Empty-reply nudges raised 1 → 3 per turn** (provider hiccups repeat).
  - **Premature-wrap-up detection broadened.** The drive guard now also
    fires when tools ran, todos exist, and the reply LOOKS unfinished
    (short, or ends on a promise like "Now I will…") — catching models that
    never call todowrite. Drive nudges raised 5 → 8 per turn. Leftover
    todos are surfaced to the UI whenever the guard engaged.

### Changed
- **Sandbox commands are now routed through Docker when the agent decides it
  needs the sandbox** — instead of quietly running on the host:
  - `bash` gained an opt-in **`sandbox: true`** parameter; the same command
    then runs via `docker exec loom-sandbox sh -lc "<command>"`
    (`workdir /workspace`). If the sandbox isn't set up the call FAILS with
    the `/sandbox` setup hint — it never silently falls back to the host.
  - The system prompt now states the exact routing (build-mode tool list +
    a per-turn **"Sandbox (Docker, ready)"** block, resolved lazily so
    `/sandbox setup|on|off` applies from the next turn): sandbox-intended
    commands go through the `sandbox` tool or `bash {sandbox:true}`, ordinary
    commands stay on the host.
  - The `sandbox` tool description spells out the `docker exec … sh -lc`
    shape, and the tool now flows through the same permission gate as bash
    (dangerous commands prompt; user-approved calls carry `_approved`).
- **Sandbox is now opt-in per command, not a global router.** Enabling the
  sandbox no longer hijacks the bash tool — every host command keeps running
  on your machine (Windows included) exactly as before. Instead, a dedicated
  **`sandbox` tool** appears; the agent calls it only when isolation is
  genuinely needed (you asked for the sandbox, the command is risky, or a
  Linux-only environment is required). Each call revives the container if it
  stopped (e.g. after a Docker Desktop restart) and re-mounts the current
  project, then runs just that one command via `docker exec`. The container
  idles in the background between calls; `/sandbox off` disables the tool
  (not the host), `/sandbox on` re-enables it. The setup wizard's build step
  also became fully non-blocking: docker pull streams per-layer progress
  into a live percentage bar, package installs stream their output, and the
  TUI stays responsive throughout (esc lets setup finish in the background).
- **Every docker status check is now spawn-based (non-blocking).** The last
  synchronous `execFileSync` calls — `detectDocker()` (wizard open, setup
  start, "docker is ready" resume), `sandboxStatus()` (session start,
  `/sandbox status`, `/sandbox on`), and `/sandbox rm` — blocked the whole
  event loop for up to 10–30 s while Docker Desktop answered, freezing the
  TUI (no cursor, no renders) and swallowing live progress updates. New
  async twins (`detectDockerAsync`, `sandboxStatusAsync`, `sandboxPending`)
  stream results back via promises; the wizard shows a spinner during the
  check instead of hanging; the session-start pending reminder is now a
  config-only read (zero docker calls).
- **Slash popup decluttered.** The autocomplete popup and command palette
  now show a short one-line description per command — argument syntax is no
  longer appended (it lives in `/help` and the README table). Duplicate
  entries were removed from the picker while their handlers stay callable:
  `/model` → `/models`, `/thinking` + `/details` → `/settings`, `/rewind`
  → `/restore` (40 → 36 entries). Every desc was shortened to ~2–35 chars
  so rows fit on one clean line. README table regenerated from the real
  list (it previously advertised commands that no longer exist).
- **TUI design overhaul.** The splash leads with the full LOOM CODE wordmark
  in solid terracotta over a separator rule and a pill-style status
  row; the default "Loom Dark" (and Light) palettes got deeper surface
  stepping so panels read without borders. Every selection surface — command
  palette, slash/file popups, select modals, permission popup — now uses a
  tinted active row with a `▸` marker; the command palette finally renders
  each command's description; modals gained a title divider; toasts carry a
  kind-colored status dot (● ok / ✖ error / ◆ info) and clip long text so
  they never cover the chat. System notices sit on a tinted surface, the
  assistant footer is brand-colored, markdown headings get an h1/h2/h3 color
  hierarchy, the input placeholder color-codes /commands @file !shell, and
  hard-coded reds now follow the theme's error color. Still grid-line-free in
  the main view — color and spacing do the work, no box frames.
- **Sidebar version now tracks `package.json`** (it was stuck at a hardcoded
  v1.2.0 while the package moved on); splash and sidebar share one source.
- **`task` tool description now lists every built-in subagent with its specialty.**
- **Stop messages show the real state, not canned text.** Continuation nudges
  now quote the model's ACTUAL last message plus the open todo list (instead
  of one identical line every time); the empty-reply nudge reports the real
  tool-call count; a build turn that ends with open todos returns them
  (`resp.openTodos`) and the TUI appends "Stopped with N todo(s) still open: …"
  with the actual items; the interrupt line reports kept chars + the
  in-progress todo; the plan-complete line includes the planned step count;
  "(no response)"/"(interrupted)" placeholders describe what happened.
- **Sessions now live in per-session folders inside the project**
  (claude-code/opencode style): `<project>/.loom/sessions/<id>/session.json`
  (metadata) + `messages.jsonl` (one message per line, append/rewrite-safe).
  Old flat `~/.loom/sessions/<id>.json` files stay readable and are migrated
  into the project folder on the next save; the /sessions picker merges both.

### Fixed
- **Resuming a session 400'd the next turn** (`NVIDIA error 400: missing
  field tool_call_id`). The resume path rebuilt the in-memory message list
  from `{role, content, toolCalls}` only — dropping `toolCallId` — so the
  provider payload carried a tool row with no id. Resume now preserves
  `toolCallId` (and aliases legacy snake_case `tool_calls`/`tool_call_id`
  on load); both providers also skip orphaned tool rows defensively instead
  of failing the turn.
- **"The model ended the turn without any text" now says why when it knows.**
  `finish_reason` is captured from the stream; a truncated reply (reasoning
  ate the output budget) reports that instead of a mystery placeholder.

## [1.2.36] — fix `loom web` / `loom acp` / `loom attach`

### Fixed
- **`loom web` launched the TUI instead of the browser server.** Since 1.2.34
  the npm shims prefer `bin/loom-bun.js`, whose non-TUI branch routed every
  subcommand into `src/core/cli.js`'s interactive `main()` — which has no
  handler for `web`/`acp`/`attach`, so control fell through to the full-screen
  app (reproduced: splash painted, no HTTP listener). `bin/loom-bun.js` now
  routes those three subcommands directly to their own entry points, exactly
  like `bin/loom.js` always did. Verified end-to-end on a global install:
  `/api/health` → 200, UI served, banner prints.

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
