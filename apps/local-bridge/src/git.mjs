import { access, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const GITHUB_REPO = /^(?:https?:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STATIC_ASSETS = new Set([
  "app.js", "command-center.css", "command-center.js", "data.js", "decisions.css", "decisions.js",
  "favicon.svg", "index.html", "intelligence.css", "intelligence.js", "local-worlds.css",
  "local-worlds.js", "project-board.css", "project-board.js", "project-map.css", "project-map.js", "reports.css", "reports.js", "styles.css", "universe-experience.css", "universe-experience.js", "workboard.css", "workboard.js"
]);

const text = (value, max = 160) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const validId = (value) => typeof value === "string" && ID.test(value);
const validGithub = (value) => typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);

export function normalizeRemote(value) {
  const match = String(value ?? "").trim().match(GITHUB_REPO);
  return match ? `${match[1]}/${match[2]}` : null;
}

function normalizeProject(project) {
  if (!project || typeof project !== "object") return null;
  const github = validGithub(project.github) ? project.github : normalizeRemote(project.github);
  if (!validId(project.id) || !text(project.name, 100) || !github || typeof project.path !== "string" || !isAbsolute(project.path)) return null;
  return {
    id: project.id,
    name: text(project.name, 100),
    path: resolve(project.path),
    github
  };
}

function normalizeWorld(world) {
  if (!world || typeof world !== "object" || !validId(world.id) || !text(world.name, 100)) return null;
  const projects = Array.isArray(world.projects) ? world.projects.map(normalizeProject).filter(Boolean).slice(0, 100) : [];
  return {
    id: world.id,
    name: text(world.name, 100),
    ar: text(world.ar, 160),
    en: text(world.en, 160),
    description: text(world.description, 240),
    color: /^#[0-9a-f]{6}$/i.test(world.color) ? world.color : "#c084fc",
    projects
  };
}

export function sanitizeWorldConfig(config) {
  return {
    githubOwner: validGithubOwner(config?.githubOwner) ? config.githubOwner : null,
    configured: config?.configured !== false,
    worlds: (Array.isArray(config?.worlds) ? config.worlds : []).map((world) => ({
      id: world.id,
      name: world.name,
      ar: world.ar,
      en: world.en,
      description: world.description,
      color: world.color,
      projects: (Array.isArray(world.projects) ? world.projects : []).map((project) => ({
        id: project.id,
        name: project.name,
        github: project.github
      }))
    }))
  };
}

function validGithubOwner(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value);
}

export async function loadWorldConfig(configPath) {
  let raw;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { githubOwner: null, worlds: [], configured: false };
    throw new Error("invalid-local-config");
  }
  const worlds = Array.isArray(raw?.worlds) ? raw.worlds.map(normalizeWorld).filter(Boolean).slice(0, 50) : [];
  return {
    githubOwner: validGithubOwner(raw?.githubOwner) ? raw.githubOwner : null,
    worlds,
    configured: true
  };
}

async function git(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 });
  return stdout.trim();
}

export async function readGitProject(project) {
  const base = { id: text(project?.id, 64), name: text(project?.name, 100), github: validGithub(project?.github) ? project.github : null };
  if (!project || typeof project.path !== "string" || !isAbsolute(project.path)) return { ...base, status: "invalid-path" };
  try {
    const details = await stat(project.path);
    if (!details.isDirectory()) return { ...base, status: "missing" };
    const root = await git(["rev-parse", "--show-toplevel"], project.path);
    const branch = await git(["branch", "--show-current"], project.path).catch(() => "");
    const head = await git(["rev-parse", "--short", "HEAD"], project.path).catch(() => "");
    const porcelain = await git(["status", "--porcelain=v1", "--untracked-files=all"], project.path);
    const log = await git(["log", "-1", "--format=%H%x00%s%x00%cI"], project.path).catch(() => "");
    const remoteRaw = await git(["remote", "get-url", "origin"], project.path).catch(() => "");
    const remote = normalizeRemote(remoteRaw);
    const [sha = "", subject = "", date = ""] = log.split("\u0000");
    return {
      ...base,
      status: "ready",
      branch: text(branch || "DETACHED", 100),
      head: text(head || sha.slice(0, 12), 20),
      dirty: Boolean(porcelain),
      changedFiles: porcelain ? porcelain.split(/\r?\n/).filter(Boolean).length : 0,
      lastCommit: { sha: text(sha, 64), subject: text(subject, 160), date: text(date, 40) },
      gitRoot: Boolean(root),
      remote: remote,
      remoteMatches: Boolean(remote && base.github && remote.toLowerCase() === base.github.toLowerCase())
    };
  } catch (error) {
    return { ...base, status: error?.code === "ENOENT" ? "missing" : "not-git" };
  }
}

export function isAllowedAsset(asset) {
  return typeof asset === "string" && STATIC_ASSETS.has(asset) && !asset.includes("/") && !asset.includes("\\");
}

/** Internal (loopback-only) UI modules. They are deliberately not part of the public GitHub Pages artifact. */
export function isInternalAsset(asset) {
  return typeof asset === "string" && (/^internal\/[a-z0-9-]{1,40}\.(?:js|css)$/.test(asset) || /^internal\/assets\/agents\/[a-z0-9-]{1,40}\.webp$/.test(asset) || /^internal\/assets\/fonts\/[a-z0-9-]{1,40}\.woff2$/.test(asset));
}

export { STATIC_ASSETS };
