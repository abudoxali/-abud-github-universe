/* V5 screen capture against a running ISOLATED bridge (tests/dev-bridge.mjs): screenshots, horizontal/vertical overflow
 * and uncaught browser errors per route and width. Optional interactive steps run a real capability through the UI.
 * Usage: node tests/v5-shots.mjs <origin> <outDir> [widths=1440,390] [routes=agents/tools,...] [--interact] */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const [origin = "http://127.0.0.1:4191", outDir = "local/qa-v5", widthsArg = "1440,390", routesArg = "agents/tools"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const interact = process.argv.includes("--interact");
if (!/^http:\/\/127\.0\.0\.1:(41(8\d|9\d))$/.test(origin)) throw new Error("v5-shots runs only against an isolated dev bridge on 127.0.0.1:4180-4199");
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const report = [];
for (const width of widthsArg.split(",").map(Number)) {
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, deviceScaleFactor: 1, locale: "ar-EG", reducedMotion: "no-preference" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  for (const route of routesArg.split(",")) {
    errors.length = 0;
    await page.goto(`${origin}/#view/${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      const offenders = [...document.querySelectorAll(".content *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1); }).slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`);
      return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, height: doc.scrollHeight, offenders };
    });
    const file = join(outDir, `${route.replace(/[\/:%]/g, "-")}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    report.push({ route, width, overflowX: metrics.scrollWidth > metrics.clientWidth + 1, offenders: metrics.offenders, height: metrics.height, errors: [...errors], file });
  }
  if (interact && width >= 1000) {
    await page.goto(`${origin}/#view/agents/tools`, { waitUntil: "networkidle" });
    await page.waitForSelector(".cap-card");
    await page.locator('.cap-card[data-tool="report.executionPdf"] button', { hasText: "تشغيل" }).click();
    await page.locator(".co-drawer button[type=submit]").click();
    await page.waitForSelector(".cap-result .cap-art-card", { timeout: 30000 });
    await page.screenshot({ path: join(outDir, "console-pdf-result.png") });
    await page.keyboard.press("Escape");
    await page.locator('.cap-card[data-tool="design.statusCard"] button', { hasText: "تشغيل" }).click();
    await page.locator(".co-drawer select[name=projectId]").selectOption({ index: 1 });
    await page.locator(".co-drawer button[type=submit]").click();
    await page.waitForSelector(".cap-result .cap-art-card img", { timeout: 30000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(outDir, "console-card-result.png") });
    await page.keyboard.press("Escape");
    await page.locator('.cap-card[data-tool="telemetry.toolLatency"] button', { hasText: "تشغيل" }).click();
    await page.locator(".co-drawer button[type=submit]").click();
    await page.waitForSelector(".cap-result .cap-chart svg", { timeout: 30000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(outDir, "console-chart-result.png") });
    await page.keyboard.press("Escape");
    // search keeps focus and filters in place
    const search = page.locator('input[aria-label="بحث القدرات"]');
    await search.click(); await search.pressSequentially("PDF", { delay: 40 });
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    const visible = await page.locator(".cap-card:not([hidden])").count();
    report.push({ interaction: "search", focusedAfterTyping: focused, visibleCards: visible });
    await page.locator(".cap-tabs button", { hasText: "الملفات الناتجة" }).click();
    await page.waitForSelector(".cap-art-card", { timeout: 15000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, "files-gallery.png"), fullPage: true });
    report.push({ interaction: "console", errors: [...errors] });
  }
  await context.close();
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
