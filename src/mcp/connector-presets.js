// Hosting / cloud-service connector presets — platforms you "connect" your
// project to rather than dev-tool servers. Surfaced under /connectors (and
// `loom add connector`), not /mcp. Lives in the core layer so the CLI
// (`loom add connector <preset> -e KEY=V`) and the TUI picker share one
// catalog; the TUI re-exports this list from src/tui/mcp-presets.ts.
//
// Each preset: id, label, package (npx-run) or command (full override, e.g.
// docker / npx mcp-remote), description, args (may reference $KEY env
// placeholders resolved at add time), env defaults, prompts (guided key
// entry + the required-key set for CLI expansion), and an optional
// optionalArgsPrompt (non-secret trailing arg, e.g. --project-ref).

/**
 * @typedef {Object} ConnectorPrompt
 * @property {string} key
 * @property {string} label
 * @property {boolean} [mask]
 */

/**
 * @typedef {Object} OptionalArgsPrompt
 * @property {string|null} flag
 * @property {string} label
 */

/**
 * @typedef {Object} ConnectorPreset
 * @property {string} id
 * @property {string} label
 * @property {string} [package]
 * @property {string} [command]
 * @property {string} description
 * @property {string[]} args
 * @property {Record<string, string>} env
 * @property {ConnectorPrompt[]} prompts
 * @property {OptionalArgsPrompt} [optionalArgsPrompt]
 */

/** @type {ConnectorPreset[]} */
const CONNECTOR_PRESETS = [
  {
    id: 'supabase',
    label: 'Supabase',
    package: '@supabase/mcp-server-supabase',
    description: 'Query schema, run SQL, manage Supabase projects',
    args: ['--access-token', '$SUPABASE_ACCESS_TOKEN'],
    env: { SUPABASE_ACCESS_TOKEN: '' },
    prompts: [
      { key: 'SUPABASE_ACCESS_TOKEN', label: 'Personal access token (supabase.com/dashboard/account/tokens)', mask: true },
    ],
    optionalArgsPrompt: { flag: '--project-ref', label: 'Project ref (optional, e.g. abcdefghijklmnop) — Enter to skip' },
  },
  {
    id: 'nextjs',
    label: 'Next.js',
    package: 'nextjs-mcp-server',
    description: 'Next.js project introspection (routes, pages, config)',
    args: [],
    env: {},
    prompts: [],
  },
  {
    id: 'railway',
    label: 'Railway',
    package: '@railway/mcp-server',
    description: 'Railway deploys, services, variables',
    args: [],
    env: { RAILWAY_API_TOKEN: '' },
    prompts: [
      { key: 'RAILWAY_API_TOKEN', label: 'API token (railway.app/account/tokens)', mask: true },
    ],
  },
  {
    id: 'vercel',
    label: 'Vercel',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.vercel.com'],
    description: 'Vercel deployments and projects (remote MCP endpoint, OAuth)',
    env: {},
    prompts: [],
  },
  {
    id: 'netlify',
    label: 'Netlify',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://api.netlify.com/mcp'],
    description: 'Netlify sites, deploys, and environment vars (remote MCP endpoint, OAuth)',
    env: {},
    prompts: [],
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    package: '@cloudflare/mcp-server-cloudflare',
    description: 'Workers, DNS, and account management',
    args: [],
    env: { CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' },
    prompts: [
      { key: 'CLOUDFLARE_API_TOKEN', label: 'API token (dash.cloudflare.com/profile/api-tokens)', mask: true },
      { key: 'CLOUDFLARE_ACCOUNT_ID', label: 'Account ID (dash.cloudflare.com — right sidebar)', mask: false },
    ],
  },
];

module.exports = { CONNECTOR_PRESETS };
