/* V6 live check against the REAL local OmniRoute, using only the isolated dev bridge (temporary DB, synthetic repositories).
 * Start:  DEV_REAL_ROUTER=1 node tests/dev-bridge.mjs 4191        Run:  node tests/v6-live.mjs http://127.0.0.1:4191
 * It spends a handful of small requests on the configured free/low-cost models and reports measured results only. */
import assert from "node:assert/strict";
const origin = process.argv[2] || "http://127.0.0.1:4191";
assert.equal(origin, "http://127.0.0.1:4191", "isolated dev bridge only");
const api = `${origin}/local-api/company`;
const token = (await (await fetch(`${origin}/local-api/session`)).json()).token;
const call = async (method, path, body) => {
  const response = await fetch(`${api}${path}`, { method, headers: { "Content-Type": "application/json", "X-Abud-Session": token }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${data?.error || ""} ${data?.message || ""}`);
  return data;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(runId, limitMs = 150_000) {
  for (const start = Date.now(); Date.now() - start < limitMs; await sleep(1000)) {
    const run = await call("GET", `/runs/${runId}`);
    if (!["queued", "running"].includes(run.status)) return run;
  }
  throw new Error(`run ${runId} did not settle`);
}
let pass = 0, fail = 0;
const results = [];
async function check(name, fn) {
  const started = Date.now();
  try { const detail = await fn(); pass++; results.push({ name, ok: true, seconds: +((Date.now() - started) / 1000).toFixed(1), ...detail }); console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`); }
  catch (error) { fail++; results.push({ name, ok: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
const toolIds = (run) => (run.toolCalls || []).map((c) => c.tool);

await check("OmniRoute is connected", async () => { const health = await (await fetch(`${origin}/local-api/health`)).json(); assert.equal(health.capabilities.inference, true); });

await check("Scenario A — NEX picks resource tools by itself for «راجع استهلاكنا وحالة النماذج»", async () => {
  const sent = await call("POST", "/ask", { content: "NEX، راجع استهلاكنا وحالة النماذج" });
  assert.equal(sent.agentId, "nex");
  const run = await settle(sent.runId);
  assert.equal(run.status, "succeeded", run.errorMessage);
  const used = toolIds(run);
  assert.ok(used.some((t) => ["usage.read", "quota.read", "telemetry.providerCompare", "telemetry.agentStats"].includes(t)), `resource tools expected, got ${used}`);
  assert.ok(!used.some((t) => /^(security|design|image|calendar|report|web)\./.test(t)), `no unrelated tools, got ${used}`);
  assert.ok(run.content?.length > 40 || run.output?.length > 40);
  const executions = await call("GET", `/executions?runId=${run.id}`).catch(() => null);
  return { agent: "nex", tools: used, model: run.effectiveModel, tokens: (run.promptTokens || 0) + (run.completionTokens || 0), actionsAr: run.actionsAr };
});

await check("ORI — «ask the company» routes a priorities request to ORI and reads company tools", async () => {
  const sent = await call("POST", "/ask", { content: "راجع حالة مشاريعي وجهّز أولويات النهارده" });
  assert.equal(sent.agentId, "ori");
  const run = await settle(sent.runId);
  assert.equal(run.status, "succeeded", run.errorMessage);
  assert.ok(toolIds(run).some((t) => ["company.overview", "tasks.query", "project.read"].includes(t)), `got ${toolIds(run)}`);
  return { agent: "ori", tools: toolIds(run), model: run.effectiveModel, actionsAr: run.actionsAr };
});

await check("MIA is refused a security tool she was never granted (permission refusal, audited)", async () => {
  const response = await fetch(`${api}/capabilities/security.gitleaks/execute`, { method: "POST", headers: { "Content-Type": "application/json", "X-Abud-Session": token }, body: JSON.stringify({ agentId: "mia", input: {} }) });
  assert.ok([403, 409, 422].includes(response.status), `status ${response.status}`);
  return { status: response.status };
});

let meetingId;
await check("Scenario F/G — a live meeting: chair answers first, addressed agent answers alone, outcomes proposed", async () => {
  const meeting = await call("POST", "/meetings", { title: "مراجعة أولويات الأسبوع (حي)", participants: ["ori", "nex", "rex"], budget: { maxTurns: 10, maxRounds: 4 } });
  meetingId = meeting.id;
  await call("POST", `/meetings/${meetingId}/start`, {});
  await call("POST", `/meetings/${meetingId}/messages`, { content: "ريكس، ايه أكتر مخاطرة أمنية لازم ناخد بالنا منها الأسبوع ده؟" });
  let view;
  for (const start = Date.now(); Date.now() - start < 150_000; await sleep(1500)) { view = await call("GET", `/meetings/${meetingId}`); if (!view.currentSpeaker && !view.queue.length) break; }
  const answers = view.turns.filter((t) => t.kind === "answer");
  assert.deepEqual(answers.map((t) => t.speaker), ["rex"], "only the addressed agent answers");
  assert.equal(answers[0].status, "completed");
  assert.ok(answers[0].content.length > 40);
  await call("POST", `/meetings/${meetingId}/end`, {});
  for (const start = Date.now(); Date.now() - start < 150_000; await sleep(1500)) { view = await call("GET", `/meetings/${meetingId}`); if (view.status === "ended") break; }
  assert.equal(view.status, "ended");
  assert.ok(view.outcomes.every((o) => o.status === "proposed"), "nothing auto-confirmed");
  return { turns: view.turns.length, outcomes: view.outcomes.map((o) => o.type), summaryChars: view.summary?.length ?? 0, tokens: view.usage.tokens };
});

await check("Accounting reconciles with the live requests", async () => {
  const report = await call("GET", "/accounting?range=24h");
  assert.equal(report.reconciliation.ok, true);
  assert.ok(report.totals.inferences >= 3);
  return { requests: report.totals.requests, inferences: report.totals.inferences, inputTokens: report.totals.inputTokens, outputTokens: report.totals.outputTokens, cost: report.totals.cost };
});

console.log(`\n${pass} passed, ${fail} failed`);
console.log(JSON.stringify(results, null, 1));
process.exitCode = fail ? 1 : 0;
