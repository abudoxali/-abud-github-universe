/* V6 Meeting Center, voice controls and learning view — browser regression against the isolated dev bridge only.
 * Usage: node tests/dev-bridge.mjs 4191   (in another shell)   then   node tests/v6-meetings.mjs http://127.0.0.1:4191
 * Fake media flags let Chromium grant a synthetic microphone; nothing is recorded from a real device. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const origin = process.argv[2] || 'http://127.0.0.1:4191';
assert.equal(origin, 'http://127.0.0.1:4191');
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', permissions: ['microphone'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/429|Failed to load resource/.test(m.text())) errors.push(m.text()); });
let pass = 0, fail = 0;
async function check(name, fn) { try { await fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; console.error(`FAIL ${name}: ${e.stack}`); } }
const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const meetingId = () => decodeURIComponent(new URL(page.url()).hash).split('/')[3];
try {
  await page.goto(`${origin}/#view/agents/meetings`, { waitUntil: 'networkidle' });
  await check('meetings tab is listed under agents', async () => { await page.waitForSelector('.mt-create'); assert.ok(await page.locator('.os-tab', { hasText: 'الاجتماعات' }).count()); });
  await check('create and start a whole-team hybrid meeting from the form', async () => {
    await page.fill('.mt-create input[name=title]', 'اختبار مركز الاجتماعات');
    await page.selectOption('.mt-create select[name=mode]', 'hybrid');
    await page.click('.mt-create button:has-text("كل الفريق")');
    await page.click('button:has-text("ابدأ الاجتماع")');
    await page.waitForSelector('.mt-seats .mt-seat');
    assert.equal(await page.locator('.mt-seat').count(), 6);
  });
  await check('typing survives polling redraws', async () => {
    await page.fill('.mt-compose textarea', 'مسودة لم تُرسل');
    await page.waitForTimeout(5000);
    assert.equal(await page.inputValue('.mt-compose textarea'), 'مسودة لم تُرسل');
  });
  await check('addressing NEX makes only NEX answer, one speaker at a time', async () => {
    await page.fill('.mt-compose textarea', 'NEX، ايه رأيك في الاستهلاك؟');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.mt-turn-completed').length >= 2, null, { timeout: 30000 });
    const speakers = await page.$$eval('.co-chat-assistant .co-chat-meta strong', (els) => els.map((e) => e.textContent));
    assert.deepEqual(speakers, ['NEX']);
  });
  await check('voice controls are push-to-talk only and recording shows an indicator', async () => {
    const mic = page.locator('.mt-compose .vo-mic');
    assert.equal(await mic.getAttribute('aria-pressed'), 'false');
    if (!(await mic.isDisabled())) {
      await mic.click();
      await page.waitForSelector('.vo-mic.is-recording', { timeout: 5000 });
      assert.match(await page.textContent('.mt-compose .vo-indicator'), /يسجّل/);
      await mic.click();
      await page.waitForSelector('.vo-mic:not(.is-recording)');
    }
  });
  await check('ending produces proposed outcomes; confirming an action item creates a task', async () => {
    await page.click('button:has-text("إنهاء واستخراج النتائج")');
    await page.waitForSelector('.mt-outcome', { timeout: 30000 });
    assert.ok(await page.locator('.mt-outcome-proposed').count() >= 2, 'nothing is auto-confirmed');
    const item = page.locator('.mt-outcome', { hasText: 'مهمة مقترحة' }).first();
    await item.locator('button:has-text("تأكيد")').click();
    await page.waitForSelector('.mt-outcome-confirmed a:has-text("فتح المهمة")');
    const data = await page.evaluate(async (id) => (await fetch(`/local-api/company/meetings/${id}`)).json(), meetingId());
    assert.ok(data.outcomes.some((o) => o.type === 'action_item' && o.status === 'confirmed' && o.taskId));
  });
  await check('meeting export is Markdown with the transcript', async () => {
    const text = await page.evaluate(async (id) => (await fetch(`/local-api/company/meetings/${id}/export`)).text(), meetingId());
    assert.match(text, /## المحضر/); assert.match(text, /NEX، ايه رأيك/);
  });
  for (const width of [1440, 1024, 768, 390, 360]) {
    await check(`meeting room and learning fit ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await fits(), 'meeting room overflow');
      await page.goto(`${origin}/#view/agents/memory/learning`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.lr-stats');
      assert.ok(await fits(), 'learning overflow');
      await page.goBack({ waitUntil: 'networkidle' });
    });
  }
  await check('learning view shows measured counts only', async () => {
    await page.goto(`${origin}/#view/agents/memory/learning`, { waitUntil: 'networkidle' });
    const text = await page.textContent('.lr-root');
    assert.doesNotMatch(text, /%/);
    assert.match(text, /اقتراحات تنتظر قرارك/);
  });
  await check('no uncaught browser errors', () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
