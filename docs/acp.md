# Editor integration via the Agent Client Protocol (ACP)

Loom can be driven as a **background coding agent by any editor that speaks the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com)** — the same open
standard that powers opencode, Claude Code, and Gemini CLI integrations. You
don't need a Loom plugin or a Loom-owned editor: the editor spawns `loom acp`
as a subprocess, and the two sides exchange JSON-RPC messages over stdio.

> New in v1.3.0 — implemented in `src/acp/acp-server.js` (protocol tests in
> `src/acp/acp-server.test.js`).

## How it works

- **Transport:** newline-delimited JSON-RPC 2.0 over stdio. The editor writes
  requests to stdin; Loom answers on stdout and queues agent events that the
  client pulls with `fetchAgentEvent`. Loom never writes protocol data to
  stdout outside responses, so the stream stays parseable.
- **Launch:** `loom acp` starts the server and prints a readiness line to
  **stderr** (never stdout): `[loom acp] started — provider: …, config: …`.
- **Lifecycle:** the editor sends `initialize` → `connect` (creates a session,
  chooses `plan`/`chat`/`build` mode, optional instruction block) →
  `sendChatRequest` → polls `fetchAgentEvent` → `cancelCurrentTask` when asked.

## Prerequisites

- Loom installed (provides the `loom` command) — or run `bun src/acp/acp-server.js`
  from a checkout.
- An API key for at least one provider (the same config used by the TUI;
  provider is chosen automatically from `~/.loom/config.json` or `LOOM_CONFIG_DIR`).

## Configure an editor

### Zed

Zed hosts ACP agents in its Agent Panel as **External Agents**. Add Loom as a
custom agent in `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "Loom Code": {
      "type": "custom",
      "command": "loom",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Then open the Command Palette and run **`agent: new thread`**, pick *Loom Code*,
and chat. To bind a key (open the Agent Panel / start a thread):

```json
{
  "bindings": {
    "cmd-alt-o": ["agent::NewExternalAgentThread", {
      "agent": { "custom": { "name": "Loom Code", "command": { "command": "loom", "args": ["acp"] } } }
    }]
  }
}
```

Prefer pointing `command` at the full path to `loom` (`which loom`) so Zed can
find it.

### JetBrains IDEs (IntelliJ / PyCharm / WebStorm …)

JetBrains co-developed ACP with Zed. In the JetBrains **Agent** integration,
set the ACP provider command to `loom acp` (same shape as the Zed entry above:
command `loom`, arguments `acp`).

### Neovim

Point an ACP-capable completion plugin’s custom adapter at `loom acp`:

- **Avante.nvim** — add a provider with `custom_api = "acp"` and make the
  command run `loom acp`.
- **CodeCompanion.nvim** — add an ACP adapter whose command is `loom acp`.

If your plugin needs the agent to reachable on `PATH`, install Loom globally
(`npm i -g .` / `npm link` from the repo, or publish) or use the absolute path.

## Implemented ACP methods

| Method                | Notes                                                                 |
|-----------------------|-----------------------------------------------------------------------|
| `initialize`          | Returns `protocolVersion: 1`, capabilities (`openai`, `customInstructions`), and the full OpenAI-style `toolSchemas` + `builtInTools`. |
| `connect`             | Creates a session/task. Accepts `agentConfig.mode` (`plan`/`chat`/`build`) and `agentConfig.instructions` (injected into the agent prompt). Emits `session.updated: created`; returns `{ taskId }`. |
| `storeMessage`        | Persists a user/assistant message into the session before/after requests. |
| `sendChatRequest`     | Starts an async turn; returns `{ requestId }` immediately. Streams `agent.message` (text + reasoning), `tool.use`, `tool.result`, then `request.completed` / `request.error`. |
| `fetchAgentEvent`     | Poll with `{ taskId, cursor }`; returns `{ events, cursor }`. Increment the cursor and keep polling until `request.completed`/`request.error`. |
| `cancelCurrentTask`   | Interrupts the active request (maps to session interrupt / abort). |
| `updateAgentConfig`   | Replaces the session instruction block.                                |
| `changeDefaultMode`   | Switches mode between `plan`/`chat`/`build` mid-session.               |
| `enableToolUse` / `disposeTool` | Accepted; all built-in + MCP tools are enabled by default (no gating). |

## Events (retrieved via `fetchAgentEvent`)

`session.updated` (`created`/`expanded`), `agent.message` (`type: text` /
`type: reasoning`), `agent.message.completed`, `tool.use`, `tool.result`,
`request.completed`, `request.error`.

## Try it without an editor

Pipe newline-delimited JSON into `loom acp` — initialize and create a task:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize"}' \
  '{"jsonrpc":"2.0","id":2,"method":"connect","params":{}}' \
  | loom acp
```

Or run the bundled self-test client against a real model turn:

```bash
node scripts/acp-smoke.js                # spawns `node bin/loom.js acp`, chats
node scripts/acp-smoke.js "explain this"' # custom prompt
node scripts/acp-smoke.js --cancel        # demonstrate cancelCurrentTask
```

`scripts/acp-smoke.js` requires a configured provider key and exits non-zero on
protocol error, so it doubles as a CI/diagnostic ping after any ACP change.

## Publishing to the ACP Registry

To make Loom installable with **one click** in ACP-aware editors (like Zed’s
`zed: acp registry`, or the JetBrains ACP marketplace), publish a listing on the
[Agent Client Protocol registry](https://agentclientprotocol.com):

- **Command:** `loom acp` (runs the stdio server; no extra flags).
- **Runtime note:** the agent needs a provider API key — same setup as the TUI.
- **Repository/release:** link the Loom repo, README, and npm package.

A registry listing is pure metadata — the agent code is already ACP-compatible,
so no code changes are required to publish.

## Troubleshooting

- **The editor gets no response / broken JSON** — make sure nothing writes to
  stdout before/around the server. The readiness line goes to stderr by design;
  external logging must go to stderr too, or set `LOOM_DEBUG` and check
  `~/.loom/debug`.
- **`sendChatRequest` errors with “Task already has an active request”** — the
  client must wait for `request.completed`/`request.error` (or cancel) before
  the next request.
- **`fetchAgentEvent` returns no new events** — keep polling with the returned
  `cursor`; events only flush on fetch.
- **“API key is invalid” / quota errors surface as `request.error`** — configure
  the provider key exactly as you would for the TUI.
