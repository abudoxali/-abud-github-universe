import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { chromium } from "playwright";

const ROOT = resolve(process.cwd(), "../.."), PRIVATE = resolve(process.cwd(), "public"), ORIGIN = "https://os.abud.fun";
const screenshotDir = join(homedir(), "Desktop", "ABUD-Universe-Owner-Review");
const sourceIndex = await readFile(resolve(ROOT, "index.html"), "utf8");
const sourceData = await readFile(resolve(ROOT, "data.js"), "utf8");
const catalogContext = { window: {} };
runInNewContext(sourceData, catalogContext);
const catalog = catalogContext.window.ABUD_DATA;
const publicRepos = catalog.repos.map(repo => ({ name: repo.name, private: false, archived: false, default_branch: "main", defaultBranch: "main", html_url: "https://github.com/abudoxali/" + repo.name, owner: { login: "abudoxali", id: 123456 }, visibility: "public", stargazers_count: 3, language: "TypeScript", pushed_at: "2026-10-09T10:00:00Z" }));
const authorizedRepos = [
  { name: "RootRay", private: false, archived: false, defaultBranch: "main", htmlUrl: "https://github.com/abudoxali/RootRay" },
  { name: "repo-public-fixture", private: false, archived: false, defaultBranch: "main", htmlUrl: "https://github.com/abudoxali/repo-public-fixture" },
  { name: "repo-private-fixture", private: true, archived: false, defaultBranch: "main", htmlUrl: "https://github.com/abudoxali/repo-private-fixture" }
];
const base = () => ({
  version: 1, focus: ["RootRay", "repo-private-fixture"], projects: {
    RootRay: { stage: "progress", tasks: [{ id: "pub1", title: "Review public release evidence", done: false }] },
    "repo-private-fixture": { stage: "blocked", tasks: [{ id: "priv1", title: "Synthetic private task fixture", done: false }] }
  }, events: [{ project: "repo-private-fixture", kind: "note", detail: "Synthetic blocker fixture", at: "2026-10-09T10:00:00.000Z" }]
});
let current = { revision: 4, data: base() }, saves = 0, conflictNext = false, privateGitHubCalls = 0;
const failures = [];
await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
function contentType(path) { return ({ ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" })[extname(path)] || "text/plain"; }
function json(route, status, data, headers = {}) { return route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store", ...headers }, body: JSON.stringify(data) }); }
async function setup(page, { guest = false, mobile = false } = {}) {
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin === "https://fonts.googleapis.com") return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    if (url.origin === "https://fonts.gstatic.com") return route.fulfill({ status: 200, contentType: "font/woff2", body: Buffer.from([]) });
    if (url.origin === "https://api.github.com") {
      if (path === "/users/abudoxali/repos") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(url.searchParams.get("page") === "1" ? publicRepos : []) });
      if (path.startsWith("/repos/abudoxali/repo-private-fixture")) { privateGitHubCalls++; return route.fulfill({ status: 404, contentType: "application/json", body: "{}" }); }
      const name = decodeURIComponent(path.split("/")[3] || "");
      if (!publicRepos.some(repo => repo.name === name)) return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      if (path.endsWith("/contents/STATUS.md")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ type: "file", encoding: "base64", size: 75, sha: "public-sha", content: Buffer.from("Status: PUBLIC FIXTURE\nNext Action: Review the public source\n").toString("base64") }) });
      if (path.includes("/commits")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ sha: "publiccommit123", commit: { message: "docs: public evidence fixture", committer: { date: "2026-10-09T10:00:00Z" } } }]) });
      if (path.includes("/actions/runs")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ workflow_runs: [{ name: "Public CI fixture", conclusion: "success", status: "completed", updated_at: "2026-10-09T10:10:00Z", html_url: "https://github.com/abudoxali/RootRay/actions/runs/1" }] }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(publicRepos.find(repo => repo.name === name)) });
    }
    if (url.origin !== ORIGIN) throw Error("Unexpected external origin: " + url.origin);
    if (path === "/" && request.method() === "GET") {
      const html = sourceIndex
        .replace("</head>", '<meta name="robots" content="noindex,nofollow,noarchive"><link rel="stylesheet" href="/assets/universe.css"></head>')
        .replace('<script defer src="./command-center.js"></script>', '<script defer src="/assets/universe.js"></script>\n  <script defer src="./command-center.js"></script>');
      return route.fulfill({ status: 200, contentType: "text/html", body: html });
    }
    const rootAsset = resolve(ROOT, path.slice(1));
    const shared = ["app.js", "command-center.css", "command-center.js", "data.js", "decisions.css", "decisions.js", "favicon.svg", "intelligence.css", "intelligence.js", "reports.css", "reports.js", "styles.css", "workboard.css", "workboard.js"];
    if (shared.includes(path.slice(1))) return route.fulfill({ status: 200, contentType: contentType(rootAsset), body: await readFile(rootAsset) });
    if (path === "/assets/universe.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: await readFile(resolve(PRIVATE, "app.js")) });
    if (path === "/assets/universe.css") return route.fulfill({ status: 200, contentType: "text/css", body: await readFile(resolve(PRIVATE, "style.css")) });
    if (path === "/api/me") return json(route, guest ? 401 : 200, guest ? { error: "unauthorized" } : { owner: "abudoxali", csrf: "f".repeat(64) });
    if (path === "/api/repos") return json(route, 200, { repos: authorizedRepos, updatedAt: new Date().toISOString() });
    if (path === "/api/workboard") {
      if (request.method() === "PUT") {
        const body = request.postDataJSON();
        assert.equal(request.headers()["x-os-csrf"], "f".repeat(64));
        assert.equal(request.headers().origin, ORIGIN);
        assert.equal(body.revision, current.revision);
        assert.ok(body.data.focus.every(name => [...publicRepos.map(repo => repo.name), ...authorizedRepos.map(repo => repo.name)].includes(name)));
        if (conflictNext) { conflictNext = false; current = { revision: current.revision + 1, data: current.data }; return json(route, 409, { error: "version-conflict" }); }
        current = { revision: current.revision + 1, data: body.data }; saves++;
      }
      return json(route, 200, current);
    }
    if (path.startsWith("/api/repos/") && path.endsWith("/status")) {
      const name = decodeURIComponent(path.split("/")[3]);
      if (!authorizedRepos.some(repo => repo.name === name)) return json(route, 404, { error: "not-installed" });
      return json(route, 200, { repo: name, exists: true, sha: "synthetic-status-sha", claims: [{ key: "Status", value: "SYNTHETIC OWNER-APPROVED REVIEW" }, { key: "Next Action", value: "Verify the synthetic fixture workflow" }] });
    }
    if (path === "/api/report.md") return route.fulfill({ status: 200, contentType: "text/markdown", headers: { "Cache-Control": "private, no-store", "Content-Disposition": "attachment; filename=abud-os-private-7d.md" }, body: "# Synthetic private report\nSynthetic private fixture only.\n" });
    if (path === "/api/logout") return json(route, 200, { ok: true });
    throw Error("Unexpected request: " + request.method() + " " + url);
  });
  page.on("pageerror", error => failures.push(error.stack || error.message));
  page.on("console", message => { if (message.type() === "error" && !/(?:409 \(Conflict\)|401 \(Unauthorized\))/.test(message.text())) failures.push(message.text()); });
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
}
try {
  const desktop = await browser.newPage({ acceptDownloads: true });
  await setup(desktop);
  await desktop.goto(ORIGIN + "/", { waitUntil: "domcontentloaded" });
  await desktop.locator("#secureSaveStatus[data-state=saved]").waitFor();
  await desktop.locator("#repoGrid .secure-repo-card").nth(1).waitFor();
  assert.equal(await desktop.locator("html").getAttribute("dir"), "rtl");
  assert.equal(await desktop.locator("#repoGrid .repo-card:not(.secure-repo-card)").count(), catalog.repos.length);
  assert.equal(await desktop.locator("#repoGrid .secure-repo-card").count(), 2, "Public catalog duplicate is not counted twice; unique authorized public and private entries render");
  assert.equal(await desktop.locator("#graphClusters .graph-cluster").count(), 9, "Original eight public categories plus one explicit authorization group");
  assert.equal(await desktop.locator("#graphClusters .secure-map-cluster .graph-repo").count(), 2);
  assert.equal(await desktop.evaluate(() => window.ABUD_RUNTIME.getRepos().some(repo => repo.name === "repo-private-fixture")), false);
  assert.equal(await desktop.locator("#secureDailyFocus").isVisible(), true);
  await desktop.screenshot({ path: join(screenshotDir, "01-universe-home-desktop.png"), fullPage: false });
  console.log("PASS Universe shell: original catalog, identity, daily command center and duplicate-safe secure discovery");

  await desktop.locator("#map").scrollIntoViewIfNeeded();
  await desktop.waitForFunction(() => Number(document.querySelector("#mapWorld").style.height.replace("px", "")) > 1640);
  await desktop.locator("#fitMap").click();
  await desktop.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const initialZoom = Number((await desktop.locator("#zoomValue").textContent()).replace("%", ""));
  await desktop.locator("#zoomIn").click();
  assert.ok(Number((await desktop.locator("#zoomValue").textContent()).replace("%", "")) > initialZoom);
  await desktop.locator("#fitMap").click();
  const transformBefore = await desktop.locator("#mapWorld").evaluate(el => getComputedStyle(el).transform);
  const viewport = await desktop.locator("#mapViewport").boundingBox();
  await desktop.mouse.move(viewport.x + viewport.width * .55, viewport.y + viewport.height * .55);
  await desktop.mouse.down(); await desktop.mouse.move(viewport.x + viewport.width * .55 + 35, viewport.y + viewport.height * .55 + 20); await desktop.mouse.up();
  assert.notEqual(await desktop.locator("#mapWorld").evaluate(el => getComputedStyle(el).transform), transformBefore, "Map panning remains active");
  await desktop.locator("#fitMap").click();
  await desktop.locator("#mapViewport").screenshot({ path: join(screenshotDir, "02-interactive-project-graph-desktop.png") });
  await desktop.locator('#filterChips [data-filter="authorized"]').click();
  assert.equal(await desktop.locator("#repoGrid .secure-repo-card").count(), 2);
  assert.equal(await desktop.locator("#repoGrid .repo-card:not(.secure-repo-card)").count(), 0);
  await desktop.locator("#clearFilters").click();
  await desktop.screenshot({ path: join(screenshotDir, "03-categories-library-desktop.png"), fullPage: false });
  await desktop.locator("#repoSearch").fill("repo-private-fixture");
  assert.equal(await desktop.locator("#repoGrid .secure-repo-card").count(), 1);
  assert.equal(await desktop.locator("#repoGrid .repo-card:not(.secure-repo-card)").count(), 0);
  await desktop.locator("#clearFilters").click();
  assert.equal(await desktop.locator("#relationGrid .relation-card").count(), 6);
  await desktop.locator('#relationModes [data-relation-type="overlap"]').click();
  assert.equal(await desktop.locator("#relationGrid .relation-card").count(), 1);
  await desktop.locator('#relationModes [data-relation-type="all"]').click();
  await desktop.locator("#relationGrid [data-edge]").first().click();
  await desktop.waitForFunction(() => document.querySelectorAll("#graphLines .repo-connection.is-focused").length === 1);
  assert.equal(await desktop.locator("#graphClusters .graph-repo.is-related-focus").count(), 2);
  await desktop.locator('#decisionFilters [data-decision-filter="overlap"]').click();
  assert.equal(await desktop.locator("#decisionList .decision-item").count(), 1);
  await desktop.locator('#decisionFilters [data-decision-filter="all"]').click();
  await desktop.locator('#repoGrid [data-hub="RootRay"]').click();
  await desktop.waitForURL(/#project\/RootRay$/);
  await desktop.locator("#hubCommit").getByText("docs: public evidence fixture").waitFor();
  await desktop.locator("#intelligenceState").getByText("FOUND / PUBLIC").waitFor();
  assert.equal(await desktop.locator("#hubTitle").textContent(), "RootRay");
  await desktop.locator("#hubBack").click();
  await desktop.waitForURL(/#daily$/);
  console.log("PASS original project experience: public Project Hub, STATUS.md evidence, six curated relations, and review filters");
  console.log("PASS map and library: category filter, pan, zoom, fit, authorized-only filter and public/private distinction");

  await desktop.locator('#graphClusters [data-secure-open="repo-private-fixture"]').click();
  await desktop.waitForURL(/#project\/repo-private-fixture$/);
  await desktop.waitForTimeout(200);
  await desktop.locator("#secureStatusEvidence").getByText("SYNTHETIC OWNER-APPROVED REVIEW").waitFor({ timeout: 5000 });
  assert.equal(await desktop.locator("#hubTitle").textContent(), "repo-private-fixture");
  assert.match(await desktop.locator("#hubCategory").textContent(), /PRIVATE/);
  await desktop.locator("#projectHub").screenshot({ path: join(screenshotDir, "04-private-project-hub-desktop.png") });
  assert.equal(privateGitHubCalls, 0, "Private details use the authenticated same-origin API, never public GitHub API calls");
  await desktop.locator("#hubBack").click();
  await desktop.waitForURL(/#daily$/);
  console.log("PASS Project Hub: private visibility marker and STATUS.md evidence come through the authenticated API");

  await desktop.locator('#secureFocusCards [data-work-project="repo-private-fixture"] [data-secure-stage="repo-private-fixture"]').selectOption("review");
  await desktop.locator('#secureFocusCards [data-work-project="repo-private-fixture"] [data-secure-task-form] input').fill("Verify synthetic private task save");
  await desktop.locator('#secureFocusCards [data-work-project="repo-private-fixture"] [data-secure-task-form] button[type="submit"]').click();
  await desktop.locator("#secureDecisionRepo").selectOption("repo-private-fixture");
  await desktop.locator("#secureDecisionText").fill("Synthetic private blocker resolved after review");
  await desktop.locator("#secureDecisionJournal button[type=submit]").click();
  assert.match(await desktop.locator("#secureDecisionEvents").textContent(), /Synthetic private blocker resolved/);
  await desktop.locator("#secureSave").click();
  await desktop.locator("#secureSaveStatus[data-state=saved]").waitFor();
  assert.equal(saves, 1);
  assert.equal(current.data.projects["repo-private-fixture"].stage, "review");
  assert.equal(current.data.projects["repo-private-fixture"].tasks.some(task => task.title === "Verify synthetic private task save"), true);
  assert.equal(current.data.events.some(item => item.detail === "Synthetic private blocker resolved after review"), true);
  assert.ok(!await desktop.evaluate(() => Object.values(localStorage).join(" ")).then(text => text.includes("repo-private-fixture")), "Private project names and data never enter localStorage");
  const exportPromise = desktop.waitForEvent("download");
  await desktop.locator("#secureExport").click();
  const exportFile = await exportPromise;
  const exportData = JSON.parse(await readFile(await exportFile.path(), "utf8"));
  assert.ok(exportData.focus.includes("repo-private-fixture"));
  assert.ok(exportData.projects["repo-private-fixture"].tasks.some(task => task.title === "Verify synthetic private task save"));
  await desktop.screenshot({ path: join(screenshotDir, "05-server-tasks-decisions-desktop.png"), fullPage: false });

  conflictNext = true;
  await desktop.locator('#secureFocusCards [data-work-project="repo-private-fixture"] [data-secure-stage="repo-private-fixture"]').selectOption("blocked");
  await desktop.locator("#secureSave").click();
  await desktop.locator('#secureSaveStatus[data-state="conflict"]').waitFor();
  desktop.once("dialog", dialog => dialog.accept());
  await desktop.locator("#secureReload").click();
  await desktop.locator("#secureSaveStatus[data-state=saved]").waitFor();
  assert.equal(await desktop.locator('#secureFocusCards [data-work-project="repo-private-fixture"] [data-secure-stage="repo-private-fixture"]').inputValue(), "review");
  assert.equal(saves, 1, "Conflicted update is not silently overwritten");

  const reportDownload = desktop.waitForEvent("download");
  await desktop.locator('.secure-report-links a[href="/api/report.md?days=7"]').click();
  assert.match((await reportDownload).suggestedFilename(), /abud-os-private-7d\.md/);
  assert.equal(await desktop.locator("#secureWorkspacePanel").isVisible(), true);
  await desktop.locator("#workboard").scrollIntoViewIfNeeded();
  await desktop.screenshot({ path: join(screenshotDir, "06-private-reports-desktop.png"), fullPage: false });
  const importData = {
    version: 1, focus: ["repo-private-fixture", "unapproved-private-fixture"], projects: {
      "repo-private-fixture": { stage: "blocked", tasks: [{ id: "imported", title: "Synthetic imported task", done: false }] },
      "unapproved-private-fixture": { stage: "done", tasks: [{ id: "hidden", title: "Never import unapproved repo", done: false }] }
    }, events: [{ project: "repo-private-fixture", kind: "note", detail: "Synthetic imported decision", at: new Date().toISOString() }, { project: "unapproved-private-fixture", kind: "note", detail: "Must be dropped", at: new Date().toISOString() }]
  };
  desktop.once("dialog", dialog => dialog.accept());
  await desktop.locator("#secureImportFile").setInputFiles({ name: "private-workspace.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(importData)) });
  await desktop.locator('#secureSaveStatus[data-state="dirty"]').waitFor();
  assert.equal(await desktop.locator("#secureFocusCards .secure-focus-card").count(), 1);
  assert.ok(!(await desktop.locator("#secureFocusCards").textContent()).includes("unapproved-private-fixture"));
  assert.equal(saves, 1, "Import stays an unsaved draft until explicit save");
  console.log("PASS server workspace: task/stage/decision save, reload, 409 conflict, safe opt-in import/export, no browser persistence and private report download");

  await desktop.locator("#languageButton").click();
  assert.equal(await desktop.locator("html").getAttribute("lang"), "en");
  assert.equal(await desktop.locator("html").getAttribute("dir"), "ltr");
  await desktop.locator("#languageButton").click();
  assert.equal(await desktop.locator("html").getAttribute("dir"), "rtl");
  const mobile = await browser.newPage({ acceptDownloads: true });
  await setup(mobile, { mobile: true });
  await mobile.goto(ORIGIN + "/", { waitUntil: "domcontentloaded" });
  await mobile.locator("#secureSaveStatus[data-state=saved]").waitFor();
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, "Secure Universe mobile layout must not overflow");
  await mobile.screenshot({ path: join(screenshotDir, "07-universe-home-mobile-arabic.png"), fullPage: false });
  await mobile.locator("#mobileMenu").click();
  assert.equal(await mobile.locator("#sidebar").evaluate(el => el.classList.contains("mobile-open")), true);
  await mobile.waitForTimeout(300);
  await mobile.screenshot({ path: join(screenshotDir, "08-mobile-navigation-arabic.png"), fullPage: false });
  await mobile.keyboard.press("Escape");
  await mobile.waitForFunction(() => !document.querySelector("#sidebar").classList.contains("mobile-open"));
  await mobile.locator('#graphClusters [data-secure-open="repo-private-fixture"]').click();
  await mobile.locator("#secureStatusEvidence").getByText("SYNTHETIC OWNER-APPROVED REVIEW").waitFor();
  await mobile.locator("#secureProjectTools").screenshot({ path: join(screenshotDir, "09-private-project-hub-mobile.png") });
  await mobile.locator("#languageButton").click();
  assert.equal(await mobile.locator("html").getAttribute("dir"), "ltr");
  assert.equal(failures.length, 0, failures.join("\n"));
  console.log("PASS Chromium: Arabic RTL, English LTR, mobile navigation, private Hub and no horizontal overflow");
  console.log("SCREENSHOTS: " + screenshotDir);

  const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await setup(guest, { guest: true, mobile: true });
  await guest.goto(ORIGIN + "/", { waitUntil: "domcontentloaded" });
  await guest.locator("#secureAccount .secure-auth-link").waitFor();
  assert.equal(await guest.locator("#secureWorkspacePanel").count(), 0);
  assert.equal(await guest.locator(".secure-repo-card").count(), 0);
  assert.equal(await guest.evaluate(() => window.ABUD_RUNTIME.getRepos().some(repo => repo.name === "repo-private-fixture")), false);
  assert.equal(failures.length, 0, failures.join("\n"));
  console.log("PASS access boundary: guest receives only the public Universe and sign-in link");
} finally { await browser.close(); }
