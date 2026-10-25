import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubReader } from "../src/github.mjs";

test("GitHub reader validates identity, bounds requests and caches sanitized read-only evidence", async () => {
  const calls = [];
  const reader = createGitHubReader({ run: async (endpoint) => {
    calls.push(endpoint);
    if (endpoint.endsWith("/issues?state=open&per_page=10")) return JSON.stringify([{ number: 1, title: "Fix", state: "open", pull_request: null }, { number: 2, pull_request: {} }]);
    if (endpoint.endsWith("/actions/runs?per_page=5")) return JSON.stringify({ workflow_runs: [] });
    return JSON.stringify(endpoint === "repos/owner/repo" ? { name: "repo", private: true, default_branch: "main", secret: "never-return" } : []);
  }, now: () => 1_000 });
  assert.equal((await reader.read("owner/repo/extra")).state, "not-linked");
  const result = await reader.read("owner/repo");
  assert.equal(result.state, "connected");
  assert.equal(result.repository.private, true);
  assert.equal(result.issues.length, 1);
  assert.equal(calls.length, 7);
  assert.ok(!JSON.stringify(result).includes("never-return"));
  assert.equal((await reader.read("owner/repo")).cached, true);
  assert.equal(calls.length, 7);
});

test("GitHub identity resolution follows redirects read-only and never guesses", async () => {
  const calls = [];
  const reader = createGitHubReader({ run: async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === "repos/old/App") return JSON.stringify({ full_name: "new/App", id: 7 });
    throw Object.assign(new Error("gh: Not Found (HTTP 404)"), { stderr: "gh: Not Found (HTTP 404)" });
  } });
  assert.deepEqual(await reader.resolve("old/App"), { state: "confirmed", canonical: "new/App", repoId: 7 });
  assert.equal((await reader.resolve("old/Gone")).state, "not-found");
  assert.equal((await reader.resolve("../etc")).state, "not-found");
  assert.deepEqual(calls, ["repos/old/App", "repos/old/Gone"]);
  const offline = createGitHubReader({ run: async () => { throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }); } });
  assert.equal((await offline.resolve("old/App")).state, "unavailable");
});

test("GitHub reader reports missing authentication without fabricating remote state", async () => {
  const reader = createGitHubReader({ run: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  const result = await reader.read("owner/repo");
  assert.equal(result.state, "disconnected");
  assert.equal(result.repository, undefined);
});
