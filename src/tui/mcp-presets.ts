// Curated MCP presets — one-key installs for well-known servers.
//
// EVERY package below was verified against the npm registry AND confirmed to
// be a real vendor-maintained server (several lookalike npm packages are
// security-research canaries — never add an unverified package here). Secrets
// are collected as env vars and never embedded into the command line.
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
      { key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub PAT with repo scope (github.com/settings/tokens)" },
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
      { key: "SENTRY_ACCESS_TOKEN", label: "Sentry auth token (sentry.io/settings/auth-tokens)" },
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
      { key: "FIGMA_API_KEY", label: "Figma API key (figma.com/developers/api)" },
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
      { key: "EXA_API_KEY", label: "Exa API key (dashboard.exa.ai)" },
    ],
  },
  {
    id: "brave",
    label: "Brave Search MCP",
    package: "@modelcontextprotocol/server-brave-search",
    description: "Real-time web search (official reference server)",
    args: [],
    env: { BRAVE_API_KEY: "" },
    prompts: [
      { key: "BRAVE_API_KEY", label: "Brave Search API key (brave.com/search/api)" },
    ],
  },
  {
    id: "puppeteer",
    label: "Puppeteer MCP",
    package: "@modelcontextprotocol/server-puppeteer",
    description: "Headless Chrome automation (official reference server)",
    args: [],
    env: {},
    prompts: [],
  },
  {
    id: "postgres",
    label: "PostgreSQL MCP",
    package: "@modelcontextprotocol/server-postgres",
    description: "Query and inspect a Postgres database",
    args: [],
    env: { DATABASE_URL: "" },
    prompts: [
      { key: "DATABASE_URL", label: "Connection string (postgres://user:pass@host:5432/db)" },
    ],
  },
  {
    id: "sqlite",
    label: "SQLite MCP",
    package: "@modelcontextprotocol/server-sqlite",
    description: "Read/write SQLite databases (official reference server)",
    args: [],
    env: {},
    prompts: [],
    optionalArgsPrompt: { flag: null, label: "Database path (optional, e.g. ./data.db) — Enter to skip" },
  },
  {
    id: "mongodb",
    label: "MongoDB MCP",
    package: "mongodb-mcp-server",
    description: "Query MongoDB and manage Atlas (official server)",
    args: [],
    env: { MONGODB_CONNECTION_STRING: "" },
    prompts: [
      { key: "MONGODB_CONNECTION_STRING", label: "Connection string (mongodb+srv://…)" },
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
      { key: "LINEAR_API_KEY", label: "Linear API key (linear.app/settings/api)" },
    ],
  },
  {
    id: "slack",
    label: "Slack MCP",
    package: "@modelcontextprotocol/server-slack",
    description: "Post and read messages in your workspace",
    args: [],
    env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" },
    prompts: [
      { key: "SLACK_BOT_TOKEN", label: "Bot token (xoxb-…)" },
      { key: "SLACK_TEAM_ID", label: "Team ID (slack.com/api/auth.test)" },
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
// rather than dev-tool servers. Surfaced under /connectors, not /mcp.
export const CONNECTOR_PRESETS = [
  {
    id: "supabase",
    label: "Supabase",
    package: "@supabase/mcp-server-supabase",
    description: "Query schema, run SQL, manage Supabase projects",
    args: ["--access-token", "$SUPABASE_ACCESS_TOKEN"],
    env: { SUPABASE_ACCESS_TOKEN: "" },
    prompts: [
      { key: "SUPABASE_ACCESS_TOKEN", label: "Personal access token (supabase.com/dashboard/account/tokens)" },
    ],
    optionalArgsPrompt: { flag: "--project-ref", label: "Project ref (optional, e.g. abcdefghijklmnop) — Enter to skip" },
  },
  {
    id: "nextjs",
    label: "Next.js",
    package: "nextjs-mcp-server",
    description: "Next.js project introspection (routes, pages, config)",
    args: [],
    env: {},
    prompts: [],
  },
  {
    id: "railway",
    label: "Railway",
    package: "@railway/mcp-server",
    description: "Railway deploys, services, variables",
    args: [],
    env: { RAILWAY_API_TOKEN: "" },
    prompts: [
      { key: "RAILWAY_API_TOKEN", label: "API token (railway.app/account/tokens)" },
    ],
  },
  {
    id: "vercel",
    label: "Vercel",
    package: "vercel-mcp-server",
    description: "Vercel deployments and projects",
    args: [],
    env: { VERCEL_TOKEN: "" },
    prompts: [
      { key: "VERCEL_TOKEN", label: "Access token (vercel.com/account/tokens)" },
    ],
  },
  {
    id: "netlify",
    label: "Netlify",
    package: "netlify-mcp-server",
    description: "Netlify sites, deploys, and environment vars",
    args: [],
    env: { NETLIFY_AUTH_TOKEN: "" },
    prompts: [
      { key: "NETLIFY_AUTH_TOKEN", label: "Auth token (app.netlify.com/user/applications)" },
    ],
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    package: "@cloudflare/mcp-server-cloudflare",
    description: "Workers, DNS, and account management",
    args: [],
    env: { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
    prompts: [
      { key: "CLOUDFLARE_API_TOKEN", label: "API token (dash.cloudflare.com/profile/api-tokens)" },
      { key: "CLOUDFLARE_ACCOUNT_ID", label: "Account ID (dash.cloudflare.com — right sidebar)" },
    ],
  },
];

export function presetSpawn(preset, resolvedEnv) {
  if (preset.command) {
    return { command: preset.command, args: preset.args || [], env: Object.assign({}, preset.env, resolvedEnv || {}) };
  }
  const run = npxRun(preset.package, preset.args);
  return { command: run.command, args: run.runArgs, env: Object.assign({}, preset.env, resolvedEnv || {}) };
}
