/* ABUD FUN Company OS V6 — local voice in conversations and meetings. Push-to-talk only (never always-on): the owner
 * records, reviews the local transcript, then sends it like typed text. Agent replies are spoken one sentence at a time
 * through a single queue, so two voices never overlap; talking again stops playback. Robots show listening/speaking only
 * while that is actually happening. Everything degrades to text when the local voice engine is not installed. */
(() => {
  "use strict";
  const O = window.AbudOps;
  if (!O) return;
  const { h, toast, mutate } = O;
  const MAX_SECONDS = 60;
  const store = { get(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch (_) { /* private mode */ } } };
  const state = { status: null, checkedAt: 0, warmed: false, recorder: null, queue: [], playing: null, overrides: new Map(), baselines: new Map(), spoken: new Set(), listeners: new Set() };
  const replyOn = () => store.get("abud.voice.reply") !== "off";
  const notify = () => state.listeners.forEach((fn) => { try { fn(); } catch (_) { /* detached view */ } });

  async function status(force = false) {
    if (!force && state.status && Date.now() - state.checkedAt < 15_000) return state.status;
    try { state.status = await (await fetch("/local-api/company/voice/status", { cache: "no-store" })).json(); } catch (_) { state.status = { state: "error" }; }
    state.checkedAt = Date.now();
    return state.status;
  }
  const usable = () => ["ready", "stopped", "starting"].includes(state.status?.state);

  /** Robot state comes from real audio activity only; views ask for the override when they render. */
  function setRobot(agentId, value) {
    if (value) state.overrides.set(agentId, value); else state.overrides.delete(agentId);
    document.querySelectorAll(`svg.rb-robot[data-agent="${CSS.escape(agentId)}"]`).forEach((el) => el.__robot?.set?.({ animationState: value || "idle" }));
    notify();
  }

  function warm() {
    if (state.warmed || !usable()) return;
    state.warmed = true;
    mutate("POST", "/voice/warmup", {}).catch(() => { state.warmed = false; });
  }

  // ------------------------------------------------------------------ speech output (single queue)
  const plain = (text) => String(text || "").replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ").replace(/[#*_>|~-]{1,}/g, " ").replace(/\s+/g, " ").trim();
  function sentences(text, max = 360) {
    const out = [];
    for (const part of plain(text).split(/(?<=[.!؟?؛\n])\s+/)) {
      if (!part) continue;
      if (out.length && (out.at(-1) + " " + part).length <= max) out[out.length - 1] += ` ${part}`;
      else out.push(part.slice(0, max));
    }
    return out.slice(0, 8); // long answers stay readable on screen; only the opening is spoken
  }
  /** One synthesis at a time (the local worker has a single GPU slot): a busy worker — e.g. still warming up — is
   * retried briefly instead of failing the reply. */
  async function fetchAudio(agentId, text, cancelled) {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (cancelled()) return null;
      const token = await O.session();
      const response = await fetch("/local-api/company/voice/tts", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "X-Abud-Session": token }, body: JSON.stringify({ agentId, text }) });
      if (response.status === 429) { await new Promise((resolve) => setTimeout(resolve, 1500)); continue; }
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || "تعذر توليد الصوت");
      return URL.createObjectURL(await response.blob());
    }
    throw new Error("محرك الصوت مشغول؛ ستظهر الردود كتابةً");
  }
  function speak(agentId, text, { maxParts = 8 } = {}) {
    if (!replyOn() || !usable()) return;
    const parts = sentences(text).slice(0, maxParts);
    if (!parts.length) return;
    state.queue.push(...parts.map((part) => ({ agentId, text: part, url: null })));
    if (!state.playing) playNext();
  }
  const generation = { n: 0 };
  /** Fetches the head of the queue (and prefetches only the next item), plays it, then moves on. */
  async function playNext() {
    const next = state.queue.shift();
    if (!next) { state.playing = null; notify(); return; }
    const gen = generation.n;
    const cancelled = () => gen !== generation.n;
    state.playing = { agentId: next.agentId, audio: null };
    let url;
    try { url = await (next.url || fetchAudio(next.agentId, next.text, cancelled)); } catch (error) { toast(error.message, "bad"); state.queue.length = 0; state.playing = null; notify(); return; }
    if (cancelled() || !url) { if (url) URL.revokeObjectURL(url); return; }
    const following = state.queue[0];
    const audio = new Audio(url);
    state.playing = { agentId: next.agentId, audio };
    setRobot(next.agentId, "speaking");
    const done = () => {
      URL.revokeObjectURL(url); setRobot(next.agentId, null);
      if (state.playing?.audio === audio) { state.playing = null; playNext(); }
    };
    audio.addEventListener("ended", done, { once: true });
    audio.addEventListener("error", done, { once: true });
    audio.play().then(() => { if (following && !following.url) following.url = fetchAudio(following.agentId, following.text, cancelled); })
      .catch(() => { toast("لم يسمح المتصفح بتشغيل الصوت؛ اضغط في الصفحة ثم أعد المحاولة", "bad"); state.queue.length = 0; done(); });
    notify();
  }
  function stopPlayback() {
    const current = state.playing;
    generation.n++;
    for (const item of state.queue.splice(0)) item.url?.then((url) => url && URL.revokeObjectURL(url)).catch(() => {});
    if (current?.audio) { current.audio.pause(); setRobot(current.agentId, null); }
    state.playing = null;
    notify();
  }

  /** Speaks only replies that complete after the view was opened — reopening a thread never replays history. */
  function observe(key, agentId, messages) {
    const done = (messages || []).filter((m) => m.role === "assistant" && m.state === "complete" && m.content);
    const last = done.at(-1);
    if (!state.baselines.has(key)) { state.baselines.set(key, last?.id ?? null); return; }
    if (!last || last.id === state.baselines.get(key) || state.spoken.has(last.id)) return;
    state.spoken.add(last.id);
    state.baselines.set(key, last.id);
    speak(agentId, last.content);
  }

  // ------------------------------------------------------------------ push-to-talk input
  const toBase64 = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] || ""); r.onerror = reject; r.readAsDataURL(blob); });
  async function startRecording(agentId, onText, ui) {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("هذا المتصفح لا يدعم التسجيل الصوتي؛ استخدم الكتابة", "bad");
    stopPlayback();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (error) {
      return toast(error?.name === "NotAllowedError" ? "لم يُسمح بالميكروفون. فعّله من إعدادات المتصفح للموقع ثم أعد المحاولة." : "تعذر الوصول إلى الميكروفون", "bad");
    }
    const type = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [], started = Date.now();
    state.recorder = { recorder, stream, agentId };
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(timer); state.recorder = null; setRobot(agentId, null); ui.sync();
      const blob = new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" });
      if (blob.size < 800) return toast("التسجيل قصير جدًا", "bad");
      ui.busy(true);
      try {
        const result = await mutate("POST", "/voice/stt", { audioBase64: await toBase64(blob), mime: blob.type });
        if (result.text) onText(result.text); else toast("لم يُتعرّف على كلام واضح", "bad");
      } catch (error) { toast(error.message, "bad"); } finally { ui.busy(false); }
    };
    const timer = setInterval(() => { const s = Math.floor((Date.now() - started) / 1000); ui.tick(s); if (s >= MAX_SECONDS) recorder.stop(); }, 250);
    ui.tick(0);
    recorder.start(250);
    setRobot(agentId, "listening");
    ui.sync();
  }

  /** Composer controls: تحدّث / إيقاف الصوت / الرد بالصوت. Text input stays the primary path. */
  function controls({ agentId, onText }) {
    const wrap = h("div", { class: "vo-controls", role: "group", "aria-label": "التحكم الصوتي" });
    const mic = h("button", { type: "button", class: "btn btn-secondary vo-mic", "aria-pressed": "false" });
    const indicator = h("span", { class: "vo-indicator", role: "status", "aria-live": "polite" });
    const stop = h("button", { type: "button", class: "btn btn-secondary vo-stop", onclick: stopPlayback }, "إيقاف الصوت");
    const reply = h("button", { type: "button", class: "btn btn-secondary vo-reply" });
    let busy = false;
    const ui = {
      tick: (s) => { indicator.textContent = `● يسجّل ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} — اضغط مرة أخرى للإنهاء`; },
      busy: (v) => { busy = v; indicator.textContent = v ? "يحوّل الكلام إلى نص محليًا…" : ""; ui.sync(); },
      sync: () => {
        const recording = state.recorder?.agentId === agentId;
        const ok = usable();
        mic.disabled = !ok || busy || (Boolean(state.recorder) && !recording);
        mic.setAttribute("aria-pressed", String(recording));
        mic.classList.toggle("is-recording", recording);
        mic.textContent = recording ? "إنهاء التسجيل" : "🎙 تحدّث";
        mic.title = ok ? "اضغط للتحدث، ثم راجع النص قبل الإرسال" : state.status?.state === "not-installed" ? "محرك الصوت غير مثبت على هذا الجهاز — الكتابة متاحة" : "محرك الصوت غير متاح الآن — الكتابة متاحة";
        if (!recording && !busy) indicator.textContent = ok ? "" : state.status ? "الصوت غير متاح؛ الكتابة تعمل كالمعتاد" : "";
        stop.hidden = !state.playing;
        reply.disabled = !ok;
        reply.setAttribute("aria-pressed", String(replyOn()));
        reply.textContent = replyOn() ? "🔊 الرد بالصوت" : "🔇 الرد كتابةً فقط";
      }
    };
    mic.onclick = () => {
      if (state.recorder?.agentId === agentId) return state.recorder.recorder.stop();
      warm();
      startRecording(agentId, onText, ui);
    };
    reply.onclick = () => { store.set("abud.voice.reply", replyOn() ? "off" : "on"); if (!replyOn()) stopPlayback(); else warm(); ui.sync(); };
    const listener = () => { if (!wrap.isConnected) state.listeners.delete(listener); else ui.sync(); };
    state.listeners.add(listener);
    status().then(() => { ui.sync(); if (replyOn()) warm(); });
    ui.sync();
    wrap.append(mic, reply, stop, indicator);
    return wrap;
  }

  window.AbudVoice = { status, usable, controls, observe, speak, stopPlayback, override: (agentId) => state.overrides.get(agentId) || null };
})();
