demoust leave space for it now a# LOOM.md

## Project Overview
Loom Code is an AI-powered coding agent for the terminal — multi-provider support (Anthropic, OpenAI, NVIDIA, Google, OpenRouter, Local/Ollama) and a redesigned OpenTUI (SolidJS) terminal interface.

## Build / Run Commands
- `npm install` — install node dependencies (basic REPL)
- `bun install` — install all deps including OpenTUI native modules
- `node src/index.js` — run basic line-mode REPL
- `bun run src/tui-open.tsx` — launch the new OpenTUI TUI for this project
- `bun src/tui-open.tsx -p "query"` — one-shot/headless mode
- `npm run tui` — alias for `bun run src/tui-open.tsx`
- `npm start` — alias for `node src/index.js`
- `bun build src/tui-open.tsx --outdir=dist --target=bun` — bundle the TUI

## Test Commands
- Manual TUI render test: `bun run src/tui-open.tsx` (visual check)
- Interactive render test: `bun run src/tui/test-interactive.tsx` — verifies splash, slash popup, filtering, Enter execute, modals (asserts included)
- Headless smoke (no TTY): pipe into `bun src/tui-open.tsx -p "hi"` — requires a valid provider API key
- No unit test framework configured yet; add `bun test` tests under `src/**/*.test.tsx` using `testRender` from `@opentui/solid`

## Code Style
- CommonJS (`.js`) for legacy core (session, providers, tools, mcp, config, cli)
- ES modules + TypeScript (`.ts`, `.tsx`) for the OpenTUI layer — `src/tui/**`, `src/tui-open.tsx`
- SolidJS signals for state; `@opentui/solid` hooks (`useKeyboard`, `useRenderer`, `useTerminalDimensions`)
- OpenTUI JSX intrinsics use kebab/underscore names per reconciliation rules:
  - `<text>`, `<box>`, `<scrollbox>` — layout/display
  - `<input>`, `<textarea>`, `<select>`, `<tab_select>` — inputs (underscore for `tab_select`)
- Text styling uses **nested** modifier tags: `<strong>`, `<em>`, `<u>`, `<span fg="...">` — NOT props
- Colors via palette helpers in `src/tui/design.ts` (hex strings)

## Architecture — TUI (new, OpenTUI/SolidJS)
```
src/tui-open.tsx        Entry point (bun) — render(<App/>)
src/tui/
  App.tsx               Root component — layout, keyboard routing, session submit loop, slash commands (command errors surface as toasts, not chat messages)
  store.ts              SolidJS signals: messages, input, thinking, modal, suggestions, provider state, todos
  design.ts             Palettes/themes, glyphs, block wordmarks, splash robot, VERSION
  keybinds.ts           Configurable keymap + leader mode
  markdown.tsx          Markdown renderer + code highlighting
  toolkit.ts            Tool output formatting helpers
  reports.ts            /help, /status, /keybinds text
  shell/
    Boot.tsx            Splash: anchored robot head, tagline, centered composer
    LoomBar.tsx         Composer + status rows (mode, provider, model, usage)
    Stage.tsx           Transcript: user bars, assistant markdown, tools, diffs, todos
  overlays/
    Layer.tsx           Modal frame
    Deck.tsx            Command palette (ctrl+p)
    Pickers.tsx         Provider/model/theme/settings/key/baseurl modals
    Sheets.tsx          Help, MCP, sandbox, subagents, sessions, skills, connectors
    Gate.tsx            Permission + question prompts
    Toasts.tsx          Transient notices
```

The old `src/tui.js` (ink) and the old `src/tui/components/` tree have been removed. `src/core/cli.js` spawns `bun src/tui-open.tsx` when TTY + bun available, else falls back to the basic readline REPL.

## Architecture — Core (unchanged)
```
src/providers/      anthropic.js, openai.js, nvidia.js, google.js, openrouter.js, local.js
                    All "OpenAI-compat" providers delegate to providers/openai-compat.js
                    Base URLs resolved via config/settings.getBaseUrl(provider)
                    Env overrides: ANTHROPIC_BASE_URL, OPENAI_BASE_URL, NVIDIA_BASE_URL, GOOGLE_BASE_URL, OPENROUTER_BASE_URL

src/core/session.js         Session class — agentic tool loop (up to 50 iterations)
src/core/model-router.js    Budget router — free/cheap/best/auto level → per-turn model pick
src/core/usage.js           Usage & billing ledger + monthly spend governor (budgetStatus / setMonthlyBudget)
src/core/events.js          Sync event bus (turn lifecycle, model:switch, tool calls)
src/core/session-store.js   Save/load conversations in ~/.loom/sessions
src/core/permissions.js     bash/edit/write permission gating
src/core/plugin-cmd.js      /skills, /mcp, /diff, /debug, /editor, /export, /sessions, /fork handlers
src/config/settings.js      ~/.loom/config.json persistence, API key + base URL helpers
src/tools/index.js          read/write/edit/bash/grep/glob/webfetch/todowrite + MCP passthrough
src/mcp/                    MCP client + manager (stdio servers)
src/skills/                 Skill install/remove/list from ~/.loom/skills
```

## Slash Commands (41 total)
`SLASH_LIST` in `src/tui/store.ts` is the source of truth; see the README table
for the full list with arguments. Aliases (`/model`, `/thinking`, `/details`,
`/rewind`) work but stay hidden from the picker.

### Leader Key (Ctrl+X)
| Key | Slash Command |
|-----|---------------|
| `c` | `/compact` |
| `e` | `/editor` |
| `q` | `/exit` |
| `x` | `/export` |
| `h` | `/help` |
| `m` | `/models` |
| `n` | `/new` |
| `r` | `/redo` |
| `l` | `/sessions` |
| `u` | `/undo` |
| `s` | `/settings` |
| `t` | `/thinking` |
| `d` | `/details` |
| `a` | `/agents` |
| `j` | `/subagents` |
| `b` | `/build` |
| `p` | `/plan` |

### Autocomplete
- **Slash (`/`)** — live-filtered commands with descriptions, 10-row scrollable window over the full list, UP/DOWN/TAB/ENTER/ESC
- **At (`@`)** — fuzzy file search (project files, top 10)
- **Bang (`!`)** — shell presets (`!ls -la`, `!git status`, `!git diff`, `!pwd`)
- **Mouse** — click a suggestion row to select + execute it; scroll wheel scrolls through the full list and moves the selection (also in modals: provider/model/theme pickers + palette — model picker shows "showing N-M of X" range)

### Keyboard Shortcuts
| Keys | Action |
|------|--------|
| `Enter` | Submit prompt / pick autocomplete |
| `Esc` | Interrupt thinking / close modal / clear input |
| `Ctrl+C` | Exit TUI (clean terminal restore) |
| `Ctrl+P` | Command palette (type to filter) |
| `Ctrl+X` | Leader prefix (2s timeout) |
| `Tab` | Cycle autocomplete / cycle input mode (Build/Plan/Chat) |
| `Up/Down` | Navigate autocomplete / suggestion list |
| `Mouse wheel` | Scroll chat history (scrollbox) / move suggestion + modal selection |
| `Mouse click` | Run a suggestion or modal option (autocomplete, pickers, palette) |

## Configuration Format
`~/.loom/config.json`:
```json
{
  "provider": "nvidia",
  "model":    { "nvidia": "deepseek-ai/deepseek-v4-flash", "anthropic": "claude-sonnet-4-20250514" },
  "apiKeys":  { "nvidia": "..." },
  "baseUrls": { "nvidia": "https://integrate.api.nvidia.com/v1" },
  "maxTokens": 8192,
  "temperature": 0.7,
  "requestTimeoutMs": 600000,
  "toolTimeoutMs": 180000,
  "subagentTimeoutMs": 900000
}
```

## TUI State Persistence
`~/.loom/tui.json`:
```json
{
  "theme": "loom",
  "showToolDetails": false,
  "showThinking": true,
  "leader": "ctrl+x",
  "leader_timeout": 2000
}
```

## Native Modules Note
`@opentui/core` ships per-platform native packages (`@opentui/core-win32-x64`, `-darwin-arm64`, etc.).
Install the one matching the host OS — npm/bun install will pull them automatically when flagged in
`optionalDependencies`. `bun build` may warn about missing *other* platforms; that is expected.

## Notes for the Coding Agent
- Always use `bun run src/tui-open.tsx` to drive the UI; never edit the old `tui.js` (gone)
- When adding a new slash command:
  1. Register in `src/tui/store.ts` (`SLASH_LIST`)
  2. Add a `case "cmdname":` block in `src/tui/App.tsx` (`processSlash`)
  3. If it opens a picker, add a modal handler in `src/tui/overlays/Pickers.tsx` (or `Sheets.tsx` for full-screen reports)
- To add a provider: drop a file in `src/providers/`, register in `providers/index.js` (`PROVIDERS`, `PROVIDER_ORDER`, `PROVIDER_LABELS`), add its base URL default to `config/settings.js`
- Run deterministic checks with `bun -e "..."` or `bun build` before pushing UI changes
- **Critical**: All signal reads MUST be inside JSX expressions (`{signal()}`) or `<Show when={signal()}>` — top-level `const s = signal()` captures once and never updates

## SolidJS Reactivity Pattern (MUST FOLLOW)
```tsx
// WRONG — captures once, never updates
const s = suggestions();

// CORRECT — read inside JSX
<Show when={suggestions().length > 0 && autoKind() === "slash"}>
  {suggestions().slice(0, 4).map(...)}
</Show>
```

This pattern applies to ALL components: Boot, LoomBar, Stage, Gate, Pickers, Sheets, Deck.

### Passing props to children
Pass **accessor functions**, not resolved values, for reactive props. Component bodies
run once (untracked), so `const msgs = props.messages` in a child body captures a stale value.

```tsx
// WRONG — child body reads props.messages once, never updates
<Stage messages={messages()} />

// CORRECT — child calls the accessor inside JSX
<Stage messages={messages} />
// in Stage: const visible = () => (props.messages?.() || []).slice(-40); ... {visible().map(...)}
```

Boolean/static props may stay as values (`show={showThinking()}` is fine when read inside
`<Show when={...}>` or another JSX expression).
