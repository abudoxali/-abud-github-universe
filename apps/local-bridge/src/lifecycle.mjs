/* Durable lifecycle record for the standalone bridge (local/runtime/bridge-state.json).
 * A process that is killed (Windows restart, Task Manager, a parent job closing) or crashes natively writes nothing on its
 * way out. The heartbeat in this file lets the next start tell those cases apart from a clean stop or a logged fatal
 * error, instead of leaving an unexplained gap. It holds timing and memory figures only: no request data, no secrets. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { uptime } from "node:os";

const MB = 1024 * 1024;

export function readPreviousRun(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && typeof value.startedAt === "string" ? value : null;
  } catch (_) {
    return null;
  }
}

/** null for a clean stop or no record; otherwise how the previous process most likely ended, with the evidence used. */
export function classifyPreviousRun(previous, { bootTimeMs = Date.now() - uptime() * 1000 } = {}) {
  if (!previous || previous.clean) return null;
  const lastSeen = Date.parse(previous.heartbeatAt || previous.startedAt);
  const evidence = { pid: previous.pid ?? null, startedAt: previous.startedAt, lastSeenAt: new Date(lastSeen).toISOString(), bootAt: new Date(bootTimeMs).toISOString(),
    rssMb: previous.rssMb ?? null, peakRssMb: previous.peakRssMb ?? null, heapUsedMb: previous.heapUsedMb ?? null };
  // The OS came up after the last heartbeat, so the process ended with the previous Windows session.
  if (Number.isFinite(lastSeen) && bootTimeMs > lastSeen) return { kind: "system-restart", ...evidence };
  if (previous.fatal) return { kind: "fatal-error", fatal: previous.fatal, ...evidence };
  // Same OS session, no clean stop and no logged fatal error: terminated from outside or a native crash.
  return { kind: "unexpected-exit", ...evidence };
}

export function createLifecycleRecorder({ file, port, intervalMs = 30_000, now = () => new Date(), memory = () => process.memoryUsage() }) {
  let timer = null;
  const state = { pid: process.pid, node: process.version, port, startedAt: now().toISOString(), heartbeatAt: null, clean: false, fatal: null, rssMb: null, peakRssMb: null, heapUsedMb: null };
  function write() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(state));
      renameSync(temp, file);
    } catch (_) { /* Diagnostics must never take the bridge down. */ }
  }
  function beat() {
    const usage = memory();
    state.heartbeatAt = now().toISOString();
    state.rssMb = Math.round(usage.rss / MB);
    state.heapUsedMb = Math.round(usage.heapUsed / MB);
    state.peakRssMb = Math.max(state.peakRssMb ?? 0, state.rssMb);
    write();
  }
  return {
    state,
    start() { beat(); timer = setInterval(beat, intervalMs); timer.unref(); },
    fatal(info) { state.fatal = { at: now().toISOString(), ...info }; beat(); },
    stopped() { if (timer) clearInterval(timer); timer = null; state.clean = true; state.stoppedAt = now().toISOString(); beat(); }
  };
}

/** A V8 stack reduced to frame locations, with user-profile paths masked; never includes request data. */
export function safeStack(error) {
  return String(error?.stack || "").split("\n").slice(1, 9).map((line) => line.trim().replace(/[A-Za-z]:\\Users\\[^\\]+/gi, "[user]").replace(/\/(?:home|Users)\/[^/]+/g, "[user]").slice(0, 200));
}
