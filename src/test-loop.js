const fs = require('fs');
const os = require('os');
const path = require('path');

function makeFake(script) {
  let i = 0;
  return {
    chat: async () => {
      const step = script[i];
      if (i < script.length - 1) i++;
      return step;
    },
  };
}

function toolCallTool(id, name, input) {
  return { content: '', toolCalls: [{ id, name, input }] };
}

async function run() {
  const { Session } = require('./core/session');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-loop-'));

  // Simulate the FULL agent loop: model writes a file, then replies.
  // With native tool-calling: tool call → result → final text. No JSON parsing.
  const script = [
    toolCallTool('call_1', 'write', { filePath: tmp + '/demo.txt', content: 'demo content' }),
    toolCallTool('call_2', 'read', { filePath: tmp + '/demo.txt' }),
    toolCallTool('call_3', 'bash', { command: 'echo done' }),
    { content: 'File created, read back, and verified. Done.', toolCalls: [] },
  ];

  const s = new Session();
  const fake = makeFake(script);
  s.provider.providers['fake'] = fake;
  s.provider.active = { name: 'fake' };
  s.refresh = () => { s.config = s.config; };

  const events = [];
  const resp = await s.sendUserMessage('Create a file called demo.txt', {
    onTool: (name) => events.push('tool:' + name),
  });

  console.log('Final response:', JSON.stringify(resp));
  console.log('Events:', events.join(', '));
  console.log('File exists:', fs.existsSync(path.join(tmp, 'demo.txt')));
  console.log('File content:', fs.readFileSync(path.join(tmp, 'demo.txt'), 'utf8').trim());
  console.log('Session message count:', s.messages.length);

  const ok = resp.type === 'text' && resp.content === 'File created, read back, and verified. Done.' &&
             events.join(',') === 'tool:write,tool:read,tool:bash' &&
             fs.existsSync(path.join(tmp, 'demo.txt')) && s.messages.length >= 8;
  console.log(ok ? 'NATIVE TOOL LOOP TEST PASSED (3 tools)' : 'NATIVE TOOL LOOP TEST FAILED');
  fs.rmSync(tmp, { recursive: true, force: true });
}

run().catch(e => { console.error(e); process.exit(1); });