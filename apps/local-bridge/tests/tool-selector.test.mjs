import test from "node:test";
import assert from "node:assert/strict";
import { AGENTS, TOOLS, V5_AGENT_TOOLS, VPS_AGENT_TOOLS } from "../src/catalog.mjs";
import { normalizeToolText, selectTools } from "../src/tool-selector.mjs";
const availability = Object.fromEntries(TOOLS.map(t => [t.id, true]));
const run = (agent, request, extra = {}) => selectTools({ agent, grants: agent.tools, request, availability, projectId: "p1", ...extra });

test("every tool has complete bilingual discovery and exact required-input metadata", () => {
  for (const tool of TOOLS) {
    assert.ok(["A", "B", "C"].includes(tool.tier));
    for (const key of ["intents", "categories", "sideEffects", "dataSources", "needs"]) assert.ok(Array.isArray(tool[key]), `${tool.id}.${key}`);
    assert.ok(tool.latencyClass && tool.costClass);
    assert.ok(tool.discovery.keywords.length >= 2, tool.id);
    assert.ok(tool.intents.some(s => /[a-z]/i.test(s)), `${tool.id}: English intent`);
    assert.ok(tool.intents.some(s => /[؀-ۿ]/u.test(s)), `${tool.id}: Arabic intent`);
    assert.ok(tool.categories.length && tool.sideEffects.length && tool.dataSources.length, tool.id);
    assert.deepEqual(tool.needs, Object.keys(tool.input).filter(k => tool.input[k].required));
    assert.equal(tool.tier, tool.approval !== "none" || ["proposal", "external-read"].includes(tool.sideEffect) ? "C" : tool.readOnly ? "A" : "B", tool.id);
    assert.equal(typeof tool.summarizeAr, "function");
    assert.match(tool.summarizeAr({ ok: false }), /لم تتوفر/);
    assert.ok(tool.discovery.keywords.every(s => typeof s === "string" && s.length));
    assert.deepEqual(tool.discovery.requiredInputs, Object.keys(tool.input).filter(k => tool.input[k].required));
  }
});
test("Arabic normalization removes marks/tatweel and folds letter variants deterministically", () => {
  assert.equal(normalizeToolText(" إِنْشَاءُ مـَهْمَة  "), normalizeToolText("انشاء مهمه"));
  assert.equal(normalizeToolText("آ إ أ ٱ ى ة"), "ا ا ا ا ي ه");
});
for (const [id, request, expected] of [
  ["ori", "company overview", "company.overview"],
  ["mia", "تصميم بطاقة حالة مشروع", "design.statusCard"],
  ["nex", "مقارنة المزودين والنماذج", "telemetry.providerCompare"],
  ["luna", "تصدير مواعيد المهام للتقويم", "calendar.exportTasks"],
  ["zen", "حداثة مصادر المعرفة", "knowledge.freshness"],
  ["rex", "فحص الأسرار", "security.gitleaks"]
]) test(`${id} representative request selects granted specialist`, () => {
  const result = run(AGENTS.find(a => a.id === id), request);
  assert.ok(result.selected.some(t => t.toolId === expected));
});
test("custom sam uses explicit grants, not builtin identity or role", () => {
  const sam = { id: "sam", tools: ["knowledge.freshness"], active: true, enabled: true, availability: "active" };
  assert.equal(run(sam, "knowledge source freshness").selected[0].toolId, "knowledge.freshness");
  assert.equal(run(sam, "knowledge source freshness", { grants: [] }).selected.length, 0);
});
test("rejects ungranted, unavailable and missing required inputs", () => {
  const agent = AGENTS.find(a => a.id === "rex");
  const result = run(agent, "فحص الأسرار", { projectId: undefined, availability: { "security.gitleaks": true } });
  assert.ok(result.rejected.some(t => t.toolId === "security.gitleaks" && t.reason === "missing-input"));
  assert.ok(result.rejected.some(t => t.toolId === "design.statusCard" && t.reason === "not-granted"));
  assert.ok(result.rejected.some(t => t.toolId === "security.scan" && t.reason === "unavailable"));
  assert.equal(run({ ...agent, enabled: false }, "فحص الأسرار").selected.length, 0);
});
test("task creation derives bounded owner title; other required inputs are never guessed", () => {
  const ori = AGENTS[0];
  for (const request of ["Do not create a task; explain process", "لا تنشئ مهمة", "متعملش مهمة", "مش عايز إنشاء مهمة", 'Example: "create task review"', '"إنشاء مهمة مراجعة"']) assert.ok(!run(ori, request).selected.some(t => t.toolId === "tasks.create"), request);
  const result = run(ori, "إنشاء مهمة مراجعة المشروع");
  assert.equal(result.selected.find(t => t.toolId === "tasks.create").input.title, "إنشاء مهمة مراجعة المشروع");
  assert.ok(run(ori, "update task status").rejected.some(t => t.toolId === "tasks.update" && t.reason === "missing-input"));
});
test("owner colloquial requests and summaries remain useful", () => {
  for (const [id, request, toolId] of [["ori", "اولويات النهارده", "company.overview"], ["nex", "الحصص", "quota.read"], ["nex", "حالة النماذج", "telemetry.providerCompare"], ["rex", "امنيأ", "security.scan"]]) {
    assert.ok(run(AGENTS.find(a => a.id === id), request).selected.some(t => t.toolId === toolId), request);
  }
  assert.match(TOOLS.find(t => t.id === "tasks.query").summarizeAr([{ id: "1" }]), /1/);
  assert.match(TOOLS.find(t => t.id === "company.overview").summarizeAr({ overdue: [1, 2] }), /المتأخرة: 2/);
});
test("generic single tokens do not select tools and domain/specialization rank relevant intent", () => {
  const nex = AGENTS.find(a => a.id === "nex");
  for (const [request, toolId] of [["usage", "usage.read"], ["quota", "quota.read"]]) assert.ok(run(nex, request).selected.some(t => t.toolId === toolId));
  assert.equal(run(nex, "حالة").selected.length, 0);
  const base = { id: "sam", tools: ["knowledge.freshness"] };
  assert.equal(run(base, "source").selected.length, 0);
  const plain = run(base, "knowledge source freshness").selected[0];
  const specialized = run({ ...base, policyDomain: "research", specializations: ["knowledge source freshness"] }, "knowledge source freshness").selected[0];
  assert.ok(specialized.score > plain.score);
  assert.equal(run({ ...base, policyDomain: "research", specializations: ["source"] }, "source").selected.length, 0);
});
test("ordinary owner requests select relevant tools without unrelated specialties", () => {
  for (const [id, request, expected] of [
    ["nex", "راجع استهلاكنا وحالة النماذج والحصص", ["usage.read", "telemetry.providerCompare", "quota.read"]],
    ["ori", "راجع حالة مشاريعي وجهز أولويات النهارده", ["company.overview", "tasks.query"]],
    ["rex", "افحص المستودع أمنيا", ["security.scan"]],
    ["luna", "راجع المواعيد النهائية deadlines", ["tasks.query", "calendar.exportTasks"]],
    ["zen", "ابحث عن مصادر بحث research", ["knowledge.search"]]
  ]) {
    const agent = AGENTS.find(a => a.id === id);
    const result = run(agent, request, { grants: [...agent.tools, ...V5_AGENT_TOOLS[id], ...VPS_AGENT_TOOLS[id]] });
    for (const toolId of expected) assert.ok(result.selected.some(t => t.toolId === toolId), `${id}: ${toolId}`);
    if (id === "nex") assert.ok(result.selected.every(t => !/^(security|design)\./.test(t.toolId)));
    if (id === "zen") assert.equal(result.selected.find(t => t.toolId === "knowledge.search").input.q, request);
  }
  const mia = run(AGENTS.find(a => a.id === "mia"), "افحص الأسرار secret scan");
  assert.ok(mia.rejected.some(t => t.toolId === "security.gitleaks" && t.reason === "not-granted"));
});
test("pure stable selection validates input, bounds candidates and preserves approval", () => {
  const rex = AGENTS.find(a => a.id === "rex");
  const opts = { agent: rex, grants: rex.tools, availability, request: "osv dependency vulnerabilities", projectId: "p1", maxTools: 1 };
  const before = JSON.stringify(opts);
  assert.deepEqual(selectTools(opts), selectTools(opts));
  assert.equal(JSON.stringify(opts), before);
  assert.equal(selectTools(opts).selected[0].requiresApproval, true);
  assert.equal(selectTools({ ...opts, maxTools: 0 }).selected.length, 0);
  assert.ok(selectTools({ ...opts, inputs: { "security.osv": { unexpected: true } } }).rejected.some(t => t.toolId === "security.osv" && t.reason === "invalid-inputs"));
  assert.equal(selectTools().selected.length, 0);
});
