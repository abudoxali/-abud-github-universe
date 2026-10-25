/* ABUD FUN Company OS V2 — shared company layer used by every workspace: data accessors, the task card, task drawer,
 * quick task composer, project creation, notification and activity lists. All data comes from the Local Bridge company
 * API (SQLite) — the single source of truth for tasks, projects and agent runs. Text is inserted with textContent only. */
(() => {
  "use strict";
  const O = window.AbudOps;
  if (!O || !O.mutate) return;
  const { h, fill, fmt, badge, notice, L, label, bdi, dateOnly, todayIso, drawer, act, mutate, invalidate, icon, panel, empty, button, field, select, formValues } = O;

  // ---------------------------------------------------------------- data
  const co = {
    summary: (force) => O.api.co("summary", "/summary", { force, ttl: 15_000 }),
    tasks: (force) => O.api.co("tasks", "/tasks", { force, ttl: 15_000 }),
    projects: (force) => O.api.co("projects", "/projects", { force, ttl: 20_000 }),
    catalog: () => O.api.co("catalog", "/catalog", { ttl: 600_000 }),
    activity: (force) => O.api.co("activity", "/activity?limit=80", { force, ttl: 15_000 }),
    notifications: (force) => O.api.co("notifications", "/notifications", { force, ttl: 15_000 }),
    settings: (force) => O.api.co("settings", "/settings", { force, ttl: 60_000 }),
    agents: (force) => O.api.co("agents", "/agents", { force, ttl: 10_000 })
  };
  const data = (key) => O.peek(`co:${key}`)?.data;
  const agentsDef = () => data("catalog")?.agents || [];
  const agentDef = (id) => agentsDef().find((a) => a.id === id);
  const projectsList = () => data("projects")?.projects || [];
  const projectName = (id) => projectsList().find((p) => p.id === id)?.name || null;
  const refreshAfterTaskChange = () => invalidate("tasks", "archivedTasks", "summary", "activity", "projects", "agents", "agent:", "notifications", "project:");

  function pipType(state) {
    if (!state) return null;
    if (state === "working") return "working";
    if (["thinking", "queued", "listening", "speaking"].includes(state)) return "thinking";
    if (["available", "idle", "ready"].includes(state)) return "available";
    if (["error", "failed"].includes(state)) return "error";
    if (["router-offline", "offline"].includes(state)) return "offline";
    if (["unavailable", "disabled", "no-eligible-model"].includes(state)) return "unavailable";
    return "available";
  }
  function pipLabel(state) {
    const map = {
      working: "يعمل الآن",
      thinking: "يفكر في الطلب",
      queued: "في طابور التنفيذ",
      listening: "يستمع للطلب",
      speaking: "يستقبل الرد",
      available: "جاهز للعمل",
      idle: "في وضع الاستعداد",
      ready: "جاهز للعمل",
      error: "واجه خطأ",
      failed: "تعذّر التنفيذ",
      offline: "OmniRoute غير متصل",
      "router-offline": "OmniRoute غير متصل",
      "no-eligible-model": "لا يوجد نموذج مؤهل",
      disabled: "الوكيل معطّل",
      unavailable: "غير متاح حاليًا"
    };
    return map[state] || state;
  }

  /** Character portrait for an agent: the code-built head from the robot engine (flat vector, no animation — small UI
   * never runs a live renderer). Supports reusable size variants (xs, sm, md, lg, xl, 2xl) and live state pips. */
  function avatar(id, size = "sm", opts = {}) {
    if (typeof opts === "string") opts = { state: opts };
    const extraClass = opts.className ? ` ${opts.className}` : "";
    if (id === "owner") {
      const icSize = size === "xs" ? 11 : size === "sm" ? 14 : size === "lg" ? 22 : size === "xl" ? 28 : 18;
      return h("span", { class: `co-avatar co-avatar-${size} co-avatar-owner${extraClass}`, title: L.owner, "aria-label": L.owner }, icon("user", icSize));
    }
    if (id === "none" || id == null) return h("span", { class: `co-avatar co-avatar-${size} co-avatar-none${extraClass}`, title: L.none, "aria-label": L.none }, "—");
    const def = agentDef(id);
    if (!def) return h("span", { class: `co-avatar co-avatar-${size}${extraClass}` }, "—");

    const state = opts.state || null;
    const pip = (opts.showPip !== false && state) ? pipType(state) : null;
    const isWorking = pip === "working";
    const statusText = state ? ` (${pipLabel(state)})` : "";
    const titleText = `${def.name} · ${def.titleAr}${statusText}`;
    const interactiveClass = opts.interactive ? " is-interactive" : "";
    const workingClass = isWorking ? " is-working" : "";
    const hasPipClass = pip ? " has-pip" : "";

    const el = h("span", {
      class: `co-avatar co-avatar-${size} co-avatar-agent${interactiveClass}${workingClass}${hasPipClass}${extraClass}`,
      title: titleText,
      "aria-label": titleText,
      style: `--agent:${def.color}`,
      "data-agent": def.id,
      "data-agent-state": state || "idle"
    },
      window.AbudRobots?.portrait(def.id, { expression: opts.expression || (isWorking ? "focus" : null) }) || h("img", { src: def.art.face || def.art.card, alt: "", loading: "lazy", decoding: "async" }));

    if (pip) {
      el.append(h("span", {
        class: `co-avatar-pip co-avatar-pip-${pip}`,
        "aria-label": pipLabel(state),
        title: pipLabel(state)
      }));
    }
    return el;
  }
  const assigneeName = (id) => (id === "owner" ? L.owner : id === "none" ? L.none : agentDef(id)?.name || id);
  const assigneeOptions = () => [["owner", L.owner], ["none", L.none], ...agentsDef().map((a) => [a.id, `${a.name} — ${a.titleAr}`])];
  const projectOptions = (withNone = true) => [...(withNone ? [["", "بدون مشروع"]] : []), ...projectsList().map((p) => [p.id, p.name])];
  const openProject = (id) => O.go("projects", "p", id);

  // ---------------------------------------------------------------- task actions shared by several screens
  async function patchTask(id, patch, success = "تم الحفظ") {
    const result = await act(null, () => mutate("PATCH", `/tasks/${encodeURIComponent(id)}`, patch), success);
    if (result) refreshAfterTaskChange();
    return result;
  }
  function statusSelect(task) {
    const node = select("status", Object.entries(L.taskStatus), task.status, { "aria-label": `حالة المهمة: ${task.title}`, class: "ops-input co-compact" });
    node.addEventListener("change", () => {
      if (node.value === "blocked") { node.value = task.status; openTask(task.id, { focusBlocker: true }); return; }
      patchTask(task.id, { status: node.value }, `الحالة: ${L.taskStatus[node.value]}`);
    });
    return node;
  }
  function dueChip(task) {
    if (!task.dueDate) return null;
    const today = todayIso();
    const closed = ["done", "cancelled"].includes(task.status);
    const overdue = task.dueDate < today && !closed;
    return h("span", { class: `co-due${overdue ? " co-overdue" : task.dueDate === today ? " co-today" : ""}` }, icon("calendar", 14),
      overdue ? `متأخرة · ${dateOnly(task.dueDate)}` : task.dueDate === today ? "اليوم" : dateOnly(task.dueDate));
  }
  /** The task card used everywhere (HQ, Work Hub, project page, agent workspace). */
  function taskRow(task, { compact = false, showProject = true } = {}) {
    const done = task.status === "done";
    const doneBtn = h("button", { type: "button", class: `co-check${done ? " co-checked" : ""}`, "aria-pressed": String(done), "aria-label": done ? `إعادة فتح: ${task.title}` : `تمييز كمنجزة: ${task.title}`,
      onclick: () => patchTask(task.id, { status: done ? "todo" : "done" }, done ? "أُعيد فتح المهمة" : "أُنجزت المهمة") }, done ? icon("check", 16) : null);
    return h("li", { class: `co-task co-prio-${task.priority}${done ? " co-task-done" : ""}${task.status === "blocked" ? " co-task-blocked" : ""}`, "data-task": task.id },
      doneBtn,
      h("div", { class: "co-task-main" },
        h("button", { type: "button", class: "co-task-title", onclick: () => openTask(task.id) }, task.title),
        h("div", { class: "co-task-meta" },
          showProject && task.projectId ? h("a", { class: "ops-chip", href: O.href("projects", "p", task.projectId) }, icon("projects", 14), projectName(task.projectId) || "مشروع") : null,
          h("span", { class: "co-assignee" }, avatar(task.assignee), assigneeName(task.assignee)),
          dueChip(task),
          task.status === "blocked" && task.blocker ? h("span", { class: "co-blocker" }, icon("alert", 14), task.blocker) : null)),
      h("div", { class: "co-task-side" }, label("priority", task.priority), compact ? label("taskStatus", task.status) : statusSelect(task)));
  }
  const taskList = (tasks, opts) => (tasks.length ? h("ul", { class: "co-tasks" }, tasks.map((t) => taskRow(t, opts))) : null);

  async function openTask(id, { focusBlocker = false } = {}) {
    const d = drawer("تفاصيل المهمة", { wide: true });
    fill(d.body, O.skeleton(4));
    let task;
    try { task = await fetch(`/local-api/company/tasks/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error("تعذر تحميل المهمة")))); }
    catch (error) { fill(d.body, notice("bad", "تعذر التحميل", error.message)); return; }
    d.heading.textContent = task.title;
    if (task.archivedAt) {
      fill(d.body, notice("info", "مهمة مؤرشفة", `أُرشفت ${fmt.when(task.archivedAt)}. تبقى بياناتها وسجلها محفوظين.`),
        panel("تفاصيل محفوظة", null, h("p", null, task.description || task.title), button("استعادة المهمة", async (event) => {
          if (await act(event.currentTarget, () => mutate("POST", `/tasks/${encodeURIComponent(id)}/restore`, {}), "استُعيدت المهمة")) { refreshAfterTaskChange(); d.close(); }
        }, { icon: "refresh" })));
      return;
    }
    const form = h("form", { class: "co-form-grid", onsubmit: async (event) => {
      event.preventDefault();
      const v = formValues(form);
      const patch = { title: v.title, description: v.description || null, projectId: v.projectId || null, assignee: v.assignee, priority: v.priority, status: v.status, blocker: v.blocker || null,
        dueDate: v.dueDate || null, startDate: v.startDate || null, estimateHours: v.estimateHours === "" ? null : Number(v.estimateHours), tags: v.tags ? v.tags.split(/[،,]/).map((t) => t.trim()).filter(Boolean) : [] };
      const saved = await act(form.querySelector("[type=submit]"), () => mutate("PATCH", `/tasks/${encodeURIComponent(id)}`, patch), "حُفظت المهمة");
      if (saved) { refreshAfterTaskChange(); d.close(); }
    } },
    field("العنوان", h("input", { class: "ops-input", name: "title", required: true, maxlength: 160, value: task.title })),
    field("الوصف", h("textarea", { class: "ops-input", name: "description", rows: 4, maxlength: 4000 }, task.description || "")),
    h("div", { class: "co-form-row" },
      field("المشروع", select("projectId", projectOptions(), task.projectId ?? "")),
      field("المسؤول", select("assignee", assigneeOptions(), task.assignee))),
    h("div", { class: "co-form-row" },
      field("الأولوية", select("priority", Object.entries(L.priority), task.priority)),
      field("الحالة", select("status", Object.entries(L.taskStatus), task.status))),
    field("العائق", h("input", { class: "ops-input", name: "blocker", maxlength: 300, value: task.blocker || "" }), "مطلوب عند اختيار «متعطّل»."),
    h("div", { class: "co-form-row" },
      field("تاريخ البدء", O.dateInput("startDate", task.startDate, "تاريخ البدء")),
      field("تاريخ الاستحقاق", O.dateInput("dueDate", task.dueDate, "تاريخ الاستحقاق")),
      field("الجهد المقدّر (ساعات)", h("input", { class: "ops-input", type: "number", min: 0, step: 0.5, name: "estimateHours", value: task.estimateHours ?? "" }))),
    field("الوسوم", h("input", { class: "ops-input", name: "tags", value: (task.tags || []).join("، ") }), "افصل بفاصلة."),
    h("div", { class: "co-form-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, "حفظ التغييرات"),
      button("أرشفة المهمة", async (event) => {
        if (!(await O.confirmDialog({ title: "أرشفة المهمة؟", body: `ستختفي «${task.title}» من العمل النشط وتبقى قابلة للاستعادة من تبويب المنجزة.`, confirm: "أرشفة" }))) return;
        if (await act(event.currentTarget, () => mutate("POST", `/tasks/${encodeURIComponent(id)}/archive`, {}), "أُرشفت المهمة")) { refreshAfterTaskChange(); d.close(); }
      }, { icon: "download" }),
      agentDef(task.assignee) ? button(`اطلب من ${agentDef(task.assignee).name} العمل عليها`, async (event) => {
        const def = agentDef(task.assignee);
        const run = await act(event.currentTarget, () => mutate("POST", "/runs", { agentId: def.id, capability: def.capabilities.includes("task_breakdown") ? "task_breakdown" : "chat",
          request: `${task.title}${task.description ? `\n\n${task.description}` : ""}`, taskId: task.id, projectId: task.projectId || undefined, priority: task.priority, idempotencyKey: `task-${task.id}-${Date.now()}` }), `أُرسلت إلى ${def.name}`);
        if (run) { invalidate("agents", "agent:", "summary", "activity"); d.close(); O.go("agents", def.id, "runs"); }
      }, { icon: "play" }) : null));
    fill(d.body, form,
      panel("السجل", "كل تغيير محفوظ مع الفاعل والوقت.", task.events?.length ? h("ul", { class: "co-history" }, task.events.map((e) => h("li", null, h("time", null, fmt.when(e.at)), h("span", { class: "co-history-actor" }, actorName(e.actor)), h("span", null, describeEvent(e))))) : empty("لا سجل.")),
      task.runs?.length ? panel("تشغيلات الوكلاء", null, h("ul", { class: "co-history" }, task.runs.map((r) => h("li", null, h("time", null, fmt.when(r.createdAt)), avatar(r.agentId), label("runStatus", r.status), h("a", { class: "ops-link", href: O.href("agents", r.agentId, "runs"), onclick: () => d.close() }, "عرض النتيجة"))))) : null);
    if (focusBlocker) { form.status.value = "blocked"; form.blocker.focus(); }
  }
  const actorName = (actor) => (actor === "owner:owner" ? L.owner : /^agent:/.test(actor) ? actor.slice(6).toUpperCase() : actor === "system" || /^system/.test(actor) ? "النظام" : actor);
  function describeEvent(e) {
    if (e.kind === "created") return "أُنشئت";
    if (e.kind === "agent-run") return "أُسندت لوكيل";
    if (e.kind === "agent-result") return "نتيجة من وكيل";
    const d = e.detail || {};
    const names = { title: "العنوان", description: "الوصف", projectId: "المشروع", blocker: "العائق", startDate: "تاريخ البدء", estimateHours: "الجهد", tags: "الوسوم" };
    return Object.entries(d).map(([k, v]) => k === "status" ? `الحالة: ${L.taskStatus[v.from] ?? "—"} ← ${L.taskStatus[v.to] ?? "—"}` : k === "assignee" ? `المسؤول: ${assigneeName(v.to)}` : k === "priority" ? `الأولوية: ${L.priority[v.to]}` : k === "dueDate" ? `الاستحقاق: ${v.to ? dateOnly(v.to) : "—"}` : `تعديل ${names[k] || k}`).join(" · ") || "تعديل";
  }

  /** Quick task composer: the title is the only required input; the compact controls are optional. */
  function quickTaskForm({ preset = {}, onDone, autofocus = false } = {}) {
    const form = h("form", { class: "co-quickadd", "aria-label": "إضافة مهمة سريعة", onsubmit: async (event) => {
      event.preventDefault();
      const v = formValues(form);
      if (!v.title) { form.title.focus(); return; }
      const created = await act(form.querySelector("[type=submit]"), () => mutate("POST", "/tasks", { title: v.title, projectId: v.projectId || null, assignee: v.assignee || "owner", priority: v.priority || "medium", dueDate: v.dueDate || null, status: preset.status || undefined }), "أُضيفت المهمة");
      if (created) { form.title.value = ""; form.title.focus(); refreshAfterTaskChange(); onDone?.(created); }
    } },
    h("div", { class: "co-quickadd-main" }, icon("plus", 20),
      h("input", { class: "co-quickadd-title", name: "title", placeholder: "أضف مهمة جديدة… ثم اضغط Enter", maxlength: 160, "aria-label": "عنوان المهمة", required: true, autofocus: autofocus ? true : null }),
      h("button", { type: "submit", class: "btn btn-primary" }, "إضافة")),
    h("div", { class: "co-quickadd-opts" },
      h("label", null, icon("projects", 16), h("span", { class: "sr-only" }, "المشروع"), select("projectId", projectOptions(), preset.projectId ?? "", { "aria-label": "المشروع" })),
      h("label", null, icon("user", 16), h("span", { class: "sr-only" }, "المسؤول"), select("assignee", assigneeOptions(), preset.assignee ?? "owner", { "aria-label": "المسؤول" })),
      h("label", null, icon("flag", 16), h("span", { class: "sr-only" }, "الأولوية"), select("priority", Object.entries(L.priority), preset.priority ?? "medium", { "aria-label": "الأولوية" })),
      O.dateInput("dueDate", preset.dueDate ?? "", "تاريخ الاستحقاق")));
    return form;
  }
  /** A quick-add form that survives re-renders: the same node is reused (keeping focus and typed text) and is only
   * rebuilt when it is idle and its project/agent options have changed. */
  const stableForms = new Map();
  function stableQuickAdd(key, preset = {}) {
    const signature = `${projectsList().length}:${agentsDef().length}:${JSON.stringify(preset)}`;
    const cached = stableForms.get(key);
    if (cached && (cached.signature === signature || cached.form.contains(document.activeElement) || cached.form.title.value)) return cached.form;
    const form = quickTaskForm({ preset });
    stableForms.set(key, { form, signature });
    return form;
  }
  function openQuickTask(preset) {
    co.projects(); co.catalog();
    const d = drawer("مهمة جديدة");
    fill(d.body, quickTaskForm({ preset, onDone: () => d.close() }), h("p", { class: "ops-dim" }, "تُحفظ المهمة في مخزن الشركة وتظهر فورًا في العمل والرئيسية وصفحة المشروع والوكيل المسؤول."));
    d.body.querySelector("input[name=title]")?.focus();
  }

  function openNewProject() {
    const d = drawer("مشروع جديد");
    const form = h("form", { class: "co-form-grid", onsubmit: async (event) => {
      event.preventDefault();
      const v = formValues(form);
      const created = await act(form.querySelector("[type=submit]"), () => mutate("POST", "/projects", { name: v.name, github: v.github || null, status: v.status, priority: v.priority, summary: v.summary || null }), "أُنشئ المشروع");
      if (created) { invalidate("projects", "summary", "activity"); d.close(); openProject(created.id); }
    } },
    field("اسم المشروع", h("input", { class: "ops-input", name: "name", required: true, maxlength: 120 })),
    field("مستودع GitHub (اختياري)", h("input", { class: "ops-input", name: "github", dir: "ltr", placeholder: "owner/repo", pattern: "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" }), "الهوية الثابتة للمشروع؛ تمنع التكرار."),
    h("div", { class: "co-form-row" }, field("الحالة", select("status", Object.entries(L.projectStatus), "active")), field("الأولوية", select("priority", Object.entries(L.priority), "medium"))),
    field("الوصف", h("textarea", { class: "ops-input", name: "summary", rows: 3, maxlength: 600 })),
    h("div", { class: "co-form-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, "إنشاء المشروع")));
    fill(d.body, form);
    form.name.focus();
  }

  // ---------------------------------------------------------------- notifications + activity (shared)
  const TARGET_HREF = { task: null, project: (id) => O.href("projects", "p", id), run: () => O.href("agents", "runs"), approval: () => O.href("resources", "routing"), provider: () => O.href("resources", "quotas"), agent: (id) => O.href("agents", id), system: () => O.href("system", "overview") };
  function notificationList(list, { compact = false } = {}) {
    return h("ul", { class: "co-notes" }, list.map((n) => h("li", { class: `co-note co-note-${n.level}${n.acknowledged_at ? " co-note-ack" : ""}` },
      label("level", n.level),
      h("div", { class: "co-note-main" }, h("strong", null, O.rich(n.title)), !compact && n.body ? h("span", { class: "ops-dim" }, O.rich(isoText(n.body))) : null,
        h("small", { class: "ops-dim" }, `${fmt.relative(n.last_seen_at)}${n.count > 1 ? ` · تكرر ${n.count} مرات` : ""}`)),
      h("div", { class: "co-note-actions" },
        n.target_type === "task" ? h("button", { type: "button", class: "ops-link", onclick: () => openTask(n.target_id) }, "فتح")
          : TARGET_HREF[n.target_type] ? h("a", { class: "ops-link", href: TARGET_HREF[n.target_type](n.target_id) }, "فتح") : null,
        n.acknowledged_at ? h("span", { class: "ops-dim" }, "تم الإقرار") : h("button", { type: "button", class: "ops-link", onclick: async (e) => { if (await act(e.currentTarget, () => mutate("POST", `/notifications/${n.id}/ack`, {}), "تم الإقرار")) invalidate("notifications", "summary"); } }, "إقرار")))));
  }
  /** Server text sometimes carries ISO timestamps; show them in the company timezone. */
  // Older stored summaries carry a Latin memory scope ("ذاكرة project: …"); show it in Arabic without rewriting history.
  const SCOPE_AR = { project: "المشروع", agent: "الوكيل", company: "الشركة" };
  const isoText = (text) => String(text ?? "").replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => fmt.when(iso))
    .replace(/^ذاكرة (project|agent|company):/, (_, scope) => `ذاكرة ${SCOPE_AR[scope]}:`);
  const ACTOR = (e) => (e.actor_type === "agent" ? avatar(e.actor_id) : e.actor_type === "owner" ? avatar("owner") : h("span", { class: "co-avatar co-avatar-sm co-avatar-sys", title: "النظام" }, icon("system", 14)));
  const OUTCOME = { success: ["ok", "نجح"], failure: ["bad", "فشل"], blocked: ["warn", "متوقف"], pending: ["info", "بانتظار"], info: ["muted", "معلومة"] };
  /** Activity timeline. The technical action code and evidence stay available behind an expandable detail. */
  function activityList(events, { technical = true } = {}) {
    return h("ul", { class: "co-activity" }, events.map((e) => h("li", null, ACTOR(e),
      h("div", { class: "co-act-main" }, h("span", null, O.rich(isoText(e.summary))),
        h("small", { class: "ops-dim" }, fmt.when(e.at)),
        technical && (e.action || e.evidence) ? h("details", { class: "co-act-tech" }, h("summary", null, "تفاصيل تقنية"), h("p", null, bdi(e.action), e.evidence ? [" · ", bdi(e.evidence)] : null)) : null),
      badge(...(OUTCOME[e.outcome] || ["muted", e.outcome])))));
  }

  window.AbudCompany = {
    co, data, agentsDef, agentDef, projectsList, projectName, refreshAfterTaskChange, avatar, assigneeName, assigneeOptions, projectOptions,
    patchTask, statusSelect, taskRow, taskList, dueChip, openTask, openProject, openQuickTask, openNewProject, quickTaskForm, stableQuickAdd, describeEvent,
    notificationList, activityList, isoText, panel, empty, button, field, select, formValues
  };
  co.catalog(); co.settings(); co.summary(); co.projects();
})();
