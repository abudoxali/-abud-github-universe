/* V6 voice supervisor: on-demand worker, text-only fallback, bounded payloads, crash-loop guard, owner-guarded API. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoice } from "../src/voice.mjs";
import { createServer } from "../src/server.mjs";
import { startStubRouter, TEST_KEY } from "./fixtures.mjs";

async function fakeWorker() {
  const seen = [];
  const server = createHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ path: req.url, origin: req.headers.origin ?? null, type: req.headers["content-type"], size: body.length });
      const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/health") return json(200, { models: { stt: { state: "unloaded" } } });
      if (req.url === "/stt") return json(200, { text: " عايز أراجع المشاريع ", language: "ar", durationMs: 1800 });
      if (req.url === "/tts") { const { voice } = JSON.parse(body.toString()); res.writeHead(200, { "Content-Type": "audio/wav" }); return res.end(Buffer.from(`RIFF-${voice}`)); }
      if (req.url === "/warmup") return json(200, { ok: true, seconds: 0.1 });
      if (req.url === "/unload") return json(200, { unloaded: true });
      json(404, { error: "not-found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

test("voice supervisor reports not-installed and keeps the app text-only when the runtime is missing", async () => {
  const voice = createVoice({ env: { VOICE_HOME: join(tmpdir(), "abud-no-voice-here") }, spawn: () => { throw new Error("must not spawn"); } });
  const status = await voice.status();
  assert.equal(status.state, "not-installed");
  assert.match(status.setup, /setup\.ps1/);
  await assert.rejects(() => voice.transcribe({ audioBase64: "AAAA" }), (e) => e.status === 503 && e.code === "voice-not-installed");
});

test("voice supervisor forwards STT/TTS to a loopback worker, bounds audio, and sends no browser origin", async () => {
  const worker = await fakeWorker();
  try {
    const voice = createVoice({ env: { ABUD_VOICE_URL: worker.url } });
    assert.equal((await voice.status()).state, "ready");
    const heard = await voice.transcribe({ audioBase64: Buffer.from("webm-bytes").toString("base64"), mime: "audio/webm;codecs=opus" });
    assert.deepEqual(heard, { text: "عايز أراجع المشاريع", language: "ar", durationMs: 1800, source: "voice" });
    assert.equal(worker.seen.find((s) => s.path === "/stt").type, "audio/webm;codecs=opus");
    assert.equal(String(await voice.speak({ voice: "rex", text: "تمام" })), "RIFF-rex");
    assert.ok(worker.seen.every((s) => s.origin === null), "the worker refuses browser origins; the Bridge never sends one");
    await assert.rejects(() => voice.transcribe({ audioBase64: Buffer.alloc(voice.maxAudioBytes + 1).toString("base64") }), (e) => e.status === 413);
    await assert.rejects(() => voice.speak({ voice: "ori", text: "  " }), (e) => e.status === 422);
    assert.deepEqual(await voice.warmup(), { ok: true, seconds: 0.1 });
  } finally { await worker.close(); }
});

test("a crashing worker is restarted at most three times in ten minutes", async () => {
  const home = await mkdtemp(join(tmpdir(), "abud-voice-home-"));
  let spawned = 0;
  const fakeSpawn = () => { spawned++; const p = new EventEmitter(); p.kill = () => {}; setImmediate(() => p.emit("exit", 1)); return p; };
  try {
    // Pretend the runtime is installed by pointing at files that exist.
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(home, "venv", "Scripts"), { recursive: true });
    await writeFile(join(home, "venv", "Scripts", "python.exe"), "");
    const voice = createVoice({ env: { VOICE_HOME: home, ABUD_VOICE_PORT: "1" }, spawn: fakeSpawn });
    for (let i = 0; i < 3; i++) await assert.rejects(() => voice.ensure(), (e) => e.status === 503);
    await assert.rejects(() => voice.ensure(), (e) => e.code === "voice-crash-loop");
    assert.equal(spawned, 3);
    assert.equal((await voice.status()).state, "error");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("voice HTTP API is session guarded and returns agent audio chosen server-side", async () => {
  const worker = await fakeWorker();
  const stub = await startStubRouter();
  const dir = await mkdtemp(join(tmpdir(), "abud-voice-api-"));
  const server = createServer({
    configPath: join(dir, "worlds.json"), workspaceConfigPath: join(dir, "none.json"), policyPath: join(dir, "policy.json"), dbPath: join(dir, "company.db"), backupDir: join(dir, "backups"),
    vpsConfigPath: join(dir, "no-vps.json"), env: { OMNIROUTE_BASE_URL: `http://127.0.0.1:${stub.port}`, OMNIROUTE_API_KEY: TEST_KEY, ABUD_WORKSPACE_ROOTS: dir },
    voiceOptions: { env: { ABUD_VOICE_URL: worker.url } }, startupOptions: { env: {}, platform: "test" }, agentOptions: { home: dir, env: {}, runImpl: async () => ({ ok: false, reason: "not-found" }) },
    githubReader: { resolve: async () => ({ state: "unavailable" }), read: async (github) => ({ state: "not-linked", github, fetchedAt: new Date().toISOString(), cached: false, unavailable: [] }) },
    background: false, log: () => {}
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = (await (await fetch(`${base}/local-api/session`)).json()).token;
    const post = (path, body, headers = {}) => fetch(`${base}/local-api/company${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await (await fetch(`${base}/local-api/company/voice/status`)).json()).state, "ready");
    assert.equal((await post("/voice/tts", { agentId: "luna", text: "أهلاً" })).status, 403, "writes need the owner session");
    const audio = await post("/voice/tts", { agentId: "luna", text: "أهلاً" }, { "X-Abud-Session": token });
    assert.equal(audio.headers.get("content-type"), "audio/wav");
    assert.equal(await audio.text(), "RIFF-luna");
    assert.equal((await post("/voice/tts", { agentId: "nobody", text: "x" }, { "X-Abud-Session": token })).status, 404);
    const stt = await post("/voice/stt", { audioBase64: Buffer.from("x").toString("base64"), mime: "audio/webm" }, { "X-Abud-Session": token });
    assert.equal((await stt.json()).text, "عايز أراجع المشاريع");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await worker.close(); await stub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
