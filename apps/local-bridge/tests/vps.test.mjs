/* VPS Operations Center: SSH transport hardening, probe parsing, redaction, monitoring/incident lifecycle, agent tool
 * permissions and the owner-approved action workflow. Synthetic fixtures only; no network and no real server. */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.mjs";
import { createCompany } from "../src/company.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { createVps } from "../src/vps.mjs";
import { classifySshFailure, createSshTransport, serverFingerprint, sshArgs } from "../src/vps-ssh.mjs";
import * as P from "../src/vps-probes.mjs";
import { createStartup, STARTUP_ACTIONS } from "../src/startup.mjs";

const FP = "SHA256:TESTfingerprintNOTaREALhostKEY0123456789abc";
const IDENTITY = "C:/Users/TEST/.ssh/id_test_SHOULD_NOT_LEAK";
const PROFILE = {
  environments: { production: { base: "/var/www/app", url: "https://app.example.test", healthPath: "/api/health", expected: "active" },
    staging: { base: "/var/www/app-staging", url: "https://staging.example.test", healthPath: "/api/health", expected: "retired" } },
  pm2: [{ user: "app", services: [{ name: "app-api", environment: "production" }, { name: "app-web", environment: "production" }, { name: "app-staging-api", environment: "staging" }] }],
  systemd: ["nginx", "postgresql"], databases: ["app"]
};

const basicOutput = ({ hostname = "vm-test", api = "online", apiStart = 1_700_000_000_000, apiRestarts = 2, disk = 43, nginx = "active" } = {}) => [
  "@@hostname", hostname, "@@machine", "0cc345d9cbd3c129", "@@os", "Ubuntu 24.04.5 LTS", "6.8.0-1-generic", "@@uptime", "606139.36 2378360.64",
  "@@load", "0.25 0.12 0.03 1/343 286348", "4", "@@cpu", "cpu  100 0 100 800 0 0 0 0 0 0", "cpu  110 0 110 880 0 0 0 0 0 0",
  "@@mem", "MemTotal:        8131776 kB", "MemAvailable:    6200508 kB", "SwapTotal:       2097148 kB", "SwapFree:        1955836 kB",
  "@@df", `/dev/sda1      100000000000 ${disk}000000000 ${100 - disk}000000000      ${disk}% /`, "/dev/sda16        923156480   122281984   736231424      15% /boot",
  "@@systemd", `nginx ${nginx}`, "postgresql active", "@@failed", "systemd-networkd-wait-online.service",
  "@@pm2:app", `app-api\t${api}\t${apiRestarts}\t0\t${apiStart}\t166424576\t0.4\tfork_mode`, "app-web\tonline\t6\t0\t1700000000100\t478588928\t0.5\tfork_mode"
].join("\n");
const inventoryOutput = [
  "@@deploy:production", "/var/www/app/releases/20261024-190715", "74332a9713cb00e43047efa076e536615d3f6880", "feat/x", "2026-10-24T17:06:52Z", "20261021-174958", "20261024-190135", "20261024-190715",
  "@@deploy:staging", "/var/www/app-staging/releases/20261013-003349", "722f384eb44899f6f6776cf422658fb556c2acfe", "codex/v2", "2026-10-12T22:32:34Z", "20261012-210259", "20261013-003349",
  "@@pg", "accepting", "16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)", "12", "db app 12008471", "@@nginx", "nginx version: nginx/1.24.0 (Ubuntu)", "2026-10-24T04:43:11Z", "@@boots", "2026-10-18T13:28:15Z"
].join("\n");

/** Scriptable fake transport: records every script and answers by section markers. */
function fakeTransport() {
  const t = { scripts: [], fail: null, api: "online", apiStart: 1_700_000_000_000, apiRestarts: 2, disk: 43, hostname: "vm-test", restartOk: true, nginx: "active" };
  t.exec = async (host, script) => {
    t.scripts.push(script);
    if (t.fail) return { ok: false, category: t.fail, ms: 5 };
    if (script.includes("pm2 restart")) {
      if (t.restartOk) { t.api = "online"; t.apiStart += 60_000; t.apiRestarts += 1; }
      return { ok: true, code: 0, stdout: `@@exit\n${t.restartOk ? 0 : 1}\n`, ms: 20, fingerprint: FP };
    }
    if (script.includes("@@hostname")) return { ok: true, code: 0, stdout: basicOutput(t), ms: 30, fingerprint: FP };
    if (script.includes("@@deploy:")) return { ok: true, code: 0, stdout: inventoryOutput, ms: 30, fingerprint: FP };
    return { ok: true, code: 0, stdout: "nginx: configuration file /etc/nginx/nginx.conf test is successful\ncontact admin@example.com token=abc123secret from 10.1.2.3\n", ms: 10, fingerprint: FP };
  };
  return t;
}
const siteChecker = async (url) => (url.includes("staging") ? { url, health: { status: 410, ms: 50, body: null }, root: { status: 410, ms: 40 }, checkedAt: new Date().toISOString() }
  : { url, health: { status: 200, ms: 80, body: { status: "ok", database: "connected", commit: "74332a9713cb00e43047efa076e536615d3f6880" } }, root: { status: 200, ms: 90 }, checkedAt: new Date().toISOString() });
const certChecker = async (hostname) => ({ hostname, ok: true, daysLeft: 60, validTo: "2030-01-01T00:00:00.000Z" });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "abud-vps-"));
  const configPath = join(dir, "vps.json");
  writeFileSync(configPath, JSON.stringify({ hosts: [{ id: "app", name: "App VPS", provider: "Test", address: "203.0.113.10", port: 22, sshUser: "root", hostKeyFingerprint: FP, expectedHostname: "vm-test", project: "owner/Alpha", identityFile: IDENTITY, profile: PROFILE }] }));
  const company = createCompany({ db: openDatabase(":memory:") });
  company.seed();
  company.syncProjects({ catalog: [{ name: "Alpha" }], owner: "owner", repos: [] });
  const transport = fakeTransport();
  const vps = createVps({ company, configPath, transport, siteChecker, certChecker });
  await vps.reload();
  const runtime = createRuntime({ company, routerClient: { config: {} }, getOverview: async () => ({ connection: { state: "offline" } }), getUsage: async () => null, workspace: { scan: async () => ({ repos: [] }), paths: () => new Map() }, vps });
  return { company, vps, transport, runtime, close: () => { runtime.stop(); vps.stop(); } };
}

// ---------------------------------------------------------------- transport
test("ssh arguments pin identity and host key, disable forwarding and run only a fixed remote command", () => {
  const args = sshArgs({ host: { address: "203.0.113.10", port: 22, sshUser: "root" }, identityFile: IDENTITY, knownHostsFile: "C:/kh" });
  const joined = args.join(" ");
  for (const opt of ["-F none", "IdentitiesOnly=yes", "BatchMode=yes", "StrictHostKeyChecking=yes", "UserKnownHostsFile=C:/kh", "GlobalKnownHostsFile=none", "UpdateHostKeys=no", "ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes", "RequestTTY=no", "PasswordAuthentication=no"]) assert.ok(joined.includes(opt), opt);
  assert.equal(args.at(-1), "/bin/bash --noprofile --norc -s", "the remote command is fixed; scripts go over stdin");
  assert.ok(!joined.includes("StrictHostKeyChecking=no") && !joined.includes("accept-new"));
  assert.throws(() => sshArgs({ host: { address: "203.0.113.10; rm -rf /", port: 22, sshUser: "root" }, identityFile: IDENTITY, knownHostsFile: "x" }), /invalid-address/);
  assert.throws(() => sshArgs({ host: { address: "203.0.113.10", port: 22, sshUser: "root -oProxyCommand=x" }, identityFile: IDENTITY, knownHostsFile: "x" }), /invalid-ssh-user/);
});

test("ssh failures are classified; a changed or unpinned host key fails closed", async () => {
  assert.equal(classifySshFailure("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@", 255), "host-key-changed");
  assert.equal(classifySshFailure("No ED25519 host key is known for x and you have requested strict checking.\nHost key verification failed.", 255), "host-key-unknown");
  assert.equal(classifySshFailure("root@x: Permission denied (publickey).", 255), "auth-failed");
  assert.equal(classifySshFailure("ssh: connect to host x port 22: Connection timed out", 255), "connect-timeout");
  assert.equal(classifySshFailure("ssh: Could not resolve hostname x", 255), "unreachable");
  assert.equal(serverFingerprint(`debug1: Server host key: ssh-ed25519 ${FP}`), FP);
  const spawnWith = (stderr, code, stdout = "ok\n") => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = Object.assign(new EventEmitter(), { end() { setImmediate(() => { child.stderr.emit("data", Buffer.from(stderr)); child.stdout.emit("data", Buffer.from(stdout)); child.emit("close", code); }); } });
    child.kill = () => {};
    return child;
  };
  const host = { id: "h", address: "203.0.113.10", port: 22, sshUser: "root", hostKeyFingerprint: FP };
  const ok = await createSshTransport({ identityFor: () => IDENTITY, knownHostsFile: "kh", spawnImpl: spawnWith(`debug1: Server host key: ssh-ed25519 ${FP}\n`, 0) }).exec(host, "echo ok\n");
  assert.equal(ok.ok, true); assert.equal(ok.stdout, "ok\n");
  const swapped = await createSshTransport({ identityFor: () => IDENTITY, knownHostsFile: "kh", spawnImpl: spawnWith("debug1: Server host key: ssh-ed25519 SHA256:OTHERKEYOTHERKEYOTHERKEYOTHERKEYOTHERKEY123\n", 0) }).exec(host, "echo ok\n");
  assert.deepEqual([swapped.ok, swapped.category], [false, "host-key-mismatch"], "a key accepted by known_hosts but different from the pinned one is refused");
  const unknown = await createSshTransport({ identityFor: () => IDENTITY, knownHostsFile: "kh", spawnImpl: spawnWith("Host key verification failed.\n", 255, "") }).exec(host, "x");
  assert.equal(unknown.category, "host-key-unknown");
  const none = await createSshTransport({ identityFor: () => null, knownHostsFile: "kh", spawnImpl: spawnWith("", 0) }).exec(host, "x");
  assert.equal(none.category, "not-configured");
  const big = await createSshTransport({ identityFor: () => IDENTITY, knownHostsFile: "kh", spawnImpl: spawnWith(`debug1: Server host key: ssh-ed25519 ${FP}\n`, 0, "x".repeat(2000)) }).exec(host, "x", { maxBytes: 100 });
  assert.equal(big.category, "output-too-large");
  const hang = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = Object.assign(new EventEmitter(), { end() {} }); c.kill = () => {}; return c; };
  const slow = await createSshTransport({ identityFor: () => IDENTITY, knownHostsFile: "kh", spawnImpl: hang }).exec(host, "x", { timeoutMs: 50 });
  assert.equal(slow.category, "command-timeout");
});

// ---------------------------------------------------------------- probes and redaction
test("profiles reject anything that could inject into a probe script; parsers read real output shapes", () => {
  assert.throws(() => P.normalizeProfile({ pm2: [{ user: "app", services: [{ name: "api; rm -rf /" }] }] }), /invalid-profile-service/);
  assert.throws(() => P.normalizeProfile({ pm2: [{ user: "root$(id)", services: [] }] }), /invalid-profile-user/);
  assert.throws(() => P.normalizeProfile({ environments: { production: { base: "/etc" } } }), /invalid-profile-base/);
  assert.throws(() => P.normalizeProfile({ environments: { production: { url: "http://x.test" } } }), /invalid-profile-url/);
  const profile = P.normalizeProfile(PROFILE);
  const script = P.basicScript(profile);
  assert.ok(script.includes("TZ=UTC") && script.includes("pm2 jlist") && script.includes("python3"), "pm2 output is filtered on the server so env values never leave it");
  const basic = P.parseBasic(basicOutput());
  assert.equal(basic.hostname, "vm-test");
  assert.equal(basic.cpu.pct, 20, "user+system deltas 20 of 100 jiffies");
  assert.equal(basic.memory.usedPct, 23.7);
  assert.equal(basic.disk.usedPct, 43);
  assert.deepEqual(basic.systemd, { nginx: "active", postgresql: "active" });
  assert.equal(basic.pm2.app.processes[0].status, "online");
  const inv = P.parseInventory(inventoryOutput);
  assert.equal(inv.deployments.production.commitSha, "74332a9713cb00e43047efa076e536615d3f6880");
  assert.equal(inv.deployments.production.rollbackCandidate, "20261024-190135");
  assert.equal(inv.postgres.accepting, true);
  assert.equal(inv.nginx.activeSince, "2026-10-24T04:43:11Z");
  assert.throws(() => P.diagnosticScript(profile, "rm -rf /"), /unknown-diagnostic/);
  assert.throws(() => P.logScript(profile, "/etc/shadow"), /unknown-log-source/);
});

test("remote text is redacted: credentials, tokens, emails, IPs and query strings; timestamps survive", () => {
  const raw = [
    "2026-10-25T13:51:18Z error: login failed for owner@example.com from 197.45.1.2 password=hunter2 token: abc",
    "GET /api/auth?code=XYZ&state=1 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    "cookie: session=s3cr3t; DATABASE_URL=postgres://user:pa55@localhost/db read /var/www/app/shared/storage/contracts/x.pdf phone 201001234567"
  ].join("\n");
  const out = P.redactRemote(raw).lines.join("\n");
  for (const leak of ["owner@example.com", "197.45.1.2", "hunter2", "XYZ", "eyJhbGci", "s3cr3t", "pa55", "contracts/x.pdf", "201001234567"]) assert.ok(!out.includes(leak), `leaked ${leak}`);
  assert.ok(out.includes("2026-10-25T13:51:18Z"), "log timestamps are kept");
  assert.equal(P.redactRemote(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), { maxLines: 5 }).shown, 5);
});

test("public checks: staging 410 is 'retired' and 401 'protected', never an outage", () => {
  assert.equal(P.classifySite("retired", 410), "retired");
  assert.equal(P.classifySite("active", 401), "protected");
  assert.equal(P.classifySite("active", 200, { status: "ok", database: "connected" }), "ok");
  assert.equal(P.classifySite("active", 200, { status: "ok", database: "disconnected" }), "degraded");
  assert.equal(P.classifySite("active", 503), "down");
  assert.equal(P.classifySite("active", null), "unreachable");
});

// ---------------------------------------------------------------- monitoring lifecycle
test("monitoring: live state, metrics and services; retired staging is not an incident; deployments link to the project", async () => {
  const env = await setup();
  try {
    const result = await env.vps.probe("app");
    assert.equal(result.basic.ok, true);
    const o = env.vps.overview("app");
    assert.equal(o.connection.state, "connected");
    assert.equal(o.projectId, "gh:owner/alpha", "the host links to the existing project, no duplicate is created");
    assert.equal(env.company.listProjects().length, 1);
    const byName = Object.fromEntries(o.services.map((s) => [s.service, s.state]));
    assert.deepEqual(byName, { nginx: "running", postgresql: "running", "app-api": "running", "app-web": "running", "app-staging-api": "retired" });
    assert.equal(o.sites.staging.state, "retired");
    assert.equal(o.deployment.environments.production.provenanceMatch, true);
    assert.equal(env.vps.openIncidents().length, 0);
    assert.equal(env.vps.metrics("app", "1h").samples >= 1, true);
    const json = JSON.stringify([o, env.vps.status(), env.vps.tools.listHosts()]);
    assert.ok(!json.includes(IDENTITY) && !json.includes("SHOULD_NOT_LEAK"), "the SSH identity path never leaves the bridge");
  } finally { env.close(); }
});

test("an SSH outage never marks services stopped; the incident opens after debounce, is deduplicated, and recovers", async () => {
  const env = await setup();
  try {
    await env.vps.probe("app", "basic");
    env.transport.fail = "connect-timeout";
    for (let i = 0; i < 2; i++) await env.vps.probe("app", "basic");
    assert.equal(env.vps.openIncidents().length, 0, "two failures stay below the debounce threshold");
    assert.ok(env.vps.services("app").every((s) => s.state !== "stopped" && s.stale), "last verified states are kept and flagged stale");
    for (let i = 0; i < 3; i++) await env.vps.probe("app", "basic");
    const open = env.vps.openIncidents();
    assert.equal(open.length, 1, "one incident for one condition");
    assert.equal(open[0].key, "unreachable");
    assert.equal(env.company.notifications().filter((n) => n.kind === "vps").length, 1);
    assert.equal(env.company.listTasks({ includeClosed: false }).filter((t) => t.tags.includes("vps")).length, 1, "one owner task, not one per failed check");
    env.transport.fail = null;
    await env.vps.probe("app", "basic");
    assert.equal(env.vps.openIncidents().length, 0, "recovered");
    assert.equal(env.company.notifications().filter((n) => n.kind === "vps").length, 0, "notification resolved");
    assert.ok(env.company.activity({ targetType: "vps", targetId: "app" }).some((e) => e.action === "vps.incident.recovered"));
  } finally { env.close(); }
});

test("a stopped production service opens one critical incident and task; repeated checks do not duplicate it", async () => {
  const env = await setup();
  try {
    await env.vps.probe("app", "basic");
    env.transport.api = "stopped";
    for (let i = 0; i < 4; i++) await env.vps.probe("app", "basic");
    const open = env.vps.openIncidents();
    assert.equal(open.length, 1);
    assert.equal(open[0].service, "app-api");
    assert.equal(open[0].severity, "critical");
    assert.equal(open[0].assignedAgent, "ori");
    assert.equal(env.company.listTasks({ includeClosed: false }).filter((t) => t.tags.includes("vps")).length, 1);
    env.transport.hostname = "imposter";
    await env.vps.probe("app", "basic");
    assert.ok(env.vps.openIncidents().some((i) => i.key === "identity" && i.severity === "critical" && i.assignedAgent === "rex"), "a host answering with another identity is a security incident");
  } finally { env.close(); }
});

// ---------------------------------------------------------------- agent tools
test("agent VPS tools: read-only for all six, diagnostics by role, arbitrary commands impossible, every call audited", async () => {
  const env = await setup();
  try {
    await env.vps.probe("app");
    for (const agent of ["ori", "mia", "nex", "luna", "zen", "rex"]) {
      const health = await env.runtime.invokeTool(agent, "vps.getHealth", {}, { toolCalls: [] });
      assert.equal(health.host.id, "app");
      assert.ok(!JSON.stringify(health).includes(IDENTITY));
    }
    await assert.rejects(env.runtime.invokeTool("luna", "vps.runSafeDiagnostic", { diagnostic: "failed-units" }, { toolCalls: [] }), (e) => e.code === "tool-forbidden");
    await assert.rejects(env.runtime.invokeTool("mia", "vps.getRedactedLogs", { source: "nginx-error" }, { toolCalls: [] }), (e) => e.code === "tool-forbidden");
    await assert.rejects(env.runtime.invokeTool("rex", "vps.runSafeDiagnostic", { diagnostic: "cat /etc/shadow" }, { toolCalls: [] }), (e) => e.code === "invalid-tool-input");
    await assert.rejects(env.runtime.invokeTool("rex", "vps.runSafeDiagnostic", { diagnostic: "failed-units", command: "rm -rf /" }, { toolCalls: [] }), (e) => e.code === "invalid-tool-input", "unknown fields such as 'command' are refused");
    const diag = await env.runtime.invokeTool("rex", "vps.runSafeDiagnostic", { diagnostic: "nginx-config-test" }, { toolCalls: [] });
    assert.equal(diag.ok, true);
    const text = JSON.stringify(diag.output);
    assert.ok(!text.includes("admin@example.com") && !text.includes("abc123secret") && !text.includes("10.1.2.3"), "diagnostic output is redacted");
    assert.ok(env.company.activity({ targetType: "vps" }).some((e) => e.action === "vps.diagnostic" && e.actor_id === "rex"));
    const sent = env.transport.scripts.at(-1);
    assert.ok(!sent.includes("rm -rf") && !sent.includes("/etc/shadow"), "only the allowlisted script reaches the server");
  } finally { env.close(); }
});

// ---------------------------------------------------------------- controlled actions
test("approved action: agent proposes, only the owner approves the exact target, token is single-use, success needs verification", async () => {
  const env = await setup();
  try {
    await env.vps.probe("app");
    const proposal = await env.runtime.invokeTool("ori", "vps.createActionProposal", { operation: "pm2.restart", service: "app-api", reason: "اختبار إعادة تشغيل خدمة واختبار التحقق" }, { toolCalls: [] });
    assert.equal(proposal.status, "proposed");
    assert.match(proposal.note, /owner approves/);
    const again = await env.runtime.invokeTool("ori", "vps.createActionProposal", { operation: "pm2.restart", service: "app-api", reason: "نفس الاقتراح مرة أخرى للتأكد" }, { toolCalls: [] });
    assert.equal(again.id, proposal.id, "identical pending proposals are deduplicated");
    assert.equal(env.transport.scripts.filter((s) => s.includes("pm2 restart")).length, 0, "a proposal executes nothing");
    assert.throws(() => env.vps.approve(proposal.id, { confirmText: "app-api" }, { type: "agent", id: "ori" }), (e) => e.code === "owner-only", "an agent cannot approve, even its own proposal");
    assert.throws(() => env.vps.approve(proposal.id, { confirmText: "app-web" }, { type: "owner", id: "owner" }), (e) => e.code === "confirmation-mismatch");
    const { token } = env.vps.approve(proposal.id, { confirmText: "app-api" }, { type: "owner", id: "owner" });
    await assert.rejects(env.vps.execute(proposal.id, { token: "f".repeat(64) }, { type: "owner", id: "owner" }), (e) => e.code === "approval-invalid");
    const done = await env.vps.execute(proposal.id, { token }, { type: "owner", id: "owner" });
    assert.equal(done.status, "succeeded", JSON.stringify(done.result));
    assert.equal(done.postState.status, "online");
    assert.ok(done.postState.startedAt > done.preState.startedAt, "restart verified by a newer start time");
    assert.equal(env.transport.scripts.filter((s) => s.includes("pm2 restart app-api")).length, 1);
    await assert.rejects(env.vps.execute(proposal.id, { token }, { type: "owner", id: "owner" }), (e) => e.code === "not-approved", "the approval is consumed");
    assert.ok(["vps.action.proposed", "vps.action.approved", "vps.action.succeeded"].every((a) => env.company.activity({ targetType: "vps" }).some((e) => e.action === a)));

    env.transport.restartOk = false;
    const failing = env.vps.propose({ hostId: "app", operation: "pm2.restart", service: "app-web", reason: "اختبار حالة الفشل بعد التنفيذ" }, { type: "owner", id: "owner" });
    const t2 = env.vps.approve(failing.id, { confirmText: "app-web" }, { type: "owner", id: "owner" }).token;
    const failed = await env.vps.execute(failing.id, { token: t2 }, { type: "owner", id: "owner" });
    assert.equal(failed.status, "failed", "a non-zero exit is never reported as success");
  } finally { env.close(); }
});

test("action safeguards: tier 3 refused, unknown or absent services refused, approvals expire", async () => {
  const env = await setup();
  try {
    await env.vps.probe("app");
    const owner = { type: "owner", id: "owner" };
    assert.throws(() => env.vps.propose({ hostId: "app", operation: "deploy.release", reason: "نشر الإصدار الجديد الآن" }, owner), (e) => e.code === "tier3-not-automatable");
    assert.throws(() => env.vps.propose({ hostId: "app", operation: "pm2.restart", service: "evil;reboot", reason: "محاولة خدمة غير مسجلة" }, owner), (e) => e.code === "unknown-service");
    assert.throws(() => env.vps.propose({ hostId: "app", operation: "pm2.restart", service: "app-staging-api", reason: "الخدمة غير موجودة على الخادم" }, owner), (e) => e.code === "service-not-present");
    assert.throws(() => env.vps.propose({ hostId: "app", operation: "shell.exec", reason: "تنفيذ أمر عشوائي على الخادم" }, owner), (e) => e.code === "unknown-operation");
    const p = env.vps.propose({ hostId: "app", operation: "nginx.reload", reason: "إعادة تحميل الإعداد بعد فحص" }, owner);
    assert.equal(p.review.confirmPhrase, "nginx");
    assert.equal(p.review.risk, "high");
    const { token } = env.vps.approve(p.id, { confirmText: "nginx" }, owner);
    env.company.db.run("UPDATE vps_actions SET approval_expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), p.id);
    await assert.rejects(env.vps.execute(p.id, { token }, owner), (e) => ["approval-expired", "not-approved"].includes(e.code));
    assert.equal(env.vps.getAction(p.id).status, "expired");
  } finally { env.close(); }
});

// ---------------------------------------------------------------- startup controls
test("startup controls accept only allowlisted actions and never return filesystem paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abud-startup-"));
  const calls = [];
  const startup = createStartup({ root: dir, env: { APPDATA: join(dir, "appdata"), SystemRoot: "C:/Windows" }, platform: "win32", spawnImpl: (file, args) => { calls.push([file, ...args]); const c = new EventEmitter(); setImmediate(() => c.emit("exit", 0)); c.kill = () => {}; return c; } });
  await assert.rejects(startup.perform("cmd /c calc"), (e) => e.code === "unknown-action");
  assert.ok(STARTUP_ACTIONS.every((a) => /^[a-z-]+$/.test(a)));
  await startup.perform("company-autostart-on");
  assert.deepEqual(calls[0].slice(-2), ["-Action", "autostart-on"]);
  await startup.perform("browser-at-signin-off");
  assert.equal(startup.status().company.openBrowserAtSignIn, false);
  await assert.rejects(startup.perform("router-start", { routerConnected: true }), (e) => e.code === "router-running", "never a second router");
  startup.observeRouter("offline"); startup.observeRouter("connected");
  const s = startup.status();
  assert.equal(s.omniroute.connection.reconnects, 1);
  assert.ok(!JSON.stringify(s).includes(dir), "no local paths in the status");
});
