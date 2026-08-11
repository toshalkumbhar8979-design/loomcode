# LOOM.md

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
- Colors via palette helpers in `src/tui/theme.ts` (hex strings)

## Architecture — TUI (new, OpenTUI/SolidJS)
```
src/tui-open.tsx        Entry point (bun) — render(<App/>)
src/tui/
  App.tsx               Root component — layout, keyboard routing, session submit loop, slash commands (command errors surface as toasts, not chat messages)
  store.ts              SolidJS signals: messages, input, thinking, modal, suggestions, provider state, todos, pets
  theme.ts              Color palette (loom dark/light), LOOM banner ASCII, VERSION
  components/
    SplashScreen.tsx    Full-screen banner + input prompt (shown when no messages)
    ChatArea.tsx        Message list (user/assistant/tool/system bubbles, thinking indicator) — assistant bubbles render on a slightly darker patch; while the model edits files the view splits: chat left, diff panel right
    Sidebar.tsx         Right-hand panel: provider, model, tabs (Info/Todos/Files), companion pet
    InputBar.tsx        Bottom input with slash autocomplete (mouse click/wheel) + status line
    Modals.tsx          Provider picker, model picker, key input, base-URL editor, confirm dialogs (mouse click/wheel)
  companion/
    openpets.ts         Optional OpenPets desktop app bridge (IPC via @open-pets/client)
    (Companion.tsx lives in components/ — animated pet with blink frames, click reactions, speech bubbles)
```

The old `src/tui.js` (ink) has been removed. `src/core/cli.js` now spawns `bun src/tui-open.tsx` when TTY + bun available, else falls back to the basic readline REPL.

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

## Companion Pet System
- **5 built-in pets**: Cat, Robot, Fenrir (wolf), Luma (firefly), OpenPets (desktop sync)
- **Animation**: 700ms blink interval, idle/thinking/working/happy/sleep poses, random phrases
- **Interaction**: Click pet → celebrating mood + hearts counter + speech bubble
- **Event-driven moods**: `notifyPet({ mood: "working"|"success"|"error"|"celebrating" ... })` called from chat lifecycle
- **OpenPets desktop sync** (optional): `@open-pets/client` IPC bridge at `src/tui/companion/openpets.ts`
  - Reactions: idle, thinking, working, editing, running, testing, waiting, waving, success, error, celebrating
  - Auto-discovers desktop app via `%APPDATA%\OpenPets\runtime\ipc.json` (Win) or `~/.config/OpenPets/runtime/ipc.json` (Linux)
  - Graceful no-op when desktop app not running
- `/companion` opens picker modal; selection persisted to `~/.loom/tui.json`
- Settings `[e]` toggles OpenPets sync on/off

## Slash Commands (39 total)
| Command | Args | Description |
|---------|------|-------------|
| `/help` | — | Show this help dialog |
| `/build` | — | Build mode — full agent tools (all tools, executes changes) |
| `/plan` | — | Plan mode — read-only analysis; model gets only read/glob/grep/webfetch/todowrite, mutations blocked by an execute guard; ends with "Plan complete — Tab to Build, send 'go'" |
| `/chat` | — | Chat mode — conversation only, zero tools |
| `/connect` | `[provider]` | Add/connect a provider (opens picker if no arg) |
| `/key` | — | Edit API key for current provider |
| `/baseurl` | `[provider] [url]` | Set provider base URL |
| `/model` | `[model-id]` | Pick active model (or open picker) |
| `/models` | — | List available models (grouped by provider) |
| `/providers` | — | List supported providers |
| `/status` | — | Show connection status (provider, model, key) |
| `/usage` | — | Show token usage and billing breakdown (session + lifetime + monthly budget) |
| `/budget` | `[level \| $]` | Budget routing — `free`/`cheap`/`best`/`auto`, or a dollar cap (`/budget 50`). Over-cap blocks paid turns (`/budget free` is the escape hatch) |
| `/new` | — | Start a new session |
| `/clear` | — | Clear the chat |
| `/compact` | — | Compact conversation (keep last 10) |
| `/restore` | — | Restore a snapshot point |
| `/undo` | — | Undo last exchange |
| `/redo` | — | Redo last undone exchange |
| `/reset` | — | Reset the session |
| `/settings` | — | Toggle details/thinking/sidebar/OpenPets |
| `/sessions` | — | Browse saved sessions |
| `/share` | — | Export the current session to JSON |
| `/export` | — | Export to markdown |
| `/thinking` | — | Toggle thinking visibility |
| `/details` | — | Toggle tool detail visibility |
| `/theme` | — | Theme picker (live switch + persist) |
| `/permissions` | — | Saved permission rules (view / reset) |
| `/editor` | — | Open external editor (LOOM.md) |
| `/diff` | — | Show git diff |
| `/init` | — | Create LOOM.md |
| `/memory` | — | Show memory file locations |
| `/doctor` | — | Run diagnostics |
| `/skills` | `install <dir\|git> \| remove <name>` | Manage skills (`/skills install <path-or-url> [name]`, `/skills remove <name>`, `/skills help`) |
| `/mcp` | `add <name> <cmd> \| remove \| toggle` | Manage MCP servers (`/mcp add <name> <command> [args...]`, `/mcp remove <name>`, `/mcp toggle <name>`, `/mcp help`) |
| `/debug` | — | Show debug info |
| `/fork` | — | Fork conversation |
| `/companion` | — | Change your companion pet |
| `/exit` | — | Quit Loom Code |

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
| `b` | `/build` |
| `p` | `/plan` |

### Autocomplete
- **Slash (`/`)** — live-filtered commands with descriptions, 10-row scrollable window over the full list, UP/DOWN/TAB/ENTER/ESC
- **At (`@`)** — fuzzy file search (project files, top 10)
- **Bang (`!`)** — shell presets (`!ls -la`, `!git status`, `!git diff`, `!pwd`)
- **Mouse** — click a suggestion row to select + execute it; scroll wheel scrolls through the full list and moves the selection (also in modals: provider/model/companion pickers + palette — model picker shows "showing N-M of X" range)

### Keyboard Shortcuts
| Keys | Action |
|------|--------|
| `Enter` | Submit prompt / pick autocomplete |
| `Esc` | Interrupt thinking / close modal / clear input |
| `Ctrl+C` | Exit TUI (clean terminal restore) |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+P` | Command palette (type to filter) |
| `Ctrl+X` | Leader prefix (3s timeout) |
| `Ctrl+I` | Cycle sidebar tab (Info/Todos/Files) |
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
  "temperature": 0.7
}
```

## TUI State Persistence
`~/.loom/tui.json`:
```json
{
  "sidebarVisible": true,
  "showToolDetails": false,
  "showThinking": true,
  "companion": "cat",
  "openPetsSync": false,
  "petEnabled": true
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
  3. If it opens a picker, add a modal handler in `src/tui/components/Modals.tsx`
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

This pattern applies to ALL components: InputBar, Companion, Sidebar, BreadcrumbBar, ChatArea, Modals.

### Passing props to children
Pass **accessor functions**, not resolved values, for reactive props. Component bodies
run once (untracked), so `const msgs = props.messages` in a child body captures a stale value.

```tsx
// WRONG — child body reads props.messages once, never updates
<ChatArea messages={messages()} />

// CORRECT — child calls the accessor inside JSX
<ChatArea messages={messages} />
// in ChatArea: const visible = () => (props.messages?.() || []).slice(-40); ... {visible().map(...)}
```

Boolean/static props may stay as values (`show={sidebarVisible()}` is fine when read inside
`<Show when={...}>` or another JSX expression).