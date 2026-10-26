/* ORI's bounded multi-agent orchestration. A workflow is a reviewed template materialized into a persisted plan: each
 * step names one specialist, one approved tool and its inputs (only the context that step needs, never the company
 * database), its dependencies and its delegation depth. ORI runs ready steps in parallel up to the limit, under a
 * deadline and an inference cap; approval-gated tools wait for the owner; every state change is an event; a restarted
 * Bridge resumes the same plan. Tool steps are deterministic; ORI's single synthesis is the only model call, and it
 * must cite the evidence ids it was given. Specialists cannot add steps, grant themselves tools or approve anything. */
import { agentById, toolById } from "./catalog.mjs";
import { HttpError } from "./company.mjs";
import { newId, parseJson } from "./db.mjs";
import { redact, text } from "./util.mjs";

export const LIMITS = { maxDepth: 2, maxParallel: 3, deadlineMs: 10 * 60_000, maxInferences: 1 };
const HARD = { maxParallel: [1, 3], deadlineMs: [60_000, 30 * 60_000] };
const TERMINAL = new Set(["succeeded", "failed", "skipped", "cancelled"]);
const STEP_AR = { pending: "بانتظار دوره", running: "قيد التنفيذ", succeeded: "اكتمل", failed: "فشل", skipped: "تُخطّي", cancelled: "أُلغي", "waiting-approval": "بانتظار موافقة المالك" };

const tool = (key, agent, toolId, title, input, opts = {}) => ({ key, agent, kind: "tool", tool: toolId, title, input, depth: 1, dependsOn: [], ...opts });
const synthesis = (title, dependsOn, focus) => ({ key: "synthesis", agent: "ori", kind: "synthesis", title, dependsOn, depth: 1, focus });
const followups = () => ({ key: "followups", agent: "luna", kind: "followups", title: "تحويل توصيات ORI إلى مهام متابعة", dependsOn: ["synthesis"], depth: 2, optional: true });

/** Reviewed workflow templates. `input(ctx)` builds a step's inputs from the validated workflow inputs only. */
export const TEMPLATES = {
  project_review: {
    ar: "مراجعة مشروع", description: "حالة المشروع والمهام وحالة Git وحداثة المعرفة وفحص أمني حتمي وبطاقة حالة مصممة، ثم خلاصة ORI ومهام متابعة.",
    inputs: { projectId: "required" },
    steps: (c) => [
      tool("overview", "nex", "company.overview", "قياس حالة المشروع والمهام", { projectId: c.projectId }),
      tool("git", "nex", "git.status", "حالة نسخ Git المحلية", { projectId: c.projectId }),
      tool("knowledge", "zen", "knowledge.freshness", "حداثة مصادر المعرفة", { projectId: c.projectId }, { optional: true }),
      tool("security", "rex", "security.scan", "فحص أمني حتمي", { projectId: c.projectId }),
      tool("card", "mia", "design.statusCard", "بطاقة حالة المشروع", { projectId: c.projectId }, { optional: true }),
      synthesis("خلاصة ORI للمراجعة", ["overview", "git", "knowledge", "security", "card"], "الحالة الفعلية، المخاطر، الأولويات التالية"),
      followups()
    ]
  },
  security_review: {
    ar: "مراجعة أمن المستودع", description: "فحص REX للأسرار في السجل والتغييرات غير المحفوظة وثغرات الاعتماديات (بموافقتك) وحالة Git، ثم خلاصة ORI.",
    inputs: { projectId: "required" },
    steps: (c) => [
      tool("baseline", "rex", "security.scan", "فحوص حتمية للمستودع", { projectId: c.projectId }),
      tool("secrets-history", "rex", "security.gitleaks", "أسرار في آخر 300 Commit", { projectId: c.projectId, mode: "history" }),
      tool("secrets-pending", "rex", "security.gitleaks", "أسرار في التغييرات غير المحفوظة", { projectId: c.projectId, mode: "uncommitted" }),
      tool("dependencies", "rex", "security.osv", "ثغرات الاعتماديات (OSV)", { projectId: c.projectId }, { optional: true }),
      tool("git", "nex", "git.status", "حالة Git والرفع", { projectId: c.projectId }),
      synthesis("خلاصة ORI الأمنية", ["baseline", "secrets-history", "secrets-pending", "dependencies", "git"], "المخاطر حسب الخطورة مع الدليل، وما لم يُفحص"),
      followups()
    ]
  },
  weekly_report: {
    ar: "تقرير الشركة الأسبوعي", description: "لقطة الشركة، أداء الوكلاء خلال 7 أيام، الموافقات المعلقة، تقرير PDF عربي وتقويم المواعيد، ثم خلاصة ORI.",
    inputs: {},
    steps: () => [
      tool("overview", "ori", "company.overview", "لقطة تشغيل الشركة", {}),
      tool("agents", "nex", "telemetry.agentStats", "أداء الوكلاء خلال 7 أيام", { range: "7d" }),
      tool("approvals", "luna", "approvals.list", "الموافقات المعلّقة", {}),
      tool("pdf", "luna", "report.executionPdf", "تقرير التنفيذ PDF", { rangeDays: 7 }, { optional: true }),
      tool("calendar", "luna", "calendar.exportTasks", "تقويم المواعيد القادمة", {}, { optional: true }),
      synthesis("خلاصة ORI الأسبوعية", ["overview", "agents", "approvals", "pdf", "calendar"], "ما أُنجز، ما تأخر، ما يحتاج قرار المالك")
    ]
  },
  resource_audit: {
    ar: "تدقيق موارد الذكاء الاصطناعي", description: "حصص المزوّدين واستهلاك OmniRoute وأداء الوكلاء والنماذج والأدوات خلال 30 يومًا، ثم توصيات ORI.",
    inputs: {},
    steps: () => [
      tool("quota", "nex", "quota.read", "حصص المزوّدين", {}, { optional: true }),
      tool("usage", "nex", "usage.read", "استهلاك OmniRoute", {}, { optional: true }),
      tool("agents", "nex", "telemetry.agentStats", "أداء الوكلاء (30 يومًا)", { range: "30d" }),
      tool("providers", "nex", "telemetry.providerCompare", "مقارنة النماذج (30 يومًا)", { range: "30d" }),
      tool("tools", "nex", "telemetry.toolLatency", "موثوقية الأدوات (7 أيام)", { range: "7d" }),
      synthesis("توصيات ORI للموارد", ["quota", "usage", "agents", "providers", "tools"], "الاستهلاك الفعلي مقابل غير المعروف، النماذج الموثوقة، التوصيات دون تغيير أي إعداد")
    ]
  },
  research_brief: {
    ar: "موجز بحث تقني", description: "ZEN يستخلص حتى 3 صفحات من مواقع معتمدة ويبحث في المعرفة المحلية، ثم موجز ORI مع المراجع.",
    inputs: { topic: "required", urls: "optional", projectId: "optional" },
    steps: (c) => [
      ...(c.urls || []).map((url, i) => tool(`page-${i + 1}`, "zen", "web.extract", `استخلاص المصدر ${i + 1}`, { url, ingest: true, ...(c.projectId ? { projectId: c.projectId } : {}) }, { optional: true })),
      tool("search", "zen", "knowledge.search", "بحث في المعرفة المعتمدة", { q: c.topic, ...(c.projectId ? { projectId: c.projectId } : {}), limit: 8 }, { dependsOn: (c.urls || []).map((_, i) => `page-${i + 1}`) }),
      synthesis("موجز ORI البحثي", [...(c.urls || []).map((_, i) => `page-${i + 1}`), "search"], `الموضوع: ${c.topic}. افصل المثبت بالمصدر عن التفسير، واذكر المرجع لكل ادعاء`)
    ]
  },
  release_readiness: {
    ar: "جاهزية الإصدار", description: "حالة Git وفحص الأسرار في التغييرات غير المحفوظة والفحص الحتمي وحداثة التوثيق والمهام والموافقات المعلقة، ثم حكم ORI.",
    inputs: { projectId: "required" },
    steps: (c) => [
      tool("git", "nex", "git.status", "حالة Git والرفع", { projectId: c.projectId }),
      tool("security", "rex", "security.scan", "فحص أمني حتمي", { projectId: c.projectId }),
      tool("secrets", "rex", "security.gitleaks", "أسرار في التغييرات غير المحفوظة", { projectId: c.projectId, mode: "uncommitted" }),
      tool("docs", "zen", "knowledge.freshness", "حداثة التوثيق المفهرس", { projectId: c.projectId }, { optional: true }),
      tool("work", "ori", "company.overview", "المهام المفتوحة والمتعطلة", { projectId: c.projectId }),
      tool("approvals", "luna", "approvals.list", "الموافقات المعلّقة", {}),
      synthesis("حكم ORI على الجاهزية", ["git", "security", "secrets", "docs", "work", "approvals"], "هل المشروع جاهز للإصدار؟ اذكر العوائق بالدليل وما لم يُتحقق منه"),
      followups()
    ]
  }
};

/** Evidence ids cited in a synthesis: single ([E1]) and grouped ([E2, E4] / [E2، E4]) forms, in order of first use. */
export function citations(textValue) {
  const ids = [];
  for (const group of String(textValue).matchAll(/\[(E\d+(?:\s*[,،]\s*E\d+)*)\]/g)) for (const id of group[1].split(/\s*[,،]\s*/)) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** One-line Arabic summary of a tool result for the Operations Room (the full result stays in the audit). */
export function summarizeResult(toolId, r) {
  if (!r || typeof r !== "object") return "لا مخرجات";
  switch (toolId) {
    case "company.overview": return `مهام مفتوحة ${r.tasks?.open ?? 0} · متأخرة ${r.tasks?.overdue?.length ?? 0} · متعطلة ${r.tasks?.blocked?.length ?? 0} · موافقات معلّقة ${r.approvalsPending ?? 0}`;
    case "git.status": return r.checkouts?.length ? r.checkouts.map((c) => `${c.rel}: ${c.branch ?? "?"}${c.dirty ? ` · ${c.changedFiles} متغيّر` : " · نظيف"}${c.ahead ? ` · ${c.ahead} غير مرفوع` : ""}`).join(" | ") : "لا توجد نسخة محلية مرتبطة";
    case "security.scan": return `${r.findings?.length ?? 0} ملاحظة حتمية${r.findings?.some((f) => f.level === "critical") ? " (منها حرجة)" : ""}`;
    case "security.gitleaks": return r.checkouts?.some((c) => !c.ok) ? `لم يكتمل الفحص لبعض النسخ · ${r.findings} نتيجة` : `${r.findings} نتيجة محتملة${r.findingsInTestFiles ? ` (${r.findingsInTestFiles} منها في ملفات اختبار، غالبًا قيم تجريبية تحتاج مراجعة)` : ""} (${r.method})`;
    case "security.osv": return `${r.vulnerablePackages} حزمة لها تنبيهات معروفة`;
    case "knowledge.freshness": return `حديث ${r.summary?.fresh ?? 0} · تغيّر ${r.summary?.changed ?? 0} · قديم ${r.summary?.stale ?? 0} · غير متاح ${r.summary?.missing ?? 0}`;
    case "knowledge.search": return `${r.results?.length ?? 0} مرجع مطابق`;
    case "web.extract": return `${r.title || r.url} · ${r.characters} حرفًا${r.suspectedInstructions ? " · نص موجّه للذكاء الاصطناعي (لم يُنفّذ)" : ""}`;
    case "design.statusCard": case "design.brandGraphic": return "صورة محفوظة في الملفات الناتجة";
    case "report.executionPdf": return `تقرير PDF محفوظ · مفتوحة ${r.counts?.open ?? 0} · متأخرة ${r.counts?.overdue ?? 0}`;
    case "calendar.exportTasks": return `تقويم بـ ${r.events} موعد`;
    case "approvals.list": return `${r.approvals?.length ?? 0} طلب موافقة معلّق${r.serverActions?.length ? ` · ${r.serverActions.length} إجراء خادم` : ""}`;
    case "telemetry.agentStats": return `${(r.agents || []).reduce((s, a) => s + a.runs, 0)} تشغيل · ${(r.agents || []).reduce((s, a) => s + a.cost.unknownEvents, 0)} بتكلفة غير معروفة`;
    case "telemetry.providerCompare": return `${r.models?.length ?? 0} نموذج مرصود`;
    case "telemetry.toolLatency": return `${r.tools?.length ?? 0} أداة مقيسة`;
    case "quota.read": return r.available ? `${r.connections?.length ?? 0} اتصال مزوّد` : `غير متاح (${r.reason})`;
    case "usage.read": return r.available ? `${r.summary?.requests ?? 0} طلب عبر الراوتر` : `غير متاح (${r.reason})`;
    default: return "اكتمل";
  }
}

export function createOrchestrator({ company, internals, telemetry, now = Date.now }) {
  const { db } = company;
  const iso = (ms = now()) => new Date(ms).toISOString();
  const active = new Map(); // workflowId -> { controllers: Map(stepId -> AbortController) }

  // ------------------------------------------------------------------ persistence helpers
  const wfRow = (r) => r && ({ id: r.id, template: r.template, title: r.title, objective: r.objective, primaryAgent: r.primary_agent, projectId: r.project_id, parentRunId: r.parent_run_id, status: r.status,
    limits: parseJson(r.limits, LIMITS), input: parseJson(r.input, {}), report: r.report, evidence: parseJson(r.evidence, []), errorCode: r.error_code, errorMessage: r.error_message,
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, updatedAt: r.updated_at });
  const stepRow = (r) => r && ({ id: r.id, workflowId: r.workflow_id, ordinal: r.ordinal, key: r.key, agentId: r.agent_id, kind: r.kind, title: r.title, dependsOn: parseJson(r.depends_on, []), depth: r.depth, optional: r.optional === 1,
    toolId: r.tool_id, input: parseJson(r.input, {}), expected: r.expected, status: r.status, statusAr: STEP_AR[r.status], runId: r.run_id, executionId: r.execution_id, approvalId: r.approval_id,
    output: parseJson(r.output, r.output), evidence: parseJson(r.evidence, []), errorCode: r.error_code, errorMessage: r.error_message, attempts: r.attempts, startedAt: r.started_at, finishedAt: r.finished_at });
  const setWf = (id, fields) => { const keys = Object.keys(fields); db.run(`UPDATE workflows SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), iso(), id); };
  const setStep = (id, fields) => { const keys = Object.keys(fields); db.run(`UPDATE workflow_steps SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => fields[k]), id); };
  const event = (workflowId, kind, { stepId = null, agentId = null, ...detail } = {}) => db.run("INSERT INTO workflow_events (workflow_id, step_id, at, kind, agent_id, detail) VALUES (?,?,?,?,?,?)", workflowId, stepId, iso(), kind, agentId, JSON.stringify(detail));
  const steps = (workflowId) => db.all("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY ordinal", workflowId).map(stepRow);
  const getRaw = (id) => { const r = db.get("SELECT * FROM workflows WHERE id = ?", String(id)); if (!r) throw new HttpError(404, "not-found", "سير العمل غير موجود"); return wfRow(r); };

  // ------------------------------------------------------------------ create (validate inputs, materialize and bound the plan)
  function validateInputs(template, raw = {}) {
    const def = TEMPLATES[template];
    if (!def) throw new HttpError(422, "unknown-template", "قالب سير العمل غير معروف");
    const input = {};
    for (const key of Object.keys(raw)) if (!(key in def.inputs) && !["limits", "priority"].includes(key)) throw new HttpError(422, "invalid-workflow-input", `حقل غير معروف: ${key}`);
    if (def.inputs.projectId) {
      if (raw.projectId) input.projectId = company.getProject(String(raw.projectId)).id;
      else if (def.inputs.projectId === "required") throw new HttpError(422, "validation", "اختر المشروع");
    }
    if (def.inputs.topic) {
      const topic = typeof raw.topic === "string" ? text(raw.topic, 200) : "";
      if (!topic && def.inputs.topic === "required") throw new HttpError(422, "validation", "اكتب موضوع البحث");
      input.topic = topic;
    }
    if (def.inputs.urls && raw.urls != null) {
      if (!Array.isArray(raw.urls) || raw.urls.length > 3 || !raw.urls.every((u) => typeof u === "string" && u.length <= 2000 && /^https?:\/\//i.test(u))) throw new HttpError(422, "validation", "حتى 3 روابط http(s) فقط");
      input.urls = [...new Set(raw.urls.map((u) => u.trim()))];
    }
    return input;
  }
  function boundedLimits(requested = {}) {
    const limits = { ...LIMITS };
    if (requested.maxParallel != null) { if (!Number.isInteger(requested.maxParallel) || requested.maxParallel < HARD.maxParallel[0] || requested.maxParallel > HARD.maxParallel[1]) throw new HttpError(422, "validation", "عدد المتخصصين المتزامنين من 1 إلى 3"); limits.maxParallel = requested.maxParallel; }
    if (requested.deadlineMinutes != null) { const ms = requested.deadlineMinutes * 60_000; if (!Number.isInteger(requested.deadlineMinutes) || ms < HARD.deadlineMs[0] || ms > HARD.deadlineMs[1]) throw new HttpError(422, "validation", "المهلة من 1 إلى 30 دقيقة"); limits.deadlineMs = ms; }
    return limits;
  }
  /** Materializes the template and rejects any plan outside the bounds: unknown agent or tool, a tool the agent was never
   * granted, a dependency cycle or missing step, depth above the limit, more than one synthesis. */
  function plan(template, input, limits) {
    const list = TEMPLATES[template].steps(input);
    const keys = new Set(list.map((s) => s.key));
    if (keys.size !== list.length) throw new HttpError(500, "plan-invalid", "مفاتيح خطوات مكررة");
    if (list.filter((s) => s.kind === "synthesis").length > limits.maxInferences) throw new HttpError(422, "plan-invalid", "الخطة تتجاوز حد الاستدلال");
    for (const step of list) {
      if (!company.agentById(step.agent)) throw new HttpError(500, "plan-invalid", `وكيل غير معروف: ${step.agent}`);
      if (step.depth > limits.maxDepth) throw new HttpError(422, "plan-depth", "عمق التفويض يتجاوز الحد");
      if (step.kind === "tool" && (!toolById(step.tool) || !company.agentById(step.agent).tools.includes(step.tool))) throw new HttpError(500, "plan-invalid", `الأداة ${step.tool} ليست ضمن أدوات ${step.agent}`);
      for (const dep of step.dependsOn) if (!keys.has(dep)) throw new HttpError(500, "plan-invalid", `اعتماد مفقود: ${dep}`);
    }
    const order = new Map(list.map((s, i) => [s.key, i]));
    for (const step of list) for (const dep of step.dependsOn) if (order.get(dep) >= order.get(step.key)) throw new HttpError(500, "plan-cycle", "ترتيب الخطوات يحتوي اعتمادًا دائريًا أو لاحقًا");
    return list;
  }
  function create({ template, projectId = null, topic = null, urls = null, limits: requested = {}, priority = "medium" } = {}, actor = { type: "owner", id: "owner" }) {
    if (actor.type !== "owner") throw new HttpError(403, "owner-only", "بدء سير عمل متعدد الوكلاء للمالك فقط");
    const raw = Object.fromEntries(Object.entries({ projectId, topic, urls }).filter(([, v]) => v != null && v !== ""));
    const input = validateInputs(template, raw);
    const limits = boundedLimits(requested);
    const list = plan(template, input, limits);
    const def = TEMPLATES[template];
    const id = newId("wf");
    const title = `${def.ar}${input.projectId ? ` — ${company.getProject(input.projectId).name}` : input.topic ? ` — ${input.topic}` : ""}`;
    db.tx(() => {
      db.run("INSERT INTO workflows (id, template, title, objective, primary_agent, project_id, status, limits, input, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        id, template, text(title, 200), def.description, "ori", input.projectId ?? null, "queued", JSON.stringify(limits), JSON.stringify(input), iso(), iso());
      list.forEach((step, ordinal) => db.run(`INSERT INTO workflow_steps (id, workflow_id, ordinal, key, agent_id, kind, title, depends_on, depth, optional, tool_id, input, expected, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        newId("stp"), id, ordinal, step.key, step.agent, step.kind, step.title, JSON.stringify(step.dependsOn), step.depth, step.optional ? 1 : 0, step.tool ?? null, JSON.stringify(step.input ?? {}), step.focus ?? null, "pending"));
      const runId = internals.insertRun({ agentId: "ori", capability: "orchestration", domain: company.agentConfig("ori").policyDomain, mode: company.agentConfig("ori").mode, priority: ["high", "medium", "low"].includes(priority) ? priority : "medium",
        request: text(title, 400), projectId: input.projectId ?? null, workflowId: id, status: "queued" });
      setWf(id, { parent_run_id: runId });
      event(id, "created", { agentId: "ori", template, limits, steps: list.length });
      for (const step of list) event(id, "delegated", { agentId: step.agent, step: step.key, tool: step.tool ?? step.kind, depth: step.depth });
      company.log({ actorType: actor.type, actorId: actor.id, action: "workflow.created", targetType: input.projectId ? "project" : "workflow", targetId: input.projectId ?? id, outcome: "pending", summary: `ORI يبدأ «${title}» مع ${new Set(list.map((s) => s.agent)).size} وكلاء`, metadata: { workflowId: id, runId } });
    });
    setImmediate(internals.pump);
    return get(id);
  }

  // ------------------------------------------------------------------ execution
  function evidenceOf(workflowId) {
    return steps(workflowId).filter((s) => s.status === "succeeded" && s.kind === "tool").map((s, i) => ({ id: `E${i + 1}`, step: s.key, agentId: s.agentId, tool: s.toolId, executionId: s.executionId, summary: s.output?.summary ?? null, artifactIds: s.evidence?.[0]?.artifactIds ?? [] }));
  }
  /** A delegated step's own run row, so accounting, audit and the run history attribute the work to the specialist. */
  function childRun(wf, step, capability) {
    const config = company.agentConfig(step.agentId);
    const id = internals.insertRun({ agentId: step.agentId, capability, domain: config.policyDomain, mode: config.mode, priority: "medium", request: text(step.title, 300), projectId: wf.projectId, workflowId: wf.id, parentRunId: wf.parentRunId, status: "running" });
    internals.setRun(id, { started_at: iso() });
    return id;
  }
  async function runToolStep(wf, step, signal, span) {
    const def = toolById(step.toolId);
    const approval = step.approvalId ? company.getApproval(step.approvalId) : null;
    if (def.approval === "always" && approval?.status !== "approved") {
      if (approval?.status === "rejected") { setStep(step.id, { status: "skipped", finished_at: iso(), error_code: "rejected-by-owner", error_message: "رفض المالك هذه الخطوة" }); event(wf.id, "step-skipped", { stepId: step.id, agentId: step.agentId, reason: "rejected-by-owner" }); return; }
      if (!approval) {
        const created = company.createApproval({ kind: "workflow.step", requestedBy: `agent:${step.agentId}`, title: `${company.agentById(step.agentId).name}: ${step.title}`, summary: `${def.descriptionAr || def.description} — ضمن «${wf.title}».`,
          payload: { workflowId: wf.id, stepId: step.id, agentId: step.agentId, toolId: step.toolId, input: step.input }, risk: def.network && def.network !== "none" ? "data-egress" : "medium" });
        setStep(step.id, { status: "waiting-approval", approval_id: created.id });
        event(wf.id, "approval-requested", { stepId: step.id, agentId: step.agentId, approvalId: created.id, tool: step.toolId });
      }
      return;
    }
    const runId = childRun(wf, step, "delegated_tool");
    setStep(step.id, { status: "running", run_id: runId, started_at: iso(), attempts: step.attempts + 1 });
    event(wf.id, "step-started", { stepId: step.id, agentId: step.agentId, tool: step.toolId });
    const toolCalls = [];
    try {
      const result = await internals.invokeTool(step.agentId, step.toolId, step.input, { toolCalls, signal, span, approved: approval?.status === "approved", approvalId: approval?.id, extra: { projectId: wf.projectId, runId, workflowId: wf.id } });
      const summary = summarizeResult(step.toolId, result);
      const executionId = toolCalls.at(-1)?.executionId ?? null;
      const artifactIds = Array.isArray(result?.artifactIds) ? result.artifactIds : [];
      // The step keeps a bounded digest for ORI's synthesis; the full result stays in the tool audit.
      const { artifact, ...rest } = result && typeof result === "object" ? result : { value: result };
      const digest = redact(JSON.stringify(rest), 2400);
      setStep(step.id, { status: "succeeded", finished_at: iso(), execution_id: executionId, output: JSON.stringify({ summary, digest }), evidence: JSON.stringify([{ executionId, artifactIds, summary }]) });
      internals.setRun(runId, { output: digest, cost_basis: "no-inference" });
      internals.finish(runId, "succeeded", { tool_calls: JSON.stringify(toolCalls) }, { notify: false });
      event(wf.id, "step-succeeded", { stepId: step.id, agentId: step.agentId, tool: step.toolId, executionId, artifactIds, summary });
    } catch (error) {
      const cancelled = signal.aborted || error?.code === "cancelled";
      setStep(step.id, { status: cancelled ? "cancelled" : "failed", finished_at: iso(), execution_id: toolCalls.at(-1)?.executionId ?? null, error_code: error?.code || "tool-failed", error_message: redact(error?.messageAr || error?.message || "failed", 240) });
      internals.finish(runId, cancelled ? "cancelled" : "failed", { error_category: error?.code || "tool-failed", error_message: redact(error?.messageAr || error?.message || "failed", 200), cost_basis: "no-inference", tool_calls: JSON.stringify(toolCalls) }, { notify: false });
      event(wf.id, cancelled ? "step-cancelled" : "step-failed", { stepId: step.id, agentId: step.agentId, tool: step.toolId, code: error?.code || "tool-failed", message: redact(error?.messageAr || error?.message || "", 200) });
    }
  }
  async function runSynthesis(wf, step, signal) {
    const evidence = evidenceOf(wf.id);
    const all = steps(wf.id);
    const failed = all.filter((s) => s.kind === "tool" && ["failed", "skipped", "cancelled"].includes(s.status)).map((s) => ({ step: s.key, agent: s.agentId, tool: s.toolId, status: s.status, reason: s.errorMessage }));
    const runId = childRun(wf, step, "synthesis");
    setStep(step.id, { status: "running", run_id: runId, started_at: iso(), attempts: step.attempts + 1 });
    event(wf.id, "step-started", { stepId: step.id, agentId: "ori", tool: "synthesis" });
    const def = company.agentById("ori");
    const config = company.agentConfig("ori");
    const digests = Object.fromEntries(all.filter((s) => s.status === "succeeded" && s.kind === "tool").map((s, i) => [`E${i + 1}`, { step: s.title, agent: company.agentById(s.agentId).name, tool: s.toolId, summary: s.output?.summary, data: s.output?.digest }]));
    const { json, warnings } = internals.assembleContext({ objective: wf.title, focus: step.expected, evidence: digests, notVerified: failed, memory: internals.memoryContext("ori", wf.projectId, wf.title) }, { compact: true });
    const messages = [
      { role: "system", content: `${internals.systemPrompt(def, config, "project_assessment")}\nأنت تنسّق فريقًا: كل دليل مرفق نتيجة أداة حتمية نفّذها متخصص. اعتمد عليها فقط. اذكر معرّف الدليل بين قوسين مربعين مثل [E1] بعد كل ادعاء. اذكر صراحة ما لم يُتحقق منه.` },
      { role: "user", content: `الهدف: ${wf.title}\nالتركيز: ${step.expected}\nاكتب بإيجاز (حتى 300 كلمة): 1) الخلاصة 2) ما هو مثبت مع [E#] 3) المخاطر والعوائق 4) ما لم يُفحص 5) الخطوات التالية.\n\nالأدلة (JSON):\n${json}` }
    ];
    const policy = company.getPolicy(config.policyDomain);
    const approval = step.approvalId ? company.getApproval(step.approvalId) : null;
    const result = await internals.infer(runId, { def, config, capability: "project_assessment", messages, policy, priority: "medium", signal, approvedRef: approval?.status === "approved" ? approval.payload?.model : null });
    if (signal.aborted) { setStep(step.id, { status: "cancelled", finished_at: iso() }); internals.finish(runId, "cancelled", { error_category: "cancelled", error_message: "أُلغي" }, { notify: false }); event(wf.id, "step-cancelled", { stepId: step.id, agentId: "ori" }); return; }
    if (!result.ok) {
      if (result.category === "approval-required") {
        const created = company.createApproval({ kind: "agent.paid_inference", requestedBy: "agent:ori", title: `استدلال مدفوع لخلاصة «${wf.title}»`, summary: result.message, payload: { runId, model: result.needsApproval.ref, class: result.needsApproval.class, workflowId: wf.id, stepId: step.id }, risk: "spend" });
        setStep(step.id, { status: "waiting-approval", approval_id: created.id, run_id: runId });
        internals.finish(runId, "blocked", { error_category: "approval-required", error_message: result.message, approval_id: created.id }, { notify: false });
        event(wf.id, "approval-requested", { stepId: step.id, agentId: "ori", approvalId: created.id, tool: "synthesis" });
        return;
      }
      setStep(step.id, { status: "failed", finished_at: iso(), error_code: result.category, error_message: redact(result.message || result.category, 240) });
      internals.finish(runId, ["budget-exceeded", "no-eligible-model"].includes(result.category) ? "blocked" : "failed", { error_category: result.category, error_message: result.message }, { notify: false });
      event(wf.id, "step-failed", { stepId: step.id, agentId: "ori", tool: "synthesis", code: result.category, message: redact(result.message || "", 200) });
      return;
    }
    const cited = citations(result.content).filter((id) => digests[id]);
    let output = result.content.slice(0, 20000);
    if (warnings.length) output += `\n\n—\nملاحظة النظام: ${warnings.join("; ")}`;
    db.tx(() => {
      internals.recordUsage(runId, "ori", result.provider, result.model, result.promptTokens, result.completionTokens, result.costUsd);
      internals.setRun(runId, { output, effective_model: result.model, provider: result.provider, connection_id: result.connectionId, prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens,
        reasoning_tokens: result.reasoningTokens, cost_usd: result.costUsd, cost_basis: result.costUsd == null ? "unknown" : "router-estimate", latency_ms: result.latencyMs });
      setStep(step.id, { status: "succeeded", finished_at: iso(), output: JSON.stringify({ summary: `خلاصة تستند إلى ${cited.length} من ${evidence.length} دليل`, text: output, cited, model: result.model }) });
    });
    internals.finish(runId, "succeeded", {}, { notify: false });
    event(wf.id, "step-succeeded", { stepId: step.id, agentId: "ori", tool: "synthesis", cited, model: result.model, uncited: cited.length === 0 && evidence.length > 0 });
  }
  async function runFollowups(wf, step) {
    const synth = steps(wf.id).find((s) => s.kind === "synthesis");
    const parsed = synth?.output?.text ? internals.extractJson(synth.output.text) : null;
    const runId = childRun(wf, step, "followups");
    setStep(step.id, { status: "running", run_id: runId, started_at: iso(), attempts: step.attempts + 1 });
    const calls = [];
    const created = await internals.createFollowups("luna", parsed?.tasks, wf.projectId, calls);
    const made = created.filter((c) => c.id);
    internals.setRun(runId, { output: JSON.stringify({ requested: Array.isArray(parsed?.tasks) ? parsed.tasks.length : 0, created }).slice(0, 4000), cost_basis: "no-inference" });
    internals.finish(runId, "succeeded", { tool_calls: JSON.stringify(calls) }, { notify: false });
    setStep(step.id, { status: "succeeded", finished_at: iso(), output: JSON.stringify({ summary: `${made.length} مهمة متابعة${created.length - made.length ? ` · ${created.length - made.length} موجودة أو مرفوضة` : ""}`, tasks: made.map((t) => ({ id: t.id, title: t.title })) }) });
    event(wf.id, "step-succeeded", { stepId: step.id, agentId: "luna", tool: "followups", created: made.length });
  }
  /** A step may start when every dependency is terminal; follow-ups additionally need a successful synthesis. */
  function ready(all, step) {
    if (step.status !== "pending") return false;
    const byKey = new Map(all.map((s) => [s.key, s]));
    if (!step.dependsOn.every((k) => TERMINAL.has(byKey.get(k)?.status))) return false;
    if (step.kind === "followups" && byKey.get("synthesis")?.status !== "succeeded") return false;
    return true;
  }
  function report(wf) {
    const all = steps(wf.id);
    const synth = all.find((s) => s.kind === "synthesis");
    const evidence = evidenceOf(wf.id);
    const lines = [`# ${wf.title}`, ""];
    if (synth?.status === "succeeded") lines.push(synth.output.text, "");
    else lines.push(`> لم تُكتب خلاصة ORI (${synth ? STEP_AR[synth.status] : "—"}${synth?.errorMessage ? `: ${synth.errorMessage}` : ""}). النتائج أدناه حتمية من أدوات المتخصصين.`, "");
    lines.push("## الأدلة", ...evidence.map((e) => `- [${e.id}] ${company.agentById(e.agentId).name} · ${e.tool}: ${e.summary}${e.artifactIds.length ? ` (ملفات: ${e.artifactIds.join("، ")})` : ""}`));
    const gaps = all.filter((s) => s.kind === "tool" && s.status !== "succeeded");
    if (gaps.length) lines.push("", "## ما لم يُتحقق منه", ...gaps.map((s) => `- ${company.agentById(s.agentId).name} · ${s.title}: ${STEP_AR[s.status]}${s.errorMessage ? ` — ${s.errorMessage}` : ""}`));
    const fu = all.find((s) => s.kind === "followups");
    if (fu?.status === "succeeded") lines.push("", `## المتابعة`, `- ${fu.output.summary}`);
    return { markdown: lines.join("\n").slice(0, 30000), evidence };
  }
  function settle(wf, status, { code = null, message = null } = {}) {
    const { markdown, evidence } = report(wf);
    setWf(wf.id, { status, finished_at: TERMINAL.has(status) || status === "partial" ? iso() : null, report: markdown, evidence: JSON.stringify(evidence), error_code: code, error_message: message });
    event(wf.id, `workflow-${status}`, { agentId: "ori", evidence: evidence.length, code });
    const runStatus = status === "succeeded" || status === "partial" ? "succeeded" : status === "cancelled" ? "cancelled" : status === "waiting-approval" ? "blocked" : "failed";
    internals.setRun(wf.parentRunId, { output: markdown, cost_basis: "workflow" });
    internals.finish(wf.parentRunId, runStatus, { ...(runStatus !== "succeeded" ? { error_category: code || status, error_message: message || STEP_AR[status] || status } : {}) }, { notify: runStatus === "failed" });
    company.log({ actorType: "agent", actorId: "ori", action: `workflow.${status}`, targetType: wf.projectId ? "project" : "workflow", targetId: wf.projectId ?? wf.id, outcome: status === "succeeded" ? "success" : status === "partial" || status === "waiting-approval" ? "info" : "failure",
      summary: `«${wf.title}»: ${{ succeeded: "اكتمل", partial: "اكتمل جزئيًا", failed: "فشل", cancelled: "أُلغي", "waiting-approval": "بانتظار موافقة المالك" }[status] || status} (${evidence.length} دليل)`, metadata: { workflowId: wf.id } });
  }

  /** Called by the runtime scheduler for the workflow's parent run (capability "orchestration"). */
  async function execute(parentRun, signal, span = null) {
    const wf = getRaw(parentRun.workflow_id);
    if (["succeeded", "partial", "failed", "cancelled"].includes(wf.status)) return internals.finish(parentRun.id, "succeeded", {}, { notify: false });
    // The deadline bounds each execution period, so time spent waiting for the owner’s approval does not consume it.
    const deadlineAt = now() + wf.limits.deadlineMs;
    setWf(wf.id, { status: "running", started_at: wf.startedAt || iso() });
    event(wf.id, wf.startedAt ? "resumed" : "started", { agentId: "ori" });
    const controllers = new Map();
    active.set(wf.id, controllers);
    const abortAll = () => { for (const c of controllers.values()) c.abort(); };
    signal?.addEventListener?.("abort", abortAll, { once: true });
    const inflight = new Map();
    let deadlineHit = false;
    try {
      for (;;) {
        if (signal?.aborted) break;
        if (now() > deadlineAt) { deadlineHit = true; abortAll(); break; }
        const all = steps(wf.id);
        const runnable = all.filter((s) => ready(all, s) && !inflight.has(s.id));
        for (const step of runnable) {
          if (inflight.size >= wf.limits.maxParallel) break;
          // A tool with a concurrency limit (gitleaks runs one at a time) waits its turn instead of failing as tool-busy.
          if (step.kind === "tool" && all.filter((s) => inflight.has(s.id) && s.toolId === step.toolId).length >= (toolById(step.toolId).maxConcurrent ?? 4)) continue;
          const controller = new AbortController();
          controllers.set(step.id, controller);
          const job = (step.kind === "tool" ? runToolStep(wf, step, controller.signal, span) : step.kind === "synthesis" ? runSynthesis(wf, step, controller.signal) : runFollowups(wf, step))
            .catch((error) => { setStep(step.id, { status: "failed", finished_at: iso(), error_code: "runtime-error", error_message: redact(error?.message || "error", 200) }); event(wf.id, "step-failed", { stepId: step.id, agentId: step.agentId, code: "runtime-error" }); })
            .finally(() => { inflight.delete(step.id); controllers.delete(step.id); });
          inflight.set(step.id, job);
        }
        if (!inflight.size) {
          // A follow-up whose synthesis did not succeed can never run: it is skipped rather than left pending.
          const latest = steps(wf.id);
          for (const s of latest.filter((x) => x.status === "pending" && x.kind === "followups" && latest.find((y) => y.key === "synthesis")?.status && TERMINAL.has(latest.find((y) => y.key === "synthesis").status))) {
            setStep(s.id, { status: "skipped", finished_at: iso(), error_code: "no-synthesis", error_message: "لا توجد خلاصة ناجحة لتحويلها إلى مهام" });
          }
          if (!steps(wf.id).some((s) => ready(steps(wf.id), s))) break;
          continue;
        }
        const timeLeft = Math.max(1, deadlineAt - now());
        await Promise.race([...inflight.values(), new Promise((r) => setTimeout(r, Math.min(timeLeft, 1000)))]);
      }
      await Promise.allSettled([...inflight.values()]);
      const all = steps(wf.id);
      if (signal?.aborted || deadlineHit) {
        for (const s of all.filter((x) => ["pending", "running", "waiting-approval"].includes(x.status))) setStep(s.id, { status: "cancelled", finished_at: iso(), error_code: deadlineHit ? "deadline" : "cancelled", error_message: deadlineHit ? "انتهت مهلة سير العمل" : "ألغاه المالك" });
        return settle(getRaw(wf.id), "cancelled", { code: deadlineHit ? "deadline" : "cancelled", message: deadlineHit ? "انتهت مهلة سير العمل" : "ألغاه المالك" });
      }
      if (all.some((s) => s.status === "waiting-approval")) return settle(getRaw(wf.id), "waiting-approval", { code: "approval-required", message: "خطوات بانتظار موافقة المالك" });
      // succeeded: every step succeeded · partial: something useful exists but a step did not complete · failed: nothing did.
      const missingRequired = all.filter((s) => !s.optional && s.status !== "succeeded");
      const status = all.every((s) => s.status === "succeeded") ? "succeeded" : all.some((s) => s.status === "succeeded") ? "partial" : "failed";
      return settle(getRaw(wf.id), status, missingRequired.length ? { code: "steps-incomplete", message: `${missingRequired.length} خطوة أساسية لم تكتمل` } : status === "partial" ? { code: "optional-incomplete", message: "خطوات اختيارية لم تكتمل" } : {});
    } finally {
      active.delete(wf.id);
      signal?.removeEventListener?.("abort", abortAll);
    }
  }

  // ------------------------------------------------------------------ owner controls, approvals, recovery
  function requeue(wf, reason) {
    setWf(wf.id, { status: "queued", finished_at: null });
    internals.setRun(wf.parentRunId, { status: "queued", finished_at: null, error_category: null, error_message: null });
    event(wf.id, "requeued", { agentId: "ori", reason });
    setImmediate(internals.pump);
  }
  /** Approval decisions reach a workflow step only through the owner's decision on the approval itself. */
  function onApprovalDecided(approval, decision) {
    const payload = approval.payload || {};
    if (!payload.workflowId || !payload.stepId) return false;
    const wf = getRaw(payload.workflowId);
    const step = steps(wf.id).find((s) => s.id === payload.stepId);
    if (!step || step.status !== "waiting-approval") return true;
    if (decision === "reject") {
      setStep(step.id, { status: "skipped", finished_at: iso(), error_code: "rejected-by-owner", error_message: "رفض المالك هذه الخطوة" });
      event(wf.id, "approval-rejected", { stepId: step.id, agentId: step.agentId, approvalId: approval.id });
    } else {
      setStep(step.id, { status: "pending" });
      event(wf.id, "approval-granted", { stepId: step.id, agentId: step.agentId, approvalId: approval.id });
    }
    if (wf.status === "waiting-approval") requeue(wf, decision === "reject" ? "approval-rejected" : "approval-granted");
    return true;
  }
  function cancel(id, actor = { type: "owner", id: "owner" }) {
    if (actor.type !== "owner") throw new HttpError(403, "owner-only", "إلغاء سير العمل للمالك فقط");
    const wf = getRaw(id);
    if (["succeeded", "partial", "failed", "cancelled"].includes(wf.status)) throw new HttpError(409, "not-cancellable", "سير العمل منتهٍ");
    const run = db.get("SELECT status FROM agent_runs WHERE id = ?", wf.parentRunId);
    if (run?.status === "running") { internals.cancelRun(wf.parentRunId); return get(id); }
    for (const s of steps(id).filter((x) => ["pending", "waiting-approval"].includes(x.status))) setStep(s.id, { status: "cancelled", finished_at: iso(), error_code: "cancelled", error_message: "ألغاه المالك" });
    settle(wf, "cancelled", { code: "cancelled", message: "ألغاه المالك" });
    return get(id);
  }
  function retryStep(id, key, actor = { type: "owner", id: "owner" }) {
    if (actor.type !== "owner") throw new HttpError(403, "owner-only", "إعادة الخطوات للمالك فقط");
    const wf = getRaw(id);
    const step = steps(id).find((s) => s.key === key);
    if (!step) throw new HttpError(404, "not-found", "الخطوة غير موجودة");
    if (!["failed", "cancelled"].includes(step.status)) throw new HttpError(409, "not-retryable", "يمكن إعادة الخطوات الفاشلة أو الملغاة فقط");
    if (active.has(id)) throw new HttpError(409, "workflow-running", "انتظر انتهاء الخطوات الجارية");
    db.tx(() => {
      setStep(step.id, { status: "pending", error_code: null, error_message: null, finished_at: null });
      // Steps that depended on the retried one are re-opened too, so a new synthesis sees the new evidence.
      for (const s of steps(id).filter((x) => x.dependsOn.includes(key) || (x.kind === "followups" && step.kind !== "followups"))) if (s.id !== step.id && s.status !== "waiting-approval") setStep(s.id, { status: "pending", error_code: null, error_message: null, finished_at: null });
      event(id, "step-retry", { stepId: step.id, agentId: step.agentId, by: "owner" });
    });
    requeue(wf, "owner-retry");
    return get(id);
  }
  /** Restart recovery: read-only tool steps interrupted mid-flight are re-run; anything else that was running is marked
   * interrupted (never silently re-executed); the workflow's parent run is re-queued so the same plan resumes. */
  function recover() {
    const resumed = [];
    for (const r of db.all("SELECT * FROM workflows WHERE status IN ('queued','running')")) {
      const wf = wfRow(r);
      for (const s of steps(wf.id).filter((x) => x.status === "running")) {
        const readOnly = s.kind === "tool" && toolById(s.toolId)?.readOnly;
        setStep(s.id, readOnly ? { status: "pending" } : { status: "failed", finished_at: iso(), error_code: "interrupted", error_message: "انقطع التنفيذ بإعادة تشغيل الـ Bridge؛ أعد الخطوة يدويًا" });
        event(wf.id, readOnly ? "step-requeued-after-restart" : "step-interrupted", { stepId: s.id, agentId: s.agentId });
      }
      if (wf.parentRunId) internals.setRun(wf.parentRunId, { status: "queued", finished_at: null });
      setWf(wf.id, { status: "queued" });
      event(wf.id, "recovered", { agentId: "ori" });
      resumed.push(wf.id);
    }
    return resumed;
  }

  // ------------------------------------------------------------------ read models
  function get(id) {
    const wf = getRaw(id);
    const list = steps(id);
    const runIds = db.all("SELECT id FROM agent_runs WHERE workflow_id = ?", id).map((r) => r.id);
    const usage = runIds.length ? db.get(`SELECT COUNT(*) AS events, COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion, SUM(cost_usd) AS usd, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown FROM usage_events WHERE run_id IN (${runIds.map(() => "?").join(",")})`, ...runIds) : null;
    const tools = db.get("SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms),0) AS ms FROM tool_executions WHERE workflow_id = ?", id);
    return {
      ...wf, steps: list,
      events: db.all("SELECT * FROM workflow_events WHERE workflow_id = ? ORDER BY id DESC LIMIT 200", id).map((e) => ({ id: e.id, stepId: e.step_id, at: e.at, kind: e.kind, agentId: e.agent_id, detail: parseJson(e.detail, {}) })).reverse(),
      approvals: list.filter((s) => s.approvalId).map((s) => company.getApproval(s.approvalId)).map((a) => ({ id: a.id, kind: a.kind, title: a.title, status: a.status, createdAt: a.createdAt })),
      artifacts: db.all("SELECT id, title, kind, mime, agent_id, state, created_at FROM artifacts WHERE workflow_id = ? ORDER BY created_at", id).map((a) => ({ id: a.id, title: a.title, kind: a.kind, mime: a.mime, agentId: a.agent_id, state: a.state, createdAt: a.created_at })),
      resources: { runs: runIds.length, toolExecutions: tools.n, toolMs: tools.ms, inferences: usage?.events ?? 0, promptTokens: usage?.prompt ?? 0, completionTokens: usage?.completion ?? 0, estimatedUsd: usage?.usd ?? null, unknownCostEvents: usage?.unknown ?? 0,
        elapsedMs: wf.startedAt ? Date.parse(wf.finishedAt || iso()) - Date.parse(wf.startedAt) : null },
      specialists: [...new Set(list.map((s) => s.agentId))]
    };
  }
  function list({ status = null, projectId = null, limit = 30 } = {}) {
    const where = [], params = [];
    if (status) { where.push("status = ?"); params.push(status); }
    if (projectId) { where.push("project_id = ?"); params.push(projectId); }
    return db.all(`SELECT * FROM workflows ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`, ...params, Math.min(Math.max(Number(limit) || 30, 1), 100)).map(wfRow).map((wf) => {
      const counts = db.all("SELECT status, COUNT(*) AS n FROM workflow_steps WHERE workflow_id = ? GROUP BY status", wf.id);
      return { id: wf.id, template: wf.template, title: wf.title, status: wf.status, projectId: wf.projectId, createdAt: wf.createdAt, finishedAt: wf.finishedAt, steps: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        specialists: db.all("SELECT DISTINCT agent_id FROM workflow_steps WHERE workflow_id = ?", wf.id).map((r) => r.agent_id) };
    });
  }
  const templates = () => Object.entries(TEMPLATES).map(([id, t]) => ({ id, ar: t.ar, description: t.description, inputs: t.inputs,
    agents: [...new Set(t.steps({ projectId: "x", topic: "x", urls: [] }).map((s) => s.agent))], approvalGated: t.steps({ projectId: "x", topic: "x", urls: [] }).filter((s) => s.kind === "tool" && toolById(s.tool)?.approval === "always").map((s) => s.tool) }));
  return { create, execute, get, list, cancel, retryStep, recover, onApprovalDecided, templates, active };
}
