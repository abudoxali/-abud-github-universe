/* Small supervisor for the new persistent KemeTone TTS process. Speech recognition remains in the browser.
 * The worker receives text only and runs locally; no model downloads occur during a call. */
import { existsSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SCRIPT = fileURLToPath(new URL("../../realtime-voice/worker.py", import.meta.url));
export function createLiveTts({ env = process.env, spawn = nodeSpawn, log = () => {} } = {}) {
  const home = env.ABUD_LIVE_VOICE_HOME || join(env.LOCALAPPDATA || "", "ABUD-FUN-OS", "realtime-voice");
  const python = env.ABUD_LIVE_VOICE_PYTHON || join(home, "venv", "Scripts", "python.exe");
  let process = null, starting = null, nextId = 0, buffer = "";
  const pending = new Map();
  const installed = () => existsSync(python) && existsSync(join(home, "kemetone", "kemetone.pth")) && existsSync(join(home, "kemetone", "voices", "kemetone.pt"));
  const status = () => ({ state: !installed() ? "not-installed" : starting ? "starting" : process ? "ready" : "stopped", engine: "KemeTone", language: "ar-EG" });
  const rejectAll = (error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const stop = () => { if (process) process.kill(); process = null; starting = null; rejectAll(new Error("live-tts-stopped")); };
  function handle(line) {
    let message; try { message = JSON.parse(line); } catch (_) { return; }
    if (message.ready) return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error));
    else item.resolve({ audio: Buffer.from(message.audioBase64, "base64"), durationMs: message.durationMs, synthesisMs: message.synthesisMs });
  }
  function ensure() {
    if (process && !starting) return Promise.resolve();
    if (starting) return starting;
    if (!installed()) return Promise.reject(new Error("live-tts-not-installed"));
    starting = new Promise((resolve, reject) => {
      const child = spawn(python, ["-I", "-B", SCRIPT], { env: { ...env, ABUD_LIVE_VOICE_HOME: home }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      process = child;
      const timeout = setTimeout(() => { child.kill(); reject(new Error("live-tts-start-timeout")); }, 60000);
      let ready = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        for (let pos; (pos = buffer.indexOf("\n")) >= 0;) {
          const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
          if (!ready) {
            try { if (JSON.parse(line).ready) { ready = true; clearTimeout(timeout); starting = null; resolve(); } } catch (_) { /* diagnostics on stdout */ }
          } else handle(line);
        }
      });
      child.stderr.on("data", (chunk) => log(JSON.stringify({ event: "live-tts-stderr", message: String(chunk).slice(0, 300) })));
      child.on("error", (error) => { clearTimeout(timeout); if (!ready) reject(error); rejectAll(error); });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (!ready) reject(new Error(`live-tts-exit-${code}`));
        if (process === child) { process = null; starting = null; buffer = ""; }
        rejectAll(new Error("live-tts-exited"));
      });
    });
    starting.catch(() => { starting = null; });
    return starting;
  }
  async function speak(text) {
    const value = String(text || "").trim();
    if (!value || value.length > 550) throw new Error("live-tts-invalid-text");
    await ensure();
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("live-tts-timeout")); }, 15000);
      pending.set(id, { resolve, reject, timer });
      process.stdin.write(JSON.stringify({ id, text: value }) + "\n");
    });
  }
  return { status, ensure, speak, stop };
}
