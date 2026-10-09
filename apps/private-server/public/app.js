/* ABUD OS Private V2.0 alpha. No private data in localStorage or global cross-origin calls. */
(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const html = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
  const secretText = /(?:github_pat_[\w]{10,}|gh[pousr]_[\w]{8,}|sk-[\w-]{14,}|-----BEGIN .*PRIVATE KEY-----|(?:password|passphrase|api[_ -]?key|secret|access[_ -]?token)\s*[:=])/i;
  const stages = ["backlog", "progress", "blocked", "review", "done"];
  const base = { version: 1, focus: [], projects: {}, events: [] };
  let ready = false, csrf = "", owner = "", authorized = [], workspace = structuredClone(base), revision = 0, mapHeight = 1640;
  let dirty = false, busy = false, showing = null, statusRequest = 0;
  const isEn = () => document.documentElement.lang === "en";
  const tr = (ar, en) => isEn() ? en : ar;
  const publicRepos = () => window.ABUD_RUNTIME?.getRepos?.() || [];
  const publicNames = () => new Set(publicRepos().map((repo) => repo.name));
  const privateRepo = (name) => authorized.find((repo) => repo.name === name && repo.private === true);
  const repository = (name) => authorized.find((repo) => repo.name === name);
  const secureRouteRepo = (name) => {
    const repo = repository(name);
    return repo && (repo.private || !publicNames().has(name)) ? repo : null;
  };
  const allNames = () => new Set([...publicNames(), ...authorized.map((repo) => repo.name)]);
  const uniqueAuthorized = () => {
    const known = publicNames();
    return [...new Map(authorized.filter((repo) => repo.private || !known.has(repo.name)).map((repo) => [repo.name, repo])).values()];
  };
  const api = async (path, options = {}) => {
    const response = await fetch(path, {
      credentials: "same-origin", ...options, headers: {
        "Accept": "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });
    let body = null;
    try { body = await response.json(); } catch (_) { }
    if (!response.ok) { const error = new Error(body?.error || "request-failed"); error.status = response.status; throw error; }
    return body;
  };
  const currentFilter = () => window.ABUD_RUNTIME?.getFilter?.() || $("#filterChips .chip.active")?.dataset.filter || "all";
  const safeRepoLink = (repo) => typeof repo?.htmlUrl === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repo.htmlUrl) ? repo.htmlUrl : "#";
  function mountAccount() {
    const actions = $(".top-actions");
    if (!actions || $("#secureAccount")) return;
    const box = document.createElement("div");
    box.id = "secureAccount";
    box.className = "secure-account";
    box.innerHTML = '<a class="btn btn-outline secure-auth-link" href="/auth/start"></a>';
    actions.prepend(box);
    renderAccount();
  }
  function renderAccount() {
    const box = $("#secureAccount");
    if (!box) return;
    box.innerHTML = owner
      ? '<span class="secure-owner">' + html("@" + owner) + '</span><button class="btn btn-outline" id="secureLogout" type="button">' + html(tr("خروج آمن", "Sign out")) + '</button>'
      : '<a class="btn btn-outline secure-auth-link" href="/auth/start">' + html(tr("دخول ABUD OS", "Sign in to ABUD OS")) + '</a>';
    $("#secureLogout")?.addEventListener("click", logout);
  }
  function setStatus(message, kind = "saved") {
    const el = $("#secureSaveStatus");
    if (!el) return;
    el.textContent = message;
    el.dataset.state = kind;
  }
  function event(project, kind, detail) {
    if (!allNames().has(project) || !detail || secretText.test(detail)) return;
    workspace.events.unshift({ project, kind, detail: String(detail).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120), at: new Date().toISOString() });
    workspace.events = workspace.events.slice(0, 150);
  }
  function record(name) {
    if (!workspace.projects[name]) workspace.projects[name] = { stage: "backlog", tasks: [] };
    return workspace.projects[name];
  }
  function changed() {
    dirty = true;
    setStatus(tr("تغييرات غير محفوظة — لم تُرسل للسيرفر بعد", "Unsaved changes — not yet sent to the server"), "dirty");
    renderWorkspace();
    renderDaily();
    renderDecisionJournal();
    renderProjectTools();
  }
  function mountWorkspace() {
    const section = $("#workboard");
    if (!section || $("#secureWorkspacePanel")) return;
    for (const node of section.querySelectorAll(":scope > .work-summary, :scope > .work-toolbar, :scope > .work-projects, :scope > .work-history, :scope > .work-footer")) node.hidden = true;
    const report = $("#reports");
    for (const node of report.children) node.hidden = true;
    const secureReports = document.createElement("div");
    secureReports.className = "secure-report-panel";
    secureReports.innerHTML = '<div class="section-kicker">PRIVATE OWNER REPORTS</div><h3>' + html(tr("تقارير خاصة لصاحب الحساب", "Private owner reports")) + '</h3><p>' + html(tr("روابط تنزيل محمية بالجلسة، دون روابط عامة أو تخزين في GitHub Pages.", "Session-protected downloads; no public links or GitHub Pages storage.")) + '</p><div class="secure-report-links"><a class="btn btn-outline" href="/api/report.md?days=7">' + html(tr("تقرير 7 أيام", "7-day report")) + ' ↗</a><a class="btn btn-outline" href="/api/report.md?days=30">' + html(tr("تقرير 30 يومًا", "30-day report")) + ' ↗</a></div>';
    report.append(secureReports);
    const panel = document.createElement("section");
    panel.id = "secureWorkspacePanel";
    panel.className = "secure-workspace panel";
    panel.innerHTML = '<div class="panel-header"><div><div class="section-kicker">OWNER WORKSPACE · SERVER-SAVED</div><h3>' + html(tr("مساحة التنفيذ المتزامنة", "Synchronized execution workspace")) + '</h3></div><span class="secure-private-indicator">' + html(tr("لا تخزين محلي للبيانات الخاصة", "Private data is not stored locally")) + '</span></div>' +
      '<p class="secure-help">' + html(tr("اختَر حتى 3 مشاريع من الكتالوج العام والمستودعات المصرح بها فقط. التغييرات تبقى مسودة حتى تحفظها صراحةً.", "Choose up to 3 projects from the public catalog and explicitly authorized repositories. Changes remain a draft until you save.")) + '</p>' +
      '<div class="secure-workspace-controls"><label for="secureRepoPicker">' + html(tr("إضافة مشروع للتركيز", "Add a focus project")) + '</label><select id="secureRepoPicker"></select><button class="btn btn-secondary" id="secureAddFocus" type="button">' + html(tr("إضافة للتركيز", "Add to focus")) + '</button></div>' +
      '<div id="secureFocusCards" class="secure-focus-cards"></div><div id="secureJournal" class="secure-journal"></div>' +
      '<div class="secure-import-row"><button type="button" class="btn btn-outline" id="secureExport">' + html(tr("تصدير نسخة JSON آمنة", "Export safe JSON")) + '</button><button type="button" class="btn btn-outline" id="secureImportButton">' + html(tr("استيراد نسخة JSON", "Import JSON backup")) + '</button><input id="secureImportFile" type="file" accept="application/json,.json" hidden><span id="secureSaveStatus" role="status" aria-live="polite"></span><button type="button" class="btn btn-primary" id="secureSave">' + html(tr("حفظ على السيرفر", "Save to server")) + '</button><button type="button" class="btn btn-outline" id="secureReload">' + html(tr("إعادة تحميل", "Reload")) + '</button></div>';
    section.querySelector(".section-heading").after(panel);
    $("#secureAddFocus").addEventListener("click", () => addFocus($("#secureRepoPicker").value));
    $("#secureSave").addEventListener("click", saveWorkspace);
    $("#secureReload").addEventListener("click", () => loadWorkspace(true));
    $("#secureExport").addEventListener("click", exportWorkspace);
    $("#secureImportButton").addEventListener("click", () => $("#secureImportFile").click());
    $("#secureImportFile").addEventListener("change", importWorkspace);
    panel.addEventListener("click", (e) => {
      const button = e.target.closest("[data-secure-action]");
      if (!button) return;
      const name = button.dataset.repo;
      if (button.dataset.secureAction === "remove-focus") removeFocus(name);
      if (button.dataset.secureAction === "add-task") addTask(name, panel.querySelector('[data-task-input="' + CSS.escape(name) + '"]').value);
      if (button.dataset.secureAction === "toggle-task") toggleTask(name, button.dataset.taskId);
      if (button.dataset.secureAction === "delete-task") deleteTask(name, button.dataset.taskId);
      if (button.dataset.secureAction === "open-project") location.hash = "#project/" + encodeURIComponent(name);
    });
    panel.addEventListener("change", (e) => {
      const select = e.target.closest("[data-secure-stage]");
      if (!select) return;
      const name = select.dataset.secureStage;
      record(name).stage = stages.includes(select.value) ? select.value : "backlog";
      event(name, "stage", select.value);
      changed();
    });
    panel.addEventListener("submit", (e) => {
      const form = e.target.closest("[data-secure-task-form]");
      if (!form) return;
      e.preventDefault();
      addTask(form.dataset.secureTaskForm, form.querySelector("input").value);
    });
    $("#secureDecisionJournal")?.addEventListener("submit", submitDecision);
    mountDaily();
    mountDecisionJournal();
    renderWorkspace();
  }
  function mountDaily() {
    const daily = $("#daily");
    if (!daily || $("#secureDailyFocus")) return;
    const box = document.createElement("section");
    box.id = "secureDailyFocus";
    box.className = "secure-daily-focus";
    box.setAttribute("aria-live", "polite");
    $(".daily-layout").after(box);
  }
  function mountDecisionJournal() {
    const section = $("#decisions");
    if (!section || $("#secureDecisionJournal")) return;
    const panel = document.createElement("section");
    panel.id = "secureDecisionJournal";
    panel.className = "secure-decision-journal";
    panel.innerHTML = '<div class="section-kicker">OWNER DECISIONS · PRIVATE</div><h3>' + html(tr("سجل القرارات والعوائق الخاص", "Private decisions and blockers")) + '</h3><form class="secure-note-form"><select id="secureDecisionRepo" aria-label="' + html(tr("المشروع", "Project")) + '"></select><input id="secureDecisionText" maxlength="120" required autocomplete="off" placeholder="' + html(tr("سجل قرارًا أو عائقًا", "Record a decision or blocker")) + '"><button type="submit" class="btn btn-secondary">' + html(tr("إضافة", "Add")) + '</button></form><ol id="secureDecisionEvents"></ol>';
    section.querySelector(".decision-list").after(panel);
    panel.addEventListener("submit", submitDecision);
  }
  function mountProjectTools() {
    const hub = $("#projectHub");
    if (!hub || $("#secureProjectTools")) return;
    const panel = document.createElement("section");
    panel.id = "secureProjectTools";
    panel.className = "secure-project-tools";
    panel.hidden = true;
    hub.append(panel);
  }
  function mount() {
    mountAccount();
    mountWorkspace();
    mountProjectTools();
  }
  function visibleSecureRepos() {
    const filter = currentFilter(), query = $("#repoSearch")?.value.trim().toLowerCase() || "";
    if (filter !== "all" && filter !== "authorized") return [];
    return uniqueAuthorized().filter((repo) => !query || repo.name.toLowerCase().includes(query));
  }
  function renderDiscovery() {
    if (!owner || !ready) return;
    mount();
    document.querySelectorAll(".secure-repo-card, .secure-map-cluster").forEach((el) => el.remove());
    const items = visibleSecureRepos();
    const all = uniqueAuthorized();
    const cardList = $("#repoGrid");
    if (cardList) {
      for (const repo of items) {
        const visibility = repo.private ? tr("PRIVATE · مصرح به", "PRIVATE · AUTHORIZED") : tr("PUBLIC · مصرح به", "PUBLIC · AUTHORIZED");
        const card = document.createElement("article");
        card.className = "repo-card secure-repo-card";
        card.innerHTML = '<div class="repo-head"><span class="repo-icon">' + html(repo.name.slice(0, 1).toUpperCase()) + '</span><span class="repo-badge secure-visibility">' + html(visibility) + '</span></div><h3 class="repo-name">' + html(repo.name) + '</h3><p class="repo-desc">' + html(repo.private ? tr("مستودع خاص ظاهر عبر تثبيت GitHub App المختار فقط.", "Private repository visible through the selected GitHub App installation only.") : tr("مستودع عام مصرح به لم يكن موجودًا في الكتالوج عند التحميل.", "Authorized public repository not present in the catalog at load time.")) + '</p><div class="repo-meta"><span>' + html(repo.archived ? tr("مؤرشف", "Archived") : tr("لا يوجد تصنيف تحريري", "No editorial category")) + '</span></div><div class="repo-actions"><button type="button" class="small-btn" data-secure-open="' + html(repo.name) + '">' + html(tr("تفاصيل", "Details")) + ' ↗</button><button type="button" class="small-btn ghost" data-secure-add="' + html(repo.name) + '">' + html(tr("إضافة للتركيز", "Add focus")) + '</button></div>';
        cardList.append(card);
      }
      const visiblePublic = cardList.querySelectorAll(".repo-card:not(.secure-repo-card)").length;
      const count = visiblePublic + items.length;
      $("#resultCount").textContent = count + " / " + (publicRepos().length + all.length);
    }
    const counts = $("#sidebarCategories");
    if (counts && !counts.querySelector('[data-filter="authorized"]')) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "side-cat"; button.dataset.filter = "authorized"; button.style.setProperty("--cat", "#c084fc");
      button.innerHTML = '<span class="cat-dot"></span><span>' + html(tr("المصرح بها", "Authorized")) + '</span><span class="cat-count">' + all.length + '</span>';
      counts.append(button);
    }
    const chips = $("#filterChips");
    if (chips && !chips.querySelector('[data-filter="authorized"]')) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "chip" + (currentFilter() === "authorized" ? " active" : ""); button.dataset.filter = "authorized";
      button.innerHTML = '<i style="--chip:#c084fc"></i>' + html(tr("المصرح بها", "Authorized")) + ' · ' + all.length;
      chips.append(button);
    }
    const world = $("#mapWorld"), svg = $("#graphLines"), clusterRoot = $("#graphClusters");
    if (world && svg && clusterRoot && items.length) {
      const height = 1650 + 130 + Math.ceil(items.length / 2) * 72;
      world.style.height = height + "px";
      svg.setAttribute("viewBox", "0 0 2260 " + height);
      const cluster = document.createElement("section");
      cluster.className = "graph-cluster secure-map-cluster";
      cluster.style.cssText = "left:823px;top:1650px;--accent:#c084fc;height:auto;min-height:160px";
      cluster.innerHTML = '<div class="cluster-heading"><div><div class="cluster-name"><b></b>' + html(tr("وصول مصرح به", "AUTHORIZED ACCESS")) + '</div><div class="cluster-subtitle">' + html(tr("مستودعات مختارة · لا توجد علاقات مستنتجة", "Selected repositories · no inferred relationships")) + '</div></div><span class="cluster-count">' + items.length + '</span></div><div class="cluster-list">' + items.map((repo) => '<button class="graph-repo secure-graph-repo" data-secure-open="' + html(repo.name) + '" type="button" title="' + html(repo.name) + '"><span>' + html(repo.name) + '</span><i>' + (repo.private ? "PRIVATE" : "PUBLIC") + '</i></button>').join("") + '</div>';
      clusterRoot.append(cluster);
      const publicCount = publicRepos().length;
      $("#graphTotal").textContent = publicCount + " PUBLIC · " + all.length + " AUTHORIZED";
      $("#graphSummary").textContent = publicCount + " PUBLIC NODES · " + all.length + " AUTHORIZED · NO INFERRED EDGES";
      if (mapHeight !== height) {
        mapHeight = height;
        requestAnimationFrame(() => $("#fitMap")?.click());
      }
    } else if (world && svg) {
      world.style.height = "1640px";
      svg.setAttribute("viewBox", "0 0 2260 1640");
      if (mapHeight !== 1640) {
        mapHeight = 1640;
        requestAnimationFrame(() => $("#fitMap")?.click());
      }
    }
  }
  function renderWorkspace() {
    if (!owner || !$("#secureWorkspacePanel")) return;
    const projects = $("#secureFocusCards"), picker = $("#secureRepoPicker");
    const allowed = allNames(), focus = workspace.focus.filter((name) => allowed.has(name)).slice(0, 3);
    workspace.focus = focus;
    const previous = picker.value;
    const options = [...new Set([...publicRepos().map((repo) => repo.name), ...authorized.map((repo) => repo.name)])].sort((a, b) => a.localeCompare(b));
    picker.replaceChildren(...options.filter((name) => !focus.includes(name)).map((name) => { const option = document.createElement("option"); option.value = name; option.textContent = name; return option; }));
    if ([...picker.options].some((option) => option.value === previous)) picker.value = previous;
    $("#secureAddFocus").disabled = busy || focus.length >= 3 || !picker.options.length;
    projects.innerHTML = focus.length ? focus.map((name) => {
      const record = workspace.projects[name] || { stage: "backlog", tasks: [] };
      const repo = repository(name), privateLabel = repo?.private ? tr("PRIVATE", "PRIVATE") : tr("PUBLIC", "PUBLIC");
      const tasks = (record.tasks || []).map((task) => '<li class="secure-task ' + (task.done ? "done" : "") + '"><input type="checkbox" data-secure-action="toggle-task" data-repo="' + html(name) + '" data-task-id="' + html(task.id) + '" ' + (task.done ? "checked" : "") + ' aria-label="' + html(task.title) + '"><span>' + html(task.title) + '</span><button type="button" data-secure-action="delete-task" data-repo="' + html(name) + '" data-task-id="' + html(task.id) + '" aria-label="' + html(tr("حذف المهمة", "Remove task")) + '">×</button></li>').join("");
      return '<article class="secure-focus-card" data-work-project="' + html(name) + '"><div class="secure-focus-head"><div><span class="secure-visibility-text">' + privateLabel + (repo?.private ? " · " + html(tr("مصرح به", "AUTHORIZED")) : "") + '</span><h4>' + html(name) + '</h4></div><button type="button" class="small-btn ghost" data-secure-action="remove-focus" data-repo="' + html(name) + '">' + html(tr("إزالة", "Remove")) + '</button></div><label>' + html(tr("مرحلة يحددها المالك", "Owner-defined stage")) + '<select data-secure-stage="' + html(name) + '" ' + (busy ? "disabled" : "") + '>' + stages.map((stage) => '<option value="' + stage + '" ' + ((record.stage || "backlog") === stage ? "selected" : "") + '>' + html(stageLabel(stage)) + '</option>').join("") + '</select></label><ul class="secure-tasks">' + (tasks || '<li class="secure-task-empty">' + html(tr("لا توجد مهام بعد.", "No tasks yet.")) + '</li>') + '</ul><form data-secure-task-form="' + html(name) + '" class="secure-task-form"><input data-task-input="' + html(name) + '" maxlength="120" required autocomplete="off" placeholder="' + html(tr("أضف خطوة قابلة للتحقق", "Add a verifiable next step")) + '" ' + (busy ? "disabled" : "") + '><button type="submit" class="btn btn-secondary" ' + (busy ? "disabled" : "") + '>+ ' + html(tr("مهمة", "Task")) + '</button></form><button type="button" class="secure-open-project" data-secure-action="open-project" data-repo="' + html(name) + '">' + html(tr("فتح Project Hub", "Open Project Hub")) + ' ↗</button></article>';
    }).join("") : '<div class="secure-empty">' + html(tr("لم تختر مشروع تركيز بعد. استخدم محدد المستودعات أو أضف مشروعًا من المكتبة.", "No focus projects yet. Use the repository picker or add one from the library.")) + '</div>';
    const decisionPicker = $("#secureDecisionRepo");
    if (decisionPicker) {
      const old = decisionPicker.value;
      decisionPicker.replaceChildren(...focus.map((name) => { const option = document.createElement("option"); option.value = name; option.textContent = name; return option; }));
      if (focus.includes(old)) decisionPicker.value = old;
      $("#secureDecisionText").disabled = !focus.length || busy;
      decisionPicker.disabled = !focus.length || busy;
    }
    renderJournal();
    renderDaily();
    renderDecisionJournal();
    renderProjectTools();
    if (!dirty && !busy) setStatus(tr("محفوظ على السيرفر · الإصدار ", "Saved on server · revision ") + revision, "saved");
    $("#secureSave").disabled = busy || !dirty;
    $("#secureReload").disabled = busy;
  }
  function stageLabel(stage) {
    const words = { backlog: ["بانتظار البدء", "Backlog"], progress: ["قيد التنفيذ", "In progress"], blocked: ["متوقف / عائق", "Blocked"], review: ["يحتاج مراجعة", "Needs review"], done: ["مكتمل بتأكيد المالك", "Owner-confirmed done"] };
    return tr(...words[stage]);
  }
  function renderJournal() {
    const list = $("#secureJournal");
    if (!list) return;
    const recent = (workspace.events || []).filter((item) => allNames().has(item.project)).slice(0, 8);
    list.innerHTML = '<div class="secure-journal-title">' + html(tr("قرارات وعوائق محفوظة", "Saved decisions and blockers")) + '</div>' + (recent.length ? '<ol>' + recent.map((item) => '<li><strong>' + html(item.project) + '</strong> · ' + html(item.kind) + ' · ' + html(item.detail) + '<small>' + html(new Date(item.at).toLocaleString(isEn() ? "en-GB" : "ar-EG")) + '</small></li>').join("") + '</ol>' : '<p>' + html(tr("لا توجد قرارات مسجلة.", "No decisions recorded.")) + '</p>');
  }
  function renderDaily() {
    const box = $("#secureDailyFocus");
    if (!box || !owner) return;
    const focus = workspace.focus.slice(0, 3);
    box.innerHTML = '<div class="secure-daily-heading"><span class="section-kicker">SERVER-SAVED OWNER FOCUS</span><strong>' + html(tr("التركيز المتزامن", "Synchronized focus")) + '</strong></div>' + (focus.length ? '<div class="secure-daily-list">' + focus.map((name) => '<a href="#project/' + encodeURIComponent(name) + '"><strong>' + html(name) + '</strong><span>' + html(stageLabel(workspace.projects[name]?.stage || "backlog")) + '</span></a>').join("") + '</div>' : '<p>' + html(tr("أضف مشاريع للتركيز من لوحة التنفيذ.", "Choose focus projects in the Workboard.")) + '</p>');
  }
  function renderDecisionJournal() {
    const panel = $("#secureDecisionJournal"), list = $("#secureDecisionEvents");
    if (!panel || !list || !owner) return;
    const events = (workspace.events || []).filter((item) => item.kind === "note" && allNames().has(item.project)).slice(0, 12);
    list.innerHTML = events.length ? events.map((item) => '<li><strong>' + html(item.project) + '</strong><span>' + html(item.detail) + '</span><small>' + html(new Date(item.at).toLocaleString(isEn() ? "en-GB" : "ar-EG")) + '</small></li>').join("") : '<li class="secure-empty">' + html(tr("لا توجد قرارات أو عوائق مسجلة.", "No decisions or blockers recorded.")) + '</li>';
  }
  function renderProjectTools() {
    const panel = $("#secureProjectTools");
    if (!panel || !owner) return;
    const name = decodeURIComponent(location.hash.startsWith("#project/") ? location.hash.slice(9) : "");
    const repo = repository(name);
    if (!repo) { panel.hidden = true; showing = null; return; }
    panel.hidden = false;
    const focused = workspace.focus.includes(name), recordData = workspace.projects[name] || { stage: "backlog", tasks: [] };
    panel.innerHTML = '<div class="section-kicker">OWNER WORKSPACE · ' + html(repo.private ? "PRIVATE · AUTHORIZED" : "PUBLIC · AUTHORIZED") + '</div><h2>' + html(tr("إدارة المشروع المحفوظة على السيرفر", "Server-backed project management")) + '</h2><p class="secure-help">' + html(tr("المرحلة والمهام والقرارات ملكك؛ لا تُستنتج العلاقات من GitHub.", "Stages, tasks and decisions are owner-defined; no relationships are inferred from GitHub.")) + '</p>' +
      '<div class="secure-project-action">' + (!focused ? '<button class="btn btn-primary" type="button" data-secure-focus="' + html(name) + '">' + html(tr("إضافة للتركيز", "Add to focus")) + '</button>' : '<label>' + html(tr("مرحلة يحددها المالك", "Owner-defined stage")) + '<select id="secureHubStage" ' + (busy ? "disabled" : "") + '>' + stages.map((stage) => '<option value="' + stage + '" ' + ((recordData.stage || "backlog") === stage ? "selected" : "") + '>' + html(stageLabel(stage)) + '</option>').join("") + '</select></label>') + '<span id="secureHubSaveState">' + html(dirty ? tr("تغييرات غير محفوظة", "Unsaved changes") : tr("محفوظ على السيرفر", "Saved on server")) + '</span></div>' +
      (focused ? '<ul class="secure-hub-tasks">' + (recordData.tasks || []).map((task) => '<li>' + (task.done ? "✓" : "○") + ' ' + html(task.title) + '</li>').join("") + '</ul><form class="secure-hub-task-form"><input id="secureHubTask" maxlength="120" required placeholder="' + html(tr("أضف مهمة", "Add a task")) + '" ' + (busy ? "disabled" : "") + '><button class="btn btn-secondary" type="submit">+ ' + html(tr("مهمة", "Task")) + '</button></form>' : "") +
      '<div class="secure-status-evidence" id="secureStatusEvidence" aria-live="polite">' + html(tr("جاري تحميل STATUS.md من المستودع المصرح به…", "Loading STATUS.md from the authorized repository…")) + '</div>';
    panel.querySelector("[data-secure-focus]")?.addEventListener("click", () => addFocus(name));
    $("#secureHubStage")?.addEventListener("change", (e) => {
      record(name).stage = e.target.value;
      event(name, "stage", e.target.value);
      changed();
    });
    panel.querySelector(".secure-hub-task-form")?.addEventListener("submit", (e) => {
      e.preventDefault(); addTask(name, $("#secureHubTask").value);
    });
    if (showing !== name) { showing = name; void loadStatus(name); }
  }
  async function loadStatus(name) {
    const request = ++statusRequest;
    const target = $("#secureStatusEvidence");
    if (!target) return;
    try {
      const result = await api("/api/repos/" + encodeURIComponent(name) + "/status");
      if (request !== statusRequest || showing !== name) return;
      target.innerHTML = '<strong>' + html(tr("أدلة STATUS.md · للقراءة فقط", "STATUS.md evidence · read only")) + '</strong>' +
        (result.exists && result.claims?.length ? '<dl>' + result.claims.map((claim) => '<dt>' + html(claim.key) + '</dt><dd>' + html(claim.value) + '</dd>').join("") + '</dl>' : '<p>' + html(tr("الملف غير موجود أو لا يحتوي على الحقول المعروفة.", "File unavailable or contains no recognized fields.")) + '</p>') +
        (result.sha ? '<small>' + html(tr("معرّف المصدر: ", "Source SHA: ")) + html(result.sha) + '</small>' : "") + '<p class="secure-help">' + html(tr("هذه ادعاءات موثقة في الملف وليست تحققًا من التشغيل أو الجاهزية.", "Documented claims are not runtime verification or a readiness assessment.")) + '</p>';
    } catch (_) {
      if (request === statusRequest) target.textContent = tr("تعذر تحميل حالة المصدر. لم يتم كشف محتوى خاص.", "Source status unavailable. No private content was exposed.");
    }
  }
  function addFocus(name) {
    if (!name || !allNames().has(name) || workspace.focus.includes(name)) return;
    if (workspace.focus.length >= 3) { setStatus(tr("الحد الأقصى 3 مشاريع للتركيز", "Maximum of 3 focus projects"), "error"); return; }
    workspace.focus.push(name); record(name); event(name, "focus", "Added to owner focus"); changed();
  }
  function removeFocus(name) {
    workspace.focus = workspace.focus.filter((item) => item !== name);
    event(name, "unfocus", "Removed from owner focus"); changed();
  }
  function addTask(name, value) {
    const title = String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120);
    if (!workspace.focus.includes(name) || !title || secretText.test(title)) { setStatus(tr("اكتب مهمة صالحة دون أسرار", "Enter a valid task without secrets"), "error"); return; }
    const tasks = record(name).tasks;
    if (tasks.length >= 20) { setStatus(tr("الحد الأقصى 20 مهمة للمشروع", "Maximum of 20 tasks per project"), "error"); return; }
    tasks.push({ id: crypto.randomUUID(), title, done: false }); event(name, "task_add", title); changed();
  }
  function toggleTask(name, id) {
    const task = workspace.projects[name]?.tasks.find((entry) => entry.id === id);
    if (!task) return;
    task.done = !task.done; event(name, task.done ? "task_done" : "task_undo", task.title); changed();
  }
  function deleteTask(name, id) {
    const recordData = workspace.projects[name];
    if (!recordData) return;
    const task = recordData.tasks.find((entry) => entry.id === id);
    recordData.tasks = recordData.tasks.filter((entry) => entry.id !== id);
    if (task) event(name, "task_remove", task.title);
    changed();
  }
  function submitDecision(e) {
    e.preventDefault();
    const name = $("#secureDecisionRepo")?.value, input = $("#secureDecisionText"), text = input?.value.trim();
    if (!name || !workspace.focus.includes(name) || !text || secretText.test(text)) { setStatus(tr("القرار يحتاج مشروع تركيز ونصًا آمنًا", "Choose a focus project and enter safe decision text"), "error"); return; }
    event(name, "note", text); input.value = ""; changed();
  }
  async function loadWorkspace(confirmDiscard = false) {
    if (dirty && confirmDiscard && !window.confirm(tr("سيؤدي التحميل إلى تجاهل المسودة غير المحفوظة. متابعة؟", "Reloading discards the unsaved draft. Continue?"))) return;
    busy = true; setStatus(tr("جاري تحميل البيانات المحمية…", "Loading protected workspace…"), "loading"); renderWorkspace();
    try {
      const [repoResponse, boardResponse] = await Promise.all([api("/api/repos"), api("/api/workboard")]);
      authorized = Array.isArray(repoResponse.repos) ? repoResponse.repos.filter((repo) => typeof repo.name === "string") : [];
      workspace = normalize(boardResponse.data); revision = boardResponse.revision; dirty = false; ready = true;
      busy = false; mount(); renderWorkspace(); renderDiscovery(); route();
    } catch (error) {
      busy = false;
      setStatus(error.status === 401 ? tr("انتهت الجلسة — سجّل الدخول مجددًا", "Session expired — sign in again") : tr("تعذر تحميل المساحة. لم يتم تغيير البيانات المحفوظة.", "Could not load the workspace. Saved data was not changed."), "error");
      $("#secureReload").disabled = false;
    }
  }
  function normalize(data) {
    const allowed = allNames();
    if (!data || data.version !== 1 || !Array.isArray(data.focus)) return structuredClone(base);
    const focus = [...new Set(data.focus.filter((name) => typeof name === "string" && allowed.has(name)))].slice(0, 3);
    const projects = {};
    for (const [name, item] of Object.entries(data.projects || {})) {
      if (!allowed.has(name) || !item || typeof item !== "object") continue;
      projects[name] = { stage: stages.includes(item.stage) ? item.stage : "backlog", tasks: (Array.isArray(item.tasks) ? item.tasks : []).slice(0, 20).filter((task) => task && typeof task.title === "string" && task.title.trim() && !secretText.test(task.title)).map((task) => ({ id: /^[\w-]{1,64}$/.test(task.id || "") ? task.id : crypto.randomUUID(), title: task.title.trim().slice(0, 120), done: task.done === true })) };
    }
    const kinds = new Set(["note", "focus", "unfocus", "stage", "task_add", "task_done", "task_undo", "task_remove"]);
    const events = (Array.isArray(data.events) ? data.events : []).slice(0, 150).filter((item) => item && allowed.has(item.project) && kinds.has(item.kind) && typeof item.detail === "string" && item.detail.trim() && !secretText.test(item.detail) && !Number.isNaN(Date.parse(item.at))).map((item) => ({ project: item.project, kind: item.kind, detail: item.detail.slice(0, 120), at: new Date(item.at).toISOString() }));
    return { version: 1, focus, projects, events };
  }
  async function saveWorkspace() {
    if (!dirty || busy) return;
    busy = true; setStatus(tr("جاري الحفظ…", "Saving…"), "loading"); renderWorkspace();
    try {
      const result = await api("/api/workboard", { method: "PUT", headers: { "X-OS-CSRF": csrf }, body: JSON.stringify({ revision, data: normalize(workspace) }) });
      revision = result.revision; workspace = normalize(result.data); dirty = false;
      setStatus(tr("تم الحفظ على السيرفر · الإصدار ", "Saved on server · revision ") + revision, "saved");
    } catch (error) {
      if (error.status === 409) setStatus(tr("تعارض: جهاز آخر حفظ تغييرات أحدث. أعد التحميل للمقارنة قبل الحفظ.", "Conflict: another device saved a newer revision. Reload to compare before saving."), "conflict");
      else setStatus(error.status === 401 ? tr("انتهت الجلسة؛ المسودة ما زالت في الذاكرة فقط.", "Session expired; the draft remains in memory only.") : tr("تعذر الحفظ. المسودة لم تُرسل؛ حاول مجددًا.", "Save failed. The draft was not synchronized; retry."), "error");
    } finally { busy = false; renderWorkspace(); }
  }
  function exportWorkspace() {
    const payload = { version: 1, source: "ABUD OS authenticated workspace export", exportedAt: new Date().toISOString(), ...normalize(workspace) };
    const link = document.createElement("a"), url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    link.href = url; link.download = "abud-os-private-workspace-" + new Date().toISOString().slice(0, 10) + ".json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importWorkspace(e) {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    if (file.size > 80 * 1024 || !file.size) { setStatus(tr("ملف غير صالح أو أكبر من 80KB", "Invalid file or larger than 80KB"), "error"); return; }
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed.version !== 1 || !Array.isArray(parsed.focus) || !parsed.projects || typeof parsed.projects !== "object" || Array.isArray(parsed.projects)) throw Error("invalid");
      if (!window.confirm(tr("استيراد النسخة سيستبدل المسودة الحالية فقط. راجعها واحفظ يدويًا. متابعة؟", "Import replaces only the current draft. Review and save manually. Continue?"))) return;
      workspace = normalize(parsed); dirty = true; setStatus(tr("تم الاستيراد كمسودة؛ لم تُحفظ بعد.", "Imported as a draft; not saved yet."), "dirty"); renderWorkspace();
    } catch (_) { setStatus(tr("تعذر قراءة نسخة Workboard آمنة.", "Could not read a safe Workboard backup."), "error"); }
  }
  function renderProject(name) {
    const repo = secureRouteRepo(name);
    if (!repo) return false;
    document.body.classList.add("project-mode");
    $("#projectHub").hidden = false;
    $("#hubBackLabel").textContent = tr("العودة للوحة التحكم", "Back to the Universe");
    $("#hubCategory").textContent = repo.private ? tr("PRIVATE · APP INSTALL SELECTED", "PRIVATE · APP INSTALL SELECTED") : tr("PUBLIC · APP AUTHORIZED", "PUBLIC · APP AUTHORIZED");
    $("#hubTitle").textContent = repo.name;
    $("#hubDescription").textContent = repo.private ? tr("مستودع خاص متاح عبر GitHub App المختار. بياناته لا تدخل الكتالوج العام.", "Private repository available through the selected GitHub App. Its data is not part of the public catalog.") : tr("مستودع عام مصرح به خارج الكتالوج الحالي. لا يوجد تقييم تحريري أو علاقة مستنتجة.", "Authorized public repository outside the current catalog. No editorial rating or inferred relationships.");
    $("#hubRepoLink").href = safeRepoLink(repo);
    $("#hubNext").textContent = tr("افحص STATUS.md ومعلومات المستودع المصرح بها.", "Review STATUS.md and authorized repository metadata.");
    $("#hubReview").textContent = tr("الظهور هنا يثبت فقط عضوية GitHub App المختارة؛ لا يثبت جاهزية المنتج.", "Visibility here confirms selected GitHub App membership only; it does not prove product readiness.");
    $("#hubCommit").textContent = tr("لا يتم جلب بيانات خاصة من GitHub في المتصفح.", "Private GitHub data is never fetched in the browser.");
    $("#hubCi").textContent = tr("حالة CI غير متاحة عبر الصلاحيات الحالية.", "CI status is unavailable through the current permissions.");
    $("#hubEvidence").textContent = tr("ملخص STATUS.md من السيرفر بعد التحقق من الصلاحيات.", "STATUS.md summary from the server after authorization checks.");
    $("#hubInfo").textContent = (repo.private ? "PRIVATE · " : "PUBLIC · ") + tr("عضوية مصرح بها", "authorized membership");
    $("#hubDisclaimer").textContent = tr("المعلومات الخاصة محمية بجلسة صاحب الحساب. المرحلة والمهام قرارات يدوية، وعلاقات المشاريع لا تُستنتج.", "Private details require the owner session. Stages and tasks are manual; project relationships are not inferred.");
    $("#projectIntelligence").hidden = true;
    renderProjectTools();
    window.scrollTo({ top: 0, behavior: "instant" });
    return true;
  }
  function route() {
    if (!ready || !location.hash.startsWith("#project/")) return;
    let name;
    try { name = decodeURIComponent(location.hash.slice(9)); } catch (_) { return; }
    if (secureRouteRepo(name)) return;
    if (repository(name)) setTimeout(() => {
      if (location.hash !== "#project/" + encodeURIComponent(name)) return;
      $("#projectIntelligence").hidden = false;
      renderProjectTools();
    }, 0);
  }
  function renderSecureRoute(name) {
    renderProject(name);
  }
  async function logout() {
    const button = $("#secureLogout"); if (button) button.disabled = true;
    try { await api("/api/logout", { method: "POST", headers: { "X-OS-CSRF": csrf } }); }
    catch (error) {
      if (error.status === 401) { location.replace("/"); return; }
      setStatus(tr("تعذر إنهاء الجلسة. حاول مجددًا.", "Sign-out failed. Retry."), "error");
      if (button) button.disabled = false;
      return;
    }
    csrf = ""; owner = ""; authorized = []; workspace = structuredClone(base); dirty = false; ready = true;
    location.replace("/");
  }
  async function start() {
    mountAccount();
    try {
      const me = await api("/api/me");
      csrf = me.csrf; owner = me.owner;
      renderAccount(); mount();
      await loadWorkspace();
    } catch (error) {
      ready = true; renderAccount();
      if (error.status !== 401) {
        const alert = document.createElement("div"); alert.className = "secure-alert"; alert.textContent = tr("تعذر التحقق من ABUD OS. لا توجد بيانات خاصة معروضة.", "ABUD OS could not be verified. No private data is displayed.");
        $(".content")?.prepend(alert);
      }
      window.ABUD_COMMAND?.route?.();
    }
  }
  window.ABUD_PRIVATE_WORKSPACE = {
    ready: () => ready,
    getRepo: (name) => secureRouteRepo(name),
    showHub: (name) => renderSecureRoute(name)
  };
  document.addEventListener("click", (e) => {
    const open = e.target.closest("[data-secure-open]");
    if (open) { location.hash = "#project/" + encodeURIComponent(open.dataset.secureOpen); return; }
    const add = e.target.closest("[data-secure-add]");
    if (add) { addFocus(add.dataset.secureAdd); $("#workboard").scrollIntoView({ behavior: "smooth" }); }
    const focus = e.target.closest("[data-secure-focus]");
    if (focus) addFocus(focus.dataset.secureFocus);
  });
  $("#repoSearch")?.addEventListener("input", renderDiscovery);
  document.addEventListener("click", (e) => { if (e.target.closest("[data-filter]")) setTimeout(renderDiscovery, 0); });
  window.addEventListener("abud:refresh", () => { renderDiscovery(); if (owner) renderWorkspace(); });
  window.addEventListener("hashchange", route);
  window.addEventListener("abud:workboard", renderDaily);
  window.addEventListener("click", (e) => {
    if (e.target.closest("#hubCopyBrief") && secureRouteRepo(decodeURIComponent(location.hash.slice(9)))) {
      const name = decodeURIComponent(location.hash.slice(9)), repo = repository(name);
      navigator.clipboard?.writeText("Project: " + name + "\nVisibility: " + (repo.private ? "authorized private" : "authorized public") + "\nReview the server-authorized STATUS.md and owner-selected tasks. Do not infer project relationships.").catch(() => { });
    }
  });
  void start();
})();