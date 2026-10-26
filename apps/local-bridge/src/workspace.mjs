/* Read-only workspace discovery. Inspects only operator-authorized roots, never follows symlinks/junctions, never reads
 * source or environment files, never runs a git command that writes (GIT_OPTIONAL_LOCKS=0, no fetch/pull/checkout). */
import { lstat, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createTtlCache, mapLimit, redact, run, text } from "./util.mjs";
import { classifyPath } from "./context.mjs";

const IGNORED_DIRS = /^(?:node_modules|dist|build|out|target|vendor|coverage|__pycache__|venv|\.venv|\.cache|\.next|\.nuxt|\.turbo|\.git|\.claude|\.idea|\.vscode)$/i;
const MAX_REPOS = 250;
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" };

const caseKey = (path) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));

export async function loadWorkspaceConfig({ configPath, env = process.env } = {}) {
  let rawRoots = [];
  let maxDepth = 1;
  let source = "none";
  if (env.ABUD_WORKSPACE_ROOTS) {
    rawRoots = String(env.ABUD_WORKSPACE_ROOTS).split(process.platform === "win32" ? ";" : ":");
    source = "environment";
  } else if (configPath) {
    try {
      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      rawRoots = Array.isArray(parsed?.roots) ? parsed.roots : [];
      if (parsed?.maxDepth === 2) maxDepth = 2;
      source = "local/workspace.json";
    } catch (error) {
      if (error?.code !== "ENOENT") return { configured: false, source: "local/workspace.json", error: "invalid-workspace-config", roots: [], maxDepth };
    }
  }
  const roots = [], rejected = [];
  for (const entry of rawRoots.slice(0, 8)) {
    // A root is a path string, or { path, label?, personal? } where `personal` is the owner's explicit confirmation.
    const candidate = typeof entry === "string" ? entry : entry?.path;
    if (typeof candidate !== "string" || !isAbsolute(candidate.trim())) continue;
    const path = resolve(candidate.trim());
    try {
      if (!(await stat(path)).isDirectory()) continue;
    } catch (_) { continue; }
    if (roots.some((root) => caseKey(root.path) === caseKey(path))) continue;
    const label = text(typeof entry === "object" && entry.label ? entry.label : basename(path), 60) || "workspace";
    const verdict = classifyPath(path, { personalConfirmed: typeof entry === "object" && entry.personal === true });
    // Refused scopes are reported by label and reason only; their path is never exposed or inspected.
    if (!verdict.ok) { rejected.push({ label, code: verdict.code, reasonAr: verdict.reasonAr }); continue; }
    roots.push({ id: `root-${roots.length + 1}`, label, path, personal: verdict.personal === true });
  }
  return { configured: roots.length > 0, source, roots, rejected, maxDepth };
}

/** Owner-managed scopes live in local/workspace.json. An environment-defined list (ABUD_WORKSPACE_ROOTS) takes precedence
 * and is read-only here. Every write re-validates through the same protected-path policy the loader applies. */
async function readRootEntries(configPath) {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    return { entries: Array.isArray(parsed?.roots) ? parsed.roots : [], maxDepth: parsed?.maxDepth === 2 ? 2 : 1 };
  } catch (error) {
    if (error?.code === "ENOENT") return { entries: [], maxDepth: 1 };
    throw Object.assign(new Error("invalid-workspace-config"), { code: "invalid-workspace-config" });
  }
}
async function writeRootEntries(configPath, entries, maxDepth) {
  await mkdir(dirname(configPath), { recursive: true });
  const temp = `${configPath}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ roots: entries, maxDepth }, null, 2), "utf8");
  await rename(temp, configPath);
}
const entryPath = (entry) => resolve(String(typeof entry === "string" ? entry : entry?.path ?? ""));

export async function addWorkspaceRoot({ configPath, env = process.env, path, label, personal = false } = {}) {
  if (env.ABUD_WORKSPACE_ROOTS) return { ok: false, status: 409, code: "environment-managed", messageAr: "المجلدات محددة بمتغير بيئة؛ عدّلها من هناك" };
  if (typeof path !== "string" || !isAbsolute(path.trim())) return { ok: false, status: 422, code: "invalid-path", messageAr: "اكتب مسارًا كاملًا لمجلد موجود" };
  const target = resolve(path.trim());
  try { if (!(await stat(target)).isDirectory()) throw new Error("not-directory"); } catch (_) { return { ok: false, status: 422, code: "not-a-folder", messageAr: "المسار غير موجود أو ليس مجلدًا" }; }
  const verdict = classifyPath(target, { personalConfirmed: personal === true });
  if (!verdict.ok) return { ok: false, status: 422, code: verdict.code, messageAr: verdict.reasonAr };
  const { entries, maxDepth } = await readRootEntries(configPath);
  if (entries.some((entry) => caseKey(entryPath(entry)) === caseKey(target))) return { ok: false, status: 409, code: "already-added", messageAr: "هذا المجلد مضاف بالفعل" };
  if (entries.length >= 8) return { ok: false, status: 422, code: "too-many", messageAr: "الحد الأقصى 8 مجلدات" };
  await writeRootEntries(configPath, [...entries, { path: target, label: text(label || basename(target), 60), personal: verdict.personal === true }], maxDepth);
  return { ok: true };
}

export async function removeWorkspaceRoot({ configPath, env = process.env, id } = {}) {
  if (env.ABUD_WORKSPACE_ROOTS) return { ok: false, status: 409, code: "environment-managed", messageAr: "المجلدات محددة بمتغير بيئة؛ عدّلها من هناك" };
  const config = await loadWorkspaceConfig({ configPath, env });
  const root = config.roots.find((r) => r.id === id);
  if (!root) return { ok: false, status: 404, code: "not-found", messageAr: "المجلد غير موجود" };
  const { entries, maxDepth } = await readRootEntries(configPath);
  await writeRootEntries(configPath, entries.filter((entry) => caseKey(entryPath(entry)) !== caseKey(root.path)), maxDepth);
  return { ok: true };
}

export const publicWorkspaceConfig = (config) => ({
  configured: config.configured, source: config.source, error: config.error ?? null, maxDepth: config.maxDepth,
  roots: config.roots.map((root) => ({ id: root.id, label: root.label, personal: root.personal === true })),
  rejected: config.rejected ?? []
});

// ---------------------------------------------------------------- pure parsers

export function sanitizeRemote(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { kind: "none", github: null, host: null, display: null };
  let host = null;
  let path = null;
  const scp = value.match(/^(?:[^@\s/]+@)?([A-Za-z0-9.-]+):(?!\/\/)([^\s]+)$/);
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith(".") || value.startsWith("file:")) {
    return { kind: "local", github: null, host: null, display: null };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try { const url = new URL(value); host = url.hostname.toLowerCase(); path = url.pathname.replace(/^\/+/, ""); } catch (_) { return { kind: "other", github: null, host: null, display: null }; }
  } else if (scp) {
    host = scp[1].toLowerCase(); path = scp[2].replace(/^\/+/, "");
  } else {
    return { kind: "other", github: null, host: null, display: null };
  }
  path = path.replace(/\.git\/?$/i, "").replace(/\/+$/, "");
  if (host === "github.com" || host === "www.github.com") {
    const match = path.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    return match ? { kind: "github", github: `${match[1]}/${match[2]}`, host: "github.com", display: `github.com/${match[1]}/${match[2]}` } : { kind: "other", github: null, host, display: host };
  }
  return { kind: "other", github: null, host, display: text(`${host}/${path}`, 120) };
}

export function parseStatusV2(output) {
  const result = { oid: null, branch: null, detached: false, upstream: null, ahead: null, behind: null, changed: 0, untracked: 0 };
  for (const line of String(output).split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) { const oid = line.slice(13).trim(); result.oid = oid === "(initial)" ? null : oid; }
    else if (line.startsWith("# branch.head ")) { const head = line.slice(14).trim(); result.detached = head === "(detached)"; result.branch = result.detached ? null : head; }
    else if (line.startsWith("# branch.upstream ")) result.upstream = true;
    else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]); }
    } else if (line.startsWith("?")) { result.untracked++; result.changed++; }
    else if (!line.startsWith("#") && !line.startsWith("!")) result.changed++;
  }
  return result;
}

const SECRET_LINE = /(api[_-]?key|token|secret|password|passwd|authorization|bearer|private[_-]?key)\s*[:=]/i;

/** Extracts only a title plus Updated/State-style fields from a STATUS.md head; secret-looking lines are dropped. */
export function parseStatusDocument(content) {
  const lines = String(content).split(/\r?\n/).slice(0, 80).filter((line) => !SECRET_LINE.test(line));
  const title = lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, "");
  const field = (names) => {
    for (const line of lines) {
      const match = line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?([A-Za-z ]{3,24})(?:\*\*)?\s*[:：]\s*(?:\*\*)?(.+?)(?:\*\*)?\s*$/);
      if (match && names.includes(match[1].trim().toLowerCase())) return redact(match[2].replace(/[`*]/g, ""), 140);
    }
    return null;
  };
  return { title: title ? redact(title, 100) : null, updated: field(["updated", "last updated", "date"]), state: field(["state", "status", "current state"]) };
}

const MARKERS = [
  [/^package\.json$/i, "JavaScript"], [/^tsconfig(?:\.[a-z]+)?\.json$/i, "TypeScript"], [/^composer\.json$/i, "PHP"], [/^artisan$/i, "Laravel"],
  [/^(?:requirements\.txt|pyproject\.toml|setup\.py)$/i, "Python"], [/^cargo\.toml$/i, "Rust"], [/^go\.mod$/i, "Go"], [/\.(?:csproj|sln)$/i, ".NET"],
  [/^pubspec\.yaml$/i, "Dart/Flutter"], [/^project\.godot$/i, "Godot"], [/^gemfile$/i, "Ruby"], [/^(?:pom\.xml|build\.gradle(?:\.kts)?)$/i, "JVM"], [/\.blend$/i, "Blender"]
];
const FRAMEWORKS = ["next", "react", "vue", "svelte", "vite", "express", "electron", "tailwindcss", "astro", "nuxt", "expo", "fastify", "nestjs", "@nestjs/core"];

export function detectStack(names, packageJson) {
  const languages = new Set();
  for (const name of names) for (const [pattern, label] of MARKERS) if (pattern.test(name)) languages.add(label);
  if (languages.has("TypeScript")) languages.delete("JavaScript");
  if (!languages.size && names.some((name) => /^index\.html$/i.test(name))) languages.add("Static web");
  const frameworks = new Set();
  const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
  for (const name of FRAMEWORKS) if (Object.hasOwn(deps, name)) frameworks.add(name === "@nestjs/core" ? "nestjs" : name);
  if (languages.has("Laravel")) { languages.delete("Laravel"); languages.add("PHP"); frameworks.add("laravel"); }
  return { languages: [...languages].sort(), frameworks: [...frameworks].sort() };
}

// ---------------------------------------------------------------- discovery

async function readHead(path, bytes) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

async function inspectRepo({ dir, rel, rootId, worlds }) {
  const base = { name: basename(dir), rel, rootId, git: true, worlds: worlds ?? [] };
  const started = Date.now();
  let names = [];
  try { names = await readdir(dir); } catch (_) { return { ...base, state: "unreadable" }; }
  const [statusRun, logRun, remoteRun] = await Promise.all([
    run("git", ["-c", "core.quotepath=off", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"], { cwd: dir, timeout: 10_000, env: GIT_ENV }),
    run("git", ["log", "-1", "--format=%H%x00%s%x00%cI"], { cwd: dir, timeout: 5000, env: GIT_ENV }),
    run("git", ["config", "--get", "remote.origin.url"], { cwd: dir, timeout: 5000, env: GIT_ENV })
  ]);
  if (!statusRun.ok) return { ...base, state: statusRun.reason === "timeout" ? "timeout" : "git-error" };
  const status = parseStatusV2(statusRun.stdout);
  const [sha = "", subject = "", date = ""] = (logRun.ok ? logRun.stdout.trim() : "").split("\u0000");
  const statusFile = names.find((name) => name.toLowerCase() === "status.md");
  let statusDoc = { present: false };
  if (statusFile) {
    try { statusDoc = { present: true, ...parseStatusDocument(await readHead(join(dir, statusFile), 32 * 1024)) }; } catch (_) { statusDoc = { present: true }; }
  }
  let packageJson = null;
  if (names.includes("package.json")) {
    try {
      const size = (await stat(join(dir, "package.json"))).size;
      if (size <= 64 * 1024) packageJson = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    } catch (_) { /* unreadable manifest: stack detection falls back to file names */ }
  }
  return {
    ...base, state: "ready",
    branch: status.branch ? text(status.branch, 100) : null, detached: status.detached,
    head: (status.oid || sha).slice(0, 12) || null,
    dirty: status.changed > 0, changedFiles: status.changed, untrackedFiles: status.untracked,
    hasUpstream: status.upstream === true, ahead: status.ahead, behind: status.behind,
    lastCommit: sha ? { sha: sha.slice(0, 12), subject: redact(subject, 160), date: text(date, 40) } : null,
    remote: sanitizeRemote(remoteRun.ok ? remoteRun.stdout : ""),
    readme: names.some((name) => /^readme(?:\.[a-z]+)?$/i.test(name)),
    statusDoc, ...detectStack(names, packageJson), scanMs: Date.now() - started
  };
}

/** Creates a stateful scanner. `refresh` is a way to bypass TTL for everything or for one repository name. */
export function createWorkspaceScanner({ config, knownPaths = () => new Map(), ttlMs = 45_000, now = Date.now } = {}) {
  const repoCache = createTtlCache(ttlMs, now);
  const paths = new Map(); // relative name -> absolute path; server-side only, never serialized to the browser

  async function candidates(root, depth, parent = "") {
    let entries;
    try { entries = await readdir(join(root.path, parent), { withFileTypes: true }); } catch (_) { return { repos: [], folders: [], skipped: { symlinks: 0, ignored: 0 } }; }
    const out = { repos: [], folders: [], skipped: { symlinks: 0, ignored: 0 } };
    for (const entry of entries) {
      if (entry.isSymbolicLink()) { out.skipped.symlinks++; continue; }
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRS.test(entry.name) || entry.name.startsWith(".") || entry.name.startsWith("$")) { out.skipped.ignored++; continue; }
      const rel = parent ? `${parent}/${entry.name}` : entry.name;
      const dir = join(root.path, rel);
      let hasGit = false;
      try { await lstat(join(dir, ".git")); hasGit = true; } catch (_) { /* not a repository */ }
      if (hasGit) out.repos.push({ dir, rel, rootId: root.id });
      else {
        out.folders.push({ name: entry.name, rel, rootId: root.id });
        if (depth > 1) {
          const nested = await candidates(root, depth - 1, rel);
          out.repos.push(...nested.repos);
          out.skipped.symlinks += nested.skipped.symlinks; out.skipped.ignored += nested.skipped.ignored;
        }
      }
    }
    return out;
  }

  async function scan({ refresh = null } = {}) {
    const started = Date.now();
    const known = knownPaths();
    const found = { repos: [], folders: [], skipped: { symlinks: 0, ignored: 0 } };
    for (const root of config.roots) {
      const result = await candidates(root, config.maxDepth);
      found.repos.push(...result.repos); found.folders.push(...result.folders);
      found.skipped.symlinks += result.skipped.symlinks; found.skipped.ignored += result.skipped.ignored;
    }
    paths.clear();
    for (const item of found.repos) paths.set(item.rel, item.dir);
    const truncated = found.repos.length > MAX_REPOS;
    const repos = await mapLimit(found.repos.slice(0, MAX_REPOS), 5, async (item) => {
      const key = caseKey(item.dir);
      const forced = refresh === "all" || (refresh && refresh.toLowerCase() === item.rel.toLowerCase());
      const cached = forced ? undefined : repoCache.get(key);
      if (cached) return { ...cached, cached: true };
      const record = await inspectRepo({ ...item, worlds: known.get(key) });
      record.refreshedAt = new Date(now()).toISOString();
      repoCache.set(key, record);
      return { ...record, cached: false };
    });
    return {
      generatedAt: new Date(now()).toISOString(), scanMs: Date.now() - started, repos, folders: found.folders.slice(0, 200),
      limits: { maxRepos: MAX_REPOS, truncated, depth: config.maxDepth }, skipped: found.skipped,
      summary: {
        repos: repos.length, ready: repos.filter((r) => r.state === "ready").length, dirty: repos.filter((r) => r.dirty).length,
        behind: repos.filter((r) => r.behind > 0).length, ahead: repos.filter((r) => r.ahead > 0).length,
        noRemote: repos.filter((r) => r.state === "ready" && r.remote?.kind === "none").length, nonGitFolders: found.folders.length,
        fromCache: repos.filter((r) => r.cached).length
      }
    };
  }
  return { scan, paths };
}
