/* Project map workspace: filtering, list/graph views, focus mode and an in-map inspector. */
(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const state = { query: "", filter: "all", view: "graph", selected: null, fullscreen: false };
  const labels = {
    ar: { all: "كل المشاريع", active: "تركيز حالي", live: "منشور", revive: "إحياء", cleanup: "تنظيف", archive: "مجمّد", personal: "شخصي", showcase: "معرض" },
    en: { all: "All projects", active: "Current focus", live: "Shipped", revive: "Revive", cleanup: "Cleanup", archive: "Frozen", personal: "Personal", showcase: "Showcase" }
  };
  const english = () => document.documentElement.lang === "en";
  const t = (ar, en) => english() ? en : ar;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;"}[char]));
  const repos = () => window.ABUD_RUNTIME?.getRepos?.() || [];
  const catLabel = (repo) => repo.category ? (labels[english() ? "en" : "ar"][repo.category] || repo.category) : "—";
  const visible = () => repos().filter((repo) => {
    const matchesFilter = state.filter === "all" || repo.category === state.filter;
    const needle = state.query.trim().toLocaleLowerCase();
    return matchesFilter && (!needle || [repo.name, repo.category, repo.status, repo.ar, repo.en, repo.nextAr, repo.nextEn].some((part) => String(part || "").toLocaleLowerCase().includes(needle)));
  });

  function renderKpis() {
    const all = repos(), current = all.filter((repo) => repo.category === "active"), review = all.filter((repo) => ["cleanup", "archive"].includes(repo.category));
    const data = [
      [t("المشاريع الظاهرة", "VISIBLE NODES"), visible().length, "#c084fc"],
      [t("العوالم", "GROUPS"), new Set(visible().map((repo) => repo.category)).size, "#45d6d0"],
      [t("التركيز الحالي", "CURRENT FOCUS"), current.length, "#f97373"],
      [t("تحتاج مراجعة", "REVIEW SIGNALS"), review.length, "#fbbf24"]
    ];
    const target = $("#mapKpis"); if (!target) return;
    target.innerHTML = data.map(([label, value, color]) => `<div class="map-kpi" style="--kpi-color:${color}"><strong>${value.toString().padStart(2, "0")}</strong><span>${escapeHtml(label)}</span></div>`).join("");
  }

  function renderFilters() {
    const target = $("#mapFilterbar"); if (!target) return;
    const counts = repos().reduce((result, repo) => { result[repo.category] = (result[repo.category] || 0) + 1; return result; }, {});
    const keys = ["all", "active", "live", "revive", "showcase", "personal", "archive", "cleanup"];
    target.innerHTML = keys.map((key) => {
      const count = key === "all" ? repos().length : counts[key] || 0;
      return `<button type="button" class="map-filter ${state.filter === key ? "is-active" : ""}" data-map-filter="${key}">${escapeHtml(labels[english() ? "en" : "ar"][key])}<b>${count}</b></button>`;
    }).join("");
  }

  function applyGraphSearch() {
    const needle = state.query.trim().toLocaleLowerCase();
    $(".map-workspace")?.classList.toggle("map-has-map-filter", state.filter !== "all" || !!needle);
    $$(".graph-cluster").forEach((cluster) => {
      const categoryMatches = state.filter === "all" || cluster.dataset.mapCategory === state.filter;
      let matches = 0;
      cluster.querySelectorAll(".graph-repo").forEach((button) => {
        const match = !needle || button.textContent.toLocaleLowerCase().includes(needle);
        button.hidden = !!needle && !match;
        button.classList.toggle("map-search-match", !!needle && match);
        if (match) matches += 1;
      });
      cluster.hidden = !categoryMatches;
      cluster.classList.toggle("map-search-hidden", categoryMatches && !!needle && !matches);
    });
    $$(".map-edge").forEach((edge) => { edge.hidden = state.filter !== "all" && edge.dataset.mapCategory !== state.filter; });
  }

  function renderList() {
    const target = $("#mapListView"); if (!target) return;
    const rows = visible();
    target.innerHTML = rows.length ? rows.map((repo) => {
      const color = (window.ABUD_DATA?.categories || []).find((cat) => cat.id === repo.category)?.color || "#c084fc";
      return `<article class="map-list-row${state.selected === repo.name ? " is-selected" : ""}" data-map-row="${escapeHtml(repo.name)}"><span class="map-list-dot" style="--row-color:${escapeHtml(color)}"></span><div><strong>${escapeHtml(repo.name)}</strong><span>${escapeHtml(catLabel(repo))}</span></div><p>${escapeHtml(english() ? repo.nextEn : repo.nextAr)}</p><button type="button" data-map-select="${escapeHtml(repo.name)}">${t("ملخص", "Summary")}</button></article>`;
    }).join("") : `<div class="map-list-empty">${t("مفيش مشاريع مطابقة للبحث أو الفلتر.", "No projects match this search or filter.")}</div>`;
  }

  function renderView() {
    const viewport = $("#mapViewport"), list = $("#mapListView"), board = $("#mapBoardView"), graphButton = $("#mapGraphView"), listButton = $("#mapListViewToggle"), boardButton = $("#mapBoardViewToggle");
    if (!viewport || !list || !board) return;
    const graph = state.view === "graph";
    const listMode = state.view === "list";
    viewport.hidden = !graph; list.hidden = !listMode; board.hidden = state.view !== "board";
    document.querySelector(".map-workspace")?.classList.toggle("map-board-mode", state.view === "board");
    graphButton?.classList.toggle("is-active", graph); graphButton?.setAttribute("aria-pressed", String(graph));
    listButton?.classList.toggle("is-active", listMode); listButton?.setAttribute("aria-pressed", String(listMode));
    boardButton?.classList.toggle("is-active", state.view === "board"); boardButton?.setAttribute("aria-pressed", String(state.view === "board"));
    $$('[data-map-ar][data-map-en]').forEach((node) => { node.textContent = english() ? node.dataset.mapEn : node.dataset.mapAr; });
    $("#mapSearch")?.setAttribute("placeholder", t("ابحث باسم المشروع أو المجموعة", "Search projects or groups"));
    if (listMode) renderList();
    window.dispatchEvent(new CustomEvent("abud:map-view", { detail: { view: state.view, filter: state.filter } }));
  }

  function showInspector(name) {
    const repo = repos().find((item) => item.name === name), content = $("#mapInspectorContent"), empty = $("#mapInspectorEmpty");
    if (!repo || !content || !empty) return;
    state.selected = name; empty.hidden = true; content.hidden = false;
    $("#mapInspector").hidden = false;
    $(".map-workspace")?.classList.add("map-has-selection");
    $("#mapInspectorCategory").textContent = catLabel(repo);
    $("#mapInspectorName").textContent = repo.name;
    $("#mapInspectorStatus").textContent = repo.status || "—";
    $("#mapInspectorDescription").textContent = t(repo.ar, repo.en);
    $("#mapInspectorNext").textContent = t(repo.nextAr, repo.nextEn);
    $("#mapInspectorNote").textContent = repo.note || t("لا توجد ملاحظة إضافية.", "No additional note.");
    $("#mapInspectorOpen").dataset.open = repo.name;
    const github = $("#mapInspectorGithub"); github.href = `https://github.com/${encodeURIComponent(window.ABUD_DATA?.owner || "abudoxali")}/${encodeURIComponent(repo.name)}`;
    $$(".graph-repo").forEach((button) => button.classList.toggle("is-selected", button.dataset.mapSelect === name));
    $$(".map-list-row").forEach((row) => row.classList.toggle("is-selected", row.dataset.mapRow === name));
  }

  function clearInspector() {
    state.selected = null;
    $(".map-workspace")?.classList.remove("map-has-selection");
    $("#mapInspector")?.setAttribute("hidden", "");
    $("#mapInspectorContent")?.setAttribute("hidden", "");
    $("#mapInspectorEmpty")?.removeAttribute("hidden");
    $$(".graph-repo.is-selected").forEach((button) => button.classList.remove("is-selected"));
    $$(".map-list-row.is-selected").forEach((row) => row.classList.remove("is-selected"));
  }

  function setFullscreen(value) {
    state.fullscreen = value;
    $("#map")?.classList.toggle("map-fullscreen", value);
    document.body.classList.toggle("map-focus", value);
    const button = $("#mapFullscreen");
    if (button) { button.setAttribute("aria-pressed", String(value)); button.querySelector("span").textContent = value ? t("إغلاق المساحة", "Exit focus") : t("مساحة كاملة", "Full space"); }
    if (value) window.scrollTo({ top: 0, behavior: "smooth" });
    window.dispatchEvent(new Event("resize"));
  }

  function renderAll() {
    renderKpis(); renderFilters(); applyGraphSearch(); renderList(); renderView();
    const total = $("#graphTotal"), summary = $("#graphSummary");
    if (total) total.textContent = visible().length + " REPOS";
    if (summary) summary.textContent = t(`${visible().length} مشروع · ${new Set(visible().map((repo) => repo.category)).size} مجموعات`, `${visible().length} projects · ${new Set(visible().map((repo) => repo.category)).size} groups`);
    if (state.selected && !visible().some((repo) => repo.name === state.selected)) clearInspector();
    else if (state.selected) showInspector(state.selected);
  }

  function bind() {
    $("#mapSearch")?.addEventListener("input", (event) => { state.query = event.target.value; renderAll(); });
    $("#mapFilterbar")?.addEventListener("click", (event) => { const button = event.target.closest("[data-map-filter]"); if (!button) return; state.filter = button.dataset.mapFilter; renderAll(); window.dispatchEvent(new CustomEvent("abud:map-filter", { detail: { category: state.filter } })); });
    $("#mapGraphView")?.addEventListener("click", () => { state.view = "graph"; renderView(); });
    $("#mapListViewToggle")?.addEventListener("click", () => { state.view = "list"; renderView(); });
    $("#mapBoardViewToggle")?.addEventListener("click", () => { state.view = "board"; renderView(); });
    $("#mapFullscreen")?.addEventListener("click", () => setFullscreen(!state.fullscreen));
    $("#mapInspectorClear")?.addEventListener("click", clearInspector);
    $("#mapSearch")?.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.target.value = ""; state.query = ""; renderAll(); event.target.blur(); } });
    document.addEventListener("click", (event) => {
      const boardSelect = event.target.closest("[data-board-select]");
      if (boardSelect && boardSelect.closest("#mapBoardView")) { event.preventDefault(); showInspector(boardSelect.dataset.boardSelect); return; }
      const select = event.target.closest("[data-map-select]"); if (select && select.closest("#map")) { event.preventDefault(); showInspector(select.dataset.mapSelect); }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
        event.preventDefault(); $("#mapSearch")?.focus();
      }
      if (event.key === "Escape" && state.selected) clearInspector();
      else if (event.key === "Escape" && state.fullscreen) setFullscreen(false);
    });
    window.addEventListener("abud:refresh", renderAll);
    window.addEventListener("abud:language", renderAll);
    renderAll();
  }
  window.addEventListener("DOMContentLoaded", bind, { once: true });
})();
