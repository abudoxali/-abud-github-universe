/* ABUD FUN Company OS V2 — الوكلاء (AI Workforce): the six AI employees, their workspaces, requests and runs.
 * Availability, "working" and results come only from the bridge (live route evaluation + persisted runs): "جاهز" means an
 * eligible model exists now; "يعمل الآن" means a persisted queued/running run exists. The characters are code-built robots
 * (robot-engine.js); their animation state is derived from that same verified state, and success/error reactions fire only
 * for observed run transitions. The owner-supplied artwork remains available as the visual reference. */
(() => {
  "use strict";
  const O = window.AbudOps;
  const C = window.AbudCompany;
  if (!O || !C) return;
  const { h, fill, fmt, badge, notice, L, label, bdi, icon, panel, panelX, empty, button, linkButton, field, select, formValues, href, toast, act, mutate, invalidate } = O;

  const root = O.section("coWorkforce", "agents");
  const AGENT_IDS = ["ori", "mia", "nex", "luna", "zen", "rex"];
  const ui = { agent: null, sub: "overview", runFilter: "", pick: "ori", polling: null, forms: new Map(), previewState: "idle", previewForm: "standard" };
  const agentsRes = () => O.peek("co:agents")?.data?.agents;
  const catalog = () => O.peek("co:catalog")?.data;
  const loadAgents = (force) => O.api.co("agents", "/agents", { force, ttl: 10_000 });
  const loadAgent = (id, force) => O.api.co(`agent:${id}`, `/agents/${id}`, { force, ttl: 8_000 });
  const loadRuns = (force) => O.api.co("runs", "/runs?limit=40", { force, ttl: 8_000 });
  const CLASS_TONE = { free: "ok", "api-free-tier": "info", subscription: "warn", metered: "bad", restricted: "muted", unknown: "muted" };
  const RUN_CAPS = (cat) => ({ ...Object.fromEntries(Object.entries(cat?.capabilities || {}).map(([k, v]) => [k, v.ar])), ...(cat?.internalCapabilities || {}) });
  const row = (k, ...v) => h("div", { class: "ops-row" }, h("dt", null, k), h("dd", null, ...v));

  // ---------------------------------------------------------------- code-built robots (robot-engine.js)
  const R = window.AbudRobots;
  const FORM_AR = { standard: "الهيئة الأساسية", expressive: "هيئة العمل" };
  /** Animation state from verified bridge state only: a persisted running run → working, queued only → thinking,
   * an eligible route → idle, otherwise unavailable. Nothing animates as "working" without a persisted run. */
  function robotState(a, runs) {
    if (!a) return "idle";
    if (a.availability === "disabled" || a.availability === "router-offline") return "unavailable";
    if (runs?.some((r) => r.status === "running")) return "working";
    if (runs?.some((r) => r.status === "queued")) return "thinking";
    if (a.availability === "working") return "working";
    return a.availability === "available" ? "idle" : "unavailable";
  }
  /** One live robot per key: periodic re-renders reuse the same instance, so its animation never restarts. */
  function robot(key, agentId, opts = {}) {
    if (!R) return h("img", { class: "rb-fallback", src: C.agentDef(agentId)?.art?.card || "", alt: "" });
    return R.mount(key, { agentId, ...opts });
  }
  const runSeen = new Map();
  /** Success/error reactions only for an observed transition (queued/running → finished, or a new finished run between
   * polls), or on first sight for a run that finished within the last minute. */
  function watchRuns(agents) {
    for (const a of agents || []) {
      const last = a.lastRun;
      if (!last?.id) continue;
      const prev = runSeen.get(a.id);
      runSeen.set(a.id, { id: last.id, status: last.status });
      if (!["succeeded", "failed"].includes(last.status) || (prev && prev.id === last.id && prev.status === last.status)) continue;
      const observed = prev ? prev.id !== last.id || ["queued", "running"].includes(prev.status) : Boolean(last.finishedAt) && Date.now() - Date.parse(last.finishedAt) < 60_000;
      if (observed) document.querySelectorAll(`svg.rb-robot[data-agent="${a.id}"]`).forEach((el) => el.__robot?.react(last.status === "succeeded" ? "success" : "error"));
    }
  }

  // ---------------------------------------------------------------- safe Markdown → DOM (never HTML)
  function inline(text) {
    const out = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(...O.rich(text.slice(last, m.index)));
      out.push(m[0].startsWith("**") ? h("strong", null, m[0].slice(2, -2)) : h("code", null, m[0].slice(1, -1)));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(...O.rich(text.slice(last)));
    return out;
  }
  function renderMarkdown(text) {
    const out = [];
    let list = null, listTag = null, para = [], code = null;
    const flush = () => { if (para.length) out.push(h("p", null, inline(para.join(" ")))); para = []; };
    for (const raw of String(text).split("\n")) {
      if (code) { if (/^\s*```/.test(raw)) { out.push(h("pre", { dir: "ltr" }, h("code", null, code.join("\n")))); code = null; } else code.push(raw); continue; }
      if (/^\s*```/.test(raw)) { flush(); list = null; code = []; continue; }
      const line = raw.replace(/\s+$/, "");
      if (!line.trim() || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); list = null; continue; }
      const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (heading) { flush(); list = null; out.push(h(heading[1].length <= 2 ? "h3" : "h4", null, inline(heading[2].replace(/\*\*/g, "")))); continue; }
      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) { flush(); list = null; out.push(h("blockquote", null, inline(quote[1]))); continue; }
      const bullet = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
      if (bullet) {
        flush();
        const tag = /\d/.test(bullet[2]) ? "ol" : "ul";
        if (!list || listTag !== tag) { list = h(tag); listTag = tag; out.push(list); }
        list.append(h("li", { class: bullet[1].length >= 2 ? "co-sub" : null }, inline(bullet[3])));
        continue;
      }
      list = null;
      para.push(line.trim());
    }
    if (code) out.push(h("pre", { dir: "ltr" }, h("code", null, code.join("\n"))));
    flush();
    return out;
  }
  const prettyJson = (text) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_) { return text; } };
  const PROGRESS_AR = { queued: "في الطابور", connecting: "يتصل بالراوتر", "waiting-for-model": "ينتظر رد النموذج", "receiving-response": "يستقبل الرد", retrying: "يعيد المحاولة", "switching-provider": "ينتقل إلى مزوّد آخر", completed: "اكتمل", failed: "فشل", cancelled: "أُلغي", blocked: "متوقف" };
  const runProgress = (run) => ["queued", "running"].includes(run.status) ? PROGRESS_AR[run.routing?.progress?.phase] || L.runStatus[run.status] : null;

  // ---------------------------------------------------------------- run list + run drawer
  function runList(runs, { showAgent = true } = {}) {
    const caps = RUN_CAPS(catalog());
    return h("ul", { class: "co-runs" }, runs.map((r) => h("li", { class: `co-run co-run-${r.status}`, "data-run": r.id },
      showAgent ? C.avatar(r.agentId, "md") : h("span", { class: "sy-card-icon" }, icon(r.status === "succeeded" ? "check" : r.status === "failed" ? "alert" : "clock", 20)),
      h("div", { class: "co-run-main" },
        h("div", { class: "co-run-line" }, label("runStatus", r.status), runProgress(r) ? badge("info", runProgress(r)) : null, h("strong", null, caps[r.capability] || r.capability), r.workflowId && !r.parentRunId ? badge("accent", "سير عمل متعدد الوكلاء") : null),
        h("span", { class: "co-run-req" }, r.request.slice(0, 160)),
        h("small", { class: "ops-dim" }, fmt.when(r.createdAt), r.effectiveModel ? [" · ", bdi(r.effectiveModel, "co-tech-soft")] : null, r.latencyMs ? ` · ${fmt.ms(r.latencyMs)}` : "",
          r.promptTokens != null ? ` · ${fmt.num((r.promptTokens || 0) + (r.completionTokens || 0))} رمز` : "",
          r.costUsd != null ? ` · ${fmt.usd(r.costUsd)} تقدير الراوتر` : r.status === "succeeded" && r.costBasis !== "no-inference" ? " · تكلفة غير معروفة" : ""),
        r.errorMessage ? h("small", { class: "ops-bad-text" }, r.errorMessage) : null),
      h("div", { class: "co-run-actions" }, button("النتيجة", () => openRun(r.id), { icon: "chevronLeft" }),
        ["queued", "running"].includes(r.status) ? button("إلغاء", async (e) => { if (await act(e.currentTarget, () => mutate("POST", `/runs/${r.id}/cancel`, {}), "طُلب الإلغاء")) invalidate("agents", "agent:", "runs"); }) : null))));
  }
  async function openRun(id) {
    const d = O.drawer("نتيجة التشغيل", { wide: true });
    fill(d.body, O.skeleton(5));
    let run;
    try { run = await fetch(`/local-api/company/runs/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error("تعذر التحميل")))); }
    catch (error) { fill(d.body, notice("bad", "تعذر التحميل", error.message)); return; }
    const caps = RUN_CAPS(catalog());
    const def = C.agentDef(run.agentId);
    d.heading.textContent = `${def?.name || run.agentId} · ${caps[run.capability] || run.capability}`;
    const routing = run.routing;
    fill(d.body,
      h("div", { class: "co-run-summary" }, C.avatar(run.agentId, "lg"), h("div", null, h("div", { class: "co-inline" }, label("runStatus", run.status), label("priority", run.priority)),
        h("small", { class: "ops-dim" }, `أُنشئ ${fmt.when(run.createdAt)}${run.startedAt ? ` · بدأ ${fmt.when(run.startedAt)}` : ""}${run.finishedAt ? ` · انتهى ${fmt.when(run.finishedAt)}` : ""}`))),
      run.errorMessage ? notice(run.status === "blocked" ? "warn" : "bad", run.status === "blocked" ? "التشغيل متوقف" : "فشل التشغيل", `${run.errorCategory || ""}: ${run.errorMessage}`,
        run.approvalId ? h("a", { class: "ops-link", href: href("resources", "routing"), onclick: () => d.close() }, "افتح طلب الموافقة") : null) : null,
      run.output ? panel("النتيجة", run.costBasis === "no-inference" ? "خطوة حتمية بلا استدعاء نموذج." : null,
        run.costBasis === "no-inference" ? h("pre", { class: "co-json", dir: "ltr" }, prettyJson(run.output)) : h("div", { class: "co-output" }, renderMarkdown(run.output)),
        run.effectiveModel ? h("p", { class: "pj-evidence" }, icon("resources", 16), "المصدر: ", bdi(run.effectiveModel), " عبر OmniRoute", run.provider ? [" · ", bdi(run.provider)] : null) : null)
        : ["queued", "running"].includes(run.status) ? notice("info", runProgress(run) || "التشغيل جارٍ", "ستظهر النتيجة هنا بعد حفظها. لا يظهر «اكتمل» إلا بعد حفظ النتيجة.") : null,
      panel("الطلب", null, h("p", { class: "co-pre" }, run.request)),
      run.steps?.length ? panel("خطوات سير العمل", "كل خطوة تشغيل مستقل محفوظ.", runList(run.steps)) : null,
      h("details", { class: "ops-panel" }, h("summary", null, "الاستهلاك والتوجيه (تفاصيل تقنية)"),
        h("dl", { class: "ops-dl" },
          row("النموذج الفعلي", run.effectiveModel ? bdi(run.effectiveModel) : "—"), row("المزوّد", run.provider ? bdi(run.provider) : "—"),
          row("رموز الإدخال / الإخراج", run.promptTokens != null ? `${fmt.num(run.promptTokens)} / ${fmt.num(run.completionTokens)}${run.reasoningTokens ? ` (منها ${fmt.num(run.reasoningTokens)} تفكير)` : ""}` : "—"),
          row("التكلفة", run.costUsd != null ? `${fmt.usd(run.costUsd)} — ${run.costBasis === "router-estimate" ? "تقدير الراوتر، ليست فاتورة" : run.costBasis}` : run.costBasis === "no-inference" ? "لا استدلال" : "غير معروفة"),
          row("زمن الاستجابة", run.latencyMs ? fmt.ms(run.latencyMs) : "—"), row("المحاولات", String(run.attempts || 0))),
        routing ? h("div", null, h("h4", null, "لماذا هذا النموذج؟"), routeTable(routing)) : null,
        run.toolCalls?.length ? h("div", null, h("h4", null, "استدعاءات الأدوات"), h("ul", { class: "ops-list" }, run.toolCalls.map((t) => h("li", null, t.ok ? badge("ok", "نجح") : badge("bad", t.error || "رُفض"), bdi(t.tool), t.ms != null ? h("span", { class: "ops-dim" }, fmt.ms(t.ms)) : null)))) : null));
  }
  function routeTable(route) {
    const cat = catalog();
    return h("div", { class: "ops-tablewrap" }, h("table", { class: "ops-table" },
      h("thead", null, h("tr", null, ["المرشح", "الفئة", "القرار", "السبب"].map((x) => h("th", { scope: "col" }, x)))),
      h("tbody", null, route.candidates.map((c) => h("tr", null,
        h("th", { scope: "row" }, bdi(c.ref), c.ref === route.chosen ? [" ", badge("ok", "المختار")] : null),
        h("td", null, badge(CLASS_TONE[c.class] || "muted", cat?.classes?.[c.class]?.ar?.split(" — ")[0] || c.class)),
        h("td", null, c.eligible ? (c.needsApproval ? badge("warn", "يحتاج موافقة") : badge("ok", "مؤهل")) : badge("muted", "مستبعد")),
        h("td", null, c.reasons.map((r) => r.ar).join(" · ")))))),
      route.attempts?.length ? h("p", { class: "ops-dim" }, "المحاولات: ", route.attempts.map((a, i) => [i ? "، " : "", bdi(`${a.ref} → ${a.code}`)])) : null);
  }

  // ---------------------------------------------------------------- team overview
  function agentCard(a) {
    const last = a.lastRun;
    return h("article", { class: `ag-card co-avail-${a.availability}`, style: `--agent:${a.color}`, "data-agent": a.id },
      h("a", { class: "ag-stage", href: href("agents", a.id), "aria-label": `مساحة عمل ${a.name}` }, robot(`card:${a.id}`, a.id, { variant: "standard", animationState: robotState(a), size: 230 })),
      h("div", { class: "ag-info" },
        h("div", { class: "ag-name" }, h("h3", null, bdi(a.name), h("span", null, `0${a.order}`)), label("availability", a.availability)),
        h("p", { class: "ag-role" }, `${a.titleAr} · ${a.roleAr}`),
        h("dl", { class: "ag-facts" },
          h("div", null, h("dt", null, "المهمة الحالية"), h("dd", { title: a.currentTask?.title || "" }, a.currentTask ? a.currentTask.title : a.activeRuns ? "تشغيل جارٍ" : "—")),
          h("div", null, h("dt", null, "مهام مفتوحة"), h("dd", null, String(a.openTasks))),
          h("div", null, h("dt", null, "النموذج الآن"), h("dd", null, a.route.chosen ? bdi(a.route.chosen.split("/").pop(), "co-tech-soft") : h("span", { class: "ops-dim" }, "لا يوجد"))),
          h("div", null, h("dt", null, "آخر تشغيل"), h("dd", null, last ? `${L.runStatus[last.status]} · ${fmt.relative(last.finishedAt || last.createdAt)}` : "—"))),
        h("div", { class: "ag-actions" }, linkButton("مساحة العمل", href("agents", a.id), { kind: "primary" }), linkButton("طلب جديد", href("agents", "request", a.id), { icon: "play" }))));
  }
  function renderTeam() {
    const agents = agentsRes();
    if (!agents) { fill(root, O.resourceStatus(O.peek("co:agents"), "فريق الوكلاء") || O.skeleton(5)); return; }
    const ready = agents.filter((a) => ["available", "working"].includes(a.availability)).length;
    const working = agents.filter((a) => a.availability === "working").length;
    const runs24 = agents.reduce((n, a) => n + (a.usage24h?.runs || 0), 0);
    const runs = O.peek("co:runs")?.data?.runs;
    fill(root,
      h("section", { class: "ag-hero ag-hero-compact", "aria-labelledby": "agHeroTitle" },
        h("div", null,
          h("h2", { id: "agHeroTitle" }, "ستة موظفين، هوية واحدة"),
          h("p", null, "كل وكيل له دور ثابت وصلاحيات تُفرض في الخادم. يمر كل طلب عبر OmniRoute وفق سياسة التوجيه والميزانية."),
          h("div", { class: "ag-hero-stats" },
            h("div", { class: "ag-hero-stat" }, h("strong", null, `${ready}/6`), h("span", null, "جاهزون الآن")),
            h("div", { class: "ag-hero-stat" }, h("strong", null, String(working)), h("span", null, "يعملون الآن")),
            h("div", { class: "ag-hero-stat" }, h("strong", null, String(runs24)), h("span", null, "تشغيلات آخر 24 ساعة"))),
          ),
        h("div", { class: "hq-hero-actions" }, linkButton("طلب جديد لوكيل", href("agents", "request"), { kind: "primary", icon: "play" }))),
      h("div", { class: "ag-grid" }, agents.map(agentCard)),
      panelX({ title: "أحدث النشاط", hint: "كل تشغيل يُحفظ قبل بدئه؛ لا يظهر «اكتمل» إلا بعد حفظ النتيجة.", actions: linkButton("كل التشغيلات", href("agents", "runs"), { icon: "chevronLeft" }) },
        runs ? (runs.length ? runList(runs.filter((r) => !r.parentRunId).slice(0, 5)) : empty("لا تشغيلات بعد. أرسل أول طلب لأحد الوكلاء.")) : O.skeleton(3)));
  }

  // ---------------------------------------------------------------- request composer (choose agent → project → describe → review → send)
  function composer(preset = {}, hooks = {}) {
    const cat = catalog();
    const agents = cat?.agents || [];
    let agentId = preset.agentId && agents.some((a) => a.id === preset.agentId) ? preset.agentId : ui.pick;
    const capSel = h("select", { class: "ops-input", name: "capability", "aria-label": "نوع المهمة" });
    const projectSel = select("projectId", [["", "بدون مشروع"], ...C.projectOptions(false)], preset.projectId || "", { "aria-label": "المشروع" });
    const request = h("textarea", { class: "ops-input", name: "request", rows: 4, maxlength: 4000, placeholder: "اكتب طلبك بالعربية… مثال: لخّص حالة المشاريع المتعطّلة واقترح أولويات الأسبوع.", "aria-label": "نص الطلب" });
    const review = h("div", { class: "ops-notice ops-notice-info", role: "status" });
    const picker = h("div", { class: "ag-picker", role: "radiogroup", "aria-label": "اختر الوكيل" });
    const drawPicker = () => fill(picker, agents.map((a) => h("button", { type: "button", role: "radio", class: "ag-pick", style: `--agent:${a.color}`, "aria-checked": String(a.id === agentId),
      onclick: () => { agentId = a.id; ui.pick = a.id; drawPicker(); fillCaps(); hooks.onAgent?.(agentId); } }, C.avatar(a.id, "md"), h("strong", null, bdi(a.name)), h("small", null, a.titleAr))));
    const fillCaps = () => {
      const def = agents.find((a) => a.id === agentId);
      fill(capSel, (def?.capabilities || ["chat"]).map((c) => h("option", { value: c, selected: c === preset.capability ? true : null }, cat?.capabilities?.[c]?.ar || c)));
      toggleProject();
      drawReview();
    };
    const toggleProject = () => {
      const assess = capSel.value === "project_assessment";
      projectSel.required = assess;
      request.required = !assess;
      request.placeholder = assess ? "اختياري: ما الذي تريد التركيز عليه في التقييم؟" : "اكتب طلبك بالعربية…";
    };
    const drawReview = () => {
      const a = (agentsRes() || []).find((x) => x.id === agentId);
      const def = agents.find((x) => x.id === agentId);
      fill(review, icon(a?.route?.chosen ? "info" : "alert", 20), h("div", { class: "ops-notice-main" },
        h("strong", null, `المراجعة قبل الإرسال — ${def?.name || ""}`),
        h("p", null, a ? (a.route.chosen ? ["سيُنفَّذ الآن عبر ", bdi(a.route.chosen), ` (${L.availability[a.availability]}). `] : [`لا نموذج مؤهل الآن (${L.availability[a.availability]}). سيُحفظ الطلب ويتوقف مع سبب واضح. `]) : "جارٍ التحقق من التوجيه… ",
          "الاستدلال المدفوع والميزانيات تخضع للموافقة والحدود تلقائيًا؛ لا تُرسل أسرارًا.")));
    };
    capSel.addEventListener("change", () => { toggleProject(); });
    request.addEventListener("focus", () => hooks.onState?.("listening"));
    request.addEventListener("blur", () => hooks.onState?.("idle"));
    const form = h("form", { class: "co-composer", "aria-label": "طلب جديد لوكيل", onsubmit: async (event) => {
      event.preventDefault();
      const v = formValues(form);
      if (v.capability === "project_assessment" && !v.projectId) { toast("اختر المشروع المراد تقييمه", "bad"); projectSel.focus(); return; }
      if (!["project_assessment", "infra_assessment"].includes(v.capability) && !v.request) { toast("اكتب نص الطلب", "bad"); request.focus(); return; }
      hooks.onState?.("thinking");
      const run = await act(form.querySelector("[type=submit]"), () => mutate("POST", "/runs", { agentId, capability: v.capability, projectId: v.projectId || undefined, request: v.request, priority: v.priority,
        idempotencyKey: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }), "أُرسل الطلب؛ تابع التقدم في مساحة الوكيل");
      if (!run) hooks.onState?.("idle");
      if (run) { request.value = ""; invalidate("agents", "agent:", "summary", "activity", "runs"); O.go("agents", agentId, "runs"); startPolling(); }
    } },
    h("div", null, h("p", { class: "co-field" }, h("span", null, "1. الوكيل")), picker),
    h("div", { class: "co-form-row" }, field("2. نوع المهمة", capSel), field("المشروع (اختياري)", projectSel), field("الأولوية", select("priority", Object.entries(L.priority), preset.priority || "medium"))),
    field("3. الطلب", request),
    review,
    h("div", { class: "co-form-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, icon("play", 18), "إرسال للوكيل")));
    drawPicker(); fillCaps(); hooks.onAgent?.(agentId);
    ui.drawReview = drawReview;
    return form;
  }
  function renderRequest(presetAgent) {
    if (!catalog()) { fill(root, O.skeleton(4)); return; }
    const preview = h("div", { class: "ag-req-preview" });
    let current = null;
    const liveOf = (id) => (agentsRes() || []).find((x) => x.id === id);
    const drawPreview = (id) => {
      current = id;
      const def = catalog()?.agents?.find((x) => x.id === id);
      if (!def) return;
      const live = liveOf(id);
      preview.style.setProperty("--agent", def.color);
      fill(preview,
        h("div", { class: "ag-req-stage" }, robot("req:preview", id, { variant: "standard", animationState: robotState(live), size: 220 })),
        h("div", { class: "ag-req-copy" }, h("strong", null, bdi(def.name), h("span", null, ` · ${def.titleAr}`)), h("p", null, def.roleAr), live ? label("availability", live.availability) : null));
    };
    const setState = (state) => {
      const base = robotState(liveOf(current));
      preview.querySelector("svg.rb-robot")?.__robot?.set({ animationState: base === "unavailable" || state === "idle" ? base : state });
    };
    fill(root, h("div", { class: "pj-detail-grid ag-req-grid" },
      panel("طلب جديد", "اختر المتخصص المناسب. لتقييم مشروع كامل استخدم ORI ← «تقييم حالة مشروع» (يشارك NEX وREX وLUNA تلقائيًا باستدعاء نموذج واحد).", composer({ agentId: presetAgent }, { onAgent: drawPreview, onState: setState })),
      panel("الوكيل المختار", "يستمع أثناء كتابتك ويفكر أثناء الإرسال؛ حالته الفعلية تأتي من الخادم.", preview)));
  }

  // ---------------------------------------------------------------- all runs
  function renderRuns() {
    const runs = O.peek("co:runs")?.data?.runs;
    if (!runs) { fill(root, O.resourceStatus(O.peek("co:runs"), "التشغيلات") || O.skeleton(4)); return; }
    const top = runs.filter((r) => !r.parentRunId && (!ui.runFilter || r.agentId === ui.runFilter || r.status === ui.runFilter));
    fill(root, panelX({ title: "سجل التشغيلات", hint: "آخر 40 تشغيلًا (خطوات سير العمل تظهر داخل تشغيلها الرئيسي).",
      actions: select("runFilter", [["", "كل التشغيلات"], ...AGENT_IDS.map((id) => [id, C.agentDef(id)?.name || id.toUpperCase()]), ...Object.entries(L.runStatus).map(([k, v]) => [k, `الحالة: ${v}`])], ui.runFilter, { "aria-label": "تصفية التشغيلات", onchange: (e) => { ui.runFilter = e.target.value; renderRuns(); } }) },
    top.length ? runList(top) : empty("لا تشغيلات مطابقة.")));
  }

  // ---------------------------------------------------------------- agent workspace
  const SUBS = [["overview", "نظرة عامة"], ["tasks", "المهام"], ["runs", "التشغيلات"], ["tools", "الأدوات والصلاحيات"], ["routing", "النموذج والتوجيه"], ["memory", "الذاكرة والسياق"], ["settings", "الإعدادات"], ["art", "الشخصية والحركة"]];
  function renderAgent(id) {
    if (O.editing(root, () => render())) return;
    const res = O.peek(`co:agent:${id}`);
    const a = res?.data;
    const def = catalog()?.agents?.find((x) => x.id === id);
    if (!def) { O.setHead("agents", null); fill(root, catalog() ? notice("bad", "وكيل غير معروف", "لا يوجد وكيل بهذا المعرّف.") : O.skeleton(4)); return; }
    O.setHead("agents", { tab: "workspace", title: `${def.name} — ${def.titleAr}`, subtitle: def.roleAr, back: [href("agents"), "الفريق"], hideTabs: true });
    const sub = SUBS.some(([s]) => s === ui.sub) ? ui.sub : "overview";
    const form = ui.forms.get(id) || "standard";
    const liveState = robotState(a, a?.runs);
    const stage = robot(`ws:${id}`, id, { variant: form, animationState: liveState, size: 330 });
    if (!stage.__wsBound) { stage.__wsBound = true; stage.addEventListener("click", () => stage.__robot?.react("greeting")); }
    if (a) watchRuns([a]);
    fill(root,
      h("section", { class: "ag-ws-hero", style: `--agent:${def.color}` },
        h("div", { class: "ag-ws-stage" }, stage,
          h("div", { class: "ag-form-toggle", role: "group", "aria-label": "هيئة الشخصية" }, ["standard", "expressive"].map((v) =>
            h("button", { type: "button", class: "ag-form-btn", "aria-pressed": String(v === form), onclick: () => { ui.forms.set(id, v); render(); } }, FORM_AR[v])))),
        h("div", { class: "ag-ws-copy" },
          h("h2", null, bdi(def.name), h("small", null, `${def.titleAr} · 0${def.order}`)),
          h("p", null, def.summaryAr),
          h("div", { class: "ag-ws-badges" }, a ? label("availability", a.availability) : badge("muted", "جارٍ التحقق"),
            R && a ? h("span", { class: "ops-chip" }, h("span", { class: "ag-swatch" }), `الحالة الحية: ${R.STATE_AR[liveState]}`) : null,
            a?.config ? badge("accent", `الوضع: ${catalog()?.modes?.[a.config.mode]?.ar || a.config.mode}`) : null,
            a?.route?.chosen ? h("span", { class: "ops-chip" }, "النموذج الآن: ", bdi(a.route.chosen)) : null,
),
          h("div", { class: "ag-actions" }, linkButton(`طلب جديد إلى ${def.name}`, href("agents", "request", def.id), { kind: "primary", icon: "play" }), button("تحديث", () => loadAgent(id, true), { icon: "refresh" })))),
      h("nav", { class: "os-tabs", "aria-label": `أقسام مساحة ${def.name}` }, SUBS.map(([s, text]) => h("a", { class: `os-tab${s === sub ? " os-tab-current" : ""}`, href: href("agents", id, s), "aria-current": s === sub ? "page" : null }, text))),
      a ? tabContent(sub, a, def) : (O.resourceStatus(res, def.name) || O.skeleton(4)));
  }
  function saveAgent(id, patch, msg = "حُفظت إعدادات الوكيل", trigger = null) {
    return act(trigger, () => mutate("PATCH", `/agents/${id}`, patch), msg).then((r) => { if (r) invalidate(`agent:${id}`, "agents", "activity"); return r; });
  }
  function tabContent(tab, a, def) {
    const cat = catalog();
    const openTasks = a.tasks.filter((t) => !["done", "cancelled"].includes(t.status));
    if (tab === "overview") {
      const active = a.runs.filter((r) => ["queued", "running"].includes(r.status));
      return [
        active.length ? notice("info", "تشغيل جارٍ", `${active.length} تشغيل في الطابور أو قيد التنفيذ. الصفحة تتحدّث تلقائيًا كل 3 ثوانٍ أثناء التشغيل.`) : null,
        a.availability === "no-eligible-model" ? notice("warn", "لا نموذج مؤهل الآن", "كل مرشحي سياسة التوجيه مستبعدون (حصة نافدة أو فئة غير مسموحة أو لا اتصال). راجع «النموذج والتوجيه».") : null,
        a.availability === "router-offline" ? notice("bad", "OmniRoute غير متصل", "لا يمكن تنفيذ أي استدلال حتى يعود الاتصال.") : null,
        a.availability === "disabled" ? notice("warn", "الوكيل معطّل", "فعّله من «الإعدادات» لقبول طلبات جديدة.") : null,
        h("div", { class: "os-kpis" },
          O.kpi({ label: "مهام مفتوحة", value: openTasks.length, ic: "work" }), O.kpi({ label: "تشغيلات 24 ساعة", value: a.usage24h.runs, ic: "activity" }),
          O.kpi({ label: "رموز 24 ساعة", value: fmt.compact(a.usage24h.tokens), hint: "قياس التطبيق", ic: "gauge" }), O.kpi({ label: "تكلفة تقديرية 24 ساعة", value: fmt.cost(a.usage24h), hint: a.usage24h.unknownCostEvents ? "الراوتر لم يبلغ تكلفة بعض التشغيلات" : "تقدير الراوتر، ليست فاتورة", ic: "wallet" })),
        h("div", { class: "co-columns" },
          panelX({ title: "طابور المهام", hint: `${openTasks.length} مهمة مفتوحة مسندة`, actions: linkButton("كل المهام", href("agents", def.id, "tasks"), { icon: "chevronLeft" }) }, C.taskList(openTasks.slice(0, 5)) || empty("لا مهام مسندة.")),
          panelX({ title: "آخر التشغيلات", actions: linkButton("السجل", href("agents", def.id, "runs"), { icon: "chevronLeft" }) }, a.runs.length ? runList(a.runs.slice(0, 4), { showAgent: false }) : empty("لا تشغيلات بعد."))),
        h("div", { class: "co-columns" },
          panel("المسؤوليات", null, h("ul", { class: "co-bullets" }, def.responsibilitiesAr.map((x) => h("li", null, x)))),
          panel("الحدود", "تُفرض الصلاحيات في الخادم، لا بتعليمات النموذج.", h("ul", { class: "co-bullets co-bullets-guard" }, def.boundariesAr.map((x) => h("li", null, x))))),
        h("div", { class: "co-columns" },
          panel("المشاريع المرتبطة", null, a.config.projects.length ? h("div", { class: "co-inline" }, a.config.projects.map((pid) => h("a", { class: "ops-chip", href: href("projects", "p", pid) }, C.projectName(pid) || pid))) : empty("لا مشاريع مرتبطة. اربطه من صفحة المشروع.")),
          panel("النشاط والأخطاء", null, a.activity.length ? C.activityList(a.activity.slice(0, 8)) : empty("لا نشاط.")))];
    }
    if (tab === "tasks") return [panel(["مهمة جديدة مسندة إلى ", bdi(def.name)], null, C.stableQuickAdd(`agent:${def.id}`, { assignee: def.id })), panel("كل المهام المسندة", null, C.taskList(a.tasks) || empty("لا مهام."))];
    if (tab === "runs") return panel("سجل التشغيلات", "آخر 30 تشغيلًا، الأحدث أولًا.", a.runs.length ? runList(a.runs, { showAgent: false }) : empty("لا تشغيلات."));
    if (tab === "tools") {
      const allowed = new Set(a.config.tools);
      return [
        notice("info", "صلاحيات قابلة للتضييق فقط", "يمكنك سحب أداة من الوكيل، لكن لا يمكن منحه أداة خارج مجموعته المعتمدة في الكود. لا يوجد تنفيذ Shell أو وصول ملفات عشوائي أو طلبات شبكة مفتوحة."),
        h("div", { class: "ops-tablewrap" }, h("table", { class: "ops-table" },
          h("thead", null, h("tr", null, ["الأداة", "الوصف", "النوع", "الموافقة", "الحد/دقيقة", "مسموحة"].map((x) => h("th", { scope: "col" }, x)))),
          h("tbody", null, cat.tools.filter((t) => def.tools.includes(t.id)).map((t) => h("tr", null,
            h("th", { scope: "row" }, t.ar, h("div", null, bdi(t.id, "co-tech-soft"))),
            h("td", null, bdi(t.description, "co-tech-soft")),
            h("td", null, t.readOnly ? badge("ok", "قراءة فقط") : badge("warn", "كتابة داخلية")),
            h("td", null, t.approval === "always" ? badge("warn", "دائمًا") : badge("muted", "لا")),
            h("td", null, String(t.ratePerMin)),
            h("td", null, h("input", { type: "checkbox", checked: allowed.has(t.id) ? true : null, "aria-label": `السماح بـ ${t.ar}`,
              onchange: (e) => saveAgent(def.id, { tools: e.target.checked ? [...allowed, t.id] : [...allowed].filter((x) => x !== t.id) }, e.target.checked ? "أُعيدت الأداة" : "سُحبت الأداة") }))))))),
        h("p", { class: "ops-dim" }, `أدوات ليست ضمن صلاحيات ${def.name}: ${cat.tools.filter((t) => !def.tools.includes(t.id)).map((t) => t.ar).join("، ") || "—"}.`)];
    }
    if (tab === "routing") {
      const preview = a.routePreview;
      const domainSel = select("policyDomain", Object.entries(cat.domains), a.config.policyDomain, { "aria-label": "مجال السياسة" });
      const modeSel = select("mode", Object.entries(cat.modes).filter(([m]) => def.id !== "rex" || ["strict", "analytical"].includes(m)).map(([m, v]) => [m, v.ar]), a.config.mode, { "aria-label": "وضع التشغيل" });
      const override = h("input", { class: "ops-input", dir: "ltr", name: "modelOverride", value: a.config.modelOverride || "", placeholder: "provider/model (اختياري)", "aria-label": "نموذج مفضل" });
      return [
        panel("لماذا يختار هذا الوكيل هذا النموذج الآن؟", `تقييم حي لسياسة «${cat.domains[preview.domain]}» مقابل حالة OmniRoute${preview.evaluatedAt ? ` (${fmt.when(preview.evaluatedAt)})` : ""}.`, routeTable(preview)),
        panel("الإعداد", "النموذج المفضل يُضاف أول قائمة المرشحين لكنه يمر بنفس فحوص الامتثال والحصة والميزانية.",
          h("div", { class: "co-form-row" }, field("مجال السياسة", domainSel), field("وضع التشغيل", modeSel, cat.modes[a.config.mode]?.note), field("نموذج مفضل", override)),
          h("div", { class: "co-form-actions" }, button("حفظ", (e) => saveAgent(def.id, { policyDomain: domainSel.value, mode: modeSel.value, modelOverride: override.value.trim() || null }, undefined, e.currentTarget), { kind: "primary" }))),
        panel("السياسة المطبقة", null, h("dl", { class: "ops-dl" },
          row("المرشحون", h("ol", { class: "co-ol" }, a.policy.candidates.map((c) => h("li", null, bdi(c))))),
          row("الفئات المسموحة", h("span", { class: "co-inline" }, a.policy.allowClasses.map((c) => badge(CLASS_TONE[c] || "muted", cat.classes[c]?.ar?.split(" (")[0] || c)))),
          row("أقصى إعادة محاولة", String(a.policy.maxRetries)), row("حماية الحصة", `${a.policy.quotaProtectPct}% (للأولوية غير العالية)`),
          row("الموافقة", { none: "لا", paid: "للاستدلال المدفوع", always: "لكل تشغيل" }[a.policy.approval]), row("أقصى رموز إخراج", fmt.num(a.policy.maxOutputTokens))),
          linkButton("تعديل سياسات التوجيه والميزانيات", href("resources", "routing"), { icon: "chevronLeft" }))];
    }
    if (tab === "memory") {
      const title = h("input", { class: "ops-input", maxlength: 120, placeholder: "عنوان الملاحظة", "aria-label": "عنوان الملاحظة" });
      const text = h("textarea", { class: "ops-input", rows: 3, maxlength: 2000, placeholder: "معلومة ثابتة يحتاجها الوكيل (لا أسرار ولا مفاتيح)", "aria-label": "نص الملاحظة" });
      return [
        notice("info", "ذاكرة صريحة ومحدودة", "لا تُحفظ المحادثات الخام. يُرسل للنموذج فقط: ملاحظات الشركة + ملاحظات هذا الوكيل + ملاحظات المشروع المعتمدة، بحد أقصى نحو 2400 حرف، مع مصدر وتاريخ كل ملاحظة."),
        panel(["ملاحظة جديدة لذاكرة ", bdi(def.name)], null, field("العنوان", title), field("المحتوى", text),
          button("حفظ الملاحظة", async (e) => { if (!title.value.trim() || !text.value.trim()) { toast("أدخل العنوان والمحتوى", "bad"); return; } if (await act(e.currentTarget, () => mutate("POST", "/memory", { scope: "agent", scopeRef: def.id, title: title.value, body: text.value }), "حُفظت")) invalidate(`agent:${def.id}`); }, { kind: "primary" })),
        panel("ملاحظات الوكيل", null, a.memory.length ? h("ul", { class: "co-memory" }, a.memory.map((m) => h("li", null,
          h("div", { class: "co-inline" }, h("strong", null, m.title), m.approved ? badge("ok", "معتمدة") : badge("warn", "بانتظار المراجعة"), h("small", { class: "ops-dim" }, fmt.when(m.updatedAt))), h("p", { class: "co-pre" }, m.body),
          button("حذف", async (e) => { if (!(await O.confirmDialog({ title: "حذف الملاحظة؟", body: `«${m.title}» ستُحذف من ذاكرة ${def.name}.`, confirm: "حذف", tone: "danger" }))) return; if (await act(e.currentTarget, () => mutate("DELETE", `/memory/${m.id}`), "حُذفت")) invalidate(`agent:${def.id}`); })))) : empty("لا ملاحظات."))];
    }
    if (tab === "settings") {
      const instructions = h("textarea", { class: "ops-input", rows: 6, maxlength: 4000, "aria-label": "تعليمات المالك" }, a.config.instructions || "");
      const enabled = h("input", { type: "checkbox", checked: a.config.enabled ? true : null });
      return [
        panel("التشغيل", null, h("label", { class: "co-check-field" }, enabled, h("span", null, h("strong", null, `${def.name} مفعّل`), h("small", null, "عند التعطيل تُرفض الطلبات الجديدة ولا تُحذف السجلات."))),
          h("div", { class: "co-form-actions" }, button("حفظ", (e) => saveAgent(def.id, { enabled: enabled.checked }, undefined, e.currentTarget)))),
        panel("تعليمات المالك", "تُضاف إلى تعليمات الدور الثابتة؛ لا يمكنها تجاوز الصلاحيات أو الموافقات أو الميزانيات.", instructions, h("div", { class: "co-form-actions" }, button("حفظ التعليمات", (e) => saveAgent(def.id, { instructions: instructions.value }, undefined, e.currentTarget), { kind: "primary" }))),
        panel("الهوية", "الهوية ثابتة في الكود ولا تُعدّل من الواجهة.", h("dl", { class: "ops-dl" }, row("المعرّف", bdi(def.id)), row("اللون", h("span", { class: "co-swatch", style: `background:${def.color}` }), " ", bdi(def.color)), row("القدرات", def.capabilities.map((c) => cat.capabilities[c]?.ar || c).join("، "))))];
    }
    if (tab === "art") {
      const original = h("div", { class: "co-art-grid" },
        h("figure", null, h("img", { src: def.art.full || def.art.card, alt: `${def.name} — ${def.art.full ? "صورة كاملة" : "بطاقة الفريق"}`, loading: "lazy" }), h("figcaption", null, def.art.full ? "الصورة الكاملة الأصلية" : "بطاقة الفريق الأصلية (لا توجد صورة كاملة منفصلة)")),
        h("figure", { class: "co-art-wide" }, h("img", { src: def.art.sheet, alt: `${def.name} — ورقة تصميم الشخصية`, loading: "lazy", style: "background:#0d0d14" }), h("figcaption", null, "ورقة الشخصية الأصلية (زوايا، تعابير، أوضاع، خامات)")),
        h("p", { class: "ops-dim" }, "ملفات المالك الأصلية كما سُلّمت دون قص؛ هي مرجع التصميم الذي بُنيت منه الشخصية بالكود."));
      if (!R) return original;
      const spec = R.AGENTS[def.id];
      const preview = robot(`art:${def.id}:preview`, def.id, { variant: ui.previewForm, animationState: ui.previewState, size: 280 });
      const stateSel = select("rbState", R.STATES.map((x) => [x, R.STATE_AR[x]]), ui.previewState, { "aria-label": "حالة المعاينة",
        onchange: (e) => { ui.previewState = e.target.value; preview.__robot?.set({ animationState: ui.previewState }); } });
      const formSel = select("rbForm", Object.entries(FORM_AR), ui.previewForm, { "aria-label": "هيئة المعاينة",
        onchange: (e) => { ui.previewForm = e.target.value; preview.__robot?.set({ variant: ui.previewForm }); } });
      return [
        panel("الشخصية المبنية بالكود", "هندسة متجهة مبنية بالكود (رأس وأذنان ووحدات جانبية وقناع وعينان وجذع ونواة ومفاصل وأطراف وأحذية) بمفاصل متحركة مستقلة؛ لا تُستخدم صورة كجسم للشخصية.",
          h("div", { class: "rb-forms" }, ["standard", "expressive"].map((v) => h("figure", { class: "rb-form", style: `--agent:${def.color}` },
            h("div", { class: "rb-form-stage" }, robot(`art:${def.id}:${v}`, def.id, { variant: v, animationState: "idle", size: 260 })),
            h("figcaption", null, h("strong", null, FORM_AR[v]), ` — ${spec.forms[v].ar}`))))),
        panel("معاينة الحركات", "معاينة للتصميم فقط ولا تعكس حالة تشغيل حقيقية. الحالة الحية تظهر في رأس مساحة العمل.",
          h("div", { class: "rb-preview", style: `--agent:${def.color}` }, h("div", { class: "rb-form-stage" }, preview),
            h("div", { class: "rb-preview-controls" }, field("الحالة", stateSel), field("الهيئة", formSel),
              button("تحية", () => preview.__robot?.react("greeting"), { icon: "sparkle" }),
              h("p", { class: "ops-dim" }, "يحترم إعداد «تقليل الحركة» في النظام: تُعرض لقطة ثابتة لكل حالة.")))),
        h("details", { class: "ops-panel" }, h("summary", null, "المرجع البصري الأصلي (ملفات المالك)"), original)];
    }
    return null;
  }

  // ---------------------------------------------------------------- routing + polling
  function render() {
    if (O.state.view !== "agents") return;
    if (O.state.tab === "workspace" && ui.agent) return renderAgent(ui.agent);
    O.setHead("agents", null);
    if (O.state.tab === "request") return renderRequest(O.state.rest[0]);
    if (O.state.tab === "runs") return renderRuns();
    return renderTeam();
  }
  function anyActive() {
    const detail = ui.agent ? O.peek(`co:agent:${ui.agent}`)?.data : null;
    return (agentsRes() || []).some((a) => a.activeRuns > 0) || (detail?.runs || []).some((r) => ["queued", "running"].includes(r.status));
  }
  function startPolling() {
    if (ui.polling) return;
    ui.polling = setInterval(() => {
      if (O.state.view !== "agents" || document.hidden) return;
      if (!anyActive()) { clearInterval(ui.polling); ui.polling = null; return; }
      if (ui.agent) loadAgent(ui.agent, true); else { loadAgents(true); loadRuns(true); }
      invalidate("summary", "tasks", "activity");
    }, 3000);
  }

  O.registerView({
    id: "agents", order: 40, icon: "agents", ar: "الوكلاء", subtitle: "ستة موظفين ذكاء اصطناعي بأدوار ثابتة، يعملون عبر OmniRoute وتحت صلاحيات يفرضها الخادم.",
    tabs: [["team", "الفريق"], ["request", "طلب جديد"], ["runs", "التشغيلات"], ["workspace", "مساحة الوكيل", { hidden: true }]],
    defaultTab: "team",
    resolve(rest) {
      if (AGENT_IDS.includes(rest[0])) return { tab: "workspace", rest };
      return ["team", "request", "runs"].includes(rest[0]) ? { tab: rest[0], rest: rest.slice(1) } : { tab: null, rest };
    },
    onShow(tab, rest) {
      ui.agent = tab === "workspace" ? rest[0] : null;
      ui.sub = tab === "workspace" ? rest[1] || "overview" : "overview";
      C.co.catalog(); C.co.projects();
      if (ui.agent) loadAgent(ui.agent); else { loadAgents(); loadRuns(); }
      if (tab === "request") loadAgents();
      render();
      startPolling();
    },
    badge() { const n = (agentsRes() || []).filter((a) => a.activeRuns).length; return n ? { n, tone: "info", title: `${n} وكيل يعمل الآن` } : null; }
  });
  O.setActions("agents", () => [button("تحديث", () => { loadAgents(true); loadRuns(true); }, { icon: "refresh" }), linkButton("طلب جديد", href("agents", "request"), { kind: "primary", icon: "play" })]);
  O.setActions("agents", [], "workspace"); // the workspace hero carries its own actions
  O.on("co:agents", () => { if (O.state.tab !== "request") render(); else ui.drawReview?.(); watchRuns(agentsRes()); O.refreshNav(); });
  O.on("co:runs", () => { if (O.state.tab !== "request") render(); });
  O.on("co:catalog", render);
  O.on("co:projects", () => { if (O.state.view === "agents" && O.state.tab !== "request") render(); });
  for (const id of AGENT_IDS) O.on(`co:agent:${id}`, () => { if (ui.agent === id) render(); });
  window.AbudWorkforce = { openRun, renderMarkdown };
})();
