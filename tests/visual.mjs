/* Visual and responsive QA for the internal Company OS against a RUNNING bridge (read-only: navigation and GET requests
 * only — nothing is clicked that writes). Captures one screenshot per route and width, records horizontal overflow and
 * console errors, and measures the robot renderer on the AI Workforce team view (frame intervals, script time per frame,
 * JS heap). Usage:
 *   node tests/visual.mjs [origin=http://127.0.0.1:4172] [outDir=local/qa] [widths=1440,1024,768,390,360] [routes=all]
 * Screenshots are written to <outDir>/<width>/<route>.png and a summary to <outDir>/summary.json. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const [origin = "http://127.0.0.1:4172", outDir = "local/qa", widthsArg = "1440,1024,768,390,360", routesArg = "all"] = process.argv.slice(2);
const WIDTHS = widthsArg.split(",").map(Number);
const ROUTES = {
  hq: "hq", projects: "projects", "projects-all": "projects/all", "projects-universe": "projects/universe", work: "work", "work-board": "work/board", "work-calendar": "work/calendar",
  agents: "agents", "agents-request": "agents/request", "agents-runs": "agents/runs", "agent-ori": "agents/ori", "agent-mia": "agents/mia", "agent-nex": "agents/nex",
  "agent-luna": "agents/luna", "agent-zen": "agents/zen", "agent-rex": "agents/rex", "agent-nex-art": "agents/nex/art", "agent-rex-runs": "agents/rex/runs",
  resources: "resources", "resources-quotas": "resources/quotas", "resources-providers": "resources/providers", "resources-routing": "resources/routing",
  system: "system", "system-activity": "system/activity", "system-settings": "system/settings",
  "system-integrations": "system/integrations", "system-data": "system/data", "system-security": "system/security",
  "work-done": "work/done", "work-project": "work/project", "project-detail": "projects/p/gh:abudoxali/-abud-github-universe", "project-repo": "projects/p/gh:abudoxali/-abud-github-universe/repo",
  "system-servers": "system/servers", "project-elhabak": "projects/p/gh:abudoxali/elhabak-construction-system-v1"
};
const pick = routesArg === "all" ? Object.keys(ROUTES) : routesArg.split(",");

const browser = await chromium.launch();
const summary = { origin, at: new Date().toISOString(), shots: [], errors: [], perf: null };
for (const width of WIDTHS) {
  const mobile = width < 768;
  const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  page.on("pageerror", (e) => summary.errors.push(`${width} pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|api\.github\.com/.test(m.text())) summary.errors.push(`${width} console: ${m.text()}`); });
  page.on("request", (req) => { if (!["GET", "HEAD"].includes(req.method()) && req.url().startsWith(origin)) summary.errors.push(`${width} unexpected write request: ${req.method()} ${req.url()}`); });
  await page.route(/api\.github\.com|fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 403, contentType: "application/json", body: "{}" }));
  await mkdir(join(outDir, String(width)), { recursive: true });
  await page.goto(`${origin}/#view/hq`, { waitUntil: "networkidle" });
  await page.waitForSelector("body.ops-mode", { timeout: 15_000 });
  for (const name of pick) {
    await page.evaluate((hash) => { location.hash = `#view/${hash}`; }, ROUTES[name]);
    await page.waitForTimeout(1300);
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const wide = [...document.querySelectorAll("body *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > doc.clientWidth + 1 || r.left < -1) && !el.closest(".ops-tablewrap, .os-tabs, .os-parts, .co-board, [data-scroll-x]"); })
        .slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).split(" ")[0]}`);
      return { scroll: doc.scrollWidth - doc.clientWidth, wide };
    });
    const robots = await page.evaluate(() => [...document.querySelectorAll("svg.rb-robot")].filter((el) => el.getBoundingClientRect().width).map((el) => ({ agent: el.dataset.agent, state: el.dataset.state, variant: el.dataset.variant, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) })));
    const file = join(outDir, String(width), `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    summary.shots.push({ width, name, file, overflow, robots });
  }
  // The navigation must stay in view on long pages (desktop sidebar is sticky; mobile uses a fixed off-canvas panel).
  await page.evaluate(() => { location.hash = "#view/system/activity"; });
  await page.waitForTimeout(1300);
  const sideTop = await page.evaluate(async () => { window.scrollTo(0, 900); await new Promise((r) => setTimeout(r, 300)); const top = document.querySelector(".os-side")?.getBoundingClientRect().top; window.scrollTo(0, 0); return top; });
  if (Math.abs(sideTop) > 1) summary.errors.push(`${width} navigation scrolled out of view (top ${Math.round(sideTop)}px)`);
  if (width === WIDTHS[0]) {
    await page.evaluate(() => { location.hash = "#view/agents"; });
    await page.waitForTimeout(1500);
    summary.perf = await page.evaluate(async () => {
      window.AbudRobots?.resetStats();
      const gaps = [];
      let last = performance.now();
      await new Promise((resolve) => { const end = last + 4000; const step = (t) => { gaps.push(t - last); last = t; if (t < end) requestAnimationFrame(step); else resolve(); }; requestAnimationFrame(step); });
      gaps.sort((a, b) => a - b);
      const q = (p) => +gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))].toFixed(2);
      return { frames: gaps.length, seconds: 4, fps: +(gaps.length / 4).toFixed(1), p50FrameMs: q(0.5), p95FrameMs: q(0.95), maxFrameMs: q(1), robot: window.AbudRobots?.stats(), heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null };
    });
  }
  await context.close();
}
await browser.close();
await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
const bad = summary.shots.filter((s) => s.overflow.scroll > 0);
console.log(`shots: ${summary.shots.length}, overflow: ${bad.length}, errors: ${summary.errors.length}`);
for (const s of bad) console.log(`  overflow ${s.width} ${s.name}: +${s.overflow.scroll}px ${s.overflow.wide.join(" ")}`);
for (const e of summary.errors.slice(0, 20)) console.log(`  ${e}`);
console.log("perf:", JSON.stringify(summary.perf));
