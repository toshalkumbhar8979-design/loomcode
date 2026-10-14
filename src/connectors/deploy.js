// Deployment connectors — Vercel, Netlify, Cloudflare Pages, Railway, Render, Fly.io
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const CONFIG_DIR = process.env.LOOM_CONFIG_DIR || path.join(require('os').homedir(), '.loom');
const CONNECTORS_FILE = path.join(CONFIG_DIR, 'connectors.json');

function loadConnectors() {
    try {
        if (fs.existsSync(CONNECTORS_FILE)) {
            return JSON.parse(fs.readFileSync(CONNECTORS_FILE, 'utf8'));
        }
    } catch {}
    return { supabase: {}, convex: {}, deploy: {} };
}

function saveConnectors(cfg) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONNECTORS_FILE, JSON.stringify(cfg, null, 2));
}

function getDeployConfig() {
    const cfg = loadConnectors();
    return cfg.deploy || {};
}

function setDeployConfig(config) {
    const cfg = loadConnectors();
    cfg.deploy = { ...cfg.deploy, ...config };
    saveConnectors(cfg);
}

// Vercel deployment
async function deployVercel(projectPath, options = {}) {
    const config = getDeployConfig();
    if (!config.vercel?.token) {
        throw new Error('Vercel not configured. Run: loom connectors deploy vercel --token <token>');
    }
    
    const vercelCli = path.join(projectPath, 'node_modules', '.bin', 'vercel');
    const hasVercel = fs.existsSync(vercelCli) || await which('vercel');
    
    if (!hasVercel) {
        // Install vercel CLI locally
        execSync('npm install -D vercel', { cwd: projectPath, stdio: 'inherit' });
    }
    
    const args = ['--token', config.vercel.token, '--yes'];
    if (config.vercel.org) args.push('--scope', config.vercel.org);
    if (options.prod) args.push('--prod');
    if (options.buildCommand) args.push('--build-command', options.buildCommand);
    if (options.outputDir) args.push('--output-dir', options.outputDir);
    
    const result = execSync(`vercel ${args.join(' ')}`, { 
        cwd: projectPath, 
        stdio: 'pipe',
        env: { ...process.env, VERCEL_TOKEN: config.vercel.token }
    });
    
    const output = result.toString();
    const urlMatch = output.match(/https:\/\/[^\s]+/);
    return { url: urlMatch ? urlMatch[0] : null, output };
}

// Netlify deployment
async function deployNetlify(projectPath, options = {}) {
    const config = getDeployConfig();
    if (!config.netlify?.authToken) {
        throw new Error('Netlify not configured. Run: loom connectors deploy netlify --auth-token <token>');
    }
    
    const netlifyCli = path.join(projectPath, 'node_modules', '.bin', 'netlify');
    const hasNetlify = fs.existsSync(netlifyCli) || await which('netlify');
    
    if (!hasNetlify) {
        execSync('npm install -D netlify-cli', { cwd: projectPath, stdio: 'inherit' });
    }
    
    const args = ['deploy', '--auth', config.netlify.authToken];
    if (config.netlify.siteId) args.push('--site', config.netlify.siteId);
    if (options.prod) args.push('--prod');
    if (options.dir) args.push('--dir', options.dir);
    
    const result = execSync(`netlify ${args.join(' ')}`, { 
        cwd: projectPath, 
        stdio: 'pipe',
        env: { ...process.env, NETLIFY_AUTH_TOKEN: config.netlify.authToken }
    });
    
    const output = result.toString();
    const urlMatch = output.match(/https:\/\/[^\s]+/);
    return { url: urlMatch ? urlMatch[0] : null, output };
}

// Cloudflare Pages deployment
async function deployCloudflarePages(projectPath, options = {}) {
    const config = getDeployConfig();
    if (!config.cloudflare?.apiToken || !config.cloudflare?.accountId) {
        throw new Error('Cloudflare not configured. Run: loom connectors deploy cloudflare --api-token <token> --account-id <id>');
    }
    
    const wranglerCli = path.join(projectPath, 'node_modules', '.bin', 'wrangler');
    const hasWrangler = fs.existsSync(wranglerCli) || await which('wrangler');
    
    if (!hasWrangler) {
        execSync('npm install -D wrangler', { cwd: projectPath, stdio: 'inherit' });
    }
    
    // For Pages, use wrangler pages deploy
    const args = ['pages', 'deploy', options.dir || '.', 
        '--project-name', options.projectName || path.basename(projectPath),
        '--branch', options.branch || 'main',
        '--commit-hash', getGitHash(projectPath)];
    
    const result = execSync(`wrangler ${args.join(' ')}`, { 
        cwd: projectPath, 
        stdio: 'pipe',
        env: { ...process.env, CF_API_TOKEN: config.cloudflare.apiToken, CF_ACCOUNT_ID: config.cloudflare.accountId }
    });
    
    return { url: `https://${options.projectName}.pages.dev`, output: result.toString() };
}

// Railway deployment
async function deployRailway(projectPath, options = {}) {
    const config = getDeployConfig();
    if (!config.railway?.token) {
        throw new Error('Railway not configured. Run: loom connectors deploy railway --token <token>');
    }
    
    const railwayCli = path.join(projectPath, 'node_modules', '.bin', 'railway');
    const hasRailway = fs.existsSync(railwayCli) || await which('railway');
    
    if (!hasRailway) {
        execSync('npm install -D @railway/cli', { cwd: projectPath, stdio: 'inherit' });
    }
    
    const args = ['up', '--detach'];
    if (config.railway.project) args.push('--project', config.railway.project);
    if (config.railway.environment) args.push('--environment', config.railway.environment);
    
    const result = execSync(`railway ${args.join(' ')}`, { 
        cwd: projectPath, 
        stdio: 'pipe',
        env: { ...process.env, RAILWAY_TOKEN: config.railway.token }
    });
    
    return { url: null, output: result.toString() };
}

// Render deployment
async function deployRender(projectPath, options = {}) {
    const config = getDeployConfig();
    if (!config.render?.apiKey) {
        throw new Error('Render not configured. Run: loom connectors deploy render --api-key <key>');
    }
    
    // Render uses API-based deployment
    const response = await fetch('https://api.render.com/v1/services', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.render.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            type: 'web_service',
            name: options.name || path.basename(projectPath),
            repo: options.repoUrl,
            branch: options.branch || 'main',
            buildCommand: options.buildCommand || 'npm run build',
            startCommand: options.startCommand || 'npm start',
            envVars: options.envVars || []
        })
    });
    
    if (!response.ok) throw new Error(`Render deployment failed: ${await response.text()}`);
    return await response.json();
}

// Fly.io deployment
async function deployFly(projectPath, options = {}) {
    const config = getDeployConfig();
    if (!config.fly?.token) {
        throw new Error('Fly.io not configured. Run: loom connectors deploy fly --token <token>');
    }
    
    const flyCli = path.join(projectPath, 'node_modules', '.bin', 'flyctl');
    const hasFly = fs.existsSync(flyCli) || await which('flyctl');
    
    if (!hasFly) {
        // Install flyctl
        if (process.platform === 'win32') {
            execSync('powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"', { stdio: 'inherit' });
        } else {
            execSync('curl -L https://fly.io/install.sh | sh', { stdio: 'inherit' });
        }
    }
    
    // Ensure fly.toml exists
    const flyToml = path.join(projectPath, 'fly.toml');
    if (!fs.existsSync(flyToml)) {
        const toml = `app = "${options.appName || path.basename(projectPath)}"
primary_region = "${options.region || 'ord'}"
[build]
  dockerfile = "Dockerfile"
[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0`;
        fs.writeFileSync(flyToml, toml);
    }
    
    const result = execSync(`flyctl deploy --access-token ${config.fly.token}`, { 
        cwd: projectPath, 
        stdio: 'pipe' 
    });
    
    return { url: `https://${options.appName}.fly.dev`, output: result.toString() };
}

// Docker build helper
function buildDockerImage(projectPath, tag, dockerfile = 'Dockerfile') {
    const fullTag = tag || `loom-${path.basename(projectPath)}:${Date.now()}`;
    execSync(`docker build -t ${fullTag} -f ${dockerfile} .`, { cwd: projectPath, stdio: 'inherit' });
    return fullTag;
}

// Preview server (for local preview of built apps)
function startPreviewServer(projectPath, options = {}) {
    const port = options.port || 3000;
    const previewDir = options.previewDir || path.join(projectPath, 'dist');
    
    if (!fs.existsSync(previewDir)) {
        throw new Error('No build output found. Run build first.');
    }
    
    const http = require('http');
    const { createServer } = require('http');
    const { readFileSync } = require('fs');
    const { extname, join } = require('path');
    
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.eot': 'application/vnd.ms-fontobject'
    };
    
    const server = createServer((req, res) => {
        let filePath = join(previewDir, req.url === '/' ? 'index.html' : req.url);
        
        // SPA fallback
        if (!fs.existsSync(filePath)) {
            filePath = join(previewDir, 'index.html');
        }
        
        try {
            const content = readFileSync(filePath);
            const ext = extname(filePath);
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
            res.end(content);
        } catch {
            res.writeHead(404);
            res.end('Not found');
        }
    });
    
    return new Promise((resolve, reject) => {
        server.listen(port, () => resolve({ server, port, url: `http://localhost:${port}` }));
        server.on('error', reject);
    });
}

// Stop preview server
function stopPreviewServer(server) {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}

// Git helpers
function getGitHash(projectPath) {
    try {
        return execSync('git rev-parse --short HEAD', { cwd: projectPath, stdio: 'pipe' }).toString().trim();
    } catch {
        return 'unknown';
    }
}

function getGitBranch(projectPath) {
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectPath, stdio: 'pipe' }).toString().trim();
    } catch {
        return 'main';
    }
}

function getGitRemoteUrl(projectPath) {
    try {
        return execSync('git config --get remote.origin.url', { cwd: projectPath, stdio: 'pipe' }).toString().trim();
    } catch {
        return null;
    }
}

function which(cmd) {
    return new Promise((resolve) => {
        const whichCmd = process.platform === 'win32' ? 'where' : 'which';
        const child = spawn(whichCmd, [cmd], { stdio: 'ignore' });
        child.on('close', (code) => resolve(code === 0));
    });
}

// Auto-detect framework and build
async function detectAndBuild(projectPath) {
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        throw new Error('No package.json found');
    }
    
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    
    let framework = 'vite';
    let buildCommand = pkg.scripts?.build || 'npm run build';
    let outputDir = 'dist';
    let devCommand = pkg.scripts?.dev || 'npm run dev';
    
    if (deps.next) {
        framework = 'nextjs';
        buildCommand = 'next build';
        outputDir = '.next';
        devCommand = 'next dev';
    } else if (deps['@remix-run/react'] || deps['@remix-run/node']) {
        framework = 'remix';
        buildCommand = 'remix build';
        outputDir = 'build';
    } else if (deps.astro) {
        framework = 'astro';
        buildCommand = 'astro build';
        outputDir = 'dist';
    } else if (deps.nuxt) {
        framework = 'nuxt';
        buildCommand = 'nuxt build';
        outputDir = '.output/public';
    } else if (deps.svelte || deps['@sveltejs/kit']) {
        framework = 'svelte';
        buildCommand = 'vite build';
        outputDir = 'build';
    }
    
    // Run build
    execSync(buildCommand, { cwd: projectPath, stdio: 'inherit' });
    
    return { framework, buildCommand, outputDir, devCommand };
}

module.exports = {
    loadConnectors,
    saveConnectors,
    getDeployConfig,
    setDeployConfig,
    deployVercel,
    deployNetlify,
    deployCloudflarePages,
    deployRailway,
    deployRender,
    deployFly,
    buildDockerImage,
    startPreviewServer,
    stopPreviewServer,
    getGitHash,
    getGitBranch,
    getGitRemoteUrl,
    detectAndBuild,
    which
};