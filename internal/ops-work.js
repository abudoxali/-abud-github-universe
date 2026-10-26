/* ABUD FUN Company OS V2 — العمل (Work Hub). The company task store (SQLite) is the single operational source of truth:
 * a task created anywhere (HQ, project page, agent workspace) appears here, and every change here is visible everywhere.
 * Views are contextual tabs; only one is rendered at a time. Dates use the company timezone (Africa/Cairo). */
(() => {
  "use strict";
  const O = window.AbudOps;
  const C = window.AbudCompany;
  if (!O || !C) return;
  const { h, fill, L, label, icon, panel, panelX, empty, button, select, href, todayIso, store } = O;

  const head = O.section("coWork", "work");
  const body = O.section("coWorkBody", "work");
  const prefs = store.read("abud-os-work", {}) || {};
  const ui = { project: prefs.project || "", assignee: prefs.assignee || "", query: "", month: null, boardPositioned: false };
  const persist = () => store.write("abud-os-work", { project: ui.project, assignee: ui.assignee });
  const allTasks = () => C.data("tasks")?.tasks || [];
  const isOpen = (t) => !["done", "cancelled"].includes(t.status);

  function filtered() {
    const q = ui.query.trim().toLowerCase();
    return allTasks().filter((t) => (!ui.project || t.projectId === ui.project) && (!ui.assignee || t.assignee === ui.assignee)
      && (!q || t.title.toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q) || (t.tags || []).some((tag) => tag.toLowerCase().includes(q))));
  }

  let searchInput = null;
  function renderHead() {
    if (O.state.tab === "routines") { fill(head, null); return; }
    if (!C.data("tasks")) { fill(head, O.resourceStatus(O.peek("co:tasks"), "المهام") || O.skeleton(2)); return; }
    // The search box keeps its node (and focus) across data refreshes.
    if (!searchInput) searchInput = h("input", { class: "ops-input pj-search", type: "search", placeholder: "ابحث في المهام…", "aria-label": "بحث في المهام", oninput: (e) => { ui.query = e.target.value; renderBody(); } });
    const tab = O.state.tab || "today";
    fill(head,
      C.stableQuickAdd("work", { projectId: ui.project || "", assignee: ui.assignee && (ui.assignee === "owner" || ui.assignee === "none" || C.activeAgents().some((a) => a.id === ui.assignee)) ? ui.assignee : "owner", dueDate: tab === "today" ? todayIso() : "" }),
      h("div", { class: "wk-filters" }, searchInput,
        select("fproject", [["", "كل المشاريع"], ...C.projectOptions(false)], ui.project, { "aria-label": "تصفية بالمشروع", onchange: (e) => { ui.project = e.target.value; persist(); renderAll(); } }),
        select("fassignee", [["", "كل المسؤولين"], ...C.assigneeOptions({ activeOnly: false })], ui.assignee, { "aria-label": "تصفية بالمسؤول", onchange: (e) => { ui.assignee = e.target.value; persist(); renderAll(); } }),
        ui.project || ui.assignee ? button("مسح التصفية", () => { ui.project = ""; ui.assignee = ""; persist(); renderAll(); }, { icon: "close" }) : null));
  }

  /** Focus projects (company store) with their real task progress — the legacy Workboard idea, now on company tasks. */
  function focusStrip() {
    const focus = (C.data("projects")?.projects || []).filter((p) => p.focus);
    if (!focus.length) return panelX({ title: "مشاريع التركيز", hint: "اختر حتى ثلاثة مشاريع تركيز من صفحة المشروع؛ تظهر هنا مع تقدّم مهامها." }, empty("لا مشاريع تركيز بعد.", O.linkButton("اختر من المشاريع", href("projects", "all"), { icon: "flag" })));
    return panelX({ title: `مشاريع التركيز (${focus.length}/3)`, hint: "التقدم = المهام المنجزة من مجموع المهام غير الملغاة." },
      h("div", { class: "wk-focus" }, focus.map((p) => {
        const total = p.tasks.open + p.tasks.done;
        const pct = total ? (p.tasks.done / total) * 100 : null;
        return h("a", { class: "wk-focus-card", href: href("projects", "p", p.id), style: "text-decoration:none;color:inherit" },
          h("strong", null, p.name),
          h("div", { class: "wk-progress" }, O.meter(pct, "ok", `تقدم ${p.name}`), h("span", null, total ? `${p.tasks.done}/${total}` : "لا مهام")),
          h("small", { class: "ops-dim" }, `${p.tasks.open} مفتوحة${p.tasks.blocked ? ` · ${p.tasks.blocked} متعطّلة` : ""}`));
      })));
  }

  function group(title, hint, tasks, opts) {
    return tasks.length ? panel(`${title} (${tasks.length})`, hint, C.taskList(tasks, opts)) : null;
  }

  function renderBody() {
    if (O.state.tab === "routines") { fill(body, window.AbudRoutines ? window.AbudRoutines.render() : null); return; }
    if (!C.data("tasks")) { fill(body, null); return; }
    const tab = O.state.tab || "today";
    const tasks = filtered();
    const today = todayIso();
    const open = tasks.filter(isOpen);
    let nodes;
    if (tab === "today") {
      const overdue = open.filter((t) => t.dueDate && t.dueDate < today);
      const dueToday = open.filter((t) => t.dueDate === today);
      const doing = open.filter((t) => t.status === "in_progress" && !(t.dueDate && t.dueDate <= today));
      const important = open.filter((t) => t.priority === "high" && t.status !== "in_progress" && t.status !== "backlog" && !(t.dueDate && t.dueDate <= today));
      const any = overdue.length + dueToday.length + doing.length + important.length;
      nodes = [focusStrip(),
        any ? null : empty("لا شيء لليوم: لا متأخر، لا مستحق، ولا عمل جارٍ. أضف مهمة بالأعلى."),
        group("متأخرة", "تجاوزت موعدها — ابدأ بها أو أعد جدولتها.", overdue),
        group("مستحقة اليوم", null, dueToday),
        group("قيد التنفيذ", null, doing),
        group("مهمة بلا موعد قريب", "أولوية عالية.", important)];
    } else if (tab === "upcoming") {
      const dated = open.filter((t) => t.dueDate && t.dueDate > today).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      const weekEnd = new Intl.DateTimeFormat("en-CA", { timeZone: O.companyZone() }).format(new Date(Date.now() + 7 * 86_400_000));
      nodes = [group("خلال 7 أيام", null, dated.filter((t) => t.dueDate <= weekEnd)),
        group("لاحقًا", null, dated.filter((t) => t.dueDate > weekEnd)),
        group("بلا موعد (المتراكم)", "مهام مفتوحة بلا تاريخ استحقاق.", open.filter((t) => !t.dueDate && ["backlog", "todo"].includes(t.status)))];
      if (!nodes.some(Boolean)) nodes = [empty("لا مهام قادمة.")];
    } else if (tab === "done") {
      const done = tasks.filter((t) => t.status === "done").sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || "")).slice(0, 100);
      const archived = O.peek("co:archivedTasks")?.data?.tasks;
      nodes = [panel(`المنجزة (${done.length})`, "الأحدث إنجازًا أولًا. اضغط المربع لإعادة فتح مهمة.", C.taskList(done, { compact: true }) || empty("لا مهام منجزة بعد.")),
        panel(`الأرشيف (${archived?.length ?? "…"})`, "مهام محفوظة خارج العمل النشط؛ افتح المهمة لاستعادتها.", archived ? (archived.length ? h("ul", { class: "co-tasks" }, archived.map((t) => h("li", { class: "co-task" }, button(t.title, () => C.openTask(t.id), { icon: "refresh" }), h("small", { class: "ops-dim" }, t.archivedAt ? O.fmt.when(t.archivedAt) : "")))) : empty("لا مهام مؤرشفة.")) : O.skeleton(2))];
    } else if (tab === "board") nodes = [board(tasks)];
    else if (tab === "calendar") nodes = [calendar(open)];
    else if (tab === "project") {
      const groups = new Map();
      for (const t of open) groups.set(t.projectId || "", [...(groups.get(t.projectId || "") || []), t]);
      nodes = groups.size ? [h("div", { class: "co-groups" }, [...groups].sort((a, b) => b[1].length - a[1].length).map(([pid, list]) => panelX({ title: pid ? C.projectName(pid) || pid : "بدون مشروع", hint: `${list.length} مهمة مفتوحة`, actions: pid ? O.linkButton("المشروع", href("projects", "p", pid), { icon: "chevronLeft" }) : null }, C.taskList(list, { showProject: false }))))] : [empty("لا مهام مفتوحة.")];
    } else if (tab === "agent") {
      const order = ["owner", ...C.agentsDef().map((a) => a.id), "none"];
      nodes = [h("div", { class: "co-groups" }, order.map((id) => {
        const list = open.filter((t) => t.assignee === id);
        if (!list.length && id === "none") return null;
        return panelX({ title: C.assigneeName(id), hint: `${list.length} مهمة مفتوحة`, actions: id !== "owner" && id !== "none" ? O.linkButton("مساحة الوكيل", href("agents", id), { icon: "chevronLeft" }) : null },
          h("div", { class: "co-group-head" }, C.avatar(id, "md"), h("span", { class: "ops-dim" }, id === "owner" ? "مهامك" : id === "none" ? "تحتاج إسنادًا" : C.agentDef(id)?.titleAr || "")),
          C.taskList(list) || empty("لا مهام مسندة."));
      }))];
    }
    fill(body, nodes);
    if (tab === "board" && !ui.boardPositioned) {
      ui.boardPositioned = true;
      requestAnimationFrame(() => {
        const boardEl = body.querySelector(".co-board");
        const activeCol = [...(boardEl?.querySelectorAll(".co-col") || [])].find((col) => col.querySelector(".co-task"));
        if (boardEl && activeCol && getComputedStyle(boardEl).direction === "rtl") {
          boardEl.scrollLeft = activeCol.getBoundingClientRect().right - boardEl.getBoundingClientRect().right;
        }
      });
    }
  }

  function board(tasks) {
    const columns = ["backlog", "todo", "in_progress", "blocked", "review", "done"];
    return h("div", null,
      h("p", { class: "ops-dim" }, "اسحب البطاقة بين الأعمدة، أو غيّر حالتها من القائمة داخل البطاقة (بديل لوحة المفاتيح)."),
      h("div", { class: "co-board", role: "list", "aria-label": "لوحة المهام" }, columns.map((status) => {
        const items = tasks.filter((t) => t.status === status).slice(0, status === "done" ? 20 : 200);
        const col = h("section", { class: `co-col co-col-${status}`, role: "listitem", "aria-label": `${L.taskStatus[status]}: ${items.length}`, "data-status": status },
          h("header", null, label("taskStatus", status), h("span", { class: "ops-dim" }, String(items.length))),
          h("ul", { class: "co-col-list" }, items.map((t) => {
            const card = C.taskRow(t);
            card.draggable = true;
            card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed = "move"; card.classList.add("co-dragging"); });
            card.addEventListener("dragend", () => card.classList.remove("co-dragging"));
            return card;
          })),
          status === "done" && tasks.filter((t) => t.status === "done").length > 20 ? h("a", { class: "ops-link", href: href("work", "done") }, "كل المنجزة") : null);
        col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("co-drop"); });
        col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("co-drop"); });
        col.addEventListener("drop", (e) => {
          e.preventDefault(); col.classList.remove("co-drop");
          const id = e.dataTransfer.getData("text/plain");
          const task = tasks.find((x) => x.id === id);
          if (!task || task.status === status) return;
          if (status === "blocked") C.openTask(id, { focusBlocker: true });
          else C.patchTask(id, { status }, `نُقلت إلى «${L.taskStatus[status]}»`);
        });
        return col;
      })));
  }

  function calendar(tasks) {
    const today = todayIso();
    const [y, m] = (ui.month || today.slice(0, 7)).split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const offset = (first.getUTCDay() + 1) % 7; // weeks start on Saturday (Egypt)
    const monthName = new Intl.DateTimeFormat("ar-EG-u-nu-latn", { month: "long", year: "numeric", timeZone: "UTC" }).format(first);
    const shift = (delta) => { const d = new Date(Date.UTC(y, m - 1 + delta, 1)); ui.month = d.toISOString().slice(0, 7); renderBody(); };
    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(h("div", { class: "co-day co-day-pad", "aria-hidden": "true" }));
    for (let d = 1; d <= days; d++) {
      const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const items = tasks.filter((t) => t.dueDate === iso);
      const dayLabel = new Intl.DateTimeFormat("ar-EG-u-nu-latn", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
      cells.push(h("div", { class: `co-day${iso === today ? " co-day-today" : ""}${iso < today && items.length ? " co-day-late" : ""}`, "aria-label": `${dayLabel}: ${items.length ? `${items.length} مهمة` : "لا مهام"}`, role: "gridcell" },
        h("span", { class: "co-day-num" }, String(d)),
        items.slice(0, 3).map((t) => h("button", { type: "button", class: `co-day-task co-prio-${t.priority}`, onclick: () => C.openTask(t.id), title: t.title }, t.title)),
        items.length > 3 ? h("small", { class: "ops-dim" }, `+${items.length - 3} أخرى`) : null,
        h("button", { type: "button", class: "co-day-add", "aria-label": `إضافة مهمة في ${dayLabel}`, onclick: () => C.openQuickTask({ dueDate: iso, projectId: ui.project || "", assignee: ui.assignee && (ui.assignee === "owner" || ui.assignee === "none" || C.activeAgents().some((a) => a.id === ui.assignee)) ? ui.assignee : "owner" }) }, "+")));
    }
    const weekdays = ["السبت", "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"];
    const undated = tasks.filter((t) => !t.dueDate).length;
    return panel(null, null, h("div", { class: "co-calendar" },
      h("div", { class: "co-cal-head" },
        h("strong", null, monthName),
        h("div", { class: "co-inline" }, button("الشهر السابق", () => shift(-1), { icon: "chevronRight" }), button("اليوم", () => { ui.month = null; renderBody(); }), button("الشهر التالي", () => shift(1), { icon: "chevronLeft" }))),
      h("div", { class: "co-cal-grid", role: "grid", "aria-label": `تقويم ${monthName}` }, weekdays.map((w) => h("div", { class: "co-weekday", role: "columnheader" }, w)), cells),
      h("p", { class: "ops-dim" }, `المهام المفتوحة حسب تاريخ الاستحقاق بتوقيت القاهرة. ${undated ? `${undated} مهمة بلا موعد تظهر في «القادمة».` : ""}`)));
  }

  function renderAll() { renderHead(); renderBody(); }

  O.registerView({
    id: "work", order: 30, icon: "work", ar: "العمل", subtitle: "مهام الشركة وجداولها في مخزن واحد دائم — للمالك ولفريق الوكلاء.",
    tabs: [["today", "اليوم"], ["board", "اللوحة"], ["calendar", "التقويم"], ["upcoming", "القادمة"], ["project", "حسب المشروع"], ["agent", "حسب الوكيل"], ["done", "المنجزة"], ...(window.AbudInternalHealth?.capabilities?.routines ? [["routines", "الروتين"]] : [])],
    defaultTab: store.read("abud-os-work-tab", "today"),
    onShow(tab) { store.write("abud-os-work-tab", tab); if (tab === "board") ui.boardPositioned = false; C.co.tasks(); C.co.projects(); C.co.catalog(); if (tab === "done") O.api.co("archivedTasks", "/tasks?archived=only", { ttl: 15_000 }); renderAll(); },
    badge() { const today = todayIso(); const n = allTasks().filter((t) => isOpen(t) && t.dueDate && t.dueDate < today).length; return n ? { n, tone: "bad", title: `${n} مهمة متأخرة` } : null; }
  });
  O.setActions("work", () => [button("تحديث", () => C.co.tasks(true), { icon: "refresh" }), button("مهمة مفصّلة", () => C.openQuickTask({ projectId: ui.project || "" }), { kind: "primary", icon: "plus" })]);
  O.on("co:tasks", () => { if (O.state.view === "work") { renderHead(); renderBody(); } });
  O.on("co:projects", () => { if (O.state.view === "work") renderAll(); });
  O.on("co:catalog", () => { if (O.state.view === "work") renderAll(); });
  O.on("co:archivedTasks", () => { if (O.state.view === "work" && O.state.tab === "done") renderBody(); });
})();
