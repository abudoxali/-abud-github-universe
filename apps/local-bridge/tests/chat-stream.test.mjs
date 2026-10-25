import test from "node:test";
import assert from "node:assert/strict";
import { createRouterClient, boundedChatTimeouts } from "../src/omniroute.mjs";

const env = { OMNIROUTE_BASE_URL: "http://127.0.0.1:20128", OMNIROUTE_API_KEY: "test-only" };
const encoder = new TextEncoder();
const headers = { "content-type": "text/event-stream", "x-omniroute-provider": "gemini", "x-omniroute-selected-connection-id": "test-connection" };
function stream(chunks, { hold = false } = {}) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) { const chunk = chunks[index++]; controller.enqueue(chunk instanceof Uint8Array ? chunk : encoder.encode(chunk)); }
      else if (!hold) controller.close();
    }
  });
}
function client(reply) {
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname === "/api/health") return new Response("ok");
    return reply(url, options);
  };
  return createRouterClient({ env, fetchImpl });
}
const call = (router, extra = {}) => router.chat({ model: "gemini/flash", messages: [{ role: "user", content: "hello" }], maxTokens: 30, ...extra });

test("JSON inference keeps the existing return shape and observability", async () => {
  const router = client(() => new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 2 } }), { headers: { "content-type": "application/json" } }));
  const result = await call(router);
  assert.equal(result.ok, true);
  assert.equal(result.data.choices[0].message.content, "hello");
  assert.equal(result.meta.transport, "json");
  assert.ok(result.meta.timing.connectedMs != null && result.meta.timing.headersMs != null);
});

test("SSE handles split UTF-8 and frame boundaries, usage, snapshot without duplication and DONE", async () => {
  const events = [
    'data: {"model":"flash","choices":[{"delta":{"content":"مرحبا"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" 🌍"}}]}\n\n',
    'data: {"choices":[{"message":{"content":"مرحبا 🌍"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n',
    'data: [DONE]\n\n'
  ];
  const bytes = encoder.encode(events.join(""));
  const chunks = [bytes.slice(0, 13), bytes.slice(13, 60), bytes.slice(60, 67), bytes.slice(67)];
  const router = client(() => new Response(stream(chunks), { headers }));
  const phases = [];
  const result = await call(router, { onProgress: (event) => phases.push(event.phase) });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.choices[0].message.content, "مرحبا 🌍");
  assert.equal(result.meta.transport, "sse");
  assert.deepEqual(result.data.usage, { prompt_tokens: 3, completion_tokens: 4 });
  assert.ok(phases.includes("generating"));
});

test("SSE refuses incomplete output and returns structured provider errors", async () => {
  const incomplete = client(() => new Response(stream(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']), { headers }));
  const bad = await call(incomplete);
  assert.equal(bad.ok, false);
  assert.equal(bad.message, "incomplete-stream");
  const provider = client(() => new Response(stream(['data: {"error":{"message":"upstream offline"}}\n\n']), { headers }));
  const error = await call(provider);
  assert.equal(error.code, "provider-unavailable");
  assert.equal(error.message, "upstream offline");
});

test("auth denial, cancellation and bounded timeout settings", async () => {
  const denied = client(() => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401, headers: { "content-type": "application/json" } }));
  assert.equal((await call(denied)).code, "unauthorized");
  const controller = new AbortController();
  const waiting = client((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })));
  const request = call(waiting, { signal: controller.signal });
  controller.abort();
  assert.equal((await request).code, "cancelled");
  assert.equal(boundedChatTimeouts({ connectMs: -5, headersMs: 999999, idleMs: 12345 }).connectMs, 1000);
  assert.equal(boundedChatTimeouts({ headersMs: 999999 }).headersMs, 120000);
});

test("local connection timeout has a separate phase", async () => {
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  const router = createRouterClient({ env, fetchImpl });
  const result = await call(router, { timeouts: { connectMs: 1000 } });
  assert.equal(result.code, "connect-timeout");
  assert.equal(result.meta.timing.headersMs, null);
});

test("healthy router can time out while waiting for inference headers", async () => {
  const waiting = client((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })));
  const result = await call(waiting, { timeouts: { headersMs: 5000 } });
  assert.equal(result.code, "headers-timeout");
  assert.ok(result.meta.timing.connectedMs != null);
});

test("first useful output timeout differs from streaming inactivity", async () => {
  const hanging = () => new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(": heartbeat\n\n")); } });
  const router = client(() => new Response(hanging(), { headers }));
  const first = await call(router, { timeouts: { firstTokenMs: 5000 } });
  assert.equal(first.code, "first-output-timeout");
  const output = () => new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')); } });
  const stalled = await call(client(() => new Response(output(), { headers })), { timeouts: { idleMs: 5000 } });
  assert.equal(stalled.code, "stalled");
  assert.ok(stalled.meta.timing.firstTokenMs != null);
});

test("overall duration cap wins even when the header phase allows longer", async () => {
  const waiting = client((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })));
  const result = await call(waiting, { timeouts: { headersMs: 120000, totalMs: 20000 } });
  assert.equal(result.code, "timeout");
  assert.ok(result.meta.timing.totalMs >= 19500);
});

test("a completed stream with no visible text is a retryable empty output that keeps its token usage", async () => {
  const events = [
    'data: {"model":"flash","choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":1400,"completion_tokens":1600}}\n\n',
    "data: [DONE]\n\n"
  ];
  const router = client(() => new Response(stream(events), { headers }));
  const result = await call(router, { onText: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, "empty-output");
  assert.deepEqual([result.usage.prompt_tokens, result.usage.completion_tokens], [1400, 1600]);
});
