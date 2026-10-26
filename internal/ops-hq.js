/* ABUD FUN Company OS V2 — الرئيسية (Company HQ). The owner's daily control centre: where the company stands, what needs
 * attention and what to do next. Every figure comes from /local-api/company/summary; nothing is estimated or scored.
 * Each signal appears in exactly one place (today's work, attention, resource health) so alerts are never repeated. */
(() => {
  "use strict";
  const O = window.AbudOps;
  const C = window.AbudCompany;
  if (!O || !C) return;
  const { h, fill, fmt, badge, notice, L, label, bdi, icon, panelX, empty, button, linkButton, kpi, href, todayIso, act, toast } = O;

  const root = O.section("hqView", "hq");
  const data = () => O.peek("co:summary")?.data;

  function greeting() {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: O.companyZone() }).format(new Date()));
    return hour < 12 ? "صباح الخير" : hour < 18 ? "مساء الخير" : "مساء النور";
  }
  const plural = (n, one, two, few, many) => (n === 0 ? `لا ${many}` : n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`);

  /** One plain-Arabic sentence built only from real counts. */
  function operationalSummary(s) {
    const t = s.tasks;
    const parts = [];
    parts.push(t.dueToday.length ? `${plural(t.dueToday.length, "مهمة واحدة", "مهمتان", "مهام", "مهمة")} مستحقة اليوم` : "لا مهام مستحقة اليوم");
    if (t.overdue.length) parts.push(`${plural(t.overdue.length, "مهمة متأخرة", "مهمتان متأخرتان", "مهام متأخرة", "مهمة متأخرة")}`);
    if (t.blocked.length) parts.push(`${plural(t.blocked.length, "مهمة متعطّلة", "مهمتان متعطّلتان", "مهام متعطّلة", "مهمة متعطّلة")}`);
    if (s.approvalsPending) parts.push(`${plural(s.approvalsPending, "موافقة بانتظارك", "موافقتان بانتظارك", "موافقات بانتظارك", "موافقة بانتظارك")}`);
    const working = s.runs.active.length;
    // Agents can only run through OmniRoute; while it is unreachable they are stopped, not "on standby".
    parts.push(working ? `${plural(working, "وكيل يعمل الآن", "تشغيلان جاريان", "تشغيلات جارية", "تشغيلًا جاريًا")}` : s.router.state === "checking" ? "جارٍ التحقق من اتصال OmniRoute" : s.router.state !== "connected" ? "الوكلاء متوقفون حتى يعود اتصال OmniRoute" : "الوكلاء في وضع الاستعداد");
    return `${parts.join("، ")}.`;
  }

  /** «اسأل الشركة»: the bridge routes the request to the right employee (or ORI) and opens that conversation. */
  function askBox() {
    const input = h("input", { class: "ops-input", type: "text", maxlength: 4000, placeholder: "اسأل الشركة… مثال: راجع حالة مشاريعي وجهّز أولويات النهارده", "aria-label": "اسأل الشركة" });
    return h("form", { class: "hq-ask", role: "search", onsubmit: async (event) => {
      event.preventDefault();
      const content = input.value.trim(); if (!content) return input.focus();
      const result = await act(event.currentTarget.querySelector("button[type=submit]"), () => O.mutate("POST", "/ask", { content, idempotencyKey: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }), null);
      if (!result) return;
      toast(`حُوّل الطلب إلى ${result.agentName}: ${result.reasonAr}`, "ok");
      O.go("agents", "chat", result.conversationId);
    } }, input, h("button", { type: "submit", class: "btn btn-primary" }, "اسأل"));
  }

  function hero(s) {
    const longDate = new Intl.DateTimeFormat("ar-EG-u-nu-latn", { dateStyle: "full", timeZone: O.companyZone() }).format(new Date());
    return h("section", { class: "hq-hero", "aria-labelledby": "hqGreeting" },
      h("div", null,
        h("p", { class: "hq-eyebrow" }, h("b", null, "ABUD FUN"), h("span", null, longDate), h("span", null, "توقيت القاهرة")),
        h("h2", { id: "hqGreeting" }, `${greeting()}، هذه حالة الشركة الآن`),
        h("p", { class: "hq-summary" }, s ? operationalSummary(s) : "جارٍ تجميع حالة الشركة من المخزن المحلي…"),
        askBox(),
        h("div", { class: "hq-hero-actions" },
          button("مهمة جديدة", () => C.openQuickTask({ dueDate: todayIso() }), { kind: "primary", icon: "plus" }),
          linkButton("إسناد لوكيل", href("agents", "request"), { icon: "agents" }),
          s?.approvalsPending ? linkButton(`مراجعة الموافقات (${s.approvalsPending})`, href("resources", "routing"), { icon: "shield" }) : linkButton("عرض المشاريع", href("projects"), { icon: "projects" }))),
      s ? h("nav", { class: "hq-crew", "aria-label": "فريق الوكلاء وحالتهم" }, [...s.agents].reverse().map((a) =>
        h("a", { href: href("agents", a.id), class: `hq-crew-item os-crew-${a.availability}`, style: `--agent:${a.color}`, title: `${a.name} · ${L.availability[a.availability] || a.availability}`, "aria-label": `${a.name}: ${L.availability[a.availability] || a.availability}` },
          C.avatar(a.id, "lg", { state: a.availability, interactive: true })))) : null);
  }

  function kpis(s) {
    const t = s.tasks;
    const working = s.agents.filter((a) => a.availability === "working").length;
    const ready = s.agents.filter((a) => ["available", "working"].includes(a.availability)).length;
    const decisions = s.approvalsPending + t.blocked.length + s.projects.blocked.length;
    const routerOk = s.router.state === "connected";
    const routerChecking = s.router.state === "checking";
    return h("div", { class: "os-kpis", role: "list", "aria-label": "مؤشرات الشركة" },
      kpi({ label: "مشاريع نشطة", value: s.projects.active, hint: `من ${s.projects.total} مشروعًا مسجلًا`, href: href("projects", "all"), ic: "projects", tone: "accent" }),
      kpi({ label: "مهام مهمة مفتوحة", value: t.highOpen, hint: `${t.open} مهمة مفتوحة إجمالًا`, href: href("work"), ic: "work", tone: t.overdue.length ? "warn" : null }),
      kpi({ label: "قرارات معلّقة", value: decisions, hint: decisions ? "موافقات وعوائق تنتظرك" : "لا شيء ينتظر قرارك", href: href(s.approvalsPending ? "resources" : "work", s.approvalsPending ? "routing" : ""), ic: "flag", tone: decisions ? "warn" : "ok" }),
      kpi({ label: "وكلاء يعملون الآن", value: working, hint: `${ready} من 6 جاهزون للتنفيذ`, href: href("agents"), ic: "agents", tone: working ? "accent" : null }),
      kpi({ label: "اتصال الذكاء", value: routerOk ? "متصل" : routerChecking ? "جار التحقق" : "غير متصل", hint: s.router.version ? `OmniRoute v${s.router.version}` : "OmniRoute", href: href("resources"), ic: "resources", tone: routerOk ? "ok" : routerChecking ? "muted" : "bad" }));
  }

  function todayPanel(s) {
    const t = s.tasks;
    const seen = new Set();
    const list = [...t.overdue, ...t.dueToday, ...t.inProgressList, ...t.focus].filter((x) => !seen.has(x.id) && seen.add(x.id)).slice(0, 7);
    return panelX({ title: "عمل اليوم", hint: "المتأخر أولًا، ثم المستحق اليوم، ثم الجاري والمهم.", actions: linkButton("كل المهام", href("work", "today"), { kind: "secondary", icon: "chevronLeft" }) },
      C.stableQuickAdd("hq", { dueDate: todayIso() }),
      C.taskList(list, { compact: false }) || empty("لا عمل عاجل اليوم. أضف مهمة أو حدّد أولوية عالية لما يهمك."));
  }

  function projectsPanel(s) {
    const list = s.projects.priority;
    return panelX({ title: "مشاريع ذات أولوية", hint: s.projects.focusCount ? `مشاريع التركيز (${s.projects.focusCount}/3) ثم المشاريع النشطة عالية الأولوية.` : "حدّد حتى ثلاثة مشاريع تركيز من صفحة المشروع.", actions: linkButton("كل المشاريع", href("projects", "all"), { icon: "chevronLeft" }) },
      list.length ? h("div", { class: "hq-projects" }, list.slice(0, 4).map((p) => h("a", { class: "hq-project", href: href("projects", "p", p.id) },
        h("div", { class: "hq-project-head" }, h("strong", null, p.name), label("projectStatus", p.status)),
        p.focus ? h("span", { class: "hq-focus-star" }, icon("flag", 14), "مشروع تركيز") : null,
        h("div", { class: "hq-project-meta" },
          h("span", null, `${p.tasks.open} مهمة مفتوحة`), p.tasks.blocked ? h("span", { class: "ops-bad-text" }, `${p.tasks.blocked} متعطّلة`) : null,
          h("span", null, p.checkouts ? `${p.checkouts} نسخة محلية` : "بلا نسخة محلية")),
        p.blocker ? h("small", { class: "co-blocker" }, icon("alert", 14), p.blocker) : null)))
        : empty("لا مشاريع تركيز أو مشاريع نشطة عالية الأولوية بعد.", linkButton("اختر مشاريع التركيز", href("projects", "all"), { kind: "primary" })));
  }

  /** Attention list: blocked work, approvals, router and agent failures — each item once, most severe first. */
  function attentionPanel(s) {
    const items = [];
    if (s.router.state !== "connected" && s.router.state !== "checking") items.push({ sev: "critical", ic: "resources", title: "OmniRoute غير متصل", sub: "لا يمكن تنفيذ طلبات الوكلاء حتى يعود الاتصال.", href: href("resources") });
    for (const a of s.approvals) items.push({ sev: "warning", ic: "shield", title: a.title, sub: `موافقة مطلوبة · ${fmt.relative(a.createdAt)}`, href: href("resources", "routing") });
    for (const t of s.tasks.blocked) items.push({ sev: "warning", ic: "alert", title: t.title, sub: t.blocker ? `متعطّلة: ${t.blocker}` : "مهمة متعطّلة", task: t.id });
    for (const p of s.projects.blocked) items.push({ sev: "warning", ic: "projects", title: p.name, sub: p.blocker ? `مشروع متعطّل: ${p.blocker}` : "مشروع متعطّل", href: href("projects", "p", p.id) });
    // Notifications not already represented elsewhere on this page (overdue tasks live in "today", quota in resource health).
    // Infrastructure incidents and server approvals come once each from the VPS summary below.
    items.push(...(O.serversAttention?.(s) || []));
    const covered = new Set(["task-overdue", "quota", "project-blocked", "approval", "router", "vps", "vps-approval"]);
    for (const n of (s.notifications || []).filter((x) => !x.acknowledged_at && !covered.has(x.kind))) items.push({ sev: n.level, ic: n.kind === "agent-error" ? "agents" : "bell", title: n.title, sub: C.isoText(n.body || fmt.relative(n.last_seen_at)), href: n.target_type === "agent" ? href("agents", n.target_id) : href("system", "activity") });
    const rank = { critical: 0, warning: 1, info: 2 };
    items.sort((a, b) => rank[a.sev] - rank[b.sev]);
    return panelX({ title: "يحتاج انتباهك", hint: "العوائق والموافقات والأعطال المهمة فقط." },
      items.length ? h("ul", { class: "hq-attention" }, items.slice(0, 7).map((item) => h("li", { class: `hq-sev-${item.sev}` },
        h("span", { class: "hq-att-icon" }, icon(item.ic, 20)),
        h("div", null, h("strong", null, O.rich(item.title)), h("small", null, O.rich(item.sub))),
        item.task ? h("button", { type: "button", class: "ops-link", onclick: () => C.openTask(item.task) }, "فتح") : h("a", { class: "ops-link", href: item.href }, "فتح"))))
        : h("div", { class: "co-empty" }, icon("check", 26), h("p", null, "لا شيء يحتاج قرارًا الآن.")));
  }

  function teamPanel(s) {
    return panelX({ title: "فريق الوكلاء", hint: "«جاهز» يعني وجود نموذج مؤهل الآن؛ «يعمل الآن» يعني تشغيلًا محفوظًا جاريًا.", actions: linkButton("الفريق", href("agents"), { icon: "chevronLeft" }) },
      h("ul", { class: "hq-team" }, s.agents.map((a) => h("li", null, h("a", { href: href("agents", a.id) },
        C.avatar(a.id, "md", { state: a.availability }),
        h("span", null, h("strong", null, bdi(a.name)), h("small", null, a.titleAr, a.openTasks ? ` · ${a.openTasks} مهمة` : "")),
        label("availability", a.availability))))));
  }

  function resourcePanel(s) {
    const groups = s.quota.groups;
    const exhausted = groups.reduce((n, g) => n + g.exhausted, 0);
    const low = groups.reduce((n, g) => n + g.low, 0);
    const blockedAgents = s.agents.filter((a) => a.availability === "no-eligible-model").length;
    // Without a router connection neither model eligibility nor quota pressure is known; say so instead of "none".
    const routerOk = s.router.state === "connected";
    const unknown = () => badge("muted", "غير معروف حاليًا");
    return panelX({ title: "صحة الموارد الذكية", hint: "ملخص NEX: الاتصال، والوكلاء بلا نموذج، وضغط الحصص.", actions: linkButton("الموارد الذكية", href("resources"), { icon: "chevronLeft" }) },
      h("div", { class: "hq-resource" },
        h("div", { class: "hq-res-row" }, h("span", null, "OmniRoute"), routerOk ? badge("ok", "متصل") : s.router.state === "checking" ? badge("muted", "جار التحقق") : badge("bad", "غير متصل")),
        h("div", { class: "hq-res-row" }, h("span", null, "وكلاء بلا نموذج مؤهل"), !routerOk ? unknown() : blockedAgents ? badge("warn", String(blockedAgents)) : badge("ok", "لا أحد")),
        h("div", { class: "hq-res-row" }, h("span", null, "نوافذ حصص نافدة / منخفضة"), !routerOk ? unknown() : h("span", null, exhausted ? badge("warn", `${exhausted} نافدة`) : null, " ", low ? badge("muted", `${low} منخفضة`) : null, !exhausted && !low ? badge("ok", "لا ضغط") : null)),
        groups.length ? h("p", { class: "ops-dim" }, "الأكثر تأثرًا: ", groups.slice(0, 3).map((g, i) => [i ? "، " : "", bdi(g.provider)])) : null,
        s.router.lockouts ? h("p", { class: "ops-dim" }, `${s.router.lockouts} قفل مؤقت نشط في الراوتر.`) : null));
  }

  function activityPanel(s) {
    return panelX({ title: "آخر النشاط", actions: linkButton("السجل الكامل", href("system", "activity"), { icon: "chevronLeft" }) },
      s.activity.length ? C.activityList(s.activity.slice(0, 6), { technical: false }) : empty("لا نشاط بعد."));
  }

  function render() {
    const res = O.peek("co:summary");
    const s = data();
    if (!s) { fill(root, hero(null), O.resourceStatus(res, "بيانات الشركة") || O.skeleton(4)); return; }
    fill(root,
      hero(s),
      res?.state === "stale" ? notice("warn", "بيانات قديمة", "فشل آخر تحديث؛ تُعرض آخر بيانات ناجحة.") : null,
      kpis(s),
      h("div", { class: "hq-grid" },
        h("div", { class: "hq-col" }, todayPanel(s), projectsPanel(s), activityPanel(s)),
        h("div", { class: "hq-col" }, attentionPanel(s), teamPanel(s), resourcePanel(s))));
  }

  O.registerView({
    id: "hq", order: 10, icon: "home", ar: "الرئيسية", subtitle: null,
    onShow() { C.co.summary(); C.co.catalog(); C.co.projects(); O.api.overview(); },
    badge() { const s = data(); const n = s ? s.tasks.overdue.length : 0; return n ? { n, tone: "bad", title: `${n} مهمة متأخرة` } : null; }
  });
  O.setActions("hq", () => [h("span", { class: "ops-stamp" }, data() ? `آخر تحديث ${fmt.relative(data().generatedAt)}` : ""), button("تحديث", () => { C.co.summary(true); C.co.notifications(true); }, { icon: "refresh" })]);
  O.on("co:summary", () => { render(); if (O.state.view === "hq") O.refreshHead(); });
  O.on("overview", () => { if (O.state.view === "hq") C.co.summary(true); });
  O.on("co:catalog", render);
  O.on("co:projects", () => { if (O.state.view === "hq") render(); });
  render();
})();
