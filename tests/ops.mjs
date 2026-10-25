/* Browser-level verification of the internal Company OS V2 (loopback bridge) against SYNTHETIC fixtures: a stub OmniRoute and
 * temporary git repositories. These are automated tests only; live-router verification is documented separately in STATUS.md. */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { runInNewContext } from "node:vm";
import { chromium } from "playwright";
import { createServer } from "../apps/local-bridge/src/server.mjs";
import { TEST_KEY, startStubRouter } from "../apps/local-bridge/tests/fixtures.mjs";

const root = process.cwd();
const catalogContext = { window: {} };
runInNewContext(await readFile(resolve(root, "data.js"), "utf8"), catalogContext);
const catalog = catalogContext.window.ABUD_DATA;
const publicName = catalog.repos[0].name;

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
async function repo(parent, name, remote) {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), "# t\n");
  await writeFile(join(dir, "STATUS.md"), "# T\nUpdated: 2030-01-01\nState: Testing\n");
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", `commit in ${name}`);
  if (remote) git(dir, "remote", "add", "origin", remote);
  return dir;
}

const work = await mkdtemp(join(tmpdir(), "abud-ops-e2e-"));
const workspace = join(work, "GitHub");
await mkdir(workspace);
await repo(workspace, publicName, `https://github.com/${catalog.owner}/${publicName}.git`);
await repo(workspace, "private-tool", `git@github.com:${catalog.owner}/private-tool.git`);
await repo(workspace, "private-tool-copy", `https://github.com/${catalog.owner}/private-tool`);
await repo(workspace, "scratch", null);
const dirty = await repo(workspace, "dirty-one", null);
await writeFile(join(dirty, "wip.txt"), "x");
await writeFile(join(work, "worlds.json"), JSON.stringify({ githubOwner: catalog.owner, worlds: [] }));

// Synthetic VPS (documentation address, fake transport): the real local/vps.json is never read by tests.
const FP = "SHA256:TESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTES";
await writeFile(join(work, "vps.json"), JSON.stringify({ hosts: [{ id: "lab", name: "Lab VPS", provider: "Test", address: "203.0.113.10", sshUser: "root", hostKeyFingerprint: FP, expectedHostname: "lab-host", identityFile: "C:/TEST/id_SHOULD_NOT_LEAK",
  profile: { environments: { production: { base: "/var/www/lab", url: "https://lab.example.test", healthPath: "/api/health" } }, pm2: [{ user: "lab", services: [{ name: "lab-api", environment: "production" }] }], systemd: ["nginx"], databases: [] } }] }));
const labBasic = ["@@hostname", "lab-host", "@@machine", "abc", "@@os", "Ubuntu 24.04 LTS", "6.8", "@@uptime", "90000 1", "@@load", "0.1 0.1 0.1 1/1 1", "2", "@@cpu", "cpu 1 0 1 98 0 0 0 0", "cpu 2 0 2 196 0 0 0 0",
  "@@mem", "MemTotal: 4000000 kB", "MemAvailable: 3000000 kB", "SwapTotal: 0 kB", "SwapFree: 0 kB", "@@df", "/dev/sda1 100000000000 40000000000 60000000000 40% /", "@@systemd", "nginx active", "@@failed", "@@pm2:lab", "lab-api\tonline\t1\t0\t1700000000000\t104857600\t0.3\tfork_mode"].join("\n");
const vpsOptions = {
  transport: { exec: async (h, script) => ({ ok: true, code: 0, ms: 12, fingerprint: FP, stdout: script.includes("@@hostname") ? labBasic : script.includes("@@deploy:") ? "@@deploy:production\n/var/www/lab/releases/20261020-101010\nabcdef1234567\nmain\n2026-10-20T10:10:10Z\n20261019-101010\n20261020-101010\n@@pg\naccepting\n16.1\n3\n@@nginx\nnginx version: nginx/1.24.0\n-\n@@boots\n" : "ok\n" }) },
  siteChecker: async (url) => ({ url, health: { status: 200, ms: 40, body: { status: "ok", database: "connected", commit: "abcdef1234567" } }, root: { status: 200, ms: 30 }, checkedAt: new Date().toISOString() }),
  certChecker: async (hostname) => ({ hostname, ok: true, daysLeft: 50, validTo: "2030-01-01T00:00:00.000Z", issuer: "Test CA" })
};

async function startBridge({ router, vps = false }) {
  const env = { OMNIROUTE_BASE_URL: router, OMNIROUTE_API_KEY: TEST_KEY, ABUD_WORKSPACE_ROOTS: workspace };
  const server = createServer({
    root, configPath: join(work, "worlds.json"), workspaceConfigPath: join(work, "none.json"), policyPath: join(work, "policy.json"), dbPath: ":memory:", env,
    vpsConfigPath: join(work, vps ? "vps.json" : "no-vps.json"), vpsOptions: vps ? vpsOptions : {}, startupOptions: { env: {}, platform: "test" },
    agentOptions: { home: work, platform: "win32", env: {}, runImpl: async (file) => file === "tasklist" ? { ok: true, stdout: '"codex.exe","1"\n' } : file === "claude" ? { ok: true, stdout: "2.0.0 (Claude Code)" } : { ok: false, reason: "not-found" } },
    githubReader: { resolve: async () => ({ state: "unavailable" }), read: async (github) => ({ state: github ? "connected" : "not-linked", github, fetchedAt: new Date().toISOString(), cached: false, unavailable: [], repository: { private: false, default_branch: "main" }, issues: [], pullRequests: [], workflows: [], releases: [], commits: [], branches: [] }) }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const stub = await startStubRouter();
const online = await startBridge({ router: `http://127.0.0.1:${stub.port}`, vps: true });
const offline = await startBridge({ router: "http://127.0.0.1:9" });

// Static "Pages" server containing exactly the public artifact files (mirrors the workflow's cp list).
const PUBLIC = ["index.html", "styles.css", "command-center.css", "intelligence.css", "decisions.css", "workboard.css", "reports.css", "local-worlds.css", "universe-experience.css", "project-map.css", "project-board.css", "app.js", "command-center.js", "intelligence.js", "decisions.js", "workboard.js", "reports.js", "universe-experience.js", "project-map.js", "project-board.js", "local-worlds.js", "data.js", "favicon.svg"];
const siteDir = join(work, "_site");
await mkdir(siteDir);
for (const file of PUBLIC) await copyFile(resolve(root, file), join(siteDir, file));
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const site = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://x").pathname.replace(/^\/$/, "/index.html");
    const body = await readFile(join(siteDir, path.slice(1)));
    res.writeHead(200, { "Content-Type": types[extname(path)] || "text/plain" }); res.end(body);
  } catch (_) { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const siteOrigin = `http://127.0.0.1:${site.address().port}`;

const browser = await chromium.launch();
const errors = [];
async function open(origin, { mobile = false, lang = "ar" } = {}) {
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true } : { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${origin} pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_|Failed to load resource|api\.github\.com/.test(m.text())) errors.push(`${origin} console: ${m.text()}`); });
  await page.route(/api\.github\.com|fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 403, contentType: "application/json", body: "{}" }));
  await page.addInitScript((l) => { try { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("abud-universe-language", l); sessionStorage.setItem("seeded", "1"); } } catch (_) { } }, lang);
  return page;
}
const text = (page, selector) => page.locator(selector).first().innerText();
const noOverflow = async (page, label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, `horizontal overflow on ${label}`);

const go = async (page, hash, selector) => { await page.evaluate((h) => { location.hash = h; }, hash); if (selector) await page.waitForSelector(selector); else await page.waitForTimeout(350); };
const api = (page, path) => page.evaluate((p) => fetch(`/local-api/company${p}`).then((r) => r.json()), path);
const VIEWS = ["hq", "projects", "work", "agents", "resources", "system"];
const TABS = { projects: ["overview", "all", "universe", "local", "reports"], work: ["today", "board", "calendar", "upcoming", "project", "agent", "done"], agents: ["team", "chat", "memory", "knowledge", "request", "runs"], resources: ["overview", "quotas", "usage", "providers", "routing", "nex"], system: ["overview", "servers", "integrations", "activity", "data", "security", "settings"] };

try {
  // ---------------------------------------------------------------- shell: six workspaces, Arabic RTL, legacy routes
  const page = await open(online.origin, { lang: "en" });
  await page.goto(online.origin + "/");
  await page.waitForSelector("body.ops-mode #hqView .hq-hero");
  assert.equal(await page.evaluate(() => document.documentElement.dir), "rtl", "the Company OS is Arabic RTL even when the public site was in English");
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("os-booting")), false, "boot guard removed after mount");
  assert.deepEqual(await page.locator(".os-nav .os-nav-label").allInnerTexts(), ["الرئيسية", "المشاريع", "العمل", "الوكلاء", "الموارد الذكية", "النظام"]);
  assert.equal(await page.locator("#sidebar").isVisible(), false, "the public Universe sidebar is replaced");
  for (const [legacy, view, tab] of [["#view/overview", "hq", null], ["#view/universe", "projects", "universe"], ["#view/workboard", "work", null], ["#view/usage", "resources", "overview"], ["#view/infra", "system", "overview"], ["#view/activity", "system", "activity"], ["#view/settings", "system", "settings"], ["#map", "projects", "universe"], ["#decisions", "projects", "reports"], ["#agentSystem", "system", "integrations"]]) {
    await go(page, legacy);
    assert.equal(await page.evaluate(() => document.body.dataset.osView), view, `${legacy} → ${view}`);
    if (tab) assert.equal(await page.evaluate(() => document.body.dataset.osTab), tab, `${legacy} → ${view}/${tab}`);
    assert.ok((await page.evaluate(() => location.hash)).startsWith(`#view/${view}`), `${legacy} rewritten to a V2 route`);
  }
  // Only one workspace and one tab are visible at a time.
  await go(page, "#view/resources/quotas", "#opsUsage .ops-provider");
  assert.equal(await page.locator("#hqView").isVisible(), false);
  assert.equal(await page.locator("#coResources").isVisible(), false, "the overview tab is hidden while quotas are shown");
  // Global search finds agents and projects from local data.
  await page.fill(".os-search-input", "LUNA");
  await page.waitForSelector('.os-search-results .os-search-item:has-text("LUNA")');
  await page.keyboard.press("Escape");
  console.log("PASS shell: Arabic RTL, six workspaces, contextual tabs, legacy routes and anchors redirected, global search");

  // ---------------------------------------------------------------- AI resources: live quotas, analytics, provenance
  const codex = page.locator('#opsUsage .ops-provider[data-provider="codex"]');
  assert.match(await codex.innerText(), /مُبلَّغ من المزوّد/);
  assert.match(await codex.innerText(), /4% متبقٍ/);
  assert.match(await codex.innerText(), /حرج/);
  assert.match(await codex.innerText(), /96 \/ 100 من الحصة/);
  const agy = page.locator('#opsUsage .ops-provider[data-provider="agy"]');
  assert.match(await agy.innerText(), /Claude & GPT Models · Weekly[\s\S]*نفد/);
  assert.match(await agy.innerText(), /نفدت بعض النوافذ/);
  assert.match(await page.locator('#opsUsage .ops-provider[data-provider="nvidia"]').innerText(), /لا يكشف الحصة[\s\S]*لا نستنتج حصة من عدد التوكنز/);
  assert.match(await text(page, "#opsUsage"), /قفل مؤقت[\s\S]*claude-opus/);
  assert.match(await text(page, "#opsUsage"), /مراقبة حصص موثوقة لـ 0 من 3/);
  assert.equal(await page.locator('#opsUsage .ops-meter[role="meter"]').first().getAttribute("aria-valuemin"), "0");
  await go(page, "#view/resources/usage", "#opsUsage .ops-tiles");
  const usageText = await text(page, "#opsUsage");
  assert.match(usageText, /الطلبات\s*100/);
  assert.match(usageText, /التكلفة التقديرية\s*\$1\.50[\s\S]*ليست فاتورة/);
  assert.match(usageText, /مرصود من الراوتر/);
  assert.match(usageText, /اختبارات اتصال يجريها الراوتر نفسه/);
  assert.match(await text(page, "#rsUsage"), /قياس التطبيق/);
  assert.ok(await page.locator("#opsUsage svg.ops-chart").count() === 1);
  const rangeRequest = page.waitForRequest((r) => r.url().includes("/local-api/omniroute/usage?range=30d"));
  await page.click('#opsUsage .ops-seg:has-text("30d")');
  await rangeRequest;
  await go(page, "#view/resources/providers", '#opsUsage tr[data-provider="codex"]');
  assert.match(await text(page, '#opsUsage tr[data-provider="codex"]'), /مُبلَّغة/);
  console.log("PASS resources: provider-reported quotas, exhausted/critical states, unknown-quota honesty, analytics, estimate labelling, range filter, providers");

  // Manual reconciliation persists on this device and compares with the provider-reported value.
  await go(page, "#view/resources/quotas", "#opsManualWindow");
  await page.selectOption("#opsManualWindow", { index: 0 });
  await page.fill("#opsManualValue", "40");
  await page.click('#opsUsage button:has-text("حفظ على هذا الجهاز")');
  assert.match(await text(page, "#opsUsage .ops-manual"), /إدخال يدوي[\s\S]*40\.0%[\s\S]*مقابل المُبلَّغ الآن/);
  await page.reload(); await page.waitForSelector("body.ops-mode");
  await go(page, "#view/resources/quotas", "#opsUsage .ops-manual");
  console.log("PASS resources: manual quota reconciliation stored locally and compared, survives reload");

  // ---------------------------------------------------------------- local developer tools (system → integrations)
  await go(page, "#view/system/integrations", "#agentSystem .ops-agent");
  const toolIds = await page.locator("#agentSystem .ops-agent").evaluateAll((n) => n.map((e) => e.dataset.agent || e.outerHTML.slice(0, 120)));
  assert.equal(toolIds.length, 3, JSON.stringify(toolIds));
  const agentsText = await text(page, "#agentSystem");
  assert.equal((agentsText.match(/التنفيذ معطّل(?!ة)/g) || []).length, 3, "one execution-disabled badge per tool");
  assert.match(agentsText, /غير مكشوفة/);
  assert.match(agentsText, /غير مدعومة آليًا/);
  assert.equal(await page.locator("#agentSystem button:has-text('تشغيل'), #agentSystem button:has-text('إيقاف')").count(), 0, "no agent control buttons");
  assert.match(await text(page, "#sysIntegrations"), /مفتاح API مُعدّ[\s\S]*نعم/);
  console.log("PASS system: developer-tool discovery separates provider health, process presence and sessions; execution disabled");

  // ---------------------------------------------------------------- universe views stay intact inside the Projects hub
  await go(page, "#view/projects/universe/u-map", "#map");
  assert.ok(await page.locator("#mapWorld .map-node, #mapWorld [data-node], #mapWorld button").count() > 0, "graph nodes render");
  await page.click("#mapListViewToggle");
  assert.equal(await page.locator("#mapListView").isVisible(), true);
  await page.click("#mapBoardViewToggle");
  assert.equal(await page.locator("#mapBoardView").isVisible(), true);
  assert.ok(await page.locator("#mapBoardView .board-lane, #mapBoardView [data-lane]").count() >= 4, "Now/Next/Ideas/Parked lanes");
  await page.click("#mapGraphView");
  await go(page, "#view/projects/universe/u-library", "#library");
  assert.equal(await page.locator("#map").isVisible(), false, "only the selected Universe part is shown");
  await page.evaluate(() => localStorage.setItem("abud-universe-project-board-v1", JSON.stringify({ version: 1, custom: [{ id: "n1", title: "my note" }], placements: {}, collapsed: {}, focusOnly: false })));
  const boardBefore = await page.evaluate(() => localStorage.getItem("abud-universe-project-board-v1"));
  console.log("PASS projects: Graph / List / Board and the other Universe parts remain functional inside the Projects hub");

  // ---------------------------------------------------------------- projects: sync, repository manager, manual links in the company store
  await go(page, "#view/projects/all", "#coProjects .pj-toolbar");
  await page.click('#osPageHead button:has-text("مزامنة من GitHub والمجلدات")');
  await page.waitForFunction((name) => document.querySelector("#coProjects")?.innerText.includes(name), publicName);
  await go(page, "#view/projects/local", '#prjLocal .pj-repo-row[data-rel="scratch"]');
  const repo = (rel) => page.locator(`#prjLocal .pj-repo-row[data-rel="${rel}"]`);
  assert.match(await repo(publicName).innerText(), /مربوط بهوية Remote/);
  assert.match(await repo("scratch").innerText(), /بلا Remote/);
  assert.match(await repo("dirty-one").innerText(), /تغيير محلي/);
  assert.match(await repo("private-tool").innerText(), /نسخة مكررة/, "two checkouts of the same remote are flagged");
  assert.ok(!(await page.content()).includes(work.replace(/\\/g, "\\\\")), "no absolute path in DOM");
  await repo("scratch").locator("summary").click();
  await repo("scratch").locator("select").selectOption({ label: publicName });
  await repo("scratch").locator('button:has-text("ربط")').click();
  await page.waitForFunction(() => /ربط يدوي/.test(document.querySelector('#prjLocal .pj-repo-row[data-rel="scratch"]')?.innerText || ""));
  await page.reload(); await page.waitForSelector("body.ops-mode");
  await go(page, "#view/projects/local", '#prjLocal .pj-repo-row[data-rel="scratch"]');
  await page.waitForFunction(() => /ربط يدوي/.test(document.querySelector('#prjLocal .pj-repo-row[data-rel="scratch"]')?.innerText || ""));
  const linked = (await api(page, "/projects")).projects.find((p) => p.checkouts.some((c) => c.rel === "scratch"));
  assert.equal(linked?.name, publicName, "the manual link lives in the company store");
  await repo("scratch").locator("summary").click();
  await repo("scratch").locator('button:has-text("فك الربط")').click();
  await page.click('.os-dialog button:has-text("فك الربط")');
  await page.waitForFunction(() => /بلا Remote/.test(document.querySelector('#prjLocal .pj-repo-row[data-rel="scratch"]')?.innerText || ""));
  const refreshReq = page.waitForRequest((r) => /\/local-api\/workspace\?refresh=scratch/.test(r.url()));
  await repo("scratch").locator("summary").click();
  await repo("scratch").locator('button:has-text("إعادة الفحص")').click();
  await refreshReq;
  assert.equal(await page.evaluate(() => localStorage.getItem("abud-universe-project-board-v1")), boardBefore, "board state untouched by Company OS usage");
  console.log("PASS projects: sync, remote-identity links, duplicates, manual link/unlink persisted in the store, targeted refresh, board state preserved");

  // Project detail page: one coherent page per project; focus flag capped by the store.
  const project = (await api(page, "/projects")).projects.find((p) => p.name === publicName);
  await go(page, `#view/projects/p/${encodeURIComponent(project.id)}`, "#prjDetail .os-tabs");
  assert.equal(await page.evaluate(() => document.getElementById("osPageTitle").innerText), publicName);
  await page.click('#osPageHead button:has-text("تركيز")');
  await page.waitForFunction(() => /مشروع تركيز/.test(document.querySelector("#prjDetail")?.innerText || ""));
  for (const tab of ["المهام", "المستودع", "الوكلاء والتشغيلات", "الملاحظات والقرارات", "النشاط"]) {
    await page.click(`#prjDetail .os-tab:has-text("${tab}")`);
    if (tab === "المستودع") await page.waitForFunction(() => /GitHub البعيد/.test(document.querySelector("#prjDetail")?.innerText || "") && /الفرع الافتراضي/.test(document.querySelector("#prjDetail")?.innerText || ""));
    await page.waitForTimeout(250);
    await noOverflow(page, `project detail ${tab}`);
  }
  console.log("PASS projects: detail page with tabs, focus project persisted");

  // ---------------------------------------------------------------- secrets never reach the browser
  await go(page, "#view/system/security", "#sysSecurity .sy-card");
  assert.match(await text(page, "#sysSecurity"), /بيانات الشركة فقط/);
  await go(page, "#view/system/overview", "#opsInfra .sy-card");
  assert.match(await text(page, "#opsInfra"), /البنية البعيدة/);
  await page.waitForSelector("#sysStartup .sy-card");
  assert.match(await text(page, "#sysStartup"), /التشغيل عند تسجيل الدخول/);

  // VPS Operations Center (synthetic host + fake transport): live state, services, approval card with exact target.
  await page.evaluate(async () => { const t = (await (await fetch("/local-api/session")).json()).token; await fetch("/local-api/company/vps/hosts/lab/probe", { method: "POST", headers: { "Content-Type": "application/json", "X-Abud-Session": t }, body: "{}" }); });
  await go(page, "#view/system/servers", "#sysServers .vps-host");
  await page.waitForFunction(() => /lab-api/.test(document.querySelector("#sysServers")?.innerText || "") && /متصل/.test(document.querySelector("#sysServers")?.innerText || ""));
  await page.click('#sysServers button:has-text("اقتراح إعادة تشغيل")');
  await page.fill(".co-drawer textarea", "اختبار مسار الموافقة في الواجهة");
  await page.click('.co-drawer button:has-text("إنشاء الاقتراح")');
  await page.waitForSelector("#sysServers .vps-approval");
  const card = await text(page, "#sysServers .vps-approval");
  assert.match(card, /pm2 restart lab-api/);
  assert.match(card, /للتأكيد اكتب «lab-api»/);
  assert.match(card, /الإنتاج/);
  await noOverflow(page, "system servers");
  console.log("PASS servers: live host state, services, proposal → approval card naming the exact command and target");

  await go(page, "#view/system/activity", "#coActivity .co-activity li");
  const everything = await page.content();
  for (const secret of [TEST_KEY, "OIDC-SECRET", "SECRET-SHOULD-NOT-LEAK", "owner@example.com", "id_SHOULD_NOT_LEAK"]) assert.ok(!everything.includes(secret), `secret ${secret} reached the browser`);
  assert.ok(!(await page.evaluate(() => JSON.stringify({ ...localStorage }))).includes(TEST_KEY), "no credential in localStorage");
  console.log("PASS system: overview/security/activity truthful; no secret in DOM or localStorage");

  // Every workspace and tab renders without horizontal overflow on desktop.
  for (const view of VIEWS) for (const tab of TABS[view] || [null]) { await go(page, tab ? `#view/${view}/${tab}` : `#view/${view}`); await noOverflow(page, `desktop ${view}/${tab || ""}`); }
  console.log("PASS layout: no horizontal overflow on any desktop workspace or tab");

  // ---------------------------------------------------------------- mobile
  const mobile = await open(online.origin, { mobile: true, lang: "ar" });
  await mobile.goto(online.origin + "/");
  await mobile.waitForSelector("body.ops-mode");
  await mobile.click(".os-menu-toggle");
  await mobile.waitForFunction(() => document.body.classList.contains("os-side-open"));
  await mobile.click('.os-nav-link[data-view="resources"]');
  await mobile.waitForFunction(() => document.body.dataset.osView === "resources" && !document.body.classList.contains("os-side-open"));
  for (const view of VIEWS) for (const tab of TABS[view] || [null]) { await go(mobile, tab ? `#view/${view}/${tab}` : `#view/${view}`); await noOverflow(mobile, `mobile ${view}/${tab || ""}`); }
  await go(mobile, "#view/system/servers", "#sysServers .vps-approval");
  assert.match(await text(mobile, "#sysServers .vps-approval"), /pm2 restart lab-api/);
  await mobile.fill("#sysServers .vps-approval input", "lab-api");
  await mobile.click('#sysServers .vps-approval button:has-text("موافقة وتنفيذ")');
  const dialog = await mobile.locator('.os-dialog[role="alertdialog"]');
  await dialog.waitFor();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= 391, "mobile approval dialog stays inside the viewport");
  await mobile.click('.os-dialog button:has-text("إلغاء")');
  console.log("PASS mobile: off-canvas navigation closes after use, no horizontal overflow on any workspace or tab");

  // ---------------------------------------------------------------- router offline
  const down = await open(offline.origin, { lang: "ar" });
  await down.goto(offline.origin + "/#view/resources/quotas");
  await down.waitForSelector("#opsUsage .ops-notice-bad");
  assert.match(await text(down, "#opsUsage"), /OmniRoute غير متاح/);
  assert.equal(await down.locator("#opsUsage .ops-provider").count(), 0, "no quota cards without data");
  await go(down, "#view/system/integrations", "#agentSystem .ops-agent");
  assert.match(await text(down, "#agentSystem"), /حالة المزوّد غير متاحة/);
  await go(down, "#view/hq", "#hqView .os-kpis");
  await down.waitForFunction(() => /غير متصل/.test(document.querySelector("#hqView .os-kpis")?.innerText || ""));
  assert.match(await text(down, "#hqView"), /OmniRoute غير متصل/, "HQ raises the router outage as an attention item");
  assert.match(await text(down, "#hqView .hq-summary"), /الوكلاء متوقفون حتى يعود اتصال OmniRoute/, "agents are not described as on standby while they cannot run");
  const health = await text(down, "#hqView .hq-resource");
  assert.match(health, /وكلاء بلا نموذج مؤهل\s*غير معروف حاليًا/);
  assert.doesNotMatch(health, /لا ضغط|لا أحد/, "unknown quota pressure and eligibility are not reported as none");
  console.log("PASS offline: router outage shown explicitly in resources, system and HQ; no fabricated quota or provider state");

  // ---------------------------------------------------------------- HQ + work hub: one task system everywhere
  const co = await open(online.origin, { lang: "ar" });
  await co.goto(online.origin + "/#view/hq");
  await co.waitForSelector("#hqView .os-kpis");
  assert.equal(await co.locator("#hqView .hq-crew a").count(), 6);
  console.log("PASS hq: hero, live KPIs and the six-agent crew");

  await go(co, "#view/work/today", "#coWork .co-quickadd");
  await co.fill('#coWork .co-quickadd input[name="title"]', "مهمة اختبار دائمة");
  await co.selectOption('#coWork .co-quickadd select[name="assignee"]', "luna");
  await co.click('#coWork .co-quickadd button[type="submit"]');
  await co.waitForFunction(async () => (await fetch("/local-api/company/tasks").then((r) => r.json())).tasks.some((t) => t.title === "مهمة اختبار دائمة"));
  await co.waitForFunction(() => document.activeElement?.name === "title", null, { timeout: 4000 }); // focus returns to the title for the next task
  await co.waitForTimeout(800);
  assert.equal(await co.evaluate(() => document.activeElement?.name), "title", "background refreshes keep focus in the quick-add title");
  await go(co, "#view/work/agent");
  await co.waitForFunction(() => /مهمة اختبار دائمة/.test(document.querySelector("#coWorkBody")?.innerText || ""));
  await co.reload();
  await co.waitForSelector("#coWorkBody .co-task");
  assert.match(await text(co, "#coWorkBody"), /مهمة اختبار دائمة/, "task persisted in the company store");
  await go(co, "#view/agents/luna/tasks", '#coWorkforce .co-task:has-text("مهمة اختبار دائمة")');
  await go(co, "#view/hq", "#hqView .os-kpis");
  assert.equal((await api(co, "/summary")).tasks.open >= 1, true, "HQ summary counts the same task");
  await go(co, "#view/work/agent", '#coWorkBody .co-task:has-text("مهمة اختبار دائمة")');
  await co.click('#coWorkBody .co-task:has-text("مهمة اختبار دائمة") .co-check');
  await co.waitForFunction(() => !/مهمة اختبار دائمة/.test(document.querySelector("#coWorkBody")?.innerText || ""));
  await go(co, "#view/work/done");
  await co.waitForFunction(() => document.querySelector("#coWorkBody .co-task.co-task-done")?.innerText.includes("مهمة اختبار دائمة") || false);
  await co.click('#coWorkBody .co-task:has-text("مهمة اختبار دائمة") .co-task-title');
  await co.click('button:has-text("أرشفة المهمة")');
  await co.click('.os-dialog button:has-text("أرشفة")');
  await co.waitForFunction(() => /مهمة اختبار دائمة/.test(document.querySelector("#coWorkBody")?.innerText || "") && /الأرشيف/.test(document.querySelector("#coWorkBody")?.innerText || ""));
  assert.equal((await api(co, "/tasks")).tasks.some((t) => t.title === "مهمة اختبار دائمة"), false, "archived task leaves active list");
  await co.click('#coWorkBody button:has-text("مهمة اختبار دائمة")');
  await co.click('button:has-text("استعادة المهمة")');
  await co.waitForFunction(async () => (await fetch("/local-api/company/tasks").then((r) => r.json())).tasks.some((t) => t.title === "مهمة اختبار دائمة"));
  await go(co, "#view/work/calendar", "#coWorkBody .co-cal-grid");
  assert.equal(await co.locator("#coWorkBody .co-weekday").first().innerText(), "السبت", "weeks start on Saturday");
  await go(co, "#view/work/board", "#coWorkBody .co-board");
  assert.equal(await co.locator("#coWorkBody .co-board .co-col").count(), 6);
  console.log("PASS work: one task store across Work Hub, agent workspace and HQ; persistence, completion, archive/restore, done/calendar/board views");

  // ---------------------------------------------------------------- agents: identities, request composer, real (stub) run
  await go(co, "#view/agents", "#coWorkforce .ag-card");
  assert.equal(await co.locator("#coWorkforce .ag-card").count(), 6);
  assert.equal(await co.locator("#coWorkforce .ag-card svg.rb-robot").count(), 6, "team figures are code-rendered");
  assert.deepEqual((await co.locator("#coWorkforce .ag-card svg.rb-robot").evaluateAll((nodes) => nodes.map((svg) => svg.dataset.agent))).sort(), ["luna", "mia", "nex", "ori", "rex", "zen"]);
  assert.equal(await co.locator("#coWorkforce .ag-card svg.rb-robot").first().evaluate((svg) => svg.viewBox.baseVal.height), 325, "approved full-body viewBox is active");
  for (const name of ["ORI", "MIA", "NEX", "LUNA", "ZEN", "REX"]) assert.match(await text(co, "#coWorkforce .ag-grid"), new RegExp(name));
  // The stub router has no Gemini connection: point LUNA's policy domain at the stub's API-key provider (via the real API).
  await co.evaluate(() => window.AbudOps.mutate("PATCH", "/policies/admin", { candidates: ["nvidia/model-a"] }));
  await go(co, "#view/agents/request", "#coWorkforce .co-composer");
  await co.click('#coWorkforce .ag-pick:has-text("LUNA")');
  await co.selectOption('#coWorkforce .co-composer select[name="capability"]', "task_breakdown");
  await co.fill('#coWorkforce .co-composer textarea[name="request"]', "جهّزي قائمة متابعة لإطلاق الإصدار");
  await co.click('#coWorkforce .co-composer button[type="submit"]');
  await co.waitForFunction(() => location.hash === "#view/agents/luna/runs");
  await co.waitForSelector("#coWorkforce .ag-ws-hero");
  await co.waitForSelector("#coWorkforce .co-run-succeeded", { timeout: 20000 });
  await co.click('#coWorkforce .co-run-succeeded button:has-text("النتيجة")');
  await co.waitForSelector(".co-drawer .co-output");
  assert.match(await text(co, ".co-drawer .co-output"), /رد تجريبي/);
  assert.match(await co.locator(".co-drawer").textContent(), /لماذا هذا النموذج/);
  await co.keyboard.press("Escape");
  for (const sub of ["tools", "routing", "memory", "settings", "art"]) {
    await go(co, `#view/agents/luna/${sub}`);
    await co.waitForSelector('#coWorkforce .os-tab[aria-current="page"]');
    assert.equal(await co.locator('#coWorkforce .os-tab[aria-current="page"]').getAttribute("href"), `#view/agents/luna/${sub}`);
  }
  console.log("PASS agents: six code-rendered identities; request composer → LUNA run persisted and explained; workspace tabs");

  await go(co, "#view/agents/chat", "#coWorkforce .co-chat-new");
  await co.locator("#coWorkforce .co-chat-new select[name=agentId]").selectOption("ori");
  await co.click("#coWorkforce .co-chat-new button[type=submit]");
  const chatFile = join(work, "chat-note.md");
  await writeFile(chatFile, "Verified synthetic company note for ORI.\n");
  await co.locator("#coWorkforce .co-chat-compose input[type=file]").setInputFiles(chatFile);
  await co.waitForSelector('#coWorkforce .co-chat-compose .co-chat-files:has-text("chat-note.md")');
  await co.locator("#coWorkforce .co-chat-compose textarea").fill("راجع حالة الشركة بإيجاز");
  await co.click("#coWorkforce .co-chat-compose button[type=submit]");
  await co.waitForFunction(() => document.querySelector("#coWorkforce .co-chat-assistant .co-chat-text")?.textContent?.includes("رد تجريبي"), null, { timeout: 20000 });
  const chatBefore = await text(co, "#coWorkforce .co-chat-transcript");
  assert.match(chatBefore, /راجع حالة الشركة بإيجاز/);
  await co.reload();
  await co.waitForSelector("#coWorkforce .co-chat-assistant .co-chat-text");
  assert.match(await text(co, "#coWorkforce .co-chat-transcript"), /رد تجريبي/);
  assert.match(await text(co, "#coWorkforce .co-chat-transcript"), /chat-note.md/);
  console.log("PASS conversations: create, bounded text attachment, streamed response, durable messages after browser reload");

  await go(co, "#view/agents/memory", "#coWorkforce .co-memory-form");
  await co.locator("#coWorkforce .co-memory-form").first().locator('input[aria-label="عنوان الذاكرة"]').fill("قرار اختبار الفهرس");
  await co.locator("#coWorkforce .co-memory-form").first().locator('textarea[aria-label="محتوى الذاكرة"]').fill("هذا القرار خاص باختبار الذاكرة المحلية");
  await co.locator("#coWorkforce .co-memory-form").first().locator('button[type="submit"]').click();
  await co.waitForSelector('#coWorkforce .co-memory-card:has-text("قرار اختبار الفهرس")');
  await co.locator('#coWorkforce input[aria-label="بحث الذاكرة"]').fill("اختبار الفهرس");
  await co.waitForSelector('#coWorkforce .co-memory-card:has-text("قرار اختبار الفهرس")');
  await co.locator('#coWorkforce .co-memory-card:has-text("قرار اختبار الفهرس") button:has-text("حذف")').click();
  await co.locator('.os-dialog button:has-text("حذف")').click();
  await co.waitForFunction(() => !document.querySelector('#coWorkforce .co-memory-card'));
  console.log("PASS memory: owner creates, FTS5 finds, and deletion removes indexed result");

  await go(co, "#view/agents/knowledge", "#coWorkforce .co-memory-form");
  await co.locator('#coWorkforce .co-memory-form input[aria-label="عنوان المصدر"]').fill("مذكرة معرفة تجريبية");
  await co.locator('#coWorkforce .co-memory-form textarea[aria-label="نص المصدر"]').fill("المعلومة الموثقة لهذا الاختبار: فهرسة المعرفة المحلية تعمل.");
  await co.locator('#coWorkforce .co-memory-form button:has-text("إضافة إلى المعرفة")').click();
  await co.waitForSelector('#coWorkforce .co-memory-card:has-text("مذكرة معرفة تجريبية")');
  await co.locator('#coWorkforce input[aria-label="بحث المعرفة"]').fill("فهرسة المعرفة");
  await co.waitForSelector('#coWorkforce .co-knowledge-results:has-text("مذكرة معرفة تجريبية")');
  await co.locator('#coWorkforce select[aria-label="مشروع المستند المعتمد"]').selectOption(project.id);
  await co.locator('#coWorkforce button:has-text("استيراد من المشروع")').click();
  await co.waitForSelector('#coWorkforce .co-memory-card:has-text("STATUS.md")');
  await co.locator('#coWorkforce .co-memory-card:has-text("مذكرة معرفة تجريبية") button:has-text("حذف")').click();
  await co.locator('.os-dialog button:has-text("حذف")').click();
  await co.waitForFunction(() => !document.querySelector('#coWorkforce .co-knowledge-results li'));
  console.log("PASS knowledge: owner text and approved project document ingestion, FTS5 citation, deletion from search");

  // ---------------------------------------------------------------- V5 capability engine: library, console, artifact, audit
  await go(co, "#view/agents/tools", '#coWorkforce .cap-card[data-tool="report.executionPdf"]');
  const capSearch = co.locator('#coWorkforce input[aria-label="بحث القدرات"]');
  await capSearch.click();
  await capSearch.pressSequentially("تقويم", { delay: 30 });
  assert.equal(await co.evaluate(() => document.activeElement?.getAttribute("aria-label")), "بحث القدرات", "typing in the capability search keeps focus");
  assert.ok(await co.locator('#coWorkforce .cap-card[data-tool="calendar.exportTasks"]').isVisible());
  assert.equal(await co.locator('#coWorkforce .cap-card[data-tool="security.gitleaks"]').isVisible(), false, "search filters in place");
  await capSearch.fill("");
  await co.click('#coWorkforce .cap-card[data-tool="report.executionPdf"] button:has-text("تشغيل")');
  await co.click('.co-drawer button[type=submit]');
  await co.waitForSelector(".co-drawer .cap-result .cap-art-card", { timeout: 30000 });
  assert.match(await text(co, ".co-drawer .cap-result"), /نجح/);
  await co.keyboard.press("Escape");
  const pdfArtifacts = (await api(co, "/artifacts?kind=pdf")).artifacts;
  assert.equal(pdfArtifacts[0].agentId, "luna");
  const pdfHead = await co.evaluate(async (id) => { const r = await fetch(`/local-api/company/artifacts/${id}/download`); const b = new Uint8Array(await r.arrayBuffer()); return { type: r.headers.get("content-type"), csp: r.headers.get("content-security-policy"), magic: String.fromCharCode(...b.slice(0, 5)) }; }, pdfArtifacts[0].id);
  assert.deepEqual([pdfHead.type, pdfHead.magic], ["application/pdf", "%PDF-"]);
  assert.match(pdfHead.csp, /sandbox/);
  // an approval-gated capability refuses to run without the owner's explicit confirmation
  await co.click('#coWorkforce .cap-card[data-tool="security.osv"] button:has-text("تشغيل")');
  await co.click('.co-drawer button[type=submit]');
  assert.equal(await co.locator(".co-drawer .cap-result .cap-art-card").count(), 0);
  await co.keyboard.press("Escape");
  await co.click('#coWorkforce .cap-tabs button:has-text("سجل التنفيذ")');
  await co.waitForSelector("#coWorkforce .cap-audit tbody tr");
  assert.match(await text(co, "#coWorkforce .cap-audit"), /report\.executionPdf/);
  const audit = (await api(co, "/executions?toolId=report.executionPdf")).executions;
  assert.equal(audit[0].actorType, "owner");
  assert.equal(audit[0].status, "succeeded");
  console.log("PASS capabilities: library search keeps focus, owner console runs LUNA's Arabic PDF, artifact served sandboxed, approval gate holds, audit persisted");

  // ---------------------------------------------------------------- V5 Operations Room: ORI workflow from the UI, approval gate, accounting
  await go(co, "#view/agents/operations", "#coWorkforce .op-template");
  assert.equal(await co.locator("#coWorkforce .op-template").count(), 6, "six workflow templates");
  await co.locator("#coWorkforce .op-template", { hasText: "تقرير الشركة الأسبوعي" }).locator("button", { hasText: "تشغيل" }).click();
  await co.click(".co-drawer button[type=submit]");
  await co.waitForFunction(async () => { const d = await fetch("/local-api/company/workflows?limit=1").then((r) => r.json()); return ["succeeded", "partial", "failed"].includes(d.workflows[0]?.status); }, null, { timeout: 45000 });
  const weekly = (await api(co, "/workflows?limit=1")).workflows[0];
  const weeklyDetail = await api(co, `/workflows/${weekly.id}`);
  assert.ok(["succeeded", "partial"].includes(weeklyDetail.status), weeklyDetail.steps.map((s) => `${s.key}:${s.status}:${s.errorCode}`).join(" "));
  assert.ok(weeklyDetail.steps.filter((s) => s.kind === "tool" && s.status === "succeeded").length >= 3, "specialist tool steps ran");
  assert.ok(weeklyDetail.events.some((e) => e.kind === "delegated" && e.agentId === "nex"));
  assert.ok(weeklyDetail.artifacts.some((a) => a.kind === "pdf" && a.agentId === "luna"), "LUNA's PDF is a workflow deliverable");
  await co.waitForFunction(() => /اكتمل/.test(document.querySelector("#coWorkforce .op-detail-head .ops-badge")?.innerText || ""), null, { timeout: 15000 });
  assert.ok(await co.locator("#coWorkforce .op-stage svg.rb-robot").count() >= 3, "the stage shows the participating robots");
  assert.match(await text(co, "#coWorkforce .op-report"), /الأدلة/);
  // security review pauses for the owner's approval of the OSV step, then resumes after a rejection
  await co.locator("#coWorkforce .op-template", { hasText: "مراجعة أمن المستودع" }).locator("button", { hasText: "تشغيل" }).click();
  await co.locator(".co-drawer select[name=projectId]").selectOption({ index: 0 });
  await co.click(".co-drawer button[type=submit]");
  await co.waitForSelector('#coWorkforce .op-step-waiting-approval button:has-text("رفض")', { timeout: 45000 });
  await co.click('#coWorkforce .op-step-waiting-approval button:has-text("رفض")');
  await co.waitForFunction(async () => { const d = await fetch("/local-api/company/workflows?limit=1").then((r) => r.json()); return ["succeeded", "partial", "failed"].includes(d.workflows[0]?.status); }, null, { timeout: 45000 });
  const secure = await api(co, `/workflows/${(await api(co, "/workflows?limit=1")).workflows[0].id}`);
  assert.equal(secure.steps.find((s) => s.key === "dependencies").status, "skipped");
  await go(co, "#view/resources/accounting", "#rsAccounting .op-acct tbody tr");
  assert.equal(await co.locator("#rsAccounting .op-acct tbody tr").count(), 6);
  assert.ok(await co.locator('#rsAccounting .ops-badge:has-text("مطابق للسجلات")').count(), "accounting reconciles to persisted records");
  assert.equal((await api(co, "/accounting?range=24h")).reconciliation.ok, true);
  console.log("PASS operations: ORI weekly report delegates to specialists with a PDF deliverable; OSV step waits for the owner and resumes after rejection; accounting reconciled");

  // ---------------------------------------------------------------- V5 integration: chat search focus, rename dialog, export, context; memory conflicts
  await go(co, "#view/agents/chat", "#coWorkforce .co-chat-layout");
  const chatSearch = co.locator('#coWorkforce input[aria-label="بحث المحادثات"]');
  await chatSearch.click();
  await chatSearch.pressSequentially("محادثة", { delay: 60 });
  await co.waitForTimeout(700);
  assert.equal(await co.evaluate(() => document.activeElement?.getAttribute("aria-label")), "بحث المحادثات", "chat search keeps focus while results refresh");
  assert.equal(await chatSearch.inputValue(), "محادثة");
  await chatSearch.fill("");
  await co.waitForTimeout(500);
  await co.locator("#coWorkforce .co-chat-thread").first().click();
  await co.waitForSelector("#coWorkforce .co-chat-header");
  await co.waitForSelector("#coWorkforce .co-chat-context");
  assert.match(await text(co, "#coWorkforce .co-chat-context"), /سياق الرد التالي/);
  await co.click('#coWorkforce .co-chat-header button:has-text("إعادة تسمية")');
  await co.locator('.os-dialog input[aria-label="اسم المحادثة"]').fill("محادثة معاد تسميتها");
  await co.keyboard.press("Enter");
  await co.waitForFunction(() => /محادثة معاد تسميتها/.test(document.querySelector("#coWorkforce .co-chat-header h3")?.innerText || ""));
  const exported = await co.evaluate(async () => { const href = document.querySelector('#coWorkforce .co-chat-export a[href*="format=md"]').getAttribute("href"); const r = await fetch(href); return { type: r.headers.get("content-type"), text: await r.text() }; });
  assert.match(exported.type, /markdown/);
  assert.match(exported.text, /# محادثة معاد تسميتها/);
  // memory conflict: the owner sees both notes and decides; nothing is deleted
  await co.evaluate(async () => {
    const token = (await fetch("/local-api/session").then((r) => r.json())).token;
    const post = (body) => fetch("/local-api/company/memory", { method: "POST", headers: { "Content-Type": "application/json", "X-Abud-Session": token }, body: JSON.stringify(body) });
    await post({ scope: "company", title: "سياسة الإصدار", body: "الإصدار كل أسبوعين" });
    await post({ scope: "company", title: "سياسة الإصدار.", body: "الإصدار شهريًا" });
  });
  await go(co, "#view/agents/memory/conflicts", "#coWorkforce .co-conflict");
  assert.match(await text(co, "#coWorkforce .co-conflict"), /الإصدار كل أسبوعين/);
  assert.match(await text(co, "#coWorkforce .co-conflict"), /الإصدار شهريًا/);
  await co.click('#coWorkforce .co-conflict button:has-text("اعتماد الجديدة")');
  await co.waitForFunction(() => !document.querySelector("#coWorkforce .co-conflict"));
  const archived = (await api(co, "/memory?state=archived")).notes.find((n) => n.body === "الإصدار كل أسبوعين");
  assert.ok(archived?.supersededBy, "the superseded note is archived with a pointer, not deleted");
  assert.equal(await co.locator("#coWorkforce .ops-seggroup button", { hasText: "مكتبة المعرفة" }).count(), 1, "memory and knowledge share one tab");
  console.log("PASS integration: chat search keeps focus, rename dialog, Markdown export, context budget shown; memory conflict resolved by the owner with provenance kept");

  // ---------------------------------------------------------------- NEX: recommendation → approval; router untouched
  await go(co, "#view/resources/nex", '#rsNex .co-rec[data-rec="router-retry"]');
  assert.match(await text(co, "#rsNex"), /ملخص NEX التنفيذي/);
  await co.click('#rsNex .co-rec[data-rec="router-retry"] > summary');
  await co.click('#rsNex .co-rec[data-rec="router-retry"] button:has-text("requestRetry")');
  await co.waitForFunction(() => location.hash === "#view/resources/routing");
  await co.waitForSelector("#rsRouting .co-approval-pending");
  await co.click('#rsRouting .co-approval-pending button:has-text("موافقة")');
  await co.click('.os-dialog button:has-text("اعتماد")');
  await co.waitForFunction(() => /الكتابة إلى الراوتر معطّلة/.test(document.querySelector("#rsRouting .co-approvals")?.innerText || ""));
  assert.equal(stub.settings.requestRetry, 3, "router setting untouched while writes are disabled");
  assert.ok(stub.hits.every((h) => h.method === "GET" || (h.method === "POST" && h.path === "/v1/chat/completions")), "only GETs and inference reached the router");
  const recs = (await api(co, "/resources")).recommendations;
  assert.ok(recs.some((r) => /^exhausted:/.test(r.id)), "exhausted quota is reported");
  assert.ok(recs.filter((r) => /^exhausted:/.test(r.id)).every((r) => r.level !== "critical" && r.category), "normal quota exhaustion is never a critical incident");
  assert.equal(new Set(recs.map((r) => r.id)).size, recs.length, "no duplicate recommendation cards");
  console.log("PASS resources: NEX recommendation → approval flow; live router never modified; quota exhaustion not escalated");

  // ---------------------------------------------------------------- automatic, idempotent browser-data migration
  await co.evaluate((name) => localStorage.setItem("abud-os-workboard-v1", JSON.stringify({ version: 1, focus: [name], projects: { [name]: { stage: "progress", tasks: [{ id: "m1", title: "مهمة من المتصفح", done: false }] } },
    events: [{ id: "j1", project: name, kind: "note", detail: "قرار من سجل المتصفح", at: "2026-10-01T10:00:00.000Z" }] })), publicName);
  await co.reload(); await co.waitForSelector("body.ops-mode");
  await co.waitForFunction(async () => (await fetch("/local-api/company/tasks").then((r) => r.json())).tasks.some((t) => t.title === "مهمة من المتصفح"), null, { timeout: 15000 });
  await go(co, "#view/system/data", '#sysData button:has-text("ترحيل الآن")');
  await co.click('#sysData button:has-text("ترحيل الآن")');
  await co.waitForFunction(() => /0 مهمة/.test(document.querySelector("#sysData .co-report")?.innerText || ""));
  const migrated = (await api(co, "/tasks")).tasks.filter((t) => t.title === "مهمة من المتصفح");
  assert.equal(migrated.length, 1, "migration never duplicates tasks");
  assert.ok((await api(co, "/activity?limit=200")).events.some((e) => e.action === "journal.note" && /قرار من سجل المتصفح/.test(e.summary)), "journal carried into the audit log");
  console.log("PASS migration: legacy Workboard tasks, focus and journal migrate automatically and idempotently");

  // ---------------------------------------------------------------- public isolation
  const pub = await open(siteOrigin, { lang: "en" });
  const internalRequests = [];
  pub.on("request", (r) => { if (/\/internal\/|\/local-api\/(omniroute|agents|workspace|policy|settings)/.test(r.url())) internalRequests.push(r.url()); });
  await pub.goto(siteOrigin + "/");
  await pub.waitForSelector("#map");
  await pub.waitForTimeout(1200);
  assert.equal(await pub.evaluate(() => document.body.classList.contains("ops-mode")), false);
  assert.equal(await pub.locator("#opsUsage, .os-nav, .os-side").count(), 0);
  assert.deepEqual(internalRequests, [], "public host never requests internal assets or privileged APIs");
  assert.equal((await pub.request.get(siteOrigin + "/internal/ops-core.js")).status(), 404);
  assert.equal((await pub.request.get(siteOrigin + "/local-api/omniroute/overview")).status(), 404);
  const publicHtml = await pub.content();
  assert.ok(!publicHtml.includes("private-tool") && !publicHtml.includes("OMNIROUTE"), "no internal data in public page");
  console.log("PASS isolation: public static host has no Company OS UI, no internal assets, no privileged API");

  assert.deepEqual(errors, [], "uncaught browser errors");
  console.log("PASS ops: zero uncaught browser errors");
} finally {
  await browser.close();
  await online.close(); await offline.close(); await stub.close();
  await new Promise((r) => site.close(r));
}
