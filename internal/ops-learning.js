/* ABUD FUN Company OS V6 — الخبرات والتعلّم: what the employees learned, shown as measurable counts only (no
 * "intelligence" percentages), the learning proposals waiting for the owner, and the procedural skills with their
 * evaluation, activation and rollback. Agents only propose; every approval here is the owner's. */
(() => {
  "use strict";
  const O = window.AbudOps;
  const C = window.AbudCompany;
  if (!O || !C) return;
  const { h, fill, fmt, notice, panel, empty, button, act, mutate } = O;
  const ui = { summary: null, proposals: null, skills: null, error: null, box: null };
  const KIND_AR = { "new-fact": "حقيقة جديدة", preference: "تفضيل للمالك", procedure: "إجراء ناجح", "recurring-failure": "خطأ متكرر", "better-strategy": "طريقة أفضل", "memory-correction": "تصحيح ذاكرة" };
  const SKILL_AR = { draft: "مسودة", testing: "قيد التقييم", active: "مفعّلة", retired: "متقاعدة" };
  const get = (path) => fetch(`/local-api/company${path}`, { cache: "no-store" }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d?.message || "تعذر التحميل"); return d; });

  async function load() {
    try {
      const [summary, proposals, skills] = await Promise.all([get("/learning/summary"), get("/learning/proposals?status=pending&limit=50"), get("/learning/skills?limit=50")]);
      Object.assign(ui, { summary, proposals: proposals.proposals, skills: skills.skills, error: null });
    } catch (error) { ui.error = error.message; }
    draw();
  }
  const agentName = (id) => C.agentDef(id)?.name || String(id || "").toUpperCase();
  const run = (trigger, method, path, ok) => act(trigger, () => mutate(method, path, {}), ok).then((r) => { if (r) load(); });

  function stats(s) {
    const item = (value, label, hint) => h("div", { class: "lr-stat" }, h("strong", null, fmt.num(value)), h("span", null, label), hint ? h("small", { class: "ops-dim" }, hint) : null);
    return h("div", { class: "lr-stats" },
      item(s.verifiedKnowledge7d, "معرفة مؤكدة جديدة", `آخر 7 أيام · ${fmt.num(s.verifiedKnowledge30d)} في 30 يومًا`),
      item(s.pendingProposals, "اقتراحات بانتظارك"), item(s.approvedSkills, "مهارات مفعّلة"),
      item(s.recentCorrections, "تصحيحات حديثة", "آخر 30 يومًا"), item(s.supersededNotes, "معارف استُبدلت"),
      item(s.repeatedFailures, "أخطاء أدوات متكررة", "تكرار نفس الخطأ لنفس الوكيل"));
  }
  function proposal(p) {
    return h("li", { class: "lr-item" },
      h("div", { class: "lr-item-head" }, C.avatar(p.agentId, "sm"), h("strong", null, p.title), h("span", { class: "ops-chip" }, KIND_AR[p.kind] || p.kind)),
      h("p", { dir: "auto" }, p.body),
      h("small", { class: "ops-dim" }, `${agentName(p.agentId)} · ${fmt.when(p.createdAt)}${p.evidence?.length ? ` · ${p.evidence.length} دليل` : ""}`),
      h("div", { class: "ops-actions" },
        button("اعتمادها", (e) => run(e.currentTarget, "POST", `/learning/proposals/${p.id}/approve`, "اعتُمدت وأضيفت للذاكرة"), { kind: "primary" }),
        button("رفض", (e) => run(e.currentTarget, "POST", `/learning/proposals/${p.id}/reject`, "رُفض الاقتراح"), { kind: "secondary" })));
  }
  function skill(s) {
    const evaluation = s.evaluation;
    return h("li", { class: "lr-item" },
      h("div", { class: "lr-item-head" }, C.avatar(s.agentId, "sm"), h("strong", null, s.title), h("span", { class: "ops-chip" }, `${SKILL_AR[s.status] || s.status} · إصدار ${s.version}`)),
      h("ol", { class: "lr-steps" }, (s.steps || []).slice(0, 8).map((step) => h("li", null, typeof step === "string" ? step : [step.toolId ? h("code", null, step.toolId) : null, step.guidance ? ` ${step.guidance}` : ""]))),
      evaluation ? h("p", { class: evaluation.passed ? "ops-dim" : "lr-bad" }, evaluation.passed ? "اجتاز التقييم: الأدوات ضمن صلاحيات الوكيل ولا يوجد إجراء حساس." : `لم يجتز التقييم: ${(evaluation.errors || evaluation.issues || []).join("، ") || "راجع الخطوات"}`) : null,
      h("small", { class: "ops-dim" }, `استُخدمت ${fmt.num(s.useCount)} مرة${s.lastUsedAt ? ` · آخر استخدام ${fmt.when(s.lastUsedAt)}` : ""}`),
      h("div", { class: "ops-actions" },
        ["draft", "testing"].includes(s.status) ? button("تقييم", (e) => run(e.currentTarget, "POST", `/learning/skills/${s.id}/evaluate`, "اكتمل التقييم"), { kind: "secondary" }) : null,
        ["draft", "testing"].includes(s.status) && evaluation?.passed ? button("تفعيل", (e) => run(e.currentTarget, "POST", `/learning/skills/${s.id}/activate`, "فُعّلت المهارة"), { kind: "primary" }) : null,
        s.status === "active" && s.rollbackTo ? button("الرجوع للإصدار السابق", (e) => run(e.currentTarget, "POST", `/learning/skills/${s.id}/rollback`, "تم الرجوع"), { kind: "secondary" }) : null));
  }
  function draw(initial = false) {
    const box = ui.box;
    if (!box || (!initial && !box.isConnected)) return;
    fill(box,
      ui.error ? notice("bad", "تعذر تحميل بيانات التعلّم", ui.error) : null,
      ui.summary ? panel("ما تعلّمه الفريق", "أرقام محسوبة من السجلات الفعلية؛ لا نسب ذكاء تقديرية.", stats(ui.summary)) : h("p", { class: "ops-dim" }, "يحمّل…"),
      panel("اقتراحات تنتظر قرارك", "يقترح الموظفون ما تعلّموه من تصحيحاتك ونتائج العمل الموثّقة. لا يُحفظ شيء كمعرفة مؤكدة دون اعتمادك.",
        ui.proposals == null ? null : ui.proposals.length ? h("ul", { class: "lr-list" }, ui.proposals.map(proposal)) : empty("لا توجد اقتراحات معلّقة.")),
      panel("المهارات الإجرائية", "خطوات ناجحة تحولت لمهارة بعد تقييمها. لا تمنح المهارة أي صلاحية جديدة للوكيل.",
        ui.skills == null ? null : ui.skills.length ? h("ul", { class: "lr-list" }, ui.skills.map(skill)) : empty("لا توجد مهارات بعد.")));
  }

  window.AbudLearning = { render() { ui.box = h("div", { class: "lr-root" }); draw(true); load(); return ui.box; } };
})();
