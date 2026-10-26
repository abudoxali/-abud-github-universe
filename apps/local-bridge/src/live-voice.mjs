/* Gemini Live voice front-end. Google's Live model is only the owner's ears and mouth: it hears the microphone, speaks
 * Egyptian Arabic, and has exactly ONE tool, `ask_company`. Every real request goes through that tool into the normal
 * conversation or meeting path (same runtime, OmniRoute routing, permissions, approvals, memory and audit), exactly as if
 * the owner had typed it. Google never receives company data except the agent reply it is asked to say aloud.
 * The API key stays on this machine: the browser talks to this Bridge, and only the Bridge talks to Google. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { HttpError } from "./company.mjs";

const GOOGLE_HTTP = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const LIVE_WS_PATH = "/local-api/company/live-voice/ws";
const KEY_PATTERN = /^[A-Za-z0-9._-]{30,120}$/;
const MAX_KEYS = 3;
const START_TIMEOUT_MS = 5000;
const REPLY_TIMEOUT_MS = 180_000;
const POLL_MS = 200;
const MAX_SPOKEN_CHARS = 1500;
const VOICES = { ori: "Orus", mia: "Kore", nex: "Puck", luna: "Aoede", zen: "Fenrir", rex: "Charon" };
const DEFAULT_VOICE = "Kore";
const OWNER = { type: "owner", id: "owner" };

/** Higher is better: newest generation first, extended-thinking variants last (they add latency). */
export function pickLiveModel(ids) {
  const score = (id) => (/extended/.test(id) ? -20 : 0) + (/3\.8/.test(id) ? 40 : /3\.\d/.test(id) ? 30 : /2\.5/.test(id) ? 20 : 10)
    + (/live/.test(id) ? 6 : 0) + (/native-audio/.test(id) ? 3 : 0) - (/preview|exp/.test(id) ? 1 : 0);
  return [...ids].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Plain text for speech: no markdown marks, links or code fences. */
export function toSpeech(value) {
  return String(value ?? "").replace(/```[\s\S]*?```/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#>|]/g, "")
    .replace(/^\s*[-•]\s+/gm, "").replace(/\s+\n/g, "\n").trim().slice(0, MAX_SPOKEN_CHARS);
}

export function buildInstruction({ agent, meeting = null }) {
  const lines = [
    `أنت ${agent.name}، ${agent.titleAr} في شركة ABUD FUN، وبتتكلم بالصوت مباشرة مع المالك عبدالله.`,
    "اتكلم باللهجة المصرية الطبيعية، بجمل قصيرة ومن غير مقدمات أو مجاملات طويلة.",
    "قاعدة الشغل: أي سؤال أو طلب يخص الشغل أو الشركة أو المشاريع أو المهام أو الأرقام أو القرارات أو الرأي لازم تنادي الأداة ask_company الأول، وبعدين تقول للمالك نتيجتها بصوتك في جملتين أو تلاتة. ممنوع تخمّن أو تضيف معلومة أو رقم مش موجود في النتيجة.",
    "الاستثناء الوحيد اللي ترد عليه بنفسك من غير الأداة: التحية، «سامعني؟»، الشكر، «تمام/ماشي»، أو طلب إعادة الجملة.",
    "قبل ما تنادي الأداة قول كلمة قصيرة واحدة زي «ثانية أشوف». لو النتيجة فيها فشل أو رفض أو محتاجة موافقة المالك، قول ده بصراحة وببساطة.",
    "لا تقول إنك نموذج من جوجل ولا إنك بتستخدم أداة؛ إنت " + agent.name + "."
  ];
  if (meeting) lines.push(
    `إنت في اجتماع «${meeting.title}» ومعاك: ${meeting.participants.map((p) => p.name).join("، ")}. النتيجة بتيجي باسم المتكلم؛ انسب الكلام له («نكس بيقول إن…»).`,
    "لو جالك رسالة تبدأ بـ «[تحديث من الاجتماع]» قولها فورًا بنفس الأسلوب وانسبها لصاحبها، من غير ما تنادي الأداة."
  );
  return lines.join("\n");
}

export function buildSetup({ model, instruction, voice, handle = null }) {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      systemInstruction: { parts: [{ text: instruction }] },
      tools: [{ functionDeclarations: [{
        name: "ask_company",
        description: "ابعت كلام المالك للشركة (الوكلاء بأدواتهم وصلاحياتهم) وارجع بالرد. نادِها لأي سؤال أو طلب شغل.",
        parameters: { type: "OBJECT", properties: { request: { type: "STRING", description: "كلام المالك بنصه زي ما قاله" } }, required: ["request"] }
      }] }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 600 } },
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: handle ? { handle } : {}
    }
  };
}

export function createLiveVoice({ company, conversations, meetings, runtime, env = process.env, home = null, fetchImpl = globalThis.fetch,
  endpoints = {}, log = () => {}, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const httpBase = endpoints.http || GOOGLE_HTTP, wsBase = endpoints.ws || GOOGLE_WS;
  const dir = home || (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "ABUD-FUN-OS", "gemini-live") : null);
  const keyFile = dir && join(dir, "gemini.key"), prefsFile = dir && join(dir, "prefs.json");
  const sessions = new Set();
  let wss = null, cachedModel = null;

  function readPrefs() { try { return JSON.parse(readFileSync(prefsFile, "utf8")); } catch (_) { return {}; } }
  const splitKeys = (text) => [...new Set(String(text ?? "").split(/[\s,;]+/).map((k) => k.trim()).filter(Boolean))];
  /** Up to three keys, tried in order: the next one is used only when Google refuses or exhausts the current one. */
  function readKeys() {
    const fromEnv = splitKeys(env.GEMINI_LIVE_API_KEY).slice(0, MAX_KEYS);
    if (fromEnv.length) return { keys: fromEnv, source: "env" };
    try { const keys = splitKeys(readFileSync(keyFile, "utf8")).slice(0, MAX_KEYS); if (keys.length) return { keys, source: "file" }; } catch (_) { /* not configured */ }
    return null;
  }
  function status() {
    const found = readKeys();
    return { engine: "gemini-live", configured: Boolean(found), keyCount: found?.keys.length ?? 0, source: found?.source ?? null, acknowledgedFreeTier: readPrefs().acknowledgedFreeTier === true,
      model: cachedModel, canStoreKey: Boolean(dir), activeSessions: sessions.size };
  }

  async function listLiveModels(key) {
    let response;
    try { response = await fetchImpl(`${httpBase}/models?pageSize=200`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15000) }); }
    catch (_) { throw new HttpError(502, "gemini-unreachable", "تعذّر الوصول لخدمة جوجل. راجع الإنترنت."); }
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new HttpError(422, "gemini-key-rejected", "جوجل رفضت المفتاح. تأكد إنه مفتاح AI Studio صحيح.");
    if (!response.ok) throw new HttpError(502, "gemini-error", `خدمة جوجل ردت بخطأ (${response.status})`);
    const body = await response.json().catch(() => ({}));
    return (body.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("bidiGenerateContent")).map((m) => String(m.name).replace(/^models\//, ""));
  }
  async function resolveModel(key) {
    if (env.ABUD_LIVE_GEMINI_MODEL) return (cachedModel = env.ABUD_LIVE_GEMINI_MODEL);
    if (cachedModel) return cachedModel;
    const ids = await listLiveModels(key);
    const chosen = pickLiveModel(ids);
    if (!chosen) throw new HttpError(422, "gemini-no-live-model", "المفتاح ده مفيهوش موديل صوت مباشر (Live) متاح.");
    return (cachedModel = chosen);
  }

  /** Checks every key against Google. Reports only which positions work, never the keys. */
  async function checkKeys(keys) {
    const results = [];
    for (const key of keys) {
      try { const ids = await listLiveModels(key); results.push({ ok: Boolean(pickLiveModel(ids)), ids }); }
      catch (error) { if (error.code === "gemini-unreachable") throw error; results.push({ ok: false, code: error.code, ids: [] }); }
    }
    return results;
  }
  async function test() {
    const found = readKeys();
    if (!found) throw new HttpError(409, "not-configured", "مفيش مفتاح Gemini متسجل");
    cachedModel = null;
    const checks = await checkKeys(found.keys);
    const first = checks.find((c) => c.ok);
    if (!first) throw new HttpError(422, "gemini-key-rejected", "جوجل رفضت كل المفاتيح المسجلة.");
    cachedModel = env.ABUD_LIVE_GEMINI_MODEL || pickLiveModel(first.ids);
    return { ...status(), model: cachedModel, keys: checks.map((c, i) => ({ position: i + 1, ok: c.ok })) };
  }
  async function setKey({ key, keys, acknowledgeFreeTier } = {}) {
    if (!dir) throw new HttpError(409, "no-storage", "مفيش مكان آمن لحفظ المفتاح على الجهاز ده");
    const list = splitKeys(Array.isArray(keys) ? keys.join("\n") : (keys ?? key));
    if (!list.length || list.length > MAX_KEYS || list.some((value) => !KEY_PATTERN.test(value))) throw new HttpError(422, "validation", `شكل المفتاح غير صحيح (من 1 إلى ${MAX_KEYS} مفاتيح، كل واحد في سطر)`);
    if (acknowledgeFreeTier !== true) throw new HttpError(422, "ack-required", "لازم توافق إن النسخة المجانية بتسمح لجوجل تستخدم الصوت والنص لتحسين منتجاتها");
    cachedModel = null;
    const checks = await checkKeys(list);
    const bad = checks.findIndex((c) => !c.ok);
    if (bad >= 0) throw new HttpError(422, checks[bad].code || "gemini-key-rejected", `جوجل رفضت المفتاح رقم ${bad + 1}. تأكد إنه مفتاح AI Studio صحيح وفيه موديل Live.`);
    const model = (cachedModel = env.ABUD_LIVE_GEMINI_MODEL || pickLiveModel(checks[0].ids));
    mkdirSync(dir, { recursive: true });
    writeFileSync(keyFile, list.join("\n"), { encoding: "utf8", mode: 0o600 });
    writeFileSync(prefsFile, JSON.stringify({ acknowledgedFreeTier: true, acknowledgedAt: new Date().toISOString() }));
    company.log({ actorType: "owner", actorId: "owner", action: "live-voice.key.set", targetType: "system", targetId: "live-voice", summary: `تم حفظ ${list.length} مفتاح Gemini Live على الجهاز`, metadata: { model, keyCount: list.length } });
    return { ...status(), model, keys: checks.map((c, i) => ({ position: i + 1, ok: c.ok })) };
  }
  function clearKey() {
    if (keyFile) rmSync(keyFile, { force: true });
    cachedModel = null;
    for (const session of [...sessions]) session.end("key-removed");
    company.log({ actorType: "owner", actorId: "owner", action: "live-voice.key.removed", targetType: "system", targetId: "live-voice", summary: "تم حذف مفتاح Gemini Live" });
    return status();
  }

  // ------------------------------------------------------------------ the tool: one request into the company
  const runPending = (id) => runtime ? company.db.get("SELECT id FROM agent_runs WHERE conversation_id = ? AND status IN ('queued','running') LIMIT 1", id) : null;

  async function askChat(threadId, text) {
    let sent;
    try { sent = conversations.send(threadId, { content: text }); }
    catch (error) {
      if (error.code !== "conversation-busy") throw error;
      const busy = runPending(threadId);
      if (busy) { try { runtime.cancel(busy.id, OWNER); } catch (_) { /* finished meanwhile */ } }
      sent = conversations.send(threadId, { content: text });
    }
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    for (;;) {
      const run = company.getRun(sent.run.id);
      if (!["queued", "running"].includes(run.status)) {
        if (run.status === "succeeded") return { runId: run.id, replies: [{ speaker: company.agentById(run.agentId)?.name ?? run.agentId, text: toSpeech(run.output) }] };
        return { runId: run.id, failure: run.status === "blocked" ? "الرد محتاج موافقة منك أو متوقف بسياسة" : run.status === "cancelled" ? "اتلغى" : (run.errorMessage || "تعذّر الرد") };
      }
      if (Date.now() > deadline) return { runId: run.id, failure: "الرد اتأخر أوي" };
      await wait(POLL_MS);
    }
  }

  /** Yields each speaker's completed turn as soon as it finishes; the first one is spoken at once. */
  async function* meetingReplies(meetingId, text) {
    const clientMessageId = `live_${randomBytes(8).toString("hex")}`;
    let view;
    try { view = await meetings.say(meetingId, { content: text, clientMessageId }); }
    catch (error) {
      if (error.code !== "meeting-busy") throw error;
      meetings.interrupt(meetingId);
      view = await meetings.say(meetingId, { content: text, clientMessageId: `live_${randomBytes(8).toString("hex")}` });
    }
    const round = view.turns.filter((t) => ["queued", "in-flight"].includes(t.status)).sort((a, b) => a.seq - b.seq);
    const sinceSeq = Math.min(...round.map((t) => t.seq)) - 1;
    const pending = new Map(round.map((t) => [t.id, t]));
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (pending.size && Date.now() < deadline) {
      const current = meetings.get(meetingId, { sinceSeq });
      for (const turn of current.turns) {
        if (!pending.has(turn.id) || ["queued", "in-flight"].includes(turn.status)) continue;
        pending.delete(turn.id);
        yield turn.status === "completed" ? { speaker: turn.speakerName, text: toSpeech(turn.content) } : { speaker: turn.speakerName, failure: turn.status === "interrupted" ? "اتقاطع" : "تعذّر الرد" };
      }
      if (current.status !== "active" && !current.turns.some((t) => pending.has(t.id) && ["queued", "in-flight"].includes(t.status))) break;
      if (pending.size) await wait(POLL_MS);
    }
  }

  // ------------------------------------------------------------------ one call = one browser socket + one Google socket
  function startSession(browser, context) {
    const found = readKeys();
    if (!found) return fail(browser, "not-configured", "مفيش مفتاح Gemini متسجل. سجّله من إعدادات النظام.");
    let agent, meeting = null, key;
    try {
      if (context.kind === "meeting") {
        meeting = meetings.get(context.id);
        if (meeting.status !== "active") throw new HttpError(409, "meeting-state", "ابدأ الاجتماع الأول");
        agent = company.agentById(meeting.chair);
      } else if (context.kind === "chat") {
        const thread = conversations.get(context.id);
        agent = company.agentById(thread.agentId);
      } else throw new HttpError(422, "validation", "نوع المكالمة غير معروف");
      if (!agent) throw new HttpError(404, "not-found", "الوكيل غير موجود");
      key = `${context.kind}:${context.id}`;
    } catch (error) { return fail(browser, error.code || "failed", error.messageAr || error.message); }

    const state = { keyIndex: 0, google: null, ready: false, ended: false, handle: null, reconnects: 0, pendingInput: "", outputText: "", busy: false,
      followups: [], speaking: false, modelBusy: false, callIds: new Map(), tools: 0, tokens: 0, startedAt: Date.now() };
    const toBrowser = (message) => { if (browser.readyState === 1) browser.send(JSON.stringify(message)); };
    const toGoogle = (message) => { if (state.google?.readyState === 1) state.google.send(JSON.stringify(message)); };
    const session = { end };
    sessions.add(session);

    function end(reason = "ended") {
      if (state.ended) return;
      state.ended = true;
      sessions.delete(session);
      try { state.google?.close(); } catch (_) { /* already closed */ }
      toBrowser({ type: "ended", reason });
      try { browser.close(); } catch (_) { /* already closed */ }
      company.log({ actorType: "owner", actorId: "owner", action: "live-voice.session", targetType: context.kind, targetId: context.id, summary: `مكالمة Gemini Live (${Math.round((Date.now() - state.startedAt) / 1000)} ثانية)`,
        metadata: { model: cachedModel, agentId: agent.id, toolCalls: state.tools, totalTokens: state.tokens, reason } });
    }

    async function connect() {
      let model;
      const apiKey = found.keys[state.keyIndex];
      try { model = await resolveModel(apiKey); }
      catch (error) {
        if (error.code === "gemini-key-rejected" && state.keyIndex + 1 < found.keys.length) { state.keyIndex++; state.handle = null; return connect(); }
        toBrowser({ type: "error", code: error.code || "failed", message: error.messageAr || error.message }); return end(error.code || "failed");
      }
      const google = new WebSocket(`${wsBase}?key=${encodeURIComponent(apiKey)}`);
      state.google = google;
      google.on("open", () => toGoogle(buildSetup({ model, instruction: buildInstruction({ agent, meeting }), voice: VOICES[agent.id] || DEFAULT_VOICE, handle: state.handle })));
      google.on("message", (data) => { let message; try { message = JSON.parse(data.toString("utf8")); } catch (_) { return; } onGoogle(message).catch((error) => log(JSON.stringify({ event: "live-voice-error", message: String(error?.message || error).slice(0, 200) }))); });
      google.on("error", (error) => log(JSON.stringify({ event: "live-voice-socket-error", message: String(error?.message || error).slice(0, 200) })));
      google.on("close", (code, reason) => {
        if (state.ended || state.google !== google) return;
        const exhausted = !state.ready || /quota|exhaust|rate|limit/i.test(String(reason || ""));
        if (exhausted && state.keyIndex + 1 < found.keys.length) { state.keyIndex++; state.handle = null; state.ready = false; toBrowser({ type: "reconnecting" }); connect(); return; }
        if (state.handle && state.reconnects < 2) { state.reconnects++; state.ready = false; toBrowser({ type: "reconnecting" }); connect(); return; }
        toBrowser({ type: "error", code: "google-closed", message: String(reason || "").slice(0, 200) || `انقطع الاتصال بجوجل (${code})` });
        end("google-closed");
      });
    }

    async function onGoogle(message) {
      if (message.setupComplete) { state.ready = true; toBrowser({ type: "ready", model: cachedModel, agent: agent.name }); return; }
      if (message.usageMetadata?.totalTokenCount) state.tokens = message.usageMetadata.totalTokenCount;
      if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) state.handle = message.sessionResumptionUpdate.newHandle;
      if (message.goAway) { toBrowser({ type: "reconnecting" }); if (state.handle) { try { state.google.close(); } catch (_) { /* reconnect via close handler */ } } return; }
      const content = message.serverContent;
      if (content) {
        for (const part of content.modelTurn?.parts || []) {
          if (part.inlineData?.data && /^audio\//.test(part.inlineData.mimeType || "")) {
            if (!state.speaking) { state.speaking = true; toBrowser({ type: "speaking" }); }
            if (browser.readyState === 1) browser.send(Buffer.from(part.inlineData.data, "base64"), { binary: true });
          }
        }
        if (content.inputTranscription?.text) { state.pendingInput += content.inputTranscription.text; toBrowser({ type: "input", text: state.pendingInput.trim() }); }
        if (content.outputTranscription?.text) { state.outputText += content.outputTranscription.text; toBrowser({ type: "output", text: state.outputText.trim() }); }
        if (content.interrupted) { state.speaking = false; state.modelBusy = false; state.followups = []; toBrowser({ type: "interrupted" }); }
        if (content.turnComplete) { state.speaking = false; state.modelBusy = false; state.outputText = ""; toBrowser({ type: "turn-complete" }); flushFollowups(); }
      }
      if (message.toolCall?.functionCalls) for (const call of message.toolCall.functionCalls) handleCall(call);
      if (message.toolCallCancellation?.ids) for (const id of message.toolCallCancellation.ids) cancelCall(id);
    }

    function respond(call, response) { state.modelBusy = true; toGoogle({ toolResponse: { functionResponses: [{ id: call.id, name: call.name, response }] } }); }

    async function handleCall(call) {
      if (call.name !== "ask_company") return respond(call, { error: "unknown-tool" });
      const text = (state.pendingInput.trim() || String(call.args?.request ?? "").trim()).slice(0, 4000);
      state.pendingInput = "";
      if (!text) return respond(call, { error: "لم يصل كلام واضح" });
      if (state.busy) return respond(call, { note: "في طلب شغال دلوقتي؛ استنى نتيجته" });
      state.busy = true; state.tools++;
      const record = { cancelled: false, runId: null, meetingId: null };
      state.callIds.set(call.id, record);
      toBrowser({ type: "working", request: text });
      try {
        if (context.kind === "meeting") {
          const iterator = meetingReplies(context.id, text);
          record.meetingId = context.id;
          toBrowser({ type: "refresh", key });
          const first = await iterator.next();
          if (record.cancelled) return;
          if (first.done) respond(call, { ok: false, reason: "مفيش حد رد" });
          else respond(call, first.value.failure ? { ok: false, speaker: first.value.speaker, reason: first.value.failure } : { ok: true, speaker: first.value.speaker, reply: first.value.text });
          toBrowser({ type: "refresh", key });
          for await (const next of iterator) {
            if (record.cancelled) break;
            toBrowser({ type: "refresh", key });
            if (!next.failure && next.text) { state.followups.push(`[تحديث من الاجتماع] ${next.speaker} بيقول: ${next.text}`); flushFollowups(); }
          }
        } else {
          toBrowser({ type: "refresh", key });
          const result = await askChat(context.id, text);
          record.runId = result.runId;
          if (record.cancelled) return;
          respond(call, result.failure ? { ok: false, speaker: agent.name, reason: result.failure } : { ok: true, speaker: result.replies[0].speaker, reply: result.replies[0].text });
          toBrowser({ type: "refresh", key });
        }
      } catch (error) {
        if (!record.cancelled) respond(call, { ok: false, reason: String(error.messageAr || error.message || "تعذّر التنفيذ").slice(0, 200) });
      } finally { state.busy = false; state.callIds.delete(call.id); }
    }

    function cancelCall(id) {
      const record = state.callIds.get(id);
      if (!record) return;
      record.cancelled = true;
      try { if (record.runId) runtime.cancel(record.runId, OWNER); if (record.meetingId) meetings.interrupt(record.meetingId); } catch (_) { /* already settled */ }
      toBrowser({ type: "refresh", key });
    }

    function flushFollowups() {
      if (state.speaking || state.modelBusy || !state.ready || !state.followups.length) return;
      const text = state.followups.shift();
      state.modelBusy = true;
      toGoogle({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
    }

    browser.on("message", (data, isBinary) => {
      if (state.ended) return;
      if (isBinary) { if (state.ready) toGoogle({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: Buffer.from(data).toString("base64") } } }); return; }
      let message; try { message = JSON.parse(data.toString("utf8")); } catch (_) { return; }
      if (message.type === "stop") end("stopped");
      if (message.type === "pause") toGoogle({ realtimeInput: { audioStreamEnd: true } });
    });
    browser.on("close", () => end("browser-closed"));
    connect();
  }

  function fail(browser, code, message) {
    if (browser.readyState === 1) browser.send(JSON.stringify({ type: "error", code, message }));
    try { browser.close(); } catch (_) { /* already closed */ }
  }

  /** Takes WebSocket upgrades for LIVE_WS_PATH only. `authorize` checks the host/origin; the first message carries the session token. */
  function attach(server, { isLocal, tokenOk }) {
    wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on("upgrade", (request, socket, head) => {
      let path = ""; try { path = new URL(request.url || "/", "http://127.0.0.1").pathname; } catch (_) { /* malformed */ }
      if (path !== LIVE_WS_PATH || !isLocal(request)) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, (browser) => {
        const timer = setTimeout(() => fail(browser, "start-timeout", "لم تبدأ المكالمة"), START_TIMEOUT_MS);
        browser.once("message", (data, isBinary) => {
          clearTimeout(timer);
          let message; try { message = isBinary ? null : JSON.parse(data.toString("utf8")); } catch (_) { message = null; }
          if (!message || message.type !== "start" || !tokenOk(message.token)) return fail(browser, "session-required", "انتهت الجلسة؛ أعد تحميل الصفحة");
          const context = { kind: String(message.context?.kind || ""), id: String(message.context?.id || "") };
          startSession(browser, context);
        });
      });
    });
  }
  function stop() { for (const session of [...sessions]) session.end("bridge-stopping"); wss?.close(); }

  return { status, setKey, clearKey, test, attach, stop, listLiveModels };
}
