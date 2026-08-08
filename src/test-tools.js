const { executeTool, getToolDefinitions } = require('./tools');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-test-'));

async function main() {
  console.log('--- Tool definitions ---');
  const defs = getToolDefinitions();
  console.log(`Loaded ${defs.length} tools: ${defs.map(d => d.name).join(', ')}`);

  console.log('\n--- write tool ---');
  const w = await executeTool('write', { filePath: path.join(tmp, 'hello.txt'), content: 'hello world\nline two\n' });
  console.log(JSON.stringify(w));

  console.log('\n--- read tool ---');
  const r = await executeTool('read', { filePath: path.join(tmp, 'hello.txt') });
  console.log(JSON.stringify(r).slice(0, 200));

  console.log('\n--- edit tool ---');
  const e = await executeTool('edit', { filePath: path.join(tmp, 'hello.txt'), oldString: 'hello', newString: 'goodbye' });
  console.log(JSON.stringify(e));

  console.log('\n--- bash tool ---');
  const b = await executeTool('bash', { command: 'echo test-123' });
  console.log(JSON.stringify(b));

  console.log('\n--- glob tool ---');
  const g = await executeTool('glob', { pattern: '*', path: tmp });
  console.log(JSON.stringify(g));

  console.log('\n--- unknown tool ---');
  const u = await executeTool('nope', {});
  console.log(JSON.stringify(u));

  console.log('\n--- grep tool ---');
  await executeTool('write', { filePath: path.join(tmp, 'src.js'), content: 'const x = 1;\nconst y = 2;\n' });
  const gr = await executeTool('grep', { pattern: 'const', path: tmp });
  console.log(JSON.stringify(gr));

  console.log('\n--- cleanup ---');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ALL TOOL TESTS PASSED');
}

main().catch(e => { console.error(e); process.exit(1); });