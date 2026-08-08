#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const localEnv = path.join(process.cwd(), '.env');
if (fs.existsSync(localEnv)) {
  require('dotenv').config({ path: localEnv, override: false });
}

const { main } = require('./core/cli');
const { updateCheck } = require('./core/update');
const { LoomError } = require('./core/errors');

process.title = 'loom-code';

process.on('uncaughtException', (err) => {
  if (err instanceof LoomError) {
    console.error(`\n[Loom Error] ${err.message}`);
    process.exit(1);
  }
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
  try {
    await updateCheck();
    await main();
  } catch (err) {
    console.error(err?.message || err);
    process.exit(1);
  }
})();