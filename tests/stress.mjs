/* Bridge stability under load against SYNTHETIC data. The bridge runs in its own child process with its background loops on,
 * a temporary SQLite file, temporary git repositories, and a stub OmniRoute behind a switchable TCP proxy (to cut and restore
 * the router mid-load). It exercises concurrent reads, page/asset loads, task writes, run submission and polling, quota
 * refresh, repository rescans, backups, aborted requests and a router outage + recovery, then requires that the same PID is
 * still healthy, the store passes integrity checks and memory stayed bounded. Usage: node tests/stress.mjs [rounds] */
import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { TEST_KEY, startStubRouter } from "../apps/local-bridge/tests/fixtures.mjs";

const ROUNDS = Number(process.argv[2]) || 6;
const root = process.cwd();
const work = await mkdtemp(join(tmpdir(), "abud-stress-"));
const workspace = join(work, "GitHub");
await mkdir(workspace);
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
for (let i = 0; i < 6; i++) {
  const dir = join(workspace, `repo-${i}`);
  await mkdir(dir);
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), `# r${i}\n`);
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "init");
  git(dir, "remote", "add", "origin", `https://github.com/stress-owner/repo-${i}.git`);
}
await writeFile(join(work, "worlds.json"), JSON.stringify({ githubOwner: "stress-owner", worlds: [] }));

// ---------------------------------------------------------------- stub router behind a switchable proxy
const stub = await startStubRouter();
let routerUp = true;
const sockets = new Set();
const proxy = net.createServer((client) => {
  if (!routerUp) { client.destroy(); return; }
  const upstream = net.connect(stub.port, "127.0.0.1");
  sockets.add(client); sockets.add(upstream);
  const drop = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
  client.on("error", drop); upstream.on("error", drop); client.on("close", drop); upstream.on("close", drop);
  client.pipe(upstream).pipe(client);
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const setRouter = (up) => { routerUp = up; if (!up) for (const s of sockets) s.destroy(); };

// ---------------------------------------------------------------- bridge child process
const dbPath = join(work, "company.db");
const childScript = join(work, "bridge-child.mjs");
await writeFile(childScript, `
import { createServer } from ${JSON.stringify(pathToFileURL(resolve(root, "apps/local-bridge/src/server.mjs")).href)};
const fatal = (kind) => (error) => { console.error(JSON.stringify({ fatal: kind, name: error?.name, message: String(error?.message).slice(0, 200), stack: String(error?.stack).split("\\n").slice(0, 6) })); process.exit(70); };
process.on("uncaughtException", fatal("uncaughtException"));
process.on("unhandledRejection", fatal("unhandledRejection"));
// STRESS_HEAP=1: report the live heap after a forced collection, to tell retained memory from garbage not yet collected.
if (globalThis.gc) setInterval(() => { globalThis.gc(); process.stderr.write("HEAP " + Math.round(process.memoryUsage().heapUsed / 1048576) + "\\n"); }, 1000).unref();
const server = createServer({
  root: ${JSON.stringify(root)}, configPath: ${JSON.stringify(join(work, "worlds.json"))}, workspaceConfigPath: ${JSON.stringify(join(work, "none.json"))},
  policyPath: ${JSON.stringify(join(work, "policy.json"))}, dbPath: ${JSON.stringify(dbPath)}, backupDir: ${JSON.stringify(join(work, "backups"))}, vpsConfigPath: ${JSON.stringify(join(work, "no-vps.json"))}, startupOptions: { env: {}, platform: "test" }, background: true, log: () => {},
  env: { OMNIROUTE_BASE_URL: "http://127.0.0.1:${proxy.address().port}", OMNIROUTE_API_KEY: ${JSON.stringify(TEST_KEY)}, ABUD_WORKSPACE_ROOTS: ${JSON.stringify(workspace)} },
  agentOptions: { home: ${JSON.stringify(work)}, platform: "win32", env: {}, runImpl: async () => ({ ok: false, reason: "not-found" }) },
  githubReader: { resolve: async () => ({ state: "unavailable" }), read: async (github) => ({ state: "disconnected", github }) }
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: server.address().port })));
`);
const child = spawn(process.execPath, [...(process.env.STRESS_HEAP ? ["--expose-gc"] : []), "--disable-warning=ExperimentalWarning", childScript], { stdio: ["ignore", "pipe", "pipe"] });
let childErr = "";
const heapAfterGc = [];
child.stderr.on("data", (d) => { for (const line of String(d).split("\n")) { if (line.startsWith("HEAP ")) heapAfterGc.push(Number(line.slice(5))); else if (line) childErr += `${line}\n`; } });
let exited = null;
child.on("exit", (code) => { exited = code; });
const { port } = await new Promise((resolve, reject) => {
  child.stdout.once("data", (d) => resolve(JSON.parse(String(d).trim().split("\n")[0])));
  child.once("exit", () => reject(new Error(`bridge child exited during start: ${childErr}`)));
});
const origin = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------- client helpers
const stats = { requests: 0, byStatus: {}, aborted: 0, errors: [] };
async function call(path, { method = "GET", body, timeout = 30_000, abortAfter = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), abortAfter ?? timeout);
  try {
    const response = await fetch(`${origin}${path}`, { method, signal: controller.signal, headers: body ? { "Content-Type": "application/json", "X-ABUD-SESSION": token } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    stats.requests++;
    stats.byStatus[response.status] = (stats.byStatus[response.status] || 0) + 1;
    if (response.status >= 500) stats.errors.push(`${method} ${path} -> ${response.status} ${text.slice(0, 120)}`);
    return text && /json/.test(response.headers.get("content-type") || "") ? JSON.parse(text) : null;
  } catch (error) {
    if (abortAfter != null && error.name === "AbortError") { stats.aborted++; return null; }
    stats.errors.push(`${method} ${path} -> ${error.name}: ${error.message}`);
    return null;
  } finally { clearTimeout(timer); }
}
const token = (await (await fetch(`${origin}/local-api/session`)).json()).token;
const memory = async () => (await call("/local-api/infra"))?.local?.bridge?.memoryMb;

const READS = ["/local-api/company/summary", "/local-api/company/projects", "/local-api/company/tasks", "/local-api/company/agents", "/local-api/company/runs?limit=30",
  "/local-api/company/resources", "/local-api/company/notifications", "/local-api/company/activity?limit=50", "/local-api/company/settings", "/local-api/infra",
  "/local-api/omniroute/overview", "/local-api/omniroute/usage?range=7d", "/local-api/workspace", "/local-api/settings", "/local-api/policy", "/local-api/health"];
const ASSETS = ["/", "/app.js", "/styles.css", "/internal/ops-core.js", "/internal/os.css", "/internal/robot-engine.js", "/data.js"];

const started = Date.now();
const memSamples = [await memory()];
await call("/local-api/company/projects/sync", { method: "POST", body: {} });
// The stub router has no Gemini connection: point LUNA's policy domain at the stub's API-key provider (as tests/ops.mjs does).
await call("/local-api/company/policies/admin", { method: "PATCH", body: { candidates: ["nvidia/model-a"] } });
const projectId = (await call("/local-api/company/projects")).projects[0]?.id ?? null;

for (let round = 0; round < ROUNDS; round++) {
  if (round === Math.floor(ROUNDS / 3)) setRouter(false);       // router outage mid-run
  if (round === Math.floor((2 * ROUNDS) / 3)) setRouter(true);  // recovery
  const jobs = [];
  // 1. a refresh storm: every read endpoint four times at once plus page assets (a browser reload burst)
  for (let i = 0; i < 4; i++) for (const path of READS) jobs.push(call(path));
  for (let i = 0; i < 3; i++) for (const path of ASSETS) jobs.push(call(path));
  // 2. forced refreshes (throttled server-side) and a quota snapshot
  jobs.push(call("/local-api/omniroute/overview?refresh=1"), call("/local-api/workspace?refresh=1"), call("/local-api/company/quota/snapshot", { method: "POST", body: {} }));
  // 3. task writes: create, move through statuses, archive/restore
  jobs.push((async () => {
    const task = await call("/local-api/company/tasks", { method: "POST", body: { title: `مهمة ضغط ${round}`, projectId, priority: "high" } });
    if (!task?.id) return;
    for (const status of ["in_progress", "review", "done"]) await call(`/local-api/company/tasks/${task.id}`, { method: "PATCH", body: { status } });
    await call(`/local-api/company/tasks/${task.id}/archive`, { method: "POST", body: {} });
    await call(`/local-api/company/tasks/${task.id}/restore`, { method: "POST", body: {} });
  })());
  // 4. an agent run, polled until it settles (router up: succeeds; router down: fails honestly), one cancelled
  jobs.push((async () => {
    const run = await call("/local-api/company/runs", { method: "POST", body: { agentId: "luna", capability: "chat", request: `طلب ضغط ${round}` } });
    if (!run?.id) return;
    for (let i = 0; i < 40; i++) { const r = await call(`/local-api/company/runs/${run.id}`); if (!r || !["queued", "running"].includes(r.status)) break; await new Promise((x) => setTimeout(x, 150)); }
  })());
  jobs.push((async () => {
    const run = await call("/local-api/company/runs", { method: "POST", body: { agentId: "ori", capability: "chat", request: `طلب يُلغى ${round}` } });
    if (run?.id) await call(`/local-api/company/runs/${run.id}/cancel`, { method: "POST", body: {} });
  })());
  // 5. clients that disconnect mid-request
  for (const path of ["/local-api/company/summary", "/local-api/workspace?refresh=1", "/local-api/infra", "/"]) jobs.push(call(path, { abortAfter: 2 }));
  if (round % 3 === 0) jobs.push(call("/local-api/company/backup", { method: "POST", body: {} }));
  await Promise.all(jobs);
  memSamples.push(await memory());
  assert.equal(exited, null, `bridge exited in round ${round}: ${childErr}`);
}

// Recovery: after the router returns, the cached offline state expires and the overview reconnects.
await new Promise((r) => setTimeout(r, 3500));
const recovered = await call("/local-api/omniroute/overview?refresh=1");
const health = await call("/local-api/health");
const runs = (await call("/local-api/company/runs?limit=200")).runs;
child.kill();
await new Promise((r) => (exited !== null ? r() : child.once("exit", r)));
setRouter(false); proxy.close(); await stub.close();

const db = new DatabaseSync(dbPath, { readOnly: true });
const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
const fk = db.prepare("PRAGMA foreign_key_check").all().length;
const stuck = db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status IN ('queued','running')").get().n;
db.close();

const summary = { rounds: ROUNDS, seconds: Math.round((Date.now() - started) / 1000), requests: stats.requests, byStatus: stats.byStatus, abortedByClient: stats.aborted,
  serverErrors: stats.errors.length, runs: runs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {}), memoryMb: memSamples, ...(heapAfterGc.length ? { heapAfterGcMb: heapAfterGc } : {}), recoveredRouter: recovered?.connection?.state, integrity, fk, stuckRuns: stuck };
console.log(JSON.stringify(summary, null, 1));
assert.deepEqual(stats.errors, [], "no 5xx responses or transport failures");
assert.equal(health?.status, "ok");
assert.equal(recovered?.connection?.state, "connected", "router recovery is noticed");
assert.equal(integrity, "ok");
assert.equal(fk, 0);
assert.ok(runs.some((r) => r.status === "succeeded"), "runs succeed while the router is up");
assert.ok(runs.some((r) => r.status === "failed" || r.status === "blocked"), "runs fail honestly while the router is down");
assert.ok(Math.max(...memSamples) - memSamples[1] < 120, `memory stays bounded: ${memSamples.join(", ")} MB`);
console.log("PASS stress: same bridge process stayed healthy through load, aborted clients, router outage and recovery");
