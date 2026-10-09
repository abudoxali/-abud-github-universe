import { readFile } from "node:fs/promises";
import { App } from "@octokit/app";
import { repoName, statusClaims } from "./security.js";
export function requireReadOnlyInstallation(installationRecord, config) {
  if (installationRecord.account?.id !== config.ownerId ||
    installationRecord.account?.login?.toLowerCase() !== config.ownerLogin.toLowerCase() ||
    installationRecord.repository_selection !== "selected")
    throw Error("GitHub App must be installed on the owner's explicitly SELECTED repositories");
  for (const [name, permission] of Object.entries(installationRecord.permissions || {})) {
    if (permission !== "read") throw Error("GitHub App has a non-read-only permission: " + name);
  }
  if (installationRecord.permissions?.metadata !== "read")
    throw Error("GitHub App installation needs Metadata: Read");
  if (installationRecord.permissions?.contents !== "read")
    throw Error("GitHub App installation needs Contents: Read");
  return true;
}
export async function createGitHubInstallation(env, config) {
  const pem = await readFile(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
  const app = new App({ appId: env.GITHUB_APP_ID, privateKey: pem });
  const id = Number(env.GITHUB_INSTALLATION_ID);
  const installationRecord = (await app.octokit.request("GET /app/installations/{installation_id}", {
    installation_id: id
  })).data;
  requireReadOnlyInstallation(installationRecord, config);
  const installation = await app.getInstallationOctokit(id);
  async function list() {
    const output = [], used = new Set();
    for (let page = 1; page <= 10; page++) {
      const { data } = await installation.request("GET /installation/repositories", { per_page: 100, page });
      if (!Array.isArray(data.repositories)) throw Error("Invalid GitHub App installation response");
      for (const r of data.repositories) {
        if (r.owner?.id !== config.ownerId || r.owner?.login?.toLowerCase() !== config.ownerLogin.toLowerCase() || !repoName(r.name) || used.has(r.name)) continue;
        used.add(r.name);
        output.push({
          name: r.name, private: r.private === true, archived: r.archived === true,
          updatedAt: r.pushed_at || null, defaultBranch: r.default_branch || null, htmlUrl: r.html_url
        });
      }
      if (data.repositories.length < 100) break;
      if (page === 10) throw Error("Incomplete installation pagination");
    }
    return output.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function getStatus(name) {
    if (!repoName(name)) return null;
    const approved = await list(); // fresh installation membership; no inferred access
    const target = approved.find(r => r.name === name);
    if (!target) return null;
    try {
      const { data } = await installation.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: config.ownerLogin, repo: name, path: "STATUS.md", ref: target.defaultBranch || undefined
      });
      if (Array.isArray(data) || data.type !== "file" || data.encoding !== "base64" || data.size > 150000) return { exists: false, reason: "unavailable" };
      const text = Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8");
      return { exists: true, sha: data.sha, claims: statusClaims(text), checkedAt: new Date().toISOString() };
    } catch (error) {
      if (error.status === 404) return { exists: false, reason: "not-found" };
      throw error;
    }
  }
  return { list, getStatus };
}
