/* Live conversation. Primary engine: Gemini Live through the local Bridge — the microphone streams as 16 kHz PCM, the
 * model's spoken reply streams back as 24 kHz PCM, and every real request runs through the normal agent path on the
 * Bridge (tools, permissions, OmniRoute). Fallback when no Gemini key is configured: browser SpeechRecognition (ar-EG)
 * plus a local Egyptian TTS or the browser's ar-EG voice, fed by the existing agent run streams. */
(() => {
  "use strict";
  const O = window.AbudOps;
  if (!O) return;
  const { h, toast } = O;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;
  const listeners = new Set(), baselines = new Map(), spokenMessages = new Set(), streamedRuns = new Set(), streams = new Map(), suppressed = new Set();
  const overrides = new Map();
  let gemini = { configured: false, model: null };
  const GEMINI_PHASE = { connecting: "بيتصل…", listening: "سامعك دلوقتي", working: "بيشتغل على طلبك…", speaking: "بيرد بالصوت…" };
  const geminiReady = () => gemini.configured && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(window.AudioContext);
  async function loadGemini() {
    try {
      const response = await fetch("/local-api/company/live-voice/status", { cache: "no-store", headers: { Accept: "application/json" } });
      if (response.ok) { gemini = await response.json(); notify(); }
    } catch (_) { /* Bridge unreachable: the local fallback keeps working */ }
  }
  let live = null, dictation = null, speaking = null, queue = [], epoch = 0, localReady = false, warming = null, enabled = sessionStorage.getItem("abud.voice.reply") !== "off";

  function egyptianVoices() {
    return synth?.getVoices().filter((voice) => /^ar[-_]EG$/i.test(voice.lang)) || [];
  }
  function status() {
    if (geminiReady()) return { state: "ready", engine: "Gemini Live", model: gemini.model, voices: [] };
    if (!Recognition) return { state: "unavailable", reasonAr: "التعرف المباشر على الكلام غير متاح في هذا المتصفح" };
    if (!synth && !localReady) return { state: "unavailable", reasonAr: "النطق غير متاح في هذا المتصفح" };
    const voices = egyptianVoices();
    if (!voices.length && !localReady) return { state: "unavailable", reasonAr: "لا يوجد صوت عربي مصري (ar-EG) متاح في المتصفح" };
    return { state: "ready", engine: localReady ? "KemeTone" : "browser", voices: voices.map((voice) => ({ name: voice.name, lang: voice.lang, local: voice.localService })) };
  }
  const usable = () => status().state === "ready";
  function warm() {
    if (warming || localReady) return warming;
    warming = O.mutate("POST", "/live-audio/warm", {}).then(() => { localReady = true; notify(); }).catch(() => { localReady = false; }).finally(() => { warming = null; });
    return warming;
  }
  const notify = () => { for (const listener of listeners) { if (!listener.node.isConnected) listeners.delete(listener); else listener.update(); } };
  const setRobot = (agentId, state) => { if (agentId) { if (state) overrides.set(agentId, state); else overrides.delete(agentId); } notify(); };
  const onRoute = (key) => {
    const [kind, id] = key.split(":");
    const path = decodeURIComponent(location.hash).split("/").slice(1);
    return path[0] === "agents" && path[1] === (kind === "chat" ? "chat" : "meetings") && path[2] === id;
  };

  function stopPlayback() {
    if (live?.engine === "gemini") { flushGemini(live); notify(); return; }
    epoch++;
    if (live) for (const key of streams.keys()) if (key.startsWith(`${live.key}:`)) suppressed.add(key);
    queue = [];
    speaking?.controller?.abort();
    if (speaking?.audio) { speaking.audio.pause(); URL.revokeObjectURL(speaking.url); }
    if (synth) synth.cancel();
    if (speaking) setRobot(speaking.agentId, null);
    speaking = null;
    maybeListen();
    notify();
  }
  async function playNext() {
    if (speaking || !enabled) return;
    const next = queue.shift();
    if (!next) { maybeListen(); notify(); return; }
    const voices = egyptianVoices();
    const generation = epoch;
    const controller = new AbortController();
    speaking = { agentId: next.agentId, controller };
    setRobot(next.agentId, "speaking");
    const done = () => {
      if (epoch !== generation) return;
      if (speaking?.url) URL.revokeObjectURL(speaking.url);
      speaking = null;
      setRobot(next.agentId, null);
      playNext();
    };
    try {
      if (!localReady) throw new Error("local-tts-warming");
      const token = await O.session();
      const response = await fetch("/local-api/company/live-audio/tts", { method: "POST", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Abud-Session": token }, body: JSON.stringify({ text: next.text }) });
      if (!response.ok) throw new Error("local-tts-unavailable");
      const url = URL.createObjectURL(await response.blob());
      if (epoch !== generation) { URL.revokeObjectURL(url); return; }
      const audio = new Audio(url);
      speaking = { agentId: next.agentId, audio, url, controller };
      audio.onended = done; audio.onerror = done;
      await audio.play();
    } catch (error) {
      if (epoch !== generation || controller.signal.aborted) return;
      if (speaking?.url) URL.revokeObjectURL(speaking.url);
      if (!voices.length || !synth) { toast("النطق المصري غير متاح دلوقتي", "warn"); done(); return; }
      const utterance = new SpeechSynthesisUtterance(next.text);
      utterance.lang = "ar-EG";
      utterance.voice = voices[0];
      utterance.rate = 1.06;
      utterance.onend = done; utterance.onerror = done;
      speaking = { agentId: next.agentId, utterance, controller };
      synth.speak(utterance);
    }
    notify();
  }
  function speak(agentId, text) {
    if (live?.engine === "gemini" || !enabled || !usable()) return;
    const clean = String(text || "").replace(/\*\*|^#{1,6}\s*/gm, "").trim();
    if (!clean) return;
    queue.push({ agentId, text: clean.slice(0, 550) });
    if (live?.phase === "listening") { live.phase = "waiting"; live.recognition.stop(); }
    playNext();
  }
  function feedStream(key, runId, agentId, cumulative, final = false) {
    if (!live || live.engine === "gemini" || live.key !== key || !enabled || !usable()) return;
    const streamKey = `${key}:${runId || agentId}`;
    if (suppressed.has(streamKey)) { if (final) { suppressed.delete(streamKey); streams.delete(streamKey); liveResponse(key); } return; }
    if (final && runId && streamedRuns.has(runId) && !streams.has(streamKey)) { liveResponse(key); return; }
    if (runId) streamedRuns.add(runId);
    const text = String(cumulative || "").replace(/\*\*|^#{1,6}\s*/gm, "");
    const state = streams.get(streamKey) || { sent: 0, text: "" };
    if (text.startsWith(state.text)) state.text = text;
    else { state.sent = 0; state.text = text; }
    let remaining = state.text.slice(state.sent);
    while (remaining) {
      const match = remaining.match(/^[\s\S]*?[.!؟\n،؛](?=\s|$)/u);
      const length = match && match[0].trim().length >= 8 ? match[0].length
        : remaining.length >= 120 ? Math.max(remaining.lastIndexOf(" ", 110) + 1, 110)
          : final ? remaining.length : 0;
      if (!length) break;
      const part = remaining.slice(0, length).trim();
      state.sent += length;
      remaining = state.text.slice(state.sent);
      if (part) speak(agentId, part);
    }
    streams.set(streamKey, state);
    if (final) { streams.delete(streamKey); liveResponse(key); }
  }
  function observe(key, agentId, messages) {
    const done = (messages || []).filter((m) => m.role === "assistant" && m.state === "complete" && m.content);
    const last = done.at(-1);
    if (!baselines.has(key)) { baselines.set(key, last?.id || null); return; }
    if (!last || last.id === baselines.get(key)) return;
    baselines.set(key, last.id);
    if (spokenMessages.has(last.id) || (last.runId && streamedRuns.has(last.runId))) return;
    spokenMessages.add(last.id);
    if (live?.key === `chat:${key}`) speak(agentId, last.content);
  }

  function maybeListen() {
    if (!live || live.phase !== "waiting" || live.busy || !live.responseSeen || speaking || queue.length || document.hidden) return;
    live.responseSeen = false;
    live.phase = "listening";
    setRobot(live.agentId, "listening");
    try { live.recognition.start(); } catch (_) { toast("تعذّر استئناف الميكروفون؛ ابدأ المكالمة مرة أخرى", "warn"); stopLive(); }
    notify();
  }
  function liveResponse(key) {
    if (live?.key !== key) return;
    live.responseSeen = true;
    maybeListen();
  }
  function updateLive(key, { busy = false, active = true } = {}) {
    if (live?.key !== key) return;
    if (!active) return stopLive();
    live.busy = busy;
    maybeListen();
  }
  function stopLive() {
    epoch++;
    const old = live;
    live = null;
    if (old?.engine === "gemini") {
      stopGemini(old);
      setRobot(old.agentId, null);
      notify();
      return;
    }
    if (old) {
      old.recognition.onend = null;
      old.recognition.onresult = null;
      try { old.recognition.abort(); } catch (_) { /* already stopped */ }
      setRobot(old.agentId, null);
    }
    if (dictation) { try { dictation.abort(); } catch (_) { /* already stopped */ } dictation = null; }
    stopPlayback();
    notify();
  }
  function startLive({ key, agentId, onTurn }) {
    const available = status();
    if (available.state !== "ready") { toast(available.reasonAr, "warn"); return false; }
    if (!onRoute(key)) return false;
    if (geminiReady()) return startGemini({ key, agentId });
    stopLive();
    const recognition = new Recognition();
    recognition.lang = "ar-EG";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    const session = { key, agentId, onTurn, recognition, phase: "listening", busy: false, responseSeen: false, interim: "", lastError: "" };
    live = session;
    recognition.onresult = (event) => {
      if (live !== session || session.phase !== "listening") return;
      const finals = [], partials = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const value = event.results[i][0]?.transcript?.trim();
        if (!value) continue;
        (event.results[i].isFinal ? finals : partials).push(value);
      }
      session.interim = partials.join(" ");
      if (finals.length) {
        const text = finals.join(" ").trim();
        session.phase = "waiting";
        session.busy = true;
        session.responseSeen = false;
        session.interim = text;
        recognition.stop();
        Promise.resolve(onTurn(text)).then((ok) => {
          if (live === session && ok === false) { toast("تعذّر إرسال الكلام", "bad"); stopLive(); }
        }).catch((error) => { if (live === session) { toast(error.message || "تعذّر إرسال الكلام", "bad"); stopLive(); } });
      }
      notify();
    };
    recognition.onerror = (event) => {
      if (live !== session) return;
      session.lastError = event.error;
      if (["not-allowed", "service-not-allowed", "audio-capture", "network"].includes(event.error)) {
        toast(event.error === "not-allowed" ? "اسمح للميكروفون من إعدادات المتصفح" : "خدمة التعرف على الكلام غير متاحة الآن", "warn");
        stopLive();
      }
    };
    recognition.onend = () => {
      if (live !== session || session.phase !== "listening") return;
      setTimeout(() => {
        if (live === session && session.phase === "listening" && !document.hidden) {
          try { recognition.start(); } catch (_) { stopLive(); }
        }
      }, 250);
    };
    try { recognition.start(); }
    catch (_) { live = null; toast("تعذّر بدء الميكروفون في هذا المتصفح", "bad"); return false; }
    sessionStorage.setItem("abud.voice.reply", "on");
    enabled = true;
    warm();
    setRobot(agentId, "listening");
    notify();
    return true;
  }
  // ---------------------------------------------------------------- Gemini Live engine
  function startGemini({ key, agentId }) {
    stopLive();
    const [kind, ...rest] = key.split(":");
    const session = { engine: "gemini", key, agentId, phase: "connecting", interim: "", sources: new Set(), nextTime: 0, ws: null, stream: null, capture: null, play: null, gain: null, micOn: false, turnDone: true };
    live = session;
    sessionStorage.setItem("abud.voice.reply", "on");
    enabled = true;
    setRobot(agentId, "listening");
    notify();
    openGemini(session, kind, rest.join(":")).catch((error) => {
      if (live !== session) return;
      toast(error?.name === "NotAllowedError" ? "اسمح للميكروفون من إعدادات المتصفح" : (error?.message || "تعذّر بدء المكالمة"), "bad");
      stopLive();
    });
    return true;
  }
  async function openGemini(session, kind, id) {
    const token = await O.session();
    session.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (live !== session) return stopGemini(session);
    session.play = new AudioContext();
    session.play.resume?.().catch?.(() => {});
    session.gain = session.play.createGain();
    session.gain.connect(session.play.destination);
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/local-api/company/live-voice/ws`);
    ws.binaryType = "arraybuffer";
    session.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "start", token, context: { kind, id } }));
    ws.onmessage = (event) => {
      if (live !== session) return;
      if (typeof event.data === "string") { try { onGeminiEvent(session, JSON.parse(event.data)); } catch (_) { /* ignore a malformed frame */ } }
      else playPcm(session, event.data);
    };
    ws.onclose = () => { if (live === session) { toast("المكالمة اتقفلت", "warn"); stopLive(); } };
  }
  async function startCapture(session) {
    let context;
    try { context = new AudioContext({ sampleRate: 16000 }); } catch (_) { context = new AudioContext(); }
    session.capture = context;
    await context.audioWorklet.addModule("./internal/live-worklet.js");
    if (live !== session) return;
    const source = context.createMediaStreamSource(session.stream);
    const node = new AudioWorkletNode(context, "abud-live-capture");
    const silent = context.createGain();
    silent.gain.value = 0;
    node.port.onmessage = (event) => { if (session.micOn && session.ws?.readyState === 1) session.ws.send(event.data); };
    source.connect(node);
    node.connect(silent);
    silent.connect(context.destination);
    session.micOn = true;
  }
  function playPcm(session, buffer) {
    if (!enabled || !session.play || buffer.byteLength < 2) return;
    const pcm = new Int16Array(buffer, 0, buffer.byteLength >> 1);
    const audio = session.play.createBuffer(1, pcm.length, 24000);
    const channel = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const source = session.play.createBufferSource();
    source.buffer = audio;
    source.connect(session.gain);
    const startAt = Math.max(session.play.currentTime + 0.02, session.nextTime);
    source.start(startAt);
    session.nextTime = startAt + audio.duration;
    session.sources.add(source);
    session.phase = "speaking";
    session.turnDone = false;
    setRobot(session.agentId, "speaking");
    source.onended = () => {
      session.sources.delete(source);
      if (live === session && !session.sources.size && session.nextTime <= session.play.currentTime + 0.05) {
        session.phase = "listening";
        session.interim = "";
        setRobot(session.agentId, "listening");
        notify();
      }
    };
  }
  function flushGemini(session) {
    for (const source of session.sources) { source.onended = null; try { source.stop(); } catch (_) { /* already stopped */ } }
    session.sources.clear();
    session.nextTime = 0;
    if (live === session && session.phase === "speaking") { session.phase = "listening"; setRobot(session.agentId, "listening"); }
  }
  function onGeminiEvent(session, message) {
    switch (message.type) {
      case "ready": session.phase = "listening"; startCapture(session).catch((error) => { toast(error?.message || "تعذّر تشغيل الميكروفون", "bad"); stopLive(); }); break;
      case "input": session.interim = message.text || ""; if (session.phase === "connecting") session.phase = "listening"; break;
      case "working": session.phase = "working"; setRobot(session.agentId, "listening"); break;
      case "speaking": session.phase = "speaking"; break;
      case "interrupted": flushGemini(session); session.phase = "listening"; break;
      case "turn-complete": session.turnDone = true; if (!session.sources.size) { session.phase = "listening"; session.interim = ""; setRobot(session.agentId, "listening"); } break;
      case "refresh": window.dispatchEvent(new CustomEvent("abud:live-refresh", { detail: { key: message.key } })); break;
      case "reconnecting": session.phase = "connecting"; break;
      case "error": toast(message.message || "حصلت مشكلة في المكالمة", "bad"); break;
      case "ended": stopLive(); return;
      default: break;
    }
    notify();
  }
  function stopGemini(session) {
    session.micOn = false;
    flushGemini(session);
    try { if (session.ws?.readyState === 1) session.ws.send(JSON.stringify({ type: "stop" })); session.ws?.close(); } catch (_) { /* already closed */ }
    session.ws = null;
    session.stream?.getTracks().forEach((track) => track.stop());
    for (const context of [session.capture, session.play]) { try { context?.close(); } catch (_) { /* already closed */ } }
  }
  function startDictation(agentId, onText) {
    if (!Recognition) { toast("التعرف على الكلام غير متاح في هذا المتصفح", "warn"); return; }
    if (live) stopLive();
    if (dictation) { dictation.stop(); return; }
    const recognition = new Recognition();
    recognition.lang = "ar-EG";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      if (result?.isFinal) { onText(result[0].transcript.trim()); recognition.stop(); }
      notify();
    };
    recognition.onerror = (event) => { if (event.error !== "no-speech") toast("لم أسمع كلامًا واضحًا", "warn"); };
    recognition.onend = () => { if (dictation === recognition) dictation = null; setRobot(agentId, null); notify(); };
    dictation = recognition;
    try { recognition.start(); setRobot(agentId, "listening"); }
    catch (_) { dictation = null; toast("تعذّر بدء الميكروفون", "bad"); }
    notify();
  }
  function controls({ agentId, onText, liveKey = null, liveLabel = "مكالمة لايف", liveBlocked = false, onTurn = null }) {
    const wrap = h("div", { class: "vo-controls", role: "group", "aria-label": "التحكم الصوتي" });
    const call = liveKey && onTurn ? h("button", { type: "button", class: "btn btn-secondary vo-live", onclick: () => live?.key === liveKey ? stopLive() : startLive({ key: liveKey, agentId, onTurn }) }) : null;
    const mic = h("button", { type: "button", class: "btn btn-secondary vo-mic", onclick: () => startDictation(agentId, onText) }, "🎙 إملاء");
    const mute = h("button", { type: "button", class: "btn btn-secondary vo-reply", onclick: () => {
      enabled = !enabled;
      sessionStorage.setItem("abud.voice.reply", enabled ? "on" : "off");
      if (!enabled) stopPlayback();
      notify();
    } });
    const stop = h("button", { type: "button", class: "btn btn-secondary vo-stop", onclick: stopPlayback }, "إيقاف الصوت");
    const indicator = h("span", { class: "vo-indicator", role: "status", "aria-live": "polite" });
    const update = () => {
      const available = status();
      const active = live?.key === liveKey;
      if (call) {
        call.disabled = !active && (available.state !== "ready" || liveBlocked || Boolean(live));
        call.setAttribute("aria-pressed", String(active));
        call.textContent = active ? "■ إنهاء المكالمة" : `📞 ${liveLabel}`;
      }
      mic.disabled = !Recognition || Boolean(live);
      mic.setAttribute("aria-pressed", String(Boolean(dictation)));
      mute.disabled = available.state !== "ready";
      mute.setAttribute("aria-pressed", String(enabled));
      mute.textContent = enabled ? "🔊 الصوت شغال" : "🔇 صوت مكتوم";
      stop.hidden = live?.engine === "gemini" ? !live.sources.size : !speaking && !queue.length;
      if (live?.gain) live.gain.gain.value = enabled ? 1 : 0;
      indicator.textContent = active && live.engine === "gemini" ? `${GEMINI_PHASE[live.phase] || ""}${live.phase === "listening" && live.interim ? ` · ${live.interim}` : ""}` : active ? live.phase === "listening" ? `سامعك دلوقتي${live.interim ? ` · ${live.interim}` : ""}` : speaking ? "بيرد بالصوت…" : "بيجهّز الرد…" : available.state === "ready" ? "" : available.reasonAr;
    };
    listeners.add({ node: wrap, update });
    wrap.append(call, mic, mute, stop, indicator);
    update();
    return wrap;
  }
  synth?.addEventListener?.("voiceschanged", notify);
  setTimeout(async () => { await loadGemini(); if (!gemini.configured && Recognition) warm(); }, 0);
  document.addEventListener("visibilitychange", () => { if (document.hidden && live?.engine !== "gemini") stopLive(); });
  window.addEventListener("hashchange", () => { if (live && !onRoute(live.key)) stopLive(); });
  window.AbudVoice = { refreshEngine: loadGemini, status, usable, controls, observe, speak, feedStream, stopPlayback, startLive, stopLive, liveResponse, updateLive,
    isLive: (key) => live?.key === key, override: (agentId) => overrides.get(agentId) || null };
})();
