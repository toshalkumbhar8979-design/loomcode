# Hacker News Launch Kit — Loom Code

Ready-to-paste content for https://news.ycombinator.com/submit
(the form with title / url / text fields).

---

## Recommended submission (Show HN, link post)

**Post this as a Show HN** (check the "Show HN" wording is in the title).
Use the **GitHub repo as the URL** — HN prefers repos over npm links for
source-available tools, and the README with the screenshot is the landing
page. When a URL is present the `text` field is optional — leave it EMPTY
and instead post the author comment below as the first comment in the
thread (that's the HN convention and it reads much better).

### title (copy-paste)

```
Show HN: Loom Code – open-source AI coding agent for the terminal
```

Alternates (pick one; keep it factual, HN punishes hype):

```
Show HN: Loom Code – terminal coding agent with OpenTUI, MCP, and 180+ models
Show HN: Loom Code – an open-source Claude Code-style agent for any provider
```

### url (copy-paste)

```
https://github.com/toshalkumbhar8979-design/loomcode
```

### text (leave EMPTY for a link post)

---

## First comment (post this yourself as the author, right after submitting)

```
Hi HN — I built Loom Code, an open-source (MIT) AI coding agent that runs
in your terminal. Repo: https://github.com/toshalkumbhar8979-design/loomcode
Install: npm install -g loom-agent

Why another agent? I wanted one that:
- isn't locked to one vendor — same agent loop across Anthropic, OpenAI,
  NVIDIA NIM, Gemini, OpenRouter, or a local Ollama model (180+ models),
  switchable mid-session with /models
- has a real terminal UI (custom OpenTUI + SolidJS renderer): chat with
  streaming, inline diffs per tool call, plan/build/chat modes, mouse
  selection + copy, vim mode, a command palette (ctrl+p), and a sidebar
- ships the pieces I missed in one package: MCP servers (built-in browser
  + presets for Playwright, Context7, etc.), subagents you can invoke with
  @agent, LOOM.md project memory, usage/cost tracking per session and
  lifetime, session save/fork/undo, and a browser interface (`loom web`)

Engineering notes for the curious: the TUI is SolidJS compiled to a custom
terminal renderer (no HTML, no node canvas); bun is bundled via npm
optional deps so `npm i -g loom-agent` needs zero setup and still works
if you never install bun (falls back to a Node REPL); and there's an
Agent Client Protocol server (`loom acp`) so editors like Zed can drive it.

The bash/edit/write tool calls go through a permission system
(allow/ask/deny per tool + path globs), and dangerous commands always ask.

Breaking things is expected — it's early and rough around the edges.
What would you want in a terminal coding agent?
```

---

## Alternate: text post (if you'd rather not link post)

Leave `url` EMPTY, paste into `text`. (Link posts reach more people; text
posts invite more discussion. Pick one, never both.)

### title

```
Show HN: Loom Code – I built an open-source AI coding agent for the terminal
```

### text

```
Hi HN — I've been building Loom Code, an open-source (MIT) AI coding agent
for the terminal: https://github.com/toshalkumbhar8979-design/loomcode
(npm install -g loom-agent — bun is bundled, no other setup needed)

It's a Claude Code-style agent that isn't tied to one vendor: the same
agent loop runs on Anthropic, OpenAI, NVIDIA NIM, Gemini, OpenRouter, or
local Ollama — 180+ models, switchable mid-session.

The UI is a full terminal app built on OpenTUI + SolidJS: streaming chat,
inline diffs for every edit, plan/build/chat modes, subagents (@explore),
MCP server support with presets, LOOM.md project memory, prompt history,
vim mode, and a cost tracker. There's also `loom web` (browser interface),
`loom acp` (editor integration), and `loom -p "query"` for scripting.

Tool calls gate through a permission system (per-tool + path-glob
allow/ask/deny; dangerous bash always asks).

Stack: plain ESM JavaScript core + SolidJS TSX for the TUI, rendered by a
custom Zig-based terminal renderer. 200+ tests gate every push.

Early and rough — feedback welcome, especially on the agent loop UX.
```

---

## Q&A prep: "What's new or different compared to existing products?"

> **Short version: Loom doesn't lock you into anyone's cloud, doesn't need a setup ritual, and treats your terminal like an app platform instead of a log file.**
>
> **1. Any model, out of the box.** Claude Code only speaks to Anthropic, Codex only to OpenAI, Gemini CLI only to Google. Loom takes *any* OpenAI- or Anthropic-compatible endpoint — paste a base URL + key into `/connectors` and it works. That includes NVIDIA NIM's free tier, OpenRouter, vLLM, Ollama, whatever your team already runs. Switching models mid-session is one keystroke.
>
> **2. Genuinely zero-setup install.** `npm i -g loom-agent` works even on machines without Bun installed, because Loom ships the Bun runtime *inside* the npm package (platform-specific `@oven/*` binaries as optional dependencies — no `curl | bash`, no postinstall download, works behind corporate registries). Three-tier fallback: bundled binary → PATH bun → plain Node REPL, so the command never dies.
>
> **3. It's a real terminal application, not a REPL.** Built on OpenTUI (our own renderer) with SolidJS reactivity underneath: mouse support, hover previews, scrollable modals, live-streaming diffs and tool output at 60fps. Most CLI agents print text; this behaves like software.
>
> **4. Guardrails you can actually inspect.** Every tool call hits a permission popup (allow once / always / deny), spending is capped with visible budget accounting, and remote skills are **commit-pinned**: approving a skill approves one exact git commit — if its content ever changes, it demands re-approval before it runs again.
>
> **5. Three ways to drive it.** Interactive TUI, `loom web` (HTTP API + browser client), and ACP support so editors can embed it.
>
> Honest framing: same category as Claude Code/Aider, but the ownership model is inverted — **your keys, your provider bills, your `~/.loom` data directory, MIT-licensed source.**

---
## Posting checklist (HN-specific)

- [ ] Post Tuesday–Thursday, 7–10 AM US Eastern (highest-traffic window).
- [ ] Title is factual, no clickbait, starts with "Show HN:".
- [ ] URL = GitHub repo. `text` empty for link posts.
- [ ] Post the author comment immediately after submitting (see above).
- [ ] Do NOT ask anyone to upvote (insta-flag risk). Don't upvote from your
      own other accounts.
- [ ] Reply to every substantive comment, esp. criticism — HN rewards
      authors who engage honestly. Admit rough edges before others find them.
- [ ] If it dies with 1–2 points, don't repost for weeks; it can be resubmitted
      later or picked up by someone else.
- [ ] Watch for: "how is this different from Claude Code / Aider / Codex CLI?" —
      answer: multi-provider + open source + full TUI + MCP/subagents built in.
- [ ] Watch for license questions — keep LICENSE file consistent with claims
      (see note below).

## Known discrepancy to fix BEFORE posting

`README.md` badge says **MIT** and links LICENSE, but `package.json` says
`"license": "ISC"`. HN will catch this. Decide which is true, align
`package.json` + README + LICENSE file, and ideally fix before the post.
