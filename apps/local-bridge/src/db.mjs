/* Durable company store: one local SQLite file (node:sqlite, no dependencies) owned by the Local Bridge.
 * It is the single system of record for company projects, tasks, agents, runs, budgets, routing policies, quota
 * observations, activity, notifications and approvals. Browser localStorage is only a migration source. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

// node:sqlite prints an ExperimentalWarning on first import; it is expected and not actionable here.
const originalEmit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning?.message ?? warning).includes("SQLite is an experimental feature")) return;
  return originalEmit.call(process, warning, ...rest);
};
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = originalEmit;

export const MIGRATIONS = [
  {
    version: 1,
    name: "company-core",
    sql: `
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        github TEXT UNIQUE,
        catalog_name TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','planned','paused','blocked','shipped','archived')),
        priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
        summary TEXT, notes TEXT, blocker TEXT,
        source TEXT NOT NULL CHECK (source IN ('catalog','workspace','manual','import')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE project_checkouts (
        rel TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        link TEXT NOT NULL CHECK (link IN ('remote','manual')),
        observed_at TEXT NOT NULL
      );
      CREATE INDEX project_checkouts_project ON project_checkouts(project_id);
      CREATE TABLE milestones (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL, due_date TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );

      CREATE TABLE agents (
        id TEXT PRIMARY KEY CHECK (id IN ('ori','mia','nex','luna','zen','rex')),
        enabled INTEGER NOT NULL DEFAULT 1,
        mode TEXT NOT NULL CHECK (mode IN ('standard','creative','analytical','research','strict','execution')),
        instructions TEXT NOT NULL DEFAULT '',
        policy_domain TEXT NOT NULL,
        model_override TEXT,
        tools TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_projects (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        PRIMARY KEY (agent_id, project_id)
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        assignee TEXT NOT NULL DEFAULT 'owner' CHECK (assignee IN ('owner','none','ori','mia','nex','luna','zen','rex')),
        priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('backlog','todo','in_progress','blocked','review','done','cancelled')),
        due_date TEXT, start_date TEXT, estimate_hours REAL CHECK (estimate_hours IS NULL OR estimate_hours >= 0),
        tags TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]', blocker TEXT,
        source TEXT NOT NULL DEFAULT 'owner', external_ref TEXT UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX tasks_status ON tasks(status);
      CREATE INDEX tasks_project ON tasks(project_id);
      CREATE INDEX tasks_assignee ON tasks(assignee);
      CREATE INDEX tasks_due ON tasks(due_date);
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX task_events_task ON task_events(task_id, at);

      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        workflow_id TEXT, parent_run_id TEXT,
        capability TEXT NOT NULL, domain TEXT NOT NULL, mode TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('high','medium','low')),
        request TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','blocked','cancelled')),
        requested_model TEXT, effective_model TEXT, provider TEXT, connection_id TEXT,
        routing TEXT,
        prompt_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER,
        cost_usd REAL, cost_basis TEXT,
        latency_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        error_category TEXT, error_message TEXT,
        output TEXT, tool_calls TEXT NOT NULL DEFAULT '[]',
        approval_id TEXT, idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE INDEX agent_runs_agent ON agent_runs(agent_id, created_at);
      CREATE INDEX agent_runs_status ON agent_runs(status);
      CREATE INDEX agent_runs_workflow ON agent_runs(workflow_id);

      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        agent_id TEXT, project_id TEXT, provider TEXT, model TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL, cost_basis TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('application-measured','router-reported','manual'))
      );
      CREATE INDEX usage_events_at ON usage_events(at);

      CREATE TABLE quota_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observed_at TEXT NOT NULL,
        provider TEXT NOT NULL, connection_id TEXT NOT NULL, window_id TEXT NOT NULL, label TEXT,
        model_group TEXT, used REAL, total REAL, remaining REAL, remaining_pct REAL,
        reset_at TEXT, window_seconds INTEGER, state TEXT NOT NULL, unit TEXT,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('provider-reported','router-observed','application-measured','manual','estimated')),
        collection_method TEXT NOT NULL, confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low'))
      );
      CREATE INDEX quota_obs_window ON quota_observations(connection_id, window_id, observed_at);
      CREATE INDEX quota_obs_at ON quota_observations(observed_at);

      CREATE TABLE routing_policies (
        domain TEXT PRIMARY KEY,
        candidates TEXT NOT NULL,
        allow_classes TEXT NOT NULL,
        max_cost_usd REAL,
        max_retries INTEGER NOT NULL CHECK (max_retries BETWEEN 0 AND 3),
        quota_protect_pct REAL NOT NULL CHECK (quota_protect_pct BETWEEN 0 AND 100),
        approval TEXT NOT NULL CHECK (approval IN ('none','paid','always')),
        max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 64 AND 16000),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE budgets (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('company','agent','project','provider')),
        scope_ref TEXT NOT NULL DEFAULT '',
        period TEXT NOT NULL CHECK (period IN ('daily','weekly','monthly')),
        limit_usd REAL CHECK (limit_usd IS NULL OR limit_usd >= 0),
        token_limit INTEGER CHECK (token_limit IS NULL OR token_limit >= 0),
        warn_pct REAL NOT NULL DEFAULT 80 CHECK (warn_pct BETWEEN 1 AND 100),
        hard_stop INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        UNIQUE (scope, scope_ref, period)
      );

      CREATE TABLE activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('owner','agent','system')),
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT, target_id TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','blocked','pending','info')),
        summary TEXT NOT NULL,
        metadata TEXT, evidence TEXT
      );
      CREATE INDEX activity_at ON activity_events(at);
      CREATE INDEX activity_target ON activity_events(target_type, target_id);

      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('critical','warning','info')),
        kind TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT,
        target_type TEXT, target_id TEXT,
        created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
        acknowledged_at TEXT, resolved_at TEXT
      );
      CREATE UNIQUE INDEX notifications_open ON notifications(dedupe_key) WHERE resolved_at IS NULL;

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','applied','failed','rolled_back')),
        requested_by TEXT NOT NULL,
        title TEXT NOT NULL, summary TEXT,
        payload TEXT NOT NULL, before_state TEXT, after_state TEXT, risk TEXT,
        created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, applied_at TEXT, result TEXT
      );
      CREATE INDEX approvals_status ON approvals(status);

      CREATE TABLE memory_notes (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('company','project','agent')),
        scope_ref TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL, body TEXT NOT NULL,
        source TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX memory_scope ON memory_notes(scope, scope_ref);
    `
  },
  {
    // V2: additive only. `focus` carries the legacy Workboard's "focus projects" idea into the company store; the import
    // ledger makes every browser-data migration step idempotent (a ref is imported at most once).
    version: 2,
    name: "v2-focus-and-import-ledger",
    sql: `
      ALTER TABLE projects ADD COLUMN focus INTEGER NOT NULL DEFAULT 0 CHECK (focus IN (0, 1));
      CREATE TABLE import_ledger (ref TEXT PRIMARY KEY, kind TEXT NOT NULL, imported_at TEXT NOT NULL);
    `
  },
  {
    version: 3,
    name: "task-archive",
    sql: `
      ALTER TABLE tasks ADD COLUMN archived_at TEXT;
      CREATE INDEX tasks_archived ON tasks(archived_at);
    `
  },
  {
    // V4: GitHub's own answer for an observed owner/name (a renamed account or transferred repository redirects to its
    // current full_name with the same repository id). Only "confirmed" rows are used to map a checkout to a project.
    version: 4,
    name: "github-identities",
    sql: `
      CREATE TABLE github_identities (
        slug TEXT PRIMARY KEY,
        canonical TEXT,
        repo_id INTEGER,
        state TEXT NOT NULL CHECK (state IN ('confirmed','not-found','unavailable')),
        resolved_at TEXT NOT NULL
      );
    `
  },
  {
    // V4.1: VPS Operations Center. Additive only. Host definitions are non-secret (the SSH identity path lives in the
    // ignored local/vps.json); observations hold sanitized, bounded probe results, never raw logs or business data.
    version: 5,
    name: "vps-operations",
    sql: `
      CREATE TABLE vps_hosts (
        id TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9]*' AND length(id) <= 40),
        name TEXT NOT NULL, provider TEXT, address TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
        ssh_user TEXT NOT NULL, host_key_fingerprint TEXT NOT NULL,
        expected_hostname TEXT, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        profile TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE vps_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id TEXT NOT NULL REFERENCES vps_hosts(id) ON DELETE CASCADE,
        at TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
        duration_ms INTEGER, error_category TEXT, data TEXT
      );
      CREATE INDEX vps_observations_host ON vps_observations(host_id, kind, at);
      CREATE TABLE vps_metrics (
        host_id TEXT NOT NULL REFERENCES vps_hosts(id) ON DELETE CASCADE,
        at TEXT NOT NULL, resolution TEXT NOT NULL CHECK (resolution IN ('raw','hour')),
        cpu_pct REAL, load1 REAL, mem_pct REAL, swap_pct REAL, disk_pct REAL, ssh_ms INTEGER, samples INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (host_id, resolution, at)
      );
      CREATE TABLE vps_services (
        host_id TEXT NOT NULL REFERENCES vps_hosts(id) ON DELETE CASCADE,
        service TEXT NOT NULL, kind TEXT NOT NULL, environment TEXT NOT NULL,
        state TEXT NOT NULL, detail TEXT, observed_at TEXT NOT NULL, changed_at TEXT NOT NULL,
        PRIMARY KEY (host_id, service)
      );
      CREATE TABLE vps_incidents (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES vps_hosts(id) ON DELETE CASCADE,
        dedupe_key TEXT NOT NULL, service TEXT, severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
        state TEXT NOT NULL CHECK (state IN ('open','recovered')),
        title TEXT NOT NULL, detection TEXT NOT NULL, evidence TEXT,
        assigned_agent TEXT, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, diagnosis_run_id TEXT,
        started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, recovered_at TEXT, occurrences INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX vps_incidents_open ON vps_incidents(dedupe_key) WHERE state = 'open';
      CREATE INDEX vps_incidents_host ON vps_incidents(host_id, started_at);
      CREATE TABLE vps_actions (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES vps_hosts(id) ON DELETE CASCADE,
        operation TEXT NOT NULL, params TEXT NOT NULL, environment TEXT NOT NULL, tier INTEGER NOT NULL,
        reason TEXT NOT NULL, requested_by TEXT NOT NULL, incident_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','expired','running','succeeded','failed')),
        approval_hash TEXT, approval_expires_at TEXT, approved_at TEXT,
        pre_state TEXT, post_state TEXT, exit_code INTEGER, output TEXT, result TEXT,
        created_at TEXT NOT NULL, decided_at TEXT, started_at TEXT, finished_at TEXT
      );
      CREATE INDEX vps_actions_status ON vps_actions(status, created_at);
    `
  }
];

export const nowIso = () => new Date().toISOString();
export const newId = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

export function parseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

/** Opens (or creates) the store and applies pending migrations inside one transaction each. */
export function openDatabase(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 4000;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.name, nowIso());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return wrap(db, path);
}

const RESTORE_TABLES = ["projects", "tasks", "agent_runs", "activity_events", "notifications", "usage_events", "memory_notes", "budgets"];
const backupHealth = new Map();

function wrap(db, path) {
  const statements = new Map();
  const prepare = (sql) => {
    let statement = statements.get(sql);
    if (!statement) { statement = db.prepare(sql); statements.set(sql, statement); }
    return statement;
  };
  let depth = 0;
  return {
    path,
    raw: db,
    all: (sql, ...params) => prepare(sql).all(...params),
    get: (sql, ...params) => prepare(sql).get(...params),
    run: (sql, ...params) => prepare(sql).run(...params),
    /** Nested calls join the outer transaction. */
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally { depth--; }
    },
    schemaVersion: () => db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,
    /** Consistent online copy of the whole store (VACUUM INTO). */
    backup(directory) {
      if (path === ":memory:") throw new Error("backup-unavailable-for-memory-store");
      mkdirSync(directory, { recursive: true });
      const file = join(directory, `company-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(6).toString("hex")}.db`);
      if (existsSync(file)) throw new Error("backup-filename-collision");
      try {
        db.prepare("VACUUM INTO ?").run(file);
        const copy = new DatabaseSync(file, { readOnly: true });
        try {
          if (copy.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("backup-integrity-failed");
          if (copy.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v !== db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v) throw new Error("backup-schema-mismatch");
        } finally { copy.close(); }
        return { file, bytes: statSync(file).size, verified: true };
      } catch (error) {
        try { unlinkSync(file); } catch (_) { /* VACUUM may have failed before creating it */ }
        throw error;
      }
    },
    listBackups(directory) {
      try {
        return readdirSync(directory).filter((name) => /^company-[0-9a-fTZ-]+\.db$/.test(name)).sort().reverse().slice(0, 30)
          .map((name) => {
            const file = join(directory, name);
            const info = statSync(file);
            // A backup is never written after creation, so its verdict is reused until the file itself changes;
            // listing no longer re-reads every backup on each request.
            const key = `${file}:${info.size}:${info.mtimeMs}`;
            let healthy = backupHealth.get(key);
            if (healthy === undefined) {
              healthy = false;
              try {
                const copy = new DatabaseSync(file, { readOnly: true });
                try { healthy = copy.prepare("PRAGMA integrity_check").get().integrity_check === "ok"; }
                finally { copy.close(); }
              } catch (_) { /* Report an unreadable backup as unhealthy. */ }
              backupHealth.set(key, healthy);
            }
            return { name, bytes: info.size, healthy };
          });
      } catch (_) { return []; }
    },
    /** Restore rehearsal: copies a backup to a private temporary folder, opens the copy and compares its records with the
     * live store. The live database is never touched; the copy is removed afterwards. */
    verifyRestore(directory, name) {
      if (!/^company-[0-9a-fTZ-]+\.db$/.test(String(name))) throw new Error("backup-name-invalid");
      const source = join(directory, name);
      if (!existsSync(source)) throw new Error("backup-not-found");
      const workDir = mkdtempSync(join(tmpdir(), "abud-restore-"));
      const target = join(workDir, "company.db");
      try {
        copyFileSync(source, target);
        const copy = new DatabaseSync(target, { readOnly: true });
        try {
          const integrity = copy.prepare("PRAGMA integrity_check").get().integrity_check;
          const foreignKeyViolations = copy.prepare("PRAGMA foreign_key_check").all().length;
          const schemaVersion = copy.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
          const counts = {};
          for (const table of RESTORE_TABLES) {
            counts[table] = {
              backup: copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
              live: db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
            };
          }
          // Read actual rows, not only page structure.
          const readable = counts.projects.backup === 0 || copy.prepare("SELECT id, name FROM projects LIMIT 1").get() !== undefined;
          return { name, restoredTo: "temporary-isolated-copy", integrity, foreignKeyViolations, schemaVersion, liveSchemaVersion: db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,
            counts, readable, ok: integrity === "ok" && foreignKeyViolations === 0 && readable, verifiedAt: nowIso() };
        } finally { copy.close(); }
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    close: () => db.close()
  };
}
