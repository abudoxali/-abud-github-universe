/* OmniRoute adapter: read-only, loopback-only, allowlisted GET requests against the installed router's documented API.
 * Verified against OmniRoute 3.8.52 (bundled docs/openapi.yaml and bin/cli commands). Every normalizer is pure so it can be
 * tested with synthetic fixtures; only collect* functions perform network I/O. Secrets never leave this module. */
import { finite, iso, redact, text, mapLimit, createTtlCache, provenance } from "./util.mjs";

export const DEFAULT_BASE_URL = "http://127.0.0.1:20128";
export const RANGES = ["1d", "7d", "30d", "90d", "all"];
export const DEFAULT_THRESHOLDS = { warnPercent: 20, criticalPercent: 5 };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const ID = "(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{6,80}"; // must contain a digit so /api/usage/budget|history|logs stay unreachable
const ALLOWED_GET = [
  /^\/api\/health$/, /^\/api\/monitoring\/health$/, /^\/api\/omniroute\/status$/, /^\/api\/providers$/,
  /^\/api\/providers\/health-matrix$/, /^\/api\/providers\/quota-windows$/, /^\/api\/usage\/analytics$/,
  /^\/api\/usage\/call-logs$/, /^\/api\/usage\/history$/, new RegExp(`^/api/usage/${ID}$`), /^\/api\/combos$/, /^\/api\/settings$/,
  /^\/api\/rate-limits$/, /^\/api\/quota\/plans$/, /^\/v1\/models$/
];
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function resolveRouterConfig(env = process.env) {
  const raw = String(env.OMNIROUTE_BASE_URL || DEFAULT_BASE_URL).trim();
  let url;
  try { url = new URL(raw); } catch (_) { return { valid: false, error: "invalid-base-url", keyConfigured: Boolean(env.OMNIROUTE_API_KEY) }; }
  if (!["http:", "https:"].includes(url.protocol)) return { valid: false, error: "invalid-base-url", keyConfigured: Boolean(env.OMNIROUTE_API_KEY) };
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (!loopback && env.ABUD_ALLOW_REMOTE_ROUTER !== "1") {
    return { valid: false, error: "non-loopback-router-refused", keyConfigured: Boolean(env.OMNIROUTE_API_KEY) };
  }
  return {
    valid: true,
    baseUrl: `${url.protocol}//${url.host}`,
    host: url.host,
    loopback,
    keyConfigured: Boolean(env.OMNIROUTE_API_KEY),
    apiKey: env.OMNIROUTE_API_KEY || ""
  };
}

const errorMessage = (body) => {
  const raw = body?.error?.message ?? body?.error ?? body?.message;
  return typeof raw === "string" ? redact(raw, 160) : null;
};

/** Default per-phase inference limits (ms). The company settings may override them within CHAT_TIMEOUT_BOUNDS. */
export const CHAT_TIMEOUTS = Object.freeze({ connectMs: 5_000, headersMs: 30_000, firstTokenMs: 25_000, idleMs: 30_000, totalMs: 90_000 });
export const CHAT_TIMEOUT_BOUNDS = Object.freeze({ connectMs: [1_000, 20_000], headersMs: [5_000, 120_000], firstTokenMs: [5_000, 120_000], idleMs: [5_000, 120_000], totalMs: [20_000, 300_000] });

export function boundedChatTimeouts(input = {}) {
  return Object.fromEntries(Object.entries(CHAT_TIMEOUTS).map(([key, fallback]) => {
    const [min, max] = CHAT_TIMEOUT_BOUNDS[key];
    const value = input?.[key];
    return [key, Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback];
  }));
}

/** Reads an OpenAI-style SSE stream into the non-streaming response shape ({model, choices:[{message}], usage}).
 * `onChunk(chars)` fires for every chunk that carries content or reasoning, so callers can time the first token and
 * detect stalls. Throws "too-large" past MAX_BODY_BYTES and "invalid-stream" for unparseable events. */
async function readEventStream(response, { onChunk, onActivity, signal }) {
  const reader = response.body.getReader();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "", frame = [], size = 0, content = "", usage = null, model = null, finish = null, completed = false, eventCount = 0;
  const dispatch = () => {
    const data = frame.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    frame = [];
    if (!data) return;
    if (data === "[DONE]") { completed = true; return; }
    if (completed) throw new Error("invalid-stream");
    let event;
    try { event = JSON.parse(data); } catch (_) { throw new Error("invalid-stream"); }
    eventCount++;
    onActivity?.();
    if (event.error) { const error = new Error("provider-error"); error.providerError = event.error; throw error; }
    if (event.model) model = event.model;
    if (event.usage) usage = event.usage;
    const choice = event.choices?.[0];
    const delta = choice?.delta ?? {};
    let piece = delta.content;
    if (Array.isArray(piece)) piece = piece.map((part) => part?.text ?? "").join("");
    if (typeof piece === "string" && piece) { content += piece; onChunk?.(content.length); }
    // Some compatible routers send a final complete message after deltas. Treat it as a snapshot.
    const snapshot = choice?.message?.content;
    if (typeof snapshot === "string" && snapshot !== content) {
      if (!content || snapshot.startsWith(content)) { content = snapshot; onChunk?.(content.length); }
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("too-large");
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).replace(/\r$/, ""); buffer = buffer.slice(cut + 1);
        if (line === "") dispatch(); else if (!line.startsWith(":")) frame.push(line);
      }
    }
    buffer += decoder.decode();
    if (buffer) frame.push(buffer.replace(/\r$/, ""));
    if (frame.length) dispatch();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (!completed || !eventCount || !content) throw new Error("incomplete-stream");
  return { model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], usage: usage ?? undefined };
}

function parseRetryAfter(value, now) {
  if (!value) return 30_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 1), 3600) * 1000;
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.min(Math.max(when - now(), 1000), 3600_000) : 30_000;
}

/** Creates the HTTP client. get() never throws and always resolves to {ok, code, status, data}. */
export function createRouterClient({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 12_000 } = {}) {
  const config = resolveRouterConfig(env);
  const backoff = new Map();
  async function get(path, query) {
    if (!config.valid) return { ok: false, code: "misconfigured", message: config.error };
    if (!ALLOWED_GET.some((pattern) => pattern.test(path))) return { ok: false, code: "blocked", message: "endpoint-not-allowlisted" };
    const until = backoff.get(path) ?? 0;
    if (until > now()) return { ok: false, code: "rate-limited", status: 429, retryAfterMs: until - now(), message: "waiting-for-retry-after" };
    const url = new URL(path, config.baseUrl);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual"
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      return { ok: false, code: timedOut ? "timeout" : "offline", message: timedOut ? "request-timeout" : "router-unreachable" };
    }
    let body = null;
    try {
      const raw = await response.text();
      if (raw.length > MAX_BODY_BYTES) return { ok: false, code: "bad-response", status: response.status, message: "response-too-large" };
      body = raw ? JSON.parse(raw) : null;
    } catch (_) {
      if (response.ok) return { ok: false, code: "bad-response", status: response.status, message: "invalid-json" };
    }
    if (response.ok) return { ok: true, status: response.status, data: body };
    const message = errorMessage(body);
    if (response.status === 401) return { ok: false, code: "unauthorized", status: 401, message };
    if (response.status === 403) return { ok: false, code: "forbidden", status: 403, message };
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers?.get?.("retry-after"), now);
      backoff.set(path, now() + retryAfterMs);
      return { ok: false, code: "rate-limited", status: 429, retryAfterMs, message };
    }
    if (response.status === 400) return { ok: false, code: "not-supported", status: 400, message };
    return { ok: false, code: "http-error", status: response.status, message };
  }

  /** Inference through the router's OpenAI-compatible endpoint. The only POST target this client can reach.
   * Streams (SSE) so each phase has its own bounded timeout and the failure says where it happened:
   *   connect-timeout   the router's local health endpoint did not answer within `connectMs`;
   *   headers-timeout   a healthy local router did not return inference response headers within `headersMs`;
   *   first-output-timeout the response began but no useful assistant content arrived within `firstTokenMs`;
   *   stalled           tokens stopped for `idleMs` mid-generation;
   *   timeout           the whole attempt exceeded `totalMs`.
   * A non-SSE reply (errors, or a router that ignores `stream`) is parsed as JSON exactly as before. Never throws; resolves
   * to {ok, code, status, data, meta}; `data` always has the non-streaming shape and meta.timing carries per-phase times. */
  async function chat({ model, messages, maxTokens, temperature, signal, timeouts = {}, onProgress = null }) {
    if (!config.valid) return { ok: false, code: "misconfigured", message: config.error };
    const limits = boundedChatTimeouts(timeouts);
    const path = "/v1/chat/completions";
    const until = backoff.get(`${path}:${model}`) ?? 0;
    if (until > now()) return { ok: false, code: "rate-limited", status: 429, retryAfterMs: until - now(), message: "waiting-for-retry-after" };
    const started = now();
    const timing = { phase: "connecting", connectedMs: null, headersMs: null, firstTokenMs: null, totalMs: null };
    const controller = new AbortController();
    let reason = null;
    let phaseTimer = null;
    const stop = (why) => { if (!reason) { reason = why; controller.abort(); } };
    const arm = (why, ms) => { clearTimeout(phaseTimer); phaseTimer = setTimeout(() => stop(why), ms); };
    const totalTimer = setTimeout(() => stop("timeout"), limits.totalMs);
    const onOuter = () => stop("cancelled");
    if (signal?.aborted) stop("cancelled"); else signal?.addEventListener("abort", onOuter, { once: true });
    const done = () => { clearTimeout(phaseTimer); clearTimeout(totalTimer); signal?.removeEventListener?.("abort", onOuter); timing.totalMs = now() - started; };
    const failed = (meta, fallback = "offline") => {
      done();
      const code = reason === "cancelled" ? "cancelled" : reason ?? fallback;
      const message = { cancelled: "cancelled-by-owner", "connect-timeout": "router-did-not-answer", "headers-timeout": "inference-headers-not-received", "first-output-timeout": "no-assistant-output", stalled: "generation-stalled", timeout: "attempt-time-limit", offline: "router-unreachable" }[code];
      return { ok: false, code, message, meta: { ...(meta ?? {}), latencyMs: timing.totalMs, timing } };
    };
    // A separate loopback probe distinguishes local availability from time spent inside the router/provider.
    arm("connect-timeout", limits.connectMs);
    try {
      const health = await fetchImpl(new URL("/api/health", config.baseUrl), { method: "GET", signal: controller.signal, redirect: "manual" });
      await health.body?.cancel?.().catch?.(() => {});
      if (!health.ok) { done(); return { ok: false, code: health.status === 401 ? "unauthorized" : "offline", status: health.status, meta: { latencyMs: timing.totalMs, timing } }; }
      timing.connectedMs = now() - started;
    } catch (_) { return failed(null); }
    if (reason) return failed(null);
    timing.phase = "waiting-headers";
    arm("headers-timeout", limits.headersMs);
    onProgress?.({ phase: "connecting", elapsedMs: timing.connectedMs, chars: 0 });
    const postStarted = now();
    let response;
    try {
      response = await fetchImpl(new URL(path, config.baseUrl), {
        method: "POST",
        headers: { Accept: "text/event-stream, application/json", "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: true, stream_options: { include_usage: true } }),
        signal: controller.signal,
        redirect: "manual"
      });
    } catch (_) {
      return failed(null);
    }
    if (reason) return failed(null);
    timing.headersMs = now() - postStarted;
    timing.phase = "waiting-first-token";
    arm("first-output-timeout", limits.firstTokenMs);
    onProgress?.({ phase: timing.phase, elapsedMs: timing.headersMs, chars: 0 });
    const header = (name) => response.headers?.get?.(name) ?? null;
    const meta = {
      latencyMs: null, transport: response.ok && /text\/event-stream/i.test(header("content-type") || "") ? "sse" : "json",
      provider: text(header("x-omniroute-provider"), 40) || null, model: text(header("x-omniroute-model"), 100) || null,
      connectionId: text(header("x-omniroute-selected-connection-id"), 80) || null, decision: text(header("x-omniroute-decision"), 160) || null,
      costUsd: finite(Number.parseFloat(header("x-omniroute-response-cost"))), routerVersion: text(header("x-omniroute-version"), 20) || null,
      requestId: text(header("x-omniroute-request-id"), 60) || null, timing
    };
    let body = null;
    if (response.ok && /text\/event-stream/i.test(header("content-type") || "")) {
      try {
        body = await readEventStream(response, { signal: controller.signal,
          onActivity: () => { if (timing.firstTokenMs != null) arm("stalled", limits.idleMs); },
          onChunk: (chars) => {
            if (timing.firstTokenMs == null) { timing.firstTokenMs = now() - postStarted; timing.phase = "generating"; }
            arm("stalled", limits.idleMs);
            onProgress?.({ phase: timing.phase, elapsedMs: now() - started, chars });
          }
        });
      } catch (error) {
        if (reason) return failed(meta);
        done();
        return { ok: false, code: error?.providerError ? "provider-unavailable" : "bad-response", status: response.status, message: error?.providerError ? errorMessage({ error: error.providerError }) : error?.message === "too-large" ? "response-too-large" : error?.message === "incomplete-stream" ? "incomplete-stream" : "invalid-stream", meta: { ...meta, latencyMs: timing.totalMs } };
      }
      if (reason) return failed(meta);
      done();
      meta.latencyMs = timing.totalMs;
      return { ok: true, status: response.status, data: body, meta };
    }
    try {
      const raw = await response.text();
      if (raw.length > MAX_BODY_BYTES) { done(); return { ok: false, code: "bad-response", status: response.status, message: "response-too-large", meta: { ...meta, latencyMs: timing.totalMs } }; }
      body = raw ? JSON.parse(raw) : null;
    } catch (_) {
      if (reason) return failed(meta);
      done();
      return { ok: false, code: "bad-response", status: response.status, message: "invalid-json", meta: { ...meta, latencyMs: timing.totalMs } };
    }
    if (reason) return failed(meta);
    done();
    meta.latencyMs = timing.totalMs;
    if (response.ok && body?.choices?.[0]?.message?.content) timing.firstTokenMs = now() - postStarted;
    if (response.ok && body?.choices?.[0]?.message?.content) return { ok: true, status: response.status, data: body, meta };
    if (response.ok) return { ok: false, code: "bad-response", status: response.status, message: "empty-output", meta };
    const message = errorMessage(body);
    const errCode = typeof body?.error?.code === "string" ? body.error.code : null;
    if (response.status === 401) return { ok: false, code: "unauthorized", status: 401, message, meta };
    if (response.status === 403) return { ok: false, code: "forbidden", status: 403, message, meta };
    if (response.status === 404 || errCode === "model_not_found") return { ok: false, code: "unsupported-model", status: response.status, message, meta };
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers?.get?.("retry-after"), now);
      backoff.set(`${path}:${model}`, now() + retryAfterMs);
      return { ok: false, code: /quota|exhaust|insufficient/i.test(message || "") ? "quota-exhausted" : "rate-limited", status: 429, retryAfterMs, message, meta };
    }
    if (response.status === 413 || /context|too long|maximum.*tokens/i.test(message || "")) return { ok: false, code: "context-too-large", status: response.status, message, meta };
    if (response.status === 402) return { ok: false, code: "budget-exceeded", status: 402, message, meta };
    if (response.status >= 500) return { ok: false, code: "provider-unavailable", status: response.status, message, meta };
    return { ok: false, code: "http-error", status: response.status, message, meta };
  }

  /** Owner-approved settings change through OmniRoute's documented PATCH /api/settings. Disabled unless the bridge was
   * started with ABUD_ROUTER_WRITES=1; only reviewed keys can be sent. */
  async function patchSettings(patch) {
    if (!config.valid) return { ok: false, code: "misconfigured", message: config.error };
    if (env.ABUD_ROUTER_WRITES !== "1") return { ok: false, code: "writes-disabled", message: "router-writes-disabled" };
    const keys = Object.keys(patch || {});
    if (!keys.length || !keys.every((key) => ROUTER_WRITABLE_SETTINGS.includes(key))) return { ok: false, code: "blocked", message: "setting-not-allowlisted" };
    try {
      const response = await fetchImpl(new URL("/api/settings", config.baseUrl), {
        method: "PATCH",
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify(patch), signal: AbortSignal.timeout(timeoutMs), redirect: "manual"
      });
      let body = null;
      try { body = await response.json(); } catch (_) { body = null; }
      if (response.ok) return { ok: true, status: response.status };
      return { ok: false, code: response.status === 401 || response.status === 403 ? "forbidden" : "http-error", status: response.status, message: errorMessage(body) };
    } catch (error) {
      return { ok: false, code: error?.name === "TimeoutError" ? "timeout" : "offline", message: "router-unreachable" };
    }
  }

  return {
    get, chat, patchSettings,
    config: { valid: config.valid, error: config.error, host: config.host, loopback: config.loopback, keyConfigured: config.keyConfigured, writesEnabled: env.ABUD_ROUTER_WRITES === "1" }
  };
}

/** Router settings ABUD may propose changing (each needs explicit owner approval and is verified + reversible). */
export const ROUTER_WRITABLE_SETTINGS = ["requestRetry", "maxRetryIntervalSec", "comboStrategy"];

// ---------------------------------------------------------------- normalizers (pure)

export const STATE_RANK = { exhausted: 5, critical: 4, low: 3, ok: 2, unlimited: 1, unknown: 0 };

export function windowState(remainingPct, unlimited, thresholds = DEFAULT_THRESHOLDS) {
  if (unlimited) return "unlimited";
  if (remainingPct == null) return "unknown";
  if (remainingPct <= 0) return "exhausted";
  if (remainingPct <= thresholds.criticalPercent) return "critical";
  if (remainingPct <= thresholds.warnPercent) return "low";
  return "ok";
}

function normalizeWindow(id, label, raw, thresholds, extra = {}) {
  if (!raw || typeof raw !== "object") return null;
  const used = finite(raw.used);
  const total = finite(raw.total);
  const remaining = finite(raw.remaining) ?? (used != null && total != null ? Math.max(total - used, 0) : null);
  let remainingPct = finite(raw.remainingPercentage) ?? finite(raw.percentRemaining);
  if (remainingPct == null && total != null && total > 0 && (used != null || remaining != null)) {
    remainingPct = ((remaining ?? total - used) / total) * 100;
  }
  if (remainingPct != null) remainingPct = Math.min(Math.max(Math.round(remainingPct * 10) / 10, 0), 100);
  if (used == null && total == null && remainingPct == null && !raw.unlimited) return null;
  const unlimited = raw.unlimited === true;
  return {
    id, label, used, total, remaining, remainingPct,
    resetAt: iso(raw.resetAt), windowSeconds: finite(raw.windowSeconds), unlimited,
    currency: typeof raw.currency === "string" ? text(raw.currency, 8) : null,
    unit: typeof raw.currency === "string" ? "currency-balance" : total === 100 ? "percent-of-allowance" : "provider-units",
    quotaSource: typeof raw.quotaSource === "string" ? text(raw.quotaSource, 60) : null,
    state: windowState(remainingPct, unlimited, thresholds), ...extra
  };
}

const WINDOW_LABELS = { session: "Session", weekly: "Weekly", daily: "Daily", monthly: "Monthly", window_5h: "5-hour", window5h: "5-hour", window_weekly: "Weekly", window7d: "7-day", window_monthly: "Monthly" };
const labelOf = (key) => WINDOW_LABELS[key] || text(String(key).replace(/[_-]+/g, " "), 40);

/** Handles the three response shapes seen in OmniRoute 3.8.52 `/api/usage/{connectionId}`:
 *  1) quotas: {session|weekly: {used,total,...}}  2) quotaGroups[] + per-model quotas  3) generic quotas map. */
export function normalizeConnectionUsage(body, thresholds = DEFAULT_THRESHOLDS) {
  if (!body || typeof body !== "object") return { support: "unavailable", windows: [], perModel: [] };
  const windows = [];
  const perModel = [];
  if (Array.isArray(body.quotaGroups)) {
    for (const group of body.quotaGroups.slice(0, 12)) {
      const groupName = text(group?.displayName || group?.id, 60);
      for (const [key, raw] of Object.entries(group?.windows || {})) {
        const win = normalizeWindow(`${group.id}:${key}`, `${groupName} · ${labelOf(key)}`, raw, thresholds, {
          group: text(group.id, 40), groupName, models: (group.models || []).slice(0, 20).map((m) => text(m, 80))
        });
        if (win) windows.push(win);
      }
    }
    for (const [model, raw] of Object.entries(body.quotas || {}).slice(0, 80)) {
      const win = normalizeWindow(`model:${model}`, text(model, 80), raw, thresholds, { model: text(model, 80) });
      if (win) perModel.push(win);
    }
  } else {
    for (const [key, raw] of Object.entries(body.quotas || {}).slice(0, 20)) {
      const win = normalizeWindow(key, labelOf(key), raw, thresholds);
      if (win) windows.push(win);
    }
  }
  const worst = windows.reduce((state, win) => (STATE_RANK[win.state] > STATE_RANK[state] ? win.state : state), "unknown");
  const paid = body.paidCredits && typeof body.paidCredits === "object" ? {
    hasCredits: body.paidCredits.hasCredits === true, unlimited: body.paidCredits.unlimited === true,
    overageLimitReached: body.paidCredits.overageLimitReached === true, balance: finite(body.paidCredits.balance)
  } : null;
  const speed = body.speed && typeof body.speed === "object" ? {
    avgTps: finite(body.speed.avgTps), medianTps: finite(body.speed.medianTps), avgTtftMs: finite(body.speed.avgTtftMs), samples: finite(body.speed.samples)
  } : null;
  return {
    support: windows.length ? "reported" : "no-windows",
    plan: typeof body.plan === "string" ? text(body.plan, 60) : null,
    limitReached: body.limitReached === true || windows.some((win) => win.state === "exhausted" && !win.group),
    state: windows.length ? worst : "unknown",
    resetDate: iso(body.resetDate),
    windows, perModel,
    extras: { bankedResetCredits: finite(body.bankedResetCredits), paidCredits: paid, routerObservedSpeed: speed }
  };
}

const num = (value) => finite(value) ?? 0;

export function normalizeAnalytics(body) {
  if (!body || typeof body !== "object") return null;
  const s = body.summary || {};
  const byModel = (Array.isArray(body.byModel) ? body.byModel : []).map((m) => ({
    model: text(m.model, 100), provider: text(m.provider, 40), requests: num(m.requests),
    promptTokens: num(m.promptTokens), completionTokens: num(m.completionTokens),
    successRatePct: finite(Number.parseFloat(m.successRatePct)), avgLatencyMs: finite(m.avgLatencyMs),
    lastUsedAt: iso(m.lastUsed), estimatedCostUsd: finite(m.cost), routerProbe: m.model === "connection-test" || m.rawModel === "connection-test"
  })).sort((a, b) => b.requests - a.requests);
  const probeRequests = byModel.filter((m) => m.routerProbe).reduce((sum, m) => sum + m.requests, 0);
  const requests = num(s.totalRequests);
  return {
    summary: {
      requests, probeRequests, workloadRequests: Math.max(requests - probeRequests, 0),
      promptTokens: num(s.promptTokens), completionTokens: num(s.completionTokens), totalTokens: num(s.totalTokens),
      successfulRequests: num(s.successfulRequests), failedRequests: Math.max(requests - num(s.successfulRequests), 0),
      successRatePct: finite(s.successRatePct), avgLatencyMs: finite(s.avgLatencyMs), estimatedCostUsd: finite(s.totalCost),
      fallbackCount: num(s.fallbackCount), fallbackRatePct: finite(s.fallbackRatePct), uniqueModels: num(s.uniqueModels),
      firstRequestAt: iso(s.firstRequest), lastRequestAt: iso(s.lastRequest)
    },
    dailyTrend: (Array.isArray(body.dailyTrend) ? body.dailyTrend : []).slice(-120).map((d) => ({
      date: text(d.date, 10), requests: num(d.requests), promptTokens: num(d.promptTokens), completionTokens: num(d.completionTokens), estimatedCostUsd: finite(d.cost)
    })),
    byProvider: (Array.isArray(body.byProvider) ? body.byProvider : []).map((p) => ({
      provider: text(p.provider, 40), requests: num(p.requests), promptTokens: num(p.promptTokens), completionTokens: num(p.completionTokens),
      successRatePct: finite(Number.parseFloat(p.successRatePct)), avgLatencyMs: finite(p.avgLatencyMs), estimatedCostUsd: finite(p.cost)
    })).sort((a, b) => b.requests - a.requests),
    byModel: byModel.slice(0, 30),
    // Router-observed "recent model selections": most recently used non-probe models in the selected range.
    recentModels: byModel.filter((m) => !m.routerProbe && m.lastUsedAt).sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt)).slice(0, 12)
      .map((m) => ({ model: m.model, provider: m.provider, lastUsedAt: m.lastUsedAt, requests: m.requests }))
  };
}

export function normalizeLive(body) {
  if (!body || typeof body !== "object") return null;
  return {
    inFlightRequests: Array.isArray(body.activeRequests) ? body.activeRequests.length : null,
    requestsLast10Minutes: Array.isArray(body.last10Minutes) ? body.last10Minutes.reduce((sum, minute) => sum + num(minute?.requests), 0) : null
  };
}

const isProbeLog = (log) => log?.model === "connection-test" || /^\/api\/providers\/(?:test|[^/]+\/models)/.test(String(log?.path || ""));

export function normalizeCallLogs(list) {
  const rows = (Array.isArray(list) ? list : []).slice(0, 200).map((log) => {
    const tokens = log.tokens && typeof log.tokens === "object" ? { input: finite(log.tokens.in), output: finite(log.tokens.out) } : null;
    const requested = typeof log.requestedModel === "string" ? text(log.requestedModel, 100) : null;
    return {
      id: text(log.id, 60), at: iso(log.timestamp), status: finite(log.status), provider: text(log.provider, 40),
      model: text(log.model, 100), requestedModel: requested, rerouted: Boolean(requested && requested !== log.model),
      combo: typeof log.comboName === "string" ? text(log.comboName, 60) : null, durationMs: finite(log.duration), tokens,
      routerProbe: isProbeLog(log), error: typeof log.error === "string" ? redact(log.error, 120) : null
    };
  });
  const workload = rows.filter((row) => !row.routerProbe);
  const failed = (row) => row.status != null && row.status >= 400;
  return {
    sampleSize: rows.length,
    sample: {
      workloadRequests: workload.length, routerProbes: rows.length - workload.length,
      failures: workload.filter(failed).length, rateLimited: rows.filter((row) => row.status === 429).length,
      probeFailures: rows.filter((row) => row.routerProbe && failed(row)).length
    },
    recent: rows.slice(0, 60)
  };
}

export function normalizeCombos(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.combos) ? body.combos : [];
  return list.slice(0, 50).map((combo) => ({
    id: text(combo.id, 60), name: text(combo.name, 80), strategy: text(combo.strategy, 40), hidden: combo.isHidden === true,
    steps: (Array.isArray(combo.models) ? combo.models : []).slice(0, 30).map((step) =>
      typeof step === "string" ? { model: text(step, 100), providerId: null, weight: null }
        : { model: text(step.model, 100), providerId: text(step.providerId, 40) || null, weight: finite(step.weight) })
  }));
}

export function normalizeRoutingSettings(body) {
  if (!body || typeof body !== "object") return null;
  const pick = (key, type) => (typeof body[key] === type ? body[key] : null);
  return {
    comboStrategy: pick("comboStrategy", "string"), requestRetry: pick("requestRetry", "number"), maxRetryIntervalSec: pick("maxRetryIntervalSec", "number"),
    stickyRoundRobinLimit: pick("stickyRoundRobinLimit", "number"), disableSessionStickiness: pick("disableSessionStickiness", "boolean"),
    promptCacheAffinityEnabled: pick("promptCacheAffinityEnabled", "boolean"), connectionAwareExpansion: pick("connectionAwareExpansion", "boolean"),
    requireLogin: pick("requireLogin", "boolean"), mcpEnabled: pick("mcpEnabled", "boolean"), a2aEnabled: pick("a2aEnabled", "boolean")
  };
}

export function normalizeLockouts(list, at = Date.now()) {
  return (Array.isArray(list) ? list : []).slice(0, 50).map((l) => {
    const remainingMs = finite(l.remainingMs);
    return {
      provider: text(l.provider, 40), connectionId: text(l.connectionId, 12), model: text(l.model, 100), reason: redact(l.reason, 80),
      failureCount: finite(l.failureCount), lockedAt: iso(l.lockedAt), remainingMs,
      until: iso(l.until) ?? (remainingMs != null ? new Date(at + remainingMs).toISOString() : null)
    };
  });
}

export function normalizeModels(body) {
  const list = Array.isArray(body?.data) ? body.data : [];
  const byProvider = {};
  for (const model of list) {
    const owner = text(model?.owned_by || "unknown", 40);
    const bucket = (byProvider[owner] ||= { count: 0, ids: [] });
    bucket.count++;
    if (bucket.ids.length < 60) bucket.ids.push(text(model.id, 100));
  }
  return { total: list.length, byProvider };
}

function healthIndex(matrix) {
  const index = new Map();
  for (const provider of Array.isArray(matrix?.providers) ? matrix.providers : []) {
    for (const account of Array.isArray(provider.accounts) ? provider.accounts : []) {
      index.set(account.connectionId, { provider, account });
    }
  }
  return index;
}

export function normalizeConnections({ providers, status, matrix, thresholds }) {
  const statusById = new Map((status?.providers?.connections || []).map((c) => [c.id, c]));
  const matrixById = healthIndex(matrix);
  return (Array.isArray(providers?.connections) ? providers.connections : []).map((c) => {
    const st = statusById.get(c.id) || {};
    const { provider: mp, account: ma } = matrixById.get(c.id) || {};
    const warnings = [];
    if (c.isActive === false) warnings.push("inactive");
    if (c.testStatus && c.testStatus !== "active") warnings.push(`test-status:${text(c.testStatus, 30)}`);
    if (ma?.state && ma.state !== "healthy") warnings.push(`health:${text(ma.state, 30)}`);
    if (ma?.cooldownRemainingMs > 0) warnings.push("cooldown");
    if (ma?.lastErrorType) warnings.push(`last-error:${redact(ma.lastErrorType, 40)}`);
    return {
      id: text(c.id, 80), shortId: text(c.id, 8), provider: text(c.provider, 40), authType: text(c.authType, 30),
      active: c.isActive !== false, priority: finite(c.priority), testStatus: text(c.testStatus, 30) || null,
      lastTestedAt: iso(c.lastTested), lastHealthCheckAt: iso(c.lastHealthCheckAt), backoffLevel: finite(c.backoffLevel),
      rateLimitProtection: c.rateLimitProtection === true,
      routerHealth: text(st.health, 30) || null, failureState: text(st.failureState, 30) || null,
      health24h: mp ? {
        state: text(ma?.state || mp.state, 30), requests: finite(mp.requests), successRatePct: finite(mp.successRate), avgLatencyMs: finite(mp.avgLatencyMs),
        lastRequestAt: iso(mp.lastRequestAt), lastErrorAt: iso(mp.lastErrorAt), circuit: text(mp.circuitBreaker?.state, 20) || null,
        issueCount: finite(ma?.issueCount)
      } : null,
      warnings, quota: null
    };
  });
}

/** Builds low-quota / lockout / provider notifications from already-normalized data. Provider-reported figures only. */
export function buildWarnings({ connections, lockouts }) {
  const warnings = [];
  for (const conn of connections) {
    for (const win of conn.quota?.windows || []) {
      if (["exhausted", "critical", "low"].includes(win.state)) {
        warnings.push({ level: win.state, provider: conn.provider, connectionId: conn.shortId, window: win.label, remainingPct: win.remainingPct, resetAt: win.resetAt });
      }
    }
    if (conn.active && conn.warnings.some((w) => w.startsWith("health:") || w === "cooldown")) {
      warnings.push({ level: "provider-health", provider: conn.provider, connectionId: conn.shortId, detail: conn.warnings.join(", ") });
    }
  }
  for (const l of lockouts) warnings.push({ level: "lockout", provider: l.provider, model: l.model, reason: l.reason, resetAt: l.until });
  return warnings.sort((a, b) => ({ exhausted: 0, critical: 1, lockout: 2, low: 3, "provider-health": 4 }[a.level] ?? 9) - ({ exhausted: 0, critical: 1, lockout: 2, low: 3, "provider-health": 4 }[b.level] ?? 9));
}

// ---------------------------------------------------------------- collectors (network I/O)

const connectionFailure = (result, config) => ({
  state: result.code === "offline" ? "offline" : result.code === "unauthorized" ? "auth-required" : result.code === "forbidden" ? "forbidden"
    : result.code === "rate-limited" ? "rate-limited" : result.code === "timeout" ? "timeout" : result.code === "misconfigured" ? "misconfigured" : "error",
  httpStatus: result.status ?? null, message: result.message ?? null, retryAfterMs: result.retryAfterMs ?? null,
  baseHost: config.host ?? null, loopback: config.loopback ?? null, keyConfigured: config.keyConfigured
});

export function createRouterService({ client, now = Date.now, usageTtlMs = 60_000 } = {}) {
  const usageCache = createTtlCache(usageTtlMs, now);
  const modelsCache = createTtlCache(5 * 60_000, now);

  async function connectionUsage(conn, thresholds) {
    const cached = usageCache.get(conn.id);
    if (cached) return cached;
    const result = await client.get(`/api/usage/${conn.id}`);
    let quota;
    if (result.ok) {
      quota = { ...normalizeConnectionUsage(result.data, thresholds), fetchedAt: new Date(now()).toISOString() };
    } else if (result.code === "not-supported") {
      quota = { support: "not-exposed", windows: [], perModel: [], state: "unknown", message: result.message };
    } else {
      quota = { support: result.code === "rate-limited" ? "rate-limited" : "error", windows: [], perModel: [], state: "unknown", message: result.message, retryAfterMs: result.retryAfterMs ?? null };
      return quota; // transient failures are not cached
    }
    return usageCache.set(conn.id, quota);
  }

  async function overview({ thresholds = DEFAULT_THRESHOLDS } = {}) {
    const generatedAt = new Date(now()).toISOString();
    const config = client.config;
    const health = await client.get("/api/health");
    if (!health.ok) return { generatedAt, connection: connectionFailure(health, config), connections: [], lockouts: [], combos: [], warnings: [] };

    const [status, providers, matrix, windows, combos, settings, rateLimits, monitoring] = await Promise.all([
      client.get("/api/omniroute/status"), client.get("/api/providers"), client.get("/api/providers/health-matrix"),
      client.get("/api/providers/quota-windows"), client.get("/api/combos"), client.get("/api/settings"),
      client.get("/api/rate-limits"), client.get("/api/monitoring/health")
    ]);
    if (!providers.ok) {
      return { generatedAt, connection: { ...connectionFailure(providers, config), routerReachable: true }, connections: [], lockouts: [], combos: [], warnings: [] };
    }
    let models = modelsCache.get("models");
    if (!models) {
      const result = await client.get("/v1/models");
      if (result.ok) models = modelsCache.set("models", normalizeModels(result.data));
    }
    const connections = normalizeConnections({ providers: providers.data, status: status.data, matrix: matrix.ok ? matrix.data : null, thresholds });
    await mapLimit(connections, 3, async (conn) => { if (conn.active) conn.quota = await connectionUsage(conn, thresholds); });
    const lockouts = normalizeLockouts(rateLimits.ok ? rateLimits.data?.lockouts : monitoring.ok ? monitoring.data?.lockouts : [], now());
    const monitor = status.ok ? status.data : {};
    const sys = monitoring.ok ? monitoring.data : {};
    return {
      generatedAt,
      connection: { state: "connected", baseHost: config.host, loopback: config.loopback, keyConfigured: config.keyConfigured, httpStatus: 200 },
      router: {
        version: text(sys.version || sys.system?.version, 30) || null, uptimeSec: finite(sys.uptime), gateway: text(monitor.gateway || sys.status, 30) || null,
        circuits: monitor.circuits ? { open: monitor.circuits.open, halfOpen: monitor.circuits.halfOpen, closed: monitor.circuits.closed } : null,
        // The router's own statement about how many connections have authoritative quota monitoring (not ABUD's inference).
        quotaMonitoring: monitor.quotaMonitoring ? {
          authoritative: monitor.quotaMonitoring.authoritative, headerBased: monitor.quotaMonitoring.headerBased,
          configured: monitor.quotaMonitoring.configured, unsupported: monitor.quotaMonitoring.unsupported, status: text(monitor.quotaMonitoring.status, 30)
        } : null,
        quotaPools: monitor.pools ? { count: monitor.pools.count, allocations: monitor.pools.allocations } : null,
        quotaWindowCatalog: windows.ok ? Object.fromEntries(Object.entries(windows.data?.windows || {}).slice(0, 40).map(([k, v]) => [text(k, 40), Array.isArray(v) ? v.slice(0, 6).map((x) => text(x, 40)) : []])) : null
      },
      connections, lockouts,
      combos: combos.ok ? normalizeCombos(combos.data) : [],
      routingSettings: settings.ok ? normalizeRoutingSettings(settings.data) : null,
      models, thresholds,
      warnings: buildWarnings({ connections, lockouts }),
      provenance: [
        provenance("provider-reported", "OmniRoute /api/usage/{connectionId} (relays the provider's own quota response)", generatedAt),
        provenance("router-observed", "OmniRoute /api/providers, /api/providers/health-matrix, /api/rate-limits, /api/combos", generatedAt),
        provenance("router-statement", "OmniRoute /api/omniroute/status quotaMonitoring", generatedAt)
      ]
    };
  }

  async function usage({ range = "7d" } = {}) {
    const generatedAt = new Date(now()).toISOString();
    const safeRange = RANGES.includes(range) ? range : "7d";
    const health = await client.get("/api/health");
    if (!health.ok) return { generatedAt, range: safeRange, connection: connectionFailure(health, client.config) };
    const [analytics, logs, live] = await Promise.all([client.get("/api/usage/analytics", { range: safeRange }), client.get("/api/usage/call-logs", { limit: 100 }), client.get("/api/usage/history")]);
    if (!analytics.ok && !logs.ok) return { generatedAt, range: safeRange, connection: connectionFailure(analytics, client.config) };
    return {
      generatedAt, range: safeRange, connection: { state: "connected", baseHost: client.config.host },
      live: live.ok ? normalizeLive(live.data) : null,
      analytics: analytics.ok ? normalizeAnalytics(analytics.data) : null,
      analyticsError: analytics.ok ? null : { code: analytics.code, message: analytics.message ?? null },
      logs: logs.ok ? normalizeCallLogs(logs.data) : null,
      logsError: logs.ok ? null : { code: logs.code, message: logs.message ?? null },
      costBasis: "router-estimated",
      provenance: [
        provenance("router-observed", `OmniRoute /api/usage/analytics?range=${safeRange}`, generatedAt, { note: "Requests, tokens and cost are computed by the router from its own call log and pricing table; cost is an estimate, not a provider invoice." }),
        provenance("router-observed", "OmniRoute /api/usage/call-logs?limit=100", generatedAt, { note: "Latest-100 sample used for failures, rate-limit events and recent model selection." })
      ]
    };
  }

  return { overview, usage, clearCaches() { usageCache.clear(); modelsCache.clear(); } };
}
