import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openDatabase, MIGRATIONS } from "../src/db.mjs";
import { DatabaseSync } from "node:sqlite";
import { createCompany, periodStart } from "../src/company.mjs";
import { AGENTS } from "../src/catalog.mjs";

const fresh = () => { const company = createCompany({ db: openDatabase(":memory:") }); company.seed(); return company; };
const rejects = (fn, code) => assert.throws(fn, (error) => error.code === code, `expected ${code}`);

test("store migrates once, persists across reopen and seeds the six agents, eight policies and company budgets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abud-db-"));
  const path = join(dir, "company.db");
  let db = openDatabase(path);
  let company = createCompany({ db });
  company.seed();
  company.createTask({ title: "مهمة دائمة" });
  assert.equal(db.schemaVersion(), MIGRATIONS.at(-1).version);
  db.close();
  db = openDatabase(path);
  company = createCompany({ db });
  company.seed();
  assert.equal(company.listTasks().length, 1, "task survives reopen");
  assert.equal(db.all("SELECT * FROM agents").length, 6);
  assert.deepEqual(db.all("SELECT id FROM agents ORDER BY id").map((r) => r.id), AGENTS.map((a) => a.id).sort());
  assert.equal(company.listPolicies().length, 8);
  assert.equal(company.listBudgets().length, 2);
  assert.equal(db.all("SELECT * FROM schema_migrations").length, MIGRATIONS.length, "each migration applied exactly once");
  const backup = db.backup(join(dir, "backups"));
  assert.ok(backup.bytes > 0);
  assert.equal(backup.verified, true);
  assert.equal(db.listBackups(join(dir, "backups")).length, 1);
  assert.equal(db.listBackups(join(dir, "backups"))[0].healthy, true);
  const second = db.backup(join(dir, "backups"));
  assert.notEqual(second.file, backup.file, "rapid backups use distinct files");
  assert.equal(db.listBackups(join(dir, "backups")).length, 2);
  company.createTask({ title: "بعد النسخة" });
  const rehearsal = db.verifyRestore(join(dir, "backups"), basename(backup.file));
  assert.equal(rehearsal.ok, true);
  assert.equal(rehearsal.integrity, "ok");
  assert.equal(rehearsal.restoredTo, "temporary-isolated-copy");
  assert.deepEqual(rehearsal.counts.tasks, { backup: 1, live: 2 }, "the copy holds what existed at backup time; live is untouched");
  assert.equal(company.listTasks().length, 2);
  assert.throws(() => db.verifyRestore(join(dir, "backups"), "../company.db"), /backup-name-invalid/);
  assert.throws(() => db.verifyRestore(join(dir, "backups"), "company-2020-01-01T00-00-00-000Z.db"), /backup-not-found/);
  db.close();
});

test("tasks: validation, Arabic errors, secrets rejected, status history and completion timestamps", () => {
  const company = fresh();
  rejects(() => company.createTask({ title: "" }), "validation");
  rejects(() => company.createTask({ title: "x", status: "blocked" }), "validation");
  rejects(() => company.createTask({ title: "api_key = abc123456" }), "secret-rejected");
  rejects(() => company.createTask({ title: "x", projectId: "gh:nope/nope" }), "validation");
  rejects(() => company.createTask({ title: "x", dueDate: "25/10/2026" }), "validation");
  const task = company.createTask({ title: "مراجعة الحصص", priority: "high", assignee: "nex", dueDate: "2026-10-30", tags: ["ai"] });
  assert.equal(task.assignee, "nex");
  const blocked = company.updateTask(task.id, { status: "blocked", blocker: "بانتظار مفتاح قراءة" });
  assert.equal(blocked.status, "blocked");
  const done = company.updateTask(task.id, { status: "done" });
  assert.ok(done.completedAt);
  assert.equal(done.blocker, null, "blocker cleared when unblocked");
  assert.ok(done.events.length >= 3);
  assert.ok(company.activity().some((e) => e.action === "task.completed" && e.target_id === task.id));
  const dedup = company.createTask({ title: "مرة واحدة" }, undefined, { externalRef: "ext:1" });
  assert.equal(company.createTask({ title: "مرة واحدة" }, undefined, { externalRef: "ext:1" }).id, dedup.id);
});

test("archiving preserves the task and audit history, removes it from active views, and allows restoration", () => {
  const company = fresh();
  const task = company.createTask({ title: "مهمة للأرشفة", assignee: "luna" });
  const archived = company.setTaskArchived(task.id, true);
  assert.ok(archived.archivedAt);
  assert.equal(company.listTasks().some((t) => t.id === task.id), false);
  assert.equal(company.listTasks({ archivedOnly: true }).some((t) => t.id === task.id), true);
  rejects(() => company.updateTask(task.id, { title: "تعديل" }), "task-archived");
  assert.ok(company.getTask(task.id).events.some((e) => e.kind === "archived"));
  const restored = company.setTaskArchived(task.id, false);
  assert.equal(restored.archivedAt, null);
  assert.equal(company.listTasks().some((t) => t.id === task.id), true);
  assert.ok(company.activity({ targetType: "task", targetId: task.id }).some((e) => e.action === "task.restored"));
});

test("project sync: catalog + remote identity, duplicates flagged, manual links respected, local-only never auto-created", () => {
  const company = fresh();
  const repos = [
    { rel: "Alpha", state: "ready", remote: { kind: "github", github: "owner/Alpha" } },
    { rel: "Alpha-copy", state: "ready", remote: { kind: "github", github: "Owner/alpha" } },
    { rel: "private-x", state: "ready", remote: { kind: "github", github: "owner/private-x" } },
    { rel: "scratch", state: "ready", remote: { kind: "none" } }
  ];
  const result = company.syncProjects({ catalog: [{ name: "Alpha", summary: "عام" }], owner: "owner", repos });
  assert.equal(result.duplicates.length, 1);
  assert.deepEqual(result.duplicates[0].checkouts.sort(), ["Alpha", "Alpha-copy"]);
  const projects = company.listProjects();
  assert.ok(projects.some((p) => p.id === "gh:owner/alpha" && p.checkouts.length === 2));
  assert.ok(projects.some((p) => p.id === "gh:owner/private-x"));
  assert.ok(!projects.some((p) => p.name === "scratch"), "local-only checkout is not auto-created");
  const manual = company.createProject({ name: "Scratch work" });
  company.linkCheckout("scratch", manual.id);
  company.linkCheckout("Alpha-copy", manual.id);
  company.syncProjects({ catalog: [], owner: "owner", repos });
  const after = company.getProject(manual.id);
  assert.deepEqual(after.checkouts.map((c) => c.rel).sort(), ["Alpha-copy", "scratch"], "manual links survive re-sync");
  rejects(() => company.linkCheckout("../etc", manual.id), "validation");
  const second = company.syncProjects({ catalog: [{ name: "Alpha" }], owner: "owner", repos });
  assert.equal(second.created, 0, "sync is idempotent");
});

test("GitHub-confirmed renames fold duplicate projects into one identity, re-point every reference and stay folded", () => {
  let clock = Date.parse("2026-10-01T10:00:00Z");
  const company = createCompany({ db: openDatabase(":memory:"), now: () => new Date(clock += 1000) });
  company.seed();
  const repos = [
    { rel: "GuestFlow", state: "ready", remote: { kind: "github", github: "old-owner/GuestFlow" } },
    { rel: "portal", state: "ready", remote: { kind: "github", github: "old-owner/portal" } },
    { rel: "Other", state: "ready", remote: { kind: "github", github: "someone/Other" } }
  ];
  company.syncProjects({ catalog: [{ name: "GuestFlow" }], owner: "new-owner", repos });
  assert.ok(company.listProjects().some((p) => p.id === "gh:old-owner/guestflow"), "unresolved remote creates its own project");
  const task = company.createTask({ title: "مهمة على الهوية القديمة", projectId: "gh:old-owner/guestflow" });
  company.updateProject("gh:old-owner/guestflow", { priority: "high", notes: "ملاحظة المالك" });
  company.upsertMemory({ scope: "project", scopeRef: "gh:old-owner/guestflow", title: "ذاكرة", body: "نص" });

  assert.deepEqual(company.identitiesToResolve(["old-owner/GuestFlow", "OLD-OWNER/guestflow", "old-owner/portal", null]), ["old-owner/guestflow", "old-owner/portal"]);
  const merged = company.recordGithubIdentity({ slug: "old-owner/GuestFlow", state: "confirmed", canonical: "new-owner/GuestFlow", repoId: 42 });
  assert.equal(merged.mode, "merged");
  const renamed = company.recordGithubIdentity({ slug: "old-owner/portal", state: "confirmed", canonical: "new-owner/portal", repoId: 43 });
  assert.equal(renamed.mode, "renamed");
  assert.equal(company.recordGithubIdentity({ slug: "someone/Other", state: "confirmed", canonical: "someone/Other", repoId: 44 }), null, "an unchanged identity reconciles nothing");
  assert.equal(company.recordGithubIdentity({ slug: "ghost/x", state: "not-found" }), null);

  const projects = company.listProjects();
  assert.ok(!projects.some((p) => p.id.startsWith("gh:old-owner/")), "no project remains under the superseded identity");
  const guest = company.getProject("gh:new-owner/guestflow");
  assert.deepEqual(guest.checkouts.map((c) => c.rel), ["GuestFlow"]);
  assert.equal(guest.priority, "high", "the owner's later edit on the duplicate is kept");
  assert.equal(guest.notes, "ملاحظة المالك");
  assert.equal(guest.memory.length, 1);
  assert.equal(company.getTask(task.id).projectId, "gh:new-owner/guestflow");
  assert.ok(company.activity({ targetType: "project", targetId: "gh:new-owner/guestflow" }).some((e) => e.action === "project.merged" && e.metadata.repoId === 42));
  assert.equal(company.getProject("gh:new-owner/portal").github, "new-owner/portal");
  assert.equal(company.db.all("PRAGMA foreign_key_check").length, 0);

  const again = company.syncProjects({ catalog: [{ name: "GuestFlow" }], owner: "new-owner", repos });
  assert.equal(again.created, 0, "re-sync maps the old remote to the canonical project instead of recreating the duplicate");
  assert.equal(company.listProjects().length, 3);
  assert.deepEqual(company.identitiesToResolve(["old-owner/GuestFlow", "ghost/x"]), [], "resolutions are cached");
});

test("agents can only be narrowed to their reviewed tools; REX keeps strict/analytical mode", () => {
  const company = fresh();
  rejects(() => company.updateAgent("mia", { tools: ["quota.read"] }), "tool-not-permitted");
  rejects(() => company.updateAgent("rex", { mode: "creative" }), "mode-not-permitted");
  const mia = company.updateAgent("mia", { tools: ["project.read"], mode: "creative", instructions: "ركّزي على الهوية العربية" });
  assert.deepEqual(mia.tools, ["project.read"]);
  rejects(() => company.updateAgent("ori", { modelOverride: "bad model ref!" }), "validation");
});

test("routing policies: restricted class can never be allowed and metered requires paid approval", () => {
  const company = fresh();
  rejects(() => company.updatePolicy("general", { allowClasses: ["restricted"] }), "validation");
  rejects(() => company.updatePolicy("general", { allowClasses: ["free", "metered"], approval: "none" }), "validation");
  const updated = company.updatePolicy("general", { allowClasses: ["free", "metered"], approval: "paid", candidates: ["nvidia/a", "openrouter/b"] });
  assert.deepEqual(updated.candidates, ["nvidia/a", "openrouter/b"]);
  assert.ok(company.activity().some((e) => e.action === "policy.updated"));
});

test("budgets use the company timezone period and hard-stop once application-measured spend reaches the limit", () => {
  const company = fresh();
  const start = periodStart("daily", new Date("2026-10-25T21:30:00Z"), "Africa/Cairo");
  assert.equal(start.toISOString(), "2026-10-25T21:00:00.000Z", "Cairo midnight (UTC+3 in late October) after 21:00Z");
  const weekly = periodStart("weekly", new Date("2026-10-28T10:00:00Z"), "Africa/Cairo");
  assert.equal(new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "short" }).format(weekly), "Sat");
  company.upsertBudget({ scope: "agent", scopeRef: "nex", period: "daily", limitUsd: 0.001, warnPct: 50 });
  assert.equal(company.budgetGate({ agentId: "nex" }).blocking.length, 0);
  company.db.run("INSERT INTO usage_events (at, agent_id, provider, model, prompt_tokens, completion_tokens, cost_usd, cost_basis, source) VALUES (?,?,?,?,?,?,?,?,?)", new Date().toISOString(), "nex", "nvidia", "nvidia/x", 10, 10, 0.002, "router-estimate", "application-measured");
  const gate = company.budgetGate({ agentId: "nex" });
  assert.equal(gate.blocking.length, 1);
  assert.equal(gate.blocking[0].state, "exceeded");
  assert.equal(company.budgetGate({ agentId: "mia" }).blocking.length, 0, "agent budget does not block other agents");
  assert.throws(() => company.upsertBudget({ scope: "company", period: "daily" }), (e) => e.code === "validation");
});

test("hard budgets fail closed for paid inference when an earlier paid run has no router cost or token counts", () => {
  const company = fresh();
  company.db.run("DELETE FROM budgets");
  const insert = (provider, model, cost, prompt = 10, completion = 10) => company.db.run("INSERT INTO usage_events (at, agent_id, provider, model, prompt_tokens, completion_tokens, cost_usd, cost_basis, source) VALUES (?,?,?,?,?,?,?,?,?)",
    new Date().toISOString(), "mia", provider, model, prompt, completion, cost, cost == null ? "unknown" : "router-estimate", "application-measured");
  company.upsertBudget({ scope: "company", period: "daily", limitUsd: 5 });
  insert("gemini", "gemini/flash", null);
  insert("openrouter", "openrouter/x:free", null);
  let [budget] = company.listBudgets();
  assert.equal(budget.state, "ok", "unknown cost on free and free-tier classes does not make a USD budget unverifiable");
  assert.equal(budget.spent.unknownCostEvents, 2);
  insert("openrouter", "openrouter/paid-model", null);
  [budget] = company.listBudgets();
  assert.equal(budget.state, "unverified");
  assert.equal(budget.unverifiedPaidEvents, 1);
  assert.equal(budget.spent.costUsd, 0, "known sum stays the known sum");
  const paidGate = company.budgetGate({ agentId: "mia", paid: true });
  assert.equal(paidGate.blocking.length, 1);
  assert.equal(paidGate.blocking[0].blockReason, "unverified");
  assert.equal(company.budgetGate({ agentId: "mia", paid: false }).blocking.length, 0, "free candidates keep running");
  company.upsertBudget({ scope: "company", period: "daily", limitUsd: 5, hardStop: false });
  assert.equal(company.budgetGate({ agentId: "mia", paid: true }).blocking.length, 0, "a soft budget warns but does not block");

  const tokens = fresh();
  tokens.db.run("DELETE FROM budgets");
  tokens.upsertBudget({ scope: "agent", scopeRef: "mia", period: "daily", tokenLimit: 1000 });
  tokens.db.run("INSERT INTO usage_events (at, agent_id, provider, model, prompt_tokens, completion_tokens, cost_usd, cost_basis, source) VALUES (?,?,?,?,?,?,?,?,?)", new Date().toISOString(), "mia", "moonshot", "moonshot/k2", 0, 0, 0.01, "router-estimate", "application-measured");
  assert.equal(tokens.listBudgets()[0].state, "unverified", "a paid run without token counts cannot be checked against a token limit");
  assert.equal(tokens.budgetGate({ agentId: "mia", paid: true }).blocking[0].blockReason, "unverified");
});

test("usage keeps router-unreported cost as unknown in every aggregate instead of folding it into $0", () => {
  const company = fresh();
  const insert = (agent, cost, basis) => company.db.run("INSERT INTO usage_events (at, agent_id, provider, model, prompt_tokens, completion_tokens, cost_usd, cost_basis, source) VALUES (?,?,?,?,?,?,?,?,?)",
    new Date().toISOString(), agent, "gemini", "gemini/x", 5, 5, cost, basis, "application-measured");
  const since = new Date(Date.now() - 60_000).toISOString();
  assert.deepEqual(company.usageSince(since), { runs: 0, promptTokens: 0, completionTokens: 0, tokens: 0, costUsd: 0, unknownCostEvents: 0 }, "no runs is a true zero");
  insert("ori", null, "unknown"); insert("ori", null, "unknown"); insert("ori", 0, "router-estimate"); insert("nex", 0.01, "router-estimate");
  assert.equal(company.usageSince(since).unknownCostEvents, 2);
  const byAgent = Object.fromEntries(company.usageByAgent(since).map((u) => [u.agentId, u]));
  assert.deepEqual([byAgent.ori.runs, byAgent.ori.unknownCostEvents], [3, 2]);
  assert.equal(byAgent.nex.unknownCostEvents, 0);
  assert.equal(company.usageByModel(since)[0].unknownCostEvents, 2);
});

test("quota observations are provenance-tagged, deduplicated and pruned", () => {
  const company = fresh();
  const overview = {
    generatedAt: new Date().toISOString(), connection: { state: "connected" },
    connections: [{ id: "c-1234567890", provider: "codex", quota: { support: "reported", windows: [{ id: "session", label: "Session", used: 40, total: 100, remaining: 60, remainingPct: 60, resetAt: null, windowSeconds: 18000, state: "ok", unit: "percent-of-allowance" }] } }]
  };
  assert.equal(company.recordQuota(overview).stored, 1);
  assert.equal(company.recordQuota(overview).stored, 0, "unchanged value within an hour is not stored again");
  overview.connections[0].quota.windows[0].remainingPct = 10; overview.connections[0].quota.windows[0].used = 90;
  assert.equal(company.recordQuota(overview).stored, 1);
  const history = company.quotaHistory({ sinceIso: new Date(Date.now() - 3_600_000).toISOString() });
  assert.equal(history.series[0].points.length, 2);
  assert.equal(company.db.get("SELECT source_kind FROM quota_observations LIMIT 1").source_kind, "provider-reported");
  company.db.run("UPDATE quota_observations SET observed_at = ?", new Date(Date.now() - 40 * 86_400_000).toISOString());
  assert.equal(company.pruneQuota(30), 2);
});

test("notifications deduplicate and resolve; browser migration is idempotent and never imports unknown projects", () => {
  const company = fresh();
  const a = company.raise({ key: "k1", level: "warning", kind: "quota", title: "x" });
  assert.equal(company.raise({ key: "k1", level: "critical", kind: "quota", title: "y" }), a);
  assert.equal(company.notifications()[0].count, 2);
  company.resolveStale("quota", new Set());
  assert.equal(company.notifications().length, 0);
  company.syncProjects({ catalog: [{ name: "Video_Factory" }], owner: "abudoxali", repos: [] });
  const payload = {
    catalogOwner: "abudoxali",
    workboard: { version: 1, focus: [], projects: { Video_Factory: { stage: "progress", tasks: [{ id: "t1", title: "أول مهمة", done: false }, { id: "t2", title: "منجزة", done: true }] } } },
    projectBoard: { custom: { Video_Factory: { note: "ملاحظة من اللوحة" } } },
    links: { "missing-folder": "NotInCatalog" }
  };
  const first = company.importBrowser(payload);
  assert.equal(first.tasks, 2);
  assert.equal(first.notes, 1);
  const again = company.importBrowser(payload);
  assert.equal(again.tasks, 0);
  assert.equal(again.deduplicated, 3);
  assert.equal(company.listTasks().length, 2);
  assert.equal(company.listTasks().find((t) => t.title === "منجزة").status, "done");
  assert.match(company.getProject("gh:abudoxali/video_factory").notes, /ملاحظة من اللوحة/);
});

test("additive migrations upgrade an existing v1 store without touching its data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abud-v1-"));
  const path = join(dir, "company.db");
  // Build a genuine v1 store (only the first migration applied), with data in it.
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  raw.exec(MIGRATIONS[0].sql);
  raw.prepare("INSERT INTO schema_migrations VALUES (1, 'company-core', '2026-01-01T00:00:00Z')").run();
  raw.prepare("INSERT INTO projects (id, name, github, status, priority, source, created_at, updated_at) VALUES ('gh:a/b','B','a/b','active','high','manual','x','x')").run();
  raw.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1','باقية','x','x')").run();
  raw.close();
  const db = openDatabase(path);
  assert.equal(db.schemaVersion(), MIGRATIONS.at(-1).version);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM github_identities").n, 0);
  assert.equal(db.get("SELECT title FROM tasks WHERE id = 't1'").title, "باقية");
  assert.equal(db.get("SELECT archived_at FROM tasks WHERE id = 't1'").archived_at, null);
  assert.equal(db.get("SELECT focus FROM projects WHERE id = 'gh:a/b'").focus, 0, "existing projects default to not-focused");
  db.close();
  const again = openDatabase(path);
  assert.equal(again.all("SELECT * FROM schema_migrations").length, MIGRATIONS.length, "migrations are applied exactly once");
  again.close();
});

test("focus projects are capped at three and validated", () => {
  const company = fresh();
  const ids = ["a/one", "a/two", "a/three", "a/four"].map((github) => company.createProject({ name: github, github }).id);
  for (const id of ids.slice(0, 3)) assert.equal(company.updateProject(id, { focus: true }).focus, true);
  rejects(() => company.updateProject(ids[3], { focus: true }), "focus-limit");
  rejects(() => company.updateProject(ids[3], { focus: "yes" }), "validation");
  assert.equal(company.updateProject(ids[0], { focus: false }).focus, false);
  assert.equal(company.updateProject(ids[3], { focus: true }).focus, true);
  assert.equal(company.listProjects()[0].focus, true, "focus projects sort first");
});

test("browser migration carries legacy focus projects and the execution journal exactly once", () => {
  const company = fresh();
  company.createProject({ name: "video_factory", github: "abudoxali/video_factory" });
  const workboard = { version: 1, focus: ["video_factory", "missing_repo"], projects: {}, events: [
    { id: "e1", project: "video_factory", kind: "note", detail: "قرار: نؤجل الإطلاق", at: "2026-10-01T10:00:00.000Z" },
    { id: "e2", project: "video_factory", kind: "task_done", detail: "أنهيت السكربت", at: "2026-10-02T10:00:00.000Z" },
    { id: "bad", project: "video_factory", kind: "unknown", detail: "x", at: "2026-10-02T10:00:00.000Z" }
  ] };
  const first = company.importBrowser({ workboard, catalogOwner: "abudoxali" });
  assert.equal(first.focus, 1);
  assert.equal(first.journal, 2);
  assert.equal(company.getProject("gh:abudoxali/video_factory").focus, true);
  const journal = company.activity({ limit: 50 }).filter((e) => e.action.startsWith("journal."));
  assert.equal(journal.length, 2);
  assert.ok(journal.some((e) => e.at === "2026-10-01T10:00:00.000Z" && /نؤجل الإطلاق/.test(e.summary)), "original timestamp and text are preserved");
  const before = company.activity({ limit: 200 }).length;
  const again = company.importBrowser({ workboard, catalogOwner: "abudoxali" });
  assert.equal(again.focus + again.journal + again.tasks, 0, "a second run imports nothing");
  assert.equal(company.activity({ limit: 200 }).length, before, "an empty re-run does not even add an audit event");
});

test("FTS5 memory retrieval enforces project and agent scope, owner review, and deletion", () => {
  const company = fresh();
  const one = company.createProject({ name: "Alpha", github: "owner/alpha" });
  const two = company.createProject({ name: "Beta", github: "owner/beta" });
  const approved = company.upsertMemory({ scope: "project", scopeRef: one.id, title: "قرار الإطلاق", body: "تأجيل إصدار ألفا حتى اختبار الأجهزة", sourceRef: "owner-decision-1", confidence: "verified" })[0];
  company.upsertMemory({ scope: "project", scopeRef: two.id, title: "قرار الإطلاق", body: "تأجيل إصدار بيتا لمراجعة الأداء" });
  company.upsertMemory({ scope: "agent", scopeRef: "ori", title: "تفضيل تخطيط", body: "قرار ترتيب الأولويات لوكيل ORI" });
  const scoped = company.searchMemory({ q: "تأجيل إصدار", agentId: "ori", projectId: one.id });
  assert.deepEqual(scoped.map((m) => m.id), [approved.id]);
  assert.equal(scoped[0].sourceRef, "owner-decision-1");
  assert.equal(company.searchMemory({ q: "ترتيب الأولويات", agentId: "rex", projectId: one.id }).length, 0, "agent memory stays private to its scope");
  const proposed = company.upsertMemory({ scope: "project", scopeRef: one.id, title: "حقيقة مقترحة", body: "معلومة غير مؤكدة عن المشروع" }, { type: "agent", id: "zen" })[0];
  assert.equal(proposed.approved, false);
  assert.equal(company.searchMemory({ q: "معلومة غير مؤكدة", agentId: "ori", projectId: one.id }).length, 0);
  company.upsertMemory({ id: proposed.id, scope: "project", scopeRef: one.id, title: proposed.title, body: proposed.body, approved: true, confidence: "supported" });
  assert.equal(company.searchMemory({ q: "معلومة غير مؤكدة", agentId: "ori", projectId: one.id }).length, 1);
  company.deleteMemory(approved.id);
  assert.equal(company.searchMemory({ q: "تأجيل إصدار ألفا", agentId: "ori", projectId: one.id }).length, 0, "deleted terms disappear from FTS");
  company.reindexMemory();
  assert.equal(company.searchMemory({ q: "تأجيل إصدار ألفا", agentId: "ori", projectId: one.id }).length, 0, "rebuild cannot restore deleted memory");
  assert.equal(company.db.raw.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});
