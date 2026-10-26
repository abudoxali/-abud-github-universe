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
  },
  {
    version: 6,
    name: "v5-conversations",
    sql: `
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived','deleted')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX conversations_agent_state ON conversations(agent_id, state, updated_at DESC);
      CREATE INDEX conversations_project ON conversations(project_id, updated_at DESC);
      CREATE INDEX conversations_task ON conversations(task_id, updated_at DESC);
      ALTER TABLE agent_runs ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL;
      CREATE INDEX agent_runs_conversation ON agent_runs(conversation_id, created_at);
      CREATE TABLE conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        role TEXT NOT NULL CHECK (role IN ('owner','assistant','tool','event')),
        content TEXT NOT NULL CHECK (length(content) <= 30000),
        state TEXT NOT NULL CHECK (state IN ('pending','complete','failed','blocked','cancelled')),
        source TEXT NOT NULL DEFAULT 'runtime', metadata TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX conversation_messages_turn ON conversation_messages(run_id, role) WHERE role IN ('owner','assistant');
      CREATE INDEX conversation_messages_thread ON conversation_messages(conversation_id, created_at, id);
      CREATE TABLE conversation_attachments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES conversation_messages(id) ON DELETE CASCADE,
        filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 120),
        mime TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
        data BLOB NOT NULL,
        extracted_text TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX conversation_attachments_message ON conversation_attachments(message_id);
      CREATE INDEX conversation_attachments_thread ON conversation_attachments(conversation_id, created_at);
    `
  },
  {
    version: 7,
    name: "v5-memory-provenance-fts",
    sql: `
      ALTER TABLE memory_notes ADD COLUMN owner_agent TEXT REFERENCES agents(id);
      ALTER TABLE memory_notes ADD COLUMN source_ref TEXT;
      ALTER TABLE memory_notes ADD COLUMN source_at TEXT;
      ALTER TABLE memory_notes ADD COLUMN reviewed_at TEXT;
      ALTER TABLE memory_notes ADD COLUMN confidence TEXT NOT NULL DEFAULT 'unverified' CHECK (confidence IN ('verified','supported','unverified'));
      ALTER TABLE memory_notes ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('internal','restricted'));
      ALTER TABLE memory_notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
      ALTER TABLE memory_notes ADD COLUMN retention_until TEXT;
      ALTER TABLE memory_notes ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived'));
      CREATE INDEX memory_notes_state_scope ON memory_notes(state, scope, scope_ref, updated_at DESC);
      CREATE VIRTUAL TABLE memory_fts USING fts5(title, body, content='memory_notes', content_rowid='rowid');
      INSERT INTO memory_fts(memory_fts) VALUES('rebuild');
      CREATE TRIGGER memory_fts_insert AFTER INSERT ON memory_notes BEGIN
        INSERT INTO memory_fts(rowid,title,body) VALUES (new.rowid,new.title,new.body);
      END;
      CREATE TRIGGER memory_fts_delete AFTER DELETE ON memory_notes BEGIN
        INSERT INTO memory_fts(memory_fts,rowid,title,body) VALUES ('delete',old.rowid,old.title,old.body);
      END;
      CREATE TRIGGER memory_fts_update AFTER UPDATE ON memory_notes BEGIN
        INSERT INTO memory_fts(memory_fts,rowid,title,body) VALUES ('delete',old.rowid,old.title,old.body);
        INSERT INTO memory_fts(rowid,title,body) VALUES (new.rowid,new.title,new.body);
      END;
    `
  },
  {
    version: 8,
    name: "v5-knowledge-documents",
    sql: `
      CREATE TABLE knowledge_documents (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK (source_type IN ('owner-text','project-doc')),
        source_ref TEXT NOT NULL,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
        content_sha256 TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
        bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 100000),
        source_bytes INTEGER, truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
        created_at TEXT NOT NULL, indexed_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (project_id, source_type, source_ref)
      );
      CREATE INDEX knowledge_documents_project ON knowledge_documents(project_id,state,indexed_at DESC);
      CREATE TABLE knowledge_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 1500),
        start_char INTEGER NOT NULL, end_char INTEGER NOT NULL,
        UNIQUE (document_id, ordinal)
      );
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(content, content='knowledge_chunks', content_rowid='id');
      CREATE TRIGGER knowledge_fts_insert AFTER INSERT ON knowledge_chunks BEGIN
        INSERT INTO knowledge_fts(rowid,content) VALUES (new.id,new.content);
      END;
      CREATE TRIGGER knowledge_fts_delete AFTER DELETE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_fts(knowledge_fts,rowid,content) VALUES ('delete',old.id,old.content);
      END;
      CREATE TRIGGER knowledge_fts_update AFTER UPDATE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_fts(knowledge_fts,rowid,content) VALUES ('delete',old.id,old.content);
        INSERT INTO knowledge_fts(rowid,content) VALUES (new.id,new.content);
      END;
    `
  },
  {
    // Capability engine: every tool execution is audited, generated files are stored as artifacts, the owner can disable a
    // capability, spans stay local, and knowledge gains approved web pages. knowledge_documents is rebuilt to widen its
    // source_type CHECK; foreign keys are suspended for this migration only so the rebuild cannot cascade into chunks.
    version: 9,
    name: "v5-capability-engine",
    foreignKeysOff: true,
    sql: `
      CREATE TABLE tool_executions (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL, tool_version TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        workflow_id TEXT,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','denied','timeout','cancelled')),
        input TEXT NOT NULL DEFAULT '{}', output_summary TEXT,
        error_code TEXT, error_message TEXT,
        artifact_ids TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER
      );
      CREATE INDEX tool_executions_agent ON tool_executions(agent_id, started_at DESC);
      CREATE INDEX tool_executions_tool ON tool_executions(tool_id, started_at DESC);
      CREATE INDEX tool_executions_run ON tool_executions(run_id);
      CREATE INDEX tool_executions_workflow ON tool_executions(workflow_id);
      CREATE INDEX tool_executions_status ON tool_executions(status, started_at);
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('image','calendar','pdf','report','canvas')),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
        filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 120),
        mime TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
        sha256 TEXT NOT NULL,
        data BLOB NOT NULL,
        agent_id TEXT REFERENCES agents(id),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        execution_id TEXT REFERENCES tool_executions(id) ON DELETE SET NULL,
        workflow_id TEXT,
        state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','archived')),
        metadata TEXT NOT NULL DEFAULT '{}',
        approved_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX artifacts_project ON artifacts(project_id, created_at DESC);
      CREATE INDEX artifacts_agent ON artifacts(agent_id, created_at DESC);
      CREATE INDEX artifacts_workflow ON artifacts(workflow_id);
      CREATE TABLE capability_state (
        tool_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        disabled_reason TEXT, health TEXT, health_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE visual_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
        kind TEXT NOT NULL CHECK (kind IN ('fabric')),
        spec TEXT NOT NULL CHECK (length(spec) <= 400000),
        width INTEGER NOT NULL, height INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE telemetry_spans (
        span_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL, parent_span_id TEXT,
        name TEXT NOT NULL, kind TEXT,
        start_at TEXT NOT NULL, duration_ms REAL NOT NULL,
        status TEXT NOT NULL,
        agent_id TEXT, tool_id TEXT, run_id TEXT,
        attributes TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX telemetry_spans_at ON telemetry_spans(start_at);
      CREATE INDEX telemetry_spans_agent ON telemetry_spans(agent_id, start_at);
      CREATE INDEX telemetry_spans_trace ON telemetry_spans(trace_id);
      CREATE TABLE knowledge_documents_v9 (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK (source_type IN ('owner-text','project-doc','web-page')),
        source_ref TEXT NOT NULL,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
        content_sha256 TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
        bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 100000),
        source_bytes INTEGER, truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
        created_at TEXT NOT NULL, indexed_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        source_url TEXT, fetched_at TEXT, etag TEXT, last_checked_at TEXT, freshness TEXT,
        UNIQUE (project_id, source_type, source_ref)
      );
      INSERT INTO knowledge_documents_v9 (id,project_id,source_type,source_ref,title,content_sha256,state,bytes,source_bytes,truncated,created_at,indexed_at,updated_at)
        SELECT id,project_id,source_type,source_ref,title,content_sha256,state,bytes,source_bytes,truncated,created_at,indexed_at,updated_at FROM knowledge_documents;
      DROP TABLE knowledge_documents;
      ALTER TABLE knowledge_documents_v9 RENAME TO knowledge_documents;
      CREATE INDEX knowledge_documents_project ON knowledge_documents(project_id,state,indexed_at DESC);
    `
  },
  {
    // Bounded multi-agent workflows: a persisted plan (steps with agent, tool, inputs, dependencies and depth), every
    // state change as an event, and limits stored with the workflow so a restarted Bridge resumes under the same bounds.
    version: 10,
    name: "v5-orchestration",
    sql: `
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        template TEXT NOT NULL,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        objective TEXT NOT NULL CHECK (length(objective) <= 2000),
        primary_agent TEXT NOT NULL REFERENCES agents(id),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        parent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','running','waiting-approval','succeeded','partial','failed','cancelled')),
        limits TEXT NOT NULL,
        input TEXT NOT NULL DEFAULT '{}',
        report TEXT, evidence TEXT NOT NULL DEFAULT '[]',
        error_code TEXT, error_message TEXT,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE INDEX workflows_status ON workflows(status, created_at DESC);
      CREATE INDEX workflows_project ON workflows(project_id, created_at DESC);
      CREATE TABLE workflow_steps (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        key TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        kind TEXT NOT NULL CHECK (kind IN ('tool','synthesis','followups')),
        title TEXT NOT NULL,
        depends_on TEXT NOT NULL DEFAULT '[]',
        depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 3),
        optional INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0,1)),
        tool_id TEXT, input TEXT NOT NULL DEFAULT '{}', expected TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped','cancelled','waiting-approval')),
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        execution_id TEXT, approval_id TEXT,
        output TEXT, evidence TEXT NOT NULL DEFAULT '[]',
        error_code TEXT, error_message TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at TEXT, finished_at TEXT,
        UNIQUE (workflow_id, key)
      );
      CREATE INDEX workflow_steps_workflow ON workflow_steps(workflow_id, ordinal);
      CREATE INDEX workflow_steps_status ON workflow_steps(status);
      CREATE TABLE workflow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        step_id TEXT, at TEXT NOT NULL, kind TEXT NOT NULL, agent_id TEXT,
        detail TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX workflow_events_workflow ON workflow_events(workflow_id, id);
    `
  },
  {
    // Integration: memory conflicts keep both records and their provenance until the owner decides; conversation
    // summaries are extractive and hash-verified against the stored messages they cover (originals are never removed);
    // time-range indexes keep accounting and telemetry queries off full scans.
    version: 11,
    name: "v5-integration",
    sql: `
      ALTER TABLE memory_notes ADD COLUMN conflicts_with TEXT;
      ALTER TABLE memory_notes ADD COLUMN conflict_state TEXT CHECK (conflict_state IN ('open','kept-new','kept-existing','kept-both'));
      ALTER TABLE memory_notes ADD COLUMN superseded_by TEXT;
      CREATE INDEX memory_notes_conflict ON memory_notes(conflict_state);
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        upto_rowid INTEGER NOT NULL,
        covered INTEGER NOT NULL,
        digest TEXT NOT NULL,
        text TEXT NOT NULL CHECK (length(text) <= 12000),
        method TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX agent_runs_created ON agent_runs(created_at);
      CREATE INDEX tool_executions_started ON tool_executions(started_at);
      CREATE INDEX conversation_attachments_created ON conversation_attachments(created_at);
    `
  },
  {
    // V6 Checkpoint 1: Dynamic Agent Registry. The six built-in agents become the initial roster; a registry holds
    // agent profiles (identity, specializations, voice, model routing, permissions), and agent ids are validated against
    // the active registry instead of a hard-coded CHECK. Templates derived from built-ins define allowed tool sets for
    // new agents. Tables with six-id CHECK constraints are rebuilt to accept any id matching ^[a-z][a-z0-9_-]{1,23}$.
    version: 12,
    name: "v6-agent-registry",
    foreignKeysOff: true,
    sql: `
      -- Rebuild agents table to relax id CHECK and add profile fields
      CREATE TABLE agents_v12 (
        id TEXT PRIMARY KEY CHECK (id GLOB '[a-z]*' AND length(id) BETWEEN 2 AND 24 AND id NOT GLOB '*[^a-z0-9_-]*'),
        enabled INTEGER NOT NULL DEFAULT 1,
        mode TEXT NOT NULL CHECK (mode IN ('standard','creative','analytical','research','strict','execution')),
        instructions TEXT NOT NULL DEFAULT '',
        policy_domain TEXT NOT NULL,
        model_override TEXT,
        tools TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        -- V6 profile fields
        builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
        name TEXT NOT NULL,
        title_ar TEXT NOT NULL,
        role_ar TEXT NOT NULL,
        department TEXT,
        summary_ar TEXT NOT NULL,
        specializations TEXT NOT NULL DEFAULT '[]',
        identity_profile TEXT NOT NULL DEFAULT '{}',
        voice_profile TEXT NOT NULL DEFAULT '{"status":"provisional","engine":null,"speaker":null}',
        memory_scope TEXT NOT NULL DEFAULT 'conversation',
        model_routing_profile TEXT NOT NULL DEFAULT '{}',
        resource_limits TEXT NOT NULL DEFAULT '{}',
        collaboration_permissions TEXT NOT NULL DEFAULT '{}',
        approval_policy TEXT NOT NULL DEFAULT 'default',
        availability TEXT NOT NULL DEFAULT 'active',
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        template_id TEXT,
        profile_schema_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      INSERT INTO agents_v12 (id,enabled,mode,instructions,policy_domain,model_override,tools,updated_at,builtin,name,title_ar,role_ar,summary_ar,created_at)
        SELECT id,enabled,mode,instructions,policy_domain,model_override,tools,updated_at,1,'','','','',updated_at FROM agents;
      DROP TABLE agents;
      ALTER TABLE agents_v12 RENAME TO agents;
      CREATE INDEX agents_active ON agents(active, id);
      CREATE INDEX agents_template ON agents(template_id);

      -- Rebuild tasks table to relax assignee CHECK
      CREATE TABLE tasks_v12 (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        assignee TEXT NOT NULL DEFAULT 'owner' CHECK (assignee = 'owner' OR assignee = 'none' OR (assignee GLOB '[a-z]*' AND assignee NOT GLOB '*[^a-z0-9_-]*' AND length(assignee) BETWEEN 2 AND 24)),
        priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('backlog','todo','in_progress','blocked','review','done','cancelled')),
        due_date TEXT, start_date TEXT, estimate_hours REAL CHECK (estimate_hours IS NULL OR estimate_hours >= 0),
        tags TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]', blocker TEXT,
        source TEXT NOT NULL DEFAULT 'owner', external_ref TEXT UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, archived_at TEXT
      );
      INSERT INTO tasks_v12 SELECT * FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_v12 RENAME TO tasks;
      CREATE INDEX tasks_status ON tasks(status);
      CREATE INDEX tasks_project ON tasks(project_id);
      CREATE INDEX tasks_assignee ON tasks(assignee);
      CREATE INDEX tasks_due ON tasks(due_date);
      CREATE INDEX tasks_archived ON tasks(archived_at);
    `
  },
  {
    version: 13,
    name: "v6-tool-intelligence",
    sql: `
      ALTER TABLE agent_runs ADD COLUMN tool_selection TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE agent_runs ADD COLUMN actions_ar TEXT NOT NULL DEFAULT '[]';
      CREATE TABLE auto_policies (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        tool_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('company','project')),
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        CHECK((scope = 'company' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX auto_policies_scope ON auto_policies(agent_id, tool_id, scope, COALESCE(project_id, ''));
    `
  }
];

export const nowIso = () => new Date().toISOString();
export const newId = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

export function parseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

/** The verified copy taken before the most recent schema upgrade in this process (null when none was needed). */
let lastPreMigrationBackup = null;
export const preMigrationBackup = () => lastPreMigrationBackup;

/** Opens (or creates) the store and applies pending migrations inside one transaction each. */
export function openDatabase(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 4000;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  // An existing store is copied (VACUUM INTO) and verified before any schema upgrade, so a newer build started from this
  // checkout can never alter the daily database without a restorable copy. A failed copy stops the upgrade.
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  lastPreMigrationBackup = null; // reported only by the open that actually upgraded the store
  if (path !== ":memory:" && pending.length && applied.size) {
    const from = Math.max(...applied);
    const dir = join(dirname(path), "backups");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `company-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(6).toString("hex")}.db`);
    db.prepare("VACUUM INTO ?").run(file);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      if (copy.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" || copy.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v !== from) throw new Error("pre-migration-backup-failed");
    } finally { copy.close(); }
    lastPreMigrationBackup = { file, fromVersion: from, toVersion: Math.max(...pending.map((m) => m.version)), at: nowIso() };
  }
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    // A table rebuild must not cascade deletes into child rows; the pragma only takes effect outside a transaction, so
    // it is lowered before BEGIN and every reference is re-verified before COMMIT.
    if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      if (migration.foreignKeysOff && db.prepare("PRAGMA foreign_key_check").all().length) throw new Error(`migration-${migration.version}-foreign-key-violation`);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.name, nowIso());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
    }
  }
  return wrap(db, path);
}

const RESTORE_TABLES = ["projects", "tasks", "agent_runs", "activity_events", "notifications", "usage_events", "memory_notes", "budgets", "conversations", "knowledge_documents", "tool_executions", "artifacts", "workflows"];
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
          // A backup taken before a later migration lacks its tables; those are reported as absent, not as zero rows.
          const has = (store, table) => Boolean(store.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
          for (const table of RESTORE_TABLES) {
            if (!has(copy, table) || !has(db, table)) { counts[table] = { backup: has(copy, table) ? copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : null, live: has(db, table) ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : null }; continue; }
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
