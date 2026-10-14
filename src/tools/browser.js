// Headless browser control for the Web agent (and any build-mode session).
// Wraps Playwright behind a single-page singleton: the first action launches
// a headless Chromium and every later action reuses it, so "open a page, click
// around, read the DOM" works across tool calls without re-launching.
//
// Engine resolution order:
//   1. `playwright` (bundled chromium download, if the user installed it)
//   2. `playwright-core` + a system Chrome / Edge channel (zero download)
// Everything runs in the page context only — no filesystem access beyond the
// screenshot path the caller passes (enforced by the tool-layer sandbox for
// writes is intentionally NOT applied here: screenshots land in the OS temp
// dir by default and the tool returns the absolute path).
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALL_HINT = 'Install a browser engine:  npm i playwright  then  npx playwright install chromium  (or install playwright-core and have Chrome/Edge available)';
const ACTION_TIMEOUT_MS = 30000;

/** @type {{ browser: any, page: any }|null} */
let _engine = null;
let _playwright = null; // null = not tried, false = unavailable, else module

const ACTIONS = ['goto', 'click', 'fill', 'press', 'text', 'eval', 'links', 'screenshot', 'close'];

function loadPlaywright() {
  if (_playwright !== null) return _playwright || null;
  for (const mod of ['playwright', 'playwright-core']) {
    try { _playwright = require(mod); return _playwright; } catch {}
  }
  _playwright = false;
  return null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('browser action timed out after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function checkUrl(url) {
  const u = String(url || '').trim();
  if (!u) return { error: 'goto needs a url.' };
  let parsed;
  try { parsed = new URL(u); } catch { return { error: 'Invalid url: ' + u }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http/https urls are allowed (got ' + parsed.protocol + ').' };
  }
  return { url: parsed.href };
}

async function pageSnapshot(page) {
  const title = await page.title().catch(() => '');
  return 'URL: ' + page.url() + (title ? '\nTitle: ' + title : '');
}

/** Launch (or reuse) the headless browser. Returns the page or {error}. */
async function ensurePage() {
  if (_engine && _engine.page && !_engine.page.isClosed()) return _engine.page;
  const pw = loadPlaywright();
  if (!pw) {
    return { error: 'No browser engine found. ' + INSTALL_HINT };
  }
  const attempts = [
    () => pw.chromium.launch({ headless: true }),
    () => pw.chromium.launch({ headless: true, channel: 'chrome' }),
    () => pw.chromium.launch({ headless: true, channel: 'msedge' }),
  ];
  let lastErr = null;
  for (const attempt of attempts) {
    try {
      const browser = await withTimeout(attempt(), 20000);
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      _engine = { browser, page };
      return page;
    } catch (err) { lastErr = err; }
  }
  return { error: 'Failed to launch a browser: ' + (lastErr && lastErr.message) + '. ' + INSTALL_HINT };
}

/** Close the singleton browser (also used as the `close` action). */
async function closeBrowser() {
  if (!_engine) return 'No browser is running.';
  try { await _engine.browser.close(); } catch {}
  _engine = null;
  return 'Browser closed.';
}

/**
 * Execute one browser action. `params` comes straight from the tool call:
 *   action, url, selector, text, key, script, path
 * @param {Record<string, any>} params
 * @returns {Promise<string|{error: string}>}
 */
async function run(params) {
  const action = String(params.action || '').toLowerCase().trim();
  if (!ACTIONS.includes(action)) {
    return { error: 'Unknown action "' + action + '". Use one of: ' + ACTIONS.join(' | ') };
  }
  if (action === 'close') return closeBrowser();

  // Validate inputs BEFORE launching a browser so bad calls fail fast and
  // never spawn a headless process.
  if (action === 'goto') {
    const u = checkUrl(params.url);
    if (u.error) return u;
  }
  if ((action === 'click' || action === 'fill') && !String(params.selector || '').trim()) {
    return { error: action + ' needs a CSS selector.' };
  }
  if (action === 'press' && !String(params.key || '').trim()) {
    return { error: 'press needs a key (e.g. Enter, Tab, Escape, Control+A).' };
  }
  if (action === 'eval' && !String(params.script || '').trim()) {
    return { error: 'eval needs a JavaScript expression (runs in the page context).' };
  }

  const page = await ensurePage();
  if (page && typeof page === 'object' && 'error' in page) return page;

  try {
    switch (action) {
      case 'goto': {
        const u = checkUrl(params.url);
        if (u.error) return u;
        await withTimeout(page.goto(u.url, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS }), ACTION_TIMEOUT_MS + 2000);
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
        return 'Opened ' + (await pageSnapshot(page));
      }
      case 'click': {
        const sel = String(params.selector || '').trim();
        if (!sel) return { error: 'click needs a CSS selector.' };
        await withTimeout(page.click(sel, { timeout: 10000 }), 12000);
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        return 'Clicked "' + sel + '".\n' + (await pageSnapshot(page));
      }
      case 'fill': {
        const sel = String(params.selector || '').trim();
        if (!sel) return { error: 'fill needs a CSS selector.' };
        await withTimeout(page.fill(sel, String(params.text ?? ''), { timeout: 10000 }), 12000);
        return 'Filled "' + sel + '" with ' + String(params.text ?? '').length + ' chars.';
      }
      case 'press': {
        const key = String(params.key || '').trim();
        if (!key) return { error: 'press needs a key (e.g. Enter, Tab, Escape, Control+A).' };
        await page.keyboard.press(key);
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        return 'Pressed ' + key + '.\n' + (await pageSnapshot(page));
      }
      case 'text': {
        const body = await withTimeout(page.innerText('body').catch(() => ''), 10000);
        const text = String(body || '').replace(/\n{3,}/g, '\n\n').trim();
        const head = await pageSnapshot(page);
        return head + '\n\n' + (text ? text.slice(0, 10000) : '(page has no visible text — try action="eval" or action="links")');
      }
      case 'eval': {
        const script = String(params.script || '').trim();
        if (!script) return { error: 'eval needs a JavaScript expression (runs in the page context).' };
        // Function-body form keeps multi-statement scripts working.
        const result = await withTimeout(page.evaluate((src) => {
          try { return JSON.stringify({ ok: true, value: new Function('return (' + src + ')')() }); }
          catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
        }, script), 10000);
        const parsed = JSON.parse(String(result));
        if (!parsed.ok) return { error: 'eval failed: ' + parsed.error };
        const out = typeof parsed.value === 'string' ? parsed.value : JSON.stringify(parsed.value, null, 2);
        return String(out == null ? 'null' : out).slice(0, 10000);
      }
      case 'links': {
        const links = await withTimeout(
          page.$$eval('a[href]', (els) => els.slice(0, 100).map((a) => ({
            href: a.getAttribute('href') || '',
            text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
          }))),
          10000,
        );
        if (!links.length) return (await pageSnapshot(page)) + '\n\n(no links found)';
        return links.map((l, i) => (i + 1) + '. ' + l.text + ' — ' + l.href).join('\n').slice(0, 10000);
      }
      case 'screenshot': {
        const dest = params.path
          ? path.resolve(String(params.path))
          : path.join(os.tmpdir(), 'loom-browser-' + Date.now() + '.png');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await withTimeout(page.screenshot({ path: dest, fullPage: false }), 15000);
        return 'Screenshot saved: ' + dest + '\n' + (await pageSnapshot(page));
      }
      default:
        return { error: 'Unknown action "' + action + '".' };
    }
  } catch (err) {
    return { error: 'browser ' + action + ' failed: ' + (err && err.message || err) };
  }
}

// Test/diagnostic hook — true when a browser page is live.
function isRunning() {
  return !!( _engine && _engine.page && !_engine.page.isClosed() );
}

module.exports = { run, closeBrowser, isRunning, ACTIONS };
