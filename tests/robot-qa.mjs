/* Deterministic visual and rig QA. No bridge, router, or company data is touched.
 * Usage: node tests/robot-qa.mjs [output directory] */
import { strict as assert } from "node:assert";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "playwright";

const out = resolve(process.argv[2] || "local/qa-v3-robots");
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 800 }, reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.setContent(`<html><head><style>body{margin:0;padding:24px;background:#17131f;color:#f4edf8;font:600 16px Arial}#grid{display:grid;grid-template-columns:repeat(6,1fr);gap:16px}.card{height:350px;display:flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid #57435f;border-radius:20px;background:radial-gradient(circle at 50% 40%,#32283a,#1d1726 74%)}.card svg{width:235px;height:300px}.card span{margin-top:6px}</style></head><body><div id="grid"></div></body></html>`);
await page.addScriptTag({ content: await readFile(resolve("internal/robot-specs.js"), "utf8") });
await page.addScriptTag({ content: await readFile(resolve("internal/robot-engine.js"), "utf8") });
const result = await page.evaluate(() => {
  const R = window.AbudRobots;
  const grid = document.querySelector("#grid");
  const forms = R.forms();
  for (const f of forms) {
    const card = document.createElement("div"); card.className = "card"; card.dataset.key = `${f.agentId}-${f.variant}`;
    const robot = R.create({ agentId: f.agentId, variant: f.variant, reducedMotion: true, interactive: false });
    card.append(robot.el);
    const name = document.createElement("span"); name.textContent = `${f.agentId.toUpperCase()} · ${f.variant}`; card.append(name);
    grid.append(card);
  }
  const svgs = [...document.querySelectorAll("svg.rb-robot")];
  const ids = svgs.flatMap((svg) => [...svg.querySelectorAll("[id]")].map((node) => node.id));
  const refs = svgs.flatMap((svg) => [...svg.querySelectorAll("*")].flatMap((node) => [...node.attributes].map((attr) => attr.value)).flatMap((value) => [...value.matchAll(/url\(#([^)]*)\)/g)].map((match) => match[1])));
  const geometry = svgs.map((svg) => {
    const stage = svg.querySelector("g[data-part='floats']")?.parentElement;
    const b = stage.getBBox(); const v = svg.viewBox.baseVal;
    return { agent: svg.dataset.agent, variant: svg.dataset.variant, bbox: [b.x, b.y, b.width, b.height], viewBox: [v.x, v.y, v.width, v.height],
      transformsValid: ![...svg.querySelectorAll("[transform]")].some((node) => /NaN|undefined|Infinity/.test(node.getAttribute("transform"))) };
  });
  const poseBounds = [];
  const before = R.stats().instances;
  const faceNames = ["happy", "neutral", "curious", "thinking", "focused", "surprised", "concerned", "error", "celebrating"];
  const poseHost = document.createElement("div");
  poseHost.style.cssText = "position:absolute;left:-10000px;top:0;width:260px;height:330px";
  document.body.append(poseHost);
  for (const agentId of R.ORDER) {
    const sample = R.create({ agentId, reducedMotion: true, interactive: false });
    poseHost.append(sample.el);
    for (const state of R.STATES) { sample.set({ animationState: state }); const b = sample.el.querySelector("g[data-part='floats']").parentElement.getBBox(); const v = sample.el.viewBox.baseVal; poseBounds.push({ agentId, state, bbox: [b.x, b.y, b.width, b.height], viewBox: [v.x, v.y, v.width, v.height] }); }
    for (const expression of faceNames) sample.set({ expression });
    sample.dispose();
    sample.el.remove();
  }
  poseHost.remove();
  return { forms, identities: [...new Set(forms.map((f) => f.agentId))], states: R.STATES, expressions: R.EXPRESSIONS,
    idsUnique: new Set(ids).size === ids.length, refsExist: refs.every((id) => ids.includes(id)), geometry, poseBounds, before, after: R.stats().instances, still: svgs[1].__robot.still };
});
assert.equal(result.identities.length, 6);
assert.equal(result.forms.length, 12);
assert.equal(result.states.length, 9);
assert.ok(result.poseBounds.every(({ bbox: [, , w, h] }) => w > 0 && h > 0), "all motion-state bounds were measured on rendered SVGs");
assert.ok(result.idsUnique && result.refsExist, "SVG IDs and references are isolated");
assert.ok(result.geometry.every((item) => item.transformsValid), "rig transforms are finite");
assert.deepEqual(result.geometry.filter(({ bbox: [x, y, w, h], viewBox: [vx, vy, vw, vh] }) => x < vx || y < vy || x + w > vx + vw || y + h > vy + vh), [], "all forms fit the SVG viewBox");
assert.deepEqual(result.poseBounds.filter(({ bbox: [x, y, w, h], viewBox: [vx, vy, vw, vh] }) => x < vx || y < vy || x + w > vx + vw || y + h > vy + vh), [], "all motion states fit the SVG viewBox");
assert.equal(result.after, result.before, "temporary state-test instances were released");
assert.equal(result.still, true, "reduced motion uses a still pose");
assert.deepEqual(errors, []);
await page.screenshot({ path: join(out, "twelve-forms.png"), fullPage: true });
for (const form of result.forms) await page.locator(`[data-key="${form.agentId}-${form.variant}"]`).screenshot({ path: join(out, `${form.agentId}-${form.variant}.png`) });
await page.evaluate(() => {
  const names = ["happy", "neutral", "curious", "thinking", "focused", "surprised", "concerned", "error", "celebrating"];
  document.body.innerHTML = '<div id="faces"></div>';
  const root = document.querySelector("#faces");
  root.style.cssText = "display:grid;grid-template-columns:repeat(9,1fr);gap:8px";
  for (const id of window.AbudRobots.ORDER) for (const name of names) {
    const card = document.createElement("div"); card.style.cssText = "height:130px;display:grid;place-items:center;background:#32283a;border-radius:12px;font-size:12px";
    const face = window.AbudRobots.portrait(id, { expression: name }); face.style.cssText = "width:92px;height:92px";
    card.append(face, document.createTextNode(`${id.toUpperCase()} · ${name}`)); root.append(card);
  }
});
await page.screenshot({ path: join(out, "expressions.png"), fullPage: true });
await writeFile(join(out, "summary.json"), JSON.stringify({ ...result, errors }, null, 2));
await browser.close();
console.log(JSON.stringify({ identities: result.identities.length, forms: result.forms.length, states: result.states.length, svgIdsUnique: result.idsUnique, refsExist: result.refsExist, errors: errors.length, out }));
