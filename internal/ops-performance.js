/* ABUD FUN Company OS V6 — الأداء: per-agent work and resource use for a chosen period, straight from the persisted
 * accounting report. Counts are reported as measured; high token use is use, not productivity, and unknown cost is
 * shown as unknown (never zero). */
(() => {
  "use strict";
  const O = window.AbudOps;
  const C = window.AbudCompany;
  if (!O || !C) return;
  const { h, fill, fmt, notice, panel, empty, segmented } = O;
  const ui = { range: "7d", report: null, error: null, box: null, at: 0 };
  const RANGES = [["24h", "24 ساعة"], ["7d", "7 أيام"], ["30d", "30 يومًا"]];
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  const ms = (v) => (v == null ? "—" : v < 1000 ? `${v} م.ث` : `${(v / 1000).toFixed(1)} ث`);

  async function load() {
    try {
      const response = await fetch(`/local-api/company/accounting?range=${ui.range}`, { cache: "no-store" });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || "تعذر التحميل");
      ui.report = await response.json(); ui.error = null;
    } catch (error) { ui.error = error.message; }
    draw();
  }
  function cost(c) {
    const parts = [];
    if (c.estimatedEvents) parts.push(`تقديري ${c.estimatedUsd}$`);
    if (c.knownEvents) parts.push(`فعلي ${c.knownUsd}$`);
    if (c.unknownEvents) parts.push(`غير معروف لـ ${c.unknownEvents} طلب`);
    return parts.join(" · ") || "بلا استدلال";
  }
  function card(a) {
    const finished = a.succeeded + a.failed + a.blocked + a.cancelled;
    return h("li", { class: "pf-card", style: `--agent:${a.color}` },
      h("div", { class: "pf-head" }, C.avatar(a.agentId, "md"), h("strong", null, a.name), h("small", { class: "ops-dim" }, `${fmt.num(a.requests)} طلب${a.delegated ? ` · ${a.delegated} مفوَّض` : ""}`)),
      h("dl", { class: "pf-grid" },
        h("dt", null, "نجح"), h("dd", null, `${fmt.num(a.succeeded)} (${pct(a.succeeded, finished)})`),
        h("dt", null, "فشل / توقف"), h("dd", null, `${fmt.num(a.failed)} / ${fmt.num(a.blocked)}`),
        h("dt", null, "استدعاءات الأدوات"), h("dd", null, `${fmt.num(a.toolCalls)}${a.toolDenied ? ` · ${a.toolDenied} مرفوض` : ""}`),
        h("dt", null, "متوسط التنفيذ"), h("dd", null, ms(a.avgExecutionMs)),
        h("dt", null, "رموز المُدخل / المُخرج"), h("dd", null, `${fmt.num(a.inputTokens)} / ${fmt.num(a.outputTokens)}`),
        h("dt", null, "التكلفة"), h("dd", null, cost(a.cost)),
        h("dt", null, "مهام مسندة مفتوحة"), h("dd", null, fmt.num(a.assignedOpenTasks)),
        h("dt", null, "مهام أُنجزت"), h("dd", null, fmt.num(a.completedTasks))),
      a.projects.length ? h("small", { class: "ops-dim" }, `المشاريع: ${a.projects.slice(0, 4).map((p) => p.name || p.id).join("، ")}`) : null,
      h("a", { class: "ops-link", href: O.href("agents", a.agentId) }, "مساحة العمل"));
  }
  function draw() {
    if (!ui.box) return;
    const r = ui.report;
    fill(ui.box,
      segmented(RANGES, ui.range, (value) => { ui.range = value; ui.report = null; draw(); load(); }, "فترة الأداء"),
      ui.error ? notice("bad", "تعذر تحميل الأداء", ui.error) : null,
      !r ? h("p", { class: "ops-dim" }, "يحمّل…") : [
        panel("ملخص الفريق", `الفترة: ${RANGES.find(([v]) => v === ui.range)[1]}. من سجلات التشغيل والاستخدام والأدوات المحفوظة فقط.`,
          h("div", { class: "pf-totals" }, [["الطلبات", r.totals.requests], ["نجحت", r.totals.succeeded], ["فشلت", r.totals.failed], ["استدعاءات الأدوات", r.totals.toolCalls], ["رموز مُرسلة", r.totals.inputTokens], ["رموز مُستلمة", r.totals.outputTokens]]
            .map(([label, value]) => h("div", { class: "pf-total" }, h("strong", null, fmt.num(value)), h("span", null, label)))),
          h("p", { class: "ops-dim" }, `التكلفة: ${cost(r.totals.cost)}. ${r.reconciliation.ok ? "الأرقام مطابقة للسجلات." : "تنبيه: لا تتطابق مجاميع الوكلاء مع السجل."}`)),
        r.agents.length ? h("ul", { class: "pf-list" }, r.agents.filter((a) => a.requests || a.assignedOpenTasks || a.toolCalls || a.completedTasks || C.agentDef(a.agentId)?.active !== false).map(card)) : empty("لا بيانات."),
        h("p", { class: "ops-dim" }, "استهلاك الرموز العالي يعني استخدامًا أكثر، لا إنتاجية أعلى. التكلفة التقديرية من الراوتر وليست فاتورة.")]);
  }
  window.AbudPerformance = { render() { if (!ui.box) ui.box = h("div", { class: "pf-root" }); if (Date.now() - ui.at > 5000) { ui.at = Date.now(); load(); } else draw(); return ui.box; } };
})();
