/* ABUD FUN Company OS V2 — المشاريع (Projects Hub). One identity per project (the company store, keyed by GitHub
 * owner/repo when known) shared by tasks, agents, activity, local checkouts and reports. The public Universe views
 * (graph / list / board, worlds, catalog, relations) live in the "عالم المشاريع" tab; local Git state is a read-only scan;
 * checkout links are stored only in the company store (no competing browser-local link table). */
(() => {
  "use strict";
  const O = window.AbudOps;
  const C = window.AbudCompany;
  if (!O || !C) return;
  const { h, fill, fmt, badge, notice, L, label, bdi, icon, panel, panelX, empty, button, linkButton, field, select, kpi, segmented, href, act, mutate, invalidate, toast, todayIso, dateOnly } = O;

  const sOverview = O.section("prjOverview", "projects", "overview");
  const sAll = O.section("coProjects", "projects", "all");
  const sLocal = h("section", { class: "os-section", id: "prjLocal", "data-os-view": "projects", "data-os-tab": "local", "data-os-part": "l-repos" });
  const sReports = h("section", { class: "os-section", id: "prjReports", "data-os-view": "projects", "data-os-tab": "reports", "data-os-part": "r-company" });
  const sDetail = O.section("prjDetail", "projects", "detail");
  const content = document.querySelector(".content");
  content.append(sLocal, sReports);
  // Legacy archive notes inside the reports parts make the provenance of each part explicit.
  document.getElementById("decisions")?.prepend(h("p", { class: "os-archive-note" }, icon("info", 18), "إشارات مُعدّة يدويًا من بيانات GitHub العامة (قرارات منسّقة)، وليست أدلة من المستودعات المحلية."));
  document.getElementById("workboard")?.prepend(h("p", { class: "os-archive-note" }, icon("info", 18), "أرشيف لوحة المتصفح القديمة: السجل والتقرير الأسبوعي محفوظان كما هما، ونُقلت مهامها ومشاريع التركيز وسجلها إلى مخزن الشركة."));
  document.getElementById("daily")?.prepend(h("p", { class: "os-archive-note" }, icon("info", 18), "ملخص النشاط العام على GitHub (آخر Push لكل مستودع عام). نشاط Git ليس دليلًا على جاهزية المنتج."));

  const projects = () => C.data("projects")?.projects || [];
  const workspace = () => O.peek("workspace")?.data;
  const repoIndex = () => new Map((workspace()?.repos || []).map((r) => [r.rel, r]));
  const state = O.store.read("abud-os-projects", null) || {};
  const ui = { status: state.status || "", query: "", priority: "", focusOnly: false, layout: state.layout || "cards", repoFilter: "all", repoQuery: "", detailTab: "overview", reportDays: 7 };
  const persist = () => O.store.write("abud-os-projects", { status: ui.status, layout: ui.layout });

  function gitBadges(repo) {
    if (!repo) return [badge("muted", "غير مفحوص")];
    if (repo.state !== "ready") return [badge("bad", repo.state === "unreadable" ? "تعذرت القراءة" : "خطأ Git")];
    const parts = [];
    if (repo.dirty) parts.push(badge("warn", `${repo.changedFiles} تغيير محلي`));
    if (repo.ahead > 0) parts.push(badge("info", `${repo.ahead} غير مدفوع`));
    if (repo.behind > 0) parts.push(badge("warn", `${repo.behind} خلف الأصل`));
    if (!repo.hasUpstream && repo.remote?.kind !== "none") parts.push(badge("muted", "بلا upstream"));
    if (!parts.length) parts.push(badge("ok", "نظيف"));
    return parts;
  }
  const localSummary = (p) => {
    const repos = repoIndex();
    if (!p.checkouts.length) return h("span", { class: "ops-dim" }, "بلا نسخة محلية");
    const dirty = p.checkouts.filter((c) => repos.get(c.rel)?.dirty).length;
    return h("span", null, icon("branch", 15), `${p.checkouts.length} نسخة محلية`, dirty ? h("span", { class: "co-due co-today" }, ` · ${dirty} بتغييرات`) : null);
  };

  async function toggleFocus(p, trigger) {
    const result = await act(trigger, () => mutate("PATCH", `/projects/${encodeURIComponent(p.id)}`, { focus: !p.focus }), p.focus ? "أُزيل من التركيز" : "أُضيف إلى مشاريع التركيز");
    if (result) invalidate("projects", "summary", "project:");
  }
  const focusButton = (p) => h("button", { type: "button", class: `btn btn-secondary co-btn${p.focus ? " pj-focus-on" : ""}`, "aria-pressed": String(Boolean(p.focus)), title: "مشاريع التركيز (حتى 3)",
    onclick: (e) => toggleFocus(p, e.currentTarget) }, icon("flag", 16), p.focus ? "مشروع تركيز" : "تركيز");

  // ---------------------------------------------------------------- overview
  function renderOverview() {
    const list = projects();
    if (!C.data("projects")) { fill(sOverview, O.resourceStatus(O.peek("co:projects"), "المشاريع") || O.skeleton(4)); return; }
    const ws = workspace();
    const tasks = C.data("tasks")?.tasks || [];
    const today = todayIso();
    const in14 = new Intl.DateTimeFormat("en-CA", { timeZone: O.companyZone() }).format(new Date(Date.now() + 14 * 86_400_000));
    const attention = list.filter((p) => p.status === "blocked" || p.tasks.blocked > 0 || tasks.some((t) => t.projectId === p.id && t.dueDate && t.dueDate < today && !["done", "cancelled"].includes(t.status)));
    const linkedRepos = list.reduce((n, p) => n + p.checkouts.length, 0);
    const deadlines = tasks.filter((t) => t.projectId && t.dueDate && t.dueDate >= today && t.dueDate <= in14 && !["done", "cancelled"].includes(t.status)).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 8);
    fill(sOverview,
      h("div", { class: "os-kpis" },
        kpi({ label: "كل المشاريع", value: list.length, hint: `${list.filter((p) => p.github).length} بهوية GitHub`, href: href("projects", "all"), ic: "projects", tone: "accent" }),
        kpi({ label: "نشطة", value: list.filter((p) => p.status === "active").length, hint: `${list.filter((p) => p.status === "planned").length} مخططة`, ic: "activity" }),
        kpi({ label: "مشاريع التركيز", value: `${list.filter((p) => p.focus).length}/3`, hint: "تظهر أولًا في الرئيسية", ic: "flag" }),
        kpi({ label: "تحتاج انتباهًا", value: attention.length, hint: "متعطّلة أو بها مهام متأخرة/متعطّلة", tone: attention.length ? "warn" : "ok", ic: "alert" }),
        kpi({ label: "نسخ محلية مربوطة", value: linkedRepos, hint: ws?.configured ? `${ws.summary?.dirty ?? 0} مستودع بتغييرات غير محفوظة` : "مجلد GitHub غير مُعدّ", href: href("projects", "local"), ic: "branch" })),
      h("div", { class: "co-columns" },
        panelX({ title: "تحتاج انتباهًا", hint: "مشاريع متعطّلة أو لديها مهام متعطّلة/متأخرة." },
          attention.length ? h("ul", { class: "hq-attention" }, attention.slice(0, 8).map((p) => h("li", { class: p.status === "blocked" ? "hq-sev-critical" : "hq-sev-warning" },
            h("span", { class: "hq-att-icon" }, icon("projects", 20)),
            h("div", null, h("strong", null, p.name), h("small", null, p.status === "blocked" ? `متعطّل: ${p.blocker || "—"}` : `${p.tasks.blocked} متعطّلة · ${p.tasks.open} مفتوحة`)),
            h("a", { class: "ops-link", href: href("projects", "p", p.id) }, "فتح")))) : h("div", { class: "co-empty" }, icon("check", 26), h("p", null, "لا مشاريع متعطّلة أو متأخرة."))),
        panelX({ title: "مواعيد خلال 14 يومًا", hint: "مهام المشاريع المفتوحة حسب تاريخ الاستحقاق." },
          deadlines.length ? C.taskList(deadlines, { compact: true }) : empty("لا مواعيد قريبة على مهام المشاريع."))),
      h("div", { class: "co-columns" },
        panelX({ title: "حُدّثت مؤخرًا", hint: "آخر تعديل في سجل الشركة (ليس آخر Commit).", actions: linkButton("كل المشاريع", href("projects", "all"), { icon: "chevronLeft" }) },
          h("ul", { class: "hq-team" }, [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6).map((p) => h("li", null, h("a", { href: href("projects", "p", p.id) },
            h("span", { class: "sy-card-icon" }, icon("projects", 18)), h("span", null, h("strong", null, p.name), h("small", null, fmt.relative(p.updatedAt))), label("projectStatus", p.status)))))),
        panelX({ title: "صحة المستودعات المحلية", hint: "فحص Git محلي للقراءة فقط؛ لا يعني جاهزية المنتج.", actions: linkButton("المشاريع المحلية", href("projects", "local"), { icon: "chevronLeft" }) },
          ws?.configured ? h("div", { class: "ops-tiles" },
            h("div", { class: "ops-tile" }, h("span", null, "مستودعات"), h("strong", null, String(ws.summary.repos))),
            h("div", { class: "ops-tile" }, h("span", null, "بتغييرات محلية"), h("strong", null, String(ws.summary.dirty))),
            h("div", { class: "ops-tile" }, h("span", null, "خلف الأصل"), h("strong", null, String(ws.summary.behind))),
            h("div", { class: "ops-tile" }, h("span", null, "بلا Remote"), h("strong", null, String(ws.summary.noRemote))))
            : ws ? notice("warn", "مجلد GitHub غير مُعدّ", "حدّد مجلد مستودعاتك في local/workspace.json لإظهار حالة Git المحلية.") : O.skeleton(2))));
  }

  // ---------------------------------------------------------------- all projects
  function filtered() {
    const q = ui.query.trim().toLowerCase();
    return projects().filter((p) => (!ui.status || p.status === ui.status) && (!ui.priority || p.priority === ui.priority) && (!ui.focusOnly || p.focus)
      && (!q || `${p.name} ${p.github || ""} ${p.summary || ""}`.toLowerCase().includes(q)));
  }
  let allHost = null;
  function renderAll() {
    const list = projects();
    if (!C.data("projects")) { fill(sAll, O.resourceStatus(O.peek("co:projects"), "المشاريع") || O.skeleton(4)); return; }
    const counts = Object.fromEntries(Object.keys(L.projectStatus).map((s) => [s, list.filter((p) => p.status === s).length]));
    const search = h("input", { class: "ops-input pj-search", type: "search", placeholder: "ابحث بالاسم أو المستودع…", "aria-label": "بحث في المشاريع", value: ui.query, oninput: (e) => { ui.query = e.target.value; renderAllBody(); } });
    allHost = h("div", { class: "ops-body" });
    fill(sAll,
      h("div", { class: "pj-toolbar" },
        h("div", { class: "pj-filters" },
          segmented([["", `الكل (${list.length})`], ...Object.entries(L.projectStatus).filter(([s]) => counts[s]).map(([s, t]) => [s, `${t} (${counts[s]})`])], ui.status, (v) => { ui.status = v; persist(); renderAll(); }, "تصفية بالحالة")),
        h("div", { class: "pj-filters" }, search,
          select("fprio", [["", "كل الأولويات"], ...Object.entries(L.priority)], ui.priority, { "aria-label": "تصفية بالأولوية", onchange: (e) => { ui.priority = e.target.value; renderAllBody(); } }),
          h("label", { class: "co-inline-check" }, h("input", { type: "checkbox", checked: ui.focusOnly ? true : null, onchange: (e) => { ui.focusOnly = e.target.checked; renderAllBody(); } }), "التركيز فقط"),
          segmented([["cards", "بطاقات"], ["table", "جدول"]], ui.layout, (v) => { ui.layout = v; persist(); renderAll(); }, "طريقة العرض"))),
      allHost);
    renderAllBody();
  }
  function projectCard(p) {
    return h("article", { class: `pj-card${p.focus ? " pj-card-focus" : ""}`, "data-project": p.id },
      h("div", { class: "pj-card-head" },
        h("div", { style: "min-inline-size:0" }, h("h3", null, h("a", { href: href("projects", "p", p.id) }, p.name)), h("p", { class: "pj-sub" }, p.github ? bdi(p.github, "co-tech-soft") : "بدون هوية GitHub")),
        h("div", { class: "ops-card-badges" }, label("projectStatus", p.status), label("priority", p.priority))),
      p.summary ? h("p", { class: "pj-summary" }, p.summary) : null,
      p.status === "blocked" && p.blocker ? h("span", { class: "co-blocker" }, icon("alert", 14), p.blocker) : null,
      h("div", { class: "pj-facts" },
        h("span", null, icon("work", 15), `${p.tasks.open} مفتوحة`), p.tasks.blocked ? h("span", { class: "ops-bad-text" }, `${p.tasks.blocked} متعطّلة`) : null,
        localSummary(p)),
      h("div", { class: "pj-card-foot" },
        h("span", { class: "co-avatars", "aria-label": p.agents.length ? `الوكلاء: ${p.agents.join("، ")}` : "لا وكلاء مسندين" }, p.agents.length ? p.agents.map((a) => C.avatar(a)) : h("span", { class: "ops-dim" }, "لا وكلاء")),
        h("span", { class: "ops-dim" }, `حُدّث ${fmt.relative(p.updatedAt)}`),
        focusButton(p)));
  }
  function renderAllBody() {
    if (!allHost) return;
    const shown = filtered();
    if (!shown.length) { fill(allHost, empty(projects().length ? "لا مشاريع تطابق التصفية." : "لا مشاريع بعد. زامن من GitHub والمجلدات أو أنشئ مشروعًا.", button("مشروع جديد", () => C.openNewProject(), { kind: "primary", icon: "plus" }))); return; }
    if (ui.layout === "table") {
      fill(allHost, h("div", { class: "ops-tablewrap", tabindex: "0", role: "region", "aria-label": "جدول المشاريع" }, h("table", { class: "ops-table co-projects-table" },
        h("thead", null, h("tr", null, ["المشروع", "الحالة", "الأولوية", "المهام", "النسخ المحلية", "الوكلاء", "آخر تحديث"].map((x) => h("th", { scope: "col" }, x)))),
        h("tbody", null, shown.map((p) => h("tr", { "data-project": p.id },
          h("th", { scope: "row" }, h("a", { class: "co-task-title", href: href("projects", "p", p.id) }, p.focus ? "★ " : "", p.name), p.github ? h("div", null, bdi(p.github, "co-tech-soft")) : null),
          h("td", null, label("projectStatus", p.status)), h("td", null, label("priority", p.priority)),
          h("td", null, `${p.tasks.open} مفتوحة`, p.tasks.blocked ? h("div", { class: "ops-bad-text" }, `${p.tasks.blocked} متعطّلة`) : null),
          h("td", null, localSummary(p)), h("td", null, h("span", { class: "co-avatars" }, p.agents.map((a) => C.avatar(a)))),
          h("td", { class: "ops-dim" }, fmt.relative(p.updatedAt))))))));
    } else fill(allHost, h("div", { class: "pj-grid" }, shown.map(projectCard)), h("p", { class: "ops-dim" }, `${shown.length} من ${projects().length} مشروعًا. حالة المشروع يحددها المالك؛ وجود Commits حديثة لا يعني اكتمال المنتج.`));
  }

  // ---------------------------------------------------------------- local repository manager
  function repoRows() {
    const ws = workspace();
    if (!ws?.configured) return [];
    const byRel = new Map();
    for (const p of projects()) for (const c of p.checkouts) byRel.set(c.rel, { project: p, link: c.link });
    const rows = (ws.repos || []).map((r) => {
      const linked = byRel.get(r.rel);
      const reason = linked ? null : r.state !== "ready" ? "unreadable" : r.remote?.kind === "none" ? "no-remote" : r.remote?.github ? "github-unlinked" : "other-remote";
      return { kind: "repo", rel: r.rel, name: r.name, repo: r, linked, reason, duplicate: Boolean(linked && linked.project.checkouts.length > 1) };
    });
    for (const f of ws.folders || []) rows.push({ kind: "folder", rel: f.rel, name: f.name, repo: null, linked: null, reason: "folder", duplicate: false });
    return rows;
  }
  const REASON = { "no-remote": ["warn", "بلا Remote"], "other-remote": ["warn", "Remote غير GitHub"], "github-unlinked": ["info", "GitHub غير مربوط"], unreadable: ["bad", "تعذرت القراءة"], folder: ["muted", "مجلد بلا Git"] };
  const REPO_FILTERS = [["all", "الكل"], ["linked", "مربوط"], ["unlinked", "غير مربوط"], ["dirty", "تغييرات محلية"], ["duplicates", "مكرر"], ["folders", "مجلدات"]];
  const inFilter = (row, f) => ({ all: row.kind === "repo", linked: Boolean(row.linked), unlinked: row.kind === "repo" && !row.linked, dirty: Boolean(row.repo?.dirty), duplicates: row.duplicate, folders: row.kind === "folder" }[f]);
  let localHost = null;
  function renderLocal() {
    const ws = workspace();
    if (!ws) { fill(sLocal, O.resourceStatus(O.peek("workspace"), "المستودعات المحلية") || O.skeleton(4)); return; }
    if (!ws.configured) { fill(sLocal, notice("warn", "مجلد GitHub غير مُعدّ", "حدّد مجلد مستودعاتك في local/workspace.json لإظهار حالة Git المحلية.")); return; }
    const rows = repoRows();
    const repos = rows.filter((r) => r.kind === "repo");
    localHost = h("div", { class: "pj-repo" });
    fill(sLocal,
      h("div", { class: "os-kpis" },
        kpi({ label: "مستودعات مكتشفة", value: repos.length, hint: `${ws.summary.fromCache ?? 0} من الذاكرة المؤقتة`, ic: "branch" }),
        kpi({ label: "مربوطة بمشروع", value: repos.filter((r) => r.linked).length, ic: "link", tone: "ok" }),
        kpi({ label: "غير مربوطة", value: repos.filter((r) => !r.linked).length, ic: "info", tone: repos.some((r) => !r.linked) ? "warn" : null }),
        kpi({ label: "بتغييرات محلية", value: ws.summary.dirty, ic: "alert" }),
        kpi({ label: "نسخ مكررة", value: repos.filter((r) => r.duplicate).length, hint: "نفس المشروع في أكثر من مجلد", ic: "projects" })),
      h("div", { class: "pj-toolbar" },
        segmented(REPO_FILTERS.map(([id, t]) => [id, `${t} (${rows.filter((r) => inFilter(r, id)).length})`]), ui.repoFilter, (v) => { ui.repoFilter = v; renderLocal(); }, "تصفية المستودعات"),
        h("div", { class: "pj-filters" },
          h("input", { class: "ops-input pj-search", type: "search", placeholder: "ابحث في المستودعات…", "aria-label": "بحث في المستودعات", value: ui.repoQuery, oninput: (e) => { ui.repoQuery = e.target.value; renderLocalBody(); } }),
          button("فحص الكل الآن", () => O.api.workspace(true, "all"), { icon: "refresh" }),
          button("مزامنة المشاريع", (e) => syncProjects(e.currentTarget), { icon: "projects" }))),
      localHost,
      h("p", { class: "ops-dim" }, "الربط اليدوي يُحفظ في مخزن الشركة فقط. حالة Git من فحص محلي للقراءة فقط وبحسب آخر fetch؛ لا نجري fetch ولا نكتب إلى المستودعات. المسارات الكاملة لا تُرسل للمتصفح."));
    renderLocalBody();
  }
  function renderLocalBody() {
    if (!localHost) return;
    const q = ui.repoQuery.trim().toLowerCase();
    const rows = repoRows().filter((r) => inFilter(r, ui.repoFilter) && (!q || `${r.rel} ${r.repo?.remote?.github || ""} ${r.linked?.project.name || ""}`.toLowerCase().includes(q)));
    if (!rows.length) { fill(localHost, empty("لا مستودعات تطابق التصفية.")); return; }
    fill(localHost, rows.slice(0, 200).map(repoRow));
  }
  function repoRow(row) {
    const r = row.repo;
    const linkSel = select("link", [["", "اختر مشروعًا للربط…"], ...C.projectOptions(false)], "", { "aria-label": `ربط ${row.rel} بمشروع`, class: "ops-input co-compact" });
    return h("div", { class: "pj-repo-row", "data-rel": row.rel },
      h("div", { class: "pj-repo-name" }, icon(row.kind === "folder" ? "projects" : "branch", 18), h("strong", null, bdi(row.rel)),
        r?.branch ? bdi(r.detached ? "(detached)" : r.branch, "co-tech-soft") : null,
        row.linked ? h("a", { class: "ops-chip", href: href("projects", "p", row.linked.project.id) }, row.linked.project.name) : null),
      h("div", { class: "pj-repo-state" },
        row.linked ? (row.linked.link === "manual" ? badge("accent", "ربط يدوي") : badge("ok", "مربوط بهوية Remote")) : badge(...REASON[row.reason]),
        row.duplicate ? badge("warn", "نسخة مكررة") : null,
        row.kind === "repo" ? gitBadges(r) : null),
      h("details", { class: "pj-repo-more" }, h("summary", { class: "ops-link" }, "التفاصيل والإجراءات"),
        h("div", { class: "pj-repo-body" },
          r ? h("dl", { class: "ops-dl" },
            r.remote?.github ? h("div", { class: "ops-row" }, h("dt", null, "GitHub"), h("dd", null, bdi(r.remote.github))) : null,
            h("div", { class: "ops-row" }, h("dt", null, "الفرع"), h("dd", null, bdi(r.branch || "—"), r.head ? [" · ", bdi(r.head, "co-tech-soft")] : null, r.hasUpstream ? ` · ↑${r.ahead ?? 0} ↓${r.behind ?? 0}` : " · بلا upstream")),
            r.lastCommit ? h("div", { class: "ops-row" }, h("dt", null, "آخر Commit"), h("dd", null, bdi(r.lastCommit.subject || "—", "co-tech-soft"), h("div", { class: "ops-dim" }, `${fmt.when(r.lastCommit.date)} · `, bdi(r.lastCommit.sha, "co-tech-soft")))) : null,
            [...(r.languages || []), ...(r.frameworks || [])].length ? h("div", { class: "ops-row" }, h("dt", null, "التقنيات"), h("dd", null, h("div", { class: "ops-chips" }, [...(r.languages || []), ...(r.frameworks || [])].slice(0, 8).map((t) => h("span", { class: "ops-chip" }, t))))) : null,
            r.statusDoc?.present ? h("div", { class: "ops-row" }, h("dt", null, "STATUS.md"), h("dd", null, r.statusDoc.state ? bdi(r.statusDoc.state, "co-tech-soft") : "موجود", r.statusDoc.updated ? h("span", { class: "ops-dim" }, ` · ${r.statusDoc.updated}`) : null)) : null,
            r.refreshedAt ? h("div", { class: "ops-row" }, h("dt", null, "آخر فحص"), h("dd", null, fmt.when(r.refreshedAt))) : null) : h("p", { class: "ops-dim" }, "مجلد بلا Git؛ لا يُقرأ محتواه."),
          h("div", { class: "pj-repo-actions" },
            row.kind === "repo" && !row.linked ? [linkSel, button("ربط", async (e) => { if (!linkSel.value) { linkSel.focus(); return; } if (await act(e.currentTarget, () => mutate("POST", "/checkouts/link", { rel: row.rel, projectId: linkSel.value }), "تم الربط اليدوي")) invalidate("projects", "activity"); }, { kind: "primary", icon: "link" })] : null,
            row.linked ? button("فك الربط", async (e) => { if (!(await O.confirmDialog({ title: "فك ربط النسخة المحلية؟", body: `سيُفك ربط ${row.rel} عن «${row.linked.project.name}». لا يُحذف أي ملف.`, confirm: "فك الربط" }))) return; if (await act(e.currentTarget, () => mutate("POST", "/checkouts/link", { rel: row.rel, projectId: null }), "فُك الربط")) invalidate("projects", "activity"); }) : null,
            row.kind === "repo" ? button("إعادة الفحص", () => O.api.workspace(true, row.rel), { icon: "refresh" }) : null,
            r?.remote?.github ? h("a", { class: "btn btn-secondary co-btn", href: `https://github.com/${r.remote.github.split("/").map(encodeURIComponent).join("/")}`, target: "_blank", rel: "noopener noreferrer" }, icon("external", 16), "GitHub") : null))));
  }
  async function syncProjects(trigger) {
    const r = await act(trigger, () => mutate("POST", "/projects/sync", {}), null);
    if (r) { toast(`المزامنة: ${r.created} مشروع جديد، ${r.linked} نسخة مربوطة${r.duplicates?.length ? `، ${r.duplicates.length} مكرر` : ""}`); invalidate("projects", "summary", "activity"); O.api.workspace(true); }
  }

  // ---------------------------------------------------------------- reports (company evidence, generated from the store)
  function renderReports() {
    const tasks = C.data("tasks")?.tasks;
    const runs = O.peek("co:runsAll")?.data?.runs;
    const events = C.data("activity")?.events;
    if (!tasks || !runs || !events) { fill(sReports, O.skeleton(4)); return; }
    const since = new Date(Date.now() - ui.reportDays * 86_400_000).toISOString();
    const done = tasks.filter((t) => t.status === "done" && t.completedAt && t.completedAt >= since);
    const created = tasks.filter((t) => t.createdAt >= since);
    const periodRuns = runs.filter((r) => r.createdAt >= since && !r.parentRunId);
    const byProject = new Map();
    for (const t of done) { if (!t.projectId) continue; byProject.set(t.projectId, [...(byProject.get(t.projectId) || []), t]); }
    const decisions = events.filter((e) => e.at >= since && /^(journal\.note|project\.updated|approval\.|memory\.)/.test(e.action));
    const markdown = () => [
      `# تقرير تنفيذ ABUD FUN — آخر ${ui.reportDays} أيام`, "", `أُنشئ: ${fmt.when(new Date().toISOString())} (توقيت الشركة). المصدر: مخزن الشركة المحلي (أدلة مسجلة، لا استنتاجات).`, "",
      `- مهام منجزة: ${done.length}`, `- مهام جديدة: ${created.length}`, `- تشغيلات وكلاء: ${periodRuns.length} (${periodRuns.filter((r) => r.status === "succeeded").length} ناجحة)`, "",
      "## المنجز حسب المشروع", ...[...byProject].map(([pid, list]) => `### ${C.projectName(pid) || pid}\n${list.map((t) => `- ${t.title}`).join("\n")}`), "",
      "## قرارات وتغييرات مسجلة", ...decisions.slice(0, 40).map((e) => `- ${fmt.when(e.at)} — ${C.isoText(e.summary)}`)
    ].join("\n");
    fill(sReports,
      h("div", { class: "pj-toolbar" },
        segmented([["7", "7 أيام"], ["30", "30 يومًا"]], String(ui.reportDays), (v) => { ui.reportDays = Number(v); renderReports(); }, "فترة التقرير"),
        h("div", { class: "pj-filters" }, h("span", { class: "pj-evidence" }, icon("database", 16), "أدلة من مخزن الشركة"),
          button("تصدير Markdown", () => {
            const url = URL.createObjectURL(new Blob([markdown()], { type: "text/markdown;charset=utf-8" }));
            const a = h("a", { href: url, download: `abud-report-${todayIso()}.md` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
          }, { icon: "download" }))),
      h("div", { class: "os-kpis" },
        kpi({ label: "مهام منجزة", value: done.length, ic: "check", tone: "ok" }), kpi({ label: "مهام جديدة", value: created.length, ic: "plus" }),
        kpi({ label: "تشغيلات الوكلاء", value: periodRuns.length, hint: `${periodRuns.filter((r) => r.status === "succeeded").length} ناجحة · ${periodRuns.filter((r) => r.status === "failed").length} فاشلة`, ic: "agents" }),
        kpi({ label: "قرارات وتغييرات", value: decisions.length, ic: "flag" })),
      h("div", { class: "co-columns" },
        panelX({ title: "المنجز حسب المشروع", hint: "مهام مُعلَّمة «منجز» خلال الفترة." },
          byProject.size ? h("div", { class: "co-stack" }, [...byProject].map(([pid, list]) => h("div", null, h("h4", null, h("a", { class: "ops-link", href: href("projects", "p", pid) }, C.projectName(pid) || pid), ` · ${list.length}`), C.taskList(list, { compact: true, showProject: false }))))
            : empty("لا مهام منجزة مرتبطة بمشاريع في هذه الفترة.")),
        panelX({ title: "قرارات وتغييرات مسجلة", hint: "من سجل التدقيق: تغييرات المشاريع، الموافقات، الذاكرة، وسجل المتصفح المرحّل." },
          decisions.length ? C.activityList(decisions.slice(0, 15)) : empty("لا قرارات مسجلة في هذه الفترة."))));
  }

  // ---------------------------------------------------------------- project detail page
  const DETAIL_TABS = [["overview", "نظرة عامة"], ["tasks", "المهام"], ["repo", "المستودع"], ["agents", "الوكلاء والتشغيلات"], ["notes", "الملاحظات والقرارات"], ["activity", "النشاط"]];
  const detailKey = (id) => `project:${id}`;
  const githubKey = (id) => `github:${id}`;
  const loadDetail = (id, force) => O.api.co(detailKey(id), `/projects/${encodeURIComponent(id)}`, { force, ttl: 10_000 });
  let detailId = null;
  const watched = new Set(); // detail resources are keyed per project
  function renderDetail() {
    if (!detailId) return;
    const res = O.peek(`co:${detailKey(detailId)}`);
    const p = res?.data;
    if (!p) {
      O.setHead("projects", { tab: "detail", title: "المشروع", back: [href("projects", "all"), "كل المشاريع"], hideTabs: true });
      fill(sDetail, res?.state === "error" ? notice("bad", "تعذر تحميل المشروع", res.error) : O.skeleton(5));
      return;
    }
    O.setHead("projects", { tab: "detail", title: p.name, subtitle: p.github ? `GitHub: ${p.github}` : (p.summary || "مشروع بدون هوية GitHub"), back: [href("projects", "all"), "كل المشاريع"], hideTabs: true });
    const tab = DETAIL_TABS.some(([t]) => t === ui.detailTab) ? ui.detailTab : "overview";
    const save = async (patch, msg = "حُفظ المشروع", trigger = null) => { if (await act(trigger, () => mutate("PATCH", `/projects/${encodeURIComponent(p.id)}`, patch), msg)) { invalidate("projects", "summary", "activity", detailKey(p.id)); } };
    const open = p.tasks.filter((t) => !["done", "cancelled"].includes(t.status));
    fill(sDetail,
      h("div", { class: "ops-card-badges" }, label("projectStatus", p.status), label("priority", p.priority), p.focus ? badge("accent", "مشروع تركيز") : null, p.source ? badge("muted", { catalog: "من الكتالوج العام", workspace: "من مجلدات GitHub", manual: "يدوي", import: "مستورد" }[p.source] || p.source) : null),
      h("nav", { class: "os-tabs", "aria-label": "أقسام المشروع" }, DETAIL_TABS.map(([id, text]) => h("a", { class: `os-tab${id === tab ? " os-tab-current" : ""}`, href: href("projects", "p", p.id, id), "aria-current": id === tab ? "page" : null }, text))),
      detailBody(tab, p, save, open));
  }
  function detailBody(tab, p, save, open) {
    const repos = repoIndex();
    const remotePanel = () => {
      if (!p.github) return panel("GitHub", "بيانات منفصلة عن حالة الشركة وGit المحلي.", empty("لا هوية GitHub مرتبطة بهذا المشروع."));
      const remote = O.peek(`co:${githubKey(p.id)}`);
      const g = remote?.data;
      if (!g) return panel("GitHub البعيد", "قراءة عبر GitHub CLI بحساب المالك.", remote?.state === "error" ? notice("warn", "تعذرت قراءة GitHub", remote.error) : O.skeleton(2));
      if (g.state === "disconnected") return panel("GitHub البعيد", "قراءة فقط.", notice("warn", "GitHub غير متصل", "ثبّت GitHub CLI ثم نفّذ gh auth login من حساب Windows."));
      if (g.state !== "connected" && g.state !== "partial") return panel("GitHub البعيد", "قراءة فقط.", notice("warn", "بيانات GitHub غير متاحة", g.state === "not-found" ? "المستودع غير موجود أو غير متاح للحساب الحالي." : "تحقق من اتصال GitHub CLI."));
      const base = `https://github.com/${p.github.split("/").map(encodeURIComponent).join("/")}`;
      const items = (title, values, link) => h("div", { class: "ops-row" }, h("dt", null, title), h("dd", null, values.length ? h("ul", { class: "ops-list" }, values.slice(0, 5).map((x) => h("li", null, link(x)))) : "لا توجد عناصر مفتوحة أو حديثة"));
      return panel("GitHub البعيد", `قراءة فقط · آخر جلب ${fmt.when(g.fetchedAt)}${g.cached ? " · من الذاكرة المؤقتة" : ""}. حالة الشركة يحددها المالك.`,
        g.state === "partial" ? notice("warn", "بعض بيانات GitHub غير متاحة", g.unavailable.join("، ")) : null,
        h("dl", { class: "ops-dl" },
          h("div", { class: "ops-row" }, h("dt", null, "المستودع"), h("dd", null, h("a", { href: base, target: "_blank", rel: "noopener noreferrer" }, bdi(p.github)), ` · ${g.repository.private ? "خاص" : "عام"} · الفرع الافتراضي ${g.repository.default_branch || "—"}`)),
          items("Issues مفتوحة", g.issues, (x) => h("a", { href: `${base}/issues/${x.number}`, target: "_blank", rel: "noopener noreferrer" }, `#${x.number} ${x.title}`)),
          items("Pull requests مفتوحة", g.pullRequests, (x) => h("a", { href: `${base}/pull/${x.number}`, target: "_blank", rel: "noopener noreferrer" }, `#${x.number} ${x.title}${x.draft ? " (Draft)" : ""}`)),
          items("Actions حديثة", g.workflows, (x) => h("a", { href: `${base}/actions/runs/${x.id}`, target: "_blank", rel: "noopener noreferrer" }, `${x.name || "Workflow"}: ${x.conclusion || x.status || "—"}`)),
          items("إصدارات", g.releases, (x) => h("a", { href: `${base}/releases/tag/${encodeURIComponent(x.tag_name || "")}`, target: "_blank", rel: "noopener noreferrer" }, x.name || x.tag_name || "إصدار")),
          items("Commits حديثة", g.commits, (x) => h("a", { href: `${base}/commit/${encodeURIComponent(x.sha || "")}`, target: "_blank", rel: "noopener noreferrer" }, `${x.sha || "—"} ${x.message || ""}`)),
          h("div", { class: "ops-row" }, h("dt", null, "فروع بعيدة"), h("dd", null, g.branches.map((x) => x.name).join("، ") || "—"))));
    };
    if (tab === "overview") {
      const statusSel = select("status", Object.entries(L.projectStatus), p.status, { "aria-label": "حالة المشروع" });
      const prioSel = select("priority", Object.entries(L.priority), p.priority, { "aria-label": "أولوية المشروع" });
      const blocker = h("input", { class: "ops-input", name: "blocker", value: p.blocker || "", maxlength: 300, placeholder: "مطلوب عند التعطّل", "aria-label": "العائق" });
      const msTitle = h("input", { class: "ops-input co-grow", placeholder: "مرحلة جديدة…", maxlength: 160, "aria-label": "عنوان المرحلة" });
      const msDateField = O.dateInput("milestoneDate", "", "تاريخ المرحلة");
      const msDate = msDateField.querySelector("input");
      return h("div", { class: "pj-detail-grid" },
        h("div", { class: "hq-col" },
          h("div", { class: "os-kpis" },
            kpi({ label: "مهام مفتوحة", value: open.length, ic: "work" }), kpi({ label: "متعطّلة", value: p.tasks.filter((t) => t.status === "blocked").length, ic: "alert", tone: p.tasks.some((t) => t.status === "blocked") ? "bad" : null }),
            kpi({ label: "منجزة", value: p.tasks.filter((t) => t.status === "done").length, ic: "check", tone: "ok" }), kpi({ label: "المراحل المفتوحة", value: p.milestones.filter((m) => m.status !== "done").length, ic: "flag" })),
          panelX({ title: "المهام التالية", actions: linkButton("كل المهام", href("projects", "p", p.id, "tasks"), { icon: "chevronLeft" }) },
            C.taskList(open.slice(0, 6), { showProject: false }) || empty("لا مهام مفتوحة لهذا المشروع.", button("مهمة جديدة", () => C.openQuickTask({ projectId: p.id }), { kind: "primary", icon: "plus" }))),
          panel("المراحل", "معالم المشروع بمواعيدها.",
            p.milestones.length ? h("ul", { class: "co-tasks" }, p.milestones.map((m) => h("li", { class: `co-task${m.status === "done" ? " co-task-done" : ""}` },
              h("button", { type: "button", class: `co-check${m.status === "done" ? " co-checked" : ""}`, "aria-pressed": String(m.status === "done"), "aria-label": `تبديل حالة المرحلة: ${m.title}`, onclick: async () => { if (await act(null, () => mutate("PATCH", `/milestones/${m.id}`, { status: m.status === "done" ? "open" : "done" }), null)) loadDetail(p.id, true); } }, m.status === "done" ? icon("check", 16) : null),
              h("div", { class: "co-task-main" }, h("span", { class: "co-task-title" }, m.title)), m.dueDate ? h("span", { class: "co-due" }, icon("calendar", 14), dateOnly(m.dueDate)) : h("span"))))
              : empty("لا مراحل بعد."),
            h("div", { class: "co-inline" }, msTitle, msDateField, button("إضافة مرحلة", async (e) => { if (!msTitle.value.trim()) { msTitle.focus(); return; } if (await act(e.currentTarget, () => mutate("POST", `/projects/${encodeURIComponent(p.id)}/milestones`, { title: msTitle.value, dueDate: msDate.value || null }), "أُضيفت المرحلة")) loadDetail(p.id, true); }, { icon: "plus" })))),
        h("div", { class: "hq-col" },
          O.serversProjectPanel?.(p),
          panel("الحالة التشغيلية", "يحددها المالك؛ لا تُستنتج من نشاط Git.",
            h("div", { class: "co-form-grid" }, h("div", { class: "co-form-row" }, field("الحالة", statusSel), field("الأولوية", prioSel)), field("العائق", blocker),
              h("div", { class: "co-form-actions" }, button("حفظ الحالة", (e) => save({ status: statusSel.value, priority: prioSel.value, blocker: blocker.value || null }, "حُفظت الحالة", e.currentTarget), { kind: "primary" })))),
          panel("المستودع المحلي", null, p.checkouts.length ? h("ul", { class: "ops-list" }, p.checkouts.map((c) => h("li", null, bdi(c.rel), ...gitBadges(repos.get(c.rel))))) : empty("لا نسخة محلية مربوطة."), linkButton("إدارة المستودع", href("projects", "p", p.id, "repo"), { icon: "branch" })),
          panel("الوكلاء المسندون", null, p.agents.length ? h("div", { class: "co-inline" }, p.agents.map((a) => h("a", { class: "ops-chip", href: href("agents", a) }, C.avatar(a), C.assigneeName(a)))) : empty("لا وكلاء مسندين."), linkButton("تعديل الإسناد", href("projects", "p", p.id, "agents"), { icon: "agents" }))));
    }
    if (tab === "tasks") {
      return [panel("مهمة جديدة لهذا المشروع", null, C.stableQuickAdd(`project:${p.id}`, { projectId: p.id })),
        panel(`المهام المفتوحة (${open.length})`, null, C.taskList(open, { showProject: false }) || empty("لا مهام مفتوحة.")),
        panel("المنجزة والملغاة", null, C.taskList(p.tasks.filter((t) => ["done", "cancelled"].includes(t.status)).slice(0, 40), { compact: true, showProject: false }) || empty("لا مهام منجزة بعد."))];
    }
    if (tab === "repo") {
      const unlinked = repoRows().filter((r) => r.kind === "repo" && !r.linked);
      const sel = select("rel", [["", "اختر نسخة محلية غير مربوطة…"], ...unlinked.map((r) => [r.rel, r.rel])], "", { "aria-label": "نسخة محلية للربط" });
      return [remotePanel(), panel("النسخ المحلية المربوطة", "حالة Git من فحص محلي للقراءة فقط. «آخر فحص» هو وقت آخر قراءة.",
        p.checkouts.length ? h("div", { class: "pj-repo" }, p.checkouts.map((c) => { const r = repos.get(c.rel); return repoRow({ kind: "repo", rel: c.rel, name: c.rel, repo: r, linked: { project: p, link: c.link }, reason: null, duplicate: p.checkouts.length > 1 }); }))
          : empty("لا نسخة محلية مربوطة بهذا المشروع.")),
      panel("ربط نسخة محلية", "اربط يدويًا فقط عند التأكد. الربط بهوية Remote يتم تلقائيًا عند المزامنة.", h("div", { class: "co-inline" }, sel,
        button("ربط بهذا المشروع", async (e) => { if (!sel.value) { sel.focus(); return; } if (await act(e.currentTarget, () => mutate("POST", "/checkouts/link", { rel: sel.value, projectId: p.id }), "تم الربط")) invalidate("projects", detailKey(p.id)); }, { kind: "primary", icon: "link" })))];
    }
    if (tab === "agents") {
      return [panel("الوكلاء المسندون", "يحدد من يعمل على هذا المشروع؛ لا يمنح صلاحيات إضافية.", h("div", { class: "co-agent-toggles" }, C.agentsDef().map((a) => {
        const on = p.agents.includes(a.id);
        return h("button", { type: "button", class: `co-agent-toggle${on ? " co-on" : ""}`, style: `--agent:${a.color}`, "aria-pressed": String(on), onclick: (e) => save({ agents: on ? p.agents.filter((x) => x !== a.id) : [...p.agents, a.id] }, on ? `أُزيل ${a.name}` : `أُسند ${a.name}`, e.currentTarget) }, C.avatar(a.id, "md"), h("strong", null, bdi(a.name)), h("small", null, a.titleAr));
      }))),
      panel("تشغيلات الوكلاء على المشروع", "الأحدث أولًا؛ النتيجة الكاملة في مساحة الوكيل.", p.runs.length ? h("ul", { class: "co-history" }, p.runs.map((r) => h("li", null, h("time", null, fmt.when(r.createdAt)), C.avatar(r.agentId), label("runStatus", r.status), h("span", null, r.request.slice(0, 90)), h("a", { class: "ops-link", href: href("agents", r.agentId, "runs") }, "النتيجة")))) : empty("لا تشغيلات بعد."))];
    }
    if (tab === "notes") {
      const summary = h("textarea", { class: "ops-input", rows: 3, maxlength: 600, "aria-label": "وصف المشروع" }, p.summary || "");
      const notes = h("textarea", { class: "ops-input", rows: 6, maxlength: 4000, "aria-label": "ملاحظات المشروع" }, p.notes || "");
      const decTitle = h("input", { class: "ops-input", maxlength: 120, placeholder: "عنوان القرار", "aria-label": "عنوان القرار" });
      const decBody = h("textarea", { class: "ops-input", rows: 3, maxlength: 2000, placeholder: "ما الذي تقرر ولماذا؟ (لا أسرار)", "aria-label": "نص القرار" });
      return [panel("الوصف والملاحظات", "الملاحظات المرحّلة من لوحة المتصفح تظهر هنا.", field("الوصف", summary), field("ملاحظات", notes), button("حفظ النصوص", (e) => save({ summary: summary.value || null, notes: notes.value || null }, "حُفظت النصوص", e.currentTarget), { kind: "primary" })),
        panel("تسجيل قرار", "يُحفظ في ذاكرة المشروع كقرار معتمد ويُستخدم سياقًا للوكلاء.", field("العنوان", decTitle), field("القرار", decBody),
          button("حفظ القرار", async (e) => { if (!decTitle.value.trim() || !decBody.value.trim()) { toast("أدخل العنوان والنص", "bad"); return; } if (await act(e.currentTarget, () => mutate("POST", "/memory", { scope: "project", scopeRef: p.id, title: decTitle.value, body: decBody.value, approved: true }), "حُفظ القرار")) loadDetail(p.id, true); }, { icon: "flag" })),
        panel("ذاكرة المشروع والقرارات", "ما أنشأه وكيل يبقى «بانتظار المراجعة» حتى تعتمده. المعتمد فقط يُرسل للنماذج.", p.memory.length ? h("ul", { class: "co-memory" }, p.memory.map((m) => h("li", null,
          h("div", { class: "co-inline" }, h("strong", null, m.title), m.approved ? badge("ok", "معتمدة") : badge("warn", "بانتظار المراجعة"), h("small", { class: "ops-dim" }, `${m.source} · ${fmt.when(m.updatedAt)}`)),
          h("p", { class: "co-pre" }, m.body),
          h("div", { class: "co-inline" }, !m.approved ? button("اعتماد", async (e) => { if (await act(e.currentTarget, () => mutate("POST", "/memory", { id: m.id, scope: "project", scopeRef: p.id, title: m.title, body: m.body, approved: true }), "اعتُمدت")) loadDetail(p.id, true); }) : null,
            button("حذف", async (e) => { if (!(await O.confirmDialog({ title: "حذف الملاحظة؟", body: `«${m.title}» ستُحذف من ذاكرة المشروع.`, confirm: "حذف", tone: "danger" }))) return; if (await act(e.currentTarget, () => mutate("DELETE", `/memory/${m.id}`), "حُذفت")) loadDetail(p.id, true); }))))) : empty("لا ملاحظات أو قرارات بعد."))];
    }
    return panel("نشاط المشروع", "سجل التدقيق لكل ما يخص المشروع.", p.activity.length ? C.activityList(p.activity) : empty("لا نشاط."));
  }

  // ---------------------------------------------------------------- registration + wiring
  O.registerView({
    id: "projects", order: 20, icon: "projects", ar: "المشاريع", subtitle: "كل مشاريع الشركة ومستودعاتها وعالمها وتقاريرها في مكان واحد.",
    tabs: [["overview", "نظرة عامة"], ["all", "كل المشاريع"],
      ["universe", "عالم المشاريع", { parts: [["u-map", "الخريطة"], ["u-worlds", "مسرح العوالم"], ["u-library", "الكتالوج العام"], ["u-relations", "العلاقات"], ["u-strategy", "التركيز"]] }],
      ["local", "المشاريع المحلية", { parts: [["l-repos", "المستودعات"], ["l-worlds", "عوالم الجهاز"]] }],
      ["reports", "التقارير والقرارات", { parts: [["r-company", "تقرير الشركة"], ["r-decisions", "قرارات المشاريع"], ["r-journal", "سجل المتصفح"], ["r-daily", "نشاط GitHub العام"]] }],
      ["detail", "المشروع", { hidden: true }]],
    defaultTab: "overview",
    resolve(rest) {
      if (rest[0] === "p" && rest[1]) return { tab: "detail", rest: rest.slice(1) };
      const tabs = ["overview", "all", "universe", "local", "reports"];
      return tabs.includes(rest[0]) ? { tab: rest[0], rest: rest.slice(1) } : { tab: null, rest };
    },
    onShow(tab, rest) {
      C.co.projects(); C.co.catalog();
      if (tab === "overview") { O.api.workspace(); C.co.tasks(); }
      if (tab === "all" || tab === "local") O.api.workspace();
      if (tab === "reports") { C.co.tasks(); C.co.activity(); O.api.co("runsAll", "/runs?limit=200", { ttl: 20_000 }); }
      if (tab === "detail") {
        detailId = rest[0];
        ui.detailTab = rest[1] || "overview";
        if (!watched.has(detailId)) { const id = detailId; watched.add(id); O.on(`co:${detailKey(id)}`, () => { if (detailId === id) renderDetail(); }); O.on(`co:${githubKey(id)}`, () => { if (detailId === id && ui.detailTab === "repo") renderDetail(); }); }
        O.api.workspace();
        loadDetail(detailId);
        if (ui.detailTab === "repo") O.api.co(githubKey(detailId), `/projects/${encodeURIComponent(detailId)}/github`, { ttl: 90_000 });
        renderDetail();
      } else { detailId = null; O.setHead("projects", null); }
    }
  });
  /** Detail-page actions replace the hub actions in the shared header. */
  O.setActions("projects", () => {
    const p = detailId ? O.peek(`co:${detailKey(detailId)}`)?.data : null;
    if (!p) return [];
    return [focusButton(p),
      p.github ? h("a", { class: "btn btn-secondary co-btn", href: `https://github.com/${p.github.split("/").map(encodeURIComponent).join("/")}`, target: "_blank", rel: "noopener noreferrer" }, icon("external", 16), "GitHub") : null,
      button("تقييم بواسطة ORI", async (e) => {
        const run = await act(e.currentTarget, () => mutate("POST", "/runs", { agentId: "ori", capability: "project_assessment", projectId: p.id, priority: "medium", idempotencyKey: `assess-${p.id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40)}-${Date.now()}` }), "بدأ ORI التقييم مع NEX وREX وLUNA");
        if (run) { invalidate("agents", "summary", "activity"); O.go("agents", "ori", "runs"); }
      }, { kind: "primary", icon: "sparkle" })];
  }, "detail");
  O.setActions("projects", () => [button("مزامنة من GitHub والمجلدات", (e) => syncProjects(e.currentTarget), { icon: "refresh" }), button("مشروع جديد", () => C.openNewProject(), { kind: "primary", icon: "plus" })]);
  const rerender = () => { renderOverview(); renderAll(); renderLocal(); };
  O.on("co:projects", () => { rerender(); if (detailId) loadDetail(detailId, true); });
  O.on("co:catalog", rerender);
  O.on("co:tasks", () => { if (O.state.view === "projects") { renderOverview(); renderReports(); } });
  O.on("co:activity", () => { if (O.state.view === "projects") renderReports(); });
  O.on("co:runsAll", renderReports);
  O.on("workspace", () => { renderOverview(); renderLocal(); if (O.state.view === "projects" && O.state.tab === "all") renderAllBody(); if (detailId) renderDetail(); });
  rerender();
})();
