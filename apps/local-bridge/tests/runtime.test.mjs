import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.mjs";
import { createCompany } from "../src/company.mjs";
import { createRuntime, selectRoute, extractJson } from "../src/runtime.mjs";
import { createConversations } from "../src/conversations.mjs";
import { createRouterClient, createRouterService } from "../src/omniroute.mjs";
import { recommend } from "../src/nex.mjs";
import { CONN, TEST_KEY, defaultChat, startStubRouter } from "./fixtures.mjs";

const TERMINAL = new Set(["succeeded", "failed", "blocked", "cancelled"]);

async function setup({ chat, env = {}, patchOverview = (o) => o, dbPath = ":memory:" } = {}) {
  const stub = await startStubRouter(chat ? { chat } : {});
  const client = createRouterClient({ env: { OMNIROUTE_BASE_URL: `http://127.0.0.1:${stub.port}`, OMNIROUTE_API_KEY: TEST_KEY, ...env } });
  const service = createRouterService({ client });
  const company = createCompany({ db: openDatabase(dbPath) });
  company.seed();
  // Test policies point at the stub's providers: agy (restricted), codex (subscription), nvidia (api-free-tier).
  for (const p of company.listPolicies()) company.updatePolicy(p.domain, { candidates: ["agy/gemini-flash", "codex/gpt-x", "nvidia/model-a", "nvidia/model-b"], maxRetries: 2 });
  company.syncProjects({ catalog: [{ name: "Alpha" }], owner: "owner", repos: [{ rel: "Alpha", state: "ready", remote: { kind: "github", github: "owner/Alpha" } }] });
  let overviewCache = null;
  const repos = [{ rel: "Alpha", state: "ready", branch: "main", head: "abc", dirty: true, changedFiles: 2, untrackedFiles: 1, ahead: 1, behind: 0, remote: { kind: "github", github: "owner/Alpha" }, lastCommit: { sha: "abc", subject: "init", date: "2030-01-01" }, statusDoc: { present: false } }];
  const runtime = createRuntime({
    company, routerClient: client,
    getOverview: async () => (overviewCache ??= patchOverview(await service.overview())),
    getUsage: () => service.usage({ range: "7d" }),
    workspace: { scan: async () => ({ repos }), paths: () => new Map() }
  });
  const wait = async (id) => {
    for (let i = 0; i < 200; i++) {
      const run = company.getRun(id);
      if (TERMINAL.has(run.status) && !runtime.running.has(id)) return run;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error("run did not finish");
  };
  return { stub, client, service, company, runtime, wait, close: () => { runtime.stop(); return stub.close(); } };
}

test("route selection excludes restricted and non-opted-in subscription providers, explains every decision", async () => {
  const env = await setup();
  try {
    const overview = await env.service.overview();
    const policy = env.company.getPolicy("general");
    const route = selectRoute({ policy, agentConfig: null, priority: "medium", overview });
    assert.equal(route.chosen, "nvidia/model-a");
    const byRef = Object.fromEntries(route.candidates.map((c) => [c.ref, c]));
    assert.equal(byRef["agy/gemini-flash"].reasons[0].code, "restricted-provider");
    assert.equal(byRef["codex/gpt-x"].reasons[0].code, "subscription-not-opted-in");
    // Opting into subscriptions still applies quota protection: codex session is at 4% (provider-reported).
    env.company.updatePolicy("general", { allowClasses: ["free", "api-free-tier", "subscription"] });
    const opted = selectRoute({ policy: env.company.getPolicy("general"), agentConfig: null, priority: "medium", overview, subscriptionOptIn: true });
    assert.ok(opted.candidates.find((c) => c.ref === "codex/gpt-x").reasons.some((r) => r.code === "quota-protect"));
    const urgent = selectRoute({ policy: env.company.getPolicy("general"), agentConfig: null, priority: "high", overview, subscriptionOptIn: true });
    assert.equal(urgent.chosen, "codex/gpt-x", "high priority may use protected capacity");
    const offline = selectRoute({ policy, agentConfig: null, overview: { connection: { state: "offline" } } });
    assert.equal(offline.chosen, null);
  } finally { await env.close(); }
});

test("conversation messages use the existing run, scoped history and persisted assistant result", async () => {
  const env = await setup();
  try {
    const conversations = createConversations({ company: env.company, runtime: env.runtime });
    env.runtime.setConversations(conversations);
    const project = env.company.listProjects()[0];
    const thread = conversations.create({ agentId: "ori", projectId: project.id });
    assert.throws(() => conversations.upload(thread.id, { filename: "../secret.txt", data: Buffer.from("x").toString("base64") }), { code: "filename-invalid" });
    assert.throws(() => conversations.upload(thread.id, { filename: "fake.png", data: Buffer.from("not a png").toString("base64") }), { code: "attachment-mime" });
    const attached = conversations.upload(thread.id, { filename: "brief.md", data: Buffer.from("Verified test fact: Alpha is the test project.").toString("base64") });
    assert.equal(attached.readableByAgent, true);
    const first = conversations.send(thread.id, { content: "ما حالة المشروع؟", idempotencyKey: "chat-first-001", attachmentIds: [attached.id] });
    const firstRun = await env.wait(first.run.id);
    assert.equal(firstRun.status, "succeeded", firstRun.errorMessage);
    assert.equal(firstRun.conversationId, thread.id);
    assert.deepEqual(conversations.messages(thread.id).slice(0, 2).map((m) => [m.role, m.state]), [["owner", "complete"], ["assistant", "complete"]]);
    assert.ok(conversations.messages(thread.id).some((m) => m.role === "tool" && m.source === "project.read"));
    assert.ok(conversations.messages(thread.id).some((m) => m.role === "event" && m.metadata.event === "run.succeeded"));
    assert.equal(conversations.messages(thread.id)[1].content, firstRun.output);
    assert.equal(conversations.messages(thread.id)[0].attachments[0].filename, "brief.md");
    assert.match(env.stub.chats[0].messages.at(-1).content, /Verified test fact/);
    assert.equal(conversations.list({ q: "حالة المشروع" }).length, 1, "search includes messages in the scoped thread");
    assert.equal(conversations.list({ q: "missing" }).length, 0);
    const second = conversations.send(thread.id, { content: "وما الخطوة التالية؟", idempotencyKey: "chat-second-001" });
    assert.equal(conversations.send(thread.id, { content: "وما الخطوة التالية؟", idempotencyKey: "chat-second-001" }).deduplicated, true);
    await env.wait(second.run.id);
    assert.equal(env.stub.chats.length, 2);
    assert.ok(env.stub.chats[1].messages.some((m) => m.role === "assistant" && m.content === firstRun.output));
    assert.ok(env.stub.chats[1].messages.some((m) => m.role === "user" && m.content === "ما حالة المشروع؟"));
    assert.throws(() => conversations.update(thread.id, { projectId: null }), { code: "conversation-project-locked" });
    conversations.update(thread.id, { state: "archived" });
    assert.throws(() => conversations.send(thread.id, { content: "x" }), { code: "conversation-archived" });
    conversations.update(thread.id, { state: "active" });
    assert.equal(conversations.list({ agentId: "ori" })[0].id, thread.id);
  } finally { await env.close(); }
});

test("conversation and run survive Bridge store reopen with SQLite integrity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abud-conversation-"));
  const file = join(dir, "company.db");
  const env = await setup({ dbPath: file });
  let threadId;
  try {
    const conversations = createConversations({ company: env.company, runtime: env.runtime });
    env.runtime.setConversations(conversations);
    threadId = conversations.create({ agentId: "zen" }).id;
    const queued = conversations.send(threadId, { content: "احتفظ بالمحادثة", idempotencyKey: "chat-reopen-001" });
    assert.equal((await env.wait(queued.run.id)).status, "succeeded");
  } finally { await env.close(); env.company.db.close(); }
  try {
    const db = openDatabase(file);
    const company = createCompany({ db });
    const conversations = createConversations({ company, runtime: { enqueue() { throw new Error("unexpected inference"); } } });
    assert.equal(db.raw.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.raw.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(conversations.messages(threadId)[1].state, "complete");
    assert.equal(company.getRun(conversations.messages(threadId)[1].runId).conversationId, threadId);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("end-to-end: owner request → LUNA → OmniRoute inference → persisted result, usage, follow-up task and audit trail", async () => {
  const env = await setup();
  try {
    const project = env.company.listProjects()[0];
    const queued = env.runtime.enqueue({ agentId: "luna", capability: "task_breakdown", request: "جهّزي قائمة متابعة لإطلاق المشروع", projectId: project.id, idempotencyKey: "abcdefgh-1" });
    assert.equal(queued.status, "queued");
    assert.equal(env.runtime.enqueue({ agentId: "luna", capability: "task_breakdown", request: "x", projectId: project.id, idempotencyKey: "abcdefgh-1" }).deduplicated, true, "idempotency key prevents duplicate execution");
    const run = await env.wait(queued.id);
    assert.equal(run.status, "succeeded", run.errorMessage);
    assert.equal(run.effectiveModel, "nvidia/model-a");
    assert.equal(run.costUsd, 0.0012);
    assert.equal(run.costBasis, "router-estimate");
    assert.equal(run.promptTokens, 120);
    assert.match(run.output, /رد تجريبي/);
    assert.ok(run.routing.candidates.length === 4 && run.routing.attempts.length === 1);
    assert.equal(env.stub.chats.length, 1, "exactly one inference call");
    assert.equal(env.stub.chats[0].messages[0].role, "system");
    assert.ok(!JSON.stringify(env.stub.chats[0]).includes(TEST_KEY));
    const followup = env.company.listTasks().find((t) => t.title === "مهمة متابعة تجريبية");
    assert.ok(followup, "LUNA created the follow-up through tasks.create");
    assert.equal(followup.source, "agent:luna");
    assert.ok(run.toolCalls.some((c) => c.tool === "tasks.create" && c.ok));
    assert.equal(env.company.usageSince(new Date(Date.now() - 60_000).toISOString(), { agentId: "luna" }).runs, 1);
    const actions = env.company.activity().map((e) => e.action);
    for (const action of ["agent.assigned", "agent.run.succeeded", "tool.invoked", "task.created"]) assert.ok(actions.includes(action), action);
  } finally { await env.close(); }
});

test("fallback on rate limit stays within eligible candidates; permanent auth failure is not retried", async () => {
  let calls = 0;
  const env = await setup({ chat: (model) => { calls++; return model === "nvidia/model-a" ? { status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "30" } } : defaultChat(model); } });
  try {
    const run = await env.wait(env.runtime.enqueue({ agentId: "ori", request: "ملخص اليوم" }).id);
    assert.equal(run.status, "succeeded");
    assert.equal(run.effectiveModel, "nvidia/model-b");
    assert.deepEqual(run.routing.attempts.map((a) => a.code), ["rate-limited", "ok"]);
    assert.ok(!env.stub.chats.some((c) => c.model.startsWith("agy/") || c.model.startsWith("codex/")), "never fell back to restricted/subscription");
  } finally { await env.close(); }
  const denied = await setup({ chat: () => ({ status: 401, body: { error: { message: "bad key" } } }) });
  try {
    const run = await denied.wait(denied.runtime.enqueue({ agentId: "ori", request: "ملخص" }).id);
    assert.equal(run.status, "failed");
    assert.equal(run.errorCategory, "unauthorized");
    assert.equal(denied.stub.chats.length, 1, "no retry on authorization failure");
    assert.ok(denied.company.notifications().some((n) => n.kind === "agent-error"));
  } finally { await denied.close(); }
});

test("observed stalled connection is cooled and an eligible different provider runs next", async () => {
  const geminiId = "55555555-5555-4555-8555-555555555555";
  const env = await setup({
    patchOverview: (overview) => ({ ...overview, connections: [...overview.connections, { id: geminiId, provider: "gemini", active: true, quota: { support: "not-exposed", windows: [] } }] }),
    chat: (model) => model === "nvidia/model-a"
      ? { status: 503, body: { error: { message: "upstream stalled" } }, headers: { "x-omniroute-provider": "nvidia", "x-omniroute-selected-connection-id": CONN.nvidia } }
      : model.startsWith("gemini/") ? { ...defaultChat(model), headers: { ...defaultChat(model).headers, "x-omniroute-selected-connection-id": geminiId } } : defaultChat(model)
  });
  try {
    env.company.updatePolicy("general", { candidates: ["nvidia/model-a", "nvidia/model-b", "gemini/flash"], maxRetries: 2 });
    const first = await env.wait(env.runtime.enqueue({ agentId: "ori", request: "لخّص" }).id);
    assert.equal(first.status, "succeeded", first.errorMessage);
    assert.equal(first.effectiveModel, "gemini/flash");
    assert.deepEqual(first.routing.attempts.map((attempt) => attempt.ref), ["nvidia/model-a", "gemini/flash"]);
    assert.equal(first.routing.attempts[0].connectionId, CONN.nvidia);
    assert.equal(first.routing.attempts[0].fallbackReason, "provider-unavailable");
    assert.ok(first.routing.attempts[0].timing?.headersMs != null);
    assert.equal(first.routing.progress.phase, "completed");
    const second = await env.wait(env.runtime.enqueue({ agentId: "ori", request: "لخّص ثانية" }).id);
    assert.equal(second.routing.attempts[0].ref, "gemini/flash", "only the observed connection is cooled");
  } finally { await env.close(); }
});

test("company inference phase limits are configurable only inside safe bounds", async () => {
  const env = await setup();
  try {
    const saved = env.company.updateSettings({ inferenceTimeouts: { firstTokenMs: 20000, totalMs: 120000 } });
    assert.equal(saved.inferenceTimeouts.firstTokenMs, 20000);
    assert.equal(saved.inferenceTimeouts.totalMs, 120000);
    assert.equal(saved.inferenceTimeouts.connectMs, 5000);
    assert.throws(() => env.company.updateSettings({ inferenceTimeouts: { totalMs: 900000 } }), (error) => error.code === "validation");
    // In-range values that could never fire together are refused as a combination, and nothing is saved.
    assert.throws(() => env.company.updateSettings({ inferenceTimeouts: { headersMs: 60000, totalMs: 30000 } }), (error) => error.code === "validation");
    assert.throws(() => env.company.updateSettings({ inferenceTimeouts: { connectMs: 15000, headersMs: 10000 } }), (error) => error.code === "validation");
    assert.equal(env.company.settings().inferenceTimeouts.totalMs, 120000);
  } finally { await env.close(); }
});

test("without a connection ID, fallback tries a different eligible provider before another model from the same provider", async () => {
  const geminiId = "55555555-5555-4555-8555-555555555555";
  const env = await setup({
    patchOverview: (overview) => ({ ...overview, connections: [...overview.connections, { id: geminiId, provider: "gemini", active: true, quota: { support: "not-exposed", windows: [] } }] }),
    chat: (model) => model === "nvidia/model-a"
      ? { status: 503, body: { error: { message: "upstream unavailable" } }, headers: { "x-omniroute-provider": "nvidia" } }
      : defaultChat(model)
  });
  try {
    env.company.updatePolicy("general", { candidates: ["nvidia/model-a", "nvidia/model-b", "gemini/flash"], maxRetries: 2 });
    const run = await env.wait(env.runtime.enqueue({ agentId: "ori", request: "لخّص" }).id);
    assert.equal(run.status, "succeeded");
    assert.deepEqual(run.routing.attempts.map((attempt) => attempt.ref), ["nvidia/model-a", "gemini/flash"]);
    assert.equal(run.routing.attempts[0].connectionId, null);
  } finally { await env.close(); }
});

test("budget hard stop blocks before any inference; paid models require approval and resume after it", async () => {
  const withMetered = (o) => ({ ...o, connections: [...o.connections, { id: "44444444-4444-4444-8444-444444444444", shortId: "44444444", provider: "openrouter", active: true, warnings: [], quota: { support: "no-windows", windows: [], perModel: [] } }] });
  const env = await setup({ patchOverview: withMetered });
  try {
    env.company.upsertBudget({ scope: "agent", scopeRef: "nex", period: "daily", tokenLimit: 1 });
    env.company.db.run("INSERT INTO usage_events (at, agent_id, provider, model, prompt_tokens, completion_tokens, cost_usd, cost_basis, source) VALUES (?,?,?,?,?,?,?,?,?)", new Date().toISOString(), "nex", "nvidia", "nvidia/x", 5, 5, 0, "router-estimate", "application-measured");
    const blocked = await env.wait(env.runtime.enqueue({ agentId: "nex", capability: "resource_report", request: "تقرير" }).id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.errorCategory, "budget-exceeded");
    assert.equal(env.stub.chats.length, 0, "no inference when the budget is exhausted");

    env.company.updatePolicy("creative", { candidates: ["openrouter/paid-model"], allowClasses: ["metered"], approval: "paid" });
    const paid = await env.wait(env.runtime.enqueue({ agentId: "mia", capability: "creative_brief", request: "فكرة حملة" }).id);
    assert.equal(paid.status, "blocked");
    assert.equal(paid.errorCategory, "approval-required");
    assert.equal(env.stub.chats.length, 0);
    const approval = env.company.getApproval(paid.approvalId);
    assert.equal(approval.kind, "agent.paid_inference");
    assert.equal(approval.payload.model, "openrouter/paid-model");
    await env.runtime.decideApproval(approval.id, "approve");
    const resumed = await env.wait(paid.id);
    assert.equal(resumed.status, "succeeded", resumed.errorMessage);
    assert.equal(resumed.effectiveModel, "openrouter/paid-model");
    assert.equal(env.stub.chats.length, 1, "paid inference happens only after approval");
  } finally { await env.close(); }
});

test("a paid run without router cost stops further paid inference under a hard USD budget; free models continue", async () => {
  const withMetered = (o) => ({ ...o, connections: [...o.connections, { id: "44444444-4444-4444-8444-444444444444", shortId: "44444444", provider: "openrouter", active: true, warnings: [], quota: { support: "no-windows", windows: [], perModel: [] } }] });
  const noCost = (model) => { const reply = defaultChat(model); delete reply.headers["x-omniroute-response-cost"]; return reply; };
  const env = await setup({ patchOverview: withMetered, chat: noCost });
  try {
    env.company.updatePolicy("creative", { candidates: ["openrouter/paid-model"], allowClasses: ["metered"], approval: "paid" });
    const runPaid = async () => {
      const first = await env.wait(env.runtime.enqueue({ agentId: "mia", capability: "creative_brief", request: "فكرة حملة" }).id);
      assert.equal(first.errorCategory, "approval-required", "paid-model approval is still required");
      await env.runtime.decideApproval(first.approvalId, "approve");
      return env.wait(first.id);
    };
    const paid = await runPaid();
    assert.equal(paid.status, "succeeded", paid.errorMessage);
    assert.equal(paid.costUsd, null, "absent router cost is stored as unknown, not $0");
    assert.equal(paid.costBasis, "unknown");
    assert.equal(env.stub.chats.length, 1);
    assert.ok(env.company.listBudgets().some((b) => b.scope === "company" && b.limitUsd != null && b.state === "unverified"));

    const second = await runPaid();
    assert.equal(second.status, "blocked");
    assert.equal(second.errorCategory, "budget-exceeded");
    assert.match(second.errorMessage, /غير معروفة/);
    assert.equal(env.stub.chats.length, 1, "no further paid inference while the budget cannot be verified");

    const free = await env.wait(env.runtime.enqueue({ agentId: "nex", capability: "resource_report", request: "تقرير" }).id);
    assert.equal(free.status, "succeeded", free.errorMessage);
    assert.equal(env.stub.chats.length, 2, "api-free-tier inference is not blocked by the unverified USD budget");
  } finally { await env.close(); }
});

test("tool permissions are enforced by the server, not the model; forbidden calls are audited", async () => {
  const env = await setup();
  try {
    await assert.rejects(env.runtime.invokeTool("mia", "quota.read", {}, { toolCalls: [] }), (e) => e.code === "tool-forbidden");
    await assert.rejects(env.runtime.invokeTool("luna", "tasks.create", { title: "x", evil: 1 }, { toolCalls: [] }), (e) => e.code === "invalid-tool-input");
    await assert.rejects(env.runtime.invokeTool("nex", "router.settings.propose", { key: "requestRetry" }, { toolCalls: [] }), (e) => e.code === "tool-forbidden");
    env.company.updateAgent("luna", { tools: ["tasks.query"] });
    await assert.rejects(env.runtime.invokeTool("luna", "tasks.create", { title: "x" }, { toolCalls: [] }), (e) => e.code === "tool-forbidden");
    assert.ok(env.company.activity().filter((e) => e.action === "tool.denied").length >= 3);
    env.company.updateAgent("zen", { enabled: false });
    assert.throws(() => env.runtime.enqueue({ agentId: "zen", request: "بحث" }), (e) => e.code === "agent-disabled");
    assert.throws(() => env.runtime.enqueue({ agentId: "ori", request: "my password: hunter22222" }), (e) => e.code === "secret-rejected");
  } finally { await env.close(); }
});

test("ORI project assessment: NEX evidence and REX scan without inference, one ORI synthesis, LUNA follow-ups, memory saved", async () => {
  const env = await setup();
  try {
    const project = env.company.listProjects()[0];
    const parent = await env.wait(env.runtime.enqueue({ agentId: "ori", capability: "project_assessment", projectId: project.id }).id);
    assert.equal(parent.status, "succeeded", parent.errorMessage);
    const steps = env.company.listRuns({ workflowId: parent.workflowId, limit: 10 });
    assert.deepEqual(steps.map((s) => `${s.agentId}:${s.capability}:${s.status}`).sort(), ["luna:followups:succeeded", "nex:evidence:succeeded", "ori:project_assessment:succeeded", "rex:security_scan:succeeded"]);
    assert.equal(env.stub.chats.length, 1, "single model call for the whole workflow");
    const rex = steps.find((s) => s.agentId === "rex");
    assert.match(rex.output, /no-remote|uncommitted|unpushed/);
    assert.ok(env.company.listTasks({ projectId: project.id }).some((t) => t.source === "agent:luna"));
    assert.ok(env.company.listMemory({ scope: "project", scopeRef: project.id }).some((m) => m.source === "agent:ori" && !m.approved), "agent memory is pending owner review");
  } finally { await env.close(); }
});

test("queued runs can be cancelled; router changes need approval, honour the write switch, verify and roll back", async () => {
  const env = await setup();
  try {
    env.runtime.stop(); // keep the run queued
    const queued = env.runtime.enqueue({ agentId: "zen", request: "بحث" });
    assert.equal(env.runtime.cancel(queued.id).status, "cancelled");
    const proposal = await env.runtime.proposeRouterChange({ key: "requestRetry", value: 2 });
    assert.equal(proposal.status, "pending");
    assert.deepEqual(proposal.before, { requestRetry: 3 });
    const decided = await env.runtime.decideApproval(proposal.id, "approve");
    assert.equal(decided.status, "approved");
    assert.equal(decided.result.code, "writes-disabled");
    assert.equal(env.stub.settings.requestRetry, 3, "live router untouched while writes are disabled");
    await assert.rejects(env.runtime.decideApproval(proposal.id, "approve"), (e) => e.code === "already-decided");
    await assert.rejects(env.runtime.proposeRouterChange({ key: "requireLogin", value: false }), (e) => e.code === "validation");
  } finally { await env.close(); }
  const writable = await setup({ env: { ABUD_ROUTER_WRITES: "1" } });
  try {
    const proposal = await writable.runtime.proposeRouterChange({ key: "requestRetry", value: 2 });
    const applied = await writable.runtime.decideApproval(proposal.id, "approve");
    assert.equal(applied.status, "applied");
    assert.equal(applied.result.verified, true);
    assert.equal(writable.stub.settings.requestRetry, 2);
    const rolled = await writable.runtime.rollbackRouterChange(proposal.id);
    assert.equal(rolled.status, "rolled_back");
    assert.equal(writable.stub.settings.requestRetry, 3);
    assert.ok(writable.stub.hits.filter((h) => h.method === "PATCH").every((h) => h.path === "/api/settings"));
  } finally { await writable.close(); }
});

test("NEX recommendations cite evidence and flag the router retry setting as an approval-gated proposal", async () => {
  const env = await setup();
  try {
    const overview = await env.service.overview();
    const usage = await env.service.usage({ range: "7d" });
    const recs = recommend({ overview, usage, policies: env.company.listPolicies(), budgets: env.company.listBudgets() });
    const retry = recs.find((r) => r.id === "router-retry");
    assert.ok(retry && retry.approvalRequired && retry.action.key === "requestRetry");
    assert.ok(recs.some((r) => r.id.startsWith("exhausted:")));
    assert.ok(recs.some((r) => r.id === "restricted-providers"));
    assert.ok(recs.every((r) => r.evidence.length && r.confidence));
    assert.equal(extractJson('نص\n```json\n{"tasks":[{"title":"a"}]}\n```').tasks[0].title, "a");
    assert.equal(extractJson("لا يوجد"), null);
    assert.equal(recommend({ overview: { connection: { state: "offline" } } })[0].id, "router-offline");
  } finally { await env.close(); }
});

test("secret detector flags real-looking values but not documentation placeholders", async () => {
  const { SECRETISH } = await import("../src/runtime.mjs");
  const hits = (text) => (text.match(SECRETISH) || []).length;
  assert.equal(hits('$env:OMNIROUTE_API_KEY = "<read-only key from the OmniRoute dashboard>"'), 0);
  assert.equal(hits("API_KEY=$OMNIROUTE_API_KEY"), 0);
  assert.equal(hits("password: {{ vault.password }}"), 0);
  assert.equal(hits("api_key = 8f3k2j9d0s1a"), 1);
  assert.equal(hits("token ghp_abcdefghijklmnop1234"), 1);
});

test("maxCostUsd: a paid call above the per-request cap holds further paid calls until the owner acknowledges", async () => {
  const withMetered = (o) => ({ ...o, connections: [...o.connections, { id: "44444444-4444-4444-8444-444444444444", shortId: "44444444", provider: "openrouter", active: true, warnings: [], quota: { support: "no-windows", windows: [], perModel: [] } }] });
  const env = await setup({ patchOverview: withMetered });
  try {
    env.company.updatePolicy("creative", { candidates: ["openrouter/paid-model"], allowClasses: ["metered"], approval: "paid", maxCostUsd: 0.001 });
    const runPaid = async () => {
      const first = await env.wait(env.runtime.enqueue({ agentId: "mia", capability: "creative_brief", request: "فكرة حملة" }).id);
      if (first.errorCategory !== "approval-required") return first;
      await env.runtime.decideApproval(first.approvalId, "approve");
      return env.wait(first.id);
    };
    const paid = await runPaid();
    assert.equal(paid.status, "succeeded", paid.errorMessage);
    assert.equal(paid.costUsd, 0.0012);
    const hold = env.company.notifications().find((n) => n.dedupe_key === "cost-cap:creative");
    assert.ok(hold, "the breach raises a hold");
    const second = await runPaid();
    assert.equal(second.status, "blocked");
    assert.match(second.errorMessage, /حد التكلفة لكل طلب/);
    assert.equal(env.stub.chats.length, 1, "no paid inference while the hold is open");
    env.company.acknowledge(hold.id);
    const third = await runPaid();
    assert.equal(third.status, "succeeded", "acknowledging the hold resumes paid inference (still under approval)");
    assert.equal(env.stub.chats.length, 2);
  } finally { await env.close(); }
});

test("ORI infrastructure assessment: NEX telemetry and REX review without inference, one ORI synthesis, LUNA follow-ups deduplicated", async () => {
  const { createVps } = await import("../src/vps.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const env = await setup();
  try {
    const dir = mkdtempSync(join(tmpdir(), "abud-infra-"));
    const fp = "SHA256:TESTfingerprintNOTaREALhostKEY0123456789abc";
    writeFileSync(join(dir, "vps.json"), JSON.stringify({ hosts: [{ id: "lab", name: "Lab", address: "203.0.113.10", sshUser: "root", hostKeyFingerprint: fp, identityFile: "C:/x", profile: { pm2: [{ user: "lab", services: [{ name: "lab-api" }] }], systemd: ["nginx"] } }] }));
    const basic = ["@@hostname", "lab", "@@load", "0.1 0.1 0.1 1/1 1", "2", "@@mem", "MemTotal: 4000000 kB", "MemAvailable: 3000000 kB", "@@df", "/dev/sda1 100 40 60 40% /", "@@systemd", "nginx active", "@@pm2:lab", "lab-api\tonline\t1\t0\t1700000000000\t1\t0\tfork_mode"].join("\n");
    const vps = createVps({ company: env.company, configPath: join(dir, "vps.json"), transport: { exec: async () => ({ ok: true, code: 0, ms: 5, fingerprint: fp, stdout: basic }) }, siteChecker: async () => ({}), certChecker: async () => ({}) });
    await vps.reload();
    const runtime = createRuntime({ company: env.company, routerClient: env.client, getOverview: () => env.service.overview(), getUsage: () => env.service.usage({ range: "7d" }), workspace: { scan: async () => ({ repos: [] }), paths: () => new Map() }, vps });
    const wait = async (id) => { for (let i = 0; i < 300; i++) { const r = env.company.getRun(id); if (TERMINAL.has(r.status) && !runtime.running.has(id)) return r; await new Promise((res) => setTimeout(res, 15)); } throw new Error("timeout"); };
    const run = await wait(runtime.enqueue({ agentId: "ori", capability: "infra_assessment" }).id);
    assert.equal(run.status, "succeeded", run.errorMessage);
    assert.equal(env.stub.chats.length, 1, "exactly one inference for the whole workflow");
    const steps = env.company.listRuns({ workflowId: run.workflowId, limit: 10 }).filter((r) => r.id !== run.id);
    assert.deepEqual(steps.map((s) => s.agentId).sort(), ["luna", "nex", "rex"]);
    assert.ok(steps.every((s) => s.status === "succeeded"));
    const prompt = JSON.stringify(env.stub.chats[0].messages);
    assert.match(prompt, /غير موثوقة/, "the model is told remote output is untrusted data");
    assert.ok(!prompt.includes("C:/x"), "no SSH identity in the prompt");
    const again = await wait(runtime.enqueue({ agentId: "ori", capability: "infra_assessment" }).id);
    assert.equal(again.status, "succeeded");
    assert.equal(env.company.listTasks({ includeClosed: false }).filter((t) => t.title === "مهمة متابعة تجريبية").length, 1, "the same follow-up is not created twice");
    runtime.stop(); vps.stop();
  } finally { await env.close(); }
});
