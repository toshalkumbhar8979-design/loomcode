// Unit tests for the LSP layer (src/core/lsp.js), including the
// verify-after-edit path used by write/edit.
process.env.LOOM_MEM_AUTO = "0";
import { test, expect, beforeEach, afterAll } from "bun:test";
import os from "os";
import fs from "fs";
import path from "path";

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-lsp-cfg-"));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-lsp-"));
process.env.LOOM_CONFIG_DIR = cfgDir;
const lsp = require("./lsp.js");

const fakeScript = String.raw`
const fs = require('fs');
let buf = Buffer.alloc(0);
function send(obj) {
  const body = JSON.stringify(obj);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
}
function diagsFor(text) {
  return text.indexOf('BAD') >= 0
    ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, source: 'fake', message: 'bad token' }]
    : [];
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const idx = buf.indexOf('\r\n\r\n');
    if (idx < 0) break;
    const header = buf.slice(0, idx).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) { buf = buf.slice(idx + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < idx + 4 + len) break;
    const body = buf.slice(idx + 4, idx + 4 + len).toString('utf8');
    buf = buf.slice(idx + 4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
    } else if (msg.method === 'textDocument/didOpen') {
      const td = msg.params.textDocument;
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: td.uri, version: td.version, diagnostics: diagsFor(td.text) } });
    } else if (msg.method === 'textDocument/didChange') {
      const td = msg.params.textDocument;
      const text = msg.params.contentChanges && msg.params.contentChanges[0] ? msg.params.contentChanges[0].text : '';
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: td.uri, version: td.version, diagnostics: diagsFor(text) } });
    }
  }
});
`;

const fakePath = path.join(tmpDir, "fake-lsp.js");
fs.writeFileSync(fakePath, fakeScript, "utf8");

function setConfig(obj) {
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify(obj), "utf8");
}

function enableFake() {
  const cfg = {};
  for (const id of Object.keys(lsp.DEFAULT_LSP)) cfg[id] = { disabled: true };
  cfg.fake = { command: ["node", fakePath], extensions: [".fake"] };
  setConfig({ lsp: cfg });
}

function tmpFile(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

beforeEach(() => {
  try { fs.rmSync(path.join(cfgDir, "config.json"), { force: true }); } catch {}
});

afterAll(() => {
  lsp.shutdownAll();
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env.LOOM_CONFIG_DIR;
});

test("lsp: disabled by default and autoVerify is a no-op", async () => {
  expect(lsp.findServerForExt(".fake").found).toBe(false);
  expect(await lsp.autoVerify(path.join(tmpDir, "none.fake"))).toBe("");
});

test("formatDiagnosticNote: clean marker, error/warning lines, caps", () => {
  expect(lsp.formatDiagnosticNote({ ok: true, fresh: true, id: "fake", diagnostics: [] })).toBe("\n[lsp fake: clean]");
  expect(lsp.formatDiagnosticNote({ ok: true, fresh: false, id: "fake", diagnostics: [] })).toBe("");
  const note = lsp.formatDiagnosticNote({
    ok: true,
    fresh: true,
    id: "fake",
    diagnostics: [
      { severity: "error", line: 2, character: 4, source: "ts", message: "boom" },
      { severity: "warning", line: 3, character: 1, source: "ts", message: "hmm" },
    ],
  });
  expect(note).toContain("[lsp fake: 1 error(s), 1 warning(s)]");
  expect(note).toContain("E 3:5 [ts] boom");
  expect(note).toContain("W 4:2 [ts] hmm");
  const many = Array.from({ length: 20 }, (_, i) => ({ severity: "error", line: i, character: 0, source: "x", message: "m" }));
  const capped = lsp.formatDiagnosticNote({ ok: true, fresh: true, id: "fake", diagnostics: many });
  expect(capped).toContain("... 10 more");
});

test("checkFile: opens, publishes diagnostics, and refreshes after didChange", async () => {
  enableFake();
  const p = tmpFile("check.fake", "ok");
  const first = await lsp.checkFile(p, { timeoutMs: 2000 });
  expect(first.ok).toBe(true);
  expect(first.id).toBe("fake");
  expect(first.fresh).toBe(true);
  expect(first.diagnostics).toHaveLength(0);

  fs.writeFileSync(p, "BAD", "utf8");
  const second = await lsp.checkFile(p, { timeoutMs: 2000 });
  expect(second.ok).toBe(true);
  expect(second.fresh).toBe(true);
  expect(second.diagnostics).toHaveLength(1);
  expect(second.diagnostics[0].message).toBe("bad token");
  expect(second.diagnostics[0].severity).toBe("error");
  expect(second.diagnostics[0].line).toBe(0);
  expect(second.diagnostics[0].character).toBe(0);
});

test("autoVerify: appends errors and then a clean marker", async () => {
  enableFake();
  const p = tmpFile("auto.fake", "BAD");
  const note = await lsp.autoVerify(p);
  expect(note).toContain("[lsp fake: 1 error(s), 0 warning(s)]");
  expect(note).toContain("E 1:1 [fake] bad token");

  fs.writeFileSync(p, "ok", "utf8");
  expect(await lsp.autoVerify(p)).toBe("\n[lsp fake: clean]");
});
