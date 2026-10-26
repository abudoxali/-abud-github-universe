import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, requestIsLocal } from "../src/server.mjs";
import { TEST_KEY, startStubRouter } from "./fixtures.mjs";

const REPO_ROOT = resolve(process.cwd(), "../..");

async function startBridge(env, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "abud-srv-"));
  await writeFile(join(dir, "worlds.json"), JSON.stringify({ githubOwner: "x", worlds: [] }));
  const server = createServer({ root: REPO_ROOT, configPath: join(dir, "worlds.json"), workspaceConfigPath: join(dir, "workspace.json"), policyPath: join(dir, "policy.json"), dbPath: options.dbPath || ":memory:", vpsConfigPath: join(dir, "no-vps.json"), env, agentOptions: { runImpl: async () => ({ ok: false, reason: "not-found" }), home: dir } });
  await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  return { port: server.address().port, server, close: () => new Promise((resolveClosed) => server.close(resolveClosed)) };
}

/** Raw request so that arbitrary Host / Origin / Sec-Fetch-Site headers can be sent. */
const raw = (port, path, headers = {}, method = "GET") => new Promise((resolveRaw, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
    let body = ""; res.on("data", (chunk) => (body += chunk)); res.on("end", () => resolveRaw({ status: res.statusCode, body, headers: res.headers }));
  });
  req.on("error", reject); req.end();
});

test("host/origin guard rejects DNS-rebinding hosts, foreign ports and cross-site fetches", () => {
  const req = (headers) => ({ headers });
  assert.equal(requestIsLocal(req({ host: "127.0.0.1:4170" }), 4170), true);
  assert.equal(requestIsLocal(req({ host: "localhost:4170" }), 4170), true);
  assert.equal(requestIsLocal(req({ host: "evil.example.com:4170" }), 4170), false);
  assert.equal(requestIsLocal(req({ host: "127.0.0.1:9999" }), 4170), false);
  assert.equal(requestIsLocal(req({ host: "127.0.0.1:4170", "sec-fetch-site": "cross-site" }), 4170), false);
  assert.equal(requestIsLocal(req({ host: "127.0.0.1:4170", origin: "https://evil.example.com" }), 4170), false);
  assert.equal(requestIsLocal(req({ host: "127.0.0.1:4170", origin: "http://127.0.0.1:4170", "sec-fetch-site": "same-origin" }), 4170), true);
});

test("bridge refuses rebinding hosts, cross-site requests and every non-GET method, including on static files", async () => {
  const bridge = await startBridge({});
  try {
    assert.equal((await raw(bridge.port, "/local-api/health", { Host: "attacker.example.com" })).status, 403);
    assert.equal((await raw(bridge.port, "/local-api/health", { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await raw(bridge.port, "/local-api/omniroute/overview", { Origin: "https://attacker.example.com" })).status, 403);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal((await raw(bridge.port, "/local-api/health", {}, method)).status, 405);
    const ok = await raw(bridge.port, "/local-api/health");
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).capabilities.company, true);
    assert.equal(ok.headers["cache-control"], "no-store");
    assert.equal(ok.headers["x-frame-options"], "DENY");
    assert.match(ok.headers["x-request-id"], /^[0-9a-f]{16}$/);
  } finally { await bridge.close(); }
});

test("registry admin reads include inactive profiles and catalog preserves their identities", async () => {
  const bridge = await startBridge({});
  try {
    bridge.server.company.registry.createFromTemplate({ templateId: "analyst", id: "archived-analyst", name: "Archived analyst", titleAr: "محلل", roleAr: "تحليل", summaryAr: "اختبار سجل الوكلاء", tools: [] });
    bridge.server.company.registry.deactivate("archived-analyst");
    const response = await raw(bridge.port, "/local-api/company/agent-registry");
    assert.equal(response.status, 200);
    const profile = JSON.parse(response.body).agents.find((agent) => agent.id === "archived-analyst");
    assert.equal(profile.active, false);
    assert.equal(profile.builtin, false);
    assert.deepEqual(profile.tools, []);
    const catalog = JSON.parse((await raw(bridge.port, "/local-api/company/catalog")).body);
    assert.ok(catalog.allAgents.some((agent) => agent.id === profile.id));
    assert.ok(!catalog.agents.some((agent) => agent.id === profile.id));
    assert.equal((await raw(bridge.port, "/local-api/company/agent-registry", { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await raw(bridge.port, "/local-api/company/agents/archived-analyst/activate", { "Content-Type": "application/json" }, "POST")).status, 403);
  } finally { await bridge.close(); }
});

test("internal UI assets are served only from the allowlisted internal directory", async () => {
  const bridge = await startBridge({});
  try {
    assert.equal((await raw(bridge.port, "/internal/ops-core.js")).status, 200);
    assert.equal((await raw(bridge.port, "/internal/os.css")).status, 200);
    const font = await raw(bridge.port, "/internal/assets/fonts/manrope-latin.woff2");
    assert.equal(font.status, 200, "bundled fonts are served locally");
    assert.equal(font.headers["content-type"], "font/woff2");
    assert.equal((await raw(bridge.port, "/internal/assets/fonts/OFL-manrope.txt")).status, 404, "only woff2 files are allowlisted");
    assert.equal((await raw(bridge.port, "/internal/assets/fonts/%2e%2e/%2e%2e/%2e%2e/local/company.db")).status, 404, "traversal out of the font directory is refused");
    const index = await raw(bridge.port, "/");
    assert.equal(index.status, 200);
    assert.ok(!/<link[^>]+fonts\.(googleapis|gstatic)\.com/.test(index.body), "the Company OS never loads fonts from a CDN");
    assert.match(index.body, /<html[^>]*class="os-booting"/, "boot guard prevents a flash of the public layout");
    assert.equal((await raw(bridge.port, "/internal/../local/worlds.json")).status, 404);
    assert.equal((await raw(bridge.port, "/internal/%2e%2e/STATUS.md")).status, 404);
    assert.equal((await raw(bridge.port, "/internal/nope.js")).status, 404);
    assert.equal((await raw(bridge.port, "/local/worlds.json")).status, 404);
    assert.equal((await raw(bridge.port, "/apps/local-bridge/src/server.mjs")).status, 404);
    assert.equal((await raw(bridge.port, "/local-api/unknown")).status, 404);
  } finally { await bridge.close(); }
});

test("full API against a stub router: structured data, correct states, and no secret ever reaches a response", async () => {
  const stub = await startStubRouter();
  const bridge = await startBridge({ OMNIROUTE_BASE_URL: `http://127.0.0.1:${stub.port}`, OMNIROUTE_API_KEY: TEST_KEY });
  try {
    const get = async (path) => JSON.parse((await raw(bridge.port, path)).body);
    const overview = await get("/local-api/omniroute/overview");
    assert.equal(overview.connection.state, "connected");
    assert.equal(overview.connections.length, 3);
    const usage = await get("/local-api/omniroute/usage?range=30d");
    assert.equal(usage.range, "30d");
    assert.equal((await get("/local-api/omniroute/usage?range=evil")).range, "7d");
    const agents = await get("/local-api/agents");
    assert.equal(agents.agents.length, 3);
    const policy = await get("/local-api/policy");
    assert.equal(policy.appliedToRouter, false);
    const settings = await get("/local-api/settings");
    assert.equal(settings.router.keyConfigured, true);
    assert.ok(settings.bridge.writeEndpoints > 0);
    assert.equal(settings.bridge.writeProtection, "session token + JSON + same-origin");
    const workspace = await get("/local-api/workspace");
    assert.equal(workspace.configured, false);
    const everything = JSON.stringify([overview, usage, agents, policy, settings, workspace]);
    for (const secret of [TEST_KEY, "OIDC-SECRET", "SECRET-SHOULD-NOT-LEAK", "owner@example.com"]) assert.ok(!everything.includes(secret), `response leaked ${secret}`);
    assert.ok(stub.hits.every((hit) => hit.method === "GET"));
  } finally { await bridge.close(); await stub.close(); }
});

test("conversation API persists queued messages and guards cross-thread event streams", async () => {
  const bridge = await startBridge({});
  try {
    const base = `http://127.0.0.1:${bridge.port}/local-api/company`;
    const token = JSON.parse((await raw(bridge.port, "/local-api/session")).body).token;
    const write = async (method, path, body) => {
      const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", "X-Abud-Session": token }, body: body == null ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    const made = await write("POST", "/conversations", { agentId: "ori", title: "اختبار محادثة" });
    assert.equal(made.status, 201);
    const id = made.data.id;
    const file = await write("POST", `/conversations/${id}/attachments`, { filename: "note.txt", data: Buffer.from("A small fact").toString("base64") });
    assert.equal(file.status, 201);
    assert.equal(file.data.readableByAgent, true);
    assert.equal((await fetch(`${base}/conversations/${id}/attachments/${file.data.id}`)).headers.get("content-disposition").startsWith("attachment;"), true);
    const sent = await write("POST", `/conversations/${id}/messages`, { content: "مرحبًا", idempotencyKey: "test-chat-001", attachmentIds: [file.data.id] });
    assert.equal(sent.status, 201);
    assert.equal(sent.data.run.conversationId, id);
    const detail = await (await fetch(`${base}/conversations/${id}`)).json();
    assert.deepEqual(detail.messages.map((m) => m.state), ["complete", "pending"]);
    assert.equal(detail.messages[0].attachments[0].filename, "note.txt");
    assert.equal((await write("POST", `/conversations/${id}/messages`, { content: "مرحبًا", idempotencyKey: "test-chat-001" })).data.deduplicated, true);
    const other = (await write("POST", "/conversations", { agentId: "zen" })).data;
    assert.equal((await fetch(`${base}/conversations/${other.id}/runs/${sent.data.run.id}/events`)).status, 404);
    assert.equal((await write("PATCH", `/conversations/${id}`, { projectId: "nonexistent" })).status, 409, "project scope is locked after a message");
    const controller = new AbortController();
    const stream = await fetch(`${base}/conversations/${id}/runs/${sent.data.run.id}/events`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.match(await stream.body.getReader().read().then((r) => new TextDecoder().decode(r.value)), /"type":"snapshot"/);
    controller.abort();
    assert.equal((await write("DELETE", `/conversations/${other.id}`)).data.state, "deleted");
    assert.equal((await fetch(`${base}/conversations/${other.id}`)).status, 404);
  } finally { await bridge.close(); }
});

test("conversation API survives a Bridge restart on the same private SQLite file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abud-chat-restart-"));
  const file = join(dir, "company.db");
  let bridge = await startBridge({}, { dbPath: file });
  try {
    const token = JSON.parse((await raw(bridge.port, "/local-api/session")).body).token;
    const post = async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${bridge.port}/local-api/company${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Abud-Session": token }, body: JSON.stringify(body) });
      assert.equal(response.status, 201);
      return response.json();
    };
    const thread = await post("/conversations", { agentId: "zen", title: "باقية بعد إعادة التشغيل" });
    const sent = await post(`/conversations/${thread.id}/messages`, { content: "احفظ هذه الرسالة", idempotencyKey: "restart-test-001" });
    await bridge.server.runtime.stop();
    await bridge.close();
    await new Promise((resolveTick) => setImmediate(resolveTick));
    bridge = await startBridge({}, { dbPath: file });
    const detail = JSON.parse((await raw(bridge.port, `/local-api/company/conversations/${thread.id}`)).body);
    assert.equal(detail.messages[0].content, "احفظ هذه الرسالة");
    assert.equal(detail.messages[1].runId, sent.run.id);
    assert.equal(bridge.server.company.db.raw.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});

test("bridge with an unreachable router still serves every endpoint with explicit offline state", async () => {
  const bridge = await startBridge({ OMNIROUTE_BASE_URL: "http://127.0.0.1:9", OMNIROUTE_API_KEY: TEST_KEY });
  try {
    const overview = JSON.parse((await raw(bridge.port, "/local-api/omniroute/overview")).body);
    assert.equal(overview.connection.state, "offline");
    const agents = JSON.parse((await raw(bridge.port, "/local-api/agents")).body);
    assert.ok(agents.agents.every((a) => a.quota.state === "unknown"));
  } finally { await bridge.close(); }
});

test("company writes require the session token, a JSON body and a same-origin request", async () => {
  const bridge = await startBridge({});
  try {
    const body = JSON.stringify({ title: "اختبار" });
    const json = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    const post = (headers) => new Promise((resolvePost, reject) => {
      const req = http.request({ host: "127.0.0.1", port: bridge.port, path: "/local-api/company/tasks", method: "POST", headers }, (res) => {
        let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => resolvePost({ status: res.statusCode, body: text }));
      });
      req.on("error", reject); req.end(body);
    });
    assert.equal((await post(json)).status, 403, "no session token");
    assert.equal((await post({ ...json, "X-Abud-Session": "x".repeat(64) })).status, 403, "wrong token");
    const token = JSON.parse((await raw(bridge.port, "/local-api/session")).body).token;
    assert.equal((await raw(bridge.port, "/local-api/session", { "Sec-Fetch-Site": "cross-site" })).status, 403, "token is not readable cross-site");
    assert.equal((await post({ ...json, "X-Abud-Session": token, "Sec-Fetch-Site": "cross-site" })).status, 403, "cross-site write");
    assert.equal((await post({ ...json, "X-Abud-Session": token, Origin: "https://attacker.example.com" })).status, 403, "foreign origin");
    assert.equal((await post({ "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body), "X-Abud-Session": token })).status, 415, "non-JSON body");
    const created = await post({ ...json, "X-Abud-Session": token });
    assert.equal(created.status, 201);
    assert.equal(JSON.parse(created.body).title, "اختبار");
    for (const method of ["PUT", "DELETE"]) assert.equal((await raw(bridge.port, "/local-api/company/tasks", { "X-Abud-Session": token }, method)).status, 405);
  } finally { await bridge.close(); }
});
