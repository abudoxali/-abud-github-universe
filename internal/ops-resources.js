/* ABUD FUN Company OS V2 — الموارد الذكية (AI Resources, run by NEX). Overview, quotas, consumption, providers, routing &
 * budgets, and NEX recommendations as contextual tabs. Every figure carries its provenance; estimates are never shown as
 * billing; normal quota depletion is a warning, not an incident. The live OmniRoute blocks (quotas / analytics / providers)
 * come from ops-usage.js. Router writes stay approval-gated and are disabled unless the bridge runs with ABUD_ROUTER_WRITES=1. */
(() => {
  "use strict";
  const O = window.AbudOps;
  const C = window.AbudCompany;
  if (!O || !C) return;
  const { h, fill, fmt, badge, notice, L, label, bdi, icon, panel, panelX, empty, button, linkButton, field, select, kpi, segmented, href, act, mutate, invalidate } = O;

  const sOverview = O.section("coResources", "resources", "overview");
  const sUsage = O.section("rsUsage", "resources", "usage");
  const sRouting = O.section("rsRouting", "resources", "routing");
  const sNex = O.section("rsNex", "resources", "nex");
  const sHistory = O.section("rsHistory", "resources", "quotas");
  const sAccounting = O.section("rsAccounting", "resources", "accounting");

  const load = (force) => O.api.co("resources", "/resources", { force, ttl: 20_000 });
  const loadApprovals = (force) => O.api.co("approvals", "/approvals", { force, ttl: 15_000 });
  const loadHistory = (force) => O.api.co("quotaHistory", "/quota-history?days=7", { force, ttl: 60_000 });
  const cat = () => O.peek("co:catalog")?.data;
  const EVIDENCE = { "provider-reported": ["accent", "مُبلَّغ من المزوّد"], "router-observed": ["info", "مرصود من الراوتر"], "application-measured": ["ok", "قياس التطبيق"], estimated: ["warn", "تقدير"], manual: ["muted", "يدوي"] };
  const CONF = { high: ["ok", "ثقة عالية"], medium: ["warn", "ثقة متوسطة"], low: ["muted", "ثقة منخفضة"] };
  const CLASS_TONE = { free: "ok", "api-free-tier": "info", subscription: "warn", metered: "bad", restricted: "muted" };
  const SCOPE = { company: "الشركة", agent: "وكيل", project: "مشروع", provider: "مزوّد" };
  const PERIOD = { daily: "يومي", weekly: "أسبوعي", monthly: "شهري" };
  const CATEGORY = [["critical", "حرجة", "bad", "alert"], ["warning", "تحذيرات", "warn", "alert"], ["optimization", "فرص تحسين", "accent", "sparkle"], ["info", "معلومات", "info", "info"]];
  const ui = { recFilter: "all" };
  const isoToLocal = (text) => C.isoText(text);
  const recs = () => O.peek("co:resources")?.data?.recommendations || [];
  const categoryOf = (r) => r.category || r.level;

  /** Quota readings are stale when the last stored snapshot is older than three snapshot intervals. */
  function staleQuota(data) {
    const last = data?.quota?.last?.at;
    return Boolean(last && Date.now() - Date.parse(last) > (data.quota.snapshotMinutes || 15) * 3 * 60_000);
  }

  // ---------------------------------------------------------------- recommendations
  function recommendationItem(r, { stale } = {}) {
    const quotaRec = /^(exhausted|low):/.test(r.id);
    const [cid, , tone] = CATEGORY.find(([c]) => c === categoryOf(r)) || CATEGORY[3];
    return h("details", { class: `co-rec co-rec-${cid}`, "data-rec": r.id },
      h("summary", null, badge(tone, L.level[cid] || cid),
        h("span", null, O.rich(isoToLocal(r.titleAr)), stale && quotaRec ? [" ", badge("muted", "قراءة قديمة")] : null),
        h("span", { class: "co-inline" }, r.approvalRequired ? badge("warn", "يحتاج موافقة") : null, badge(...(CONF[r.confidence] || ["muted", r.confidence])), icon("chevronDown", 18))),
      h("div", { class: "co-rec-body" },
        h("div", { class: "rs-rec-grid" },
          h("div", { class: "rs-rec-cell" }, h("h5", null, "الوضع الحالي"), h("p", null, O.rich(isoToLocal(r.situationAr)))),
          h("div", { class: "rs-rec-cell" }, h("h5", null, "التوصية"), h("p", null, O.rich(r.actionAr))),
          h("div", { class: "rs-rec-cell" }, h("h5", null, "الأثر المتوقع"), h("p", null, r.benefitAr)),
          h("div", { class: "rs-rec-cell" }, h("h5", null, "المخاطر"), h("p", null, r.riskAr))),
        h("div", null, h("h5", { class: "rs-group-title" }, "الدليل"), h("ul", { class: "co-evidence" }, r.evidence.map((e) => h("li", null, badge(...(EVIDENCE[e.kind] || ["muted", e.kind])), bdi(isoToLocal(e.text), "co-tech-soft"))))),
        h("p", { class: "ops-dim" }, `الثقة: ${(CONF[r.confidence] || ["", r.confidence])[1]} · الموافقة: ${r.approvalRequired ? "مطلوبة قبل أي تغيير" : "غير مطلوبة (لا يغيّر NEX شيئًا تلقائيًا)"}`),
        r.action?.type === "router.settings" ? h("div", { class: "co-form-actions" }, button(`اقترح تعديل ${r.action.key} إلى ${r.action.value}`, async (e) => {
          if (await act(e.currentTarget, () => mutate("POST", "/router/proposals", { key: r.action.key, value: r.action.value, reason: r.situationAr }), "أُنشئ طلب موافقة؛ لم يُطبَّق شيء بعد")) { loadApprovals(true); invalidate("summary", "notifications"); O.go("resources", "routing"); }
        }, { kind: "primary", icon: "shield" })) : null));
  }

  /** One-sentence NEX executive summary built from the recommendation categories and live state. */
  function executive(data) {
    const list = data.recommendations;
    const count = (c) => list.filter((r) => categoryOf(r) === c).length;
    const agents = O.peek("co:agents")?.data?.agents || C.data("summary")?.agents || [];
    const ready = agents.filter((a) => ["available", "working"].includes(a.availability)).length;
    const routerUp = !list.some((r) => r.id === "router-offline");
    const tone = !routerUp || count("critical") ? "bad" : count("warning") ? "warn" : "ok";
    const text = !routerUp ? "OmniRoute غير متصل؛ لا يمكن تنفيذ أي استدلال الآن."
      : count("critical") ? `مشكلات حرجة تحتاج تدخلك: ${count("critical")} · تحذيرات: ${count("warning")}.`
        : count("warning") ? `لا مشاكل حرجة. تحذيرات تعالجها سياسات التوجيه تلقائيًا: ${count("warning")} · فرص تحسين: ${count("optimization")}.`
          : "الموارد بحالة جيدة؛ لا شيء يحتاج قرارًا الآن.";
    return h("section", { class: `rs-exec rs-exec-${tone}` },
      h("img", { src: "./internal/assets/agents/nex-card.webp", alt: "NEX" }),
      h("div", null, h("h3", null, "ملخص NEX التنفيذي"), h("p", null, text), agents.length ? h("p", null, `${ready} من 6 وكلاء لديهم نموذج مؤهل الآن.`) : null));
  }

  function renderOverview() {
    const data = O.peek("co:resources")?.data;
    if (!data) { fill(sOverview, O.resourceStatus(O.peek("co:resources"), "الموارد") || O.skeleton(5)); return; }
    const overview = O.peek("overview")?.data;
    const routerUp = overview?.connection?.state === "connected";
    const providers = new Map();
    for (const c of overview?.connections || []) if (c.active) providers.set(c.provider, [...(providers.get(c.provider) || []), c]);
    const withCapacity = [...providers.values()].filter((conns) => conns.some((c) => (c.quota?.windows || []).some((w) => ["ok", "unlimited"].includes(w.state)))).length;
    const pressured = new Set((overview?.warnings || []).filter((w) => ["exhausted", "critical", "low"].includes(w.level)).map((w) => w.provider)).size;
    const budgets = data.budgets;
    const worstBudget = budgets.some((b) => b.state === "exceeded") ? "exceeded" : budgets.some((b) => b.state === "unverified") ? "unverified" : budgets.some((b) => b.state === "warning") ? "warning" : budgets.length ? "ok" : null;
    const p = data.appUsage.periods;
    const top = data.recommendations.filter((r) => ["critical", "warning"].includes(categoryOf(r))).slice(0, 3);
    fill(sOverview,
      executive(data),
      h("div", { class: "os-kpis" },
        kpi({ label: "OmniRoute", value: routerUp ? "متصل" : overview ? "غير متصل" : null, hint: overview?.router?.version ? `v${overview.router.version}` : null, tone: overview ? (routerUp ? "ok" : "bad") : null, ic: "resources" }),
        kpi({ label: "مزوّدون بسعة متاحة", value: overview ? withCapacity : null, hint: `من ${providers.size} مزوّد نشط · مُبلَّغ من المزوّد`, ic: "gauge", href: href("resources", "quotas") }),
        kpi({ label: "مزوّدون تحت ضغط حصص", value: overview ? pressured : null, hint: "نافدة أو منخفضة (طبيعي ضمن دورة الاستخدام)", tone: pressured ? "warn" : "ok", ic: "alert", href: href("resources", "quotas") }),
        kpi({ label: "استهلاك الوكلاء · 24 ساعة", value: fmt.compact(p.daily.tokens), hint: `${p.daily.runs} تشغيل · ${fmt.cost(p.daily)} تقدير`, ic: "activity", href: href("resources", "usage") }),
        kpi({ label: "الميزانيات", value: worstBudget ? { ok: "ضمن الحد", warning: "قريبة من الحد", unverified: "غير قابلة للتحقق", exceeded: "متجاوزة" }[worstBudget] : "غير محددة", hint: `${budgets.length} ميزانية مفعّلة`, tone: { ok: "ok", warning: "warn", unverified: "warn", exceeded: "bad" }[worstBudget] || null, ic: "wallet", href: href("resources", "routing") })),
      h("div", { class: "co-columns" },
        panelX({ title: "أهم التوصيات", hint: "الحرجة والتحذيرات فقط؛ التفاصيل والدليل في «توصيات NEX».", actions: linkButton(`كل التوصيات (${data.recommendations.length})`, href("resources", "nex"), { icon: "chevronLeft" }) },
          top.length ? h("div", { class: "co-recs" }, top.map((r) => recommendationItem(r, { stale: staleQuota(data) }))) : h("div", { class: "co-empty" }, icon("check", 26), h("p", null, "لا توصيات حرجة أو تحذيرات."))),
        panelX({ title: "استراتيجية التوجيه", hint: "كيف تختار الشركة النماذج الآن." },
          h("dl", { class: "ops-dl" },
            h("div", { class: "ops-row" }, h("dt", null, "سياسات المجالات"), h("dd", null, `${data.policies.length} مجالات، كل منها بقائمة مرشحين وحماية حصة`)),
            h("div", { class: "ops-row" }, h("dt", null, "إعادة المحاولة في الراوتر"), h("dd", null, overview?.routingSettings?.requestRetry != null ? String(overview.routingSettings.requestRetry) : "غير معروفة")),
            overview?.routingSettings?.comboStrategy ? h("div", { class: "ops-row" }, h("dt", null, "استراتيجية Combos"), h("dd", null, bdi(overview.routingSettings.comboStrategy))) : null,
            h("div", { class: "ops-row" }, h("dt", null, "الكتابة إلى الراوتر"), h("dd", null, data.routerWrites ? badge("warn", "مفعّلة بموافقة") : badge("ok", "معطّلة — قراءة فقط"))),
            h("div", { class: "ops-row" }, h("dt", null, "اشتراكات المستهلك"), h("dd", null, "مستبعدة افتراضيًا؛ Antigravity مستبعد دائمًا"))),
          linkButton("التوجيه والميزانيات", href("resources", "routing"), { icon: "chevronLeft" }))));
  }

  // ---------------------------------------------------------------- consumption (app-measured; router analytics follow from ops-usage)
  function renderUsage() {
    const data = O.peek("co:resources")?.data;
    if (!data) { fill(sUsage, O.skeleton(3)); return; }
    const p = data.appUsage.periods;
    const tile = (t, u) => h("div", { class: "ops-tile" }, h("span", null, t), h("strong", null, `${fmt.compact(u.tokens)} رمز`), h("small", null, `${u.runs} تشغيل · ${fmt.cost(u)} تقدير`));
    const byAgent = data.appUsage.byAgent;
    const max = Math.max(...byAgent.map((a) => a.tokens), 1);
    fill(sUsage, panelX({ title: "استهلاك وكلاء الشركة", hint: "قياس التطبيق: تشغيلات وكلاء ABUD فقط. التكلفة تقدير يعيده الراوتر لكل استجابة — ليست فاتورة." },
      h("div", { class: "ops-legend-row" }, O.source("application-measured"), O.source("estimated")),
      h("div", { class: "ops-tiles" }, tile("آخر 24 ساعة", p.daily), tile("آخر 7 أيام", p.weekly), tile("آخر 30 يومًا", p.monthly)),
      h("div", { class: "ops-two" },
        h("div", null, h("h4", null, "حسب الوكيل (30 يومًا)"), byAgent.length ? h("ul", { class: "ops-bars" }, byAgent.map((a) => h("li", null,
          h("span", { class: "ops-bar-name" }, C.avatar(a.agentId), " ", bdi(a.agentId.toUpperCase())), h("span", { class: "ops-bartrack" }, h("span", { class: "ops-barfill", style: `inline-size:${Math.max((a.tokens / max) * 100, 1)}%` })),
          h("span", { class: "ops-bar-num" }, fmt.compact(a.tokens)), h("span", { class: "ops-bar-rate" }, `${a.runs}×`)))) : empty("لا تشغيلات بعد.")),
        h("div", null, h("h4", null, "حسب النموذج (30 يومًا)"), data.appUsage.byModel.length ? h("ul", { class: "ops-list" }, data.appUsage.byModel.map((m) => h("li", null, bdi(m.model), h("span", { class: "ops-dim" }, `${m.runs} تشغيل · ${fmt.compact(m.tokens)} رمز · ${fmt.cost(m)}`)))) : empty("لا بيانات.")))),
    h("p", { class: "rs-group-title" }, icon("resources", 18), "استخدام الراوتر الكامل (يشمل أدوات خارج الشركة) — مرصود من سجل OmniRoute"));
  }

  // ---------------------------------------------------------------- quota history (7 days)
  function sparkline(series) {
    const points = series.points.filter((p) => p.remainingPct != null);
    if (!points.length) return null;
    const W = 260, H = 64;
    const t0 = Date.parse(points[0].at), t1 = Math.max(Date.parse(points.at(-1).at), t0 + 1);
    const xy = points.map((p) => [((Date.parse(p.at) - t0) / (t1 - t0)) * (W - 8) + 4, H - 4 - (p.remainingPct / 100) * (H - 8)]);
    const last = points.at(-1);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${series.provider} ${series.label}: ${points.length} قراءة، الأخيرة ${last.remainingPct}% متبقٍ`);
    const line = document.createElementNS(svg.namespaceURI, "polyline");
    line.setAttribute("points", xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "));
    svg.append(line);
    return h("figure", { class: "co-spark", style: "margin:0" },
      h("figcaption", null, bdi(series.provider), " ", h("span", { class: "ops-dim" }, `${series.label} · `, bdi(series.connection, "co-tech-soft"))), svg,
      h("small", null, `${last.remainingPct}% متبقٍ · ${points.length} قراءة${last.resetAt ? ` · يُعاد ${fmt.relative(last.resetAt)}` : ""}`));
  }
  function renderHistory() {
    const data = O.peek("co:resources")?.data;
    const history = O.peek("co:quotaHistory")?.data;
    const usage = document.getElementById("opsUsage");
    if (usage && sHistory.previousElementSibling !== usage) usage.after(sHistory); // history follows the live quota blocks
    fill(sHistory, panelX({ title: "تاريخ الحصص (7 أيام)", hint: data ? `لقطات مُبلَّغة من المزوّد يخزنها الـ Bridge كل ${data.quota.snapshotMinutes} دقيقة عند تغيّر القيمة (أو كل ساعة)، وتُحذف بعد ${data.quota.retentionDays} يومًا. آخر لقطة: ${data.quota.last?.at ? fmt.when(data.quota.last.at) : "لا يوجد"}.` : null,
      actions: button("التقاط لقطة الآن", async (e) => { if (await act(e.currentTarget, () => mutate("POST", "/quota/snapshot", {}), "خُزّنت لقطة الحصص")) { loadHistory(true); load(true); } }, { icon: "refresh" }) },
      data && staleQuota(data) ? notice("warn", "قراءات قديمة", "آخر لقطة أقدم من ثلاث دورات تجميع؛ قد لا تعكس الحالة الحالية.") : null,
      history ? (history.series.length ? h("div", { class: "co-sparks" }, history.series.map(sparkline)) : empty("لا لقطات بعد. ستظهر بعد أول دورة تجميع.")) : O.skeleton(2),
      history?.exhaustionEvents?.length ? h("details", null, h("summary", null, `أحداث النفاد (${history.exhaustionEvents.length})`), h("ul", { class: "ops-list" }, history.exhaustionEvents.map((e) => h("li", null, badge("warn", "نفدت"), bdi(e.provider), h("span", null, e.label), h("span", { class: "ops-dim" }, fmt.when(e.at)))))) : null));
  }

  // ---------------------------------------------------------------- routing, budgets, approvals
  function approvalCard(a) {
    const diff = a.before || a.after ? h("div", { class: "co-diff" },
      h("div", null, h("small", null, "قبل"), h("pre", { dir: "ltr" }, JSON.stringify(a.before, null, 1))),
      h("div", null, h("small", null, "بعد"), h("pre", { dir: "ltr" }, JSON.stringify(a.after, null, 1)))) : a.payload ? h("pre", { class: "co-json", dir: "ltr" }, JSON.stringify(a.payload, null, 1)) : null;
    return h("article", { class: `co-approval co-approval-${a.status}`, "data-approval": a.id },
      h("header", { class: "ops-card-head" }, h("h4", null, O.rich(a.title)), h("div", { class: "ops-card-badges" }, label("approval", a.status), badge("muted", a.kind === "router.settings" ? "إعداد OmniRoute" : a.kind === "agent.paid_inference" ? "استدلال مدفوع" : a.kind))),
      a.summary ? h("p", null, isoToLocal(a.summary)) : null, a.risk ? h("p", { class: "ops-dim" }, `المخاطر: ${a.risk === "spend" ? "إنفاق مالي محتمل" : a.risk}`) : null, diff,
      h("small", { class: "ops-dim" }, `طلبه ${a.requestedBy.replace("agent:", "").toUpperCase()} · ${fmt.when(a.createdAt)}${a.decidedAt ? ` · قرار ${fmt.when(a.decidedAt)}` : ""}`),
      a.result ? h("p", { class: "ops-dim" }, a.result.code === "writes-disabled" ? "مُعتمد لكن لم يُطبَّق: الكتابة إلى الراوتر معطّلة في هذه البيئة (شغّل الـ Bridge مع ABUD_ROUTER_WRITES=1 لتفعيلها)." : a.result.verified === true ? "طُبّق وتم التحقق من القيمة الجديدة في OmniRoute." : a.result.rolledBack ? "تم التراجع." : JSON.stringify(a.result)) : null,
      h("div", { class: "co-form-actions" },
        a.status === "pending" ? [button("موافقة", (e) => decide(e, a, "approve"), { kind: "primary", icon: "check" }), button("رفض", (e) => decide(e, a, "reject"))] : null,
        a.status === "applied" && a.kind === "router.settings" ? button("تراجع", async (e) => { if (await act(e.currentTarget, () => mutate("POST", `/approvals/${a.id}/rollback`, {}), "تم التراجع والتحقق")) refreshAll(); }) : null));
  }
  async function decide(event, a, decision) {
    if (decision === "approve" && a.kind === "router.settings" && !(await O.confirmDialog({ title: "اعتماد تعديل إعداد OmniRoute؟", body: O.peek("co:resources")?.data?.routerWrites ? "سيُطبَّق التعديل على الراوتر الحي ثم يُتحقق منه، والتراجع متاح." : "الكتابة إلى الراوتر معطّلة في هذه البيئة: سيُسجَّل الاعتماد فقط ولن يتغيّر الراوتر.", confirm: "اعتماد" }))) return;
    const result = await act(event.currentTarget, () => mutate("POST", `/approvals/${a.id}/decide`, { decision }), decision === "approve" ? "تمت الموافقة" : "تم الرفض");
    if (result) { refreshAll(); invalidate("agents", "agent:", "summary", "notifications", "activity"); }
  }
  function budgetsPanel(budgets) {
    const agents = cat()?.agents || [];
    const scopeSel = select("scope", Object.entries(SCOPE), "company", { "aria-label": "النطاق" });
    const refHost = h("span");
    const refControl = () => {
      const scope = scopeSel.value;
      fill(refHost, scope === "agent" ? select("scopeRef", agents.map((a) => [a.id, a.name]), "ori", { "aria-label": "الوكيل" })
        : scope === "project" ? select("scopeRef", C.projectOptions(false), "", { "aria-label": "المشروع" })
          : scope === "provider" ? h("input", { class: "ops-input", name: "scopeRef", dir: "ltr", placeholder: "gemini", "aria-label": "المزوّد" }) : null);
    };
    scopeSel.addEventListener("change", refControl);
    refControl();
    const form = h("form", { class: "co-budget-form", onsubmit: async (event) => {
      event.preventDefault();
      const v = O.formValues(form);
      const saved = await act(form.querySelector("[type=submit]"), () => mutate("POST", "/budgets", { scope: v.scope, scopeRef: v.scopeRef, period: v.period, limitUsd: v.limitUsd === "" ? null : Number(v.limitUsd), tokenLimit: v.tokenLimit === "" ? null : Number(v.tokenLimit), warnPct: Number(v.warnPct || 80), hardStop: form.hardStop.checked }), "حُفظت الميزانية");
      if (saved) { form.reset(); refControl(); load(true); }
    } },
    field("النطاق", scopeSel), field("المرجع", refHost), field("الفترة", select("period", Object.entries(PERIOD), "daily", { "aria-label": "الفترة" })),
    field("سقف بالدولار", h("input", { class: "ops-input", type: "number", name: "limitUsd", min: 0, step: 0.01, placeholder: "مثال 5", "aria-label": "السقف المالي بالدولار" })),
    field("حد الرموز", h("input", { class: "ops-input", type: "number", name: "tokenLimit", min: 0, step: 1000, "aria-label": "حد الرموز" })),
    field("تحذير عند %", h("input", { class: "ops-input", type: "number", name: "warnPct", min: 1, max: 100, value: 80, "aria-label": "نسبة التحذير" })),
    h("label", { class: "co-inline-check" }, h("input", { type: "checkbox", name: "hardStop", checked: true }), "إيقاف صارم"),
    h("button", { type: "submit", class: "btn btn-primary" }, "حفظ الميزانية"));
    return panel("الميزانيات", "للشركة والوكلاء والمشاريع والمزوّدين. تُحسب من تشغيلات وكلاء الشركة فقط وبتوقيت الشركة؛ التكلفة تقدير الراوتر ولا تخص حصص الاشتراكات.",
      budgets.length ? h("div", { class: "ops-tablewrap" }, h("table", { class: "ops-table" },
        h("thead", null, h("tr", null, ["النطاق", "الفترة", "المصروف / الحد", "الاستخدام", "الحالة", ""].map((x) => h("th", { scope: "col" }, x)))),
        h("tbody", null, budgets.map((b) => {
          const pct = Math.max(b.costPct ?? 0, b.tokenPct ?? 0);
          return h("tr", null,
            h("th", { scope: "row" }, SCOPE[b.scope], b.scopeRef ? [" · ", bdi(b.scopeRef)] : null, b.hardStop ? h("div", null, badge("muted", "إيقاف صارم")) : null),
            h("td", null, PERIOD[b.period], h("div", { class: "ops-dim" }, `منذ ${fmt.when(b.periodStart)}`)),
            h("td", null, b.limitUsd != null ? h("div", null, `${fmt.usd(b.spent.costUsd)} / ${fmt.usd(b.limitUsd)}`, b.spent.unknownCostEvents ? h("small", { class: "ops-dim" }, ` (+${b.spent.unknownCostEvents} بتكلفة غير معروفة)`) : null) : null, b.tokenLimit != null ? h("div", null, `${fmt.compact(b.spent.tokens)} / ${fmt.compact(b.tokenLimit)} رمز`) : null,
              b.spent.unknownCostEvents ? h("div", { class: "ops-dim" }, `${b.spent.unknownCostEvents} تشغيل بتكلفة غير معروفة`) : null),
            h("td", { class: "co-meter-cell" }, O.meter(Math.min(pct, 100), pct >= 100 ? "exhausted" : pct >= b.warnPct ? "low" : "ok", `استخدام ${Math.round(pct)}%`), h("small", null, `${Math.round(pct)}%`)),
            h("td", null, badge({ ok: "ok", warning: "warn", unverified: "warn", exceeded: "bad", disabled: "muted" }[b.state], { ok: "ضمن الحد", warning: "قريب من الحد", unverified: "غير قابل للتحقق", exceeded: "متجاوز", disabled: "معطّل" }[b.state]),
              b.state === "unverified" ? h("div", { class: "ops-dim" }, b.hardStop ? `${b.unverifiedPaidEvents} استدلال مدفوع بلا تكلفة معروفة؛ المدفوع متوقف` : `${b.unverifiedPaidEvents} استدلال مدفوع بلا تكلفة معروفة`) : null),
            h("td", null, button("حذف", async (e) => { if (!(await O.confirmDialog({ title: "حذف الميزانية؟", body: "ستتوقف الحماية التي توفرها هذه الميزانية.", confirm: "حذف", tone: "danger" }))) return; if (await act(e.currentTarget, () => mutate("DELETE", `/budgets/${b.id}`), "حُذفت الميزانية")) load(true); })));
        })))) : empty("لا ميزانيات."), h("h4", null, "ميزانية جديدة أو تعديل"), form);
  }
  function policiesPanel(policies) {
    const c = cat();
    if (!c) return null;
    return panel("سياسات التوجيه حسب المجال", "تُطبّق فعليًا على كل تشغيل: ترتيب النماذج المفضلة، فئات الفوترة المسموحة (المزوّدون المؤهلون)، حماية الحصة، حد الموافقة، وإعادة المحاولة (قواعد Fallback). فئة «مقيّد» لا يمكن السماح بها.",
      h("div", { class: "co-policy-grid" }, policies.map((p) => {
        const candidates = h("textarea", { class: "ops-input", dir: "ltr", rows: Math.max(3, p.candidates.length), "aria-label": `مرشحو ${p.labelAr}` }, p.candidates.join("\n"));
        const classes = ["free", "api-free-tier", "subscription", "metered"].map((cls) => h("label", { class: "co-inline-check" }, h("input", { type: "checkbox", value: cls, checked: p.allowClasses.includes(cls) ? true : null }), badge(CLASS_TONE[cls], c.classes[cls].ar.split(" (")[0].split(" — ")[0])));
        const retries = h("input", { class: "ops-input", type: "number", min: 0, max: 3, value: p.maxRetries, "aria-label": "أقصى إعادة محاولة" });
        const protect = h("input", { class: "ops-input", type: "number", min: 0, max: 100, value: p.quotaProtectPct, "aria-label": "حماية الحصة %" });
        const approval = select("approval", [["none", "بدون"], ["paid", "للمدفوع"], ["always", "دائمًا"]], p.approval, { "aria-label": "الموافقة" });
        const maxOut = h("input", { class: "ops-input", type: "number", min: 64, max: 16000, step: 64, value: p.maxOutputTokens, "aria-label": "أقصى رموز إخراج" });
        return h("details", { class: "co-policy", "data-policy": p.domain }, h("summary", null, h("strong", null, p.labelAr), " · ", bdi(p.candidates[0], "co-tech-soft")),
          h("div", { class: "co-inline" }, p.allowClasses.map((cls) => badge(CLASS_TONE[cls] || "muted", c.classes[cls]?.ar?.split(" (")[0].split(" — ")[0] || cls))),
          field("النماذج المفضلة بالترتيب (سطر لكل provider/model)", candidates),
          h("div", { class: "co-inline" }, ...classes),
          h("div", { class: "co-form-row" }, field("إعادة المحاولة", retries), field("حماية الحصة %", protect, "تمنع المهام غير العاجلة من استهلاك آخر السعة"), field("الموافقة", approval), field("أقصى رموز إخراج", maxOut)),
          h("div", { class: "co-form-actions" }, button("حفظ السياسة", async (e) => {
            const patch = { candidates: candidates.value.split(/\s*\n\s*/).map((x) => x.trim()).filter(Boolean), allowClasses: classes.map((l) => l.querySelector("input")).filter((i) => i.checked).map((i) => i.value),
              maxRetries: Number(retries.value), quotaProtectPct: Number(protect.value), approval: approval.value, maxOutputTokens: Number(maxOut.value) };
            if (await act(e.currentTarget, () => mutate("PATCH", `/policies/${p.domain}`, patch), `حُفظت سياسة ${p.labelAr}`)) { load(true); invalidate("agents", "agent:"); }
          }, { kind: "primary" })));
      })));
  }
  function renderRouting() {
    if (O.editing(sRouting, renderRouting)) return;
    const data = O.peek("co:resources")?.data;
    const approvals = O.peek("co:approvals")?.data?.approvals || [];
    if (!data) { fill(sRouting, O.skeleton(4)); return; }
    const pending = approvals.filter((a) => a.status === "pending");
    fill(sRouting,
      notice(data.routerWrites ? "warn" : "info", data.routerWrites ? "الكتابة إلى OmniRoute مفعّلة في هذه الجلسة" : "إعدادات OmniRoute الحية للقراءة فقط", data.routerWrites ? "الموافقة تطبّق التعديل ثم تتحقق منه، والتراجع متاح." : "الموافقات تُسجَّل ولا تُطبَّق على الراوتر الحي. سياسات الشركة والميزانيات أدناه تُطبَّق داخل الشركة فقط."),
      panel(`طلبات الموافقة${pending.length ? ` (${pending.length} بانتظار القرار)` : ""}`, "استدلال مدفوع وتعديلات إعدادات الراوتر تحتاج قرارك الصريح.", approvals.length ? h("div", { class: "co-approvals" }, approvals.slice(0, 20).map(approvalCard)) : empty("لا طلبات موافقة.")),
      budgetsPanel(data.budgets),
      policiesPanel(data.policies));
  }

  // ---------------------------------------------------------------- NEX recommendations
  function renderNex() {
    const data = O.peek("co:resources")?.data;
    if (!data) { fill(sNex, O.resourceStatus(O.peek("co:resources"), "التوصيات") || O.skeleton(4)); return; }
    const list = data.recommendations;
    const shown = ui.recFilter === "all" ? list : list.filter((r) => categoryOf(r) === ui.recFilter);
    const stale = staleQuota(data);
    fill(sNex,
      executive(data),
      h("div", { class: "pj-toolbar" },
        segmented([["all", `الكل (${list.length})`], ...CATEGORY.map(([c, t]) => [c, `${t} (${list.filter((r) => categoryOf(r) === c).length})`])], ui.recFilter, (v) => { ui.recFilter = v; renderNex(); }, "تصفية التوصيات"),
        h("span", { class: "ops-dim" }, "حالات الحصة المتطابقة مجمّعة لكل مزوّد؛ كل حساب يبقى ظاهرًا في الدليل.")),
      shown.length ? CATEGORY.filter(([c]) => shown.some((r) => categoryOf(r) === c)).map(([c, title, tone, ic]) => h("section", { class: "co-recs", "aria-label": title },
        h("h3", { class: "rs-group-title" }, icon(ic, 20), title, badge(tone, String(shown.filter((r) => categoryOf(r) === c).length))),
        shown.filter((r) => categoryOf(r) === c).map((r) => recommendationItem(r, { stale }))))
        : h("div", { class: "co-empty" }, icon("check", 26), h("p", null, "لا توصيات في هذا التصنيف.")),
      h("p", { class: "ops-dim" }, "NEX لا يغيّر الراوتر ولا السياسات تلقائيًا. التوصيات مبنية على بيانات مرصودة فقط ولا تَعِد بتوفير غير مثبت."));
  }

  function renderAll() { renderOverview(); renderUsage(); renderRouting(); renderNex(); renderHistory(); }
  function refreshAll(force = true) { load(force); loadApprovals(force); loadHistory(force); }

  O.registerView({
    id: "resources", order: 50, icon: "resources", ar: "الموارد الذكية", subtitle: "OmniRoute والنماذج والحصص والاستهلاك والميزانيات — يديرها NEX.",
    tabs: [["overview", "نظرة عامة"], ["quotas", "الحصص"], ["usage", "الاستهلاك"], ...(window.AbudInternalHealth?.capabilities?.workflows ? [["accounting", "محاسبة الوكلاء"]] : []), ["providers", "المزودون والنماذج"], ["routing", "التوجيه والميزانيات"], ["nex", "توصيات NEX"]],
    defaultTab: "overview",
    onShow(tab) { refreshAll(false); C.co.catalog(); C.co.projects(); C.co.agents(); O.api.overview(); if (tab === "accounting") window.AbudOperations?.renderAccounting(sAccounting); },
    badge() {
      const pending = (O.peek("co:approvals")?.data?.approvals || []).filter((a) => a.status === "pending").length;
      const critical = recs().filter((r) => categoryOf(r) === "critical").length;
      return pending ? { n: pending, tone: "warn", title: `${pending} موافقة بانتظارك` } : critical ? { n: critical, tone: "bad", title: `${critical} توصية حرجة` } : null;
    }
  });
  O.setActions("resources", () => [button("تحديث", () => { refreshAll(true); O.api.overview(true); }, { icon: "refresh" })]);
  O.on("co:resources", () => { renderAll(); O.refreshNav(); });
  O.on("co:approvals", () => { renderRouting(); O.refreshNav(); });
  O.on("co:quotaHistory", renderHistory);
  O.on("co:catalog", renderAll);
  O.on("co:agents", () => { if (O.state.view === "resources") { renderOverview(); renderNex(); } });
  O.on("overview", () => { if (O.state.view === "resources") renderOverview(); });
  loadApprovals(false);
})();
