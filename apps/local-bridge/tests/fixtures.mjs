/* Synthetic fixtures shaped like OmniRoute 3.8.52 responses. Test-only: never shown as production data. */
import { createServer } from "node:http";

export const TEST_KEY = "test-key-NOT-A-REAL-SECRET-0123456789";

export const CONN = {
  codex: "11111111-1111-4111-8111-111111111111",
  agy: "22222222-2222-4222-8222-222222222222",
  nvidia: "33333333-3333-4333-8333-333333333333"
};

export const usageBodies = {
  [CONN.codex]: {
    plan: "plus", limitReached: false,
    quotas: {
      session: { used: 96, total: 100, remaining: 4, resetAt: "2030-01-01T05:00:00.000Z", unlimited: false, windowSeconds: 18000 },
      weekly: { used: 49, total: 100, remaining: 51, resetAt: "2030-01-05T00:00:00.000Z", unlimited: false, windowSeconds: 604800 }
    },
    bankedResetCredits: 2, paidCredits: { hasCredits: false, unlimited: false, overageLimitReached: false, balance: 0 },
    speed: { avgTps: 100, medianTps: 90, avgTtftMs: 800, samples: 5 }
  },
  [CONN.agy]: {
    plan: "Pro",
    quotaGroups: [
      { id: "gemini", displayName: "Gemini Models", windows: { weekly: { used: 0, total: 1000, resetAt: "2030-01-02T00:00:00.000Z", remainingPercentage: 100, unlimited: false } }, models: ["gemini-flash"] },
      { id: "claude_gpt", displayName: "Claude & GPT Models", windows: { weekly: { used: 1000, total: 1000, resetAt: "2030-01-03T00:00:00.000Z", remainingPercentage: 0, unlimited: false } }, models: ["claude-opus"] }
    ],
    quotas: {
      "gemini-flash": { used: 0, total: 1000, resetAt: "2030-01-02T00:00:00.000Z", remainingPercentage: 100, unlimited: false },
      "claude-opus": { used: 1000, total: 1000, resetAt: "2030-01-03T00:00:00.000Z", remainingPercentage: 0, unlimited: false }
    }
  }
};

export const providers = {
  connections: [
    { id: CONN.codex, provider: "codex", authType: "oauth", isActive: true, testStatus: "active", priority: 1, backoffLevel: 0, lastTested: "2030-01-01T00:00:00Z", rateLimitProtection: false, providerSpecificData: { email: "owner@example.com", token: "SECRET-SHOULD-NOT-LEAK" } },
    { id: CONN.agy, provider: "agy", authType: "oauth", isActive: true, testStatus: "active", priority: 2, backoffLevel: 0 },
    { id: CONN.nvidia, provider: "nvidia", authType: "apikey", isActive: true, testStatus: "active", priority: 3, backoffLevel: 0 }
  ],
  total: 3
};

export const routerStatus = {
  gateway: "healthy",
  providers: { connections: providers.connections.map((c) => ({ id: c.id, provider: c.provider, active: true, health: "healthy", failureState: "none" })) },
  quotaMonitoring: { authoritative: 0, headerBased: 0, configured: 0, unsupported: 3, status: "unknown" },
  circuits: { open: 0, halfOpen: 0, closed: 3 }, pools: { count: 0, allocations: 0 }
};

export const analytics = {
  summary: { totalRequests: 100, promptTokens: 1000, completionTokens: 500, totalTokens: 1500, uniqueModels: 2, successfulRequests: 60, successRatePct: 60, avgLatencyMs: 1200, totalCost: 1.5, firstRequest: "2030-01-01T00:00:00Z", lastRequest: "2030-01-02T00:00:00Z", fallbackCount: 3, fallbackRatePct: 3 },
  dailyTrend: [{ date: "2030-01-01", requests: 40, promptTokens: 400, completionTokens: 200, cost: 0.5 }, { date: "2030-01-02", requests: 60, promptTokens: 600, completionTokens: 300, cost: 1 }],
  byProvider: [{ provider: "codex", requests: 70, promptTokens: 700, completionTokens: 350, successRatePct: "80.0", avgLatencyMs: 1000, cost: 1 }, { provider: "agy", requests: 30, promptTokens: 300, completionTokens: 150, successRatePct: "20.0", avgLatencyMs: 2000, cost: 0.5 }],
  byModel: [
    { model: "gpt-x", provider: "codex", rawModel: "gpt-x", requests: 70, promptTokens: 700, completionTokens: 350, avgLatencyMs: 1000, successRatePct: "80.0", lastUsed: "2030-01-02T00:00:00Z", cost: 1 },
    { model: "connection-test", provider: "agy", rawModel: "connection-test", requests: 5, promptTokens: 0, completionTokens: 0, avgLatencyMs: 10, successRatePct: "100.0", lastUsed: "2030-01-02T01:00:00Z", cost: 0 }
  ]
};

export const callLogs = [
  { id: "a", timestamp: "2030-01-02T00:00:00Z", method: "POST", path: "/v1/chat/completions", status: 429, model: "gpt-x", requestedModel: "auto", provider: "codex", duration: 100, tokens: { in: 1, out: 0 }, error: "rate limited for owner@example.com" },
  { id: "b", timestamp: "2030-01-02T00:00:01Z", method: "POST", path: "/api/providers/test", status: 200, model: "connection-test", provider: "agy", duration: 10, tokens: { in: 0, out: 0 } }
];

export const combos = { combos: [{ id: "c1", name: "dev", strategy: "priority", models: [{ model: "agy/claude-opus", providerId: "agy", weight: 0 }, { model: "codex/gpt-x", providerId: "codex", weight: 0 }] }] };
export const settingsBody = { comboStrategy: "fallback", requestRetry: 3, maxRetryIntervalSec: 30, oidcClientSecret: "OIDC-SECRET-SHOULD-NOT-LEAK", requireLogin: true };
export const models = { object: "list", data: [{ id: "codex/gpt-x", owned_by: "codex" }, { id: "agy/claude-opus", owned_by: "agy" }, { id: "agy/gemini-flash", owned_by: "agy" }] };

const FENCE = "```";
/** Default synthetic chat reply: echoes the model so tests can see which candidate was used. */
export const defaultChat = (model) => ({
  status: 200,
  body: { model, choices: [{ message: { role: "assistant", content: `رد تجريبي من ${model}\n\n${FENCE}json\n{"tasks":[{"title":"مهمة متابعة تجريبية","priority":"high"}]}\n${FENCE}` } }], usage: { prompt_tokens: 120, completion_tokens: 40 } },
  headers: { "x-omniroute-provider": model.split("/")[0], "x-omniroute-model": model.split("/").slice(1).join("/"), "x-omniroute-response-cost": "0.0012", "x-omniroute-selected-connection-id": "33333333-3333-4333-8333-333333333333" }
});

/** Starts a stub OmniRoute. `mode` can be "ok", "no-auth" (always 401), or "limited" (429 with Retry-After on usage).
 * `chat(model, body)` scripts /v1/chat/completions; PATCH /api/settings mutates this instance's settings only. */
export async function startStubRouter({ mode = "ok", chat = defaultChat } = {}) {
  const hits = [];
  const settings = { ...settingsBody };
  const chats = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    hits.push({ method: req.method, path: url.pathname });
    const json = (status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/api/health") return json(200, { status: "ok" });
    if (mode === "no-auth" || req.headers.authorization !== `Bearer ${TEST_KEY}`) return json(401, { error: { message: "unauthorized" } });
    if (mode === "limited" && url.pathname.startsWith("/api/usage/")) return json(429, { error: { message: "slow down" } }, { "Retry-After": "120" });
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      let raw = ""; req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => { const body = JSON.parse(raw); chats.push(body); const reply = chat(body.model, body); json(reply.status, reply.body, reply.headers || {}); });
      return;
    }
    if (req.method === "PATCH" && url.pathname === "/api/settings") {
      let raw = ""; req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => { Object.assign(settings, JSON.parse(raw)); json(200, { ok: true }); });
      return;
    }
    if (req.method !== "GET") return json(405, {});
    const id = url.pathname.match(/^\/api\/usage\/([0-9a-f-]{36})$/)?.[1];
    if (id) return usageBodies[id] ? json(200, usageBodies[id]) : json(400, { error: "quota not supported" });
    const routes = {
      "/api/providers": providers, "/api/omniroute/status": routerStatus, "/api/providers/health-matrix": { providers: [] }, "/api/providers/quota-windows": { windows: { codex: ["session", "weekly"] } },
      "/api/combos": combos, "/api/settings": settings, "/api/rate-limits": { lockouts: [{ provider: "agy", connectionId: CONN.agy, model: "claude-opus", reason: "rate_limit_exceeded", remainingMs: 60000, failureCount: 1 }] },
      "/api/monitoring/health": { status: "healthy", version: "9.9.9-test", uptime: 120 }, "/v1/models": models, "/api/usage/analytics": analytics,
      "/api/usage/call-logs": callLogs, "/api/usage/history": { activeRequests: [], last10Minutes: [{ requests: 2 }, { requests: 1 }] }
    };
    return routes[url.pathname] ? json(200, routes[url.pathname]) : json(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, hits, chats, settings, close: () => new Promise((resolve) => server.close(resolve)) };
}
