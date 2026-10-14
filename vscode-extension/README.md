# Loom Code for VS Code

Drive the [loom-agent](https://www.npmjs.com/package/loom-agent) CLI from inside VS Code.

## Requirements
- The global CLI: `npm i -g loom-agent` (v1.2.36+ recommended — earlier versions had a `loom web` routing bug)
- An API key configured once via `loom connect <provider> <key>` or `/connectors`

## Features

| Command | What it does |
|---|---|
| **Loom: Open Chat Terminal** | Opens the full interactive Loom TUI in an integrated terminal |
| **Loom: Ask About Selection** (`Ctrl/Cmd+Alt+L`) | Sends your selection to `loom -p` headlessly; answer lands in the *Loom Code* output channel |
| **Loom: Dock Browser UI Panel** | Starts `loom web --no-open` on 127.0.0.1 and docks the browser UI as an editor pane |
| **Loom: Stop Local Server** | Stops the server this window started |

Right-click a selection → *Loom: Ask About Selection*. The sparkle item in the status bar opens the chat terminal.

## Settings
- `loomcode.webPort` — port for the docked UI (default `4399`)
- `loomcode.printTimeoutSeconds` — timeout for headless questions (default `180`)

## Security notes
- The docked UI talks only to `http://127.0.0.1:<port>` — never bind `--hostname 0.0.0.0`
  from here. If you want auth even locally, set `LOOM_SERVER_PASSWORD` before launching VS Code.
- Headless questions run from your workspace root; normal loom permission popups apply in the
  terminal chat, while `-p` runs non-interactively — review any tool permissions you pre-approved.

## Develop / package
- Press **F5** in this folder to launch an Extension Development Host (no build step needed).
- Package: `npx vsce package` → install the produced `.vsix`.
