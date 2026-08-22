// Smoke tests for `loom web` (src/web/web-server.js) — network/config/auth/CORS
// paths that don't require a live model turn. Runs with: bun test src/web/web-
// server.test.js. Registered in package.json test:unit.
process.env.LOOM_MEM_AUTO = "0";
process.env.LOOM_MCP_NO_WARM = "1";
import { test, expect, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import * as web from "./web-server.js";

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-web-cfg-"));
fs.mkdirSync(path.join(cfgDir, "sessions"), { recursive: true });
process.env.LOOM_CONFIG_DIR = cfgDir;

const servers = [];
function start(opts = {}) {
  const r = web.listen({ port: 0, hostname: "127.0.0.1", cors: [], mdns: false, mdnsDomain: "loom", noOpen: true, ...opts });
  return r.then(({ server, port }) => { servers.push(server); return { server, port }; });
}
afterAll(() => { for (const s of servers) { try { s.close(); } catch {} } try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {} });

const base = (port, p = "") => `http://127.0.0.1:${port}${p}`;
const prevPassword = process.env.LOOM_SERVER_PASSWORD;
const prevUser = process.env.LOOM_SERVER_USERNAME;
afterAll(() => {
  if (prevPassword === undefined) delete process.env.LOOM_SERVER_PASSWORD; else process.env.LOOM_SERVER_PASSWORD = prevPassword;
  if (prevUser === undefined) delete process.env.LOOM_SERVER_USERNAME; else process.env.LOOM_SERVER_USERNAME = prevUser;
});

test("resolveOptions: --port, --hostname, --mdns, --cors", () => {
  const o = web.resolveOptions(["web", "--port", "4096", "--hostname", "0.0.0.0", "--cors", "https://a.com,https://b.com"]);
  expect(o.port).toBe(4096);
  expect(o.hostname).toBe("0.0.0.0");
  expect(o.cors).toContain("https://a.com");
  expect(o.cors).toContain("https://b.com");
  expect(o.mdns).toBe(false);
});

test("resolveOptions: --mdns forces hostname 0.0.0.0 and defaults domain", () => {
  const o = web.resolveOptions(["web", "--mdns"]);
  expect(o.mdns).toBe(true);
  expect(o.hostname).toBe("0.0.0.0");
  expect(o.mdnsDomain).toBe("loom");
});

test("resolveOptions: --mdns-domain implies mdns", () => {
  const o = web.resolveOptions(["web", "--mdns-domain", "proj.local"]);
  expect(o.mdns).toBe(true);
  expect(o.mdnsDomain).toBe("proj");
});

test("GET /api/health returns ok", async () => {
  const { port } = await start();
  const r = await fetch(base(port, "/api/health"));
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.ok).toBe(true);
});

test("GET / returns index.html", async () => {
  const { port } = await start();
  const r = await fetch(base(port, "/"));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type") || "").toContain("text/html");
  const html = await r.text();
  expect(html).toContain("<title>Loom Code</title>");
});

test("GET /api/sessions empty when dir has none", async () => {
  const { port } = await start();
  const r = await fetch(base(port, "/api/sessions"));
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.sessions).toEqual([]);
});

test("GET /api/sessions lists a seeded session", async () => {
  const sessDir = path.join(cfgDir, "sessions");
  for (const f of fs.readdirSync(sessDir)) fs.unlinkSync(path.join(sessDir, f));
  fs.writeFileSync(path.join(sessDir, "seed-test-xyz.json"), JSON.stringify({
    id: "seed-test-xyz", schemaVersion: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
    provider: "anthropic", model: "claude-x",
  }));
  const { port } = await start();
  const r = await fetch(base(port, "/api/sessions"));
  const j = await r.json();
  expect(j.sessions.length).toBeGreaterThanOrEqual(1);
  const row = j.sessions.find((s) => s.id === "seed-test-xyz");
  expect(row).toBeTruthy();
  expect(row.messageCount).toBe(2);
  expect(row.provider).toBe("anthropic");
});

test("admin/config endpoint returns provider metadata", async () => {
  const { port } = await start();
  const r = await fetch(base(port, "/api/config"));
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.authRequired).toBe(false);
  expect(j.version).toBe(require("../../package.json").version);
});

test("POST /api/sessions creates a new web session id", async () => {
  const { port } = await start();
  const r = await fetch(base(port, "/api/sessions"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "build" }) });
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.id).toMatch(/^web-/);
  expect(j.mode).toBe("build");
});

test("unknown /api route returns 404", async () => {
  const { port } = await start();
  const r = await fetch(base(port, "/api/no-such-thing"));
  expect(r.status).toBe(404);
});

// ── auth ──
test("auth disabled: /api/auth reports not required", async () => {
  const { port } = await start();
  const r = await fetch(base(port, "/api/auth"));
  const j = await r.json();
  expect(j.required).toBe(false);
});

test("auth enabled: protected endpoints 401, login sets cookie, then sessions ok", async () => {
  process.env.LOOM_SERVER_PASSWORD = "secret";
  process.env.LOOM_SERVER_USERNAME = "loom";
  const { port } = await start();

  const auth = await fetch(base(port, "/api/auth"));
  const authJ = await auth.json();
  expect(authJ.required).toBe(true);
  expect(authJ.username).toBe("loom");

  const nope = await fetch(base(port, "/api/sessions"));
  expect(nope.status).toBe(401);

  const bad = await fetch(base(port, "/api/auth"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "loom", password: "wrong" }) });
  expect(bad.status).toBe(401);

  const good = await fetch(base(port, "/api/auth"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "loom", password: "secret" }) });
  expect(good.status).toBe(200);
  const sc = good.headers.get("set-cookie") || "";
  const token = /loom_token=([^;\s]+)/.exec(sc)?.[1];
  expect(token).toBeTruthy();

  const ok = await fetch(base(port, "/api/sessions"), { headers: { Cookie: "loom_token=" + token } });
  expect(ok.status).toBe(200);
  const okJ = await ok.json();
  expect(Array.isArray(okJ.sessions)).toBe(true);

  delete process.env.LOOM_SERVER_PASSWORD;
  delete process.env.LOOM_SERVER_USERNAME;
});

// ── CORS ──
test("CORS: allowed origin gets Access-Control-Allow-Origin; OPTIONS preflight 204", async () => {
  const { port } = await start({ cors: ["https://example.com"] });
  const r = await fetch(base(port, "/api/health"), { headers: { Origin: "https://example.com" } });
  expect(r.headers.get("access-control-allow-origin")).toBe("https://example.com");

  const opt = await fetch(base(port, "/api/health"), { method: "OPTIONS", headers: { Origin: "https://example.com", "Access-Control-Request-Method": "GET" } });
  expect(opt.status).toBe(204);

  const other = await fetch(base(port, "/api/health"), { headers: { Origin: "https://evil.example" } });
  expect(other.headers.get("access-control-allow-origin")).toBeNull();
});

test("CORS: wildcard matches any origin", async () => {
  const { port } = await start({ cors: ["*"] });
  const r = await fetch(base(port, "/api/health"), { headers: { Origin: "https://anything.example" } });
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
});

// ── mDNS advertising (no network) ──
test("advertiseMdns returns null or an instance handle (does not throw)", () => {
  const handle = web.advertiseMdns({ mdnsDomain: "loom-test" }, 0, () => {});
  if (handle) { try { handle.instance.destroy(); } catch {} }
  expect(handle === null || handle && handle.svc).toBeTruthy();
});
