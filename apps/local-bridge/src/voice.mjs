/* Local voice supervisor. The Python Voice Worker (apps/voice-worker) runs only when the owner uses voice: it is
 * started on demand as one loopback child process, health-checked, restarted with a bounded backoff after a crash,
 * and stopped with the Bridge. Audio never leaves the machine and is never stored here; only the transcript text
 * enters a conversation, where it is untrusted input under the normal approval rules. */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "./company.mjs";

const WORKER_DIR = fileURLToPath(new URL("../../voice-worker/", import.meta.url));
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const RESTART_WINDOW_MS = 10 * 60_000, MAX_RESTARTS = 3;

export function createVoice({ env = process.env, log = () => {}, spawn = nodeSpawn, fetchImpl = fetch, now = Date.now } = {}) {
  const home = env.VOICE_HOME || join(env.LOCALAPPDATA || "", "ABUD-FUN-OS", "voice");
  const python = join(home, "venv", "Scripts", "python.exe");
  const external = env.ABUD_VOICE_URL || null; // tests and advanced setups: an already running worker, never spawned
  const port = Number(env.ABUD_VOICE_PORT || 4185);
  const base = external || `http://127.0.0.1:${port}`;
  let child = null, starting = null, lastError = null, stoppedByOwner = false;
  const restarts = [];

  const installed = () => Boolean(external) || (existsSync(python) && existsSync(join(WORKER_DIR, "worker.py")));
  async function call(path, { method = "GET", body = null, type = "application/json", timeoutMs = 3000 } = {}) {
    const response = await fetchImpl(`${base}${path}`, { method, body, headers: body ? { "Content-Type": type } : {}, signal: AbortSignal.timeout(timeoutMs) });
    return response;
  }
  async function health() {
    try { const r = await call("/health", { timeoutMs: 1500 }); return r.ok ? await r.json() : null; } catch (_) { return null; }
  }

  async function status() {
    if (!installed()) return { state: "not-installed", reasonAr: "محرك الصوت غير مثبت على هذا الجهاز", setup: "powershell -ExecutionPolicy Bypass -File apps\\voice-worker\\setup.ps1" };
    if (starting) return { state: "starting" };
    const h = await health();
    if (h) return { state: "ready", worker: h };
    return lastError ? { state: "error", reasonAr: lastError } : { state: "stopped" };
  }

  /** Reuses a healthy worker on the port (never a second process); otherwise spawns one and waits for health. */
  async function ensure() {
    if (!installed()) throw new HttpError(503, "voice-not-installed", "محرك الصوت غير مثبت؛ الكتابة متاحة كالمعتاد");
    if (await health()) return true;
    if (external) throw new HttpError(503, "voice-unavailable", "محرك الصوت لا يستجيب");
    if (!starting) starting = launch().finally(() => { starting = null; });
    return starting;
  }

  async function launch() {
    const recent = restarts.filter((t) => now() - t < RESTART_WINDOW_MS);
    if (recent.length >= MAX_RESTARTS) {
      lastError = "توقف محرك الصوت عدة مرات خلال دقائق؛ أعد المحاولة لاحقًا أو راجع السجلات";
      throw new HttpError(503, "voice-crash-loop", lastError);
    }
    restarts.splice(0, restarts.length, ...recent, now());
    stoppedByOwner = false;
    lastError = null;
    // -E -s: ignore user Python env/site; the worker directory stays importable for its local modules.
    child = spawn(python, ["-E", "-s", join(WORKER_DIR, "worker.py"), String(port)], { cwd: WORKER_DIR, env: { ...env, VOICE_HOME: home, PYTHONIOENCODING: "utf-8" }, stdio: "ignore", windowsHide: true });
    const proc = child;
    proc.on("exit", (code) => {
      if (child === proc) child = null;
      if (!stoppedByOwner && code !== 0) { lastError = `توقف محرك الصوت بشكل غير متوقع (${code})`; log(`voice worker exited with code ${code}`); }
    });
    for (let i = 0; i < 60; i++) {
      if (await health()) return true;
      if (child !== proc) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    lastError = lastError || "لم يبدأ محرك الصوت خلال 30 ثانية";
    throw new HttpError(503, "voice-start-failed", lastError);
  }

  async function forward(path, options) {
    await ensure();
    let response;
    try { response = await call(path, options); } catch (error) {
      throw new HttpError(503, "voice-unavailable", error?.name === "TimeoutError" ? "انتهت مهلة محرك الصوت" : "محرك الصوت لا يستجيب");
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const code = String(detail.error || "voice-failed");
      throw new HttpError(response.status === 429 ? 429 : response.status >= 500 ? 503 : 422, code, response.status === 429 ? "محرك الصوت مشغول بطلب آخر" : "تعذر معالجة الصوت");
    }
    return response;
  }

  async function transcribe({ audioBase64, mime }) {
    if (typeof audioBase64 !== "string" || !audioBase64) throw new HttpError(422, "validation", "لا يوجد تسجيل صوتي");
    const audio = Buffer.from(audioBase64, "base64");
    if (!audio.length) throw new HttpError(422, "validation", "التسجيل فارغ");
    if (audio.length > MAX_AUDIO_BYTES) throw new HttpError(413, "payload-too-large", "التسجيل أطول من المسموح (دقيقة واحدة)");
    const type = /^audio\/[a-z0-9.+-]+(;.*)?$/i.test(String(mime || "")) ? String(mime) : "application/octet-stream";
    const response = await forward("/stt", { method: "POST", body: audio, type, timeoutMs: 120_000 });
    const result = await response.json();
    return { text: String(result.text || "").trim(), language: result.language ?? null, durationMs: result.durationMs ?? null, source: "voice" };
  }

  async function speak({ voice, text }) {
    const value = String(text || "").trim();
    if (!value) throw new HttpError(422, "validation", "لا يوجد نص للنطق");
    const response = await forward("/tts", { method: "POST", body: JSON.stringify({ text: value.slice(0, 400), voice }), timeoutMs: 120_000 });
    return Buffer.from(await response.arrayBuffer());
  }

  const warmup = async () => (await forward("/warmup", { method: "POST", timeoutMs: 180_000 })).json();
  const unload = async () => { if (!(await health())) return { unloaded: false, reason: "not-running" }; return (await call("/unload", { method: "POST" })).json(); };
  function stop() {
    stoppedByOwner = true;
    if (child) { try { child.kill(); } catch (_) { /* already gone */ } child = null; }
    return { stopped: true };
  }

  return { status, ensure, transcribe, speak, warmup, unload, stop, maxAudioBytes: MAX_AUDIO_BYTES };
}
