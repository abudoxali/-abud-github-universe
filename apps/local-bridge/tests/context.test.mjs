/* V6 company context boundaries: protected locations, personal-folder confirmation, owner-managed scopes, access history. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath, NEVER_READ_FILES } from "../src/context.mjs";
import { addWorkspaceRoot, loadWorkspaceConfig, publicWorkspaceConfig, removeWorkspaceRoot } from "../src/workspace.mjs";
import { createServer } from "../src/server.mjs";
import { startStubRouter, TEST_KEY } from "./fixtures.mjs";

const home = "C:\\Users\\Someone";
const ok = (path, options) => classifyPath(path, { home, ...options });

test("credential stores, browser profiles, system folders and drive roots can never be authorized", () => {
  for (const path of [`${home}\\.ssh`, `${home}\\.aws\\sso`, `${home}\\.omniroute`, `${home}\\.claude\\projects`, `${home}\\AppData\\Local\\Google\\Chrome\\User Data`,
    `${home}\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles`, `${home}\\AppData\\Roaming\\Microsoft\\Credentials`, "C:\\Windows\\System32", "C:\\Program Files\\App", "D:\\KeePass\\db"]) {
    assert.equal(ok(path).ok, false, path);
    assert.equal(ok(path, { personalConfirmed: true }).ok, false, `${path} stays refused even with personal confirmation`);
  }
  assert.equal(ok("C:\\").code, "too-broad");
  assert.equal(ok(home).code, "too-broad");
});

test("personal folders need the owner's explicit confirmation; their subfolders and normal workspaces do not", () => {
  assert.equal(ok(`${home}\\Documents`).code, "personal-needs-confirmation");
  assert.equal(ok(`${home}\\Documents`, { personalConfirmed: true }).ok, true);
  assert.equal(ok(`${home}\\Documents`, { personalConfirmed: true }).personal, true);
  assert.equal(ok(`${home}\\Desktop\\GitHub`).ok, true, "a project folder on the Desktop is an ordinary scope");
  assert.equal(ok(`${home}\\OneDrive\\Documents`).code, "personal-needs-confirmation");
  assert.equal(ok("D:\\Work\\Clients").ok, true);
});

test("secret-bearing file names are never readable whatever the scope", () => {
  for (const name of [".env", ".env.production", "id_rsa", "id_ed25519", "server.pem", "cert.pfx", "vault.kdbx", ".npmrc", ".git-credentials", "Cookies", "Login Data", "logins.json", "credentials.json", "a/b/secrets.yaml"]) assert.match(name, NEVER_READ_FILES, name);
  for (const name of ["README.md", "STATUS.md", "package.json", "src/index.js", "docs/environment.md"]) assert.doesNotMatch(name, NEVER_READ_FILES, name);
});

test("the workspace loader drops protected roots, reports them by label only, and keeps the old string format working", async () => {
  const base = await mkdtemp(join(tmpdir(), "abud-ctx-"));
  try {
    const good = join(base, "projects"), ssh = join(base, ".ssh"), chrome = join(base, "AppData", "Local", "Google", "Chrome", "User Data");
    for (const dir of [good, ssh, chrome]) await mkdir(dir, { recursive: true });
    const file = join(base, "workspace.json");
    await writeFile(file, JSON.stringify({ roots: [good, ssh, { path: chrome, personal: true }] }));
    const config = await loadWorkspaceConfig({ configPath: file, env: {} });
    assert.deepEqual(config.roots.map((r) => r.label), ["projects"]);
    assert.deepEqual(config.rejected.map((r) => r.code).sort(), ["protected", "protected"]);
    const publicView = JSON.stringify(publicWorkspaceConfig(config));
    assert.ok(!publicView.includes(base.replaceAll("\\", "\\\\")) && !publicView.includes("abud-ctx-"), "no absolute path is exposed");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("owner scope management validates, persists atomically, refuses duplicates and environment-managed lists", async () => {
  const base = await mkdtemp(join(tmpdir(), "abud-ctx-"));
  try {
    const work = join(base, "work"), secrets = join(base, ".gnupg");
    await mkdir(work); await mkdir(secrets);
    const configPath = join(base, "local", "workspace.json");
    assert.deepEqual(await addWorkspaceRoot({ configPath, env: {}, path: work, label: "عمل الشركة" }), { ok: true });
    assert.equal((await addWorkspaceRoot({ configPath, env: {}, path: work })).code, "already-added");
    assert.equal((await addWorkspaceRoot({ configPath, env: {}, path: secrets })).code, "protected");
    assert.equal((await addWorkspaceRoot({ configPath, env: {}, path: "relative/dir" })).code, "invalid-path");
    assert.equal((await addWorkspaceRoot({ configPath, env: {}, path: join(base, "missing") })).code, "not-a-folder");
    assert.equal((await addWorkspaceRoot({ configPath, env: { ABUD_WORKSPACE_ROOTS: work }, path: work })).status, 409);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.roots.length, 1);
    assert.equal(saved.roots[0].label, "عمل الشركة");
    const config = await loadWorkspaceConfig({ configPath, env: {} });
    assert.equal((await removeWorkspaceRoot({ configPath, env: {}, id: "root-9" })).status, 404);
    assert.deepEqual(await removeWorkspaceRoot({ configPath, env: {}, id: config.roots[0].id }), { ok: true });
    assert.equal((await loadWorkspaceConfig({ configPath, env: {} })).configured, false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("context API: owner-guarded scope changes, refusals are audited, access history and outbound usage are measured", async () => {
  const stub = await startStubRouter();
  const dir = await mkdtemp(join(tmpdir(), "abud-ctx-api-"));
  const work = join(dir, "work"), blocked = join(dir, ".ssh");
  await mkdir(work); await mkdir(blocked);
  const server = createServer({
    configPath: join(dir, "worlds.json"), workspaceConfigPath: join(dir, "workspace.json"), policyPath: join(dir, "policy.json"), dbPath: join(dir, "company.db"), backupDir: join(dir, "backups"),
    vpsConfigPath: join(dir, "no-vps.json"), env: { OMNIROUTE_BASE_URL: `http://127.0.0.1:${stub.port}`, OMNIROUTE_API_KEY: TEST_KEY },
    startupOptions: { env: {}, platform: "test" }, agentOptions: { home: dir, env: {}, runImpl: async () => ({ ok: false, reason: "not-found" }) },
    githubReader: { resolve: async () => ({ state: "unavailable" }), read: async (github) => ({ state: "not-linked", github, fetchedAt: new Date().toISOString(), cached: false, unavailable: [] }) },
    background: false, log: () => {}
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/local-api/company`;
  try {
    const token = (await (await fetch(`http://127.0.0.1:${server.address().port}/local-api/session`)).json()).token;
    const call = (method, path, body, guarded = true) => fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(guarded ? { "X-Abud-Session": token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await call("POST", "/context/scopes", { path: work }, false)).status, 403);
    const refused = await call("POST", "/context/scopes", { path: blocked, label: "مفاتيح" });
    assert.equal(refused.status, 422);
    assert.equal((await refused.json()).error, "protected");
    assert.ok(server.company.activity({ limit: 20 }).some((e) => e.action === "context.scope.refused"), "the refusal is audited");
    const added = await (await call("POST", "/context/scopes", { path: work, label: "عمل" })).json();
    assert.deepEqual(added.scopes.roots.map((r) => r.label), ["عمل"]);
    assert.ok(!JSON.stringify(added).includes("abud-ctx-api-"), "the response never carries an absolute path");
    assert.ok(added.protected.length >= 8);
    assert.ok(added.dataFlow.neverSent.some((line) => line.includes("الصوت")));
    server.company.db.run("INSERT INTO usage_events (at, agent_id, provider, model, prompt_tokens, completion_tokens, cost_basis, source) VALUES (?,?,?,?,?,?,?,?)", new Date().toISOString(), "nex", "gemini", "flash-lite", 120, 30, "unknown", "router-reported");
    server.company.db.run("INSERT INTO tool_executions (id, tool_id, tool_version, agent_id, actor_type, actor_id, status, started_at) VALUES (?,?,?,?,?,?,?,?)", "tex_1", "project.docs", "1", "nex", "agent", "nex", "succeeded", new Date().toISOString());
    const overview = await (await fetch(`${base}/context`)).json();
    assert.deepEqual(overview.outbound.byModel[0], { provider: "gemini", model: "flash-lite", requests: 1, promptTokens: 120, completionTokens: 30 });
    assert.equal(overview.access[0].toolId, "project.docs");
    const removed = await (await call("DELETE", `/context/scopes/${added.scopes.roots[0].id}`)).json();
    assert.equal(removed.scopes.roots.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
