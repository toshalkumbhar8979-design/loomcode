// Curated MCP presets — one-key installs for well-known servers.
//
// Presets are vendor-published packages, vendor docker images, or the vendors'
// documented remote MCP endpoints (run through the mcp-remote proxy, which
// handles OAuth). Secrets are collected as env vars and never embedded into
// the command line.
//
// Each preset: name, package, description, defaults (env placeholders the user
// must fill), optional prompts, and optional argsTail (non-secret args).
// `command` overrides the npx wrapper (e.g. docker-based servers).

function npxRun(pkg, args) {
  const isWin = process.platform === "win32";
  const args2 = ["-y", pkg].concat(args || []);
  return isWin ? { command: "cmd", runArgs: ["/c", "npx"].concat(args2) } : { command: "npx", runArgs: args2 };
}

// Dev-tool MCP servers (browsers, docs, search, monitoring, databases).
export const MCP_PRESETS = [
  {
    id: "playwright",
    label: "Playwright MCP",
    package: "@playwright/mcp",
    description: "Drive a real browser: test, screenshot, debug pages",
    args: [],
    env: {},
    prompts: [],
  },
  {
    id: "github",
    label: "GitHub MCP",
    command: "docker",
    description: "Official GitHub server: repos, issues, PRs, Actions (docker)",
    args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    prompts: [
      { key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub PAT with repo scope (github.com/settings/tokens)", mask: true },
    ],
  },
  {
    id: "context7",
    label: "Context7 MCP",
    package: "@upstash/context7-mcp",
    description: "Live docs for 6000+ libraries — no stale API guesses",
    args: [],
    env: {},
    prompts: [],
  },
  {
    id: "sentry",
    label: "Sentry MCP",
    package: "@sentry/mcp-server",
    description: "Pull issues, stack traces, and root-cause analysis",
    args: ["--access-token", "$SENTRY_ACCESS_TOKEN"],
    env: { SENTRY_ACCESS_TOKEN: "" },
    prompts: [
      { key: "SENTRY_ACCESS_TOKEN", label: "Sentry auth token (sentry.io/settings/auth-tokens)", mask: true },
    ],
  },
  {
    id: "figma",
    label: "Figma MCP",
    package: "figma-developer-mcp",
    description: "Design context: nodes, layout, tokens, component refs",
    args: [],
    env: { FIGMA_API_KEY: "" },
    prompts: [
      { key: "FIGMA_API_KEY", label: "Figma API key (figma.com/developers/api)", mask: true },
    ],
  },
  {
    id: "exa",
    label: "Exa Search MCP",
    package: "exa-mcp-server",
    description: "Web search + crawling via Exa",
    args: [],
    env: { EXA_API_KEY: "" },
    prompts: [
      { key: "EXA_API_KEY", label: "Exa API key (dashboard.exa.ai)", mask: true },
    ],
  },
  {
    id: "mongodb",
    label: "MongoDB MCP",
    package: "mongodb-mcp-server",
    description: "Query MongoDB and manage Atlas (official server)",
    args: [],
    env: { MONGODB_CONNECTION_STRING: "" },
    prompts: [
      { key: "MONGODB_CONNECTION_STRING", label: "Connection string (mongodb+srv://…)", mask: false },
    ],
  },
  {
    id: "linear",
    label: "Linear MCP",
    package: "linear-mcp-server",
    description: "Issues, cycles, and projects for Linear",
    args: [],
    env: { LINEAR_API_KEY: "" },
    prompts: [
      { key: "LINEAR_API_KEY", label: "Linear API key (linear.app/settings/api)", mask: true },
    ],
  },
  {
    id: "filesystem",
    label: "Filesystem MCP",
    package: "@modelcontextprotocol/server-filesystem",
    description: "Scoped file access outside this project (official reference server)",
    args: [],
    env: {},
    prompts: [],
    optionalArgsPrompt: { flag: null, label: "Root path (optional, default: project dir) — Enter to skip" },
  },
];

// Hosting / cloud-service connectors — platforms you "connect" your project to
// rather than dev-tool servers. Surfaced under /connectors, not /mcp. The
// catalog lives in the core layer (src/mcp/connector-presets.js) so the CLI
// (`loom add connector <preset> -e KEY=V`) and this picker share one source.
export const CONNECTOR_PRESETS: any[] = require("../mcp/connector-presets.js").CONNECTOR_PRESETS;

export function presetSpawn(preset, resolvedEnv) {
  if (preset.command) {
    return { command: preset.command, args: preset.args || [], env: Object.assign({}, preset.env, resolvedEnv || {}) };
  }
  const run = npxRun(preset.package, preset.args);
  return { command: run.command, args: run.runArgs, env: Object.assign({}, preset.env, resolvedEnv || {}) };
}
