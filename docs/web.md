# Web — running Loom in your browser

Loom can run as a **web application** in your browser, giving you the same
multi-provider coding agent without a terminal. It uses a small Node `http`
server (no framework, no build step) that serves a single-page UI and drives
the **same core Session loop** as the TUI and ACP — so any provider/model,
tool, MCP server, or saved session works identically.

## Getting started

Start the web interface:

```bash
loom web
```

This starts a local server on `127.0.0.1`, picks a random available port,
prints the URL(s), and **opens your default browser** automatically.

> **Caution — security.** If `LOOM_SERVER_PASSWORD` is not set, the server is
> **unsecured**. That's fine for local single-user use but **must** be set
> before binding to a network interface (`--hostname 0.0.0.0` / `--mdns`).
> HTTP credentials and the `loom_token` cookie travel **unencrypted** — plain
> HTTP is only safe on a trusted network; for access from anything else, use a
> VPN or a TLS-terminating reverse proxy.

> **Windows.** `loom web` works from PowerShell, but if you want full terminal
> parity run it from WSL — same advice opencode gives for filesystem access.

## Configuration

You can configure the server with **command-line flags** or the `server` block
in your config (`~/.loom/config.json`). CLI flags take precedence.

### Port

By default Loom picks an available port. Pin one with:

```bash
loom web --port 4096
```

### Hostname

By default the server binds to `127.0.0.1` (localhost only). Make it reachable
on your network:

```bash
loom web --hostname 0.0.0.0
```

With `0.0.0.0`, Loom prints both local and network addresses, e.g.:

```
  Local access:       http://localhost:4096
  Network access:     http://192.168.1.100:4096
```

### mDNS

Advertise the server on the local network (sets hostname to `0.0.0.0` and
publishes it as `loom.local` via [bonjour-service](https://www.npmjs.com/package/bonjour-service)):

```bash
loom web --mdns
```

Run multiple instances on the same network with a custom domain name:

```bash
loom web --mdns --mdns-domain myproject.local
```

### CORS

Allow additional origins for custom frontends:

```bash
loom web --cors https://example.com         # one origin
loom web --cors https://a.com,https://b.com # several
loom web --cors '*'                          # any
```

### Authentication

Protect access with a password environment variable:

```bash
LOOM_SERVER_PASSWORD=secret loom web
```

> Setting the password via the command line (or passing `--password` to
> `loom attach`) can leave the literal value in shell history and process
> metadata — prefer the `LOOM_SERVER_PASSWORD` environment variable (or a
> `.env` file) where possible.

The username defaults to `loom` and can be changed with
`LOOM_SERVER_USERNAME`. When a password is set, the browser shows a login
screen; API endpoints return `401` until you log in.

### Skip the auto-open

```bash
loom web --no-open
```

## Using the web interface

Once started, the homepage lists your **saved sessions** (from
`~/.loom/sessions/`), showing provider, model, and message count. Click a
session to view its transcript; **Send a message** to continue it (or pick
**New chat** to start fresh). Responses stream live (Server-Sent Events) with
inline tool-use and reasoning.

### See Servers

Click **See Servers** in the header to view your configured MCP servers and
their enabled/disabled status (the same `/mcp` view the TUI shows).

## Attaching a terminal

You can attach a terminal client to a running web server — the two share the
same sessions and state:

```bash
# Terminal A — start the web server
loom web --port 4096

# Terminal B — attach to it
loom attach http://localhost:4096
```

`loom attach` is a **line-mode** terminal client (the SolidJS OpenTUI runs
in-process today and isn't rewired to a remote server). It lets you:

- **pick** or **create** a session (shares the server's session list),
- print a session's transcript,
- chat with live streaming, and
- send **Ctrl+C** to cancel the current request.

For password-protected servers:

```bash
LOOM_SERVER_PASSWORD=secret loom attach http://localhost:4096
# or inline:
loom attach http://localhost:4096 --username loom --password secret
```

Resume a specific session without prompting:

```bash
loom attach http://localhost:4096 --session web-abc123
```

## Config file

You can put the same server settings in your `~/.loom/config.json` under a
`server` key:

```json
{
  "server": {
    "port": 4096,
    "hostname": "0.0.0.0",
    "mdns": true,
    "cors": ["https://example.com"]
  }
}
```

**Command-line flags take precedence** over config-file settings.

## API (for custom clients)

The UI talks to a small JSON API over the same HTTP server — feel free to use
it from your own client or script. (Set `LOOM_SERVER_PASSWORD` and send
`Cookie: loom_token=…` to authenticate; get the token from `POST /api/auth`.)

| Endpoint | Method | Notes |
|---|---|---|
| `GET /api/health` | GET | `{ ok: true }` |
| `GET /api/auth` | GET | `{ required, username }` |
| `POST /api/auth` | POST | `{ username, password }` → sets `loom_token` cookie |
| `GET /api/sessions` | GET | List saved sessions |
| `GET /api/sessions/:id` | GET | Load a session transcript |
| `POST /api/sessions` | POST | `{ mode }` → `{ id, mode }` (new web session) |
| `POST /api/chat` | POST | `{ id?, message, mode? }` → `text/event-stream` of `{type, …}` |
| `POST /api/cancel` | POST | `{ id }` interrupts the active request |
| `GET /api/servers` | GET | MCP server list + status |
| `GET /api/config` | GET | Provider/model/version banner data |

SSE event `type`s: `delta`, `reasoning`, `tool.use`, `tool.result`,
`message.completed`, `request.completed`, `request.error`, `session.updated`,
`done`.

## Troubleshooting

- **"Authentication required"** — set `LOOM_SERVER_PASSWORD` (and optionally
  `LOOM_SERVER_USERNAME`) before starting the server.
- **Tail of `--cors`** — separate multiple origins with a comma: `--cors a,b`.
- **mDNS not advertised on Windows** — `bonjour-service` is pure JS but mDNS
  is best-effort on the OS; if it fails, an error is printed and the HTTP
  server still works at the printed URLs.
- **"session is busy" from a client** — you must wait for `request.completed`
  / `request.error` (or call `/api/cancel`) before sending the next message.
