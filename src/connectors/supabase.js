// Supabase connector — auth, database, storage, edge functions, realtime
const { createClient } = require('@supabase/supabase-js');
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

function getSupabaseConfig() {
    const cfg = loadConnectors();
    return cfg.supabase || {};
}

function setSupabaseConfig(config) {
    const cfg = loadConnectors();
    cfg.supabase = { ...cfg.supabase, ...config };
    saveConnectors(cfg);
}

function createSupabaseClient(overrideConfig = {}) {
    const config = { ...getSupabaseConfig(), ...overrideConfig };
    if (!config.url || !config.anonKey) {
        throw new Error('Supabase not configured. Run: loom connectors supabase --url <url> --anon-key <key>');
    }
    return createClient(config.url, config.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        ...config.options
    });
}

// Auth helpers
async function signUp(email, password, metadata = {}) {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: metadata } });
    if (error) throw error;
    return data;
}

async function signIn(email, password) {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
}

async function signOut() {
    const supabase = createSupabaseClient();
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
}

async function getSession() {
    const supabase = createSupabaseClient();
    const { data: { session } } = await supabase.auth.getSession();
    return session;
}

async function getUser() {
    const supabase = createSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    return user;
}

async function resetPassword(email) {
    const supabase = createSupabaseClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) throw error;
}

// Database helpers (PostgreSQL via Supabase)
async function query(table, options = {}) {
    const supabase = createSupabaseClient();
    let query = supabase.from(table).select(options.select || '*');
    
    if (options.filter) {
        for (const [col, val] of Object.entries(options.filter)) {
            query = query.eq(col, val);
        }
    }
    if (options.order) {
        query = query.order(options.order.column, { ascending: options.order.ascending !== false });
    }
    if (options.limit) {
        query = query.limit(options.limit);
    }
    if (options.range) {
        query = query.range(options.range.from, options.range.to);
    }
    
    const { data, error } = await query;
    if (error) throw error;
    return data;
}

async function insert(table, records, returning = true) {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase.from(table).insert(records).select(returning ? '*' : '');
    if (error) throw error;
    return data;
}

async function update(table, filter, updates) {
    const supabase = createSupabaseClient();
    let query = supabase.from(table).update(updates);
    for (const [col, val] of Object.entries(filter)) {
        query = query.eq(col, val);
    }
    const { data, error } = await query.select('*');
    if (error) throw error;
    return data;
}

async function remove(table, filter) {
    const supabase = createSupabaseClient();
    let query = supabase.from(table).delete();
    for (const [col, val] of Object.entries(filter)) {
        query = query.eq(col, val);
    }
    const { error } = await query;
    if (error) throw error;
}

async function rpc(functionName, params = {}) {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase.rpc(functionName, params);
    if (error) throw error;
    return data;
}

// Storage helpers
async function upload(bucket, path, fileBody, options = {}) {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase.storage.from(bucket).upload(path, fileBody, options);
    if (error) throw error;
    return data;
}

async function download(bucket, path) {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase.storage.from(bucket).download(path);
    if (error) throw error;
    return data;
}

async function removeFile(bucket, paths) {
    const supabase = createSupabaseClient();
    const { error } = await supabase.storage.from(bucket).remove(Array.isArray(paths) ? paths : [paths]);
    if (error) throw error;
}

async function getPublicUrl(bucket, path) {
    const supabase = createSupabaseClient();
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
}

async function listFiles(bucket, folder = '') {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase.storage.from(bucket).list(folder);
    if (error) throw error;
    return data;
}

// Edge Functions
async function invokeFunction(functionName, payload = {}) {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase.functions.invoke(functionName, { body: payload });
    if (error) throw error;
    return data;
}

// Realtime subscriptions
function subscribe(table, event, callback, filter = {}) {
    const supabase = createSupabaseClient();
    let channel = supabase.channel(`loom:${table}:${event}`);
    
    if (event === '*') {
        channel = channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: filter.column ? `${filter.column}=eq.${filter.value}` : undefined }, callback);
    } else {
        channel = channel.on('postgres_changes', { event, schema: 'public', table, filter: filter.column ? `${filter.column}=eq.${filter.value}` : undefined }, callback);
    }
    
    channel.subscribe();
    return () => { supabase.removeChannel(channel); };
}

// Project scaffolding helpers
async function scaffoldProject(projectName, template = 'react') {
    const projectPath = path.join(process.cwd(), projectName);
    fs.mkdirSync(projectPath, { recursive: true });
    
    const templates = {
        react: {
            'package.json': JSON.stringify({
                name: projectName,
                version: '0.0.1',
                private: true,
                scripts: {
                    dev: 'vite',
                    build: 'vite build',
                    preview: 'vite preview'
                },
                dependencies: { react: '^18.3.0', 'react-dom': '^18.3.0' },
                devDependencies: { vite: '^5.0.0', '@vitejs/plugin-react': '^4.0.0' }
            }, null, 2),
            'vite.config.js': `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()], server: { port: 3000, host: true } })`,
            'index.html': `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${projectName}</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`,
            'src/main.jsx': `import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nimport './index.css'\nReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>)`,
            'src/App.jsx': `function App() { return <div style={{padding: '2rem', fontFamily: 'system-ui'}}><h1>${projectName}</h1><p>Powered by Loom + Supabase</p></div> }\nexport default App`,
            'src/index.css': `* { box-sizing: border-box; } body { margin: 0; font-family: system-ui; background: #fafafa; }`
        },
        nextjs: {
            'package.json': JSON.stringify({
                name: projectName,
                version: '0.0.1',
                private: true,
                scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
                dependencies: { next: '^14.0.0', react: '^18.3.0', 'react-dom': '^18.3.0' }
            }, null, 2),
            'next.config.js': `/** @type {import('next').NextConfig} */\nconst nextConfig = {}\nmodule.exports = nextConfig`,
            'app/page.js': `export default function Home() { return <main style={{padding: '2rem'}}><h1>${projectName}</h1><p>Next.js + Supabase</p></main> }`,
            'app/layout.js': `export default function RootLayout({children}) { return <html lang="en"><body>{children}</body></html> }`
        },
        vue: {
            'package.json': JSON.stringify({
                name: projectName,
                version: '0.0.1',
                private: true,
                scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
                dependencies: { vue: '^3.4.0' },
                devDependencies: { vite: '^5.0.0', '@vitejs/plugin-vue': '^5.0.0' }
            }, null, 2),
            'vite.config.js': `import { defineConfig } from 'vite'\nimport vue from '@vitejs/plugin-vue'\nexport default defineConfig({ plugins: [vue()], server: { port: 3000, host: true } })`,
            'index.html': `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${projectName}</title></head><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>`,
            'src/main.js': `import { createApp } from 'vue'\nimport App from './App.vue'\nimport './style.css'\ncreateApp(App).mount('#app')`,
            'src/App.vue': `<template><div style="padding: 2rem; font-family: system-ui"><h1>${projectName}</h1><p>Vue + Supabase</p></div></template><script setup></script><style>* { box-sizing: border-box; } body { margin: 0; }</style>`,
            'src/style.css': `* { box-sizing: border-box; } body { margin: 0; font-family: system-ui; background: #fafafa; }`
        }
    };
    
    const tpl = templates[template] || templates.react;
    for (const [file, content] of Object.entries(tpl)) {
        const fullPath = path.join(projectPath, file);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
    }
    
    // Initialize git
    try { require('child_process').execSync('git init', { cwd: projectPath, stdio: 'ignore' }); } catch {}
    
    return projectPath;
}

module.exports = {
    createSupabaseClient,
    getSupabaseConfig,
    setSupabaseConfig,
    signUp, signIn, signOut, getSession, getUser, resetPassword,
    query, insert, update, remove, rpc,
    upload, download, removeFile, getPublicUrl, listFiles,
    invokeFunction, subscribe,
    scaffoldProject,
    loadConnectors, saveConnectors
};