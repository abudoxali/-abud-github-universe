/* V5 capability HTTP surface and ORI's MCP bridge: session-guarded execution, artifact download headers, vendor bundles,
 * the in-memory MCP protocol and a real stdio MCP process against an isolated bridge. */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../src/server.mjs";
import { MCP_TOOLS, createMcpServer, mcpName, bridgeCaller } from "../src/mcp-server.mjs";

const REPO_ROOT = resolve(process.cwd(), "../..");

async function startBridge() {
  const dir = await mkdtemp(join(tmpdir(), "abud-capapi-"));
  await writeFile(join(dir, "worlds.json"), JSON.stringify({ githubOwner: "x", worlds: [] }));
  const server = createServer({ root: REPO_ROOT, configPath: join(dir, "worlds.json"), workspaceConfigPath: join(dir, "workspace.json"), policyPath: join(dir, "policy.json"), dbPath: ":memory:", vpsConfigPath: join(dir, "no-vps.json"), env: {}, agentOptions: { runImpl: async () => ({ ok: false, reason: "not-found" }), home: dir }, log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.company.syncProjects({ catalog: [{ name: "Alpha" }], owner: "owner", repos: [] });
  const port = server.address().port;
  const request = (path, { method = "GET", body, token } = {}) => new Promise((done, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", ...(token ? { "X-Abud-Session": token } : {}) } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => { const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString()); } catch (_) { /* binary */ } done({ status: res.statusCode, headers: res.headers, body: buf, json }); });
    });
    req.on("error", reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
  const token = (await request("/local-api/session")).json.token;
  return { server, port, request, token, close: async () => { await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); } };
}

test("capability API: registry, session-guarded execution, owner switch, audit and artifact download headers", async () => {
  const bridge = await startBridge();
  try {
    const { request, token } = bridge;
    const registry = (await request("/local-api/company/capabilities")).json.capabilities;
    assert.ok(registry.length >= 40);
    const pdfTool = registry.find((t) => t.id === "report.executionPdf");
    assert.equal(pdfTool.availability, "available");
    assert.deepEqual(pdfTool.grants.filter((g) => g.granted).map((g) => g.agentId), ["luna"]);
    assert.equal((await request("/local-api/company/capabilities/company.overview/execute", { method: "POST", body: { agentId: "ori" } })).status, 403, "writes need the session token");
    const run = await request("/local-api/company/capabilities/report.executionPdf/execute", { method: "POST", token, body: { agentId: "luna", input: { rangeDays: 7 } } });
    assert.equal(run.status, 200);
    assert.equal(run.json.execution.status, "succeeded");
    const artifactId = run.json.result.artifactIds[0];
    const file = await request(`/local-api/company/artifacts/${artifactId}/download`);
    assert.equal(file.status, 200);
    assert.equal(file.headers["content-type"], "application/pdf");
    assert.match(file.headers["content-disposition"], /^attachment;/);
    assert.match(file.headers["content-security-policy"], /sandbox/);
    assert.equal(file.headers["x-content-type-options"], "nosniff");
    assert.equal(file.body.subarray(0, 5).toString(), "%PDF-");
    const forbidden = await request("/local-api/company/capabilities/report.executionPdf/execute", { method: "POST", token, body: { agentId: "zen", input: {} } });
    assert.equal(forbidden.status, 403);
    assert.ok(forbidden.json.details.executionId, "a refusal still returns its audit id");
    assert.equal((await request("/local-api/company/capabilities/report.executionPdf", { method: "PATCH", token, body: { enabled: false, reason: "اختبار" } })).status, 200);
    assert.equal((await request("/local-api/company/capabilities/report.executionPdf/execute", { method: "POST", token, body: { agentId: "luna" } })).json.error, "capability-disabled");
    const executions = (await request("/local-api/company/executions?toolId=report.executionPdf")).json.executions;
    assert.deepEqual(executions.map((e) => e.status).sort(), ["denied", "denied", "succeeded"]);
    assert.equal((await request(`/local-api/company/artifacts/${artifactId}`, { method: "PATCH", token, body: { state: "approved" } })).json.state, "approved");
    const fabric = await request("/internal/vendor/fabric.min.js");
    assert.equal(fabric.status, 200);
    assert.match(fabric.headers["content-type"], /javascript/);
    assert.equal((await request("/internal/vendor/../package.json")).status, 404);
    assert.equal((await request("/internal/vendor/lodash.js")).status, 404);
    // templates: only safe image sources are accepted
    const bad = await request("/local-api/company/templates", { method: "POST", token, body: { name: "x", width: 800, height: 450, spec: { objects: [{ type: "image", src: "https://evil.example.com/a.png" }] } } });
    assert.equal(bad.json.error, "template-source");
    const good = await request("/local-api/company/templates", { method: "POST", token, body: { name: "إعلان", width: 800, height: 450, spec: { version: "7.4.0", objects: [{ type: "textbox", text: "مرحبًا" }] } } });
    assert.equal(good.status, 201);
  } finally { await bridge.close(); }
});

test("MCP: ORI exposes only read-only tools; the protocol round-trips results and validation errors", async () => {
  const calls = [];
  const server = createMcpServer({ call: async (toolId, input) => { calls.push([toolId, input]); if (toolId === "knowledge.search" && !input.q) throw Object.assign(new Error("q is required"), { code: "invalid-tool-input" }); return { ok: true, toolId }; } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), MCP_TOOLS.map(mcpName).sort());
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
    assert.ok(!tools.some((t) => /create|update|delete|propose|extract|gitleaks|osv/.test(t.name)), "no write or external capability is exposed");
    const result = await client.callTool({ name: "company_overview", arguments: {} });
    assert.equal(JSON.parse(result.content[0].text).toolId, "company.overview");
    const invalid = await client.callTool({ name: "approvals_list", arguments: { status: "everything" } });
    assert.equal(invalid.isError, true, "schema validation happens before any call");
    assert.equal(calls.filter(([id]) => id === "approvals.list").length, 0);
  } finally { await client.close(); }
  assert.throws(() => bridgeCaller({ base: "http://192.168.1.10:4172" }), /loopback/);
});

test("MCP: a real stdio MCP process reads company state through the bridge as an audited, read-only actor", async () => {
  const bridge = await startBridge();
  const client = new Client({ name: "test-stdio", version: "1.0.0" });
  try {
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("src/mcp-server.mjs")], env: { ...process.env, ABUD_BRIDGE_URL: `http://127.0.0.1:${bridge.port}` }, stderr: "pipe" });
    await client.connect(transport);
    const overview = await client.callTool({ name: "company_overview", arguments: {} });
    assert.ok(!overview.isError, overview.content?.[0]?.text);
    assert.equal(JSON.parse(overview.content[0].text).scope, "company");
    const audit = bridge.server.runtime.listExecutions({ toolId: "company.overview" })[0];
    assert.equal(audit.actorType, "mcp");
    assert.equal(audit.agentId, "ori");
    const blocked = await bridge.request("/local-api/company/mcp/tools/tasks.create", { method: "POST", token: bridge.token, body: { input: { title: "x" } } });
    assert.equal(blocked.json.error, "mcp-not-exposed");
  } finally { await client.close().catch(() => {}); await bridge.close(); }
});
