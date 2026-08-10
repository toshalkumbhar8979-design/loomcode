// Curated MCP presets — one-key installs for well-known servers. Every entry
// here is a package that was verified to exist on npm; secrets are collected
// as env vars and never embedded into the command line.
//
// Each preset: name, package, description, defaults (env placeholders the
// user must fill), and optional argsTail (non-secret args like --project-ref).

function npxRun(pkg, args) {
  const isWin = process.platform === "win32";
  const args2 = ["-y", pkg].concat(args || []);
  return isWin ? { command: "cmd", runArgs: ["/c", "npx"].concat(args2) } : { command: "npx", runArgs: args2 };
}

export const MCP_PRESETS = [
  {
    id: "supabase",
    label: "Supabase MCP",
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
    label: "Next.js MCP",
    package: "nextjs-mcp-server",
    description: "Next.js project introspection (routes, pages, config)",
    args: [],
    env: {},
    prompts: [],
  },
  {
    id: "railway",
    label: "Railway MCP",
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
    label: "Vercel MCP",
    package: "@vercel/mcp-server",
    description: "Vercel deployments and projects",
    args: [],
    env: { VERCEL_TOKEN: "" },
    prompts: [
      { key: "VERCEL_TOKEN", label: "Access token (vercel.com/account/tokens)" },
    ],
  },
];

export function presetSpawn(preset, resolvedEnv) {
  const run = npxRun(preset.package, preset.args);
  return { command: run.command, args: run.runArgs, env: Object.assign({}, preset.env, resolvedEnv || {}) };
}

// Same shape as MCP_PRESETS but built from a user-typed line (advanced path).
export function customFromParts(parts) {
  const name = parts[0];
  const command = parts[1];
  if (!name || !command) return null;
  return { command, args: parts.slice(2), env: {} };
}
