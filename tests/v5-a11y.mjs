/* Accessibility checks for V5 screens on an ISOLATED dev bridge: every interactive control has an accessible name,
 * form fields are labelled, images have alt text, keyboard focus is visible, and reduced motion stops robot animation.
 * Usage: node tests/v5-a11y.mjs <origin> */
import { chromium } from "playwright";
const origin = process.argv[2] || "http://127.0.0.1:4191";
if (!/^http:\/\/127\.0\.0\.1:41(8\d|9\d)$/.test(origin)) throw new Error("isolated dev bridge only");
const routes = ["agents", "agents/operations", "agents/chat", "agents/tools", "agents/memory", "agents/memory/knowledge", "agents/memory/conflicts", "agents/runs", "agents/mia/studio", "agents/ori/usage", "agents/luna/files", "agents/zen/chat", "resources/accounting"];
const browser = await chromium.launch();
const report = { origin, problems: [], focusVisible: null, reducedMotion: null };
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
for (const route of routes) {
  await page.goto(`${origin}/#view/${route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const found = await page.evaluate(() => {
    const scope = document.querySelector(".content") || document.body;
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
    const name = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || el.getAttribute("alt") || "").trim() || [...(el.labels || [])].map((l) => l.textContent.trim()).join(" ") || (el.getAttribute("aria-labelledby") ? document.getElementById(el.getAttribute("aria-labelledby"))?.textContent?.trim() : "");
    const out = [];
    for (const el of scope.querySelectorAll("button, a[href], [role=button], [role=radio], summary")) if (visible(el) && !name(el)) out.push(`unnamed ${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`);
    for (const el of scope.querySelectorAll("input:not([type=hidden]), select, textarea")) if (visible(el) && !name(el) && !el.placeholder) out.push(`unlabelled ${el.tagName.toLowerCase()}[${el.name || el.type}]`);
    for (const el of scope.querySelectorAll("img")) if (visible(el) && !el.hasAttribute("alt")) out.push(`img without alt ${el.src.slice(-40)}`);
    return [...new Set(out)].slice(0, 12);
  });
  for (const f of found) report.problems.push(`${route}: ${f}`);
}
// keyboard: tabbing reaches controls and shows a visible focus indicator
await page.goto(`${origin}/#view/agents/tools`, { waitUntil: "networkidle" });
await page.waitForSelector(".cap-card");
let shown = 0;
for (let i = 0; i < 25; i++) {
  await page.keyboard.press("Tab");
  shown += await page.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return 0; const cs = getComputedStyle(el); return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 || cs.boxShadow !== "none" ? 1 : 0; });
}
report.focusVisible = `${shown}/25 tab stops showed an outline or focus ring`;
// reduced motion: robots render a still frame
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
const rm = await ctx.newPage();
await rm.goto(`${origin}/#view/agents`, { waitUntil: "networkidle" });
await rm.waitForTimeout(1200);
report.reducedMotion = await rm.evaluate(async () => { window.AbudRobots?.resetStats(); await new Promise((r) => setTimeout(r, 1500)); const s = window.AbudRobots?.stats(); return { instances: s?.instances, animatedFramesIn1500ms: s?.frames }; });
await browser.close();
console.log(JSON.stringify(report, null, 1));
