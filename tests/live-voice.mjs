/* Browser integration with synthetic recognition, isolated development Bridge, real meeting orchestration.
 * No real microphone or owner data is used. Run after tests/dev-bridge.mjs 4191. */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.argv[2] || "http://127.0.0.1:4191";
assert.equal(origin, "http://127.0.0.1:4191");
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const audioRequests = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => { if (request.url().endsWith("/live-audio/tts")) audioRequests.push(request); });
await page.addInitScript(() => {
  window.__recognizers = [];
  window.SpeechRecognition = class {
    constructor() { window.__recognizers.push(this); }
    start() { this.started = true; }
    stop() { this.started = false; this.onend?.(); }
    abort() { this.started = false; }
    deliver(text) {
      this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal: true }] });
    }
  };
});
try {
  const warmed = page.waitForResponse((response) => response.url().endsWith("/live-audio/warm"), { timeout: 120000 });
  await page.goto(`${origin}/#view/agents/meetings`, { waitUntil: "networkidle" });
  assert.ok((await warmed).ok(), "local voice engine should warm in the background");
  await page.fill(".mt-create input[name=title]", "اختبار كلام مباشر");
  await page.click('.mt-create button:has-text("كل الفريق")');
  await page.click('button:has-text("ابدأ الاجتماع")');
  await page.waitForSelector('.mt-compose .vo-live[aria-pressed="true"]');
  await page.evaluate(() => window.__recognizers.at(-1).deliver("سمعني؟"));
  await page.waitForFunction(() => [...document.querySelectorAll(".mt-turn-completed.co-chat-assistant .co-chat-text")]
    .some((element) => element.textContent.includes("أيوه، سامعك. اتفضل.")), null, { timeout: 15000 });
  const replies = await page.locator(".mt-turn-completed.co-chat-assistant .co-chat-text").allTextContents();
  assert.deepEqual(replies, ["أيوه، سامعك. اتفضل."]);
  assert.doesNotMatch(await page.locator(".mt-transcript").innerText(), /السجل الداخلي|رأي المتخصصين/);
  await page.waitForFunction(() => document.querySelector('.mt-compose .vo-indicator')?.textContent?.includes("بيرد بالصوت"), null, { timeout: 8000 }).catch(() => {});
  assert.equal(audioRequests.length, 1, "one spoken answer should request one local audio segment");
  assert.deepEqual(errors, []);
  console.log("PASS synthetic live hearing check: one concise Egyptian reply, no internal report or browser error");
} finally {
  await browser.close();
}
