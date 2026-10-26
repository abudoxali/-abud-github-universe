/* ABUD FUN Company OS V6 — الوكلاء (AI Workforce): the dynamic roster, workspaces, requests and runs.
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
  // V5 surfaces appear only when the running bridge implements them, so an older bridge serving these files stays usable.
  const V5 = window.AbudInternalHealth?.capabilities || {};
  const BUILTIN_IDS = ["ori", "mia", "nex", "luna", "zen", "rex"];
  const roster = () => agentsRes() || catalog()?.agents || [];
  const activeAgents = () => roster().filter((a) => a.active !== false && a.enabled !== false && !a.removedAt && a.config?.enabled !== false);
  const agentIds = () => C.agentsDef().map((a) => a.id);
  const QUICK_ACTIONS = {
    ori: ["راجع الشركة", "خطط للأسبوع", "وزّع العمل", "ابدأ اجتماع الفريق", "راجع الأولويات"],
    mia: ["راجعي التصميم", "جهّزي عرض", "راجعي اتساق الهوية"],
    nex: ["راجع استهلاك الذكاء الاصطناعي", "حلّل التكاليف", "افحص صحة النماذج", "راجع الأداء"],
    luna: ["نظّمي المهام", "جهّزي اجتماع", "اعملي تقرير", "راجعي المواعيد النهائية"],
    zen: ["ابحث في موضوع", "راجع المعرفة", "حلّل التوثيق"],
    rex: ["افحص المستودع", "راجع الأمان", "راجع المخاطر", "راجع الموافقات المعلّقة"]
  };
  const TEMPLATE_ACTIONS = {
    coordinator: QUICK_ACTIONS.ori, designer: QUICK_ACTIONS.mia, analyst: QUICK_ACTIONS.nex,
    operations: QUICK_ACTIONS.luna, researcher: QUICK_ACTIONS.zen, security: QUICK_ACTIONS.rex,
    default: ["راجع العمل ضمن تخصصك", "اقترح أولويات العمل"]
  };
  /** Meeting shortcuts open the real Meeting Center form with the right people preselected; nothing starts until the owner presses start. */
  const MEETING_ACTIONS = { "ابدأ اجتماع الفريق": () => ({ all: true, title: "اجتماع الفريق" }), "جهّزي اجتماع": () => ({ participants: ["luna", "ori"], title: "" }) };
  async function quickAction(def, text, trigger) {
    if (MEETING_ACTIONS[text] && window.AbudMeetings?.prefill) { window.AbudMeetings.prefill(MEETING_ACTIONS[text]()); O.go("agents", "meetings"); return; }
    const created = await act(trigger, () => mutate("POST", "/conversations", { agentId: def.id, title: text }), null);
    if (!created) return;
    ui.pick = def.id;
    O.go("agents", "chat", created.id);
    if (text === "جهّزي اجتماع" || text === "ابحث في موضوع") {
      await loadChats(created.id);
      const input = root.querySelector(".co-chat-compose textarea");
      if (input) { input.value = text === "جهّزي اجتماع" ? "جهّزي مسودة طلب اجتماع (لا تنشئي اجتماعًا فعليًا): " : "ابحث في الموضوع التالي: "; input.focus(); }
    } else await sendChatMessage(created, `${text}. استخدم البيانات والأدوات المصرّح بها، ووضّح ما يحتاج موافقتي دون تنفيذه.`);
  }
  function quickActions(def) {
    if (!V5.conversations || !activeAgents().some((a) => a.id === def.id)) return null;
    const actions = (Object.hasOwn(QUICK_ACTIONS, def.id) ? QUICK_ACTIONS[def.id] : null) || (Object.hasOwn(TEMPLATE_ACTIONS, def.templateId) ? TEMPLATE_ACTIONS[def.templateId] : TEMPLATE_ACTIONS.default);
    return panel("إجراءات سريعة", "يفتح كل إجراء محادثة محفوظة مع الوكيل. البحث يبدأ بمسودة لتكمل تفاصيلها، وإجراءات الاجتماع تفتح مركز الاجتماعات بالمشاركين محدَّدين ولا يبدأ شيء قبل ضغطك.",
      h("div", { class: "ag-quick-actions" }, actions.map((text) => button(text,
        (event) => quickAction(def, text, event.currentTarget), { kind: "secondary" }))));
  }
  function actionSummary(actions) {
    if (!actions?.length) return null;
    return h("div", { class: "co-action-summary" }, h("ul", null, actions.map((text) => h("li", null, text))),
      actions.some((text) => text.includes("بانتظار موافقة")) ? h("a", { class: "ops-chip", href: href("resources", "routing") }, "يحتاج موافقتك") : null);
  }
  const ui = { agent: null, sub: "overview", runFilter: "", pick: "ori", polling: null, forms: new Map(), previewState: "idle", previewForm: "standard", chatThreads: [], chatCurrent: null, chatAttachments: [], chatState: "active", chatQuery: "", chatStream: null, chatPartial: "", chatError: "", memoryNotes: [], memoryState: "active", memoryQuery: "", memoryError: "", memoryConflicts: [], memSeg: "memory", drafts: {}, chatContext: null, agentThreads: new Map(), knowledgeDocs: [], knowledgeHits: [], knowledgeQuery: "", knowledgeProject: "", knowledgeError: "" };
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
    if (!BUILTIN_IDS.includes(agentId)) return C.avatar(agentId, "lg");
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
    const isWorking = a.availability === "working" || (a.activeRuns && a.activeRuns > 0);
    return h("article", { class: `ag-card co-avail-${a.availability}${isWorking ? " is-working" : ""}`, style: `--agent:${a.color}`, "data-agent": a.id },
      h("div", { class: "ag-stage-wrap" },
        h("a", { class: "ag-stage", href: href("agents", "workspace", a.id), "aria-label": `مساحة عمل ${a.name}` },
          robot(`card:${a.id}`, a.id, { variant: "standard", animationState: robotState(a), size: 230, interactive: true }),
          isWorking ? h("span", { class: "ag-live-indicator", "aria-label": "يعمل الآن" }, h("span", { class: "ag-pulse-ring" }), "يعمل الآن") : null),
        BUILTIN_IDS.includes(a.id) ? h("button", {
          type: "button",
          class: "ag-stage-greet",
          title: `تحية وتفاعل من ${a.name}`,
          "aria-label": `تحية وتفاعل من ${a.name}`,
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.querySelector(`svg.rb-robot[data-agent="${a.id}"]`)?.__robot?.react("greeting");
          }
        }, icon("sparkle", 14), h("span", null, "حيِّه")) : null),
      h("div", { class: "ag-info" },
        h("div", { class: "ag-name" }, h("h3", null, bdi(a.name), h("span", null, `0${a.order}`)), label("availability", a.availability)),
        h("p", { class: "ag-role" }, `${a.titleAr} · ${a.roleAr}`),
        h("dl", { class: "ag-facts" },
          h("div", null, h("dt", null, "المهمة الحالية"), h("dd", { title: a.currentTask?.title || "" }, a.currentTask ? a.currentTask.title : a.activeRuns ? "تشغيل جارٍ" : "—")),
          h("div", null, h("dt", null, "مهام مفتوحة"), h("dd", null, String(a.openTasks))),
          h("div", null, h("dt", null, "النموذج الآن"), h("dd", null, a.route.chosen ? bdi(a.route.chosen.split("/").pop(), "co-tech-soft") : h("span", { class: "ops-dim" }, "لا يوجد"))),
          h("div", null, h("dt", null, "آخر تشغيل"), h("dd", null, last ? `${L.runStatus[last.status]} · ${fmt.relative(last.finishedAt || last.createdAt)}` : "—"))),
        h("div", { class: "ag-actions" },
          linkButton("مساحة العمل", href("agents", "workspace", a.id), { kind: "primary" }),
          V5.conversations ? linkButton("محادثة", href("agents", "chat", a.id), { icon: "agents" }) : null,
          linkButton("طلب جديد", href("agents", "request", a.id), { icon: "play" }))));
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
          h("h2", { id: "agHeroTitle" }, "فريق متجدد، هوية واحدة"),
          h("p", null, "كل وكيل له دور ثابت وصلاحيات تُفرض في الخادم. يمر كل طلب عبر OmniRoute وفق سياسة التوجيه والميزانية."),
          h("div", { class: "ag-hero-stats" },
            h("div", { class: "ag-hero-stat" }, h("strong", null, `${ready}/${agents.length}`), h("span", null, "جاهزون الآن")),
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
    const agents = activeAgents();
    let agentId = [preset.agentId, ui.pick, agents[0]?.id].find((id) => agents.some((a) => a.id === id));
    const capSel = h("select", { class: "ops-input", name: "capability", "aria-label": "نوع المهمة" });
    const projectSel = select("projectId", [["", "بدون مشروع"], ...C.projectOptions(false)], preset.projectId || "", { "aria-label": "المشروع" });
    const request = h("textarea", { class: "ops-input", name: "request", rows: 4, maxlength: 4000, placeholder: "اكتب طلبك بالعربية… مثال: لخّص حالة المشاريع المتعطّلة واقترح أولويات الأسبوع.", "aria-label": "نص الطلب" });
    const review = h("div", { class: "ops-notice ops-notice-info", role: "status" });
    const picker = h("div", { class: "ag-picker", role: "radiogroup", "aria-label": "اختر الوكيل" });
    const drawPicker = () => fill(picker, agents.map((a) => {
      const live = agentsRes()?.find((x) => x.id === a.id);
      return h("button", { type: "button", role: "radio", class: "ag-pick", style: `--agent:${a.color}`, "aria-checked": String(a.id === agentId),
        onclick: () => { agentId = a.id; ui.pick = a.id; drawPicker(); fillCaps(); hooks.onAgent?.(agentId); } },
        C.avatar(a.id, "md", { state: robotState(live) }),
        h("div", { class: "ag-pick-info" }, h("strong", null, bdi(a.name)), h("small", null, a.titleAr)));
    }));
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
      const def = C.agentDef(id);
      if (!def) return;
      const live = liveOf(id);
      preview.style.setProperty("--agent", def.color);
      fill(preview,
        h("div", { class: "ag-req-stage" }, robot("req:preview", id, { variant: "standard", animationState: robotState(live), size: 220, interactive: true })),
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
      actions: select("runFilter", [["", "كل التشغيلات"], ...agentIds().map((id) => [id, C.agentDef(id)?.name || id.toUpperCase()]), ...Object.entries(L.runStatus).map(([k, v]) => [k, `الحالة: ${v}`])], ui.runFilter, { "aria-label": "تصفية التشغيلات", onchange: (e) => { ui.runFilter = e.target.value; renderRuns(); } }) },
    top.length ? runList(top) : empty("لا تشغيلات مطابقة.")));
  }

  // ---------------------------------------------------------------- persistent conversations
  async function chatGet(path) {
    const response = await fetch(`/local-api/company${path}`, { cache: "no-store", headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
    return data;
  }
  async function loadChats(selectId = null, { background = false } = {}) {
    try {
      const data = await chatGet(`/conversations?state=${ui.chatState}&limit=100&q=${encodeURIComponent(ui.chatQuery)}`);
      ui.chatThreads = data.conversations;
      const id = selectId || ui.chatCurrent?.id;
      ui.chatCurrent = id ? await chatGet(`/conversations/${encodeURIComponent(id)}`).catch(() => null) : null;
      ui.chatAttachments = ui.chatCurrent ? (await chatGet(`/conversations/${encodeURIComponent(ui.chatCurrent.id)}/attachments`)).attachments : [];
      ui.chatContext = ui.chatCurrent ? await chatGet(`/conversations/${encodeURIComponent(ui.chatCurrent.id)}/context`).catch(() => null) : null;
      ui.chatError = "";
      // A reply that lands while the owner is typing updates state; the page redraws once focus leaves the field.
      if (!background || !busyTyping()) renderChat();
      const pending = ui.chatCurrent?.messages?.findLast((m) => m.role === "assistant" && m.state === "pending");
      if (pending?.runId) watchChatRun(ui.chatCurrent.id, pending.runId);
    } catch (error) { ui.chatError = error.message; if (!background || !busyTyping()) renderChat(); }
  }
  function watchChatRun(id, runId) {
    if (ui.chatStream?.runId === runId) return;
    ui.chatStream?.source.close();
    const source = new EventSource(`/local-api/company/conversations/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/events`);
    ui.chatStream = { source, runId };
    source.onmessage = (event) => {
      let data; try { data = JSON.parse(event.data); } catch (_) { return; }
      if (data.type === "content") {
        ui.chatPartial = data.content;
        const target = root.querySelector(`[data-chat-run="${runId}"] .co-chat-text`);
        if (target) target.textContent = data.content;
      } else if (data.type === "done" || (data.type === "snapshot" && !["queued", "running"].includes(data.run?.status))) {
        source.close(); ui.chatStream = null; ui.chatPartial = ""; loadChats(id, { background: true });
      }
    };
    source.onerror = () => { source.close(); ui.chatStream = null; setTimeout(() => { if (O.state.view === "agents" && O.state.tab === "chat") loadChats(id, { background: true }); }, 2500); };
  }
  async function sendChatMessage(thread, content, key = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, attachmentIds = []) {
    try {
      const result = await mutate("POST", `/conversations/${thread.id}/messages`, { content, idempotencyKey: key, attachmentIds });
      await loadChats(thread.id); watchChatRun(thread.id, result.run.id);
      root.querySelector(".co-chat-compose textarea")?.focus();
      return true;
    } catch (error) { toast(error.message, "bad"); return false; }
  }
  function threadItems(current) {
    return ui.chatThreads.length ? ui.chatThreads.map((thread) => {
      const tAgent = catalog()?.agents?.find((x) => x.id === thread.agentId);
      const tLive = agentsRes()?.find((x) => x.id === thread.agentId);
      return h("button", { type: "button", class: `co-chat-thread${thread.id === current?.id ? " is-selected" : ""}`, "aria-current": thread.id === current?.id ? "true" : null, onclick: () => { ui.chatPartial = ""; O.go("agents", "chat", thread.id); loadChats(thread.id); } },
        C.avatar(thread.agentId, "sm", { state: robotState(tLive) }),
        h("div", { class: "co-chat-thread-info" },
          h("strong", null, `${tAgent?.name || thread.agentId.toUpperCase()} · ${thread.title}`),
          h("small", null, `${thread.projectId ? C.projectName(thread.projectId) || "مشروع" : "بدون مشروع"} · ${fmt.relative(thread.updatedAt)}`)));
    }) : h("p", { class: "ops-dim" }, ui.chatQuery ? "لا محادثات مطابقة للبحث." : "لا محادثات هنا بعد.");
  }
  /** Search refreshes only the thread list, so the search box keeps focus and its caret. */
  async function refreshThreadList() {
    try {
      ui.chatThreads = (await chatGet(`/conversations?state=${ui.chatState}&limit=100&q=${encodeURIComponent(ui.chatQuery)}`)).conversations;
      const list = root.querySelector(".co-chat-threadlist");
      if (list) fill(list, threadItems(ui.chatCurrent)); else renderChat();
    } catch (error) { toast(error.message, "bad"); }
  }
  function renderChat() {
    if (O.state.view !== "agents" || O.state.tab !== "chat") return;
    O.setHead("agents", null);
    const current = ui.chatCurrent;
    const agents = activeAgents();
    const agentSel = select("agentId", agents.map((a) => [a.id, a.name]), ui.pick, { "aria-label": "الوكيل" });
    const projectSel = select("projectId", [["", "بدون مشروع"], ...C.projectOptions(false)], "", { "aria-label": "المشروع" });
    const taskSel = select("taskId", [["", "بدون مهمة"]], "", { "aria-label": "المهمة" });
    const fillTasks = () => fill(taskSel, [h("option", { value: "" }, "بدون مهمة"), ...(O.peek("co:tasks")?.data?.tasks || []).filter((task) => !task.archivedAt && (task.projectId || "") === projectSel.value).slice(0, 100).map((task) => h("option", { value: task.id }, task.title))]);
    projectSel.addEventListener("change", fillTasks); fillTasks();
    const newForm = h("form", { class: "co-chat-new", onsubmit: async (event) => {
      event.preventDefault();
      try {
        const created = await mutate("POST", "/conversations", { agentId: agentSel.value, projectId: projectSel.value || null, taskId: taskSel.value || null });
        ui.pick = agentSel.value; O.go("agents", "chat", created.id); loadChats(created.id);
      } catch (error) { toast(error.message, "bad"); }
    } }, agentSel, projectSel, taskSel, h("button", { type: "submit", class: "btn btn-primary" }, "محادثة جديدة"));
    const threads = h("aside", { class: "co-chat-sidebar", "aria-label": "المحادثات" },
      h("div", { class: "co-chat-sidehead" }, h("strong", null, "المحادثات"), h("button", { type: "button", class: "btn btn-secondary", onclick: () => { ui.chatState = ui.chatState === "active" ? "archived" : "active"; ui.chatCurrent = null; loadChats(); } }, ui.chatState === "active" ? "الأرشيف" : "النشطة")),
      h("input", { class: "ops-input", type: "search", value: ui.chatQuery, placeholder: "ابحث في المحادثات…", "aria-label": "بحث المحادثات", oninput: (event) => { ui.chatQuery = event.currentTarget.value; clearTimeout(ui.chatSearchTimer); ui.chatSearchTimer = setTimeout(refreshThreadList, 300); } }),
      newForm,
      h("div", { class: "co-chat-threadlist" }, threadItems(current)));
    const transcript = h("div", { class: "co-chat-transcript", role: "log", "aria-live": "polite", "aria-label": "رسائل المحادثة" });
    if (current) fill(transcript, current.messages?.length ? current.messages.map((m) => ["tool", "event"].includes(m.role) ? h("div", { class: `co-chat-system co-chat-${m.role}` },
      m.role === "tool" ? h("details", null, h("summary", null, `نتيجة أداة · ${m.source}`), h("pre", { dir: "auto" }, m.content)) : h("span", null, m.content), h("time", null, fmt.when(m.createdAt))) : h("article", { class: `co-chat-message co-chat-${m.role}`, "data-chat-run": m.runId || "" },
      h("div", { class: "co-chat-meta" }, C.avatar(m.role === "assistant" ? current.agentId : "owner", "sm"), h("strong", null, m.role === "owner" ? "أنت" : C.agentDef(current.agentId)?.name || current.agentId.toUpperCase()), h("time", null, fmt.when(m.createdAt)), m.state !== "complete" ? badge(m.state === "pending" ? "info" : "warn", m.state === "pending" ? "جارٍ الرد" : L.runStatus[m.state] || m.state) : null),
      h("div", { class: "co-chat-text", dir: "auto" }, m.state === "pending" ? (ui.chatPartial || "ينتظر رد الوكيل…") : m.content || (m.state === "failed" ? "تعذّر إكمال الرد. افتح سجل التشغيل لمعرفة السبب." : "")),
      m.role === "assistant" ? actionSummary(m.actionsAr) : null,
      m.attachments?.length ? h("ul", { class: "co-chat-files" }, m.attachments.map((file) => h("li", null, h("a", { href: `/local-api/company/conversations/${current.id}/attachments/${file.id}`, download: file.filename }, file.filename), h("small", null, file.readableByAgent ? "نص متاح للوكيل" : "محفوظ للمالك؛ لا يقرأه النموذج النصي")))) : null,
      m.role === "assistant" && m.runId ? h("details", { class: "co-chat-technical" }, h("summary", null, "تفاصيل الأدوات والتشغيل"), h("div", { class: "ops-actions" },
        h("button", { type: "button", class: "btn btn-secondary", onclick: () => openRun(m.runId) }, "تفاصيل التشغيل"),
        ["failed", "cancelled"].includes(m.state) ? h("button", { type: "button", class: "btn btn-secondary", onclick: async () => {
          const ownerMessage = current.messages.find((x) => x.runId === m.runId && x.role === "owner");
          if (ownerMessage?.attachments?.length) { const input = root.querySelector(".co-chat-compose textarea"); if (input) { input.value = ownerMessage.content; input.focus(); } toast("أعد رفع المرفقات قبل الإرسال", "info"); }
          else if (ownerMessage) await sendChatMessage(current, ownerMessage.content, `retry-${m.runId}`);
        } }, current.messages.find((x) => x.runId === m.runId && x.role === "owner")?.attachments?.length ? "أعد رفع المرفقات" : "إعادة المحاولة") : null)) : null)) : empty("ابدأ المحادثة برسالتك الأولى."));
    const fileInput = h("input", { type: "file", multiple: true, accept: ".txt,.md,.js,.mjs,.ts,.json,.py,.css,.html,.gd,.sql,.pdf,.png,.jpg,.jpeg,.webp", "aria-label": "إرفاق ملفات", onchange: async (event) => {
      const files = [...event.currentTarget.files].slice(0, Math.max(0, 3 - ui.chatAttachments.length));
      for (const file of files) {
        if (file.size > 1_048_576) { toast(`${file.name}: الحد الأقصى 1 ميغابايت`, "bad"); continue; }
        try {
          const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          await mutate("POST", `/conversations/${current.id}/attachments`, { filename: file.name, data: btoa(binary) });
        } catch (error) { toast(`${file.name}: ${error.message}`, "bad"); }
      }
      loadChats(current.id);
    } });
    const pendingFiles = ui.chatAttachments.length ? h("ul", { class: "co-chat-files" }, ui.chatAttachments.map((file) => h("li", null, file.filename, h("small", null, file.readableByAgent ? "سيُقرأ النص" : "لن يقرأ النموذج النصي هذا الملف"), h("button", { type: "button", class: "btn btn-secondary", onclick: async () => { await mutate("DELETE", `/conversations/${current.id}/attachments/${file.id}`); loadChats(current.id); } }, "إزالة")))) : null;
    const composer = current && current.state === "active" ? h("form", { class: "co-chat-compose", onsubmit: async (event) => {
      event.preventDefault();
      const input = event.currentTarget.querySelector("textarea");
      const content = input.value.trim(); if (!content) return;
      const submit = event.currentTarget.querySelector("button[type=submit]"); submit.disabled = true;
      if (await sendChatMessage(current, content, undefined, ui.chatAttachments.map((file) => file.id))) input.value = "";
      submit.disabled = false;
    } }, h("div", { class: "co-chat-compose-main" }, h("textarea", { class: "ops-input", rows: 3, maxlength: 4000, placeholder: "اكتب رسالتك…", "aria-label": "رسالتك", onkeydown: (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form.requestSubmit(); } } }), fileInput, pendingFiles, h("small", { class: "ops-dim" }, "النصوص والشيفرة تُقرأ بحدود آمنة. PDF والصور محفوظة للعرض فقط حتى تتوفر أداة قراءة معتمدة.")), window.AbudVoice?.controls({ agentId: current.agentId, onText: (text) => { const input = root.querySelector(".co-chat-compose textarea"); if (input) { input.value = input.value.trim() ? `${input.value.trim()} ${text}` : text; input.focus(); } } }), h("button", { type: "submit", class: "btn btn-primary" }, "إرسال")) : null;
    const chatAgent = current ? catalog()?.agents?.find((x) => x.id === current.agentId) : null;
    const chatLive = current ? agentsRes()?.find((x) => x.id === current.agentId) : null;
    const chatState = (current && window.AbudVoice?.override(current.agentId)) || robotState(chatLive);
    if (current) window.AbudVoice?.observe(current.id, current.agentId, current.messages);
    const main = h("section", { class: "co-chat-main" }, current ? [h("header", { class: "co-chat-header" },
      h("div", { class: "co-chat-header-identity" },
        C.avatar(current.agentId, "md", { state: chatState }),
        h("div", { class: "co-chat-header-titles" },
          h("h3", null, current.title),
          h("p", null, `${chatAgent?.name || current.agentId.toUpperCase()} · ${chatAgent?.titleAr || ""} · ${current.projectId ? C.projectName(current.projectId) || "مشروع مرتبط" : "بدون مشروع"}${current.taskId ? " · مهمة مرتبطة" : ""}`))),
      h("div", { class: "ops-actions" }, current.messages?.some((m) => m.role === "assistant" && m.state === "pending") ? h("button", { type: "button", class: "btn btn-secondary", onclick: async () => {
        const pending = current.messages.findLast((m) => m.role === "assistant" && m.state === "pending");
        if (pending) { const cancelled = await act(null, () => mutate("POST", `/runs/${pending.runId}/cancel`, {}), "طُلب إيقاف الرد"); if (cancelled) loadChats(current.id); }
      } }, "إيقاف الرد") : null, h("button", { type: "button", class: "btn btn-secondary", onclick: async () => {
        const title = await O.promptDialog({ title: "إعادة تسمية المحادثة", label: "اسم المحادثة", value: current.title, maxlength: 160 }); if (!title || title === current.title) return;
        try { await mutate("PATCH", `/conversations/${current.id}`, { title }); loadChats(current.id); } catch (error) { toast(error.message, "bad"); }
      } }, "إعادة تسمية"), h("button", { type: "button", class: "btn btn-secondary", onclick: async () => {
        try { await mutate("PATCH", `/conversations/${current.id}`, { state: current.state === "active" ? "archived" : "active" }); ui.chatCurrent = null; loadChats(); } catch (error) { toast(error.message, "bad"); }
      } }, current.state === "active" ? "أرشفة" : "استعادة"), h("button", { type: "button", class: "btn btn-secondary", onclick: async () => {
        if (!await O.confirmDialog({ title: "حذف المحادثة؟", body: "ستختفي المحادثة من العرض. لن تُحذف سجلات التشغيل والتدقيق المرتبطة بها.", confirm: "حذف", tone: "danger" })) return;
        const deleted = await act(null, () => mutate("DELETE", `/conversations/${current.id}`), "حُذفت المحادثة");
        if (deleted) { ui.chatCurrent = null; loadChats(); }
      } }, "حذف"),
        h("details", { class: "co-chat-export" }, h("summary", { class: "btn btn-secondary" }, icon("download", 16), "تصدير"),
          h("div", { class: "co-chat-export-menu" }, h("a", { class: "btn btn-secondary", href: `/local-api/company/conversations/${current.id}/export?format=md`, download: "" }, "نص Markdown"), h("a", { class: "btn btn-secondary", href: `/local-api/company/conversations/${current.id}/export?format=json`, download: "" }, "JSON كامل"))))),
      ui.chatContext ? h("p", { class: "co-chat-context ops-dim", role: "note" }, icon("info", 14),
        ` سياق الرد التالي: آخر ${ui.chatContext.recentMessages} رسالة${ui.chatContext.summarizedMessages ? ` + ملخص موثّق لـ ${ui.chatContext.summarizedMessages} رسالة أقدم (الأصل محفوظ)` : ""} · نحو ${fmt.num(ui.chatContext.estimatedTokens)} من ${fmt.num(ui.chatContext.budgetTokens)} رمز (تقدير)`) : null,
      transcript, composer] : h("div", { class: "co-chat-empty" }, icon("agents", 36), h("h3", null, "ابدأ محادثة مع أحد الوكلاء"), h("p", null, "اختر الوكيل والمشروع، ثم أرسل رسالة. محفوظاتك تبقى متاحة دون اتصال.")));
    fill(root, ui.chatError ? notice("bad", "تعذر تحميل المحادثات", ui.chatError) : null, h("div", { class: "co-chat-layout" }, threads, main));
    if (current) transcript.scrollTop = transcript.scrollHeight;
  }

  // ---------------------------------------------------------------- الذاكرة والمعرفة (memory review, knowledge library, conflicts)
  // Searches update only their result lists, so typing never rebuilds the page or loses focus.
  async function loadMemory({ listOnly = false, background = false } = {}) {
    try {
      const path = ui.memoryQuery.trim() ? `/memory/search?q=${encodeURIComponent(ui.memoryQuery)}&pending=1` : `/memory?state=${ui.memoryState}`;
      ui.memoryNotes = (await chatGet(path)).notes;
      ui.memoryConflicts = (await chatGet("/memory-conflicts")).conflicts;
      ui.memoryError = "";
    } catch (error) { ui.memoryError = error.message; }
    const grid = root.querySelector(".co-memory-grid[data-list=memory]");
    if (listOnly && grid) fill(grid, ui.memoryNotes.length ? ui.memoryNotes.map(memoryCard) : empty("لا توجد ذكريات مطابقة."));
    else if (!background || !busyTyping()) renderMemoryTab();
  }
  function memoryScopePicker(scope = "company", ref = "") {
    const scopeSel = select("scope", [["company", "الشركة"], ["project", "مشروع"], ["agent", "وكيل"]], scope, { "aria-label": "نطاق الذاكرة" });
    const refSel = select("scopeRef", [], ref, { "aria-label": "صاحب النطاق" });
    const updateRef = () => {
      const options = scopeSel.value === "company" ? [["", "الشركة كلها"]] : scopeSel.value === "project" ? C.projectOptions(false) : activeAgents().map((a) => [a.id, a.name]);
      fill(refSel, options.map(([value, label]) => h("option", { value, selected: value === ref ? true : null }, label)));
    };
    scopeSel.addEventListener("change", () => { ref = ""; updateRef(); }); updateRef();
    return { scopeSel, refSel };
  }
  const scopeText = (m) => `${{ company: "الشركة", project: "مشروع", agent: "وكيل" }[m.scope] || m.scope}${m.scopeRef ? ` · ${m.scope === "project" ? C.projectName(m.scopeRef) || m.scopeRef : C.agentDef(m.scopeRef)?.name || m.scopeRef}` : ""}`;
  function memoryCard(m) {
    const picked = memoryScopePicker(m.scope, m.scopeRef);
    const editTitle = h("input", { class: "ops-input", value: m.title, maxlength: 120, required: true, "aria-label": "عنوان الذاكرة" });
    const editBody = h("textarea", { class: "ops-input", maxlength: 2000, required: true, rows: 4, "aria-label": "محتوى الذاكرة" }, m.body);
    const editSource = h("input", { class: "ops-input", value: m.sourceRef || "", maxlength: 400, "aria-label": "مرجع المصدر" });
    const confidence = select("confidence", [["unverified", "غير متحقق"], ["supported", "مدعوم بمصدر"], ["verified", "متحقق"]], m.confidence, { "aria-label": "درجة الثقة" });
    const sensitivity = select("sensitivity", [["internal", "داخلي مشترك حسب النطاق"], ["restricted", "مقيّد ولا يُرسل للوكيل"]], m.sensitivity, { "aria-label": "الحساسية" });
    const save = async (patch, trigger) => {
      const data = { id: m.id, scope: patch?.scope ?? picked.scopeSel.value, scopeRef: patch?.scopeRef ?? picked.refSel.value,
        title: patch?.title ?? editTitle.value, body: patch?.body ?? editBody.value, sourceRef: editSource.value || null,
        confidence: patch?.confidence ?? confidence.value, sensitivity: patch?.sensitivity ?? sensitivity.value,
        approved: patch?.approved ?? m.approved, state: patch?.state ?? m.state };
      const result = await act(trigger, () => mutate("POST", "/memory", data), "حُفظت الذاكرة");
      if (result) loadMemory();
    };
    return h("article", { class: `co-memory-card${m.conflictState === "open" ? " co-memory-conflict" : ""}` },
      h("div", { class: "co-memory-head" }, h("h3", null, m.title), badge(m.approved ? "ok" : "warn", m.approved ? "مؤكدة" : "بانتظار المراجعة"), badge(m.sensitivity === "restricted" ? "warn" : "info", m.sensitivity === "restricted" ? "مقيّدة" : "داخلية"),
        m.conflictState === "open" ? badge("bad", "تعارض بانتظار قرارك") : null, m.supersededBy ? badge("muted", "استُبدلت") : null),
      h("p", { class: "co-memory-body" }, m.body),
      h("dl", { class: "co-memory-meta" }, row("النطاق", scopeText(m)), row("المصدر", m.sourceRef || m.source), row("الثقة", { verified: "متحقق", supported: "مدعوم بمصدر", unverified: "غير متحقق" }[m.confidence] || m.confidence), row("النسخة", String(m.version)), row("آخر مراجعة", fmt.when(m.reviewedAt))),
      h("div", { class: "ops-actions" }, m.conflictState === "open" ? button("حسم التعارض", () => { ui.memSeg = "conflicts"; O.go("agents", "memory", "conflicts"); renderMemoryTab(); }, { kind: "primary" }) : !m.approved ? button("تأكيد", (event) => save({ approved: true }, event.currentTarget), { kind: "primary" }) : null,
        button(m.state === "active" ? "أرشفة" : "استعادة", (event) => save({ state: m.state === "active" ? "archived" : "active" }, event.currentTarget)),
        button("حذف", async (event) => { if (!await O.confirmDialog({ title: "حذف الذاكرة نهائيًا؟", body: "سيُحذف السجل من الذاكرة وفهرس البحث المحلي. سجلات التشغيل القديمة تبقى كسجل تدقيق مستقل.", confirm: "حذف", tone: "danger" })) return;
          const result = await act(event.currentTarget, () => mutate("DELETE", `/memory/${m.id}`), "حُذفت الذاكرة"); if (result) loadMemory(); })),
      h("details", { class: "co-memory-edit" }, h("summary", null, "تحرير النطاق والمحتوى"), h("form", { class: "co-memory-form", onsubmit: async (event) => { event.preventDefault(); await save({}, event.currentTarget.querySelector("button[type=submit]")); } },
        h("div", { class: "co-form-row" }, picked.scopeSel, picked.refSel), editTitle, editBody, editSource, h("div", { class: "co-form-row" }, confidence, sensitivity), h("button", { type: "submit", class: "btn btn-primary" }, "حفظ التعديلات"))));
  }
  /** In-progress form values survive any re-render: each field reads and writes its draft by key. */
  function drafted(el, key) {
    if (ui.drafts[key] != null) el.value = ui.drafts[key];
    el.addEventListener("input", () => { ui.drafts[key] = el.value; });
    el.addEventListener("change", () => { ui.drafts[key] = el.value; });
    return el;
  }
  const clearDrafts = (...keys) => { for (const k of keys) delete ui.drafts[k]; };
  function memoryHeader() {
    const conflicts = ui.memoryConflicts?.length || 0;
    return [O.sectionShell({ id: "memory", title: V5.learning ? "الذاكرة والخبرات" : "الذاكرة والمعرفة", subtitle: "حقائق وقرارات قابلة للمراجعة، ومصادر معرفة اعتمدتها، مع نطاق ومصدر واضحين. الذاكرة المقيّدة لا تدخل سياق الوكلاء." }),
      O.segmented([["memory", "الذاكرة"], ...(V5.learning ? [["learning", "الخبرات والتعلّم"]] : []), ["knowledge", "مكتبة المعرفة"], ["conflicts", conflicts ? `التعارضات (${conflicts})` : "التعارضات"]], ui.memSeg, (v) => { ui.memSeg = v; O.go("agents", "memory", v === "memory" ? undefined : v); renderMemoryTab(); if (v === "knowledge") loadKnowledge(); }, "أقسام الذاكرة والمعرفة")];
  }
  function renderMemoryTab() {
    if (O.state.view !== "agents" || O.state.tab !== "memory") return;
    O.setHead("agents", null);
    if (ui.memSeg === "knowledge") return renderKnowledge();
    if (ui.memSeg === "conflicts") return renderConflicts();
    if (ui.memSeg === "learning" && window.AbudLearning) return fill(root, ...memoryHeader(), window.AbudLearning.render());
    return renderMemory();
  }
  function renderMemory() {
    const createScope = memoryScopePicker();
    const title = drafted(h("input", { class: "ops-input", maxlength: 120, required: true, placeholder: "عنوان الحقيقة أو القرار", "aria-label": "عنوان الذاكرة" }), "mem.title");
    const body = drafted(h("textarea", { class: "ops-input", maxlength: 2000, required: true, rows: 3, placeholder: "المحتوى المؤكد…", "aria-label": "محتوى الذاكرة" }), "mem.body");
    const sourceRef = drafted(h("input", { class: "ops-input", maxlength: 400, placeholder: "مرجع المصدر (اختياري)", "aria-label": "مرجع المصدر" }), "mem.source");
    const createForm = h("form", { class: "co-memory-form", onsubmit: async (event) => {
      event.preventDefault();
      const result = await act(event.currentTarget.querySelector("button[type=submit]"), () => mutate("POST", "/memory", { scope: createScope.scopeSel.value, scopeRef: createScope.refSel.value, title: title.value, body: body.value, sourceRef: sourceRef.value || null, confidence: "unverified", approved: true }), "حُفظت الذاكرة");
      if (result) { clearDrafts("mem.title", "mem.body", "mem.source"); title.value = ""; body.value = ""; sourceRef.value = ""; loadMemory(); }
    } }, h("div", { class: "co-form-row" }, createScope.scopeSel, createScope.refSel), title, body, sourceRef, h("button", { type: "submit", class: "btn btn-primary" }, "حفظ الذاكرة"));
    fill(root, ...memoryHeader(),
      ui.memoryError ? notice("bad", "تعذر تحميل الذاكرة", ui.memoryError) : null,
      ui.memoryConflicts?.length ? notice("warn", `${ui.memoryConflicts.length} تعارض بانتظار قرارك`, "ملاحظات بالعنوان نفسه ومحتوى مختلف. لا تُستبدل أي ملاحظة مؤكدة حتى تقرر.") : null,
      h("div", { class: "co-memory-toolbar" }, h("input", { class: "ops-input", type: "search", value: ui.memoryQuery, placeholder: "ابحث في الذاكرة…", "aria-label": "بحث الذاكرة", oninput: (event) => { ui.memoryQuery = event.currentTarget.value; clearTimeout(ui.memoryTimer); ui.memoryTimer = setTimeout(() => loadMemory({ listOnly: true }), 300); } }),
        button(ui.memoryState === "active" ? "عرض الأرشيف" : "عرض النشطة", () => { ui.memoryState = ui.memoryState === "active" ? "archived" : "active"; ui.memoryQuery = ""; loadMemory(); }), button("إعادة الفهرسة", async (event) => { const result = await act(event.currentTarget, () => mutate("POST", "/memory/reindex", {}), "أُعيد بناء الفهرس"); if (result) loadMemory(); })),
      panel("إضافة ذاكرة", "أدخل الحقائق التي راجعتها. الوكيل لا يؤكد ذاكرته بنفسه.", createForm),
      h("div", { class: "co-memory-grid", "data-list": "memory" }, ui.memoryNotes.length ? ui.memoryNotes.map(memoryCard) : empty("لا توجد ذكريات مطابقة.")));
  }
  function renderConflicts() {
    const list = ui.memoryConflicts || [];
    const decide = (note, decision, trigger) => act(trigger, () => mutate("POST", `/memory/${note.id}/resolve`, { decision }), "حُسم التعارض").then((r) => { if (r) loadMemory(); });
    const side = (title, m) => h("div", { class: "co-conflict-side" }, h("h4", null, title), m ? [h("strong", null, m.title), h("p", { class: "co-memory-body" }, m.body),
      h("dl", { class: "co-memory-meta" }, row("المصدر", m.sourceRef || m.source), row("الحالة", m.approved ? "مؤكدة" : "بانتظار المراجعة"), row("آخر تحديث", fmt.when(m.updatedAt)))] : empty("الملاحظة الأخرى لم تعد موجودة."));
    fill(root, ...memoryHeader(),
      notice("info", "قرارك محفوظ مع المصدر", "لا يُحذف شيء: الملاحظة غير المختارة تُؤرشف مع إشارة إلى البديل، ويبقى مصدر كل منهما. لا يستطيع أي وكيل حسم التعارض."),
      list.length ? h("div", { class: "co-conflicts" }, list.map(({ note, other }) => h("article", { class: "co-memory-card co-conflict" },
        h("div", { class: "co-conflict-pair" }, side("الموجودة", other), side("الجديدة", note)),
        h("div", { class: "ops-actions" },
          button("اعتماد الجديدة", (e) => decide(note, "kept-new", e.currentTarget), { kind: "primary" }),
          button("الإبقاء على الموجودة", (e) => decide(note, "kept-existing", e.currentTarget)),
          button("الإبقاء على الاثنتين", (e) => decide(note, "kept-both", e.currentTarget)))))) : empty("لا توجد تعارضات مفتوحة."));
  }

  async function loadKnowledge({ listOnly = false, background = false } = {}) {
    try {
      const filter = ui.knowledgeProject ? `&projectId=${encodeURIComponent(ui.knowledgeProject)}` : "";
      ui.knowledgeDocs = (await chatGet(`/knowledge?state=active${filter}`)).documents;
      ui.knowledgeHits = ui.knowledgeQuery.trim() ? (await chatGet(`/knowledge/search?q=${encodeURIComponent(ui.knowledgeQuery)}${filter}`)).results : [];
      ui.knowledgeError = "";
    } catch (error) { ui.knowledgeError = error.message; }
    const hits = root.querySelector(".co-knowledge-hits");
    if (listOnly && hits) fill(hits, knowledgeHits());
    else if (O.state.tab === "memory" && ui.memSeg === "knowledge" && (!background || !busyTyping())) renderKnowledge();
  }
  const knowledgeHits = () => !ui.knowledgeQuery.trim() ? [] : panel("نتائج البحث", null, ui.knowledgeHits.length ? h("ul", { class: "co-knowledge-results" }, ui.knowledgeHits.map((hit) => h("li", null, h("strong", null, hit.document.title), h("p", null, hit.excerpt),
    h("small", null, `${hit.citation} · ${hit.document.sourceRef} · ${fmt.when(hit.document.indexedAt)}${hit.document.freshness && hit.document.freshness !== "fresh" ? ` · ${{ stale: "قديم", changed: "تغيّر المصدر", missing: "المصدر غير متاح", unreachable: "تعذّر الوصول" }[hit.document.freshness] || hit.document.freshness}` : ""}`)))) : empty("لا نتائج مطابقة."));
  function renderKnowledge() {
    const projectOptions = [["", "كل الشركة"], ...C.projectOptions(false)];
    const filter = select("projectId", projectOptions, ui.knowledgeProject, { "aria-label": "تصفية المشروع", onchange: (event) => { ui.knowledgeProject = event.currentTarget.value; loadKnowledge(); } });
    const addProject = drafted(select("projectId", projectOptions, "", { "aria-label": "مشروع المصدر الجديد" }), "kn.project");
    const title = drafted(h("input", { class: "ops-input", maxlength: 160, required: true, placeholder: "عنوان المستند", "aria-label": "عنوان المصدر" }), "kn.title");
    const content = drafted(h("textarea", { class: "ops-input", rows: 6, maxlength: 30000, required: true, placeholder: "الصق نصًا أو Markdown راجعته…", "aria-label": "نص المصدر" }), "kn.content");
    const addForm = h("form", { class: "co-memory-form", onsubmit: async (event) => {
      event.preventDefault();
      const result = await act(event.currentTarget.querySelector("button[type=submit]"), () => mutate("POST", "/knowledge", { title: title.value, content: content.value, projectId: addProject.value || null }), "أُضيف المصدر");
      if (result) { clearDrafts("kn.title", "kn.content"); loadKnowledge(); }
    } }, addProject, title, content, h("button", { type: "submit", class: "btn btn-primary" }, "إضافة إلى المعرفة"));
    const importProject = drafted(select("projectId", C.projectOptions(false), "", { "aria-label": "مشروع المستند المعتمد" }), "kn.importProject");
    const importDoc = drafted(select("doc", [["STATUS.md", "STATUS.md"], ["README.md", "README.md"]], "STATUS.md", { "aria-label": "نوع المستند" }), "kn.importDoc");
    const importForm = h("form", { class: "co-memory-form", onsubmit: async (event) => {
      event.preventDefault();
      const result = await act(event.currentTarget.querySelector("button[type=submit]"), () => mutate("POST", "/knowledge/import-project", { projectId: importProject.value, doc: importDoc.value }), "فُهرس المستند المعتمد");
      if (result) loadKnowledge();
    } }, importProject, importDoc, h("button", { type: "submit", class: "btn btn-secondary" }, "استيراد من المشروع"));
    const SOURCE_AR = { "project-doc": "مستند مشروع معتمد", "owner-text": "نص أضافه المالك", "web-page": "صفحة ويب معتمدة (ZEN)" };
    const docs = ui.knowledgeDocs.map((doc) => h("article", { class: "co-memory-card" }, h("h3", null, doc.title), h("p", { class: "ops-dim" }, `${doc.projectId ? C.projectName(doc.projectId) || doc.projectId : "الشركة"} · ${SOURCE_AR[doc.sourceType] || doc.sourceType}`),
      h("p", { class: "ops-dim" }, "المصدر: ", bdi(doc.sourceUrl || doc.sourceRef, "co-tech-soft"), ` · فُهرس ${fmt.when(doc.indexedAt)}${doc.truncated ? " · مقتطف محدود" : ""}`),
      doc.freshness && doc.freshness !== "fresh" ? badge("warn", { stale: "قديم", changed: "تغيّر المصدر منذ الفهرسة", missing: "المصدر غير متاح", unreachable: "تعذّر الوصول" }[doc.freshness] || doc.freshness) : null,
      h("div", { class: "ops-actions" }, button("معاينة", async () => {
        try { const detail = await chatGet(`/knowledge/${doc.id}`); const d = O.drawer(detail.title); fill(d.body, h("p", { class: "ops-dim" }, `المصدر: ${detail.sourceRef}`), ...detail.chunks.map((chunk) => h("p", { class: "co-knowledge-chunk" }, chunk.content))); }
        catch (error) { toast(error.message, "bad"); }
      }), button("أرشفة", async (event) => { const result = await act(event.currentTarget, () => mutate("PATCH", `/knowledge/${doc.id}`, { state: "archived" }), "أُرشف المصدر"); if (result) loadKnowledge(); }),
      button("حذف", async (event) => { if (!await O.confirmDialog({ title: "حذف المصدر المعرفي؟", body: "سيُحذف النص وفهرسه المحلي نهائيًا.", confirm: "حذف", tone: "danger" })) return;
        const result = await act(event.currentTarget, () => mutate("DELETE", `/knowledge/${doc.id}`), "حُذف المصدر"); if (result) loadKnowledge(); }))));
    fill(root, ...memoryHeader(),
      ui.knowledgeError ? notice("bad", "تعذر تحميل المعرفة", ui.knowledgeError) : null,
      h("div", { class: "co-memory-toolbar" }, h("input", { class: "ops-input", type: "search", value: ui.knowledgeQuery, placeholder: "ابحث في المصادر…", "aria-label": "بحث المعرفة", oninput: (event) => { ui.knowledgeQuery = event.currentTarget.value; clearTimeout(ui.knowledgeTimer); ui.knowledgeTimer = setTimeout(() => loadKnowledge({ listOnly: true }), 300); } }), filter,
        button("إعادة الفهرسة", async (event) => { const result = await act(event.currentTarget, () => mutate("POST", "/knowledge/reindex", {}), "أُعيد بناء الفهرس"); if (result) loadKnowledge(); })),
      h("div", { class: "co-knowledge-hits" }, knowledgeHits()),
      h("div", { class: "co-columns" }, panel("إضافة نص معتمد", "النصوص هنا قابلة للبحث من دون اتصال. لا تُفهرس ملفات الجهاز تلقائيًا.", addForm), panel("استيراد مستند مشروع", "README.md أو STATUS.md من Checkout مرتبط ومصرّح فقط، بمقتطف منقح ومحدود. صفحات الويب يضيفها ZEN من «الأدوات والمهارات».", importForm)),
      h("div", { class: "co-memory-grid" }, docs.length ? docs : empty("لا مصادر مفهرسة بعد.")));
  }

  // ---------------------------------------------------------------- agent workspace
  const SUBS = [["overview", "نظرة عامة"], ["chat", "المحادثات"], ["tasks", "المهام"], ["runs", "سجل التشغيل"], ["tools", "الأدوات والصلاحيات"], ["files", "الملفات"], ["usage", "الاستخدام"], ["studio", "استوديو التصميم", "mia"], ["routing", "النموذج والتوجيه"], ["memory", "الذاكرة والسياق"], ["settings", "الإعدادات"], ["art", "الشخصية والحركة"]];
  const subsFor = (id) => SUBS.filter(([s, , only]) => (s !== "art" || BUILTIN_IDS.includes(id)) && (!only || only === id) && (V5.toolEngine || !["files", "studio"].includes(s)) && (V5.conversations || s !== "chat") && (V5.workflows || s !== "usage"));
  function renderAgent(id) {
    if (O.editing(root, () => render())) return;
    const res = O.peek(`co:agent:${id}`);
    const a = res?.data;
    const def = C.agentDef(id);
    if (!def) { O.setHead("agents", null); fill(root, catalog() ? notice("bad", "وكيل غير معروف", "لا يوجد وكيل بهذا المعرّف.") : O.skeleton(4)); return; }
    O.setHead("agents", { tab: "workspace", title: `${def.name} — ${def.titleAr}`, subtitle: def.roleAr, back: [href("agents"), "الفريق"], hideTabs: true });
    const sub = subsFor(id).some(([s]) => s === ui.sub) ? ui.sub : "overview";
    const form = ui.forms.get(id) || "standard";
    const liveState = robotState(a, a?.runs);
    const stage = robot(`ws:${id}`, id, { variant: form, animationState: liveState, size: 330, interactive: true });
    if (!stage.__wsBound) { stage.__wsBound = true; stage.addEventListener("click", () => stage.__robot?.react("greeting")); }
    if (a) watchRuns([a]);
    fill(root,
      h("section", { class: "ag-ws-hero", style: `--agent:${def.color}` },
        h("div", { class: "ag-ws-stage" }, stage,
          BUILTIN_IDS.includes(id) ? h("div", { class: "ag-form-toggle", role: "group", "aria-label": "هيئة الشخصية" }, ["standard", "expressive"].map((v) =>
            h("button", { type: "button", class: "ag-form-btn", "aria-pressed": String(v === form), onclick: () => { ui.forms.set(id, v); render(); } }, FORM_AR[v]))) : null),
        h("div", { class: "ag-ws-copy" },
          h("h2", null, bdi(def.name), h("small", null, `${def.titleAr} · 0${def.order}`)),
          h("p", null, def.summaryAr),
          h("div", { class: "ag-ws-badges" }, a ? label("availability", a.availability) : badge("muted", "جارٍ التحقق"),
            R && a ? h("span", { class: "ops-chip" }, h("span", { class: "ag-swatch" }), `الحالة الحية: ${R.STATE_AR[liveState]}`) : null,
            a?.config ? badge("accent", `الوضع: ${catalog()?.modes?.[a.config.mode]?.ar || a.config.mode}`) : null,
            a?.route?.chosen ? h("span", { class: "ops-chip" }, "النموذج الآن: ", bdi(a.route.chosen)) : null,
),
          h("div", { class: "ag-actions" }, V5.conversations ? linkButton(`محادثة مع ${def.name}`, href("agents", "chat", def.id), { kind: "primary", icon: "agents" }) : null, linkButton("طلب متخصص", href("agents", "request", def.id), { icon: "play" }), button("تحديث", () => loadAgent(id, true), { icon: "refresh" })))),
      h("nav", { class: "os-tabs", "aria-label": `أقسام مساحة ${def.name}` }, subsFor(id).map(([s, text]) => h("a", { class: `os-tab${s === sub ? " os-tab-current" : ""}`, href: href("agents", "workspace", id, s), "aria-current": s === sub ? "page" : null }, text))),
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
        quickActions(def),
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
    if (tab === "chat") {
      const box = h("div", null, O.skeleton(2));
      chatGet(`/conversations?agentId=${def.id}&limit=30`).then((d) => fill(box, d.conversations.length ? h("ul", { class: "co-agent-threads" }, d.conversations.map((t) => h("li", null,
        h("a", { href: href("agents", "chat", t.id) }, h("strong", null, t.title), h("small", { class: "ops-dim" }, `${t.projectId ? C.projectName(t.projectId) || "مشروع" : "بدون مشروع"} · ${fmt.relative(t.updatedAt)}`))))) : empty(`لا محادثات مع ${def.name} بعد.`))).catch((error) => fill(box, notice("bad", "تعذر تحميل المحادثات", error.message)));
      return panelX({ title: `محادثات ${def.name}`, hint: "المحادثات محفوظة محليًا وتستأنف من حيث توقفت.", actions: button("محادثة جديدة", async (e) => {
        const created = await act(e.currentTarget, () => mutate("POST", "/conversations", { agentId: def.id }), null); if (created) { ui.pick = def.id; O.go("agents", "chat", created.id); }
      }, { kind: "primary", icon: "plus" }) }, box);
    }
    if (tab === "usage") { const box = h("div"); window.AbudOperations?.renderAccounting(box, { agentId: def.id }); return box; }
    if (tab === "files") return window.AbudCapabilities ? window.AbudCapabilities.artifactGallery(root, { agentId: def.id, title: `ملفات ${def.name}` }) : empty("وحدة الأدوات غير محمّلة.");
    if (tab === "studio") return window.AbudCapabilities ? window.AbudCapabilities.studio() : empty("وحدة الأدوات غير محمّلة.");
    if (tab === "tools") {
      const allowed = new Set(a.config.tools);
      return [
        window.AbudCapabilities ? window.AbudCapabilities.agentTools(def) : null,
        window.AbudCapabilities ? window.AbudCapabilities.auditPanel(root, { agentId: def.id }) : null,
        notice("info", "صلاحيات قابلة للتضييق فقط", "يمكنك سحب أداة من الوكيل، لكن لا يمكن منحه أداة خارج مجموعته المعتمدة في الكود. لا يوجد تنفيذ Shell أو وصول ملفات عشوائي أو طلبات شبكة مفتوحة."),
        h("div", { class: "ops-tablewrap" }, h("table", { class: "ops-table" },
          h("caption", { class: "ops-dim" }, "كل أدوات الوكيل المعتمدة في الكود — أزل العلامة لسحب أداة"),
          h("thead", null, h("tr", null, ["الأداة", "الوصف", "النوع", "الموافقة", "الحد/دقيقة", "مسموحة"].map((x) => h("th", { scope: "col" }, x)))),
          h("tbody", null, cat.tools.filter((t) => def.tools.includes(t.id)).map((t) => h("tr", null,
            h("th", { scope: "row" }, t.ar, h("div", null, bdi(t.id, "co-tech-soft"))),
            h("td", null, t.descriptionAr || bdi(t.description, "co-tech-soft")),
            h("td", null, t.sideEffect === "artifact" ? badge("accent", "ينتج ملفًا") : t.readOnly ? badge("ok", "قراءة فقط") : badge("warn", "كتابة داخلية")),
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
  /** Background refreshes never rebuild a page while the owner types in one of its fields (search boxes included);
   * the deferred render runs once focus leaves the text fields. Explicit actions still render immediately. */
  const TEXT_FIELD = (el) => el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !["checkbox", "radio", "button", "submit", "file", "range"].includes(el.type);
  const inForm = (el) => root.contains(el) && (TEXT_FIELD(el) || Boolean(el.closest?.("form")));
  function busyTyping() {
    // Focus on a field, or on a control of the same form (a press in progress on its submit button), counts as busy.
    if (!inForm(document.activeElement)) return false;
    if (!root.dataset.deferRender) {
      root.dataset.deferRender = "1";
      const leave = () => setTimeout(() => {
        // Still typing, or moving to this form’s own button: keep waiting so a click never lands on a rebuilt form.
        if (inForm(document.activeElement)) return;
        root.removeEventListener("focusout", leave);
        delete root.dataset.deferRender;
        render();
      }, 0);
      root.addEventListener("focusout", leave);
    }
    return true;
  }
  function render() {
    if (O.state.view !== "agents") return;
    if (O.state.tab === "workspace" && ui.agent) return renderAgent(ui.agent);
    if (busyTyping()) return;
    O.setHead("agents", null);
    if (O.state.tab === "request") return renderRequest(O.state.rest[0]);
    if (O.state.tab === "runs") return renderRuns();
    if (O.state.tab === "chat") return renderChat();
    if (O.state.tab === "memory") return renderMemoryTab();
    if (O.state.tab === "performance") return fill(root, window.AbudPerformance ? window.AbudPerformance.render() : notice("bad", "وحدة الأداء غير محمّلة", "أعد تحميل الصفحة."));
    if (O.state.tab === "meetings") return window.AbudMeetings ? window.AbudMeetings.render(root) : fill(root, notice("bad", "وحدة الاجتماعات غير محمّلة", "أعد تحميل الصفحة."));
    if (O.state.tab === "operations") return window.AbudOperations ? window.AbudOperations.renderRoom(root) : fill(root, notice("bad", "وحدة غرفة العمليات غير محمّلة", "أعد تحميل الصفحة."));
    if (O.state.tab === "tools") return window.AbudCapabilities ? window.AbudCapabilities.renderLibrary(root) : fill(root, notice("bad", "وحدة الأدوات غير محمّلة", "أعد تحميل الصفحة."));
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
    id: "agents", order: 40, icon: "agents", ar: "الوكلاء", subtitle: "فريق وكلاء بأدوار متخصصة، يعمل عبر OmniRoute وتحت صلاحيات يفرضها الخادم.",
    tabs: [["team", "الفريق"], ...(V5.workflows ? [["operations", "غرفة العمليات"]] : []), ...(V5.conversations ? [["chat", "المحادثات"]] : []), ...(V5.meetings ? [["meetings", "الاجتماعات"]] : []), ...(V5.toolEngine ? [["tools", "الأدوات والمهارات"]] : []), ...(V5.performance ? [["performance", "الأداء"]] : []), ...(V5.knowledge ? [["memory", V5.learning ? "الذاكرة والخبرات" : "الذاكرة والمعرفة"]] : []), ["runs", "سجل التشغيل"], ["request", "طلب متخصص", { hidden: true }], ["workspace", "مساحة الوكيل", { hidden: true }]],
    defaultTab: "team",
    resolve(rest) {
      if (rest[0] === "workspace") return { tab: "workspace", rest: rest.slice(1) };
      if (BUILTIN_IDS.includes(rest[0]) || (rest[0] && !["team", "request", "runs", "chat", "meetings", "memory", "knowledge", "operations", "tools", "performance"].includes(rest[0]))) return { tab: "workspace", rest };
      // «المعرفة» is part of «الذاكرة والمعرفة»; its old route still lands there.
      if (V5.knowledge && rest[0] === "knowledge") return { tab: "memory", rest: ["knowledge"] };
      const available = ["team", "request", "runs", ...(V5.workflows ? ["operations"] : []), ...(V5.conversations ? ["chat"] : []), ...(V5.meetings ? ["meetings"] : []), ...(V5.toolEngine ? ["tools"] : []), ...(V5.performance ? ["performance"] : []), ...(V5.knowledge ? ["memory"] : [])];
      return available.includes(rest[0]) ? { tab: rest[0], rest: rest.slice(1) } : { tab: null, rest };
    },
    onShow(tab, rest) {
      ui.agent = tab === "workspace" ? rest[0] : null;
      ui.sub = tab === "workspace" ? rest[1] || "overview" : "overview";
      C.co.catalog(); C.co.projects();
      if (ui.agent) loadAgent(ui.agent); else { loadAgents(); loadRuns(); }
      if (tab === "request") loadAgents();
      if (tab === "memory") { ui.memSeg = ["knowledge", "conflicts", "learning"].includes(rest[0]) ? rest[0] : "memory"; loadMemory({ background: true }); if (ui.memSeg === "knowledge") loadKnowledge({ background: true }); }
      if (tab === "chat") {
        C.co.tasks();
        const target = rest[0];
        if (agentIds().includes(target) || (target && !target.startsWith("conv_"))) { ui.pick = target; ui.chatCurrent = null; loadChats(null, { background: true }); }
        else loadChats(target || null, { background: true });
      } else if (ui.chatStream) { ui.chatStream.source.close(); ui.chatStream = null; }
      if (tab === "operations") window.AbudOperations?.reload(); else window.AbudOperations?.stop();
      if (tab === "meetings") window.AbudMeetings?.reload(rest); else window.AbudMeetings?.stop();
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
  const watchedAgents = new Set();
  function watchAgentResources() {
    for (const id of [...BUILTIN_IDS, ...agentIds()]) {
      if (watchedAgents.has(id)) continue;
      watchedAgents.add(id);
      O.on(`co:agent:${id}`, () => { if (ui.agent === id) render(); });
    }
  }
  O.on("co:catalog", watchAgentResources);
  O.on("co:agents", watchAgentResources);
  watchAgentResources();
  window.AbudWorkforce = { openRun, renderMarkdown };
})();
