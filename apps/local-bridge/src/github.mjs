/* Bounded, read-only GitHub intelligence through the owner's existing gh authentication. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// owner/name only; "." and ".." segments are refused so a value can never walk the API path.
const SLUG = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, value?.[key] ?? null]));

export function createGitHubReader({ run = (endpoint) => execFileAsync("gh", ["api", endpoint], { windowsHide: true, timeout: 8000, maxBuffer: 512 * 1024 }), now = () => Date.now() } = {}) {
  const cache = new Map();
  async function api(endpoint) {
    const result = await run(endpoint);
    return JSON.parse(typeof result === "string" ? result : result.stdout);
  }
  async function collect(slug) {
    let repo;
    try { repo = await api(`repos/${slug}`); }
    catch (error) {
      const message = String(error?.stderr || error?.message || "") + ` ${error?.code || ""}`;
      return { state: /404|Not Found/i.test(message) ? "not-found" : /not logged|authentication|401|403|ENOENT/i.test(message) ? "disconnected" : "unavailable", github: slug, fetchedAt: new Date(now()).toISOString() };
    }
    const sections = [
      ["issues", `repos/${slug}/issues?state=open&per_page=10`, (items) => items.filter((x) => !x.pull_request).map((x) => pick(x, ["number", "title", "state", "html_url", "updated_at"]))],
      ["pullRequests", `repos/${slug}/pulls?state=open&per_page=10`, (items) => items.map((x) => pick(x, ["number", "title", "state", "draft", "html_url", "updated_at"]))],
      ["workflows", `repos/${slug}/actions/runs?per_page=5`, (x) => (x.workflow_runs || []).map((r) => pick(r, ["id", "name", "status", "conclusion", "head_branch", "html_url", "created_at"]))],
      ["releases", `repos/${slug}/releases?per_page=5`, (items) => items.map((x) => pick(x, ["tag_name", "name", "published_at", "html_url", "prerelease", "draft"]))],
      ["commits", `repos/${slug}/commits?per_page=5`, (items) => items.map((x) => ({ sha: x.sha?.slice(0, 12) || null, message: x.commit?.message?.split("\n")[0]?.slice(0, 160) || null, date: x.commit?.committer?.date || null, html_url: x.html_url || null }))],
      ["branches", `repos/${slug}/branches?per_page=10`, (items) => items.map((x) => ({ name: x.name, protected: Boolean(x.protected), sha: x.commit?.sha?.slice(0, 12) || null }))]
    ];
    const data = {};
    const unavailable = [];
    for (let i = 0; i < sections.length; i += 2) {
      await Promise.all(sections.slice(i, i + 2).map(async ([key, endpoint, transform]) => {
        try { data[key] = transform(await api(endpoint)); }
        catch (_) { data[key] = []; unavailable.push(key); }
      }));
    }
    return {
      state: unavailable.length ? "partial" : "connected", github: slug, fetchedAt: new Date(now()).toISOString(),
      source: "GitHub CLI (read-only)", unavailable,
      repository: pick(repo, ["name", "full_name", "html_url", "description", "private", "default_branch", "open_issues_count", "pushed_at", "archived"]),
      ...data
    };
  }
  return {
    /** GitHub's current identity for an observed owner/name (follows rename/transfer redirects). Read-only. */
    async resolve(slug) {
      if (!SLUG.test(slug || "")) return { state: "not-found" };
      try {
        const repo = await api(`repos/${slug}`);
        return SLUG.test(repo?.full_name || "") ? { state: "confirmed", canonical: repo.full_name, repoId: Number.isInteger(repo.id) ? repo.id : null } : { state: "unavailable" };
      } catch (error) {
        return { state: /404|Not Found/i.test(String(error?.stderr || error?.message || "")) ? "not-found" : "unavailable" };
      }
    },
    async read(slug, { refresh = false } = {}) {
      if (!SLUG.test(slug || "")) return { state: "not-linked", github: null };
      const cached = cache.get(slug.toLowerCase());
      if (cached && now() - cached.at < 90_000) return { ...await cached.value, cached: true };
      const value = collect(slug);
      cache.set(slug.toLowerCase(), { at: now(), value });
      const result = await value;
      return { ...result, cached: false };
    }
  };
}
