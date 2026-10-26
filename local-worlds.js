/* Local Universe bridge: enabled only on loopback hosts. It never runs on GitHub Pages. */
(() => {
  "use strict";
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname);
  if (!localHost) return;
  const $ = (selector) => document.querySelector(selector);
  const en = () => document.documentElement.lang === "en";
  const tr = (ar, english) => en() ? english : ar;
  let latestData = null;
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value || "";
    return node;
  };
  const statusText = (project) => {
    if (project.status === "ready") return project.dirty ? tr("فيه تغييرات محلية", "Local changes") : tr("نظيف", "Clean");
    if (project.status === "missing") return tr("المجلد غير موجود", "Folder missing");
    if (project.status === "invalid-path") return tr("المسار غير صالح", "Invalid path");
    return tr("مش Git أو غير متاح", "Not a Git checkout");
  };
  const statusClass = (project) => project.status === "ready" ? (project.dirty ? "dirty" : "clean") : "error";
  function render(data) {
    latestData = data;
    const section = $("#worlds"), grid = $("#localWorldsGrid"), account = $("#localAccount"), state = $("#localWorldsStatus");
    if (!section || !grid || !account || !state) return;
    section.hidden = false;
    $("#navWorldsLink")?.removeAttribute("hidden");
    state.textContent = data.configured ? tr("مربوط محليًا", "LOCAL CONNECTED") : tr("الإعداد غير موجود", "CONFIG NEEDED");
    const projects = data.worlds.reduce((sum, world) => sum + world.projects.length, 0);
    const ready = data.worlds.reduce((sum, world) => sum + world.projects.filter((project) => project.status === "ready").length, 0);
    $("#localWorldCount").textContent = data.worlds.length;
    $("#localProjectCount").textContent = projects;
    $("#localReadyCount").textContent = ready;
    $("#localWorldsSummary").querySelectorAll("span").forEach((label, index) => {
      label.textContent = [tr("عوالم", "worlds"), tr("مشاريع", "projects"), tr("جاهز محليًا", "ready locally")][index];
    });
    account.replaceChildren(text("strong", data.account ? `@${data.account}` : tr("حساب GitHub غير مكتشف عبر gh", "GitHub CLI account not detected")), text("span", data.githubOwner ? ` · ${data.githubOwner}` : ""));
    grid.replaceChildren();
    if (!data.worlds.length) {
      grid.append(text("p", tr("انسخ local/worlds.example.json إلى local/worlds.json وعدّل المسارات.", "Copy local/worlds.example.json to local/worlds.json and edit the paths."), "local-worlds-empty"));
      return;
    }
    for (const world of data.worlds) {
      const card = document.createElement("article");
      card.className = "local-world-card";
      card.style.setProperty("--world-accent", world.color || "#c084fc");
      card.append(text("div", world.name, "local-world-kicker"), text("h3", en() ? (world.en || world.name) : (world.ar || world.name)), text("p", world.description));
      const list = document.createElement("div");
      list.className = "local-project-list";
      for (const project of world.projects) {
        const item = document.createElement("div");
        item.className = "local-project-card";
        const head = document.createElement("div");
        head.className = "local-project-head";
        head.append(text("strong", project.name), text("span", statusText(project), `local-project-status ${statusClass(project)}`));
        item.append(head);
        if (project.status === "ready") {
          item.append(text("span", `${project.branch || "DETACHED"} · ${project.head || "—"}`, "local-project-meta"));
          if (project.lastCommit?.subject) item.append(text("p", project.lastCommit.subject, "local-project-commit"));
          item.append(text("span", project.remoteMatches ? tr("Remote مطابق", "Remote matches") : tr("راجع Remote", "Check remote"), `local-project-meta ${project.remoteMatches ? "match" : "warning"}`));
          if (project.changedFiles) item.append(text("span", `${project.changedFiles} ${tr("ملف متغير", "changed file(s)")}`, "local-project-meta"));
        }
        if (project.github) {
          const link = document.createElement("a");
          link.href = `https://github.com/${encodeURIComponent(project.github.split("/")[0])}/${encodeURIComponent(project.github.split("/")[1])}`;
          link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = tr("فتح GitHub ↗", "Open GitHub ↗");
          item.append(link);
        }
        list.append(item);
      }
      card.append(list); grid.append(card);
    }
  }
  /* Internal Company OS views. They are served only by the loopback Local Bridge (never shipped to GitHub Pages) and are
   * loaded only after the bridge identifies itself and advertises the "ops" capability. */
  const loadScript = (src) => new Promise((resolve, reject) => {
    const node = document.createElement("script");
    node.src = src; node.async = false; node.onload = resolve; node.onerror = () => reject(new Error("internal-asset-unavailable"));
    document.head.append(node);
  });
  async function loadInternalWorkspace() {
    try {
      const response = await fetch("/local-api/health", { headers: { Accept: "application/json" } });
      if (!response.ok) return null;
      const health = await response.json();
      if (health?.service !== "abud-local-universe" || !health?.capabilities?.ops) return null;
      // The internal loader owns the module list and the stylesheet; nothing about them ships in this public file.
      window.AbudInternalHealth = health;
      await loadScript("./internal/ops-loader.js");
      return health;
    } catch (_) { /* static or public host: the internal workspace simply stays unloaded */ return null; }
  }
  async function boot() {
    const health = await loadInternalWorkspace();
    // The Company OS uses its own scoped workspace scanner. Don't run the legacy all-world Git and gh scan on its home load.
    if (health?.capabilities?.company) return;
    try {
      const response = await fetch("/local-api/worlds", { headers: { Accept: "application/json" } });
      if (!response.ok) throw Error("bridge unavailable");
      render(await response.json());
    } catch (_) {
      render({ configured: false, githubOwner: null, account: null, worlds: [] });
      const state = $("#localWorldsStatus"); if (state) state.textContent = tr("شغّل Local Bridge", "START LOCAL BRIDGE");
    }
  }
  window.addEventListener("DOMContentLoaded", boot, { once: true });
  window.addEventListener("abud:language", () => { if (latestData) render(latestData); });
})();
