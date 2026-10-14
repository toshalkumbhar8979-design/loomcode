// Convex connector — real-time backend, database, functions, auth
const { ConvexHttpClient } = require('convex/browser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

function getConvexConfig() {
    const cfg = loadConnectors();
    return cfg.convex || {};
}

function setConvexConfig(config) {
    const cfg = loadConnectors();
    cfg.convex = { ...cfg.convex, ...config };
    saveConnectors(cfg);
}

function createConvexClient(overrideConfig = {}) {
    const config = { ...getConvexConfig(), ...overrideConfig };
    if (!config.url) {
        throw new Error('Convex not configured. Run: loom connectors convex --url <deployment-url>');
    }
    return new ConvexHttpClient(config.url);
}

// Query helpers
async function query(functionName, args = {}) {
    const client = createConvexClient();
    return await client.query(functionName, args);
}

async function mutation(functionName, args = {}) {
    const client = createConvexClient();
    return await client.mutation(functionName, args);
}

async function action(functionName, args = {}) {
    const client = createConvexClient();
    return await client.action(functionName, args);
}

// Subscription helpers (for real-time updates)
function subscribe(functionName, args, onUpdate) {
    const client = createConvexClient();
    return client.onUpdate(functionName, args, onUpdate);
}

// Auth helpers (using Convex's built-in auth)
async function signIn(email, password) {
    return await mutation('auth:signIn', { email, password });
}

async function signUp(email, password, name) {
    return await mutation('auth:signUp', { email, password, name });
}

async function signOut() {
    return await mutation('auth:signOut', {});
}

async function getCurrentUser() {
    return await query('auth:getCurrentUser', {});
}

async function resetPassword(email) {
    return await mutation('auth:resetPassword', { email });
}

// Database operations (using Convex's query/mutation pattern)
async function list(table, options = {}) {
    const { filter, orderBy, limit, pagination } = options;
    return await query(`${table}:list`, { filter, orderBy, limit, pagination });
}

async function get(table, id) {
    return await query(`${table}:get`, { id });
}

async function create(table, data) {
    return await mutation(`${table}:create`, { data });
}

async function update(table, id, data) {
    return await mutation(`${table}:update`, { id, data });
}

async function remove(table, id) {
    return await mutation(`${table}:delete`, { id });
}

// File storage (Convex file storage)
async function uploadFile(file, metadata = {}) {
    // First get upload URL
    const uploadUrl = await action('storage:getUploadUrl', { metadata });
    // Upload to the signed URL
    const response = await fetch(uploadUrl.uploadUrl, {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' }
    });
    if (!response.ok) throw new Error('Upload failed');
    const storageId = await response.text();
    return { storageId, ...metadata };
}

async function getFileUrl(storageId) {
    return await query('storage:getUrl', { storageId });
}

// Realtime subscriptions
function watchQuery(functionName, args, callback) {
    const client = createConvexClient();
    return client.watchQuery(functionName, args, callback);
}

// Project scaffolding for Convex
async function scaffoldConvexProject(projectName, template = 'react') {
    const projectPath = path.join(process.cwd(), projectName);
    fs.mkdirSync(projectPath, { recursive: true });
    
    // Create convex directory structure
    const convexDir = path.join(projectPath, 'convex');
    fs.mkdirSync(convexDir, { recursive: true });
    
    const templates = {
        'schema.ts': `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    name: v.string(),
    email: v.string(),
    avatar: v.optional(v.string()),
  }).index("by_email", ["email"]),
  
  messages: defineTable({
    userId: v.id("users"),
    content: v.string(),
    channel: v.string(),
  }).index("by_channel", ["channel"]),
  
  tasks: defineTable({
    title: v.string(),
    completed: v.boolean(),
    assigneeId: v.optional(v.id("users")),
  }).index("by_assignee", ["assigneeId"]),
});`,
        
        'auth.ts': `import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const signUp = mutation({
  args: { email: v.string(), password: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("users").filter(q => q.eq(q.field("email"), args.email)).unique();
    if (existing) throw new Error("Email already registered");
    const userId = await ctx.db.insert("users", { name: args.name, email: args.email });
    return { userId };
  }
});

export const signIn = mutation({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db.query("users").filter(q => q.eq(q.field("email"), args.email)).unique();
    if (!user) throw new Error("Invalid credentials");
    // In production, verify password hash here
    return { userId: user._id };
  }
});

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    // Implement session logic
    return null;
  }
});`,
        
        'tasks.ts': `import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { userId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    let q = ctx.db.query("tasks");
    if (args.userId) q = q.filter(q => q.eq(q.field("assigneeId"), args.userId));
    return await q.collect();
  }
});

export const create = mutation({
  args: { title: v.string(), assigneeId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const taskId = await ctx.db.insert("tasks", { 
      title: args.title, 
      completed: false, 
      assigneeId: args.assigneeId 
    });
    return { taskId };
  }
});

export const toggle = mutation({
  args: { id: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.id);
    if (!task) throw new Error("Task not found");
    await ctx.db.patch(args.id, { completed: !task.completed });
    return { success: true };
  }
});`,
        
        'chat.ts': `import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const sendMessage = mutation({
  args: { channel: v.string(), content: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db.query("users").filter(q => q.eq(q.field("email"), "demo@loom")).unique();
    const messageId = await ctx.db.insert("messages", {
      userId: user?._id,
      content: args.content,
      channel: args.channel
    });
    return { messageId };
  }
});

export const getMessages = query({
  args: { channel: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    let q = ctx.db.query("messages").filter(q => q.eq(q.field("channel"), args.channel));
    if (args.limit) q = q.take(args.limit);
    return await q.collect();
  }
});`
    };
    
    // Write template files
    for (const [file, content] of Object.entries(templates)) {
        fs.writeFileSync(path.join(convexDir, file), content);
    }
    
    // Create package.json with convex
    const packageJson = {
        name: projectName,
        version: '0.0.1',
        private: true,
        scripts: {
            dev: 'convex dev & vite',
            build: 'convex deploy && vite build',
            convex: 'convex'
        },
        dependencies: {
            convex: '^1.14.0',
            react: '^18.3.0',
            'react-dom': '^18.3.0'
        },
        devDependencies: {
            vite: '^5.0.0',
            '@vitejs/plugin-react': '^4.0.0',
            typescript: '^5.0.0'
        }
    };
    fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify(packageJson, null, 2));
    
    // Vite config
    fs.writeFileSync(path.join(projectPath, 'vite.config.ts'), 
        `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()], server: { port: 3000, host: true } })`);
    
    // Basic React app
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src/main.tsx'),
        `import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nimport './index.css'\nReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>)`);
    
    fs.writeFileSync(path.join(projectPath, 'src/App.tsx'),
        `import { useQuery } from 'convex/react'\nimport { api } from '../convex/_generated/api'\n\nfunction App() {\n  const tasks = useQuery(api.tasks.list)\n  return (\n    <div style={{padding: '2rem', fontFamily: 'system-ui'}}\n      <h1>${projectName}</h1>\n      <ul>\n        {tasks?.map(t => <li key={t._id}><input type="checkbox" checked={t.completed} /> {t.title}</li>)}\n      </ul>\n    </div>\n  )\n}\nexport default App`);
    
    fs.writeFileSync(path.join(projectPath, 'src/index.css'), 
        `* { box-sizing: border-box; } body { margin: 0; font-family: system-ui; background: #fafafa; }`);
    
    fs.writeFileSync(path.join(projectPath, 'index.html'),
        `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${projectName}</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`);
    
    // tsconfig
    fs.writeFileSync(path.join(projectPath, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                target: 'ES2020',
                useDefineForClassFields: true,
                lib: ['ES2020', 'DOM', 'DOM.Iterable'],
                module: 'ESNext',
                skipLibCheck: true,
                moduleResolution: 'bundler',
                allowImportingTsExtensions: true,
                resolveJsonModule: true,
                isolatedModules: true,
                noEmit: true,
                jsx: 'react-jsx',
                strict: true,
                noUnusedLocals: true,
                noUnusedParameters: true,
                noFallthroughCasesInSwitch: true
            },
            include: ['src'],
            references: [{ path: './tsconfig.node.json' }]
        }, null, 2));
    
    fs.writeFileSync(path.join(projectPath, 'tsconfig.node.json'),
        JSON.stringify({
            compilerOptions: {
                composite: true,
                skipLibCheck: true,
                module: 'ESNext',
                moduleResolution: 'bundler',
                allowSyntheticDefaultImports: true
            },
            include: ['vite.config.ts']
        }, null, 2));
    
    // Initialize git
    try { require('child_process').execSync('git init', { cwd: projectPath, stdio: 'ignore' }); } catch {}
    
    return projectPath;
}

module.exports = {
    createConvexClient,
    getConvexConfig,
    setConvexConfig,
    query, mutation, action, subscribe,
    signIn, signUp, signOut, getCurrentUser, resetPassword,
    list, get, create, update, remove,
    uploadFile, getFileUrl,
    watchQuery,
    scaffoldConvexProject,
    loadConnectors, saveConnectors
};