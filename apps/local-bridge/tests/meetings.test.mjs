/* V6 Meeting Center: sequential orchestration, addressing, budgets, interruption, outcomes and restart recovery. */
import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.mjs";
import { createCompany } from "../src/company.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { createMeetings } from "../src/meetings.mjs";
import { createRouterClient, createRouterService } from "../src/omniroute.mjs";
import { startStubRouter, TEST_KEY } from "./fixtures.mjs";

const FENCE = "```";
const SUMMARY = `ملخص: اتفقنا مبدئيًا على أولويات الأسبوع.\n${FENCE}json\n${JSON.stringify({
  summary: "راجع الفريق أولويات الأسبوع.",
  decisions: ["التركيز على إصدار V6 هذا الأسبوع"],
  action_items: [{ title: "تجهيز خطة اختبار الإصدار", responsible: "ori", due: "2026-11-02" }, { title: "مراجعة الحصص", responsible: "nex", due: null }],
  open_questions: ["هل نحتاج ميزانية إضافية؟"],
  disagreements: ["REX يختلف مع ORI حول موعد الإصدار"],
  follow_ups: []
})}\n${FENCE}`;

/** Stub chat: agents reply with their name; the chair's closing turn returns the structured outcome block. */
const chat = (model, body) => {
  const user = body.messages.at(-1).content;
  const content = user.includes("انتهى اجتماع") ? SUMMARY : `مداخلة تجريبية: ${user.slice(0, 60)}`;
  return { status: 200, headers: { "x-omniroute-provider": "nvidia", "x-omniroute-model": "model-a" }, body: { model, usage: { prompt_tokens: 100, completion_tokens: 40 }, choices: [{ message: { role: "assistant", content } }] } };
};

async function setup({ db = openDatabase(":memory:") } = {}) {
  const stub = await startStubRouter({ chat });
  const client = createRouterClient({ env: { OMNIROUTE_BASE_URL: `http://127.0.0.1:${stub.port}`, OMNIROUTE_API_KEY: TEST_KEY } });
  const service = createRouterService({ client });
  const company = createCompany({ db });
  company.seed();
  for (const policy of company.listPolicies()) company.updatePolicy(policy.domain, { candidates: ["nvidia/model-a"] });
  const runtime = createRuntime({ company, routerClient: client, getOverview: () => service.overview(), getUsage: async () => ({}), workspace: { paths: () => new Map(), scan: async () => ({ repos: [] }) } });
  const meetings = createMeetings({ company, runtime });
  runtime.setMeetings(meetings);
  const project = company.createProject({ name: "Atlas", status: "active" });
  const idle = async (id) => {
    for (let i = 0; i < 400; i++) {
      const view = meetings.get(id);
      if (!view.currentSpeaker && !view.queue.length && view.status !== "ending" && !runtime.running.size) return view;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("meeting did not settle");
  };
  return { stub, company, runtime, meetings, project, idle, async close(keepDb = false) { await runtime.stop(); if (!keepDb) db.close(); await stub.close(); } };
}

test("Scenario F: individual meeting with ORI persists turns, proposes outcomes, and confirms them through normal paths", async () => {
  const env = await setup();
  try {
    const m = env.meetings.create({ title: "مراجعة مشروع Atlas", projectId: env.project.id, participants: ["ori"], agenda: ["الحالة", "الأولويات"], mode: "voice" });
    assert.equal(m.chair, "ori");
    env.meetings.start(m.id);
    await env.meetings.say(m.id, { content: "إيه وضع المشروع؟", clientMessageId: "client-msg-0001" });
    const dup = await env.meetings.say(m.id, { content: "إيه وضع المشروع؟", clientMessageId: "client-msg-0001" });
    assert.equal(dup.deduplicated, true);
    let view = await env.idle(m.id);
    assert.deepEqual(view.turns.filter((t) => t.kind !== "system").map((t) => [t.speaker, t.status]), [["owner", "completed"], ["ori", "completed"]]);
    const run = env.company.getRun(view.turns.find((t) => t.speaker === "ori").runId);
    assert.equal(run.meetingId, m.id);
    assert.equal(run.projectId, env.project.id);
    env.meetings.end(m.id);
    view = await env.idle(m.id);
    assert.equal(view.status, "ended");
    assert.equal(view.summary, "راجع الفريق أولويات الأسبوع.");
    assert.ok(view.outcomes.length >= 4);
    assert.ok(view.outcomes.every((o) => o.status === "proposed"), "outcomes are never auto-confirmed");
    const item = view.outcomes.find((o) => o.type === "action_item" && o.responsibleAgent === "ori");
    assert.equal(item.dueDate, "2026-11-02");
    assert.equal(view.outcomes.find((o) => o.content === "مراجعة الحصص").responsibleAgent, null, "non-participants are not assigned");
    assert.throws(() => env.meetings.decide(m.id, item.id, "confirm", { type: "agent", id: "ori" }), (e) => e.status === 403);
    view = env.meetings.decide(m.id, item.id, "confirm", { type: "owner", id: "owner" });
    const task = env.company.getTask(view.outcomes.find((o) => o.id === item.id).taskId);
    assert.equal(task.assignee, "ori");
    assert.equal(task.projectId, env.project.id);
    const decision = view.outcomes.find((o) => o.type === "decision");
    view = env.meetings.decide(m.id, decision.id, "confirm", { type: "owner", id: "owner" });
    const note = env.company.db.get("SELECT kind, confidence, evidence FROM memory_notes WHERE id = ?", view.outcomes.find((o) => o.id === decision.id).memoryId);
    assert.equal(note.kind, "decision");
    assert.match(note.evidence, new RegExp(`meeting:${m.id}`));
    assert.throws(() => env.meetings.decide(m.id, item.id, "confirm", { type: "owner", id: "owner" }), (e) => e.status === 409);
    const exported = env.meetings.exportMarkdown(m.id).body;
    assert.match(exported, /إيه وضع المشروع/);
    assert.match(exported, /مؤكد/);
  } finally { await env.close(); }
});

test("Scenario G: six-agent meeting is sequential, routes by address, interrupts and respects the budget", async () => {
  const env = await setup();
  try {
    const all = ["ori", "mia", "nex", "luna", "zen", "rex"];
    const m = env.meetings.create({ title: "أولويات الأسبوع", participants: all, budget: { maxTurns: 14 } });
    env.meetings.start(m.id);
    await env.meetings.say(m.id, { content: "راجعوا أولويات مشاريع الشركة للأسبوع واستهلاك النماذج" });
    let view = await env.idle(m.id);
    const firstRound = view.turns.filter((t) => t.kind === "answer");
    assert.equal(firstRound[0].speaker, "ori", "the chair speaks first");
    assert.ok(firstRound.length >= 1 && firstRound.length <= 3, "chair plus at most two specialists");

    await env.meetings.say(m.id, { content: "NEX، ايه رأيك في اقتراح أوري؟" });
    view = await env.idle(m.id);
    const afterNex = view.turns.filter((t) => t.kind === "answer").slice(firstRound.length);
    assert.deepEqual(afterNex.map((t) => t.speaker), ["nex"], "only the addressed agent answers");

    await env.meetings.say(m.id, { content: "عايز رأي كلكم في الخطة" });
    view = await env.idle(m.id);
    const everyone = view.turns.filter((t) => t.kind === "answer").slice(firstRound.length + 1);
    assert.deepEqual(everyone.map((t) => t.speaker), all, "everyone speaks once, chair first");

    // Runs never overlap inside a meeting.
    const windows = view.turns.filter((t) => t.runId).map((t) => env.company.db.get("SELECT started_at, finished_at FROM agent_runs WHERE id = ?", t.runId)).sort((a, b) => a.started_at.localeCompare(b.started_at));
    for (let i = 1; i < windows.length; i++) assert.ok(windows[i].started_at >= windows[i - 1].finished_at, "sequential runs");

    // Interrupt before the queued speakers start: nothing more is inferred.
    const chatsBefore = env.stub.chats.length;
    await env.meetings.say(m.id, { content: "كلكم: ملاحظات أخيرة؟" });
    env.meetings.interrupt(m.id);
    view = await env.idle(m.id);
    assert.equal(env.stub.chats.length, chatsBefore, "interrupted turns never reach the model");
    assert.ok(view.turns.some((t) => t.status === "interrupted"));

    // Budget: the meeting stops accepting discussion once maxTurns is reached.
    for (let i = 0; i < 6 && !env.meetings.get(m.id).budgetExhausted; i++) { await env.meetings.say(m.id, { content: `زن، نقطة ${i}` }); await env.idle(m.id); }
    assert.equal(env.meetings.get(m.id).budgetExhausted, true);
    await assert.rejects(() => env.meetings.say(m.id, { content: "سؤال إضافي" }), (e) => e.status === 409 && e.code === "meeting-budget");

    await assert.rejects(() => env.meetings.say(env.meetings.create({ title: "ثنائي", participants: ["ori", "mia"] }).id, { content: "x" }), (e) => e.status === 409);
  } finally { await env.close(); }
});

test("a simple live meeting hearing check receives one concise reply", async () => {
  const env = await setup();
  try {
    const meeting = env.meetings.create({ title: "مكالمة الفريق", participants: ["ori", "nex", "luna"], mode: "voice" });
    env.meetings.start(meeting.id);
    const before = env.stub.chats.length;
    await env.meetings.say(meeting.id, { content: "سمعني؟" });
    const view = await env.idle(meeting.id);
    const replies = view.turns.filter((turn) => turn.kind === "answer");
    assert.deepEqual(replies.map((turn) => [turn.speaker, turn.content]), [["ori", "أيوه، سامعك. اتفضل."]]);
    assert.equal(env.stub.chats.length, before);
  } finally { await env.close(); }
});

test("addressing a non-participant is refused; a registry-only 7th agent participates when addressed", async () => {
  const env = await setup();
  try {
    env.company.registry.createFromTemplate({ templateId: "analyst", id: "sam", name: "Sam", titleAr: "محلل", roleAr: "تحليل", summaryAr: "محلل تجريبي", specializations: [] });
    const m = env.meetings.create({ title: "اختبار السابع", participants: ["ori", "sam"] });
    env.meetings.start(m.id);
    await assert.rejects(() => env.meetings.say(m.id, { content: "REX، ايه رأيك؟" }), (e) => e.status === 422 && e.code === "not-a-participant");
    await env.meetings.say(m.id, { content: "Sam، ايه رأيك في الأرقام؟" });
    const view = await env.idle(m.id);
    assert.deepEqual(view.turns.filter((t) => t.kind === "answer").map((t) => [t.speaker, t.status]), [["sam", "completed"]]);
    assert.equal(view.participants.find((p) => p.agentId === "sam").turns, 1);
  } finally { await env.close(); }
});

test("meeting runs can only be started by the Meeting Center, and a restart pauses live meetings without re-running", async () => {
  const db = openDatabase(":memory:");
  const env = await setup({ db });
  try {
    const m = env.meetings.create({ title: "اجتماع سيُقطع", participants: ["ori", "nex"] });
    env.meetings.start(m.id);
    assert.throws(() => env.runtime.enqueue({ agentId: "ori", meetingId: m.id, request: "x" }, { type: "owner", id: "owner" }), (e) => e.status === 422);
    await env.meetings.say(m.id, { content: "كلكم: ابدأوا" });
    const chats = env.stub.chats.length;
    // Simulate a restart before the queued turns execute: a fresh service over the same store recovers.
    const recovered = createMeetings({ company: env.company, runtime: env.runtime });
    assert.equal(recovered.recover(), 1);
    const view = await env.idle(m.id);
    assert.equal(view.status, "paused");
    assert.equal(view.turns.filter((t) => t.kind === "answer" && t.status === "interrupted").length, 2);
    assert.equal(env.stub.chats.length, chats, "no turn is re-run after recovery");
    assert.equal(recovered.recover(), 0, "recovery is idempotent");
    recovered.start(m.id);
    assert.equal(recovered.get(m.id).status, "active");
  } finally { await env.close(); }
});
