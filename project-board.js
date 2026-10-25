/* Local-first project board: cards, lanes, notes, drag/drop, history and portable JSON. */
(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const STORE = "abud-universe-project-board-v1";
  const laneOrder = ["focus", "next", "ideas", "parked"];
  const laneCopy = {
    focus: { ar: "الآن", en: "NOW", hintAr: "حاجات لها أولوية دلوقتي", hintEn: "What deserves attention now", color: "#f97373" },
    next: { ar: "التالي", en: "NEXT", hintAr: "الخطوة الأقرب القابلة للتنفيذ", hintEn: "The nearest executable step", color: "#fbbf24" },
    ideas: { ar: "أفكار", en: "IDEAS", hintAr: "مساحة للتجارب والاقتراحات", hintEn: "Experiments and suggestions", color: "#c084fc" },
    parked: { ar: "مؤجل", en: "PARKED", hintAr: "مش وقته الآن، لكنه محفوظ", hintEn: "Not now, but still saved", color: "#7c8aa5" }
  };
  const state = { custom: [], placements: {}, collapsed: {}, focusOnly: false, history: [], future: [], zoom: 1, bound: false };
  const english = () => document.documentElement.lang === "en";
  const t = (ar, en) => english() ? en : ar;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;"}[char]));
  const repos = () => window.ABUD_RUNTIME?.getRepos?.() || [];
  const data = () => window.ABUD_DATA || { owner: "abudoxali", categories: [] };
  const category = (id) => data().categories.find((item) => item.id === id) || { id, color: "#c084fc", ar: id, en: id };
  const defaultLane = (repo) => ({ active: "focus", live: "focus", showcase: "next", personal: "next", revive: "ideas", cleanup: "parked", archive: "parked", freeze: "parked" }[repo.category] || "ideas");
  const idForRepo = (name) => `repo:${name}`;
  const now = () => new Date().toISOString();

  function readStore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || "null");
      if (!saved || typeof saved !== "object") return;
      state.custom = Array.isArray(saved.custom) ? saved.custom.filter(validCustom) : [];
      state.placements = saved.placements && typeof saved.placements === "object" ? saved.placements : {};
      state.collapsed = saved.collapsed && typeof saved.collapsed === "object" ? saved.collapsed : {};
      state.focusOnly = saved.focusOnly === true;
    } catch (_) { state.custom = []; state.placements = {}; }
  }
  function persist() {
    try { localStorage.setItem(STORE, JSON.stringify({ version: 1, custom: state.custom, placements: state.placements, collapsed: state.collapsed, focusOnly: state.focusOnly, updatedAt: now() })); } catch (_) { }
  }
  function validCustom(card) {
    return card && typeof card === "object" && typeof card.id === "string" && /^note:/.test(card.id) && typeof card.title === "string" && card.title.trim().length > 0 && laneOrder.includes(card.lane);
  }
  function snapshot() { return JSON.stringify({ custom: state.custom, placements: state.placements, collapsed: state.collapsed, focusOnly: state.focusOnly }); }
  function restore(raw) {
    try {
      const parsed = JSON.parse(raw);
      state.custom = Array.isArray(parsed.custom) ? parsed.custom.filter(validCustom) : [];
      state.placements = parsed.placements && typeof parsed.placements === "object" ? parsed.placements : {};
      state.collapsed = parsed.collapsed && typeof parsed.collapsed === "object" ? parsed.collapsed : {};
      state.focusOnly = parsed.focusOnly === true;
      persist(); render();
    } catch (_) { }
  }
  function commitHistory() {
    state.history.push(snapshot());
    if (state.history.length > 40) state.history.shift();
    state.future = [];
  }
  function undo() {
    if (!state.history.length) return;
    state.future.push(snapshot()); restore(state.history.pop());
  }
  function redo() {
    if (!state.future.length) return;
    state.history.push(snapshot()); restore(state.future.pop());
  }

  function allCards() {
    const projectCards = repos().map((repo) => ({
      id: idForRepo(repo.name), kind: "project", repoName: repo.name, title: repo.name,
      body: english() ? repo.nextEn : repo.nextAr, status: repo.status || "—",
      category: category(repo.category), lane: state.placements[idForRepo(repo.name)] || defaultLane(repo)
    }));
    const noteCards = state.custom.map((card) => ({ ...card, kind: card.kind || "note", category: { color: card.color || "#c084fc", ar: "ملاحظة", en: "NOTE" }, status: "LOCAL", lane: card.lane }));
    return [...projectCards, ...noteCards];
  }
  function filteredCards() {
    const needle = $("#mapSearch")?.value.trim().toLocaleLowerCase() || "";
    return allCards().filter((card) => (!state.focusOnly || card.lane === "focus") && (!needle || [card.title, card.body, card.status, card.category?.ar, card.category?.en].some((part) => String(part || "").toLocaleLowerCase().includes(needle))));
  }

  function cardMarkup(card) {
    const isProject = card.kind === "project";
    const accent = card.category?.color || "#c084fc";
    const open = isProject ? `<button class="board-card-open" type="button" data-board-select="${escapeHtml(card.repoName)}">${t("عرض الملخص", "View summary")} ↗</button>` : `<button class="board-card-delete" type="button" data-board-action="delete" data-board-id="${escapeHtml(card.id)}" aria-label="Delete card">×</button>`;
    const moveOptions = laneOrder.map((lane) => `<option value="${lane}" ${card.lane === lane ? "selected" : ""}>${escapeHtml(t(laneCopy[lane].ar, laneCopy[lane].en))}</option>`).join("");
    return `<article class="board-card ${isProject ? "board-project-card" : "board-note-card"}" draggable="true" data-board-id="${escapeHtml(card.id)}" style="--card-accent:${escapeHtml(accent)}"><div class="board-card-top"><span class="board-card-kind">${isProject ? t("مشروع", "PROJECT") : t("ملاحظة", "NOTE")}</span>${open}</div><h3>${escapeHtml(card.title)}</h3><p>${escapeHtml(card.body || t("لا توجد تفاصيل بعد.", "No details yet."))}</p><div class="board-card-meta"><span>${escapeHtml(card.status)}</span><label><span class="sr-only">Move card</span><select data-board-move="${escapeHtml(card.id)}" aria-label="Move ${escapeHtml(card.title)}">${moveOptions}</select></label></div></article>`;
  }

  function render() {
    const lanes = $("#boardLanes"); if (!lanes) return;
    const cards = filteredCards();
    lanes.innerHTML = laneOrder.map((lane) => {
      const copy = laneCopy[lane], laneCards = cards.filter((card) => card.lane === lane);
      const collapsed = state.collapsed[lane] === true;
      return `<section class="board-lane ${collapsed ? "is-collapsed" : ""}" data-board-lane="${lane}" style="--lane-color:${copy.color}"><header class="board-lane-head"><div><span class="board-lane-mark"></span><h3>${escapeHtml(t(copy.ar, copy.en))}</h3><p>${escapeHtml(t(copy.hintAr, copy.hintEn))}</p></div><div class="board-lane-tools"><b>${laneCards.length}</b><button type="button" class="board-lane-toggle" data-board-action="toggle-lane" data-board-lane="${lane}" aria-expanded="${String(!collapsed)}" aria-label="${escapeHtml(t("طي العمود", "Collapse lane"))}">${collapsed ? "+" : "−"}</button></div></header><div class="board-lane-drop" data-board-drop="${lane}">${laneCards.length ? laneCards.map(cardMarkup).join("") : `<div class="board-lane-empty">${escapeHtml(t("اسحب بطاقة هنا", "Drop a card here"))}</div>`}</div></section>`;
    }).join("");
    const all = allCards();
    $("#boardSummary").textContent = t(`${cards.length} بطاقة ظاهرة · ${all.filter((card) => card.kind === "project").length} مشروع · ${all.filter((card) => card.kind !== "project").length} ملاحظة`, `${cards.length} visible cards · ${all.filter((card) => card.kind === "project").length} projects · ${all.filter((card) => card.kind !== "project").length} notes`);
    $("#boardCardCount").textContent = cards.length;
    $("#boardFocusCount").textContent = allCards().filter((card) => card.lane === "focus").length;
    $("[data-board-action='focus']")?.classList.toggle("is-active", state.focusOnly);
    $("#boardZoom").textContent = Math.round(state.zoom * 100) + "%";
    const lanesLayer = $("#boardLanes"); if (lanesLayer) { lanesLayer.style.setProperty("--board-scale", state.zoom); lanesLayer.style.width = `${100 / state.zoom}%`; }
  }

  function moveCard(id, lane) {
    if (!laneOrder.includes(lane)) return;
    const card = allCards().find((item) => item.id === id); if (!card || card.lane === lane) return;
    commitHistory();
    if (card.kind === "project") state.placements[id] = lane;
    else { const custom = state.custom.find((item) => item.id === id); if (custom) custom.lane = lane; }
    persist(); render();
  }
  function deleteCard(id) {
    const index = state.custom.findIndex((card) => card.id === id); if (index < 0) return;
    commitHistory(); state.custom.splice(index, 1); persist(); render();
  }
  function toggleLane(lane) {
    if (!laneOrder.includes(lane)) return;
    state.collapsed[lane] = state.collapsed[lane] !== true;
    persist(); render();
  }
  function arrange() {
    commitHistory();
    repos().forEach((repo) => { state.placements[idForRepo(repo.name)] = defaultLane(repo); });
    persist(); render();
  }
  function setZoom(value) {
    state.zoom = Math.max(.65, Math.min(1.35, value)); render();
  }
  function addCard(event) {
    event.preventDefault();
    const form = event.currentTarget, values = new FormData(form), title = String(values.get("title") || "").trim();
    if (!title) return;
    commitHistory();
    state.custom.push({ id: `note:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, kind: "note", title, body: String(values.get("body") || "").trim(), lane: laneOrder.includes(values.get("lane")) ? values.get("lane") : "ideas", color: "#c084fc", createdAt: now() });
    persist(); form.reset(); $("#boardComposer").hidden = true; render();
  }
  function exportBoard() {
    const payload = { version: 1, exportedAt: now(), custom: state.custom, placements: state.placements, collapsed: state.collapsed, focusOnly: state.focusOnly };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `abud-universe-board-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href);
  }
  function importBoard(file) {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      try {
        const payload = JSON.parse(String(reader.result || "{}"));
        if (!payload || payload.version !== 1) throw new Error("Unsupported board");
        commitHistory(); state.custom = Array.isArray(payload.custom) ? payload.custom.filter(validCustom).slice(0, 100) : [];
        state.placements = payload.placements && typeof payload.placements === "object" ? Object.fromEntries(Object.entries(payload.placements).filter(([id, lane]) => id.startsWith("repo:") && laneOrder.includes(lane)).slice(0, 500)) : {};
        state.collapsed = payload.collapsed && typeof payload.collapsed === "object" ? payload.collapsed : {};
        state.focusOnly = payload.focusOnly === true;
        persist(); render();
      } catch (_) { window.alert(t("ملف السبورة غير صالح أو قديم.", "This board file is invalid or outdated.")); }
    });
    reader.readAsText(file);
  }
  function action(action, id, lane) {
    if (action === "add") $("#boardComposer").hidden = false;
    if (action === "close-composer") $("#boardComposer").hidden = true;
    if (action === "delete") deleteCard(id);
    if (action === "toggle-lane") toggleLane(lane);
    if (action === "focus") { state.focusOnly = !state.focusOnly; persist(); render(); }
    if (action === "undo") undo();
    if (action === "redo") redo();
    if (action === "arrange") arrange();
    if (action === "zoom-in") setZoom(state.zoom + .1);
    if (action === "zoom-out") setZoom(state.zoom - .1);
    if (action === "fit") setZoom(1);
    if (action === "export") exportBoard();
    if (action === "import") $("#boardImportInput")?.click();
  }
  function bind() {
    if (state.bound || !$("#mapBoardView")) return; state.bound = true; readStore();
    $("#mapBoardView").addEventListener("click", (event) => { const button = event.target.closest("[data-board-action]"); if (button) action(button.dataset.boardAction, button.dataset.boardId, button.dataset.boardLane); });
    $("#mapBoardView").addEventListener("change", (event) => { const select = event.target.closest("[data-board-move]"); if (select) moveCard(select.dataset.boardMove, select.value); });
    $("#boardComposer").addEventListener("submit", addCard);
    $("#boardImportInput").addEventListener("change", (event) => { const file = event.target.files?.[0]; if (file) importBoard(file); event.target.value = ""; });
    const lanes = $("#boardLanes");
    lanes.addEventListener("dragstart", (event) => { const card = event.target.closest("[data-board-id]"); if (!card) return; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", card.dataset.boardId); card.classList.add("is-dragging"); });
    lanes.addEventListener("dragend", (event) => event.target.closest("[data-board-id]")?.classList.remove("is-dragging"));
    lanes.addEventListener("dragover", (event) => { if (event.target.closest("[data-board-drop]")) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; event.target.closest("[data-board-drop]").classList.add("is-over"); } });
    lanes.addEventListener("dragleave", (event) => event.target.closest("[data-board-drop]")?.classList.remove("is-over"));
    lanes.addEventListener("drop", (event) => { const drop = event.target.closest("[data-board-drop]"); if (!drop) return; event.preventDefault(); drop.classList.remove("is-over"); moveCard(event.dataTransfer.getData("text/plain"), drop.dataset.boardDrop); });
    document.addEventListener("keydown", (event) => {
      const boardVisible = !$("#mapBoardView")?.hidden;
      if (!boardVisible) return;
      const typing = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
      else if (!typing && event.key.toLowerCase() === "n") { event.preventDefault(); action("add"); }
    });
    window.addEventListener("abud:map-view", (event) => { if (event.detail?.view === "board") render(); });
    window.addEventListener("abud:refresh", render);
    window.addEventListener("abud:language", render);
    render();
  }
  window.addEventListener("DOMContentLoaded", bind, { once: true });
})();
