import test from "node:test";
import assert from "node:assert/strict";
import { createRouterClient, createRouterService, normalizeAnalytics, normalizeCallLogs, normalizeConnectionUsage, resolveRouterConfig, windowState } from "../src/omniroute.mjs";
import { CONN, TEST_KEY, startStubRouter, usageBodies } from "./fixtures.mjs";

const envFor = (port, extra = {}) => ({ OMNIROUTE_BASE_URL: `http://127.0.0.1:${port}`, OMNIROUTE_API_KEY: TEST_KEY, ...extra });

test("window state thresholds are applied to provider-reported percentages only", () => {
  assert.equal(windowState(0), "exhausted");
  assert.equal(windowState(4.9), "critical");
  assert.equal(windowState(20), "low");
  assert.equal(windowState(20.1), "ok");
  assert.equal(windowState(null), "unknown");
  assert.equal(windowState(null, true), "unlimited");
});

test("codex-style session/weekly windows: remaining is derived from provider used/total, not invented", () => {
  const q = normalizeConnectionUsage(usageBodies[CONN.codex]);
  assert.equal(q.support, "reported");
  const session = q.windows.find((w) => w.id === "session");
  assert.equal(session.remainingPct, 4);
  assert.equal(session.state, "critical");
  assert.equal(session.resetAt, "2030-01-01T05:00:00.000Z");
  assert.equal(q.windows.find((w) => w.id === "weekly").state, "ok");
  assert.equal(q.state, "critical");
  assert.equal(q.extras.paidCredits.hasCredits, false);
});

test("antigravity-style quota groups expose group windows and per-model limits separately", () => {
  const q = normalizeConnectionUsage(usageBodies[CONN.agy]);
  assert.equal(q.windows.length, 2);
  assert.equal(q.windows.find((w) => w.group === "claude_gpt").state, "exhausted");
  assert.equal(q.windows.find((w) => w.group === "gemini").state, "ok");
  assert.equal(q.perModel.length, 2);
  assert.equal(q.state, "exhausted");
});

test("missing or unusable quota data stays unknown instead of becoming 100% or 0%", () => {
  assert.equal(normalizeConnectionUsage(null).support, "unavailable");
  const none = normalizeConnectionUsage({ plan: "free", quotas: { odd: "string", other: {} } });
  assert.equal(none.support, "no-windows");
  assert.equal(none.state, "unknown");
  assert.deepEqual(none.windows, []);
});

test("currency balances keep their currency and are not presented as percentages of an allowance", () => {
  const q = normalizeConnectionUsage({ quotas: { available: { used: 0, total: 0, remaining: 0, remainingPercentage: 0, currency: "USD" } }, limitReached: true });
  assert.equal(q.windows[0].unit, "currency-balance");
  assert.equal(q.windows[0].currency, "USD");
  assert.equal(q.limitReached, true);
});

test("analytics separate router probes from workload and label cost as an estimate", () => {
  const a = normalizeAnalytics({ summary: { totalRequests: 10, successfulRequests: 7, totalCost: 2 }, byModel: [
    { model: "connection-test", provider: "x", requests: 4, cost: 0 }, { model: "real", provider: "x", requests: 6, cost: 2, lastUsed: "2030-01-01T00:00:00Z" }
  ], byProvider: [], dailyTrend: [] });
  assert.equal(a.summary.failedRequests, 3);
  assert.equal(a.summary.probeRequests, 4);
  assert.equal(a.summary.workloadRequests, 6);
  assert.equal(a.summary.estimatedCostUsd, 2);
  assert.deepEqual(a.recentModels.map((m) => m.model), ["real"]);
});

test("call-log sample counts rate-limit events, probes and redacts emails in errors", () => {
  const logs = normalizeCallLogs([
    { id: "1", status: 429, path: "/v1/chat/completions", model: "m", requestedModel: "auto", provider: "p", error: "limit for me@example.com" },
    { id: "2", status: 200, path: "/api/providers/test", model: "connection-test", provider: "p" }
  ]);
  assert.equal(logs.sample.rateLimited, 1);
  assert.equal(logs.sample.routerProbes, 1);
  assert.equal(logs.sample.workloadRequests, 1);
  assert.equal(logs.recent[0].rerouted, true);
  assert.doesNotMatch(JSON.stringify(logs), /me@example\.com/);
});

test("router base URL must be loopback unless explicitly allowed", () => {
  assert.equal(resolveRouterConfig({ OMNIROUTE_BASE_URL: "http://203.0.113.9:20128" }).valid, false);
  assert.equal(resolveRouterConfig({ OMNIROUTE_BASE_URL: "http://203.0.113.9:20128", ABUD_ALLOW_REMOTE_ROUTER: "1" }).valid, true);
  assert.equal(resolveRouterConfig({ OMNIROUTE_BASE_URL: "ftp://127.0.0.1" }).valid, false);
  assert.equal(resolveRouterConfig({}).baseUrl, "http://127.0.0.1:20128");
});

test("client refuses non-allowlisted endpoints and any non-loopback router without sending a request", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response("{}"); };
  const client = createRouterClient({ env: envFor(20128), fetchImpl });
  assert.equal((await client.get("/api/usage/budget")).code, "blocked");
  assert.equal((await client.get("/api/usage/history")).ok, true);
  assert.equal((await client.get("/api/settings/purge-request-history")).code, "blocked");
  const remote = createRouterClient({ env: { OMNIROUTE_BASE_URL: "http://203.0.113.9:1", OMNIROUTE_API_KEY: TEST_KEY }, fetchImpl });
  assert.equal((await remote.get("/api/health")).code, "misconfigured");
  assert.equal(calls, 1);
});

test("connection failure modes: offline, unauthorized, forbidden, timeout, invalid JSON", async () => {
  const mk = (impl) => createRouterClient({ env: envFor(1), fetchImpl: impl });
  assert.equal((await mk(async () => { throw Object.assign(new Error("refused"), { name: "TypeError" }); }).get("/api/health")).code, "offline");
  assert.equal((await mk(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }).get("/api/health")).code, "timeout");
  assert.equal((await mk(async () => new Response("{}", { status: 401 })).get("/api/providers")).code, "unauthorized");
  assert.equal((await mk(async () => new Response("{}", { status: 403 })).get("/api/providers")).code, "forbidden");
  assert.equal((await mk(async () => new Response("<html>", { status: 200 })).get("/api/providers")).code, "bad-response");
  assert.equal((await mk(async () => new Response(JSON.stringify({ error: "x" }), { status: 400 })).get("/api/providers")).code, "not-supported");
});

test("HTTP 429 honours Retry-After and blocks further calls to that endpoint until it elapses", async () => {
  let clock = 1_000_000;
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response("{}", { status: 429, headers: { "Retry-After": "60" } }); };
  const client = createRouterClient({ env: envFor(1), fetchImpl, now: () => clock });
  const first = await client.get("/api/providers");
  assert.equal(first.code, "rate-limited");
  assert.equal(first.retryAfterMs, 60_000);
  clock += 10_000;
  const second = await client.get("/api/providers");
  assert.equal(second.code, "rate-limited");
  assert.equal(second.retryAfterMs, 50_000);
  assert.equal(calls, 1, "no request is sent while Retry-After is in effect");
  clock += 51_000;
  await client.get("/api/providers");
  assert.equal(calls, 2);
});

test("overview against a stub router: connected, per-connection quota, no secrets, GET only", async () => {
  const stub = await startStubRouter();
  try {
    const service = createRouterService({ client: createRouterClient({ env: envFor(stub.port) }) });
    const overview = await service.overview();
    assert.equal(overview.connection.state, "connected");
    assert.equal(overview.connection.keyConfigured, true);
    assert.equal(overview.connections.length, 3);
    const codex = overview.connections.find((c) => c.provider === "codex");
    assert.equal(codex.quota.state, "critical");
    assert.equal(overview.connections.find((c) => c.provider === "nvidia").quota.support, "not-exposed");
    assert.ok(overview.warnings.some((w) => w.level === "exhausted" && w.provider === "agy"));
    assert.ok(overview.warnings.some((w) => w.level === "critical" && w.provider === "codex"));
    assert.equal(overview.lockouts[0].model, "claude-opus");
    assert.equal(overview.routingSettings.requestRetry, 3);
    assert.equal(overview.router.quotaMonitoring.unsupported, 3);
    const serialized = JSON.stringify(overview);
    for (const secret of [TEST_KEY, "SECRET-SHOULD-NOT-LEAK", "owner@example.com", "OIDC-SECRET"]) assert.ok(!serialized.includes(secret), `leaked ${secret}`);
    assert.ok(stub.hits.every((hit) => hit.method === "GET"));
  } finally { await stub.close(); }
});

test("overview reports unauthorized (health is public but data is not) and offline states truthfully", async () => {
  const stub = await startStubRouter({ mode: "no-auth" });
  try {
    const overview = await createRouterService({ client: createRouterClient({ env: envFor(stub.port) }) }).overview();
    assert.equal(overview.connection.state, "auth-required");
    assert.equal(overview.connections.length, 0);
  } finally { await stub.close(); }
  const offline = await createRouterService({ client: createRouterClient({ env: envFor(9) }) }).overview();
  assert.equal(offline.connection.state, "offline");
});

test("rate-limited quota fetch is surfaced as rate-limited, not as zero quota, and is not cached", async () => {
  const stub = await startStubRouter({ mode: "limited" });
  try {
    const overview = await createRouterService({ client: createRouterClient({ env: envFor(stub.port) }) }).overview();
    const codex = overview.connections.find((c) => c.provider === "codex");
    assert.equal(codex.quota.support, "rate-limited");
    assert.equal(codex.quota.state, "unknown");
    assert.equal(codex.quota.windows.length, 0);
  } finally { await stub.close(); }
});

test("usage collector returns analytics, live counters and cost basis; invalid ranges fall back to 7d", async () => {
  const stub = await startStubRouter();
  try {
    const service = createRouterService({ client: createRouterClient({ env: envFor(stub.port) }) });
    const usage = await service.usage({ range: "bogus" });
    assert.equal(usage.range, "7d");
    assert.equal(usage.costBasis, "router-estimated");
    assert.equal(usage.analytics.summary.requests, 100);
    assert.equal(usage.analytics.summary.probeRequests, 5);
    assert.equal(usage.live.requestsLast10Minutes, 3);
    assert.equal(usage.logs.sample.rateLimited, 1);
  } finally { await stub.close(); }
});
