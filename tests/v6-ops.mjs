/* V6 browser regression for routines, folder scopes and privacy, agent performance, and meeting shortcuts — isolated dev
 * bridge only.  Start:  node tests/dev-bridge.mjs 4191     Run:  node tests/v6-ops.mjs http://127.0.0.1:4191 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
const origin = process.argv[2] || 'http://127.0.0.1:4191';
assert.equal(origin, 'http://127.0.0.1:4191');
const scratch = await mkdtemp(join(tmpdir(), 'abud-ops-qa-'));
const protectedDir = join(scratch, '.ssh'), goodDir = join(scratch, 'client-work');
await mkdir(protectedDir); await mkdir(goodDir);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
let pass = 0, fail = 0;
async function check(name, fn) { try { await fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; console.error(`FAIL ${name}: ${e.stack}`); } }
const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const go = async (hash, selector) => { await page.goto(`${origin}/${hash}`, { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector(selector, { timeout: 15000 }); };
try {
  await check('routines tab lists seven routines (defaults are off — proven in the unit tests; reset here so reruns are repeatable)', async () => {
    await go('#view/work/routines', '.rt-item');
    assert.equal(await page.locator('.rt-item').count(), 7);
    await page.evaluate(async () => { for (const r of (await (await fetch('/local-api/company/routines')).json()).routines) if (r.enabled) await window.AbudOps.mutate('PATCH', `/routines/${r.id}`, { enabled: false }); });
    await go('#view/work/routines', '.rt-item');
    assert.equal(await page.locator('.rt-item.is-on').count(), 0);
  });
  await check('enabling a routine and running it now records a result without a model call', async () => {
    const item = page.locator('.rt-item', { hasText: 'ملخص عمليات اليوم' });
    await item.locator('input[type=checkbox]').check();
    await page.waitForSelector('.rt-item.is-on');
    await page.locator('.rt-item.is-on button:has-text("شغّله الآن")').click();
    await page.waitForSelector('.rt-item.is-on .rt-runs li', { timeout: 10000 });
    assert.match(await page.textContent('.rt-item.is-on .rt-runs li'), /مفتوحة.*متأخرة/);
    const before = await page.evaluate(async () => (await (await fetch('/local-api/company/accounting?range=24h')).json()).totals.inferences);
    assert.equal(before, 0, 'no inference was spent');
  });
  await check('agent performance tab shows team totals and a card per agent', async () => {
    await go('#view/agents/performance', '.pf-card');
    assert.ok(await page.locator('.pf-card').count() >= 6);
    assert.match(await page.textContent('.pf-root'), /ملخص الفريق/);
    await page.click('.pf-root [role=tab]:has-text("30 يومًا"), .pf-root button:has-text("30 يومًا")');
    await page.waitForSelector('.pf-card');
  });
  await check('privacy panel: protected folder refused, valid folder added then withdrawn', async () => {
    await go('#view/system/security', '.cx-root .cx-add');
    assert.match(await page.textContent('.cx-root'), /محمي دائمًا/);
    assert.match(await page.textContent('.cx-root'), /الصوت لا يُرسل أبدًا|الصوت نفسه/);
    await page.fill('.cx-add input[type=text]', protectedDir);
    await page.click('.cx-add button[type=submit]');
    await page.waitForSelector('.toast, [role=status]:has-text("محمي")', { timeout: 5000 }).catch(() => {});
    assert.equal(await page.locator('.cx-list li', { hasText: '.ssh' }).count(), 0, 'the protected folder was not authorized');
    await page.fill('.cx-add input[type=text]', goodDir);
    await page.click('.cx-add button[type=submit]');
    await page.waitForSelector('.cx-list li:has-text("client-work")');
    assert.ok(!(await page.textContent('.cx-root')).includes(scratch), 'no absolute path is shown');
    await page.locator('.cx-list li', { hasText: 'client-work' }).locator('button:has-text("سحب التصريح")').click();
    await page.click('.os-dialog .btn-danger');
    await page.waitForFunction(() => ![...document.querySelectorAll('.cx-list li')].some((li) => li.textContent.includes('client-work')));
  });
  await check('ORI «ابدأ اجتماع الفريق» opens the Meeting Center with all six selected', async () => {
    await go('#view/agents/ori', '.ag-quick-actions');
    await page.click('.ag-quick-actions button:has-text("ابدأ اجتماع الفريق")');
    await page.waitForSelector('.mt-create');
    assert.equal(await page.locator('.mt-picks input:checked').count(), 6);
    assert.equal(await page.locator('.mt-seat').count(), 0, 'nothing started');
  });
  await check('LUNA «جهّزي اجتماع» preselects LUNA and ORI', async () => {
    await go('#view/agents/luna', '.ag-quick-actions');
    await page.click('.ag-quick-actions button:has-text("جهّزي اجتماع")');
    await page.waitForSelector('.mt-create');
    const checked = await page.$$eval('.mt-picks input:checked', (els) => els.map((e) => e.value).sort());
    assert.deepEqual(checked, ['luna', 'ori']);
  });
  for (const width of [1440, 1024, 768, 390, 360]) {
    await check(`new views fit ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      for (const [hash, selector] of [['#view/work/routines', '.rt-item'], ['#view/agents/performance', '.pf-card'], ['#view/system/security', '.cx-root .cx-add'], ['#view/hq', '.hq-ask']]) {
        await go(hash, selector);
        assert.ok(await fits(), `${hash} overflows at ${width}px`);
      }
    });
  }
  await check('no uncaught browser errors', () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
