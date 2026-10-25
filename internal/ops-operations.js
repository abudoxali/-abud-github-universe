/* ABUD FUN Company OS V5 — غرفة العمليات (ORI's multi-agent workflows) and محاسبة الوكلاء (per-agent accounting).
 * Everything shown is read from the bridge: workflow plans, step states, events, approvals, evidence and the
 * accounting report built from persisted runs. A robot animates as "working" only while one of its own steps is
 * persisted as running; success/error reactions fire once, for an observed step transition. Nothing is simulated. */
(() => {
  "use strict";
  const O = window.AbudOps;
  const C = window.AbudCompany;
  if (!O || !C) return;
  const { h, fill, fmt, badge, notice, bdi, icon, panel, panelX, empty, button, field, select, toast, act, mutate } = O;
  const R = window.AbudRobots;
  const AGENTS = ["ori", "mia", "nex", "luna", "zen", "rex"];
  const WF_AR = { queued: ["info", "في الطابور"], running: ["accent", "قيد التنفيذ"], "waiting-approval": ["warn", "بانتظار موافقتك"], succeeded: ["ok", "اكتمل"], partial: ["warn", "اكتمل جزئيًا"], failed: ["bad", "فشل"], cancelled: ["muted", "أُلغي"] };
  const STEP_AR = { pending: ["muted", "بانتظار دوره"], running: ["accent", "يعمل الآن"], succeeded: ["ok", "اكتمل"], failed: ["bad", "فشل"], skipped: ["muted", "تُخطّي"], cancelled: ["muted", "أُلغي"], "waiting-approval": ["warn", "بانتظار موافقتك"] };
  const EVENT_AR = { created: "أنشأ ORI الخطة", delegated: "فوّض ORI خطوة", started: "بدأ التنفيذ", resumed: "استؤنف التنفيذ", "step-started": "بدأت خطوة", "step-succeeded": "اكتملت خطوة", "step-failed": "فشلت خطوة", "step-skipped": "تُخطّيت خطوة",
    "step-cancelled": "أُلغيت خطوة", "approval-requested": "طُلبت موافقتك", "approval-granted": "وافقت على خطوة", "approval-rejected": "رفضت خطوة", requeued: "أعيد إلى الطابور", recovered: "استُعيد بعد إعادة التشغيل", "step-requeued-after-restart": "أعيدت خطوة بعد إعادة التشغيل",
    "step-interrupted": "انقطعت خطوة بإعادة التشغيل", "step-retry": "أعدت خطوة", "workflow-succeeded": "اكتمل سير العمل", "workflow-partial": "اكتمل جزئيًا", "workflow-failed": "فشل سير العمل", "workflow-cancelled": "أُلغي سير العمل", "workflow-waiting-approval": "توقف بانتظار موافقتك" };
  const ACTIVE = new Set(["queued", "running"]);
  const ui = { templates: null, list: null, current: null, error: "", poll: null, seen: new Map(), acct: { range: "30d", projectId: "" }, seq: 0, applied: 0 };
  const name = (id) => C.agentDef(id)?.name || String(id || "").toUpperCase();
  const get = async (path) => {
    const response = await fetch(`/local-api/company${path}`, { cache: "no-store", headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
    return data;
  };
  const wfBadge = (s) => { const [tone, text] = WF_AR[s] || ["muted", s]; return badge(tone, text); };
  const stepBadge = (s) => { const [tone, text] = STEP_AR[s] || ["muted", s]; return badge(tone, text); };
  const md = (text) => (window.AbudWorkforce?.renderMarkdown ? window.AbudWorkforce.renderMarkdown(text) : [h("pre", { class: "co-pre" }, text)]);

  // ------------------------------------------------------------------ robots driven by persisted step state
  function agentState(wf, agentId) {
    const mine = wf.steps.filter((s) => s.agentId === agentId);
    if (mine.some((s) => s.status === "running")) return "working";
    if (mine.some((s) => s.status === "waiting-approval")) return "thinking";
    if (agentId === "ori" && ACTIVE.has(wf.status)) return mine.some((s) => s.status === "pending") || wf.status === "queued" ? "listening" : "thinking";
    return "idle";
  }
  function robot(key, agentId, state, size) {
    if (!R) return C.avatar(agentId, "lg", { state });
    const node = R.mount(key, { agentId, variant: "standard", animationState: state, size, interactive: true });
    node.__robot?.set?.({ animationState: state });
    return node;
  }
  /** Reactions only for transitions observed between two polls of the same workflow. */
  function react(wf) {
    for (const step of wf.steps) {
      const key = `${wf.id}:${step.id}`;
      const prev = ui.seen.get(key);
      ui.seen.set(key, step.status);
      if (!prev || prev === step.status || !["running", "waiting-approval", "pending"].includes(prev)) continue;
      const kind = step.status === "succeeded" ? "success" : step.status === "failed" ? "error" : null;
      if (kind) document.querySelectorAll(`.op-stage svg.rb-robot[data-agent="${step.agentId}"]`).forEach((el) => el.__robot?.react(kind));
    }
  }

  // ------------------------------------------------------------------ data + polling
  /** Responses are applied in request order only: a slower, older read can never overwrite a newer state. */
  async function loadAll(selectId = null) {
    const seq = ++ui.seq;
    try {
      const [templates, list] = await Promise.all([ui.templates ? Promise.resolve({ templates: ui.templates }) : get("/workflow-templates"), get("/workflows?limit=25")]);
      const id = selectId || ui.current?.id || list.workflows[0]?.id;
      const current = id ? await get(`/workflows/${encodeURIComponent(id)}`).catch(() => null) : null;
      if (seq < ui.applied) return;
      ui.applied = seq; ui.templates = templates.templates; ui.list = list.workflows; ui.current = current; ui.error = "";
    } catch (error) { if (seq >= ui.applied) ui.error = error.message; }
    render();
    schedule();
  }
  function schedule() {
    clearTimeout(ui.poll);
    const live = ui.current && (ACTIVE.has(ui.current.status) || ui.current.steps.some((s) => s.status === "running"));
    if (!live) return;
    ui.poll = setTimeout(async () => {
      if (O.state.view !== "agents" || O.state.tab !== "operations" || document.hidden) { schedule(); return; }
      const seq = ++ui.seq;
      try {
        const [current, list] = await Promise.all([get(`/workflows/${encodeURIComponent(ui.current.id)}`), get("/workflows?limit=25")]);
        if (seq >= ui.applied) { ui.applied = seq; ui.current = current; ui.list = list.workflows; }
      } catch (_) { /* next poll */ }
      render(); schedule();
    }, 1500);
  }

  // ------------------------------------------------------------------ launcher
  function openLauncher(t) {
    const d = O.drawer(`تشغيل: ${t.ar}`, { wide: true });
    const project = t.inputs.projectId ? select("projectId", [...(t.inputs.projectId === "required" ? [] : [["", "بدون مشروع"]]), ...C.projectOptions(false)], "", { "aria-label": "المشروع", required: t.inputs.projectId === "required" ? true : null }) : null;
    const topic = t.inputs.topic ? h("input", { class: "ops-input", name: "topic", maxlength: 200, required: true, placeholder: "مثال: مقارنة FTS5 بالبحث المتجهي في SQLite", "aria-label": "موضوع البحث" }) : null;
    const urls = t.inputs.urls ? h("textarea", { class: "ops-input", name: "urls", rows: 3, dir: "ltr", placeholder: "https://… (رابط في كل سطر، حتى 3، من المواقع المعتمدة)", "aria-label": "روابط المصادر" }) : null;
    const parallel = select("maxParallel", [["3", "3 (الحد الأقصى)"], ["2", "2"], ["1", "1 (بالتتابع)"]], "3", { "aria-label": "المتخصصون المتزامنون" });
    const deadline = select("deadline", [["10", "10 دقائق"], ["5", "5 دقائق"], ["20", "20 دقيقة"], ["30", "30 دقيقة"]], "10", { "aria-label": "مهلة سير العمل" });
    const form = h("form", { class: "co-memory-form", onsubmit: async (event) => {
      event.preventDefault();
      const body = { template: t.id, projectId: project?.value || undefined, topic: topic?.value.trim() || undefined, urls: urls ? urls.value.split(/\s+/).map((u) => u.trim()).filter(Boolean) : undefined, limits: { maxParallel: Number(parallel.value), deadlineMinutes: Number(deadline.value) } };
      const created = await act(form.querySelector("[type=submit]"), () => mutate("POST", "/workflows", body), "بدأ ORI سير العمل");
      if (created) { d.close(); ui.current = created; loadAll(created.id); }
    } },
      h("p", null, t.description),
      h("div", { class: "op-team" }, t.agents.map((a) => h("span", { class: "op-chip" }, C.avatar(a, "sm"), name(a)))),
      t.approvalGated.length ? notice("warn", "خطوة تحتاج موافقتك", "سيتوقف سير العمل عند فحص ثغرات الاعتماديات حتى توافق؛ يرسل أسماء الحزم وإصداراتها فقط إلى api.osv.dev.") : null,
      project ? field(`المشروع${t.inputs.projectId === "required" ? " *" : ""}`, project) : null, topic ? field("الموضوع *", topic) : null, urls ? field("مصادر ويب (اختياري)", urls, "تُجلب فقط من المواقع المعتمدة في الإعدادات") : null,
      h("div", { class: "co-form-row" }, field("المتخصصون المتزامنون", parallel), field("المهلة", deadline)),
      notice("info", "حدود ثابتة", "عمق التفويض حتى 2، واستدعاء نموذج واحد فقط (خلاصة ORI)، وكل أداة تحت صلاحيات وكيلها وسجل التدقيق."),
      h("div", { class: "co-form-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, icon("play", 18), "ابدأ")));
    fill(d.body, form);
  }

  // ------------------------------------------------------------------ detail
  function stage(wf) {
    const specialists = wf.specialists.filter((a) => a !== "ori");
    return h("div", { class: "op-stage", style: `--agent:${C.agentDef("ori")?.color || "#7c3aed"}` },
      h("figure", { class: "op-lead" }, robot("op:ori", "ori", agentState(wf, "ori"), 170), h("figcaption", null, h("strong", null, "ORI"), h("small", null, "يقود وينسّق"))),
      h("div", { class: "op-crew" }, specialists.map((a) => {
        const state = agentState(wf, a);
        const mine = wf.steps.filter((s) => s.agentId === a);
        return h("figure", { class: `op-member op-${state}`, style: `--agent:${C.agentDef(a)?.color || "#7c3aed"}` }, robot(`op:${a}`, a, state, 96),
          h("figcaption", null, h("strong", null, name(a)), h("small", null, `${mine.filter((s) => s.status === "succeeded").length}/${mine.length} خطوة`)));
      })));
  }
  function stepRow(wf, s) {
    const out = s.output || {};
    const artifacts = s.evidence?.[0]?.artifactIds || [];
    return h("li", { class: `op-step op-step-${s.status}`, "data-step": s.key },
      h("span", { class: "op-step-agent" }, C.avatar(s.agentId, "md", { state: s.status === "running" ? "working" : undefined })),
      h("div", { class: "op-step-main" },
        h("div", { class: "op-step-line" }, h("strong", null, s.title), stepBadge(s.status), s.optional ? badge("muted", "اختيارية") : null, s.depth > 1 ? badge("info", `عمق ${s.depth}`) : null),
        h("small", { class: "ops-dim" }, `${name(s.agentId)} · `, bdi(s.toolId || (s.kind === "synthesis" ? "synthesis" : "followups"), "co-tech-soft"),
          s.startedAt && s.finishedAt ? ` · ${fmt.ms(Date.parse(s.finishedAt) - Date.parse(s.startedAt))}` : ""),
        out.summary ? h("p", { class: "op-step-summary" }, out.summary) : null,
        s.errorMessage ? h("p", { class: "ops-bad-text" }, `${s.errorCode ? `${s.errorCode}: ` : ""}${s.errorMessage}`) : null,
        artifacts.length ? h("div", { class: "op-step-files" }, artifacts.map((id) => h("a", { class: "ops-chip", href: `/local-api/company/artifacts/${id}/view`, target: "_blank", rel: "noopener" }, icon("download", 14), "ملف ناتج"))) : null),
      h("div", { class: "op-step-actions" },
        s.status === "waiting-approval" && s.approvalId ? approvalButtons(wf, s) : null,
        ["failed", "cancelled"].includes(s.status) && !ACTIVE.has(wf.status) ? button("إعادة الخطوة", async (e) => { const r = await act(e.currentTarget, () => mutate("POST", `/workflows/${wf.id}/steps/${s.key}/retry`, {}), "أعيدت الخطوة إلى الطابور"); if (r) { ui.current = r; loadAll(wf.id); } }) : null,
        s.executionId ? h("small", { class: "ops-dim", title: "سجل التنفيذ" }, bdi(s.executionId, "co-tech-soft")) : null));
  }
  function approvalButtons(wf, s) {
    return h("div", { class: "ops-actions" },
      button("موافقة", async (e) => {
        if (!await O.confirmDialog({ title: `الموافقة على: ${s.title}`, body: `سينفّذ ${name(s.agentId)} الأداة ${s.toolId || "synthesis"} مرة واحدة ضمن «${wf.title}». يُسجَّل قرارك مع التنفيذ.`, confirm: "موافقة" })) return;
        if (await act(e.currentTarget, () => mutate("POST", `/approvals/${s.approvalId}/decide`, { decision: "approve" }), "تمت الموافقة؛ يستأنف ORI")) loadAll(wf.id);
      }, { kind: "primary" }),
      button("رفض", async (e) => { if (await act(e.currentTarget, () => mutate("POST", `/approvals/${s.approvalId}/decide`, { decision: "reject" }), "رُفضت الخطوة؛ يكمل ORI بدونها")) loadAll(wf.id); }));
  }
  function detail(wf) {
    react(wf);
    const done = wf.steps.filter((s) => ["succeeded", "failed", "skipped", "cancelled"].includes(s.status)).length;
    const pct = Math.round((100 * done) / Math.max(1, wf.steps.length));
    const tools = wf.steps.filter((s) => s.kind === "tool"), synth = wf.steps.filter((s) => s.kind !== "tool");
    const r = wf.resources;
    return h("section", { class: "op-detail", "aria-live": "polite" },
      h("header", { class: "op-detail-head" },
        h("div", null, h("h3", null, wf.title), h("p", { class: "ops-dim" }, wf.objective)),
        h("div", { class: "ops-actions" }, wfBadge(wf.status), ACTIVE.has(wf.status) || wf.status === "waiting-approval" ? button("إلغاء", async (e) => {
          if (!await O.confirmDialog({ title: "إلغاء سير العمل؟", body: "تتوقف الخطوات الجارية وتُلغى المتبقية. تبقى النتائج المكتملة وسجل التدقيق.", confirm: "إلغاء سير العمل", tone: "danger" })) return;
          if (await act(e.currentTarget, () => mutate("POST", `/workflows/${wf.id}/cancel`, {}), "أُلغي سير العمل")) loadAll(wf.id);
        }) : null)),
      stage(wf),
      h("div", { class: "op-progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct, "aria-label": "تقدم سير العمل" }, h("span", { style: `inline-size:${pct}%` }), h("small", null, `${done}/${wf.steps.length} خطوة · ${pct}%`)),
      wf.approvals.some((a) => a.status === "pending") ? notice("warn", "قرار مطلوب منك", "خطوة متوقفة حتى توافق أو ترفض. لا يستطيع أي وكيل الموافقة نيابة عنك.") : null,
      h("div", { class: "op-columns" },
        panel("مراحل التنفيذ", "خطوات المتخصصين تعمل بالتوازي ضمن الحد، ثم خلاصة ORI ثم متابعة LUNA.",
          h("h4", { class: "op-phase" }, "التفويض والأدلة"), h("ol", { class: "op-steps" }, tools.map((s) => stepRow(wf, s))),
          h("h4", { class: "op-phase" }, "الخلاصة والمتابعة"), h("ol", { class: "op-steps" }, synth.map((s) => stepRow(wf, s)))),
        h("div", { class: "op-side" },
          panel("الموارد", "مقيسة من سجلات هذا السير فقط.", h("dl", { class: "ops-dl" },
            row("التشغيلات", fmt.num(r.runs)), row("استدعاءات الأدوات", fmt.num(r.toolExecutions)), row("استدعاءات النموذج", fmt.num(r.inferences)),
            row("رموز الإدخال", fmt.num(r.promptTokens)), row("رموز الإخراج", fmt.num(r.completionTokens)),
            row("التكلفة", !r.inferences ? "لا استدلال" : [r.estimatedUsd != null ? `${fmt.usd(r.estimatedUsd)} تقدير الراوتر` : null, r.unknownCostEvents ? `${r.unknownCostEvents} بلا تكلفة مبلّغة` : null].filter(Boolean).join(" · ")),
            row("المدة", r.elapsedMs != null ? fmt.ms(r.elapsedMs) : "—"))),
          panel("سجل الأحداث", "أحداث محفوظة، الأحدث في الأسفل.", h("ol", { class: "op-events" }, wf.events.slice(-40).map((e) => h("li", null,
            h("time", null, fmt.when(e.at)), e.agentId ? C.avatar(e.agentId, "xs") : null,
            h("span", null, EVENT_AR[e.kind] || e.kind, e.detail?.step ? [" · ", bdi(e.detail.step, "co-tech-soft")] : null, e.detail?.code ? [" · ", bdi(e.detail.code, "co-tech-soft")] : null))))))),
      wf.report ? panelX({ title: "التقرير النهائي", hint: "خلاصة ORI مع معرّفات الأدلة، ثم الأدلة الحتمية وما لم يُتحقق منه." }, h("div", { class: "co-output op-report" }, md(wf.report))) : null,
      wf.artifacts.length && window.AbudCapabilities ? panel("الملفات الناتجة", null, h("div", { class: "cap-art-grid" }, wf.artifacts.map((a) => h("a", { class: "op-artifact", href: `/local-api/company/artifacts/${a.id}/${a.mime?.startsWith("image/") || a.mime === "application/pdf" ? "view" : "download"}`, target: "_blank", rel: "noopener" },
        a.mime?.startsWith("image/") ? h("img", { src: `/local-api/company/artifacts/${a.id}/view`, alt: a.title, loading: "lazy" }) : icon("download", 28), h("span", null, a.title))))) : null);
  }
  const row = (k, v) => h("div", { class: "ops-row" }, h("dt", null, k), h("dd", null, v));

  // ------------------------------------------------------------------ room
  let host = null;
  function render() {
    if (!host?.isConnected || O.state.view !== "agents" || O.state.tab !== "operations") return;
    if (!ui.templates) { fill(host, ui.error ? notice("bad", "تعذر تحميل غرفة العمليات", ui.error) : O.skeleton(5)); return; }
    const list = ui.list || [];
    fill(host,
      O.sectionShell({ id: "operations", title: "غرفة العمليات", subtitle: "ORI يقسّم الهدف على المتخصصين، يجمع أدلتهم، ويكتب خلاصة واحدة. ما تراه هنا هو الحالة المحفوظة فعلًا — لا حركة مصطنعة." }),
      h("section", { class: "op-templates", "aria-label": "قوالب سير العمل" }, ui.templates.map((t) => h("article", { class: "op-template" },
        h("h3", null, t.ar), h("p", null, t.description),
        h("div", { class: "op-team" }, t.agents.map((a) => C.avatar(a, "sm"))),
        h("footer", null, t.approvalGated.length ? badge("warn", "خطوة بموافقتك") : badge("ok", "دون موافقات"), button("تشغيل", () => openLauncher(t), { kind: "primary", icon: "play" }))))),
      ui.error ? notice("bad", "تعذر التحديث", ui.error) : null,
      h("div", { class: "op-layout" },
        h("aside", { class: "op-list", "aria-label": "سير العمل الأخيرة" }, h("h3", null, "سير العمل الأخيرة"),
          list.length ? h("ul", null, list.map((w) => h("li", null, h("button", { type: "button", class: `op-list-item${w.id === ui.current?.id ? " is-selected" : ""}`, "aria-pressed": String(w.id === ui.current?.id), onclick: () => loadAll(w.id) },
            h("span", { class: "op-list-title" }, w.title), h("span", { class: "op-list-meta" }, wfBadge(w.status), h("small", { class: "ops-dim" }, fmt.relative(w.createdAt))),
            h("span", { class: "op-team" }, w.specialists.map((a) => C.avatar(a, "xs"))))))) : empty("لم يبدأ أي سير عمل بعد. اختر قالبًا من الأعلى.")),
        ui.current ? detail(ui.current) : h("div", { class: "co-chat-empty" }, icon("agents", 36), h("h3", null, "اختر قالبًا لبدء سير عمل"), h("p", null, "كل خطوة تعمل بصلاحيات وكيلها، وكل نتيجة لها دليل محفوظ."))));
  }
  /** Re-renders from the last state; a fetch happens on first open, on demand and while a workflow is live (polling). */
  function renderRoom(root) { const first = host !== root || !ui.templates; host = root; render(); if (first) loadAll(ui.current?.id); }

  // ------------------------------------------------------------------ accounting (Resources → محاسبة الوكلاء, agent workspace → الاستخدام)
  async function renderAccounting(root, { agentId = null } = {}) {
    const body = h("div", null, O.skeleton(4));
    const range = O.segmented([["24h", "24 ساعة"], ["7d", "7 أيام"], ["30d", "30 يومًا"], ["90d", "90 يومًا"]], ui.acct.range, (v) => { ui.acct.range = v; renderAccounting(root, { agentId }); }, "الفترة");
    const project = select("projectId", [["", "كل المشاريع"], ...C.projectOptions(false)], ui.acct.projectId, { "aria-label": "المشروع", onchange: (e) => { ui.acct.projectId = e.currentTarget.value; renderAccounting(root, { agentId }); } });
    fill(root, agentId ? null : O.sectionShell({ id: "accounting", title: "محاسبة الوكلاء", subtitle: "عمل كل وكيل واستهلاكه وتكلفته من السجلات المحفوظة. التكلفة غير المعروفة لا تُحسب صفرًا، وكثرة الرموز ليست مقياس إنتاجية." }),
      h("div", { class: "co-memory-toolbar" }, range, project), body);
    let data;
    try { data = await get(`/accounting?range=${ui.acct.range}${ui.acct.projectId ? `&projectId=${encodeURIComponent(ui.acct.projectId)}` : ""}${agentId ? `&agentId=${agentId}` : ""}`); }
    catch (error) { fill(body, notice("bad", "تعذر تحميل المحاسبة", error.message)); return; }
    const t = data.totals;
    const costText = (c) => [c.knownEvents ? `${fmt.usd(c.knownUsd)} معروفة` : null, c.estimatedEvents ? `${fmt.usd(c.estimatedUsd)} تقدير` : null, c.unknownEvents ? `${c.unknownEvents} غير معروفة` : null].filter(Boolean).join(" · ") || "لا استدلال";
    const A = window.AbudCapabilities;
    const agents = data.agents;
    fill(body,
      h("div", { class: "os-kpis" },
        O.kpi({ label: "طلبات (تشغيلات)", value: fmt.num(t.requests), hint: `${fmt.num(t.workflows)} سير عمل`, ic: "activity" }),
        O.kpi({ label: "نجحت", value: fmt.num(t.succeeded), hint: `فشل ${fmt.num(t.failed)} · نسبة النجاح ${t.requests ? Math.round((100 * t.succeeded) / Math.max(1, t.succeeded + t.failed)) : 0}%`, tone: t.failed ? "warn" : null, ic: "check" }),
        O.kpi({ label: "استدعاءات الأدوات", value: fmt.num(t.toolCalls), ic: "sparkle" }),
        O.kpi({ label: "رموز الإدخال", value: fmt.compact(t.inputTokens), hint: `الإخراج ${fmt.compact(t.outputTokens)} · قياس التطبيق`, ic: "gauge" }),
        O.kpi({ label: "التكلفة التقديرية", value: t.cost.estimatedEvents ? fmt.usd(t.cost.estimatedUsd) : t.cost.unknownEvents ? "غير معروفة" : "—",
          hint: [t.cost.unknownEvents ? `${fmt.num(t.cost.unknownEvents)} استدلال بلا تكلفة مبلّغة` : null, t.cost.knownEvents ? `معروفة ${fmt.usd(t.cost.knownUsd)}` : null, "تقدير الراوتر وليس فاتورة"].filter(Boolean).join(" · "), ic: "wallet" })),
      h("p", { class: "ops-dim op-basis" }, data.reconciliation.ok ? badge("ok", "مطابق للسجلات") : badge("bad", "عدم تطابق — راجع السجلات"), " محسوب من التشغيلات وسجل الاستهلاك وسجل الأدوات المحفوظة. التقدير من الراوتر وليس فاتورة، والتكلفة غير المعروفة تُعد منفصلة ولا تُحسب صفرًا، وحجم الرموز ليس مقياسًا للإنتاجية."),
      !agentId && A ? h("div", { class: "co-columns" },
        panel("التشغيلات حسب الوكيل", null, A.chart(A.barChart({ categories: agents.map((a) => a.name), series: [{ name: "نجح", stack: "r", data: agents.map((a) => a.succeeded) }, { name: "فشل", stack: "r", data: agents.map((a) => a.failed) }, { name: "متوقف", stack: "r", data: agents.map((a) => a.blocked) }] }), { label: "التشغيلات حسب الوكيل" })),
        panel("الرموز حسب الوكيل", "الحجم لا يعني الإنتاجية.", A.chart(A.barChart({ categories: agents.map((a) => a.name), series: [{ name: "إدخال", data: agents.map((a) => a.inputTokens) }, { name: "إخراج", data: agents.map((a) => a.outputTokens) }] }), { label: "الرموز حسب الوكيل" }))) : null,
      !agentId && A && data.daily.length > 1 ? panel("النشاط اليومي", null, A.chart({ color: agents.map((a) => a.color), xAxis: { type: "category", data: data.daily.map((d) => d.day.slice(5)), inverse: true }, yAxis: { type: "value", position: "right" },
        series: agents.map((a) => ({ name: a.name, type: "line", stack: "d", areaStyle: { opacity: 0.25 }, smooth: true, symbol: "none", data: data.daily.map((d) => d.byAgent[a.agentId]) })) }, { height: 240, label: "التشغيلات اليومية" })) : null,
      panel(agentId ? "تفاصيل الوكيل" : "مقارنة الوكلاء", null, h("div", { class: "ops-tablewrap" }, h("table", { class: "ops-table op-acct" },
        h("thead", null, h("tr", null, ["الوكيل", "طلبات", "مفوّضة", "نجح", "فشل", "أدوات", "إدخال", "إخراج", "التكلفة", "متوسط التنفيذ", "مهام مفتوحة", "مهام منجزة", "مشاريع"].map((c) => h("th", { scope: "col" }, c)))),
        h("tbody", null, agents.map((a) => h("tr", null, h("th", { scope: "row" }, C.avatar(a.agentId, "xs"), ` ${a.name}`), h("td", null, fmt.num(a.requests)), h("td", null, fmt.num(a.delegated)), h("td", null, fmt.num(a.succeeded)), h("td", null, fmt.num(a.failed)),
          h("td", null, fmt.num(a.toolCalls)), h("td", null, fmt.compact(a.inputTokens)), h("td", null, fmt.compact(a.outputTokens)), h("td", null, costText(a.cost)), h("td", null, fmt.ms(a.avgExecutionMs)),
          h("td", null, fmt.num(a.assignedOpenTasks)), h("td", null, fmt.num(a.completedTasks)), h("td", null, fmt.num(a.projects.length)))))))),
      agentId ? panel("أحدث النشاط", null, agents[0]?.recent.length ? h("ul", { class: "ops-list" }, agents[0].recent.map((x) => h("li", null, badge(x.status === "succeeded" ? "ok" : x.status === "failed" ? "bad" : "muted", O.L.runStatus[x.status] || x.status), bdi(x.capability, "co-tech-soft"), h("small", { class: "ops-dim" }, fmt.when(x.at))))) : empty("لا نشاط في الفترة.")) : null,
      !agentId && data.projects.length ? panel("حسب المشروع", null, h("div", { class: "ops-tablewrap" }, h("table", { class: "ops-table" },
        h("thead", null, h("tr", null, ["المشروع", "طلبات", "وكلاء", "أدوات", "رموز", "التكلفة"].map((c) => h("th", { scope: "col" }, c)))),
        h("tbody", null, data.projects.map((p) => h("tr", null, h("th", { scope: "row" }, p.name || p.id), h("td", null, fmt.num(p.requests)), h("td", null, p.agents.map((a) => C.avatar(a, "xs"))), h("td", null, fmt.num(p.toolCalls)),
          h("td", null, fmt.compact(p.inputTokens + p.outputTokens)), h("td", null, costText(p.cost)))))))) : null);
  }

  window.AbudOperations = { renderRoom, renderAccounting, reload: () => loadAll(ui.current?.id), stop: () => clearTimeout(ui.poll) };
})();
