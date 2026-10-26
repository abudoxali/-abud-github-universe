import { createRegistry } from "./registry.mjs";
/* Company domain service over the local store. Every mutation validates its input, runs in a transaction and writes an
 * activity event. Errors are HttpError instances with a stable code and an Arabic message for the UI. */
import { AGENTS, AGENT_IDS, DEFAULT_POLICIES, DOMAINS, MODES, TOOLS, CLASS_INFO, VPS_AGENT_TOOLS, V5_AGENT_TOOLS, templateById, modelClass } from "./catalog.mjs";
import { newId, nowIso, parseJson } from "./db.mjs";
import { redact, text } from "./util.mjs";

export class HttpError extends Error {
  constructor(status, code, messageAr, details) {
    super(code);
    this.status = status; this.code = code; this.messageAr = messageAr; this.details = details ?? null;
  }
}
const bad = (code, messageAr, details) => new HttpError(422, code, messageAr, details);
const notFound = (what) => new HttpError(404, "not-found", `${what} غير موجود`);

// ---------------------------------------------------------------- validation helpers
const SECRET_LIKE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_\w{10,}|sk-[A-Za-z0-9_-]{14,}|AIza[0-9A-Za-z_-]{20,}|(?:password|passphrase|api[_ -]?key|secret|access[_ -]?token)\s*[:=]\s*\S+)/i;
const PRIORITIES = ["high", "medium", "low"];
const TASK_STATUSES = ["backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled"];
const PROJECT_STATUSES = ["active", "planned", "paused", "blocked", "shipped", "archived"];
const MODEL_REF = /^[A-Za-z0-9._:/@+-]{1,120}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function str(value, { field, max, required = false, multiline = false }) {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    if (required) throw bad("validation", `الحقل «${field}» مطلوب`, { field });
    return null;
  }
  if (typeof value !== "string") throw bad("validation", `الحقل «${field}» يجب أن يكون نصًا`, { field });
  const clean = multiline ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (clean.length > max) throw bad("validation", `الحقل «${field}» أطول من ${max} حرفًا`, { field });
  if (SECRET_LIKE.test(clean)) throw bad("secret-rejected", `الحقل «${field}» يبدو أنه يحتوي على سر أو مفتاح؛ لا تُخزَّن الأسرار هنا`, { field });
  return clean;
}
const oneOf = (value, list, field, fallback) => {
  if (value == null) return fallback;
  if (!list.includes(value)) throw bad("validation", `قيمة «${field}» غير مسموحة`, { field, allowed: list });
  return value;
};
const date = (value, field) => {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw bad("validation", `«${field}» يجب أن يكون تاريخًا بصيغة YYYY-MM-DD`, { field });
  return value;
};
const numberIn = (value, field, min, max, { integer = false, nullable = true } = {}) => {
  if (value == null || value === "") { if (nullable) return null; throw bad("validation", `«${field}» مطلوب`, { field }); }
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw bad("validation", `«${field}» يجب أن يكون رقمًا بين ${min} و${max}`, { field });
  return n;
};
const tags = (value) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 12) throw bad("validation", "الوسوم يجب أن تكون قائمة حتى 12 وسمًا");
  return [...new Set(value.map((tag) => str(tag, { field: "tag", max: 40 })).filter(Boolean))];
};

// ---------------------------------------------------------------- period math (company timezone)
const DEFAULT_TZ = "Africa/Cairo";
function zonedParts(at, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" })
    .formatToParts(at).map((p) => [p.type, p.value]));
  return parts;
}
function zonedMidnight(at, timeZone) {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offset = asUtc - Math.floor(at.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - offset);
}
/** Start of the current budget period in the company timezone. Weeks start on Saturday (Egyptian work week). */
export function periodStart(period, now = new Date(), timeZone = DEFAULT_TZ) {
  const midnight = zonedMidnight(now, timeZone);
  if (period === "daily") return midnight;
  if (period === "weekly") {
    const weekday = zonedParts(now, timeZone).weekday;
    const back = { Sat: 0, Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6 }[weekday] ?? 0;
    return zonedMidnight(new Date(midnight.getTime() - back * 86_400_000 + 3_600_000), timeZone);
  }
  const p = zonedParts(now, timeZone);
  return zonedMidnight(new Date(midnight.getTime() - (+p.day - 1) * 86_400_000 + 3_600_000), timeZone);
}

// ---------------------------------------------------------------- service
export function createCompany({ db, now = () => new Date() }) {
  const at = () => now().toISOString();

  const registry = createRegistry({ db, company: { log: (...args) => log(...args) } });
  const agentById = (id) => {
    const row = db.get("SELECT * FROM agents WHERE id = ?", id);
    if (!row) return null;
    const base = AGENTS.find(a => a.id === id) ?? AGENTS.find(a => a.id === templateById(row.template_id)?.basedOn);
    return { ...base, id, name: row.name, titleAr: row.title_ar, roleAr: row.role_ar, summaryAr: row.summary_ar, specializationsAr: parseJson(row.specializations, []), ...parseJson(row.identity_profile, {}), tools: base?.tools ?? [], active: row.active === 1 };
  };
  const listAgents = ({ activeOnly = true } = {}) => db.all('SELECT id FROM agents ' + (activeOnly ? 'WHERE active = 1' : '') + ' ORDER BY builtin DESC, id').map(r => agentById(r.id));

  // V6: Dynamic agent ID validation (queries active agents from registry instead of hard-coded list)
  const getActiveAgentIds = () => db.all("SELECT id FROM agents WHERE active = 1").map((r) => r.id);
  const isActiveAgent = (id) => db.get("SELECT 1 FROM agents WHERE id = ? AND active = 1", id) != null;
  const validateAssignee = (value, field, fallback) => {
    if (value == null) return fallback;
    if (value === "owner" || value === "none") return value;
    if (!isActiveAgent(value)) throw bad("validation", `قيمة «${field}» غير مسموحة (الوكيل غير موجود أو معطل)`, { field });
    return value;
  };

  // ---------------- activity + notifications
  function log({ actorType = "owner", actorId = "owner", action, targetType = null, targetId = null, outcome = "success", summary, metadata = null, evidence = null }) {
    const safeMeta = metadata ? JSON.stringify(metadata, (key, value) => (typeof value === "string" ? redact(value, 400) : value)).slice(0, 4000) : null;
    db.run("INSERT INTO activity_events (at, actor_type, actor_id, action, target_type, target_id, outcome, summary, metadata, evidence) VALUES (?,?,?,?,?,?,?,?,?,?)",
      at(), actorType, actorId, action, targetType, targetId, outcome, redact(summary, 300), safeMeta, evidence ? redact(evidence, 200) : null);
  }
  function activity({ limit = 100, targetType = null, targetId = null, actorId = null, before = null } = {}) {
    const where = [], params = [];
    if (targetType) { where.push("target_type = ?"); params.push(targetType); }
    if (targetId) { where.push("target_id = ?"); params.push(targetId); }
    if (actorId) { where.push("actor_id = ?"); params.push(actorId); }
    if (before) { where.push("id < ?"); params.push(Number(before)); }
    const rows = db.all(`SELECT * FROM activity_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`, ...params, Math.min(Math.max(Number(limit) || 100, 1), 300));
    return rows.map((row) => ({ ...row, metadata: parseJson(row.metadata, null) }));
  }

  function raise({ key, level, kind, title, body = null, targetType = null, targetId = null }) {
    const existing = db.get("SELECT id, acknowledged_at FROM notifications WHERE dedupe_key = ? AND resolved_at IS NULL", key);
    if (existing) {
      db.run("UPDATE notifications SET last_seen_at = ?, count = count + 1, level = ?, title = ?, body = ? WHERE id = ?", at(), level, title, body, existing.id);
      return existing.id;
    }
    return Number(db.run("INSERT INTO notifications (dedupe_key, level, kind, title, body, target_type, target_id, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)",
      key, level, kind, title, body, targetType, targetId, at(), at()).lastInsertRowid);
  }
  /** Resolves open notifications of a kind whose keys are no longer active (e.g. a quota that recovered). */
  function resolveStale(kind, activeKeys) {
    const open = db.all("SELECT id, dedupe_key FROM notifications WHERE kind = ? AND resolved_at IS NULL", kind);
    for (const row of open) if (!activeKeys.has(row.dedupe_key)) db.run("UPDATE notifications SET resolved_at = ? WHERE id = ?", at(), row.id);
  }
  function notifications({ includeResolved = false, limit = 100 } = {}) {
    return db.all(`SELECT * FROM notifications ${includeResolved ? "" : "WHERE resolved_at IS NULL"} ORDER BY CASE level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen_at DESC LIMIT ?`, limit);
  }
  function acknowledge(id) {
    const row = db.get("SELECT id FROM notifications WHERE id = ?", Number(id));
    if (!row) throw notFound("التنبيه");
    db.run("UPDATE notifications SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?", at(), row.id);
    return db.get("SELECT * FROM notifications WHERE id = ?", row.id);
  }

  // ---------------- settings
  const SETTINGS_DEFAULTS = { locale: "ar-EG", timezone: DEFAULT_TZ, quotaSnapshotMinutes: 15, quotaRetentionDays: 30, schedulerConcurrency: 1, subscriptionOptIn: false,
    inferenceTimeouts: { connectMs: 5000, headersMs: 30000, firstTokenMs: 25000, idleMs: 30000, totalMs: 90000 },
    // Hosts ZEN may fetch (exact names, HTTPS or HTTP on default ports, public addresses only). Editable by the owner.
    webAllowedHosts: ["developer.mozilla.org", "nodejs.org", "docs.github.com", "github.com", "raw.githubusercontent.com", "www.sqlite.org", "sqlite.org", "learn.microsoft.com", "en.wikipedia.org", "ar.wikipedia.org"],
    telemetryRetentionDays: 14,
    // Conversation context budget (estimated tokens) and retention for files of deleted conversations (0 = keep).
    conversationContextTokens: 3000, attachmentRetentionDays: 0 };
  function settings() {
    const stored = Object.fromEntries(db.all("SELECT key, value FROM settings").map((row) => [row.key, parseJson(row.value, null)]));
    return { ...SETTINGS_DEFAULTS, ...stored };
  }
  function updateSettings(patch) {
    const next = {};
    if ("locale" in patch) next.locale = oneOf(patch.locale, ["ar-EG", "ar-SA", "ar", "en-GB"], "locale");
    if ("timezone" in patch) {
      const tz = str(patch.timezone, { field: "timezone", max: 60, required: true });
      try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch (_) { throw bad("validation", "المنطقة الزمنية غير صالحة"); }
      next.timezone = tz;
    }
    if ("quotaSnapshotMinutes" in patch) next.quotaSnapshotMinutes = numberIn(patch.quotaSnapshotMinutes, "quotaSnapshotMinutes", 5, 240, { integer: true, nullable: false });
    if ("quotaRetentionDays" in patch) next.quotaRetentionDays = numberIn(patch.quotaRetentionDays, "quotaRetentionDays", 7, 365, { integer: true, nullable: false });
    if ("subscriptionOptIn" in patch) next.subscriptionOptIn = patch.subscriptionOptIn === true;
    if ("webAllowedHosts" in patch) {
      const hosts = patch.webAllowedHosts;
      const valid = (host) => typeof host === "string" && host.length <= 253 && /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/.test(host) && !/^\d+(\.\d+){3}$/.test(host) && !/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(host);
      if (!Array.isArray(hosts) || hosts.length > 50 || !hosts.every(valid)) throw bad("validation", "قائمة المواقع المعتمدة غير صالحة: أسماء نطاقات عامة فقط (بدون عناوين IP أو أسماء محلية)، حتى 50 نطاقًا");
      next.webAllowedHosts = [...new Set(hosts)];
    }
    if ("conversationContextTokens" in patch) next.conversationContextTokens = numberIn(patch.conversationContextTokens, "conversationContextTokens", 1000, 12000, { integer: true, nullable: false });
    if ("attachmentRetentionDays" in patch) next.attachmentRetentionDays = numberIn(patch.attachmentRetentionDays, "attachmentRetentionDays", 0, 3650, { integer: true, nullable: false });
    if ("telemetryRetentionDays" in patch) next.telemetryRetentionDays = numberIn(patch.telemetryRetentionDays, "telemetryRetentionDays", 1, 90, { integer: true, nullable: false });
    if ("inferenceTimeouts" in patch) {
      const bounds = { connectMs: [1000, 20000], headersMs: [5000, 120000], firstTokenMs: [5000, 120000], idleMs: [5000, 120000], totalMs: [20000, 300000] };
      const input = patch.inferenceTimeouts;
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !bounds[key])) throw bad("validation", "حدود مهلة الاستدلال غير صالحة");
      next.inferenceTimeouts = { ...settings().inferenceTimeouts };
      for (const [key, value] of Object.entries(input)) {
        if (!Number.isInteger(value) || value < bounds[key][0] || value > bounds[key][1]) throw bad("validation", `مهلة ${key} خارج الحدود المسموحة`);
        next.inferenceTimeouts[key] = value;
      }
      // Each phase limit must be reachable: a phase longer than the whole attempt (or a connect limit longer than the
      // header wait) would never fire and would misdescribe how long a stalled request can hang.
      const t = next.inferenceTimeouts;
      if (t.connectMs > t.headersMs || [t.headersMs, t.firstTokenMs, t.idleMs].some((ms) => ms > t.totalMs)) {
        throw bad("validation", "مهل الاستدلال غير متسقة: يجب ألا تتجاوز مهلة الاتصال مهلة العناوين، وألا تتجاوز أي مرحلة المهلة الكلية", { inferenceTimeouts: t });
      }
    }
    db.tx(() => {
      for (const [key, value] of Object.entries(next)) db.run("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, JSON.stringify(value), at());
      log({ action: "settings.updated", targetType: "settings", summary: `تحديث الإعدادات: ${Object.keys(next).join("، ") || "لا شيء"}`, metadata: next });
    });
    return settings();
  }

  // ---------------- seed
  function seed() {
    registry.seedBuiltinProfiles();
    db.tx(() => {
      for (const agent of AGENTS) {
        db.run("INSERT OR IGNORE INTO agents (id, enabled, mode, instructions, policy_domain, model_override, tools, updated_at) VALUES (?,?,?,?,?,?,?,?)",
          agent.id, 1, agent.defaultMode, "", agent.domain, null, JSON.stringify(agent.tools), at());
        // V4.1 grants the reviewed VPS tools to existing agents exactly once; a later owner narrowing is never undone.
        const ref = `tools-grant:v4.1-vps:${agent.id}`;
        if (!db.get("SELECT ref FROM import_ledger WHERE ref = ?", ref)) {
          const row = db.get("SELECT tools FROM agents WHERE id = ?", agent.id);
          const merged = [...new Set([...parseJson(row.tools, []), ...VPS_AGENT_TOOLS[agent.id]])];
          db.run("UPDATE agents SET tools = ?, updated_at = ? WHERE id = ?", JSON.stringify(merged), at(), agent.id);
          db.run("INSERT INTO import_ledger (ref, kind, imported_at) VALUES (?,?,?)", ref, "tools-grant", at());
        }
        // V5 grants the reviewed specialist capabilities the same way: once, and never re-adding what the owner removed.
        const v5 = `tools-grant:v5-capabilities:${agent.id}`;
        if (!db.get("SELECT ref FROM import_ledger WHERE ref = ?", v5)) {
          const row = db.get("SELECT tools FROM agents WHERE id = ?", agent.id);
          db.run("UPDATE agents SET tools = ?, updated_at = ? WHERE id = ?", JSON.stringify([...new Set([...parseJson(row.tools, []), ...V5_AGENT_TOOLS[agent.id]])]), at(), agent.id);
          db.run("INSERT INTO import_ledger (ref, kind, imported_at) VALUES (?,?,?)", v5, "tools-grant", at());
        }
      }
      for (const [domain, policy] of Object.entries(DEFAULT_POLICIES)) {
        db.run(`INSERT OR IGNORE INTO routing_policies (domain, candidates, allow_classes, max_cost_usd, max_retries, quota_protect_pct, approval, max_output_tokens, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`, domain, JSON.stringify(policy.candidates), JSON.stringify(["free", "api-free-tier"]), 0.05, 1, policy.quotaProtectPct ?? 15, "paid", policy.maxOutputTokens, at());
      }
      db.run("INSERT OR IGNORE INTO budgets (id, scope, scope_ref, period, limit_usd, token_limit, warn_pct, hard_stop, enabled, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", "bud_company_daily", "company", "", "daily", 1, 2_000_000, 80, 1, 1, at());
      db.run("INSERT OR IGNORE INTO budgets (id, scope, scope_ref, period, limit_usd, token_limit, warn_pct, hard_stop, enabled, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", "bud_company_monthly", "company", "", "monthly", 10, null, 80, 1, 1, at());
    });
  }

  // ---------------- projects
  const projectRow = (row) => row && ({
    id: row.id, name: row.name, github: row.github, catalogName: row.catalog_name, status: row.status, priority: row.priority,
    summary: row.summary, notes: row.notes, blocker: row.blocker, source: row.source, focus: Boolean(row.focus), createdAt: row.created_at, updatedAt: row.updated_at
  });
  const MAX_FOCUS = 3;
  function listProjects() {
    const rows = db.all("SELECT * FROM projects ORDER BY focus DESC, CASE status WHEN 'blocked' THEN 0 WHEN 'active' THEN 1 WHEN 'planned' THEN 2 ELSE 3 END, CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, name COLLATE NOCASE");
    const checkouts = db.all("SELECT * FROM project_checkouts");
    const counts = db.all("SELECT project_id, SUM(CASE WHEN status NOT IN ('done','cancelled') THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM tasks WHERE project_id IS NOT NULL AND archived_at IS NULL GROUP BY project_id");
    const agentLinks = db.all("SELECT * FROM agent_projects");
    const countMap = new Map(counts.map((c) => [c.project_id, c]));
    return rows.map((row) => ({
      ...projectRow(row),
      checkouts: checkouts.filter((c) => c.project_id === row.id).map((c) => ({ rel: c.rel, link: c.link, observedAt: c.observed_at })),
      tasks: { open: countMap.get(row.id)?.open ?? 0, blocked: countMap.get(row.id)?.blocked ?? 0, done: countMap.get(row.id)?.done ?? 0 },
      agents: agentLinks.filter((l) => l.project_id === row.id).map((l) => l.agent_id)
    }));
  }
  function getProject(id) {
    const row = db.get("SELECT * FROM projects WHERE id = ?", String(id));
    if (!row) throw notFound("المشروع");
    const project = listProjects().find((p) => p.id === row.id);
    return {
      ...project,
      milestones: db.all("SELECT * FROM milestones WHERE project_id = ? ORDER BY COALESCE(due_date, '9999') , created_at", row.id)
        .map((m) => ({ id: m.id, title: m.title, dueDate: m.due_date, status: m.status })),
      activity: activity({ targetType: "project", targetId: row.id, limit: 30 }),
      memory: listMemory({ scope: "project", scopeRef: row.id })
    };
  }
  function createProject(input, actor = { type: "owner", id: "owner" }) {
    const name = str(input.name, { field: "الاسم", max: 120, required: true });
    const github = input.github ? str(input.github, { field: "github", max: 140 }) : null;
    if (github && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(github)) throw bad("validation", "صيغة GitHub يجب أن تكون owner/repo");
    const id = github ? `gh:${github.toLowerCase()}` : `prj:${newId("p").slice(2)}`;
    if (db.get("SELECT id FROM projects WHERE id = ? OR (github IS NOT NULL AND lower(github) = lower(?))", id, github ?? "")) throw new HttpError(409, "duplicate", "يوجد مشروع بنفس هوية GitHub");
    db.tx(() => {
      db.run("INSERT INTO projects (id, name, github, catalog_name, status, priority, summary, notes, blocker, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        id, name, github, null, oneOf(input.status, PROJECT_STATUSES, "status", "active"), oneOf(input.priority, PRIORITIES, "priority", "medium"),
        str(input.summary, { field: "الوصف", max: 600 }), null, null, "manual", at(), at());
      log({ actorType: actor.type, actorId: actor.id, action: "project.created", targetType: "project", targetId: id, summary: `إنشاء مشروع: ${name}` });
    });
    return getProject(id);
  }
  function updateProject(id, patch, actor = { type: "owner", id: "owner" }) {
    const current = db.get("SELECT * FROM projects WHERE id = ?", String(id));
    if (!current) throw notFound("المشروع");
    const next = {
      name: "name" in patch ? str(patch.name, { field: "الاسم", max: 120, required: true }) : current.name,
      status: "status" in patch ? oneOf(patch.status, PROJECT_STATUSES, "status") : current.status,
      priority: "priority" in patch ? oneOf(patch.priority, PRIORITIES, "priority") : current.priority,
      summary: "summary" in patch ? str(patch.summary, { field: "الوصف", max: 600 }) : current.summary,
      notes: "notes" in patch ? str(patch.notes, { field: "الملاحظات", max: 4000, multiline: true }) : current.notes,
      blocker: "blocker" in patch ? str(patch.blocker, { field: "العائق", max: 300 }) : current.blocker
    };
    if (next.status === "blocked" && !next.blocker) throw bad("validation", "المشروع المتعطّل يحتاج وصفًا للعائق");
    if ("focus" in patch) {
      if (typeof patch.focus !== "boolean") throw bad("validation", "قيمة التركيز يجب أن تكون نعم أو لا");
      next.focus = patch.focus ? 1 : 0;
      if (next.focus && !current.focus && db.get("SELECT COUNT(*) AS n FROM projects WHERE focus = 1").n >= MAX_FOCUS) throw bad("focus-limit", "الحد الأقصى ثلاثة مشاريع تركيز؛ أزل مشروعًا أولًا");
    } else next.focus = current.focus;
    const changed = Object.keys(next).filter((key) => next[key] !== current[key]);
    db.tx(() => {
      db.run("UPDATE projects SET name=?, status=?, priority=?, summary=?, notes=?, blocker=?, focus=?, updated_at=? WHERE id=?", next.name, next.status, next.priority, next.summary, next.notes, next.blocker, next.focus, at(), current.id);
      if ("agents" in patch) {
        if (!Array.isArray(patch.agents) || !patch.agents.every((a) => isActiveAgent(a))) throw bad("validation", "قائمة الوكلاء غير صالحة (وكيل غير موجود أو معطل)");
        db.run("DELETE FROM agent_projects WHERE project_id = ?", current.id);
        for (const agentId of new Set(patch.agents)) db.run("INSERT INTO agent_projects (agent_id, project_id) VALUES (?,?)", agentId, current.id);
        changed.push("agents");
      }
      if (changed.length) log({ actorType: actor.type, actorId: actor.id, action: "project.updated", targetType: "project", targetId: current.id, summary: `تحديث المشروع ${next.name}: ${changed.join("، ")}`, metadata: { changed } });
    });
    if (next.status === "blocked") raise({ key: `project-blocked:${current.id}`, level: "warning", kind: "project-blocked", title: `مشروع متعطّل: ${next.name}`, body: next.blocker, targetType: "project", targetId: current.id });
    else resolveStale(`project-blocked`, new Set(db.all("SELECT id FROM projects WHERE status = 'blocked'").map((p) => `project-blocked:${p.id}`)));
    return getProject(current.id);
  }
  function addMilestone(projectId, input) {
    const project = db.get("SELECT id, name FROM projects WHERE id = ?", String(projectId));
    if (!project) throw notFound("المشروع");
    const id = newId("ms");
    db.tx(() => {
      db.run("INSERT INTO milestones (id, project_id, title, due_date, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", id, project.id, str(input.title, { field: "العنوان", max: 160, required: true }), date(input.dueDate, "dueDate"), "open", at(), at());
      log({ action: "milestone.created", targetType: "project", targetId: project.id, summary: `مرحلة جديدة في ${project.name}` });
    });
    return getProject(project.id);
  }
  function updateMilestone(id, patch) {
    const row = db.get("SELECT * FROM milestones WHERE id = ?", String(id));
    if (!row) throw notFound("المرحلة");
    db.tx(() => {
      db.run("UPDATE milestones SET status = ?, due_date = ?, updated_at = ? WHERE id = ?", oneOf(patch.status, ["open", "done"], "status", row.status), "dueDate" in patch ? date(patch.dueDate, "dueDate") : row.due_date, at(), row.id);
      log({ action: "milestone.updated", targetType: "project", targetId: row.project_id, summary: `تحديث مرحلة: ${row.title}` });
    });
    return getProject(row.project_id);
  }

  // ---------------- GitHub identity (renamed accounts / transferred repositories)
  const IDENTITY_RECHECK_MS = { confirmed: 7 * 86_400_000, "not-found": 86_400_000, unavailable: 3_600_000 };
  /** Maps an observed owner/name to GitHub's confirmed current full_name; anything unconfirmed is returned unchanged. */
  function canonicalGithub(github) {
    if (!github) return github;
    const row = db.get("SELECT canonical FROM github_identities WHERE slug = ? AND state = 'confirmed'", github.toLowerCase());
    return row?.canonical || github;
  }
  function identitiesToResolve(slugs) {
    const due = [];
    for (const slug of new Set(slugs.filter(Boolean).map((s) => s.toLowerCase()))) {
      const row = db.get("SELECT state, resolved_at FROM github_identities WHERE slug = ?", slug);
      if (!row || now().getTime() - Date.parse(row.resolved_at) > IDENTITY_RECHECK_MS[row.state]) due.push(slug);
    }
    return due;
  }
  function recordGithubIdentity({ slug, state, canonical = null, repoId = null }) {
    const key = String(slug).toLowerCase();
    const clean = state === "confirmed" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(canonical || "") ? canonical : null;
    db.run("INSERT INTO github_identities (slug, canonical, repo_id, state, resolved_at) VALUES (?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET canonical = excluded.canonical, repo_id = excluded.repo_id, state = excluded.state, resolved_at = excluded.resolved_at",
      key, clean, Number.isInteger(repoId) ? repoId : null, clean ? "confirmed" : state === "not-found" ? "not-found" : "unavailable", at());
    return clean && clean.toLowerCase() !== key ? reconcileAlias(key, clean, repoId) : null;
  }
  /** One repository, one project: folds a project stored under an old owner/name into GitHub's current identity. All
   * references are re-pointed in one transaction; the superseded row is recorded in the activity log before removal. */
  function reconcileAlias(aliasSlug, canonical, repoId = null) {
    const aliasId = `gh:${aliasSlug.toLowerCase()}`;
    const canonicalId = `gh:${canonical.toLowerCase()}`;
    return db.tx(() => {
      const alias = db.get("SELECT * FROM projects WHERE id = ?", aliasId);
      if (!alias) return null;
      let target = db.get("SELECT * FROM projects WHERE id = ?", canonicalId);
      const mode = target ? "merged" : "renamed";
      if (!target) {
        db.run("INSERT INTO projects (id, name, github, catalog_name, status, priority, summary, notes, blocker, source, created_at, updated_at, focus) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          canonicalId, alias.source === "workspace" ? text(canonical.split("/")[1], 120) : alias.name, canonical, alias.catalog_name, alias.status, alias.priority, alias.summary, alias.notes, alias.blocker, alias.source, alias.created_at, at(), alias.focus);
      } else {
        // The owner's later explicit edit wins for status/priority; empty fields are filled, never overwritten.
        const aliasEdited = alias.updated_at > alias.created_at && alias.updated_at > target.updated_at;
        db.run("UPDATE projects SET status = ?, priority = ?, blocker = ?, summary = COALESCE(summary, ?), notes = COALESCE(notes, ?), focus = MAX(focus, ?), updated_at = ? WHERE id = ?",
          aliasEdited ? alias.status : target.status, aliasEdited ? alias.priority : target.priority, aliasEdited ? alias.blocker : (target.blocker ?? alias.blocker),
          alias.summary, alias.notes, alias.focus, at(), canonicalId);
      }
      for (const sql of [
        "UPDATE project_checkouts SET project_id = ?2 WHERE project_id = ?1",
        "UPDATE milestones SET project_id = ?2 WHERE project_id = ?1",
        "INSERT OR IGNORE INTO agent_projects (agent_id, project_id) SELECT agent_id, ?2 FROM agent_projects WHERE project_id = ?1",
        "UPDATE tasks SET project_id = ?2 WHERE project_id = ?1",
        "UPDATE agent_runs SET project_id = ?2 WHERE project_id = ?1",
        "UPDATE usage_events SET project_id = ?2 WHERE project_id = ?1",
        "UPDATE memory_notes SET scope_ref = ?2 WHERE scope = 'project' AND scope_ref = ?1",
        "UPDATE budgets SET scope_ref = ?2 WHERE scope = 'project' AND scope_ref = ?1 AND NOT EXISTS (SELECT 1 FROM budgets b WHERE b.scope = 'project' AND b.scope_ref = ?2 AND b.period = budgets.period)",
        "UPDATE activity_events SET target_id = ?2 WHERE target_type = 'project' AND target_id = ?1",
        "UPDATE notifications SET target_id = ?2 WHERE target_type = 'project' AND target_id = ?1"
      ]) db.run(sql, aliasId, canonicalId);
      const orphanBudgets = db.all("SELECT * FROM budgets WHERE scope = 'project' AND scope_ref = ?", aliasId);
      db.run("DELETE FROM budgets WHERE scope = 'project' AND scope_ref = ?", aliasId);
      db.run("DELETE FROM projects WHERE id = ?", aliasId);
      target = db.get("SELECT name FROM projects WHERE id = ?", canonicalId);
      log({ actorType: "system", actorId: "github-identity", action: `project.${mode}`, targetType: "project", targetId: canonicalId,
        summary: `توحيد هوية المشروع: ${alias.github} ← ${canonical} (نفس المستودع على GitHub)`,
        metadata: { alias: aliasId, canonical: canonicalId, repoId, evidence: "GitHub API redirect to the same repository id", superseded: projectRow(alias), supersededBudgets: orphanBudgets } });
      return { mode, alias: aliasId, canonical: canonicalId, name: target.name };
    });
  }

  /** Reconciles discovered checkouts and the public catalog into company projects. Never deletes; never auto-links by name. */
  function syncProjects({ catalog = [], owner = "", repos = [] }) {
    const result = { created: 0, linked: 0, duplicates: [] };
    db.tx(() => {
      for (const entry of catalog) {
        const github = `${owner}/${entry.name}`;
        const id = `gh:${github.toLowerCase()}`;
        const exists = db.get("SELECT id, catalog_name FROM projects WHERE id = ?", id);
        if (!exists) {
          db.run("INSERT INTO projects (id, name, github, catalog_name, status, priority, summary, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            id, text(entry.name, 120), github, text(entry.name, 120), "active", "medium", entry.summary ? text(entry.summary, 600) : null, "catalog", at(), at());
          result.created++;
        } else if (!exists.catalog_name) db.run("UPDATE projects SET catalog_name = ? WHERE id = ?", text(entry.name, 120), id);
      }
      const seenGithub = new Map();
      for (const repo of repos) {
        if (repo.state !== "ready") continue;
        const manual = db.get("SELECT project_id FROM project_checkouts WHERE rel = ? AND link = 'manual'", repo.rel);
        if (manual) { db.run("UPDATE project_checkouts SET observed_at = ? WHERE rel = ?", at(), repo.rel); continue; }
        const github = canonicalGithub(repo.remote?.github);
        if (!github) continue; // local-only checkouts are listed but only become projects through an explicit link
        const id = `gh:${github.toLowerCase()}`;
        if (!db.get("SELECT id FROM projects WHERE id = ?", id)) {
          db.run("INSERT INTO projects (id, name, github, catalog_name, status, priority, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            id, text(github.split("/")[1], 120), github, null, "active", "medium", "workspace", at(), at());
          result.created++;
        }
        const prior = db.get("SELECT project_id FROM project_checkouts WHERE rel = ?", repo.rel);
        if (!prior) { db.run("INSERT INTO project_checkouts (rel, project_id, link, observed_at) VALUES (?,?,?,?)", repo.rel, id, "remote", at()); result.linked++; }
        else db.run("UPDATE project_checkouts SET observed_at = ?, project_id = ? WHERE rel = ? AND link = 'remote'", at(), id, repo.rel);
        seenGithub.set(id, [...(seenGithub.get(id) ?? []), repo.rel]);
      }
      for (const [id, rels] of seenGithub) if (rels.length > 1) result.duplicates.push({ projectId: id, checkouts: rels });
      if (result.created || result.linked) log({ actorType: "system", actorId: "workspace-sync", action: "projects.synced", targetType: "project", summary: `مزامنة المشاريع: ${result.created} جديد، ${result.linked} نسخة محلية مربوطة`, metadata: result });
    });
    return result;
  }
  function linkCheckout(rel, projectId) {
    const cleanRel = str(rel, { field: "rel", max: 200, required: true });
    if (!/^[A-Za-z0-9._ \/()-]+$/.test(cleanRel) || cleanRel.includes("..")) throw bad("validation", "مسار نسبي غير صالح");
    if (projectId == null) {
      db.tx(() => { db.run("DELETE FROM project_checkouts WHERE rel = ?", cleanRel); log({ action: "checkout.unlinked", targetType: "checkout", targetId: cleanRel, summary: `فك ربط النسخة المحلية ${cleanRel}` }); });
      return { rel: cleanRel, projectId: null };
    }
    const project = db.get("SELECT id, name FROM projects WHERE id = ?", String(projectId));
    if (!project) throw notFound("المشروع");
    db.tx(() => {
      db.run("INSERT INTO project_checkouts (rel, project_id, link, observed_at) VALUES (?,?,?,?) ON CONFLICT(rel) DO UPDATE SET project_id = excluded.project_id, link = 'manual', observed_at = excluded.observed_at", cleanRel, project.id, "manual", at());
      log({ action: "checkout.linked", targetType: "project", targetId: project.id, summary: `ربط يدوي: ${cleanRel} ← ${project.name}` });
    });
    return { rel: cleanRel, projectId: project.id };
  }

  // ---------------- tasks
  const taskRow = (row) => row && ({
    id: row.id, title: row.title, description: row.description, projectId: row.project_id, assignee: row.assignee, priority: row.priority, status: row.status,
    dueDate: row.due_date, startDate: row.start_date, estimateHours: row.estimate_hours, tags: parseJson(row.tags, []), dependsOn: parseJson(row.depends_on, []),
    blocker: row.blocker, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at, archivedAt: row.archived_at
  });
  function listTasks({ status = null, projectId = null, assignee = null, includeClosed = true, includeArchived = false, archivedOnly = false, limit = 500 } = {}) {
    const where = [], params = [];
    if (archivedOnly) where.push("archived_at IS NOT NULL");
    else if (!includeArchived) where.push("archived_at IS NULL");
    if (status) { where.push("status = ?"); params.push(oneOf(status, TASK_STATUSES, "status")); }
    if (projectId) { where.push("project_id = ?"); params.push(String(projectId)); }
    if (assignee) { where.push("assignee = ?"); if (!["owner", "none"].includes(assignee) && !agentById(assignee)) throw bad("validation", "Invalid agent"); params.push(assignee); }
    if (!includeClosed) where.push("status NOT IN ('done','cancelled')");
    return db.all(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'todo' THEN 2 WHEN 'review' THEN 3 WHEN 'backlog' THEN 4 ELSE 5 END,
      CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, COALESCE(due_date, '9999-12-31'), created_at LIMIT ?`, ...params, Math.min(Number(limit) || 500, 2000)).map(taskRow);
  }
  function getTask(id) {
    const row = db.get("SELECT * FROM tasks WHERE id = ?", String(id));
    if (!row) throw notFound("المهمة");
    return { ...taskRow(row), events: db.all("SELECT at, actor, kind, detail FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 50", row.id).map((e) => ({ ...e, detail: parseJson(e.detail, null) })) };
  }
  function ensureProject(projectId) {
    if (projectId == null || projectId === "") return null;
    const project = db.get("SELECT id FROM projects WHERE id = ?", String(projectId));
    if (!project) throw bad("validation", "المشروع المحدد غير موجود", { field: "projectId" });
    return project.id;
  }
  function createTask(input, actor = { type: "owner", id: "owner" }, { externalRef = null, source = null } = {}) {
    if (externalRef) {
      const existing = db.get("SELECT id FROM tasks WHERE external_ref = ?", externalRef);
      if (existing) return { ...getTask(existing.id), deduplicated: true };
    }
    const id = newId("tsk");
    const title = str(input.title, { field: "العنوان", max: 160, required: true });
    const status = oneOf(input.status, TASK_STATUSES, "status", "todo");
    const blocker = str(input.blocker, { field: "العائق", max: 300 });
    if (status === "blocked" && !blocker) throw bad("validation", "المهمة المتعطّلة تحتاج وصفًا للعائق");
    const record = {
      title, description: str(input.description, { field: "الوصف", max: 4000, multiline: true }), projectId: ensureProject(input.projectId),
      assignee: validateAssignee(input.assignee, "assignee", "owner"), priority: oneOf(input.priority, PRIORITIES, "priority", "medium"), status,
      dueDate: date(input.dueDate, "dueDate"), startDate: date(input.startDate, "startDate"), estimateHours: numberIn(input.estimateHours, "estimateHours", 0, 1000),
      tags: tags(input.tags), dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn.filter((d) => typeof d === "string" && db.get("SELECT id FROM tasks WHERE id = ?", d)).slice(0, 10) : []
    };
    db.tx(() => {
      db.run(`INSERT INTO tasks (id, title, description, project_id, assignee, priority, status, due_date, start_date, estimate_hours, tags, depends_on, blocker, source, external_ref, created_at, updated_at, completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, record.title, record.description, record.projectId, record.assignee, record.priority, record.status, record.dueDate, record.startDate,
      record.estimateHours, JSON.stringify(record.tags), JSON.stringify(record.dependsOn), blocker, source ?? (actor.type === "agent" ? `agent:${actor.id}` : actor.type), externalRef, at(), at(), status === "done" ? at() : null);
      db.run("INSERT INTO task_events (task_id, at, actor, kind, detail) VALUES (?,?,?,?,?)", id, at(), `${actor.type}:${actor.id}`, "created", JSON.stringify({ status, assignee: record.assignee }));
      log({ actorType: actor.type, actorId: actor.id, action: "task.created", targetType: "task", targetId: id, summary: `مهمة جديدة: ${title}`, metadata: { projectId: record.projectId, assignee: record.assignee } });
      if (record.projectId) log({ actorType: actor.type, actorId: actor.id, action: "task.created", targetType: "project", targetId: record.projectId, summary: `مهمة جديدة في المشروع: ${title}` });
    });
    return getTask(id);
  }
  function updateTask(id, patch, actor = { type: "owner", id: "owner" }) {
    const row = db.get("SELECT * FROM tasks WHERE id = ?", String(id));
    if (!row) throw notFound("المهمة");
    if (row.archived_at) throw new HttpError(409, "task-archived", "استعد المهمة من الأرشيف قبل تعديلها");
    const current = taskRow(row);
    const next = { ...current };
    if ("title" in patch) next.title = str(patch.title, { field: "العنوان", max: 160, required: true });
    if ("description" in patch) next.description = str(patch.description, { field: "الوصف", max: 4000, multiline: true });
    if ("projectId" in patch) next.projectId = ensureProject(patch.projectId);
    if ("assignee" in patch) next.assignee = validateAssignee(patch.assignee, "assignee");
    if ("priority" in patch) next.priority = oneOf(patch.priority, PRIORITIES, "priority");
    if ("status" in patch) next.status = oneOf(patch.status, TASK_STATUSES, "status");
    if ("dueDate" in patch) next.dueDate = date(patch.dueDate, "dueDate");
    if ("startDate" in patch) next.startDate = date(patch.startDate, "startDate");
    if ("estimateHours" in patch) next.estimateHours = numberIn(patch.estimateHours, "estimateHours", 0, 1000);
    if ("tags" in patch) next.tags = tags(patch.tags);
    if ("blocker" in patch) next.blocker = str(patch.blocker, { field: "العائق", max: 300 });
    if (next.status === "blocked" && !next.blocker) throw bad("validation", "المهمة المتعطّلة تحتاج وصفًا للعائق");
    if (next.status !== "blocked" && "status" in patch && !("blocker" in patch)) next.blocker = null;
    const changed = ["title", "description", "projectId", "assignee", "priority", "status", "dueDate", "startDate", "estimateHours", "blocker"].filter((key) => next[key] !== current[key]);
    if (JSON.stringify(next.tags) !== JSON.stringify(current.tags)) changed.push("tags");
    if (!changed.length) return getTask(row.id);
    const completedAt = next.status === "done" ? (current.completedAt ?? at()) : null;
    db.tx(() => {
      db.run(`UPDATE tasks SET title=?, description=?, project_id=?, assignee=?, priority=?, status=?, due_date=?, start_date=?, estimate_hours=?, tags=?, blocker=?, updated_at=?, completed_at=? WHERE id=?`,
        next.title, next.description, next.projectId, next.assignee, next.priority, next.status, next.dueDate, next.startDate, next.estimateHours, JSON.stringify(next.tags), next.blocker, at(), completedAt, row.id);
      const detail = Object.fromEntries(changed.map((key) => [key, { from: current[key] ?? null, to: next[key] ?? null }]));
      db.run("INSERT INTO task_events (task_id, at, actor, kind, detail) VALUES (?,?,?,?,?)", row.id, at(), `${actor.type}:${actor.id}`, "updated", JSON.stringify(detail));
      const action = changed.includes("status") ? (next.status === "done" ? "task.completed" : "task.status") : changed.includes("assignee") ? "task.assigned" : "task.updated";
      log({ actorType: actor.type, actorId: actor.id, action, targetType: "task", targetId: row.id, summary: `${next.title}: ${changed.join("، ")}`, metadata: detail });
    });
    return getTask(row.id);
  }

  function setTaskArchived(id, archived, actor = { type: "owner", id: "owner" }) {
    const row = db.get("SELECT id, title, archived_at FROM tasks WHERE id = ?", String(id));
    if (!row) throw notFound("المهمة");
    if (Boolean(row.archived_at) === archived) return getTask(row.id);
    if (archived && db.get("SELECT id FROM agent_runs WHERE task_id = ? AND status IN ('queued','running') LIMIT 1", row.id)) throw new HttpError(409, "task-active-run", "لا يمكن أرشفة مهمة يعمل عليها وكيل الآن");
    db.tx(() => {
      db.run("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?", archived ? at() : null, at(), row.id);
      db.run("INSERT INTO task_events (task_id, at, actor, kind, detail) VALUES (?,?,?,?,?)", row.id, at(), `${actor.type}:${actor.id}`, archived ? "archived" : "restored", null);
      log({ actorType: actor.type, actorId: actor.id, action: archived ? "task.archived" : "task.restored", targetType: "task", targetId: row.id, summary: `${archived ? "أرشفة" : "استعادة"} المهمة: ${row.title}` });
    });
    return getTask(row.id);
  }

  // ---------------- agents
  function agentConfig(id) {
    const def = agentById(id);
    if (!def) throw notFound("الوكيل");
    const row = db.get("SELECT * FROM agents WHERE id = ?", id);
    return {
      id: def.id, enabled: row.enabled === 1 && row.active === 1, mode: row.mode, instructions: row.instructions, policyDomain: row.policy_domain,
      modelOverride: row.model_override, tools: parseJson(row.tools, def.tools), updatedAt: row.updated_at,
      projects: db.all("SELECT project_id FROM agent_projects WHERE agent_id = ?", id).map((r) => r.project_id)
    };
  }
  function updateAgent(id, patch) {
    const def = agentById(id);
    if (!def) throw notFound("الوكيل");
    const current = agentConfig(id);
    const next = { ...current };
    if ("enabled" in patch) next.enabled = patch.enabled === true;
    if ("mode" in patch) next.mode = oneOf(patch.mode, Object.keys(MODES), "mode");
    if ("instructions" in patch) next.instructions = str(patch.instructions, { field: "التعليمات", max: 4000, multiline: true }) ?? "";
    if ("policyDomain" in patch) next.policyDomain = oneOf(patch.policyDomain, Object.keys(DOMAINS), "policyDomain");
    if ("modelOverride" in patch) {
      if (patch.modelOverride == null || patch.modelOverride === "") next.modelOverride = null;
      else if (typeof patch.modelOverride !== "string" || !MODEL_REF.test(patch.modelOverride)) throw bad("validation", "مرجع النموذج غير صالح");
      else next.modelOverride = patch.modelOverride;
    }
    if ("tools" in patch) {
      // An agent can only be narrowed to a subset of its reviewed tool set; nothing grants it new tools.
      if (!Array.isArray(patch.tools) || !patch.tools.every((tool) => def.tools.includes(tool))) throw bad("tool-not-permitted", "لا يمكن منح الوكيل أداة خارج مجموعة أدواته المعتمدة");
      next.tools = [...new Set(patch.tools)];
    }
    // REX keeps its constraints regardless of mode: strict or analytical only.
    if (id === "rex" && !["strict", "analytical"].includes(next.mode)) throw bad("mode-not-permitted", "REX يعمل في الوضع الصارم أو التحليلي فقط");
    db.tx(() => {
      db.run("UPDATE agents SET enabled=?, mode=?, instructions=?, policy_domain=?, model_override=?, tools=?, updated_at=? WHERE id=?",
        next.enabled ? 1 : 0, next.mode, next.instructions, next.policyDomain, next.modelOverride, JSON.stringify(next.tools), at(), id);
      if ("projects" in patch) {
        if (!Array.isArray(patch.projects)) throw bad("validation", "قائمة المشاريع غير صالحة");
        db.run("DELETE FROM agent_projects WHERE agent_id = ?", id);
        for (const projectId of new Set(patch.projects)) db.run("INSERT INTO agent_projects (agent_id, project_id) VALUES (?,?)", id, ensureProject(projectId));
      }
      log({ action: "agent.configured", targetType: "agent", targetId: id, summary: `تحديث إعدادات ${def.name}`, metadata: { fields: Object.keys(patch) } });
    });
    return agentConfig(id);
  }

  // ---------------- runs + usage
  const runRow = (row) => row && ({
    id: row.id, agentId: row.agent_id, taskId: row.task_id, projectId: row.project_id, conversationId: row.conversation_id, workflowId: row.workflow_id, parentRunId: row.parent_run_id,
    capability: row.capability, domain: row.domain, mode: row.mode, priority: row.priority, request: row.request, status: row.status,
    requestedModel: row.requested_model, effectiveModel: row.effective_model, provider: row.provider, connectionId: row.connection_id ? row.connection_id.slice(0, 8) : null,
    routing: parseJson(row.routing, null), promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens, reasoningTokens: row.reasoning_tokens,
    costUsd: row.cost_usd, costBasis: row.cost_basis, latencyMs: row.latency_ms, attempts: row.attempts, errorCategory: row.error_category, errorMessage: row.error_message,
    output: row.output, toolSelection: parseJson(row.tool_selection, {}), actionsAr: parseJson(row.actions_ar, []), toolCalls: parseJson(row.tool_calls, []), approvalId: row.approval_id, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at
  });
  function listRuns({ agentId = null, status = null, workflowId = null, taskId = null, projectId = null, limit = 50 } = {}) {
    const where = [], params = [];
    if (agentId) { where.push("agent_id = ?"); params.push(agentId); }
    if (status) { where.push("status = ?"); params.push(status); }
    if (workflowId) { where.push("workflow_id = ?"); params.push(workflowId); }
    if (taskId) { where.push("task_id = ?"); params.push(taskId); }
    if (projectId) { where.push("project_id = ?"); params.push(projectId); }
    return db.all(`SELECT * FROM agent_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`, ...params, Math.min(Number(limit) || 50, 300)).map(runRow);
  }
  function getRun(id) {
    const row = db.get("SELECT * FROM agent_runs WHERE id = ?", String(id));
    if (!row) throw notFound("التشغيل");
    return runRow(row);
  }
  function usageWhere(sinceIso, { agentId = null, projectId = null, provider = null } = {}) {
    const where = ["at >= ?"], params = [sinceIso];
    if (agentId) { where.push("agent_id = ?"); params.push(agentId); }
    if (projectId) { where.push("project_id = ?"); params.push(projectId); }
    if (provider) { where.push("provider = ?"); params.push(provider); }
    return { where, params };
  }
  function usageSince(sinceIso, filter = {}) {
    const { where, params } = usageWhere(sinceIso, filter);
    const row = db.get(`SELECT COUNT(*) AS runs, COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END),0) AS unknownCost FROM usage_events WHERE ${where.join(" AND ")}`, ...params);
    // costUsd sums only events with a router-reported estimate; unknownCostEvents must be shown as unknown, never as $0.
    return { runs: row.runs, promptTokens: row.prompt, completionTokens: row.completion, tokens: row.prompt + row.completion, costUsd: row.cost, unknownCostEvents: row.unknownCost };
  }
  /** Paid-class events that lack the measure a budget limits: no router cost for a USD limit, or no token counts (stored as
   * 0/0) for a token limit. Their real spend is unknown, so that budget cannot be verified for further paid inference. */
  function unverifiedPaidSince(sinceIso, filter, { usd, tokens }) {
    if (!usd && !tokens) return 0;
    const { where, params } = usageWhere(sinceIso, filter);
    return db.all(`SELECT model, cost_usd, prompt_tokens, completion_tokens FROM usage_events WHERE ${where.join(" AND ")}`, ...params)
      .filter((e) => CLASS_INFO[modelClass(e.model)]?.paid && ((usd && e.cost_usd == null) || (tokens && !e.prompt_tokens && !e.completion_tokens))).length;
  }
  function usageByAgent(sinceIso) {
    return db.all("SELECT agent_id AS agentId, COUNT(*) AS runs, COALESCE(SUM(prompt_tokens + completion_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS costUsd, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknownCostEvents FROM usage_events WHERE at >= ? GROUP BY agent_id", sinceIso);
  }
  function usageByModel(sinceIso) {
    return db.all("SELECT provider, model, COUNT(*) AS runs, COALESCE(SUM(prompt_tokens + completion_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS costUsd, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknownCostEvents FROM usage_events WHERE at >= ? GROUP BY provider, model ORDER BY runs DESC", sinceIso);
  }

  // ---------------- budgets
  function listBudgets() {
    const tz = settings().timezone;
    return db.all("SELECT * FROM budgets ORDER BY scope, scope_ref, period").map((row) => {
      const since = periodStart(row.period, now(), tz).toISOString();
      const filter = row.scope === "agent" ? { agentId: row.scope_ref } : row.scope === "project" ? { projectId: row.scope_ref } : row.scope === "provider" ? { provider: row.scope_ref } : {};
      const spent = usageSince(since, filter);
      const costPct = row.limit_usd ? (spent.costUsd / row.limit_usd) * 100 : null;
      const tokenPct = row.token_limit ? (spent.tokens / row.token_limit) * 100 : null;
      const pct = Math.max(costPct ?? 0, tokenPct ?? 0);
      const unverifiedPaidEvents = unverifiedPaidSince(since, filter, { usd: row.limit_usd != null, tokens: row.token_limit != null });
      const state = !row.enabled ? "disabled" : pct >= 100 ? "exceeded" : unverifiedPaidEvents ? "unverified" : pct >= row.warn_pct ? "warning" : "ok";
      return { id: row.id, scope: row.scope, scopeRef: row.scope_ref, period: row.period, limitUsd: row.limit_usd, tokenLimit: row.token_limit, warnPct: row.warn_pct, hardStop: row.hard_stop === 1, enabled: row.enabled === 1,
        periodStart: since, spent, costPct, tokenPct, unverifiedPaidEvents, state, basis: "application-measured runs; cost is the router's per-response estimate" };
    });
  }
  function upsertBudget(input) {
    const scope = oneOf(input.scope, ["company", "agent", "project", "provider"], "scope");
    let scopeRef = "";
    if (scope === "agent") { if (!isActiveAgent(input.scopeRef)) throw bad("validation", "Invalid agent"); scopeRef = input.scopeRef; }
    else if (scope === "project") scopeRef = ensureProject(input.scopeRef) ?? (() => { throw bad("validation", "المشروع مطلوب"); })();
    else if (scope === "provider") scopeRef = str(input.scopeRef, { field: "provider", max: 40, required: true });
    const period = oneOf(input.period, ["daily", "weekly", "monthly"], "period");
    const limitUsd = numberIn(input.limitUsd, "limitUsd", 0, 100_000);
    const tokenLimit = numberIn(input.tokenLimit, "tokenLimit", 0, 10_000_000_000, { integer: true });
    if (limitUsd == null && tokenLimit == null) throw bad("validation", "حدّد سقفًا ماليًا أو حد رموز");
    const warnPct = numberIn(input.warnPct ?? 80, "warnPct", 1, 100, { nullable: false });
    const id = input.id && /^bud_[a-z0-9_]{1,40}$/.test(input.id) ? input.id : newId("bud");
    db.tx(() => {
      db.run(`INSERT INTO budgets (id, scope, scope_ref, period, limit_usd, token_limit, warn_pct, hard_stop, enabled, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(scope, scope_ref, period) DO UPDATE SET limit_usd=excluded.limit_usd, token_limit=excluded.token_limit, warn_pct=excluded.warn_pct, hard_stop=excluded.hard_stop, enabled=excluded.enabled, updated_at=excluded.updated_at`,
      id, scope, scopeRef, period, limitUsd, tokenLimit, warnPct, input.hardStop === false ? 0 : 1, input.enabled === false ? 0 : 1, at());
      log({ action: "budget.updated", targetType: "budget", targetId: `${scope}:${scopeRef}:${period}`, summary: `ميزانية ${scope}${scopeRef ? ` (${scopeRef})` : ""} ${period}: ${limitUsd ?? "—"}$ / ${tokenLimit ?? "—"} رمز` });
    });
    return listBudgets();
  }
  function deleteBudget(id) {
    const row = db.get("SELECT * FROM budgets WHERE id = ?", String(id));
    if (!row) throw notFound("الميزانية");
    db.tx(() => { db.run("DELETE FROM budgets WHERE id = ?", row.id); log({ action: "budget.deleted", targetType: "budget", targetId: row.id, summary: `حذف ميزانية ${row.scope} ${row.period}` }); });
    return listBudgets();
  }
  /** Budgets that apply to a prospective run. "blocking" are enabled hard-stop budgets already at/over 100% and, for a paid
   * candidate, hard-stop budgets whose spend is unverified (fail closed: absent cost telemetry must never read as $0). */
  function budgetGate({ agentId, projectId, provider, paid = false }) {
    const relevant = listBudgets().filter((b) => b.enabled && (b.scope === "company" || (b.scope === "agent" && b.scopeRef === agentId) || (b.scope === "project" && b.scopeRef === projectId) || (b.scope === "provider" && b.scopeRef === provider)));
    const blocking = relevant.filter((b) => b.hardStop && (b.state === "exceeded" || (paid && b.unverifiedPaidEvents > 0)))
      .map((b) => ({ ...b, blockReason: b.state === "exceeded" ? "exceeded" : "unverified" }));
    return { relevant, blocking, warning: relevant.filter((b) => b.state === "warning" || b.state === "unverified") };
  }

  // ---------------- routing policies
  const policyRow = (row) => ({ domain: row.domain, labelAr: DOMAINS[row.domain] ?? row.domain, candidates: parseJson(row.candidates, []), allowClasses: parseJson(row.allow_classes, []), maxCostUsd: row.max_cost_usd,
    maxRetries: row.max_retries, quotaProtectPct: row.quota_protect_pct, approval: row.approval, maxOutputTokens: row.max_output_tokens, updatedAt: row.updated_at });
  const listPolicies = () => db.all("SELECT * FROM routing_policies ORDER BY domain").map(policyRow);
  function getPolicy(domain) {
    const row = db.get("SELECT * FROM routing_policies WHERE domain = ?", domain);
    if (!row) throw notFound("سياسة التوجيه");
    return policyRow(row);
  }
  function updatePolicy(domain, patch) {
    const current = getPolicy(domain);
    const next = { ...current };
    if ("candidates" in patch) {
      if (!Array.isArray(patch.candidates) || patch.candidates.length < 1 || patch.candidates.length > 8 || !patch.candidates.every((c) => typeof c === "string" && MODEL_REF.test(c) && c.includes("/"))) throw bad("validation", "المرشحون: من 1 إلى 8 مراجع نماذج بصيغة provider/model");
      next.candidates = [...new Set(patch.candidates)];
    }
    if ("allowClasses" in patch) {
      if (!Array.isArray(patch.allowClasses) || !patch.allowClasses.every((c) => Object.hasOwn(CLASS_INFO, c) && c !== "restricted" && c !== "unknown")) throw bad("validation", "فئات الفوترة غير صالحة (الفئة المقيّدة لا يمكن السماح بها)");
      next.allowClasses = [...new Set(patch.allowClasses)];
    }
    if ("maxCostUsd" in patch) next.maxCostUsd = numberIn(patch.maxCostUsd, "maxCostUsd", 0, 100);
    if ("maxRetries" in patch) next.maxRetries = numberIn(patch.maxRetries, "maxRetries", 0, 3, { integer: true, nullable: false });
    if ("quotaProtectPct" in patch) next.quotaProtectPct = numberIn(patch.quotaProtectPct, "quotaProtectPct", 0, 100, { nullable: false });
    if ("approval" in patch) next.approval = oneOf(patch.approval, ["none", "paid", "always"], "approval");
    if ("maxOutputTokens" in patch) next.maxOutputTokens = numberIn(patch.maxOutputTokens, "maxOutputTokens", 64, 16000, { integer: true, nullable: false });
    // Paid (metered) classes always require at least per-run approval for paid inference.
    if (next.allowClasses.includes("metered") && next.approval === "none") throw bad("validation", "السماح بالفئة المدفوعة يتطلب موافقة على الاستدلال المدفوع");
    db.tx(() => {
      db.run("UPDATE routing_policies SET candidates=?, allow_classes=?, max_cost_usd=?, max_retries=?, quota_protect_pct=?, approval=?, max_output_tokens=?, updated_at=? WHERE domain=?",
        JSON.stringify(next.candidates), JSON.stringify(next.allowClasses), next.maxCostUsd, next.maxRetries, next.quotaProtectPct, next.approval, next.maxOutputTokens, at(), domain);
      log({ action: "policy.updated", targetType: "policy", targetId: domain, summary: `تحديث سياسة التوجيه: ${DOMAINS[domain]}`, metadata: { before: current, after: next } });
    });
    return getPolicy(domain);
  }

  // ---------------- quota observations
  /** Stores provider-reported windows; a row is written only when the value changed or the last row is older than 1 hour. */
  function recordQuota(overview) {
    if (overview?.connection?.state !== "connected") return { stored: 0, skipped: 0 };
    let stored = 0, skipped = 0;
    const observedAt = overview.generatedAt || at();
    db.tx(() => {
      for (const conn of overview.connections || []) {
        if (conn.quota?.support !== "reported") continue;
        for (const win of conn.quota.windows || []) {
          const last = db.get("SELECT remaining_pct, used, observed_at FROM quota_observations WHERE connection_id = ? AND window_id = ? ORDER BY id DESC LIMIT 1", conn.id, win.id);
          const fresh = last && last.remaining_pct === win.remainingPct && last.used === win.used && Date.parse(observedAt) - Date.parse(last.observed_at) < 3_600_000;
          if (fresh) { skipped++; continue; }
          db.run(`INSERT INTO quota_observations (observed_at, provider, connection_id, window_id, label, model_group, used, total, remaining, remaining_pct, reset_at, window_seconds, state, unit, source_kind, collection_method, confidence)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, observedAt, conn.provider, conn.id, win.id, win.label, win.groupName ?? null, win.used, win.total, win.remaining, win.remainingPct, win.resetAt, win.windowSeconds, win.state, win.unit,
          "provider-reported", "OmniRoute GET /api/usage/{connectionId}", win.remainingPct != null ? "high" : "medium");
          stored++;
        }
      }
    });
    return { stored, skipped };
  }
  function quotaHistory({ sinceIso, connectionId = null } = {}) {
    const rows = db.all(`SELECT observed_at, provider, substr(connection_id,1,8) AS connection, window_id, label, remaining_pct, used, total, reset_at, state FROM quota_observations WHERE observed_at >= ? ${connectionId ? "AND connection_id LIKE ?" : ""} ORDER BY observed_at`,
      ...(connectionId ? [sinceIso, `${connectionId}%`] : [sinceIso]));
    const series = new Map();
    for (const row of rows) {
      const key = `${row.connection}|${row.window_id}`;
      if (!series.has(key)) series.set(key, { key, provider: row.provider, connection: row.connection, windowId: row.window_id, label: row.label, points: [] });
      series.get(key).points.push({ at: row.observed_at, remainingPct: row.remaining_pct, used: row.used, total: row.total, resetAt: row.reset_at, state: row.state });
    }
    const exhaustionEvents = rows.filter((row, index) => row.state === "exhausted" && (index === 0 || rows[index - 1].state !== "exhausted" || rows[index - 1].window_id !== row.window_id));
    return { since: sinceIso, observations: rows.length, series: [...series.values()], exhaustionEvents: exhaustionEvents.map((e) => ({ at: e.observed_at, provider: e.provider, label: e.label, resetAt: e.reset_at })), source: "provider-reported, stored by the bridge" };
  }
  function pruneQuota(days) {
    const cutoff = new Date(now().getTime() - days * 86_400_000).toISOString();
    return Number(db.run("DELETE FROM quota_observations WHERE observed_at < ?", cutoff).changes);
  }
  const lastQuotaObservation = () => db.get("SELECT MAX(observed_at) AS at, COUNT(*) AS n FROM quota_observations");

  // ---------------- approvals
  const approvalRow = (row) => row && ({ id: row.id, kind: row.kind, status: row.status, requestedBy: row.requested_by, title: row.title, summary: row.summary, payload: parseJson(row.payload, null),
    before: parseJson(row.before_state, null), after: parseJson(row.after_state, null), risk: row.risk, createdAt: row.created_at, decidedAt: row.decided_at, decidedBy: row.decided_by, appliedAt: row.applied_at, result: parseJson(row.result, null) });
  function createApproval({ kind, requestedBy, title, summary, payload, before = null, after = null, risk = "medium" }) {
    const id = newId("apr");
    db.tx(() => {
      db.run("INSERT INTO approvals (id, kind, status, requested_by, title, summary, payload, before_state, after_state, risk, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        id, kind, "pending", requestedBy, text(title, 200), summary ? text(summary, 1000) : null, JSON.stringify(payload), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, risk, at());
      log({ actorType: requestedBy.startsWith("agent:") ? "agent" : requestedBy === "owner" ? "owner" : "system", actorId: requestedBy.replace(/^agent:/, ""), action: "approval.requested", targetType: "approval", targetId: id, outcome: "pending", summary: `طلب موافقة: ${title}` });
      raise({ key: `approval:${id}`, level: "warning", kind: "approval", title: `بانتظار موافقتك: ${title}`, body: summary, targetType: "approval", targetId: id });
    });
    return approvalRow(db.get("SELECT * FROM approvals WHERE id = ?", id));
  }
  const listApprovals = ({ status = null } = {}) => db.all(`SELECT * FROM approvals ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 100`, ...(status ? [status] : [])).map(approvalRow);
  function getApproval(id) {
    const row = db.get("SELECT * FROM approvals WHERE id = ?", String(id));
    if (!row) throw notFound("طلب الموافقة");
    return approvalRow(row);
  }
  function setApprovalStatus(id, status, { decidedBy = null, result = null, applied = false } = {}) {
    db.tx(() => {
      db.run(`UPDATE approvals SET status = ?, decided_at = COALESCE(decided_at, ?), decided_by = COALESCE(decided_by, ?), applied_at = CASE WHEN ? THEN ? ELSE applied_at END, result = COALESCE(?, result) WHERE id = ?`,
        status, at(), decidedBy, applied ? 1 : 0, at(), result ? JSON.stringify(result) : null, id);
      resolveStale("approval", new Set(db.all("SELECT id FROM approvals WHERE status = 'pending'").map((a) => `approval:${a.id}`)));
    });
    return getApproval(id);
  }

  // ---------------- memory
  const memoryRow = (m) => ({ id: m.id, scope: m.scope, scopeRef: m.scope_ref, title: m.title, body: m.body, source: m.source, sourceRef: m.source_ref,
    sourceAt: m.source_at, ownerAgent: m.owner_agent, approved: m.approved === 1, confidence: m.confidence, sensitivity: m.sensitivity, version: m.version,
    retentionUntil: m.retention_until, state: m.state, reviewedAt: m.reviewed_at, createdAt: m.created_at, updatedAt: m.updated_at,
    conflictsWith: m.conflicts_with ?? null, conflictState: m.conflict_state ?? null, supersededBy: m.superseded_by ?? null });
  /** Same scope and the same normalized title but different content: a conflict to be decided by the owner. */
  const normalizeTitle = (value) => String(value).toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
  function findConflict({ id = null, scope, scopeRef, title, body }) {
    const key = normalizeTitle(title);
    return db.all("SELECT * FROM memory_notes WHERE scope = ? AND scope_ref = ? AND state = 'active' AND id != ? LIMIT 400", scope, scopeRef ?? "", id ?? "")
      .find((n) => normalizeTitle(n.title) === key && n.body.trim() !== body.trim()) ?? null;
  }
  /** Owner-only resolution. Nothing is deleted: the losing note is archived with `superseded_by`, both keep their
   * provenance, and the decision is logged. "kept-both" clears the flag on both notes. */
  /** Open conflicts with both sides, for the owner review view. */
  function memoryConflicts() {
    return db.all("SELECT * FROM memory_notes WHERE conflict_state = 'open' ORDER BY updated_at DESC LIMIT 50").map((n) => ({ note: memoryRow(n), other: n.conflicts_with ? (db.get("SELECT * FROM memory_notes WHERE id = ?", n.conflicts_with) ? memoryRow(db.get("SELECT * FROM memory_notes WHERE id = ?", n.conflicts_with)) : null) : null }));
  }
  function resolveMemoryConflict(id, decision, actor = { type: "owner", id: "owner" }) {
    if (actor.type !== "owner") throw new HttpError(403, "owner-only", "حسم تعارض الذاكرة للمالك فقط");
    const note = db.get("SELECT * FROM memory_notes WHERE id = ?", String(id));
    if (!note) throw notFound("الملاحظة");
    if (note.conflict_state !== "open" || !note.conflicts_with) throw new HttpError(409, "no-conflict", "لا يوجد تعارض مفتوح لهذه الملاحظة");
    const other = db.get("SELECT * FROM memory_notes WHERE id = ?", note.conflicts_with);
    if (!["kept-new", "kept-existing", "kept-both"].includes(decision)) throw new HttpError(422, "validation", "قرار غير صالح");
    db.tx(() => {
      if (decision === "kept-new") {
        db.run("UPDATE memory_notes SET conflict_state = ?, approved = 1, reviewed_at = ?, updated_at = ? WHERE id = ?", decision, at(), at(), note.id);
        if (other) db.run("UPDATE memory_notes SET state = 'archived', superseded_by = ?, updated_at = ? WHERE id = ?", note.id, at(), other.id);
      } else if (decision === "kept-existing") {
        db.run("UPDATE memory_notes SET conflict_state = ?, state = 'archived', superseded_by = ?, updated_at = ? WHERE id = ?", decision, other?.id ?? null, at(), note.id);
      } else db.run("UPDATE memory_notes SET conflict_state = ?, approved = 1, reviewed_at = ?, updated_at = ? WHERE id = ?", decision, at(), at(), note.id);
      log({ actorType: actor.type, actorId: actor.id, action: "memory.conflict.resolved", targetType: "memory", targetId: note.id, outcome: "info",
        summary: `حسم تعارض الذاكرة «${note.title}»: ${{ "kept-new": "اعتماد الجديد وأرشفة القديم", "kept-existing": "الإبقاء على القديم وأرشفة الجديد", "kept-both": "الإبقاء على الاثنين" }[decision]}`, metadata: { other: other?.id ?? null, decision } });
    });
    return { note: memoryRow(db.get("SELECT * FROM memory_notes WHERE id = ?", note.id)), other: other ? memoryRow(db.get("SELECT * FROM memory_notes WHERE id = ?", other.id)) : null };
  }
  function listMemory({ scope = null, scopeRef = null, state = "active", approved = null, limit = 200 } = {}) {
    const where = [], params = [];
    if (state) { where.push("state = ?"); params.push(state); }
    if (scope) { where.push("scope = ?"); params.push(scope); }
    if (scopeRef != null) { where.push("scope_ref = ?"); params.push(scopeRef); }
    if (approved != null) { where.push("approved = ?"); params.push(approved ? 1 : 0); }
    return db.all(`SELECT * FROM memory_notes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`, ...params, Math.min(Math.max(Number(limit) || 200, 1), 200)).map(memoryRow);
  }
  function upsertMemory(input, actor = { type: "owner", id: "owner" }) {
    const scope = oneOf(input.scope, ["company", "project", "agent"], "scope");
    const scopeRef = scope === "company" ? "" : scope === "agent" ? (isActiveAgent(input.scopeRef) ? input.scopeRef : (() => { throw bad("validation", "Invalid agent"); })()) : ensureProject(input.scopeRef);
    const title = str(input.title, { field: "العنوان", max: 120, required: true });
    const body = str(input.body, { field: "المحتوى", max: 2000, required: true, multiline: true });
    const existing = input.id ? db.get("SELECT * FROM memory_notes WHERE id = ?", String(input.id)) : null;
    if (input.id && !existing) throw notFound("الملاحظة");
    if (existing && actor.type !== "owner") throw new HttpError(403, "memory-owner-review", "تعديل ذاكرة موجودة يحتاج المالك");
    const confidence = oneOf(input.confidence, ["verified", "supported", "unverified"], "confidence", existing?.confidence ?? "unverified");
    const sensitivity = oneOf(input.sensitivity, ["internal", "restricted"], "sensitivity", existing?.sensitivity ?? "internal");
    const state = oneOf(input.state, ["active", "archived"], "state", existing?.state ?? "active");
    const sourceRef = input.sourceRef === undefined ? existing?.source_ref ?? null : str(input.sourceRef, { field: "مرجع المصدر", max: 400 });
    const sourceAt = input.sourceAt === undefined ? existing?.source_at ?? null : input.sourceAt == null ? null : str(input.sourceAt, { field: "وقت المصدر", max: 40 });
    const retentionUntil = input.retentionUntil === undefined ? existing?.retention_until ?? null : input.retentionUntil == null ? null : str(input.retentionUntil, { field: "تاريخ الاحتفاظ", max: 40 });
    const approved = actor.type === "owner" ? (input.approved === undefined ? existing?.approved ?? 1 : input.approved ? 1 : 0) : 0;
    const reviewedAt = actor.type === "owner" && approved ? at() : existing?.reviewed_at ?? null;
    const id = existing?.id ?? newId("mem");
    const conflict = state === "active" ? findConflict({ id, scope, scopeRef, title, body }) : null;
    db.tx(() => {
      if (existing) db.run("UPDATE memory_notes SET scope=?,scope_ref=?,title=?,body=?,approved=?,owner_agent=?,source_ref=?,source_at=?,reviewed_at=?,confidence=?,sensitivity=?,version=version+1,retention_until=?,state=?,updated_at=? WHERE id=?",
        scope, scopeRef ?? "", title, body, approved, scope === "agent" ? scopeRef : existing.owner_agent, sourceRef, sourceAt, reviewedAt, confidence, sensitivity, retentionUntil, state, at(), id);
      else db.run("INSERT INTO memory_notes (id,scope,scope_ref,title,body,source,approved,created_at,updated_at,owner_agent,source_ref,source_at,reviewed_at,confidence,sensitivity,retention_until,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id, scope, scopeRef ?? "", title, body, `${actor.type}:${actor.id}`, approved, at(), at(), scope === "agent" ? scopeRef : actor.type === "agent" ? actor.id : null, sourceRef, sourceAt, reviewedAt, confidence, sensitivity, retentionUntil, state);
      if (conflict && !(existing?.conflict_state && existing.conflict_state !== "open")) {
        db.run("UPDATE memory_notes SET conflicts_with = ?, conflict_state = 'open' WHERE id = ?", conflict.id, id);
        // An agent's conflicting note never replaces owner-confirmed knowledge: it stays pending until the owner decides.
        if (actor.type !== "owner") db.run("UPDATE memory_notes SET approved = 0 WHERE id = ?", id);
        log({ actorType: actor.type, actorId: actor.id, action: "memory.conflict.detected", targetType: "memory", targetId: id, outcome: "info", summary: `تعارض محتمل مع «${conflict.title}» — بانتظار قرار المالك`, metadata: { other: conflict.id } });
      }
      log({ actorType: actor.type, actorId: actor.id, action: existing ? "memory.updated" : "memory.created", targetType: scope === "project" ? "project" : "memory", targetId: scope === "project" ? scopeRef : id, summary: `ذاكرة ${({ company: "الشركة", agent: "الوكيل", project: "المشروع" })[scope] ?? scope}: ${title}` });
    });
    return listMemory({ scope, scopeRef: scopeRef ?? "", state: null });
  }
  function searchMemory({ q, agentId = null, projectId = null, scope = null, scopeRef = null, includePending = false, limit = 20 } = {}) {
    const terms = String(q ?? "").match(/[\p{L}\p{N}_]{2,}/gu)?.slice(0, 8) ?? [];
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
    const where = ["memory_fts MATCH ?", "m.state = 'active'", "(m.retention_until IS NULL OR m.retention_until > ?)"];
    const params = [match, at()];
    if (agentId) {
      if (!isActiveAgent(agentId)) throw bad("validation", "وكيل غير معروف أو معطل");
      where.push("m.approved = 1", "m.sensitivity = 'internal'", "((m.scope = 'company' AND m.scope_ref = '') OR (m.scope = 'agent' AND m.scope_ref = ?) OR (m.scope = 'project' AND m.scope_ref = ?))");
      params.push(agentId, projectId ?? "");
    } else {
      if (!includePending) where.push("m.approved = 1");
      if (scope) { where.push("m.scope = ?"); params.push(scope); }
      if (scopeRef != null) { where.push("m.scope_ref = ?"); params.push(scopeRef); }
    }
    return db.all(`SELECT m.* FROM memory_fts JOIN memory_notes m ON m.rowid = memory_fts.rowid WHERE ${where.join(" AND ")} ORDER BY bm25(memory_fts), m.updated_at DESC LIMIT ?`, ...params, Math.min(Math.max(Number(limit) || 20, 1), 50)).map(memoryRow);
  }
  function reindexMemory() {
    db.run("INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')");
    log({ action: "memory.reindexed", targetType: "memory", outcome: "success", summary: "إعادة بناء فهرس الذاكرة المحلي" });
    return { indexed: db.get("SELECT COUNT(*) AS n FROM memory_notes").n, at: at() };
  }
  function deleteMemory(id) {
    const row = db.get("SELECT * FROM memory_notes WHERE id = ?", String(id));
    if (!row) throw notFound("الملاحظة");
    db.tx(() => { db.run("DELETE FROM memory_notes WHERE id = ?", row.id); log({ action: "memory.deleted", targetType: "memory", targetId: row.id, summary: `حذف ملاحظة ذاكرة: ${row.title}` }); });
    return { deleted: row.id };
  }

  // ---------------- migration from browser storage (idempotent)
  function importBrowser({ workboard, projectBoard, links, catalogOwner }) {
    const report = { tasks: 0, deduplicated: 0, notes: 0, links: 0, focus: 0, journal: 0, skipped: 0 };
    const ledgerHas = (ref) => Boolean(db.get("SELECT ref FROM import_ledger WHERE ref = ?", ref));
    const ledgerAdd = (ref, kind) => db.run("INSERT OR IGNORE INTO import_ledger (ref, kind, imported_at) VALUES (?,?,?)", ref, kind, at());
    db.tx(() => {
      const owner = typeof catalogOwner === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(catalogOwner) ? catalogOwner : null;
      const projectFor = (name) => (owner && typeof name === "string" ? db.get("SELECT id FROM projects WHERE lower(github) = lower(?)", `${owner}/${name}`)?.id ?? null : null);
      if (workboard && typeof workboard === "object" && workboard.version === 1 && workboard.projects && typeof workboard.projects === "object") {
        for (const [name, record] of Object.entries(workboard.projects).slice(0, 200)) {
          for (const task of (Array.isArray(record?.tasks) ? record.tasks : []).slice(0, 40)) {
            if (typeof task?.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(task.id)) { report.skipped++; continue; }
            try {
              const created = createTask({ title: task.title, projectId: projectFor(name), status: task.done ? "done" : "todo", tags: ["workboard"] }, { type: "owner", id: "owner" }, { externalRef: `wb:${name}:${task.id}`, source: "import:workboard" });
              if (created.deduplicated) report.deduplicated++; else report.tasks++;
            } catch (_) { report.skipped++; }
          }
        }
      }
      if (workboard && typeof workboard === "object" && workboard.version === 1) {
        // Focus projects: carried over once each, never beyond the company focus limit and never un-focusing anything.
        for (const name of (Array.isArray(workboard.focus) ? workboard.focus : []).slice(0, MAX_FOCUS)) {
          const id = projectFor(name);
          const ref = `wb-focus:${String(name).slice(0, 100)}`;
          if (!id || ledgerHas(ref)) { if (id) report.deduplicated++; continue; }
          if (db.get("SELECT COUNT(*) AS n FROM projects WHERE focus = 1").n < MAX_FOCUS) { db.run("UPDATE projects SET focus = 1 WHERE id = ?", id); report.focus++; }
          ledgerAdd(ref, "workboard-focus");
        }
        // Execution journal: each browser event becomes one owner activity event at its original time, exactly once.
        const KIND_AR = { focus: "تركيز جديد", unfocus: "خرج من التركيز", stage: "تغيير المرحلة", task_add: "مهمة جديدة", task_done: "مهمة منجزة", task_undo: "إعادة فتح مهمة", task_remove: "حذف مهمة", note: "قرار / ملاحظة" };
        for (const event of (Array.isArray(workboard.events) ? workboard.events : []).slice(0, 500)) {
          if (!event || typeof event.project !== "string" || !KIND_AR[event.kind] || Number.isNaN(Date.parse(event.at))) { report.skipped++; continue; }
          const ref = `wb-event:${typeof event.id === "string" ? event.id.slice(0, 64) : `${event.at}:${event.project}:${event.kind}`}`;
          if (ledgerHas(ref)) { report.deduplicated++; continue; }
          let detail;
          try { detail = str(event.detail, { field: "الملاحظة", max: 200 }); } catch (_) { report.skipped++; continue; }
          db.run("INSERT INTO activity_events (at, actor_type, actor_id, action, target_type, target_id, outcome, summary, metadata, evidence) VALUES (?,?,?,?,?,?,?,?,?,?)",
            new Date(event.at).toISOString(), "owner", "owner", `journal.${event.kind}`, projectFor(event.project) ? "project" : null, projectFor(event.project),
            "info", `سجل التنفيذ (المتصفح) · ${KIND_AR[event.kind]} — ${String(event.project).slice(0, 100)}${detail ? `: ${detail}` : ""}`, JSON.stringify({ source: "browser-workboard", kind: event.kind }), "import:workboard-journal");
          ledgerAdd(ref, "workboard-journal");
          report.journal++;
        }
      }
      if (projectBoard && typeof projectBoard === "object" && projectBoard.custom && typeof projectBoard.custom === "object") {
        for (const [name, custom] of Object.entries(projectBoard.custom).slice(0, 200)) {
          const id = projectFor(name);
          const note = typeof custom?.note === "string" ? custom.note : null;
          if (!id || !note) continue;
          const current = db.get("SELECT notes FROM projects WHERE id = ?", id);
          if (current.notes && current.notes.includes(note.trim())) { report.deduplicated++; continue; }
          try {
            const merged = str(current.notes ? `${current.notes}\n\n${note}` : note, { field: "الملاحظات", max: 4000, multiline: true });
            db.run("UPDATE projects SET notes = ?, updated_at = ? WHERE id = ?", merged, at(), id);
            report.notes++;
          } catch (_) { report.skipped++; }
        }
      }
      if (links && typeof links === "object") {
        for (const [rel, name] of Object.entries(links).slice(0, 200)) {
          if (typeof name !== "string") continue;
          const id = projectFor(name);
          if (!id) { report.skipped++; continue; }
          try { linkCheckout(rel, id); report.links++; } catch (_) { report.skipped++; }
        }
      }
      if (report.tasks || report.notes || report.links || report.focus || report.journal) log({ action: "import.browser", targetType: "store", summary: `ترحيل بيانات المتصفح: ${report.tasks} مهمة، ${report.notes} ملاحظة، ${report.links} ربط، ${report.focus} مشروع تركيز، ${report.journal} حدث سجل (مكرر ${report.deduplicated}، متجاوز ${report.skipped})`, metadata: report });
    });
    return report;
  }

  function exportAll() {
    return {
      format: "abud-company-export", version: 1, exportedAt: at(), schemaVersion: db.schemaVersion(), settings: settings(),
      projects: listProjects(), tasks: listTasks({ limit: 2000, includeArchived: true }), agents: listAgents({ activeOnly: false }).map(a => agentConfig(a.id)), policies: listPolicies(), budgets: listBudgets(),
      approvals: listApprovals(), memory: listMemory(), runs: listRuns({ limit: 300 }).map((r) => ({ ...r, output: r.output ? r.output.slice(0, 4000) : null })),
      activity: activity({ limit: 300 }),
      githubIdentities: db.all("SELECT slug, canonical, repo_id AS repoId, state, resolved_at AS resolvedAt FROM github_identities ORDER BY slug")
    };
  }

  return { registry, agentById, listAgents,
    db, log, activity, raise, resolveStale, notifications, acknowledge, settings, updateSettings, seed,
    listProjects, getProject, createProject, updateProject, addMilestone, updateMilestone, syncProjects, linkCheckout,
    canonicalGithub, identitiesToResolve, recordGithubIdentity,
    listTasks, getTask, createTask, updateTask, setTaskArchived,
    agentConfig, updateAgent, listRuns, getRun, runRow, usageSince, usageByAgent, usageByModel,
    listBudgets, upsertBudget, deleteBudget, budgetGate,
    listPolicies, getPolicy, updatePolicy,
    recordQuota, quotaHistory, pruneQuota, lastQuotaObservation,
    createApproval, listApprovals, getApproval, setApprovalStatus,
    listMemory, searchMemory, reindexMemory, upsertMemory, resolveMemoryConflict, memoryConflicts, deleteMemory, importBrowser, exportAll, at
  };
}

export { TOOLS, PRIORITIES, TASK_STATUSES, PROJECT_STATUSES };
