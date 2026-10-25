import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPreviousRun, createLifecycleRecorder, readPreviousRun, safeStack } from "../src/lifecycle.mjs";

const boot = Date.parse("2026-10-25T08:00:00Z");

test("previous-run classification separates a clean stop, an OS restart, a logged fatal error and an unexplained exit", () => {
  assert.equal(classifyPreviousRun(null), null);
  assert.equal(classifyPreviousRun({ startedAt: "2026-10-25T09:00:00Z", heartbeatAt: "2026-10-25T09:05:00Z", clean: true }, { bootTimeMs: boot }), null);
  const restart = classifyPreviousRun({ pid: 1, startedAt: "2026-10-25T07:00:00Z", heartbeatAt: "2026-10-25T07:49:00Z", clean: false, rssMb: 70 }, { bootTimeMs: boot });
  assert.equal(restart.kind, "system-restart");
  assert.equal(restart.lastSeenAt, "2026-10-25T07:49:00.000Z");
  assert.equal(restart.rssMb, 70);
  const fatal = classifyPreviousRun({ startedAt: "2026-10-25T09:00:00Z", heartbeatAt: "2026-10-25T09:01:00Z", clean: false, fatal: { kind: "uncaughtException", name: "TypeError" } }, { bootTimeMs: boot });
  assert.equal(fatal.kind, "fatal-error");
  assert.equal(fatal.fatal.name, "TypeError");
  assert.equal(classifyPreviousRun({ startedAt: "2026-10-25T09:00:00Z", heartbeatAt: "2026-10-25T09:30:00Z", clean: false }, { bootTimeMs: boot }).kind, "unexpected-exit");
});

test("the recorder writes heartbeats with memory figures, then a clean marker; unreadable files are ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abud-life-"));
  const file = join(dir, "runtime", "bridge-state.json");
  assert.equal(readPreviousRun(file), null);
  let t = Date.parse("2026-10-25T10:00:00Z");
  let rss = 50 * 1024 * 1024;
  const recorder = createLifecycleRecorder({ file, port: 4999, intervalMs: 60_000, now: () => new Date(t += 1000), memory: () => ({ rss, heapUsed: 10 * 1024 * 1024 }) });
  recorder.start();
  let state = readPreviousRun(file);
  assert.equal(state.clean, false);
  assert.equal(state.rssMb, 50);
  assert.equal(state.port, 4999);
  rss = 30 * 1024 * 1024;
  recorder.fatal({ kind: "unhandledRejection", name: "Error" });
  state = readPreviousRun(file);
  assert.equal(state.peakRssMb, 50, "peak memory is kept");
  assert.equal(state.fatal.kind, "unhandledRejection");
  recorder.stopped();
  state = readPreviousRun(file);
  assert.equal(state.clean, true);
  assert.ok(state.stoppedAt);
  assert.equal(classifyPreviousRun(state), null);
  assert.ok(!JSON.stringify(state).match(/request|token|prompt/i), "only timing and memory are recorded");
});

test("stack frames are bounded and user-profile paths are masked", () => {
  const error = new Error("x");
  error.stack = "Error: x\n    at f (C:\\Users\\Someone\\proj\\a.mjs:1:1)\n    at g (/home/someone/b.mjs:2:2)";
  assert.deepEqual(safeStack(error), ["at f ([user]\\proj\\a.mjs:1:1)", "at g ([user]/b.mjs:2:2)"]);
  assert.deepEqual(safeStack(null), []);
});

test("a killed bridge process is recognised on the next start as an unexplained exit, not a clean stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abud-life-proc-"));
  const file = join(dir, "bridge-state.json");
  // A child writes its heartbeat and is then terminated without any chance to mark a clean stop.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createLifecycleRecorder } from ${JSON.stringify(new URL("../src/lifecycle.mjs", import.meta.url).href)};
    createLifecycleRecorder({ file: ${JSON.stringify(file)}, port: 1, intervalMs: 50 }).start();
    console.log("ready"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const previous = JSON.parse(await readFile(file, "utf8"));
  assert.equal(previous.pid, child.pid);
  assert.equal(classifyPreviousRun(previous).kind, "unexpected-exit");
});
