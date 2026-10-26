/* Gemini Live front-end: key handling, setup message, the single ask_company tool into real chat/meeting runs, audio relay,
 * authentication and failure paths. Google is replaced by a local fake that speaks the same JSON protocol. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { openDatabase } from "../src/db.mjs";
import { createCompany } from "../src/company.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { createMeetings } from "../src/meetings.mjs";
import { createConversations } from "../src/conversations.mjs";
import { createRouterClient, createRouterService } from "../src/omniroute.mjs";
import { createLiveVoice, buildInstruction, buildSetup, pickLiveModel, toSpeech, LIVE_WS_PATH } from "../src/live-voice.mjs";
import { startStubRouter, TEST_KEY } from "./fixtures.mjs";

const KEY = "AIzaSyTestKeyForLiveVoice0123456789abc";
const KEY_B = "AQ.Ab8FakeSecondKeyForTests-12345678_xyz";
const TOKEN = "session-token-for-tests";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error("condition not met"); await sleep(15); } };

const chat = (model, body) => {
  const user = body.messages.at(-1).content;
  const content = user.includes("المشاريع") ? "عندك ثلاثة مشاريع نشطة." : `رد تجريبي: ${user.slice(0, 40)}`;
  return { status: 200, headers: { "x-omniroute-provider": "nvidia", "x-omniroute-model": "model-a" }, body: { model, usage: { prompt_tokens: 50, completion_tokens: 10 }, choices: [{ message: { role: "assistant", content } }] } };
};

/** A fake Google: records client messages and lets the test push server messages (as binary JSON frames, like the real API). */
async function fakeGoogle({ models, validKeys = [KEY], refuseSessions = [] } = {}) {
  const received = [], sessionKeys = [];
  let socket = null;
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (client, request) => {
    const used = new URL(request.url, "http://x").searchParams.get("key");
    sessionKeys.push(used);
    if (refuseSessions.includes(used)) { client.close(1008, "quota exceeded"); return; }
    socket = client; client.on("message", (data) => received.push(JSON.parse(data.toString("utf8"))));
  });
  const http = createHttpServer((request, response) => {
    if (!validKeys.includes(request.headers["x-goog-api-key"])) { response.writeHead(403).end("{}"); return; }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ models: models ?? [
      { name: "models/gemini-3.8-live", supportedGenerationMethods: ["bidiGenerateContent"] },
      { name: "models/gemini-3.8-live-extended-thinking", supportedGenerationMethods: ["bidiGenerateContent"] },
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }
    ] }));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    endpoints: { ws: `ws://127.0.0.1:${wss.address().port}`, http: `http://127.0.0.1:${http.address().port}` },
    received, sessionKeys, push: (message) => socket.send(Buffer.from(JSON.stringify(message))), connected: () => Boolean(socket),
    async close() { wss.close(); http.close(); }
  };
}

async function setup({ withKey = true, google: googleOptions } = {}) {
  const stub = await startStubRouter({ chat });
  const client = createRouterClient({ env: { OMNIROUTE_BASE_URL: `http://127.0.0.1:${stub.port}`, OMNIROUTE_API_KEY: TEST_KEY } });
  const service = createRouterService({ client });
  const db = openDatabase(":memory:");
  const company = createCompany({ db });
  company.seed();
  for (const policy of company.listPolicies()) company.updatePolicy(policy.domain, { candidates: ["nvidia/model-a"] });
  const runtime = createRuntime({ company, routerClient: client, getOverview: () => service.overview(), getUsage: async () => ({}), workspace: { paths: () => new Map(), scan: async () => ({ repos: [] }) } });
  const conversations = createConversations({ company, runtime });
  runtime.setConversations(conversations);
  const meetings = createMeetings({ company, runtime });
  runtime.setMeetings(meetings);
  const google = await fakeGoogle(googleOptions);
  const home = mkdtempSync(join(tmpdir(), "live-voice-"));
  const live = createLiveVoice({ company, conversations, meetings, runtime, env: {}, home, endpoints: google.endpoints });
  if (withKey) await live.setKey({ key: KEY, acknowledgeFreeTier: true });
  const server = createHttpServer();
  let allowed = true;
  live.attach(server, { isLocal: () => allowed, tokenOk: (token) => token === TOKEN });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${server.address().port}${LIVE_WS_PATH}`;
  async function call(context, { token = TOKEN } = {}) {
    const browser = new WebSocket(url);
    const events = [], audio = [];
    browser.on("message", (data, isBinary) => { if (isBinary) audio.push(Buffer.from(data)); else events.push(JSON.parse(data.toString("utf8"))); });
    await new Promise((resolve, reject) => { browser.once("open", resolve); browser.once("error", reject); });
    browser.send(JSON.stringify({ type: "start", token, context }));
    return { browser, events, audio };
  }
  return { stub, company, runtime, conversations, meetings, google, live, home, call, deny() { allowed = false; }, url,
    async close() { live.stop(); await runtime.stop(); db.close(); await stub.close(); await google.close(); server.closeAllConnections(); server.close(); } };
}

test("model choice prefers the newest non-extended Live model; speech text drops markdown", () => {
  assert.equal(pickLiveModel(["gemini-2.5-flash-native-audio-preview-12-2025", "gemini-3.8-live-extended-thinking", "gemini-3.8-live", "gemini-3.1-flash-live-preview"]), "gemini-3.8-live");
  assert.equal(pickLiveModel([]), null);
  assert.equal(toSpeech("## عنوان\n- **مهم** [رابط](http://x.y) `كود`"), "عنوان\nمهم رابط كود");
});

test("setup carries exactly one tool, transcription, a persona instruction and a voice; the instruction forbids guessing", () => {
  const setup = buildSetup({ model: "gemini-3.8-live", instruction: buildInstruction({ agent: { name: "ORI", titleAr: "القائد" } }), voice: "Orus" }).setup;
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.deepEqual(setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(setup.tools.length, 1);
  assert.deepEqual(setup.tools[0].functionDeclarations.map((f) => f.name), ["ask_company"]);
  assert.ok(setup.inputAudioTranscription && setup.outputAudioTranscription);
  assert.match(setup.systemInstruction.parts[0].text, /ORI/);
  assert.match(setup.systemInstruction.parts[0].text, /ممنوع تخمّن/);
  assert.equal(setup.sessionResumption.handle, undefined);
});

test("key: needs the free-tier acknowledgement and a valid format, is validated against Google, stored locally and removable", async () => {
  const env = await setup({ withKey: false });
  try {
    assert.equal(env.live.status().configured, false);
    await assert.rejects(env.live.setKey({ key: "short", acknowledgeFreeTier: true }), { code: "validation" });
    await assert.rejects(env.live.setKey({ key: KEY }), { code: "ack-required" });
    await assert.rejects(env.live.setKey({ key: "AIzaWrongKeyWrongKeyWrongKeyWrongKey12", acknowledgeFreeTier: true }), { code: "gemini-key-rejected" });
    assert.equal(env.live.status().configured, false);
    const saved = await env.live.setKey({ key: KEY, acknowledgeFreeTier: true });
    assert.equal(saved.configured, true);
    assert.equal(saved.model, "gemini-3.8-live");
    assert.equal(JSON.stringify(saved).includes(KEY), false, "status never returns the key");
    assert.equal(readFileSync(join(env.home, "gemini.key"), "utf8"), KEY);
    assert.equal(env.company.db.get("SELECT COUNT(*) AS n FROM activity_events WHERE summary LIKE ?", `%${KEY}%`)?.n ?? 0, 0);
    assert.equal(env.live.clearKey().configured, false);
    assert.equal(existsSync(join(env.home, "gemini.key")), false);
  } finally { await env.close(); }
});

test("connection requires the session token, a configured key and a local request", async () => {
  const env = await setup({ withKey: false });
  try {
    const noKey = await env.call({ kind: "chat", id: "x" });
    await until(() => noKey.events.some((e) => e.code === "not-configured"));
    await env.live.setKey({ key: KEY, acknowledgeFreeTier: true });
    const badToken = await env.call({ kind: "chat", id: "x" }, { token: "wrong" });
    await until(() => badToken.events.some((e) => e.code === "session-required"));
    assert.equal(env.google.connected(), false, "Google is never contacted for an unauthenticated browser");
    env.deny();
    await assert.rejects(new Promise((resolve, reject) => { const w = new WebSocket(env.url); w.once("open", resolve); w.once("error", reject); }));
  } finally { await env.close(); }
});

test("chat call: audio relays both ways; the owner's transcript (not Gemini's paraphrase) becomes a normal audited agent run", async () => {
  const env = await setup();
  try {
    for (const policy of env.company.listPolicies()) env.company.updatePolicy(policy.domain, { candidates: ["nvidia/model-a"] });
    const thread = env.conversations.create({ agentId: "ori" });
    const call = await env.call({ kind: "chat", id: thread.id });
    await until(() => env.google.received.length);
    const setup = env.google.received[0].setup;
    assert.equal(setup.model, "models/gemini-3.8-live");
    assert.match(setup.systemInstruction.parts[0].text, /ORI/);
    env.google.push({ setupComplete: {} });
    await until(() => call.events.some((e) => e.type === "ready"));

    call.browser.send(Buffer.from([1, 0, 2, 0]), { binary: true });
    const audioIn = await until(() => env.google.received.find((m) => m.realtimeInput?.audio));
    assert.equal(audioIn.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
    assert.deepEqual([...Buffer.from(audioIn.realtimeInput.audio.data, "base64")], [1, 0, 2, 0]);

    env.google.push({ serverContent: { inputTranscription: { text: "إيه أخبار " } } });
    env.google.push({ serverContent: { inputTranscription: { text: "المشاريع النهارده؟" } } });
    await until(() => call.events.some((e) => e.type === "input" && e.text === "إيه أخبار المشاريع النهارده؟"));
    env.google.push({ toolCall: { functionCalls: [{ id: "c1", name: "ask_company", args: { request: "paraphrase that must be ignored" } }] } });
    const response = await until(() => env.google.received.find((m) => m.toolResponse));
    const result = response.toolResponse.functionResponses[0];
    assert.equal(result.id, "c1");
    assert.equal(result.response.ok, true);
    assert.equal(result.response.reply, "عندك ثلاثة مشاريع نشطة.");
    const run = env.company.listRuns({ agentId: "ori", limit: 5 }).find((r) => r.conversationId === thread.id);
    assert.equal(run.request, "إيه أخبار المشاريع النهارده؟");
    assert.deepEqual(env.conversations.messages(thread.id).map((m) => m.role).filter((role) => role !== "event"), ["owner", "assistant"]);
    assert.ok(call.events.some((e) => e.type === "refresh" && e.key === `chat:${thread.id}`));

    env.google.push({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from([9, 8, 7, 6]).toString("base64") } }] } } });
    await until(() => call.audio.length);
    assert.deepEqual([...call.audio[0]], [9, 8, 7, 6]);
    env.google.push({ serverContent: { interrupted: true } });
    await until(() => call.events.some((e) => e.type === "interrupted"));
    call.browser.close();
    await until(() => env.company.db.get("SELECT 1 AS ok FROM activity_events WHERE action = 'live-voice.session'"));
  } finally { await env.close(); }
});

test("meeting call: «سمعني؟» is answered by the chair without inference; later speakers arrive as spoken updates after the current turn", async () => {
  const env = await setup();
  try {
    for (const policy of env.company.listPolicies()) env.company.updatePolicy(policy.domain, { candidates: ["nvidia/model-a"] });
    const meeting = env.meetings.create({ title: "اجتماع صوتي", participants: ["ori", "nex"], mode: "voice" });
    env.meetings.start(meeting.id);
    const call = await env.call({ kind: "meeting", id: meeting.id });
    await until(() => env.google.received.length);
    env.google.push({ setupComplete: {} });
    await until(() => call.events.some((e) => e.type === "ready"));

    env.google.push({ serverContent: { inputTranscription: { text: "سمعني؟" } } });
    env.google.push({ toolCall: { functionCalls: [{ id: "m1", name: "ask_company", args: { request: "سمعني" } }] } });
    const first = (await until(() => env.google.received.find((m) => m.toolResponse))).toolResponse.functionResponses[0];
    assert.equal(first.response.ok, true);
    assert.equal(first.response.reply, "أيوه، سامعك. اتفضل.");
    assert.equal(env.company.listRuns({ limit: 20 }).filter((r) => r.meetingId === meeting.id).length, 1, "only the chair ran");

    env.google.received.length = 0;
    env.google.push({ serverContent: { inputTranscription: { text: "كلكم قولوا رأيكم في الخطة" } } });
    env.google.push({ toolCall: { functionCalls: [{ id: "m2", name: "ask_company", args: { request: "x" } }] } });
    const second = (await until(() => env.google.received.find((m) => m.toolResponse))).toolResponse.functionResponses[0];
    assert.equal(second.response.speaker, "ORI");
    assert.match(second.response.reply, /رد تجريبي/);
    await sleep(150);
    assert.equal(env.google.received.some((m) => m.clientContent), false, "no update is injected while the model may still be speaking");
    env.google.push({ serverContent: { turnComplete: true } });
    const update = (await until(() => env.google.received.find((m) => m.clientContent))).clientContent.turns[0].parts[0].text;
    assert.match(update, /^\[تحديث من الاجتماع\] .+ بيقول: /);
    call.browser.close();
  } finally { await env.close(); }
});

test("a failed run is reported honestly to the model; a second call while one is running is refused, not duplicated", async () => {
  const env = await setup();
  try {
    const thread = env.conversations.create({ agentId: "ori" });
    env.company.updateAgent?.("ori", { enabled: false });
    const call = await env.call({ kind: "chat", id: thread.id });
    await until(() => env.google.received.length);
    env.google.push({ setupComplete: {} });
    await until(() => call.events.some((e) => e.type === "ready"));
    env.google.push({ serverContent: { inputTranscription: { text: "اعمللي تقرير" } } });
    env.google.push({ toolCall: { functionCalls: [{ id: "f1", name: "ask_company", args: { request: "x" } }, { id: "f2", name: "ask_company", args: { request: "y" } }] } });
    const responses = await until(() => { const all = env.google.received.filter((m) => m.toolResponse).flatMap((m) => m.toolResponse.functionResponses); return all.length >= 2 ? all : null; });
    assert.ok(responses.some((r) => r.id === "f2" && r.response.note), "second concurrent call is refused");
    const first = responses.find((r) => r.id === "f1");
    assert.equal(first.response.ok, false);
    assert.ok(first.response.reason);
  } finally { await env.close(); }
});

test("keys: the AQ. format and up to three keys are accepted; a rejected key is reported by position, never echoed", async () => {
  const env = await setup({ withKey: false, google: { validKeys: [KEY, KEY_B] } });
  try {
    const saved = await env.live.setKey({ keys: [KEY, KEY_B], acknowledgeFreeTier: true });
    assert.equal(saved.keyCount, 2);
    assert.deepEqual(saved.keys, [{ position: 1, ok: true }, { position: 2, ok: true }]);
    assert.equal(JSON.stringify(saved).includes(KEY_B), false);
    assert.equal(readFileSync(join(env.home, "gemini.key"), "utf8"), `${KEY}
${KEY_B}`);
    await assert.rejects(env.live.setKey({ keys: [KEY, "AQ.NotARealKeyNotARealKeyNotARealKey12"], acknowledgeFreeTier: true }), (error) => error.code === "gemini-key-rejected" && /رقم 2/.test(error.messageAr));
    await assert.rejects(env.live.setKey({ keys: [KEY, KEY_B, "AQ.Third_key_for_tests_0123456789abcdef", "AQ.Fourth_key_for_tests_0123456789abcde"], acknowledgeFreeTier: true }), { code: "validation" });
    assert.equal(env.live.status().keyCount, 2, "a failed save leaves the saved keys untouched");
  } finally { await env.close(); }
});

test("failover: when Google refuses the first key's session, the call continues on the next key without the browser noticing a failure", async () => {
  const env = await setup({ withKey: false, google: { validKeys: [KEY, KEY_B], refuseSessions: [KEY] } });
  try {
    await env.live.setKey({ keys: [KEY, KEY_B], acknowledgeFreeTier: true });
    const thread = env.conversations.create({ agentId: "ori" });
    const call = await env.call({ kind: "chat", id: thread.id });
    await until(() => env.google.received.length);
    assert.deepEqual(env.google.sessionKeys, [KEY, KEY_B], "first key tried, then the backup");
    env.google.push({ setupComplete: {} });
    await until(() => call.events.some((e) => e.type === "ready"));
    assert.equal(call.events.some((e) => e.type === "error"), false);
    assert.ok(call.events.some((e) => e.type === "reconnecting"));
  } finally { await env.close(); }
});
