/* Drives ORI's Operations Room against an ISOLATED dev bridge (tests/dev-bridge.mjs): launches a real project review
 * from the UI, watches persisted step states, captures screenshots at several widths, and checks accounting views.
 * Usage: node tests/v5-operations-shots.mjs <origin> <outDir> */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const [origin = "http://127.0.0.1:4191", outDir = "local/qa-v5"] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:41(8\d|9\d)$/.test(origin)) throw new Error("isolated dev bridge only (127.0.0.1:4180-4199)");
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const out = {};
await page.goto(`${origin}/#view/agents/operations`, { waitUntil: "networkidle" });
await page.waitForSelector(".op-template");
out.templates = await page.locator(".op-template h3").allInnerTexts();
await page.locator(".op-template", { hasText: "مراجعة مشروع" }).locator("button", { hasText: "تشغيل" }).click();
await page.locator(".co-drawer select[name=projectId]").selectOption({ index: 0 });
const before = await page.evaluate(() => fetch("/local-api/company/workflows?limit=1").then((r) => r.json()).then((d) => d.workflows[0]?.id ?? null));
await page.locator(".co-drawer button[type=submit]").click();
// wait until the newly created workflow is the selected one
await page.waitForFunction(async (prev) => { const d = await fetch("/local-api/company/workflows?limit=1").then((r) => r.json()); return d.workflows[0] && d.workflows[0].id !== prev && document.querySelector(".op-list li:first-child .op-list-item.is-selected"); }, before, { timeout: 20000 });
// observe the live phase: at least one robot marked working while a step runs (persisted state, not a timer)
let sawWorking = false;
for (let i = 0; i < 60; i++) {
  if (await page.locator(".op-member.op-working, .op-step-running").count()) { sawWorking = true; await page.screenshot({ path: join(outDir, "ops-room-running.png") }); break; }
  if (await page.locator(".op-detail-head .ops-badge", { hasText: /اكتمل|فشل/ }).count()) break;
  await page.waitForTimeout(100);
}
out.sawWorkingState = sawWorking;
// the new workflow reaches a terminal state on the server, then the UI must show the same state (polling, no reload)
await page.waitForFunction(async () => { const d = await fetch("/local-api/company/workflows?limit=1").then((r) => r.json()); return ["succeeded", "partial", "failed", "cancelled"].includes(d.workflows[0]?.status); }, null, { timeout: 60000 });
await page.waitForTimeout(2000); // one UI polling interval (1.5 s) after the server finished
await page.waitForFunction(() => /اكتمل|فشل|أُلغي/.test(document.querySelector(".op-detail-head .ops-badge")?.innerText || ""), null, { timeout: 10000 });
out.finalStatus = await page.locator(".op-detail-head .ops-badge").first().innerText();
out.steps = await page.locator(".op-step").evaluateAll((els) => els.map((e) => `${e.dataset.step}:${e.querySelector(".ops-badge")?.innerText}`));
out.reportHasEvidence = /\[E1\]/.test(await page.locator(".op-report").innerText());
out.events = await page.locator(".op-events li").count();
await page.screenshot({ path: join(outDir, "ops-room-done-1440.png"), fullPage: true });
for (const width of [1024, 768, 390, 360]) {
  await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  out[`overflow${width}`] = overflow;
  await page.screenshot({ path: join(outDir, `ops-room-done-${width}.png`), fullPage: true });
}
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${origin}/#view/resources/accounting`, { waitUntil: "networkidle" });
await page.waitForSelector("#rsAccounting .op-acct tbody tr", { timeout: 20000 });
await page.waitForTimeout(900);
out.accountingRows = await page.locator("#rsAccounting .op-acct tbody tr").count();
out.reconciled = await page.locator("#rsAccounting .ops-badge", { hasText: "مطابق للسجلات" }).count() > 0;
await page.screenshot({ path: join(outDir, "accounting-1440.png"), fullPage: true });
await page.goto(`${origin}/#view/agents/rex/usage`, { waitUntil: "networkidle" });
await page.waitForSelector(".op-acct tbody tr", { timeout: 20000 });
out.rexUsage = await page.locator(".op-acct tbody tr").first().innerText();
await page.screenshot({ path: join(outDir, "rex-usage-1440.png"), fullPage: true });
out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await browser.close();
