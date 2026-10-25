import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const text = (value, max = 160) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;
const LONG_TOKEN = /\b(?:gh[pousr]_|github_pat_|sk-|AIza|ya29\.)[A-Za-z0-9_\-.]{12,}/g;
const WINDOWS_USER_PATH = /[A-Za-z]:\\Users\\[^\\\s"']+/gi;

/** Masks values that must never reach the browser or logs: emails, URL credentials, token-like strings, user paths. */
export function redact(value, max = 200) {
  return text(value, max * 2)
    .replace(URL_CREDENTIALS, "$1")
    .replace(LONG_TOKEN, "[redacted-token]")
    .replace(WINDOWS_USER_PATH, "[user-path]")
    .replace(EMAIL, "$1***$2")
    .slice(0, max);
}

export const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
export const iso = (value) => {
  if (value == null || value === "") return null;
  const time = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** Small TTL cache; errors are never cached so a transient failure cannot mask recovery. */
export function createTtlCache(defaultTtlMs = 15_000, now = () => Date.now()) {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expires <= now()) { store.delete(key); return undefined; }
      return entry.value;
    },
    set(key, value, ttlMs = defaultTtlMs) { store.set(key, { value, expires: now() + ttlMs }); return value; },
    delete(key) { store.delete(key); },
    clear() { store.clear(); }
  };
}

/** Runs async work with bounded concurrency while preserving input order. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Executes a binary without a shell; resolves to a result object instead of throwing. */
export async function run(file, args, { cwd, timeout = 8000, maxBuffer = 512 * 1024, env } = {}) {
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd, timeout, maxBuffer, windowsHide: true, env: env ? { ...process.env, ...env } : process.env
    });
    return { ok: true, stdout: String(stdout) };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout ?? ""),
      reason: error?.killed || error?.signal ? "timeout" : error?.code === "ENOENT" ? "not-found" : "failed"
    };
  }
}

export const provenance = (kind, source, fetchedAt = new Date().toISOString(), extra = {}) => ({ kind, source, fetchedAt, ...extra });
