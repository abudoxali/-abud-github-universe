/* V6 workforce browser regression against the isolated synthetic dev bridge only. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const origin = process.argv[2] || 'http://127.0.0.1:4191';
assert.equal(origin, 'http://127.0.0.1:4191');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
let pass = 0, fail = 0, created = false;
const id = `qa${Date.now()}`;
async function check(name, fn) { try { await fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; console.error(`FAIL ${name}: ${e.stack}`); } }
async function api(method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    if (method !== 'GET') return window.AbudOps.mutate(method, path, body);
    const response = await fetch(`/local-api/company${path}`); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json();
  }, { method, path, body });
}
async function team(width) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`${origin}/#view/agents/team`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.ag-card');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
}
try {
  for (const width of [1440, 390, 360]) await check(`team fits ${width}px`, () => team(width));
  await check('create seventh agent from API', async () => {
    const data = await api('GET', '/agent-templates');
    const template = data.templates[0];
    await api('POST', '/agents', { id, templateId: template.id, name: 'وكيل الاختبار', titleAr: 'مساعد', roleAr: 'مراجعة العمل', summaryAr: 'اختبار السجل الديناميكي', tools: [] }); created = true;
  });
  await check('seventh agent renders team and generic workspace', async () => {
    await page.reload({ waitUntil: 'networkidle' }); await team(1440); await page.waitForSelector(`.ag-card[data-agent="${id}"]`);
    assert.equal(await page.locator(`.ag-card[data-agent="${id}"] svg.rb-robot`).count(), 0);
    await page.goto(`${origin}/#view/agents/${id}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.ag-ws-hero');
  });
  await check('seventh agent is in conversation picker', async () => {
    await page.goto(`${origin}/#view/agents/chat`, { waitUntil: 'networkidle' });
    await page.waitForSelector(`.co-chat-new select[name="agentId"] option[value="${id}"]`, { state: 'attached' });
  });
  for (const agent of ['ori', 'mia', 'nex', 'luna', 'zen', 'rex']) await check(`${agent} quick action creates real conversation request`, async () => {
    await page.goto(`${origin}/#view/agents/${agent}`, { waitUntil: 'networkidle' });
    const response = page.waitForResponse(r => r.url().includes('/messages') && r.request().method() === 'POST');
    // ZEN's first action requires a topic draft; the knowledge action is executable immediately.
    await page.locator('.ag-quick-actions button').nth(agent === 'zen' ? 1 : 0).click();
    assert.equal((await response).ok(), true);
    await page.waitForSelector('.co-chat-message.co-chat-owner');
    assert.ok((await page.locator('.co-chat-message.co-chat-owner').textContent()).length > 10);
  });
  await check('deactivated agent hidden from picker', async () => {
    await api('POST', `/agents/${id}/deactivate`, {}); created = false;
    await page.reload({ waitUntil: 'networkidle' });
    await page.goto(`${origin}/#view/agents/chat`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.co-chat-new');
    assert.equal(await page.locator(`.co-chat-new option[value="${id}"]`).count(), 0);
  });
  await check('no browser console errors', async () => assert.deepEqual(errors, []));
  await page.goto(`${origin}/#view/agents/team`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: join(tmpdir(), 'v6-workforce-team.png'), fullPage: true });
} finally {
  if (created) await api('POST', `/agents/${id}/deactivate`, {}).catch(e => { fail++; console.error(e.message); });
  await browser.close();
}
console.log(JSON.stringify({ pass, fail }));
process.exitCode = fail ? 1 : 0;
