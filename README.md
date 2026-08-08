# Loom Code

[![npm version](https://img.shields.io/npm/v/loom-code?style=flat&color=blue)](https://npmjs.com/loom-code)
[![License: MIT](https://img.shields.io/npm/l/loom-code?style=flat&color=green)](LICENSE)
[![Platform: Win/Mac/Linux](https://img.shields.io/badge/terminal-Win%20%7C%20Mac%20%7C%20Linux-orange)](#)

An AI-powered coding agent for the terminal with multi-provider support and a full terminal UI.

## Features

- Full OpenTUI interface with slash commands, autocomplete, and ESC-to-interrupt
- Build / Plan / Chat modes 
- LOOM.md project memory file 
- Multi-provider: Anthropic, OpenAI, NVIDIA, Google Gemini, OpenRouter, Local (Ollama)
- Built-in tools: read, write, edit, bash, grep, glob, webfetch, todowrite
- Agentic tool loop (multiple tool calls per turn, up to 50 iterations)
- MCP (Model Context Protocol) server integration
- Drag-to-copy selections, paste support
- Companion pet (OpenPets)
- Session memory, /undo, /redo, /compact, /reset, /fork
- One-shot print mode: `loom -p "query"`
- Usage & billing tracking per session + lifetime

## Prerequisites

- **[bun](https://bun.sh) >= 1.0** (required for the full TUI). Without bun, only the line-mode REPL runs.
- **Node.js >= 18** (for non-TUI mode and package scripts)
- **An API key** from at least one provider:

| Provider | Sign-up | Key type |
|----------|---------|----------|
| Anthropic | [console.anthropic.com](https://console.anthropic.com) | Claude API key |
| OpenAI | [platform.openai.com](https://platform.openai.com) | API key |
| NVIDIA | [build.nvidia.com](https://build.nvidia.com) | NIM API key (free tier available) |
| Google | [aistudio.google.com](https://aistudio.google.com) | Gemini API key (free tier available) |
| OpenRouter | [openrouter.ai](https://openrouter.ai) | OpenRouter API key |
| Local | Install [Ollama](https://ollama.com) | No key needed (runs locally) |

Install from npm (global — installs the `loom` command):
```bash
npm install -g loom-code
```

Or run from source:
```bash
npm install -g .
# or
npm link
```

## Setup

1. **Install bun** (for the full TUI):
   ```bash
   # macOS / Linux
   curl -fsSL https://bun.sh/install | bash

   # Windows
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

2. **Configure API keys** — pick one method:
   ```bash
   # a) Environment variables (.env)
   cp .env.example .env
   # Edit .env with your key:
   # ANTHROPIC_API_KEY=sk-ant-...
   # NVIDIA_API_KEY=nvapi-...
   # OPENAI_API_KEY=sk-...

   # b) Interactive setup in the TUI
   loom
   > /connect nvidia
   ```

3. **Initialize project memory** (optional):
   ```bash
   loom
   > /init
   ```
   Creates `LOOM.md` with a project-specific template.

## Usage

```bash
loom                              # interactive TUI session
loom "explain this project"       # start with initial prompt
loom -p "list files in src/"      # one-shot, print result, exit
cat logs.txt | loom -p "explain"  # analyze piped content
loom --version
loom --help
loom --basic                      # skip TUI, use line-mode REPL
```

## Slash Commands (34 total)

| Command | Args | Description |
|---------|------|-------------|
| `/help` | — | Show all commands |
| `/build` | — | Build mode — all tools |
| `/plan` | — | Plan mode — read-only analysis |
| `/chat` | — | Chat mode — no tools |
| `/connect` | `[provider]` | Add/connect a provider |
| `/key` | — | Edit API key for current provider |
| `/baseurl` | `[provider] [url]` | Set provider base URL |
| `/model` | `[model-id]` | Pick active model |
| `/models` | — | List available models |
| `/providers` | — | List supported providers |
| `/status` | — | Show connection status |
| `/usage` | — | Show token usage and billing |
| `/new` | — | Start a new session |
| `/clear` | — | Clear the chat |
| `/compact` | — | Compact conversation |
| `/undo` | — | Undo last exchange |
| `/redo` | — | Redo last undone exchange |
| `/reset` | — | Reset the session |
| `/settings` | — | Toggle details/sidebar/etc. |
| `/sessions` | — | Browse saved sessions |
| `/share` | — | Export current session to JSON |
| `/export` | — | Export to markdown |
| `/thinking` | — | Toggle thinking visibility |
| `/details` | — | Toggle tool detail visibility |
| `/init` | — | Create LOOM.md |
| `/memory` | — | Show memory files |
| `/doctor` | — | Run diagnostics |
| `/skills` | `install\|remove` | Manage skills |
| `/mcp` | `add\|remove\|toggle` | Manage MCP servers |
| `/debug` | — | Show debug info |
| `/fork` | — | Fork conversation |
| `/companion` | — | Change companion pet |
| `/exit` | — | Quit Loom Code |

## Keybindings

| Key | Action |
|-----|--------|
| **ESC** | Interrupt current operation (aborts API requests) |
| **Ctrl+C** | Exit |
| **Ctrl+B** | Toggle sidebar (file browser) |
| **Ctrl+P** | Open command palette |
| **Tab** | Cycle mode (Build → Plan → Chat) |
| **b** | Leader — build mode |
| **p** | Leader — plan mode |

## Troubleshooting

### "bun not found — full TUI requires bun"
Install bun from [bun.sh](https://bun.sh). If bun is already installed but not found, add `~/.bun/bin` to your `PATH`.

### "API key is invalid or expired"
Run `/connect <provider>` in the TUI and paste a new key. For environment variables, check your `.env` file.

### "403 Forbidden: the API key is not authorized"
Your key doesn't have access to the selected model. Some providers (especially NVIDIA NIM and OpenRouter) require accepting model terms on their website first.

### "402 quota exceeded"
Your API billing tier or rate limit has been reached. Upgrade your plan or switch to a different provider.

### TUI is slow or flickering
Try launching with `--basic` to use the line-mode REPL instead, which is lighter.

## Project Structure

```
LoomCode/
├── bin/
│   ├── loom.js              # CLI entry point
│   ├── loomcode.js          # Alternative binary name
│   └── loom-tui.js          # TUI launcher
├── src/
│   ├── index.js             # Bootstraps CLI
│   ├── core/
│   │   ├── cli.js           # Interactive REPL + slash commands
│   │   ├── session.js       # Conversation + agent tool loop
│   │   ├── permissions.js   # Command permission checks
│   │   ├── platform.js      # OS/platform detection
│   │   ├── session-store.js # Persisted sessions
│   │   ├── usage.js         # Token/cost tracking
│   │   └── plugin-cmd.js    # Subcommand backend
│   ├── providers/
│   │   ├── index.js         # ProviderRouter dispatch
│   │   ├── openai-compat.js # OpenAI-compatible provider base
│   │   ├── anthropic.js     # Anthropic Claude connector
│   │   ├── openai.js        # OpenAI GPT connector
│   │   ├── nvidia.js        # NVIDIA NIM connector
│   │   ├── google.js        # Google Gemini connector
│   │   ├── openrouter.js    # OpenRouter connector
│   │   ├── local.js         # Local (Ollama) connector
│   │   └── custom.js        # Custom provider host
│   ├── tools/
│   │   └── index.js         # read/write/edit/bash/grep/glob/webfetch
│   ├── config/
│   │   ├── settings.js      # ~/.loom/config.json persistence
│   │   └── provider-cmd.js  # /connect command logic
│   └── tui/
│       ├── App.tsx           # OpenTUI root component
│       ├── store.ts          # SolidJS reactive store
│       ├── theme.ts          # Theme / palette
│       ├── components/
│       │   ├── InputBar.tsx  # Chat input + autocomplete
│       │   ├── ChatArea.tsx  # Message list
│       │   ├── BreadcrumbBar.tsx  # Mode + provider bar
│       │   ├── Modals.tsx    # Settings pickers
│       │   ├── Sidebar.tsx   # File sidebar
│       │   └── Companion.tsx # Pet display
│       └── companion/
│           └── openpets.ts   # OpenPets tts integration
├── package.json
├── LOOM.md                    # Developer reference
└── .gitignore
```

## Configuration

Config is stored at `~/.loom/config.json` (permissions: 0600). Includes:
- `provider` — default LLM provider
- `model` — per-provider model IDs (editable in source or via `/model`)
- `apiKeys` — API keys from `/connect` or manual edit
- `baseUrls` — custom provider endpoints
- `maxTokens`, `temperature` — model settings

API keys can also be set via environment variables: `.env` or `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `NVIDIA_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY` etc.

## Adding a New Provider

Register in `src/providers/<name>.js` exporting `{ chat, stream, models }`:

```js
async function chat(messages, options) {
  // call API, return { content: '...', toolCalls: [{...}], usage: {{...}} }
}
async function stream(messages, options, onDelta) {
  // stream response, return { content, toolCalls, usage }
}
const models = [
  { id: 'my-model', name: 'My Model', provider: 'myname', context: 128000, priceIn: 0.50, priceOut: 2.00 }
];
module.exports = { chat, stream, models };
```

Then add it in `src/providers/index.js` under `PROVIDERS`.

## License

MIT