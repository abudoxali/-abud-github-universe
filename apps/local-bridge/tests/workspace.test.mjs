import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceScanner, detectStack, loadWorkspaceConfig, parseStatusDocument, parseStatusV2, publicWorkspaceConfig, sanitizeRemote } from "../src/workspace.mjs";

const jsonPath = (path) => JSON.stringify(path).slice(1, -1); // how a Windows path appears inside serialized JSON
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });

async function makeRepo(root, name, { remote, files = {}, dirty = false } = {}) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content);
  await writeFile(join(dir, "README.md"), "# readme\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `initial commit for ${name}`);
  if (remote) git(dir, "remote", "add", "origin", remote);
  if (dirty) await writeFile(join(dir, "untracked.txt"), "x");
  return dir;
}

test("remote sanitizer reduces GitHub remotes to owner/name and strips embedded credentials", () => {
  assert.equal(sanitizeRemote("https://x-access-token:ghp_ABCDEFGHIJKLMNOP1234@github.com/Owner/Repo.git").github, "Owner/Repo");
  assert.doesNotMatch(JSON.stringify(sanitizeRemote("https://user:secret@gitlab.com/g/p.git")), /secret|user:/);
  assert.equal(sanitizeRemote("git@github.com:Owner/Repo.git").display, "github.com/Owner/Repo");
  assert.equal(sanitizeRemote("").kind, "none");
  assert.equal(sanitizeRemote("C:\\Users\\me\\bare.git").kind, "local");
  assert.equal(sanitizeRemote("C:\\Users\\me\\bare.git").display, null);
});

test("git status v2 parser reads branch, ahead/behind and counts changes", () => {
  const out = ["# branch.oid abc123", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1", "1 .M N... 100644 100644 100644 a b file.js", "? new.txt"].join("\n");
  assert.deepEqual(parseStatusV2(out), { oid: "abc123", branch: "main", detached: false, upstream: true, ahead: 2, behind: 1, changed: 2, untracked: 1 });
  assert.equal(parseStatusV2("# branch.oid (initial)\n# branch.head (detached)").detached, true);
});

test("STATUS.md metadata keeps only title/updated/state and drops secret-looking lines", () => {
  const meta = parseStatusDocument("# My Project\nUpdated: 2030-01-01\nState: **SHIPPED**\nAPI_KEY=sk-live-123456\nmail owner@example.com");
  assert.deepEqual(meta, { title: "My Project", updated: "2030-01-01", state: "SHIPPED" });
});

test("stack detection uses manifests only", () => {
  const stack = detectStack(["package.json", "tsconfig.json", "index.html"], { dependencies: { next: "1" }, devDependencies: { tailwindcss: "1" } });
  assert.deepEqual(stack.languages, ["TypeScript"]);
  assert.deepEqual(stack.frameworks, ["next", "tailwindcss"]);
  assert.deepEqual(detectStack(["artisan", "composer.json"], null).frameworks, ["laravel"]);
});

test("workspace config accepts only existing absolute folders and never exposes full paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "abud-ws-"));
  const config = await loadWorkspaceConfig({ configPath: join(root, "none.json"), env: { ABUD_WORKSPACE_ROOTS: [root, "relative/path", join(root, "missing")].join(process.platform === "win32" ? ";" : ":") } });
  assert.equal(config.roots.length, 1);
  assert.ok(!JSON.stringify(publicWorkspaceConfig(config)).includes(jsonPath(tmpdir())), "only the folder label is public, never its full path");
  assert.equal((await loadWorkspaceConfig({ configPath: join(root, "none.json"), env: {} })).configured, false);
});

test("scanner discovers real repositories read-only, skips symlinks/ignored dirs, never reads secrets, and caches incrementally", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "abud-ws-"));
  await makeRepo(root, "alpha", { remote: "https://token123:secret456@github.com/acme/alpha.git", files: { "package.json": JSON.stringify({ dependencies: { react: "1" } }), "STATUS.md": "# Alpha\nUpdated: 2030-02-02\nState: Active\nTOKEN=abc\n", ".env": "SECRET_VALUE=do-not-read" }, dirty: true });
  await makeRepo(root, "beta");
  await mkdir(join(root, "node_modules", "pkg", ".git"), { recursive: true });
  await mkdir(join(root, "plain-folder"), { recursive: true });
  try { await symlink(join(root, "alpha"), join(root, "alias-to-alpha"), "junction"); } catch (_) { t.diagnostic("symlink not permitted on this host"); }
  const config = await loadWorkspaceConfig({ env: { ABUD_WORKSPACE_ROOTS: root } });
  let clock = 1000;
  const scanner = createWorkspaceScanner({ config, ttlMs: 60_000, now: () => clock, knownPaths: () => new Map() });

  const first = await scanner.scan();
  assert.deepEqual(first.repos.map((r) => r.name).sort(), ["alpha", "beta"]);
  const alpha = first.repos.find((r) => r.name === "alpha");
  assert.equal(alpha.state, "ready");
  assert.equal(alpha.branch, "main");
  assert.equal(alpha.dirty, true);
  assert.equal(alpha.untrackedFiles >= 1, true);
  assert.equal(alpha.remote.github, "acme/alpha");
  assert.equal(alpha.readme, true);
  assert.deepEqual(alpha.frameworks, ["react"]);
  assert.deepEqual(alpha.statusDoc, { present: true, title: "Alpha", updated: "2030-02-02", state: "Active" });
  assert.equal(first.repos.find((r) => r.name === "beta").dirty, false);
  assert.equal(first.repos.find((r) => r.name === "beta").remote.kind, "none");
  assert.deepEqual(first.folders.map((f) => f.name), ["plain-folder"]);
  const serialized = JSON.stringify(first);
  for (const leak of ["secret456", "token123", "do-not-read", jsonPath(tmpdir()), "SECRET_VALUE"]) assert.ok(!serialized.includes(leak), `leaked ${leak}`);
  assert.equal(first.summary.fromCache, 0);

  const second = await scanner.scan();
  assert.equal(second.summary.fromCache, 2, "unchanged repositories are served from the per-repository cache");

  await writeFile(join(root, "beta", "later.txt"), "x");
  const targeted = await scanner.scan({ refresh: "beta" });
  assert.equal(targeted.repos.find((r) => r.name === "beta").dirty, true, "single-repository refresh bypasses the cache");
  assert.equal(targeted.repos.find((r) => r.name === "alpha").cached, true, "other repositories stay cached");

  clock += 120_000;
  assert.equal((await scanner.scan()).summary.fromCache, 0, "cache expires after the TTL");
});

test("discovery performs no writes: repository state is identical before and after", async () => {
  const root = await mkdtemp(join(tmpdir(), "abud-ws-"));
  const dir = await makeRepo(root, "gamma", { dirty: true });
  const before = git(dir, "status", "--porcelain=v1", "-uall").toString() + git(dir, "rev-parse", "HEAD").toString();
  const config = await loadWorkspaceConfig({ env: { ABUD_WORKSPACE_ROOTS: root } });
  await createWorkspaceScanner({ config, knownPaths: () => new Map() }).scan({ refresh: "all" });
  assert.equal(git(dir, "status", "--porcelain=v1", "-uall").toString() + git(dir, "rev-parse", "HEAD").toString(), before);
});

test("a non-repository path or unreadable git state yields a bounded state, not a crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "abud-ws-"));
  await mkdir(join(root, "fake", ".git"), { recursive: true }); // .git exists but is not a real repository
  const config = await loadWorkspaceConfig({ env: { ABUD_WORKSPACE_ROOTS: root } });
  const scan = await createWorkspaceScanner({ config, knownPaths: () => new Map() }).scan();
  assert.equal(scan.repos.length, 1);
  assert.notEqual(scan.repos[0].state, "ready");
});
