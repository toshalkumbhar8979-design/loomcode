# Contributing to Loom Code

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# 1. Clone the repo
git clone https://github.com/yourname/loomcode
cd loomcode

# 2. Install dependencies
npm install

# 3. Run tests
npm test

# 4. Start the TUI
npm run tui
# or node bin/loom-tui.js
```

## Project Structure

```
loomcode/
├── bin/                    # CLI entry points
├── src/
│   ├── index.js            # Node.js CLI entry
│   ├── core/               # Session, CLI, permissions, usage
│   ├── providers/          # API connectors (anthropic, openai, nvidia, etc.)
│   │   └── openai-compat.js  # Base for all OpenAI-compatible providers
│   ├── tools/             # Agent tools (bash, read, write, edit, etc.)
│   ├── config/            # Settings persistence (~/.loom/config.json)
│   ├── tui/               # OpenTUI + SolidJS terminal UI
│   │   ├── App.tsx         # Root component
│   │   ├── store.ts        # Reactive state
│   │   └── components/     # InputBar, SplashScreen, ChatArea, etc.
│   └── mcp/               # MCP client/server integration
├── tests/
│   └── test-interactive.tsx  # Full interactive test suite
└── docs/                   # Landing page and documentation (separate from runtime)
```

## Adding a New Provider

1. Create `src/providers/{name}.js` using the `createOpenAICompatProvider` or a custom format.
2. Add to `src/providers/index.js` exports and `PROVIDER_ORDER`.
3. If the provider uses the default OpenAI-compatible API, just extend the base class.
4. Add the base URL to `src/config/settings.js` DEFAULTS.
5. Add the API key env var in `src/config/settings.js` `getApiKey` map.
6. Update price/context in provider models for billing accuracy.

See `src/providers/tokenrouter.js` for a minimal example.

## Adding a New Agent Tool

1. Create tool definition in `src/tools/index.js`:
```js
my_tool: {
  name: "my_tool",
  description: "What it does",
  parameters: {
    param: { type: "string", required: true },
  },
  async execute(params) {
    // validate inputs, return result string
    return "done";
  }
}
```
2. If it's read-only, add to `READ_ONLY_TOOLS` array.
3. Include in `/help` via `src/tui/components/Modals.tsx` and count in LOOM.md.

## Testing

Run the full interactive test suite (implements all features end-to-end):
```bash
npm test
```

## Code Style

- TypeScript/React in `.tsx`, JavaScript in `.js` (no `.esm.json` types in the codebase)
- Use `const`/`let` at top level
- Import at top of file, never dynamic imports inside functions
- Use `shell-quote` and `spawn()` for ANY external commands, never string-interpolated shell
- Never commit secrets or API keys to the repo

## Kept Secrets

- Do NOT commit `.env` with real API keys
- Use empty placeholders in `.env.example`
- GitHub Secrets for CI/CD

## Pull Requests

- Small, focused changes are easier to review
- Include tests for new features
- Run `npm test` before submitting
- Bump version in `package.json` for breaking/feature changes
- One PR = one feature or bug fix

## License

MIT — see [LICENSE](../LICENSE) file.