/* Browser integration for the Gemini Live path with a fake Google (local WebSocket) and Chromium's synthetic microphone.
 * No real key, network call or owner data. Run: DEV_LIVE_GOOGLE=4192 node tests/dev-bridge.mjs 4191, then node tests/live-gemini.mjs. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { createRequire } from "node:module";
const { WebSocketServer } = createRequire(new URL("../apps/local-bridge/package.json", import.meta.url))("ws");

const origin = process.argv[2] || "http://127.0.0.1:4191";
assert.equal(origin, "http://127.0.0.1:4191");
const KEY = "AIzaSyFakeKeyForBrowserTest0123456789ab";
const frames = [];
const seen = { setup: null, toolResponses: [] };
let google = null;

const http = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ models: [{ name: "models/gemini-3.8-live", supportedGenerationMethods: ["bidiGenerateContent"] }] }));
});
const wss = new WebSocketServer({ server: http });
const send = (message) => google.send(Buffer.from(JSON.stringify(message)));
wss.on("connection", (socket) => {
  google = socket;
  let heard = false;
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.setup) { seen.setup = message.setup; send({ setupComplete: {} }); return; }
    if (message.realtimeInput?.audio) {
      frames.push(message.realtimeInput.audio.data.length);
      if (!heard && frames.length >= 5) {
        heard = true;
        send({ serverContent: { inputTranscription: { text: "سمعني؟" } } });
        send({ toolCall: { functionCalls: [{ id: "call-1", name: "ask_company", args: { request: "سمعني" } }] } });
      }
    }
    if (message.toolResponse) {
      seen.toolResponses.push(message.toolResponse.functionResponses[0]);
      const tone = Int16Array.from({ length: 12000 }, (_, i) => Math.round(Math.sin(i / 12) * 6000));
      send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from(tone.buffer).toString("base64") } }] } } });
      send({ serverContent: { outputTranscription: { text: "أيوه، سامعك. اتفضل." } } });
      send({ serverContent: { turnComplete: true } });
    }
  });
});
await new Promise((resolve) => http.listen(4192, "127.0.0.1", resolve));

const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ permissions: ["microphone"] });
const page = await context.newPage();
const errors = [], localAudio = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => { if (request.url().endsWith("/live-audio/tts")) localAudio.push(request.url()); });
await page.addInitScript(() => {
  window.__played = 0;
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) { window.__played++; return start.apply(this, args); };
});
try {
  await page.goto(`${origin}/#view/agents/meetings`, { waitUntil: "networkidle" });
  const saved = await page.evaluate(async (key) => window.AbudOps.mutate("POST", "/live-voice/key", { key, acknowledgeFreeTier: true }), KEY);
  assert.equal(saved.configured, true);
  assert.equal(saved.model, "gemini-3.8-live");
  await page.evaluate(() => window.AbudVoice.refreshEngine());
  assert.equal((await page.evaluate(() => window.AbudVoice.status())).engine, "Gemini Live");

  await page.fill(".mt-create input[name=title]", "اختبار جيميناي لايف");
  await page.click('.mt-create button:has-text("كل الفريق")');
  await page.click('button:has-text("ابدأ الاجتماع")');
  await page.waitForSelector('.mt-compose .vo-live[aria-pressed="true"]');
  await page.waitForFunction(() => [...document.querySelectorAll(".mt-turn-completed.co-chat-assistant .co-chat-text")]
    .some((element) => element.textContent.includes("أيوه، سامعك. اتفضل.")), null, { timeout: 20000 });
  assert.ok(frames.length >= 5, "the synthetic microphone streamed audio to Gemini through the Bridge");
  assert.ok(seen.setup.tools[0].functionDeclarations.some((f) => f.name === "ask_company"));
  for (let i = 0; i < 100 && !seen.toolResponses.length; i++) await page.waitForTimeout(50);
  assert.equal(seen.toolResponses.length, 1);
  assert.equal(seen.toolResponses[0].response.reply, "أيوه، سامعك. اتفضل.");
  await page.waitForFunction(() => window.__played > 0, null, { timeout: 8000 });
  assert.match(await page.locator(".mt-compose .vo-indicator").innerText(), /بيرد بالصوت|سامعك/);
  assert.equal(localAudio.length, 0, "the local fallback TTS is not used while Gemini speaks");
  assert.doesNotMatch(await page.locator(".mt-transcript").innerText(), /السجل الداخلي|رأي المتخصصين/);

  await page.click('.mt-compose .vo-live');
  await page.waitForSelector('.mt-compose .vo-live[aria-pressed="false"]');
  assert.equal(await page.evaluate(() => navigator.mediaDevices.enumerateDevices().then(() => true)), true);
  assert.deepEqual(errors, []);
  console.log("PASS Gemini Live browser path: microphone -> Bridge -> (fake) Google -> normal meeting turn -> audio playback, no local TTS, no errors");
} finally {
  await browser.close();
  wss.close();
  http.close();
}
