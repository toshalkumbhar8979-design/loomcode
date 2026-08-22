#!/usr/bin/env node
// Loom Code — CLI entry point. Works with Node directly (runtime is plain JS).
require('dotenv').config();
const { main } = require('../src/core/cli');
const { updateCheck } = require('../src/core/update');
const { LoomError } = require('../src/core/errors');

process.title = 'loom-code';
process.on('uncaughtException', (err) => {
  if (err instanceof LoomError) { console.error(`\n[Loom Error] ${err.message}`); process.exit(1); }
  console.error(`\n[Unexpected Error] ${err.message}`);
  if (process.env.LOOM_DEBUG) console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(`\n[Unhandled Promise]`, reason);
  if (process.env.LOOM_DEBUG) console.error(reason?.stack);
  process.exit(1);
});
(async () => {
  const sub = process.argv.slice(2)[0];
  if (sub === 'acp') {
    // ACP subprocess mode: JSON-RPC over stdio for editor integration.
    require('../src/acp/acp-server').main();
    return;
  }
  if (sub === 'web') {
    // Browser interface: HTTP server on 127.0.0.1, opens the browser.
    require('../src/web/web-server').main();
    return;
  }
  if (sub === 'attach') {
    // Terminal client for a running `loom web` server.
    require('../src/web/attach').main();
    return;
  }
  try {
    await updateCheck();
    await main();
  } catch (err) {
    console.error(err?.message || err);
    process.exit(1);
  }
})();
