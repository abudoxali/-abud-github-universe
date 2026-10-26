/* Automatic tool execution, owner approvals and single-inference conversation audit. */
import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.mjs";
import { createCompany } from "../src/company.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { createConversations } from "../src/conversations.mjs";
import { createRouterClient, createRouterService } from "../src/omniroute.mjs";
import { startStubRouter, TEST_KEY } from "./fixtures.mjs";

function setup({ client = {}, overview = async () => ({ connection: { state: "offline" } }) } = {}) {
  const company = createCompany({ db: openDatabase(":memory:") });
  company.seed();
  const runtime = createRuntime({ company, routerClient: client, getOverview: overview, getUsage: async () => ({}), workspace: { paths: () => new Map(), scan: async () => ({ repos: [] }) } });
  const wait = async (id) => {
    for (let i = 0; i < 200; i++) {
      const run = company.getRun(id);
      if (!["queued", "running"].includes(run.status) && !runtime.running.has(id)) return run;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("run did not settle");
  };
  return { company, runtime, wait, async close() { await runtime.stop(); company.db.close(); } };
}

test("conversation performs one inference and persists selected executions and Arabic actions", async () => {
  const stub = await startStubRouter();
  const client = createRouterClient({ env: { OMNIROUTE_BASE_URL: `http://127.0.0.1:${stub.port}`, OMNIROUTE_API_KEY: TEST_KEY } });
  const service = createRouterService({ client });
  const env = setup({ client, overview: () => service.overview() });
  try {
    for (const policy of env.company.listPolicies()) env.company.updatePolicy(policy.domain, { candidates: ["nvidia/model-a"] });
    const conversations = createConversations({ company: env.company, runtime: env.runtime });
    env.runtime.setConversations(conversations);
    const thread = conversations.create({ agentId: "luna" });
    const sent = conversations.send(thread.id, { content: "tasks.query" });
    const run = await env.wait(sent.run.id);
    assert.equal(run.status, "succeeded", run.errorMessage);
    assert.equal(stub.chats.length, 1);
    assert.ok(run.actionsAr.length);
    for (const pick of run.toolSelection.selected) {
      assert.ok(env.company.agentConfig("luna").tools.includes(pick.toolId));
      if (pick.tier === "A") assert.ok(run.toolCalls.some(call => call.tool === pick.toolId && call.ok));
    }
    assert.ok(conversations.messages(thread.id).some(message => message.role === "assistant" && message.actionsAr?.length));
  } finally { await env.close(); await stub.close(); }
});

test("paid approval resumes inference without replaying automatic B write", async () => {
  const stub = await startStubRouter();
  const client = createRouterClient({ env: { OMNIROUTE_BASE_URL: `http://127.0.0.1:${stub.port}`, OMNIROUTE_API_KEY: TEST_KEY } });
  const service = createRouterService({ client });
  const env = setup({ client, overview: async () => { const overview = await service.overview(); return { ...overview, connections: [...overview.connections, { id: "paid-test", provider: "openrouter", active: true, quota: { support: "no-windows", windows: [] } }] }; } });
  try {
    for (const policy of env.company.listPolicies()) env.company.updatePolicy(policy.domain, { candidates: ["openrouter/paid-model"], allowClasses: ["metered"], approval: "always" });
    env.runtime.autoPolicies.create({ agentId: "luna", toolId: "tasks.create" });
    const queued = env.runtime.enqueue({ agentId: "luna", request: "إنشاء مهمة مراجعة التقرير" });
    const blocked = await env.wait(queued.id);
    assert.equal(blocked.status, "blocked");
    const before = env.runtime.listExecutions({ runId: queued.id, toolId: "tasks.create" });
    assert.equal(before.length, 1);
    assert.ok(blocked.approvalId);
    await env.runtime.decideApproval(blocked.approvalId, "approve");
    await env.wait(queued.id);
    assert.equal(env.runtime.listExecutions({ runId: queued.id, toolId: "tasks.create" }).length, 1);
  } finally { await env.close(); await stub.close(); }
});

test("preview is advisory and respects grants; run persists selection and audited A execution", async () => {
  const env = setup();
  try {
    const preview = await env.runtime.toolSelectPreview({ agentId: "luna", request: "tasks.query" });
    assert.ok(preview.selected.some(pick => pick.toolId === "tasks.query"));
    assert.equal(env.runtime.listExecutions().length, 0);
    const run = env.runtime.enqueue({ agentId: "luna", request: "tasks.query" });
    await env.wait(run.id);
    const row = env.company.db.get("SELECT tool_selection, actions_ar FROM agent_runs WHERE id = ?", run.id);
    assert.ok(JSON.parse(row.tool_selection).selected.some(pick => pick.toolId === "tasks.query"));
    assert.ok(JSON.parse(row.actions_ar).length);
    assert.ok(env.runtime.listExecutions({ runId: run.id }).some(call => call.toolId === "tasks.query" && call.status === "succeeded"));
  } finally { await env.close(); }
});

test("B selection proposes, owner approval executes once through audited invocation", async () => {
  const env = setup();
  try {
    const run = env.runtime.enqueue({ agentId: "luna", request: "إنشاء مهمة مراجعة التقرير" });
    await env.wait(run.id);
    const approval = env.company.db.get("SELECT id FROM approvals WHERE kind = 'agent.tool_proposal'");
    assert.ok(approval);
    assert.equal(env.runtime.listExecutions({ runId: run.id, toolId: "tasks.create" }).length, 0);
    await assert.rejects(env.runtime.decideApproval(approval.id, "approve", { type: "agent", id: "luna" }), { code: "owner-only" });
    const applied = await env.runtime.decideApproval(approval.id, "approve");
    assert.equal(applied.status, "applied");
    const calls = env.runtime.listExecutions({ runId: run.id, toolId: "tasks.create" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].actorType, "owner");
    assert.equal(calls[0].input._approval, approval.id);
    await assert.rejects(env.runtime.decideApproval(approval.id, "approve"), { code: "already-decided" });
  } finally { await env.close(); }
});

test("C preview remains advisory even with explicit valid inputs", async () => {
  const env = setup();
  try {
    const preview = await env.runtime.toolSelectPreview({ agentId: "zen", request: "web.extract", inputs: { "web.extract": { url: "https://example.com/" } } });
    const pick = preview.selected.find(item => item.toolId === "web.extract");
    assert.ok(pick);
    assert.equal(pick.tier, "C");
    assert.equal(env.runtime.listExecutions().length, 0);
    assert.throws(() => env.runtime.autoPolicies.create({ agentId: "zen", toolId: "web.extract" }));
  } finally { await env.close(); }
});

test("an already cancelled invocation never performs an internal write", async () => {
  const env = setup();
  try {
    const controller = new AbortController();
    controller.abort();
    const toolCalls = [];
    await assert.rejects(env.runtime.invokeTool("luna", "tasks.create", { title: "must not be created" }, { signal: controller.signal, toolCalls }), { code: "cancelled" });
    assert.equal(toolCalls.length, 1);
    assert.equal(env.runtime.listExecutions({ toolId: "tasks.create" })[0].status, "denied");
    assert.equal(env.company.db.get("SELECT COUNT(*) AS n FROM tasks WHERE title = ?", "must not be created").n, 0);
  } finally { await env.close(); }
});

test("late owner approval synchronizes conversation action audit without another terminal event", async () => {
  const env = setup();
  try {
    const conversations = createConversations({ company: env.company, runtime: env.runtime });
    env.runtime.setConversations(conversations);
    const thread = conversations.create({ agentId: "luna" });
    const sent = conversations.send(thread.id, { content: "إنشاء مهمة مراجعة التقرير" });
    await env.wait(sent.run.id);
    const approval = env.company.db.get("SELECT id FROM approvals WHERE kind = 'agent.tool_proposal'");
    const eventsBefore = conversations.messages(thread.id).filter(message => message.role === "event").length;
    const applied = await env.runtime.decideApproval(approval.id, "approve");
    assert.equal(applied.status, "applied");
    const assistant = conversations.messages(thread.id).find(message => message.role === "assistant");
    assert.deepEqual(assistant.actionsAr, env.company.getRun(sent.run.id).actionsAr);
    assert.ok(assistant.actionsAr.at(-1).includes(approval.id));
    assert.equal(conversations.messages(thread.id).filter(message => message.role === "event").length, eventsBefore);
  } finally { await env.close(); }
});

test("owner B policy enables automatic execution", async () => {
  const env = setup();
  try {
    env.runtime.autoPolicies.create({ agentId: "luna", toolId: "tasks.create" });
    const run = env.runtime.enqueue({ agentId: "luna", request: "إنشاء مهمة مراجعة التقرير" });
    await env.wait(run.id);
    assert.ok(env.runtime.listExecutions({ runId: run.id, toolId: "tasks.create" }).some(call => call.status === "succeeded"));
    assert.equal(env.company.db.get("SELECT COUNT(*) AS n FROM approvals WHERE kind = 'agent.tool_proposal'").n, 0);
  } finally { await env.close(); }
});
