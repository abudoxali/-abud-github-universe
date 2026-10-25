/* VPS Operations Center (local bridge adapter). Hosts are registered from the ignored local/vps.json (non-secret fields are
 * mirrored into SQLite; the SSH identity path never leaves this process). Deterministic monitoring runs here without any
 * model: bounded read-only SSH probes, public HTTPS/TLS checks, persisted history with retention, and debounced,
 * deduplicated incidents. Agents read sanitized results through permission-checked tools. Write operations exist only as
 * an allowlisted registry executed after a fresh, single-use owner approval bound to the exact host, operation and
 * parameters. There is no endpoint or tool that accepts a shell command. */
import { readFile } from "node:fs/promises";
import { connect as tlsConnect } from "node:tls";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "./company.mjs";
import { newId, parseJson } from "./db.mjs";
import { createSshTransport, SSH_ERRORS } from "./vps-ssh.mjs";
import * as P from "./vps-probes.mjs";

export const VPS_DEFAULTS = {
  basicIntervalSec: 60, inventoryIntervalSec: 900, siteIntervalSec: 120, dailySummary: false,
  thresholds: { diskWarnPct: 85, diskCritPct: 93, memWarnPct: 90, cpuWarnPct: 90, swapWarnPct: 60, sustainedChecks: 5, certWarnDays: 14, certCritDays: 5, unreachableChecks: 3, serviceChecks: 2, restartBurst: 3 }
};
const RETENTION = { rawDays: 3, hourlyDays: 120, observationDays: 30, incidentDays: 180 };
const APPROVAL_TTL_MS = 5 * 60_000;
const PROPOSAL_TTL_MS = 24 * 3_600_000;
const HEARTBEAT_MS = 15 * 60_000;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

const SERVICE_AR = { running: "يعمل", stopped: "متوقف", degraded: "متدهور", unreachable: "تعذر الوصول", unknown: "غير معروف", stale: "قراءة قديمة", retired: "مُوقَف عمدًا (staging)", absent: "غير موجود" };
const SITE_AR = { ok: "سليم", protected: "محمي بمصادقة (متوقع)", retired: "مُوقَف عمدًا (410)", degraded: "متدهور", down: "متوقف", unreachable: "تعذر الوصول", unexpected: "استجابة غير متوقعة" };

/** Allowlisted operations. Tier 2 may run after a fresh owner approval; Tier 3 is never executed by this generic path. */
export const ACTIONS = {
  "pm2.restart": { tier: 2, ar: "إعادة تشغيل خدمة PM2 واحدة", needsService: true },
  "nginx.reload": { tier: 2, ar: "إعادة تحميل Nginx بعد نجاح فحص الإعداد (nginx -t)", needsService: false },
  "deploy.release": { tier: 3, ar: "نشر إصدار" }, "deploy.rollback": { tier: 3, ar: "التراجع إلى إصدار سابق" },
  "db.migrate": { tier: 3, ar: "ترحيل قاعدة البيانات" }, "db.restore": { tier: 3, ar: "استعادة قاعدة البيانات" },
  "nginx.edit": { tier: 3, ar: "تعديل إعداد Nginx" }, "firewall.change": { tier: 3, ar: "تغيير الجدار الناري" },
  "ssh.access": { tier: 3, ar: "تعديل وصول SSH أو الحسابات" }, "release.delete": { tier: 3, ar: "حذف ملفات إصدار" }
};

/** Validates local/vps.json. Returns { configured, hosts, private, errors }. */
export async function loadVpsConfig(path) {
  let raw;
  try { raw = JSON.parse(await readFile(path, "utf8")); } catch (error) { return { configured: false, hosts: [], private: new Map(), errors: error?.code === "ENOENT" ? [] : ["unreadable-config"], monitoring: false }; }
  const hosts = [], errors = [], priv = new Map();
  for (const h of Array.isArray(raw?.hosts) ? raw.hosts.slice(0, 10) : []) {
    try {
      if (!ID.test(h.id || "")) throw new Error("invalid-id");
      if (!/^[A-Za-z0-9.:-]{1,253}$/.test(h.address || "")) throw new Error("invalid-address");
      if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(h.sshUser || "")) throw new Error("invalid-ssh-user");
      if (!FINGERPRINT.test(h.hostKeyFingerprint || "")) throw new Error("invalid-fingerprint");
      const port = Number(h.port ?? 22);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid-port");
      hosts.push({ id: h.id, name: String(h.name || h.id).slice(0, 80), provider: h.provider ? String(h.provider).slice(0, 60) : null, address: h.address, port, sshUser: h.sshUser,
        hostKeyFingerprint: h.hostKeyFingerprint, expectedHostname: typeof h.expectedHostname === "string" && /^[A-Za-z0-9.-]{1,64}$/.test(h.expectedHostname) ? h.expectedHostname : null,
        project: typeof h.project === "string" && /^[\w.-]+\/[\w.-]+$/.test(h.project) ? h.project : null, profile: P.normalizeProfile(h.profile || {}) });
      if (typeof h.identityFile === "string" && h.identityFile.length < 400) priv.set(h.id, { identityFile: h.identityFile, knownHostsFile: typeof h.knownHostsFile === "string" ? h.knownHostsFile : null });
    } catch (error) { errors.push(`${typeof h?.id === "string" ? h.id.slice(0, 40) : "host"}: ${error.message}`); }
  }
  return { configured: hosts.length > 0, hosts, private: priv, errors, monitoring: raw?.monitoring?.enabled !== false };
}

/** HTTPS health and TLS certificate checks from this Windows machine (the public view, independent of SSH). */
export async function checkSite(url, healthPath, { timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const started = Date.now();
  const read = async (path) => {
    try {
      const response = await fetchImpl(`${url}${path}`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "ABUD-Company-OS-Monitor/4.1", Accept: "application/json" } });
      const text = (await response.text()).slice(0, 4096);
      let body = null;
      try { const parsed = JSON.parse(text); body = parsed && typeof parsed === "object" ? { status: typeof parsed.status === "string" ? parsed.status.slice(0, 20) : null, database: typeof parsed.database === "string" ? parsed.database.slice(0, 20) : null, commit: /^[0-9a-f]{7,40}$/.test(parsed.commit || "") ? parsed.commit : null } : null; } catch (_) { body = null; }
      return { status: response.status, ms: Date.now() - started, body };
    } catch (error) { return { status: null, ms: Date.now() - started, error: error?.name === "TimeoutError" ? "timeout" : "network" }; }
  };
  const health = healthPath ? await read(healthPath) : null;
  const root = await read("/");
  return { url, health, root, checkedAt: new Date().toISOString() };
}
export function checkCertificate(hostname, { timeoutMs = 8000, connectImpl = tlsConnect } = {}) {
  return new Promise((resolve) => {
    let socket;
    const done = (value) => { try { socket?.destroy(); } catch (_) { /* closed */ } resolve({ hostname, checkedAt: new Date().toISOString(), ...value }); };
    try {
      socket = connectImpl({ host: hostname, port: 443, servername: hostname, timeout: timeoutMs }, () => {
        const cert = socket.getPeerCertificate();
        const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
        done({ ok: socket.authorized === true, authorizationError: socket.authorized ? null : String(socket.authorizationError || "unauthorized"), issuer: cert?.issuer?.O || cert?.issuer?.CN || null,
          validTo: validTo && !Number.isNaN(validTo.getTime()) ? validTo.toISOString() : null, daysLeft: validTo ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000) : null });
      });
      socket.on("timeout", () => done({ ok: false, error: "timeout" }));
      socket.on("error", () => done({ ok: false, error: "tls-error" }));
    } catch (_) { done({ ok: false, error: "tls-error" }); }
  });
}

export function createVps({ company, configPath, transport = null, siteChecker = checkSite, certChecker = checkCertificate, log = () => {}, now = () => Date.now() }) {
  const db = company.db;
  const iso = () => new Date(now()).toISOString();
  let config = { configured: false, hosts: [], private: new Map(), errors: [], monitoring: false };
  let ssh = transport;
  const runtime = new Map(); // hostId -> volatile monitoring state
  const locks = new Set();
  let timer = null, lastPrune = 0, enqueueRun = null;

  // ---------------------------------------------------------------- settings (stored in the company settings table)
  function settings() {
    const stored = parseJson(db.get("SELECT value FROM settings WHERE key = 'vps'")?.value, {}) || {};
    return { ...VPS_DEFAULTS, ...stored, thresholds: { ...VPS_DEFAULTS.thresholds, ...(stored.thresholds || {}) } };
  }
  function updateSettings(patch) {
    const next = settings();
    const bounds = { basicIntervalSec: [30, 900], inventoryIntervalSec: [300, 7200], siteIntervalSec: [60, 1800] };
    for (const [key, [min, max]] of Object.entries(bounds)) {
      if (!(key in patch)) continue;
      if (!Number.isInteger(patch[key]) || patch[key] < min || patch[key] > max) throw new HttpError(422, "validation", `${key} خارج الحدود (${min}–${max})`);
      next[key] = patch[key];
    }
    if ("dailySummary" in patch) next.dailySummary = patch.dailySummary === true;
    if ("thresholds" in patch) {
      const tb = { diskWarnPct: [50, 99], diskCritPct: [60, 100], memWarnPct: [50, 100], cpuWarnPct: [50, 100], swapWarnPct: [10, 100], sustainedChecks: [2, 30], certWarnDays: [3, 60], certCritDays: [1, 30], unreachableChecks: [2, 20], serviceChecks: [1, 10], restartBurst: [2, 50] };
      for (const [key, value] of Object.entries(patch.thresholds || {})) {
        if (!tb[key] || !Number.isInteger(value) || value < tb[key][0] || value > tb[key][1]) throw new HttpError(422, "validation", `حد غير صالح: ${key}`);
        next.thresholds[key] = value;
      }
      if (next.thresholds.diskWarnPct >= next.thresholds.diskCritPct) throw new HttpError(422, "validation", "حد التحذير للقرص يجب أن يكون أقل من الحد الحرج");
    }
    db.run("INSERT INTO settings (key, value, updated_at) VALUES ('vps', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", JSON.stringify(next), iso());
    company.log({ action: "vps.settings.updated", targetType: "vps", summary: "تحديث إعدادات مراقبة الخوادم", metadata: patch });
    return next;
  }

  // ---------------------------------------------------------------- registry
  const hostRow = (row) => row && ({ id: row.id, name: row.name, provider: row.provider, address: row.address, port: row.port, sshUser: row.ssh_user, hostKeyFingerprint: row.host_key_fingerprint,
    expectedHostname: row.expected_hostname, projectId: row.project_id, profile: parseJson(row.profile, {}), enabled: row.enabled === 1 });
  const hosts = () => db.all("SELECT * FROM vps_hosts ORDER BY created_at").map(hostRow);
  function host(id) {
    const row = hostRow(db.get("SELECT * FROM vps_hosts WHERE id = ?", String(id ?? "")));
    if (!row) throw new HttpError(404, "not-found", "الخادم غير مسجل");
    return row;
  }
  /** Resolves an optional host id: the given host, the host linked to a project, or the only enabled host. */
  function resolveHost(hostId, projectId = null) {
    if (hostId) return host(hostId);
    const enabled = hosts().filter((h) => h.enabled);
    const linked = projectId ? enabled.find((h) => h.projectId === projectId) : null;
    if (linked) return linked;
    if (enabled.length === 1) return enabled[0];
    throw new HttpError(422, "host-required", enabled.length ? "حدد الخادم" : "لا يوجد خادم مسجل");
  }
  async function reload() {
    config = await loadVpsConfig(configPath);
    if (!transport) {
      // One bounded transport per host, each with that host's own identity and known_hosts file.
      const perHost = new Map([...config.private].map(([id, p]) => [id, createSshTransport({ identityFor: () => p.identityFile, knownHostsFile: p.knownHostsFile ?? undefined })]));
      ssh = { exec: (h, script, opts) => (perHost.get(h.id) ?? createSshTransport({ identityFor: () => null })).exec(h, script, opts) };
    }
    db.tx(() => {
      const seen = new Set();
      for (const h of config.hosts) {
        seen.add(h.id);
        const project = h.project ? db.get("SELECT id FROM projects WHERE lower(github) = lower(?)", h.project) ?? db.get("SELECT p.id FROM github_identities g JOIN projects p ON lower(p.github) = lower(g.canonical) WHERE lower(g.slug) = lower(?)", h.project) : null;
        const existing = db.get("SELECT id FROM vps_hosts WHERE id = ?", h.id);
        if (existing) db.run("UPDATE vps_hosts SET name=?, provider=?, address=?, port=?, ssh_user=?, host_key_fingerprint=?, expected_hostname=?, project_id=?, profile=?, enabled=1, updated_at=? WHERE id=?",
          h.name, h.provider, h.address, h.port, h.sshUser, h.hostKeyFingerprint, h.expectedHostname, project?.id ?? null, JSON.stringify(h.profile), iso(), h.id);
        else {
          db.run("INSERT INTO vps_hosts (id, name, provider, address, port, ssh_user, host_key_fingerprint, expected_hostname, project_id, profile, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)",
            h.id, h.name, h.provider, h.address, h.port, h.sshUser, h.hostKeyFingerprint, h.expectedHostname, project?.id ?? null, JSON.stringify(h.profile), iso(), iso());
          company.log({ actorType: "system", actorId: "vps-monitor", action: "vps.host.registered", targetType: "vps", targetId: h.id, summary: `تسجيل الخادم ${h.name} للمراقبة (قراءة فقط)`, metadata: { provider: h.provider, projectId: project?.id ?? null } });
        }
      }
      for (const row of db.all("SELECT id FROM vps_hosts WHERE enabled = 1")) if (!seen.has(row.id)) db.run("UPDATE vps_hosts SET enabled = 0, updated_at = ? WHERE id = ?", iso(), row.id);
    });
    for (const h of hosts()) if (!runtime.has(h.id)) runtime.set(h.id, restoreState(h.id));
    return config;
  }
  /** Last persisted knowledge for a host, so a restarted bridge shows "last verified" instead of nothing. */
  function restoreState(hostId) {
    const lastOk = db.get("SELECT at, data, duration_ms FROM vps_observations WHERE host_id = ? AND kind = 'basic' AND state = 'ok' ORDER BY id DESC LIMIT 1", hostId);
    const lastFail = db.get("SELECT at, error_category FROM vps_observations WHERE host_id = ? AND kind = 'basic' AND state = 'failed' ORDER BY id DESC LIMIT 1", hostId);
    const inv = db.get("SELECT at, data FROM vps_observations WHERE host_id = ? AND kind = 'inventory' AND state = 'ok' ORDER BY id DESC LIMIT 1", hostId);
    const sites = db.get("SELECT at, data FROM vps_observations WHERE host_id = ? AND kind = 'sites' ORDER BY id DESC LIMIT 1", hostId);
    const last = db.get("SELECT at, state, error_category FROM vps_observations WHERE host_id = ? AND kind = 'basic' ORDER BY id DESC LIMIT 1", hostId);
    return {
      inFlight: new Set(), failures: last?.state === "failed" ? 1 : 0, counters: new Map(), next: { basic: 0, inventory: 0, sites: 0 },
      lastAttempt: last ? { at: last.at, ok: last.state === "ok", category: last.error_category } : null,
      lastGood: lastOk ? { at: lastOk.at, ms: lastOk.duration_ms, data: parseJson(lastOk.data, null) } : null,
      lastFailure: lastFail ? { at: lastFail.at, category: lastFail.error_category } : null,
      inventory: inv ? { at: inv.at, data: parseJson(inv.data, null) } : null,
      sites: sites ? { at: sites.at, data: parseJson(sites.data, null) } : null,
      lastObservationWrite: { basic: lastOk ? Date.parse(lastOk.at) : 0, sites: sites ? Date.parse(sites.at) : 0 }, lastSiteState: null, prevPm2: null, restartLog: []
    };
  }
  const state = (hostId) => { if (!runtime.has(hostId)) runtime.set(hostId, restoreState(hostId)); return runtime.get(hostId); };

  // ---------------------------------------------------------------- observations, metrics, services
  function observe(hostId, kind, stateText, data, { ms = null, category = null } = {}) {
    db.run("INSERT INTO vps_observations (host_id, at, kind, state, duration_ms, error_category, data) VALUES (?,?,?,?,?,?,?)", hostId, iso(), kind, stateText, ms, category, data == null ? null : JSON.stringify(data).slice(0, 32_000));
  }
  function setService(h, service, kind, environment, next, detail) {
    const prev = db.get("SELECT state FROM vps_services WHERE host_id = ? AND service = ?", h.id, service);
    const at = iso();
    if (!prev) db.run("INSERT INTO vps_services (host_id, service, kind, environment, state, detail, observed_at, changed_at) VALUES (?,?,?,?,?,?,?,?)", h.id, service, kind, environment, next, JSON.stringify(detail ?? {}), at, at);
    else db.run("UPDATE vps_services SET kind=?, environment=?, state=?, detail=?, observed_at=?, changed_at=CASE WHEN state = ? THEN changed_at ELSE ? END WHERE host_id=? AND service=?",
      kind, environment, next, JSON.stringify(detail ?? {}), at, next, at, h.id, service);
    if (prev && prev.state !== next && (prev.state === "running" || next === "running")) {
      company.log({ actorType: "system", actorId: "vps-monitor", action: "vps.service.state", targetType: "vps", targetId: h.id, outcome: next === "running" ? "success" : "failure",
        summary: `${h.name}: ${service} ${SERVICE_AR[prev.state] ?? prev.state} ← ${SERVICE_AR[next] ?? next}`, metadata: { service, from: prev.state, to: next } });
    }
  }
  const systemdState = (s) => (s === "active" ? "running" : s === "inactive" || s === "failed" ? "stopped" : ["activating", "reloading", "deactivating"].includes(s) ? "degraded" : "unknown");
  const pm2State = (s) => (s === "online" ? "running" : ["stopped", "errored"].includes(s) ? "stopped" : ["launching", "stopping", "waiting restart", "one-launch-status"].includes(s) ? "degraded" : "unknown");

  function applyServices(h, data) {
    const profile = h.profile;
    for (const unit of profile.systemd || []) setService(h, unit, "systemd", "host", systemdState(data.systemd?.[unit]), { raw: data.systemd?.[unit] ?? null });
    for (const group of profile.pm2 || []) {
      const view = data.pm2?.[group.user];
      for (const svc of group.services) {
        const env = profile.environments?.[svc.environment];
        const proc = view?.processes?.find((p) => p.name === svc.name);
        let next;
        if (!view || !view.readable) next = "unknown";
        else if (!proc) next = env?.expected === "retired" ? "retired" : "absent";
        else next = pm2State(proc.status);
        setService(h, svc.name, "pm2", svc.environment, next, proc ? { status: proc.status, restarts: proc.restarts, unstableRestarts: proc.unstableRestarts, startedAt: proc.startedAt, memoryMb: proc.memoryMb, cpuPct: proc.cpuPct, user: group.user } : { user: group.user });
      }
    }
  }

  function recordMetrics(hostId, data, sshMs) {
    db.run("INSERT OR REPLACE INTO vps_metrics (host_id, at, resolution, cpu_pct, load1, mem_pct, swap_pct, disk_pct, ssh_ms, samples) VALUES (?,?,?,?,?,?,?,?,?,1)",
      hostId, iso(), "raw", data.cpu?.pct ?? null, data.cpu?.load1 ?? null, data.memory?.usedPct ?? null, data.memory?.swapUsedPct ?? null, data.disk?.usedPct ?? null, sshMs ?? null);
  }

  // ---------------------------------------------------------------- incidents (debounced, deduplicated, with recovery)
  const AGENT_FOR = { security: "rex", resources: "nex", availability: "ori", certificate: "rex", deployment: "ori" };
  function evaluate(h, signals) {
    const st = state(h.id);
    for (const sig of signals) {
      const key = `vps:${h.id}:${sig.key}`;
      const c = st.counters.get(key) || { hits: 0, misses: 0 };
      if (sig.active) { c.hits++; c.misses = 0; } else { c.misses++; c.hits = 0; }
      st.counters.set(key, c);
      const open = db.get("SELECT * FROM vps_incidents WHERE dedupe_key = ? AND state = 'open'", key);
      if (sig.active && !open && c.hits >= (sig.sustain ?? 1)) openIncident(h, key, sig);
      else if (sig.active && open) db.run("UPDATE vps_incidents SET last_seen_at = ?, evidence = ?, severity = ? WHERE id = ?", iso(), JSON.stringify(sig.evidence ?? {}).slice(0, 4000), sig.severity, open.id);
      else if (!sig.active && open && c.misses >= (sig.recoverAfter ?? 1)) recoverIncident(h, open);
    }
  }
  function openIncident(h, key, sig) {
    const id = newId("inc");
    const agent = AGENT_FOR[sig.category] ?? "ori";
    db.tx(() => {
      db.run("INSERT INTO vps_incidents (id, host_id, dedupe_key, service, severity, state, title, detection, evidence, assigned_agent, started_at, last_seen_at) VALUES (?,?,?,?,?,'open',?,?,?,?,?,?)",
        id, h.id, key, sig.service ?? null, sig.severity, sig.title, sig.detection, JSON.stringify(sig.evidence ?? {}).slice(0, 4000), agent, iso(), iso());
      company.raise({ key, level: sig.severity, kind: "vps", title: `${h.name}: ${sig.title}`, body: sig.body ?? null, targetType: "vps", targetId: h.id });
      company.log({ actorType: "system", actorId: "vps-monitor", action: "vps.incident.opened", targetType: "vps", targetId: h.id, outcome: "failure",
        summary: `${h.name}: ${sig.title}`, metadata: { incidentId: id, severity: sig.severity, detection: sig.detection, service: sig.service ?? null, assignedAgent: agent }, evidence: sig.detection });
      if (h.projectId) company.log({ actorType: "system", actorId: "vps-monitor", action: "vps.incident.opened", targetType: "project", targetId: h.projectId, outcome: "failure", summary: `حادثة بنية تحتية: ${sig.title}` });
      if (sig.task !== false && ["critical", "warning"].includes(sig.severity)) {
        // One owner task per unresolved condition: a still-open task from an earlier occurrence is reused, not duplicated.
        const reuse = db.get("SELECT id FROM tasks WHERE external_ref LIKE ? AND archived_at IS NULL AND status NOT IN ('done','cancelled') ORDER BY created_at DESC LIMIT 1", `${key}#%`);
        const task = reuse ? { id: reuse.id } : company.createTask({ title: `[${h.name}] ${sig.title}`.slice(0, 160), description: `${sig.body ?? ""}\nمصدر الرصد: ${sig.detection}\nالمكلّف بالتحليل: ${agent.toUpperCase()}`.trim().slice(0, 4000),
          projectId: h.projectId ?? undefined, priority: sig.severity === "critical" ? "high" : "medium", tags: ["vps", "incident", sig.category] }, { type: "system", id: "vps-monitor" }, { externalRef: `${key}#${id}`, source: "vps-monitor" });
        db.run("UPDATE vps_incidents SET task_id = ? WHERE id = ?", task.id, id);
      }
    });
    log(JSON.stringify({ event: "vps-incident-opened", host: h.id, key: sig.key, severity: sig.severity }));
  }
  function recoverIncident(h, incident) {
    db.tx(() => {
      db.run("UPDATE vps_incidents SET state = 'recovered', recovered_at = ? WHERE id = ?", iso(), incident.id);
      db.run("UPDATE notifications SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL", iso(), incident.dedupe_key);
      company.log({ actorType: "system", actorId: "vps-monitor", action: "vps.incident.recovered", targetType: "vps", targetId: h.id, outcome: "success",
        summary: `${h.name}: تعافٍ — ${incident.title}`, metadata: { incidentId: incident.id, durationSec: Math.round((now() - Date.parse(incident.started_at)) / 1000) } });
      if (incident.task_id) db.run("INSERT INTO task_events (task_id, at, actor, kind, detail) VALUES (?,?,?,?,?)", incident.task_id, iso(), "system:vps-monitor", "incident-recovered", JSON.stringify({ incidentId: incident.id }));
    });
  }

  function basicSignals(h, result, data) {
    const t = settings().thresholds;
    const sig = [];
    const failed = !result.ok;
    const security = ["host-key-changed", "host-key-mismatch", "host-key-unknown"].includes(result.category);
    sig.push({ key: "host-key", active: security, severity: "critical", category: "security", sustain: 1, recoverAfter: 1, title: "تعذر التحقق من هوية مفتاح الخادم", detection: `ssh:${result.category ?? "ok"}`, body: SSH_ERRORS[result.category] ?? null, evidence: { category: result.category ?? null } });
    sig.push({ key: "auth", active: result.category === "auth-failed", severity: "warning", category: "security", sustain: 2, recoverAfter: 1, title: "رفض الخادم مصادقة SSH", detection: "ssh:auth-failed", body: SSH_ERRORS["auth-failed"] });
    sig.push({ key: "unreachable", active: failed && !security && result.category !== "auth-failed" && result.category !== "not-configured", severity: "critical", category: "availability", sustain: t.unreachableChecks, recoverAfter: 1,
      title: "الخادم غير قابل للوصول عبر SSH", detection: `ssh:${result.category ?? "ok"}`, body: `${SSH_ERRORS[result.category] ?? ""}. هذا لا يعني بالضرورة توقف التطبيقات؛ راجع فحص الموقع العام.`, evidence: { category: result.category ?? null }, task: true });
    if (failed || !data) return sig;
    const identityBad = (h.expectedHostname && data.hostname !== h.expectedHostname) || (state(h.id).machine && data.machine && state(h.id).machine !== data.machine);
    sig.push({ key: "identity", active: Boolean(identityBad), severity: "critical", category: "security", sustain: 1, recoverAfter: 1, title: "هوية الخادم لا تطابق المسجّل", detection: "probe:hostname/machine-id", evidence: { hostname: data.hostname, expected: h.expectedHostname } });
    const disk = data.disk?.usedPct;
    sig.push({ key: "disk", active: Number.isFinite(disk) && disk >= t.diskWarnPct, severity: disk >= t.diskCritPct ? "critical" : "warning", category: "resources", sustain: 2, recoverAfter: 2,
      title: `امتلاء القرص ${disk}%`, detection: "probe:df", body: `المتاح ${Math.round((data.disk?.availBytes ?? 0) / 1073741824)} GB`, evidence: { usedPct: disk } });
    sig.push({ key: "memory", active: Number.isFinite(data.memory?.usedPct) && data.memory.usedPct >= t.memWarnPct, severity: "warning", category: "resources", sustain: t.sustainedChecks, recoverAfter: 3,
      title: `استهلاك ذاكرة مرتفع مستمر ${data.memory?.usedPct}%`, detection: "probe:meminfo", evidence: { usedPct: data.memory?.usedPct } });
    sig.push({ key: "cpu", active: Number.isFinite(data.cpu?.pct) && data.cpu.pct >= t.cpuWarnPct, severity: "warning", category: "resources", sustain: t.sustainedChecks, recoverAfter: 3,
      title: `استخدام معالج مرتفع مستمر ${data.cpu?.pct}%`, detection: "probe:/proc/stat", evidence: { pct: data.cpu?.pct, load1: data.cpu?.load1 } });
    sig.push({ key: "swap", active: Number.isFinite(data.memory?.swapUsedPct) && data.memory.swapUsedPct >= t.swapWarnPct, severity: "info", category: "resources", sustain: t.sustainedChecks, recoverAfter: 3, task: false,
      title: `استخدام Swap مرتفع ${data.memory?.swapUsedPct}%`, detection: "probe:meminfo" });
    for (const row of db.all("SELECT service, environment, state, detail FROM vps_services WHERE host_id = ?", h.id)) {
      const production = row.environment === "production" || row.environment === "host";
      const down = ["stopped", "absent"].includes(row.state) && production;
      sig.push({ key: `service:${row.service}`, active: down, severity: "critical", category: "availability", service: row.service, sustain: t.serviceChecks, recoverAfter: 2,
        title: `الخدمة ${row.service} ${SERVICE_AR[row.state] ?? row.state}`, detection: `probe:${row.state === "absent" ? "pm2 jlist (missing)" : "service state"}`, evidence: { state: row.state } });
      const detail = parseJson(row.detail, {});
      if (Number.isFinite(detail.restarts)) {
        const st = state(h.id);
        const prev = st.prevPm2?.[row.service];
        st.prevPm2 = { ...(st.prevPm2 || {}), [row.service]: detail.restarts };
        if (Number.isFinite(prev) && detail.restarts > prev) st.restartLog.push({ service: row.service, at: now(), n: detail.restarts - prev });
        st.restartLog = st.restartLog.filter((r) => now() - r.at < 3_600_000);
        const burst = st.restartLog.filter((r) => r.service === row.service).reduce((sum, r) => sum + r.n, 0);
        sig.push({ key: `restarts:${row.service}`, active: burst >= t.restartBurst, severity: "warning", category: "availability", service: row.service, sustain: 1, recoverAfter: 6,
          title: `إعادات تشغيل متكررة لـ ${row.service} (${burst} خلال ساعة)`, detection: "probe:pm2 restart_time", evidence: { lastHour: burst, total: detail.restarts } });
      }
    }
    return sig;
  }
  function siteSignals(h, sites) {
    const t = settings().thresholds;
    const sig = [];
    for (const [env, s] of Object.entries(sites.environments || {})) {
      const expected = h.profile.environments?.[env]?.expected ?? "active";
      sig.push({ key: `site:${env}`, active: expected === "active" && ["down", "degraded", "unreachable"].includes(s.state), severity: env === "production" ? "critical" : "warning", category: "availability", sustain: 2, recoverAfter: 2,
        title: `فحص الصحة العام لـ ${env} ${SITE_AR[s.state] ?? s.state}`, detection: `https:${s.healthStatus ?? "no-response"}`, body: `${s.url}${h.profile.environments?.[env]?.healthPath ?? ""}`, evidence: { status: s.healthStatus, body: s.healthBody } });
      if (expected === "active" && s.cert && Number.isFinite(s.cert.daysLeft)) {
        sig.push({ key: `tls:${env}`, active: s.cert.daysLeft <= t.certWarnDays || s.cert.ok === false, severity: s.cert.daysLeft <= t.certCritDays || s.cert.ok === false ? "critical" : "warning", category: "certificate", sustain: 1, recoverAfter: 1,
          title: `شهادة TLS لـ ${new URL(s.url).hostname} ${s.cert.ok === false ? "غير صالحة" : `تنتهي خلال ${s.cert.daysLeft} يومًا`}`, detection: "tls:handshake", evidence: { validTo: s.cert.validTo, daysLeft: s.cert.daysLeft } });
      }
    }
    return sig;
  }

  // ---------------------------------------------------------------- probes
  async function probeBasic(h) {
    const st = state(h.id);
    if (st.inFlight.has("basic")) return { skipped: "in-flight" };
    st.inFlight.add("basic");
    try {
      const result = await ssh.exec(h, P.basicScript(h.profile), { timeoutMs: 25_000, maxBytes: 128 * 1024 });
      const previousOk = st.lastAttempt?.ok !== false;
      st.lastAttempt = { at: iso(), ok: result.ok, category: result.category ?? null };
      if (!result.ok) {
        st.failures++;
        st.lastFailure = { at: iso(), category: result.category };
        observe(h.id, "basic", "failed", null, { ms: result.ms, category: result.category });
        evaluate(h, basicSignals(h, result, null));
        return { ok: false, category: result.category };
      }
      const data = P.parseBasic(result.stdout);
      if (!st.machine && data.machine) st.machine = st.lastGood?.data?.machine || data.machine;
      st.failures = 0;
      st.lastGood = { at: iso(), ms: result.ms, data };
      recordMetrics(h.id, data, result.ms);
      applyServices(h, data);
      if (now() - st.lastObservationWrite.basic > HEARTBEAT_MS || !previousOk) { observe(h.id, "basic", "ok", data, { ms: result.ms }); st.lastObservationWrite.basic = now(); }
      evaluate(h, basicSignals(h, result, data));
      return { ok: true, data };
    } finally { st.inFlight.delete("basic"); }
  }
  async function probeInventory(h) {
    const st = state(h.id);
    if (st.inFlight.has("inventory")) return { skipped: "in-flight" };
    st.inFlight.add("inventory");
    try {
      const result = await ssh.exec(h, P.inventoryScript(h.profile), { timeoutMs: 30_000, maxBytes: 64 * 1024 });
      if (!result.ok) { observe(h.id, "inventory", "failed", null, { ms: result.ms, category: result.category }); return { ok: false, category: result.category }; }
      const data = P.parseInventory(result.stdout);
      const before = st.inventory?.data?.deployments;
      for (const [env, d] of Object.entries(data.deployments)) {
        const prev = before?.[env];
        if (prev?.commitSha && d.commitSha && prev.commitSha !== d.commitSha) {
          company.log({ actorType: "system", actorId: "vps-monitor", action: "vps.deployment.changed", targetType: "vps", targetId: h.id, outcome: "info",
            summary: `${h.name}: تغيّر الإصدار المنشور في ${env} (${prev.commitSha.slice(0, 7)} ← ${d.commitSha.slice(0, 7)})`, metadata: { env, from: prev.commitSha, to: d.commitSha, release: d.currentName } });
          if (h.projectId) company.log({ actorType: "system", actorId: "vps-monitor", action: "vps.deployment.changed", targetType: "project", targetId: h.projectId, outcome: "info", summary: `نشر جديد في ${env}: ${d.commitSha.slice(0, 7)}` });
        }
      }
      st.inventory = { at: iso(), data };
      observe(h.id, "inventory", "ok", data, { ms: result.ms });
      return { ok: true, data };
    } finally { st.inFlight.delete("inventory"); }
  }
  async function probeSites(h, { withCert = false } = {}) {
    const st = state(h.id);
    if (st.inFlight.has("sites")) return { skipped: "in-flight" };
    st.inFlight.add("sites");
    try {
      const environments = {};
      for (const [env, def] of Object.entries(h.profile.environments || {})) {
        if (!def.url) continue;
        const r = await siteChecker(def.url, def.healthPath);
        const prevCert = st.sites?.data?.environments?.[env]?.cert ?? null;
        const cert = withCert || !prevCert ? await certChecker(new URL(def.url).hostname) : prevCert;
        const healthStatus = r.health?.status ?? null;
        environments[env] = { url: def.url, expected: def.expected, state: P.classifySite(def.expected, healthStatus ?? r.root?.status ?? null, r.health?.body), healthStatus, healthMs: r.health?.ms ?? null, healthBody: r.health?.body ?? null,
          rootStatus: r.root?.status ?? null, rootMs: r.root?.ms ?? null, error: r.health?.error ?? r.root?.error ?? null, cert, checkedAt: r.checkedAt };
      }
      const data = { environments };
      const signature = JSON.stringify(Object.values(environments).map((e) => [e.state, e.healthStatus, e.rootStatus, e.healthBody?.commit]));
      st.sites = { at: iso(), data };
      if (signature !== st.lastSiteState || now() - st.lastObservationWrite.sites > HEARTBEAT_MS) { observe(h.id, "sites", "ok", data); st.lastObservationWrite.sites = now(); st.lastSiteState = signature; }
      evaluate(h, siteSignals(h, data));
      return { ok: true, data };
    } finally { st.inFlight.delete("sites"); }
  }

  // ---------------------------------------------------------------- scheduler (no overlap per host, bounded backoff)
  async function tick() {
    if (!config.monitoring) return;
    const s = settings();
    for (const h of hosts().filter((x) => x.enabled)) {
      const st = state(h.id);
      const t = now();
      if (t >= st.next.basic && !st.inFlight.has("basic")) {
        const backoff = Math.min(2 ** Math.max(st.failures - 1, 0), 8);
        st.next.basic = t + Math.min(s.basicIntervalSec * 1000 * backoff, 600_000);
        probeBasic(h).then(() => { if (state(h.id).failures) state(h.id).next.basic = now() + Math.min(s.basicIntervalSec * 1000 * Math.min(2 ** Math.max(state(h.id).failures - 1, 0), 8), 600_000); })
          .catch((error) => log(JSON.stringify({ event: "vps-probe-error", host: h.id, kind: "basic", name: error?.name || "Error" })));
      }
      if (t >= st.next.inventory && !st.inFlight.has("inventory") && st.failures === 0 && st.lastGood) {
        st.next.inventory = t + s.inventoryIntervalSec * 1000;
        probeInventory(h).catch((error) => log(JSON.stringify({ event: "vps-probe-error", host: h.id, kind: "inventory", name: error?.name || "Error" })));
      }
      if (t >= st.next.sites && !st.inFlight.has("sites")) {
        const withCert = !st.nextCertAt || t >= st.nextCertAt;
        if (withCert) st.nextCertAt = t + 6 * 3_600_000;
        st.next.sites = t + s.siteIntervalSec * 1000;
        probeSites(h, { withCert }).catch((error) => log(JSON.stringify({ event: "vps-probe-error", host: h.id, kind: "sites", name: error?.name || "Error" })));
      }
    }
    if (now() - lastPrune > 6 * 3_600_000) { lastPrune = now(); try { prune(); } catch (error) { log(JSON.stringify({ event: "vps-prune-error", name: error?.name || "Error" })); } }
    maybeDailySummary();
  }
  /** Rolls raw samples into hourly buckets, then applies retention. */
  function prune() {
    const cutoff = isoAgo(RETENTION.rawDays * 86_400_000);
    const hourStart = new Date(Math.floor(now() / 3_600_000) * 3_600_000).toISOString();
    db.tx(() => {
      db.run(`INSERT OR REPLACE INTO vps_metrics (host_id, at, resolution, cpu_pct, load1, mem_pct, swap_pct, disk_pct, ssh_ms, samples)
        SELECT host_id, strftime('%Y-%m-%dT%H:00:00.000Z', at), 'hour', AVG(cpu_pct), AVG(load1), AVG(mem_pct), AVG(swap_pct), MAX(disk_pct), CAST(AVG(ssh_ms) AS INTEGER), COUNT(*)
        FROM vps_metrics WHERE resolution = 'raw' AND at < ? GROUP BY host_id, strftime('%Y-%m-%dT%H', at)`, hourStart);
      db.run("DELETE FROM vps_metrics WHERE resolution = 'raw' AND at < ?", cutoff);
      db.run("DELETE FROM vps_metrics WHERE resolution = 'hour' AND at < ?", isoAgo(RETENTION.hourlyDays * 86_400_000));
      db.run("DELETE FROM vps_observations WHERE at < ?", isoAgo(RETENTION.observationDays * 86_400_000));
      db.run("DELETE FROM vps_incidents WHERE state = 'recovered' AND recovered_at < ?", isoAgo(RETENTION.incidentDays * 86_400_000));
      db.run("UPDATE vps_actions SET status = 'expired' WHERE status = 'proposed' AND created_at < ?", isoAgo(PROPOSAL_TTL_MS));
    });
  }
  /** Optional daily AI summary: one ORI run per Cairo day, only when something changed in the last 24 hours. */
  function maybeDailySummary() {
    const s = settings();
    if (!s.dailySummary || !enqueueRun) return;
    const tz = company.settings().timezone;
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(now())));
    if (hour < 8) return;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(now())).replaceAll("-", "");
    const key = `vps-daily-${day}`;
    if (db.get("SELECT id FROM agent_runs WHERE idempotency_key = ?", key)) return;
    const since = isoAgo(86_400_000);
    const changed = db.get("SELECT COUNT(*) AS n FROM vps_incidents WHERE started_at >= ? OR recovered_at >= ? OR state = 'open'", since, since).n
      + db.get("SELECT COUNT(*) AS n FROM activity_events WHERE action IN ('vps.deployment.changed','vps.action.succeeded','vps.action.failed') AND at >= ?", since).n;
    if (!changed) return;
    try { enqueueRun({ agentId: "ori", capability: "infra_review", priority: "low", idempotencyKey: key, request: "ملخص يومي موجز لحالة البنية التحتية خلال آخر 24 ساعة: التوافر، الانقطاعات، تحذيرات الموارد، صحة الإنتاج، الحوادث المفتوحة، والتوصيات." }, { type: "system", id: "vps-monitor" }); }
    catch (error) { log(JSON.stringify({ event: "vps-daily-summary-skipped", code: error?.code || "error" })); }
  }

  // ---------------------------------------------------------------- read views (shared by UI routes and agent tools)
  function freshness(at, intervalSec) {
    if (!at) return { at: null, ageSec: null, fresh: false };
    const ageSec = Math.round((now() - Date.parse(at)) / 1000);
    return { at, ageSec, fresh: ageSec <= intervalSec * 3 };
  }
  function connection(h) {
    if (!config.private.has(h.id) && !transport) return { state: "not-configured", ar: "مفتاح SSH غير محدد في الإعداد المحلي" };
    if (!h.enabled) return { state: "disabled", ar: "معطل" };
    const st = state(h.id);
    if (!st.lastAttempt) return { state: "pending", ar: "لم يُفحص بعد" };
    const f = freshness(st.lastAttempt.at, settings().basicIntervalSec);
    if (!st.lastAttempt.ok) return { state: "disconnected", category: st.lastAttempt.category, ar: SSH_ERRORS[st.lastAttempt.category] ?? "تعذر الاتصال", consecutiveFailures: st.failures, ...f };
    return { state: f.fresh ? "connected" : "stale", ar: f.fresh ? "متصل" : "آخر قراءة قديمة", ...f };
  }
  function services(h) {
    const st = state(h.id);
    const live = connection(h).state === "connected";
    return db.all("SELECT service, kind, environment, state, detail, observed_at, changed_at FROM vps_services WHERE host_id = ? ORDER BY CASE environment WHEN 'host' THEN 0 WHEN 'production' THEN 1 ELSE 2 END, service", h.id)
      .map((r) => {
        // A failed SSH check never turns a service into "stopped": its last observed state is kept and labelled stale.
        const stale = !live || (now() - Date.parse(r.observed_at)) / 1000 > settings().basicIntervalSec * 3;
        return { service: r.service, kind: r.kind, environment: r.environment, state: r.state, ar: SERVICE_AR[r.state] ?? r.state, stale, observedAt: r.observed_at, changedAt: r.changed_at, detail: parseJson(r.detail, {}), lastSshFailure: stale ? st.lastFailure : null };
      });
  }
  function openIncidents(hostId = null, limit = 50) {
    return db.all(`SELECT * FROM vps_incidents WHERE state = 'open' ${hostId ? "AND host_id = ?" : ""} ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, started_at DESC LIMIT ?`, ...(hostId ? [hostId] : []), limit).map(incidentRow);
  }
  const incidentRow = (r) => ({ id: r.id, hostId: r.host_id, key: r.dedupe_key.split(":").slice(2).join(":"), service: r.service, severity: r.severity, state: r.state, title: r.title, detection: r.detection, evidence: parseJson(r.evidence, null),
    assignedAgent: r.assigned_agent, taskId: r.task_id, diagnosisRunId: r.diagnosis_run_id, startedAt: r.started_at, lastSeenAt: r.last_seen_at, recoveredAt: r.recovered_at });
  function incidents(hostId, { days = 30, limit = 100 } = {}) {
    return db.all("SELECT * FROM vps_incidents WHERE host_id = ? AND (state = 'open' OR started_at >= ?) ORDER BY started_at DESC LIMIT ?", hostId, isoAgo(days * 86_400_000), limit).map(incidentRow);
  }
  function metrics(hostId, range = "24h") {
    const spans = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
    const span = spans[range] ?? spans["24h"];
    const since = isoAgo(span);
    const rows = span <= spans["24h"]
      ? db.all("SELECT at, cpu_pct, load1, mem_pct, swap_pct, disk_pct, ssh_ms FROM vps_metrics WHERE host_id = ? AND resolution = 'raw' AND at >= ? ORDER BY at", hostId, since)
      : db.all("SELECT at, cpu_pct, load1, mem_pct, swap_pct, disk_pct, ssh_ms FROM vps_metrics WHERE host_id = ? AND at >= ? AND (resolution = 'hour' OR at >= ?) ORDER BY at", hostId, since, isoAgo(RETENTION.rawDays * 86_400_000));
    const stat = (key) => {
      const values = rows.map((r) => r[key]).filter(Number.isFinite);
      if (!values.length) return null;
      return { min: Math.min(...values), avg: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10, max: Math.max(...values), last: values.at(-1), first: values[0] };
    };
    const buckets = 48;
    const step = Math.max(1, Math.ceil(rows.length / buckets));
    const series = [];
    for (let i = 0; i < rows.length; i += step) {
      const chunk = rows.slice(i, i + step);
      const avg = (k) => { const v = chunk.map((r) => r[k]).filter(Number.isFinite); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
      series.push({ at: chunk[0].at, cpu: avg("cpu_pct"), mem: avg("mem_pct"), disk: avg("disk_pct"), sshMs: avg("ssh_ms") });
    }
    return { range, samples: rows.length, since, basis: "measured by read-only SSH probes from this machine", cpuPct: stat("cpu_pct"), load1: stat("load1"), memPct: stat("mem_pct"), swapPct: stat("swap_pct"), diskPct: stat("disk_pct"), sshMs: stat("ssh_ms"), series };
  }
  function deployment(h) {
    const st = state(h.id);
    const inv = st.inventory;
    const sites = st.sites?.data?.environments || {};
    const environments = {};
    for (const [env, def] of Object.entries(h.profile.environments || {})) {
      const d = inv?.data?.deployments?.[env] ?? null;
      const publicCommit = sites[env]?.healthBody?.commit ?? null;
      environments[env] = { expected: def.expected, note: def.note, url: def.url, currentRelease: d?.currentName ?? null, commitSha: d?.commitSha ?? null, branch: d?.branch ?? null, deployedAt: d?.deployedAt ?? null,
        releases: d?.releases ?? [], rollbackCandidate: d?.rollbackCandidate ?? null, publicHealthCommit: publicCommit,
        provenanceMatch: d?.commitSha && publicCommit ? d.commitSha === publicCommit : null, site: sites[env] ? { state: sites[env].state, ar: SITE_AR[sites[env].state], healthStatus: sites[env].healthStatus } : null };
    }
    return { hostId: h.id, observed: freshness(inv?.at ?? null, settings().inventoryIntervalSec), environments, postgres: inv?.data?.postgres ?? null, nginx: inv?.data?.nginx ?? null, recentBoots: inv?.data?.recentBoots ?? [] };
  }
  function overview(h) {
    const st = state(h.id);
    const conn = connection(h);
    const data = st.lastGood?.data ?? null;
    const svc = services(h);
    const open = openIncidents(h.id);
    return {
      id: h.id, name: h.name, provider: h.provider, endpoint: `${h.sshUser}@${h.address}:${h.port}`, projectId: h.projectId, enabled: h.enabled, connection: conn,
      lastSuccessAt: st.lastGood?.at ?? null, lastFailure: st.lastFailure, lastProbeMs: st.lastGood?.ms ?? null,
      system: data ? { hostname: data.hostname, os: data.os, kernel: data.kernel, uptimeSec: data.uptimeSec, cpu: data.cpu, memory: data.memory, disk: data.disk, filesystems: data.filesystems, failedUnits: data.failedUnits, observed: freshness(st.lastGood.at, settings().basicIntervalSec) } : null,
      services: svc, sites: st.sites?.data?.environments ?? {}, sitesObservedAt: st.sites?.at ?? null,
      incidents: { open: open.length, critical: open.filter((i) => i.severity === "critical").length, list: open.slice(0, 10) },
      deployment: deployment(h), hostKeyFingerprint: h.hostKeyFingerprint
    };
  }
  function attention() {
    return { hosts: hosts().filter((h) => h.enabled).map((h) => ({ id: h.id, name: h.name, connection: connection(h).state })), incidents: openIncidents(null, 8).filter((i) => i.severity !== "info") };
  }
  function forProject(projectId) {
    return hosts().filter((h) => h.projectId === projectId && h.enabled).map((h) => {
      const o = overview(h);
      return { id: h.id, name: h.name, connection: o.connection, deployment: o.deployment, services: o.services.filter((s) => s.environment !== "host"), sites: o.sites, incidents: incidents(h.id, { days: 14, limit: 10 }),
        tasks: company.listTasks({ projectId, includeClosed: false, limit: 50 }).filter((t) => t.tags.includes("vps")) };
    });
  }
  function status() {
    return { configured: config.configured, monitoring: config.monitoring, configErrors: config.errors, settings: settings(), hosts: hosts().map((h) => ({ id: h.id, name: h.name, enabled: h.enabled, connection: connection(h) })) };
  }

  // ---------------------------------------------------------------- read-only diagnostics and logs (Tier 0/1), audited
  async function diagnostic(hostId, key, actor) {
    const h = host(hostId);
    if (!P.DIAGNOSTICS[key]) throw new HttpError(422, "unknown-diagnostic", "فحص غير مسموح");
    const r = await ssh.exec(h, P.diagnosticScript(h.profile, key), { timeoutMs: 25_000, maxBytes: 64 * 1024 });
    const out = r.ok ? P.redactRemote(r.stdout, { maxLines: 40 }) : null;
    company.log({ actorType: actor.type, actorId: actor.id, action: "vps.diagnostic", targetType: "vps", targetId: h.id, outcome: r.ok ? "info" : "failure", summary: `${h.name}: فحص ${P.DIAGNOSTICS[key].ar}${r.ok ? "" : ` (فشل: ${r.category})`}`, metadata: { diagnostic: key, ms: r.ms } });
    return { hostId: h.id, diagnostic: key, ar: P.DIAGNOSTICS[key].ar, ok: r.ok, error: r.ok ? null : { category: r.category, ar: SSH_ERRORS[r.category] }, exitCode: r.code ?? null, output: out, ranAt: iso(),
      provenance: "read-only allowlisted diagnostic over SSH; remote text is untrusted data and has been redacted" };
  }
  async function logs(hostId, source, service, actor) {
    const h = host(hostId);
    const def = P.LOG_SOURCES[source];
    if (!def) throw new HttpError(422, "unknown-log-source", "مصدر سجل غير مسموح");
    if (def.needsService && !(h.profile.pm2 || []).some((g) => g.services.some((s) => s.name === service))) throw new HttpError(422, "unknown-service", "الخدمة غير معروفة لهذا الخادم");
    const r = await ssh.exec(h, P.logScript(h.profile, source, def.needsService ? service : null), { timeoutMs: 25_000, maxBytes: 256 * 1024 });
    company.log({ actorType: actor.type, actorId: actor.id, action: "vps.logs.read", targetType: "vps", targetId: h.id, outcome: r.ok ? "info" : "failure", summary: `${h.name}: قراءة سجل منقّح — ${def.ar}${service ? ` (${service})` : ""}`, metadata: { source, service: service ?? null } });
    return { hostId: h.id, source, service: service ?? null, ar: def.ar, ok: r.ok, error: r.ok ? null : { category: r.category, ar: SSH_ERRORS[r.category] }, log: r.ok ? P.redactRemote(r.stdout, { maxLines: def.lines }) : null, readAt: iso(),
      provenance: "bounded tail, redacted locally (credentials, tokens, emails, IPs, query strings, shared paths); untrusted data" };
  }

  // ---------------------------------------------------------------- controlled actions (Tier 2 with owner approval)
  const actionRow = (r) => r && ({ id: r.id, hostId: r.host_id, operation: r.operation, ar: ACTIONS[r.operation]?.ar ?? r.operation, params: parseJson(r.params, {}), environment: r.environment, tier: r.tier, reason: r.reason, requestedBy: r.requested_by,
    incidentId: r.incident_id, status: r.status, approvalExpiresAt: r.approval_expires_at, approvedAt: r.approved_at, preState: parseJson(r.pre_state, null), postState: parseJson(r.post_state, null),
    exitCode: r.exit_code, output: parseJson(r.output, null), result: parseJson(r.result, null), createdAt: r.created_at, decidedAt: r.decided_at, startedAt: r.started_at, finishedAt: r.finished_at, review: review(r) });
  /** The owner-facing explanation of one proposal: what runs, where, what it affects and how to recover. */
  function review(r) {
    const params = parseJson(r.params, {});
    const h = hostRow(db.get("SELECT * FROM vps_hosts WHERE id = ?", r.host_id));
    const prod = r.environment === "production";
    if (r.operation === "pm2.restart") {
      const group = h?.profile?.pm2?.find((g) => g.services.some((s) => s.name === params.service));
      return { command: `su -s /bin/bash ${group?.user ?? "?"} -c 'pm2 restart ${params.service}'`, confirmPhrase: params.service, risk: prod ? "high" : "medium",
        impactAr: prod ? `تُعاد تشغيل ${params.service} في الإنتاج؛ قد تنقطع الطلبات والجلسات الحالية لثوانٍ وقد يرى المستخدمون أخطاء مؤقتة.` : `تُعاد تشغيل ${params.service} في staging.`,
        downtimeAr: "عادة من ثانيتين إلى 15 ثانية حتى تصبح الخدمة online.",
        preconditionsAr: ["التحقق من هوية الخادم وبصمة مفتاحه", `الخدمة ${params.service} موجودة في PM2 للمستخدم ${group?.user ?? "?"}`, "لا توجد عملية أخرى قيد التنفيذ على هذا الخادم"],
        recoveryAr: "إذا لم تعد الخدمة online: راجع سجل أخطاء PM2 المنقّح، ثم أبلغ ORI. لا يوجد تراجع تلقائي؛ الإصدار المنشور لا يتغير بإعادة التشغيل.",
        verificationAr: "بعد التنفيذ: الحالة online، ووقت البدء أحدث من قبل التنفيذ، وفحص الصحة العام للبيئة سليم." };
    }
    if (r.operation === "nginx.reload") {
      return { command: "nginx -t && systemctl reload nginx", confirmPhrase: "nginx", risk: "high",
        impactAr: "يعيد Nginx قراءة إعداده لكل المواقع على هذا الخادم (ومنها مواقع غير ELHABAK). لا يُنفذ إن فشل nginx -t.", downtimeAr: "إعادة التحميل لا تقطع الاتصالات القائمة عادة.",
        preconditionsAr: ["التحقق من هوية الخادم", "نجاح nginx -t مباشرة قبل التنفيذ", "لا توجد عملية أخرى قيد التنفيذ"],
        recoveryAr: "إذا تدهورت المواقع بعد إعادة التحميل: الإعداد على القرص لم يتغير بهذه العملية؛ راجع آخر تعديل يدوي لإعداد Nginx (خارج هذا النظام).",
        verificationAr: "بعد التنفيذ: nginx active وفحوص الصحة العامة سليمة." };
    }
    return { command: null, confirmPhrase: null, risk: "high", impactAr: "عملية من الفئة 3 لا تُنفذ من هذا المسار.", preconditionsAr: [], recoveryAr: null, verificationAr: null };
  }
  function listActions({ hostId = null, status: st = null, limit = 50 } = {}) {
    db.run("UPDATE vps_actions SET status = 'expired' WHERE (status = 'proposed' AND created_at < ?) OR (status = 'approved' AND approval_expires_at < ?)", isoAgo(PROPOSAL_TTL_MS), iso());
    const where = [], params = [];
    if (hostId) { where.push("host_id = ?"); params.push(hostId); }
    if (st) { where.push("status = ?"); params.push(st); }
    return db.all(`SELECT * FROM vps_actions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`, ...params, Math.min(Number(limit) || 50, 200)).map(actionRow);
  }
  function getAction(id) {
    listActions({ limit: 1 }); // applies expiry
    const row = db.get("SELECT * FROM vps_actions WHERE id = ?", String(id));
    if (!row) throw new HttpError(404, "not-found", "الإجراء غير موجود");
    return actionRow(row);
  }
  function propose({ hostId, operation, service = null, reason, incidentId = null }, actor) {
    const h = resolveHost(hostId);
    const def = ACTIONS[operation];
    if (!def) throw new HttpError(422, "unknown-operation", "عملية غير موجودة في سجل العمليات المسموحة");
    if (def.tier >= 3) throw new HttpError(403, "tier3-not-automatable", `«${def.ar}» عملية عالية الخطورة (الفئة 3): تحتاج تفويضًا خاصًا بالمهمة ونسخًا احتياطيًا وفحوصًا مسبقة وسير عمل متخصصًا، ولا تُنفذ من مسار الإجراءات العام.`);
    const text = typeof reason === "string" ? reason.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500) : "";
    if (text.length < 8) throw new HttpError(422, "validation", "اذكر سبب الإجراء");
    let environment = "host", params = {};
    if (def.needsService) {
      const svc = (h.profile.pm2 || []).flatMap((g) => g.services).find((s) => s.name === service);
      if (!svc) throw new HttpError(422, "unknown-service", "الخدمة ليست ضمن خدمات PM2 المسجلة لهذا الخادم");
      const observed = db.get("SELECT state FROM vps_services WHERE host_id = ? AND service = ?", h.id, svc.name);
      if (!observed || ["absent", "retired"].includes(observed.state)) throw new HttpError(409, "service-not-present", "الخدمة غير موجودة فعليًا على الخادم وفق آخر فحص؛ لا يمكن إعادة تشغيلها");
      environment = svc.environment; params = { service: svc.name };
    } else environment = "production";
    if (incidentId && !db.get("SELECT id FROM vps_incidents WHERE id = ? AND host_id = ?", incidentId, h.id)) throw new HttpError(422, "validation", "الحادثة غير موجودة");
    const existing = db.get("SELECT id FROM vps_actions WHERE host_id = ? AND operation = ? AND params = ? AND status IN ('proposed','approved','running')", h.id, operation, JSON.stringify(params));
    if (existing) return { ...getAction(existing.id), deduplicated: true };
    const id = newId("act");
    const requestedBy = `${actor.type}:${actor.id}`;
    db.run("INSERT INTO vps_actions (id, host_id, operation, params, environment, tier, reason, requested_by, incident_id, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,'proposed',?)",
      id, h.id, operation, JSON.stringify(params), environment, def.tier, text, requestedBy, incidentId, iso());
    company.log({ actorType: actor.type, actorId: actor.id, action: "vps.action.proposed", targetType: "vps", targetId: h.id, outcome: "pending", summary: `اقتراح إجراء على ${h.name}: ${def.ar}${params.service ? ` (${params.service})` : ""} — بانتظار موافقة المالك`, metadata: { actionId: id, operation, params, environment } });
    company.raise({ key: `vps-action:${id}`, level: "warning", kind: "vps-approval", title: `موافقة مطلوبة: ${def.ar}${params.service ? ` (${params.service})` : ""}`, body: text, targetType: "vps", targetId: h.id });
    return getAction(id);
  }
  const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");
  function approve(id, { confirmText }, actor) {
    if (actor?.type !== "owner") throw new HttpError(403, "owner-only", "الموافقة على إجراءات الخادم للمالك فقط");
    const action = getAction(id);
    if (action.status !== "proposed") throw new HttpError(409, "not-pending", "هذا الإجراء ليس بانتظار الموافقة");
    if (typeof confirmText !== "string" || confirmText.trim() !== action.review.confirmPhrase) throw new HttpError(422, "confirmation-mismatch", `اكتب «${action.review.confirmPhrase}» حرفيًا لتأكيد الهدف`);
    const token = randomBytes(32).toString("hex");
    const expires = new Date(now() + APPROVAL_TTL_MS).toISOString();
    const changed = db.run("UPDATE vps_actions SET status = 'approved', approval_hash = ?, approval_expires_at = ?, approved_at = ?, decided_at = ? WHERE id = ? AND status = 'proposed'", hashToken(token), expires, iso(), iso(), id).changes;
    if (changed !== 1) throw new HttpError(409, "not-pending", "تغيرت حالة الإجراء");
    company.log({ actorType: "owner", actorId: actor.id, action: "vps.action.approved", targetType: "vps", targetId: action.hostId, outcome: "info", summary: `موافقة المالك على: ${action.ar}${action.params.service ? ` (${action.params.service})` : ""} — صالحة 5 دقائق لمرة واحدة`, metadata: { actionId: id } });
    db.run("UPDATE notifications SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL", iso(), `vps-action:${id}`);
    return { action: getAction(id), token, expiresAt: expires };
  }
  function reject(id, actor) {
    if (actor?.type !== "owner") throw new HttpError(403, "owner-only", "القرار للمالك فقط");
    const action = getAction(id);
    if (!["proposed", "approved"].includes(action.status)) throw new HttpError(409, "not-pending", "لا يمكن رفض هذا الإجراء الآن");
    db.run("UPDATE vps_actions SET status = 'rejected', approval_hash = NULL, decided_at = ? WHERE id = ?", iso(), id);
    db.run("UPDATE notifications SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL", iso(), `vps-action:${id}`);
    company.log({ actorType: "owner", actorId: actor.id, action: "vps.action.rejected", targetType: "vps", targetId: action.hostId, outcome: "info", summary: `رفض المالك: ${action.ar}` });
    return getAction(id);
  }
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** A probe for an action never reuses a scheduled probe's result: it waits (bounded) for that one to finish, then runs. */
  async function probeNow(h, kind) {
    for (let i = 0; i < 60 && state(h.id).inFlight.has(kind); i++) await pause(500);
    return kind === "basic" ? probeBasic(h) : probeSites(h);
  }
  async function execute(id, { token }, actor) {
    if (actor?.type !== "owner") throw new HttpError(403, "owner-only", "التنفيذ بموافقة المالك فقط");
    const row = db.get("SELECT * FROM vps_actions WHERE id = ?", String(id));
    if (!row) throw new HttpError(404, "not-found", "الإجراء غير موجود");
    if (row.status !== "approved") throw new HttpError(409, "not-approved", "الإجراء غير معتمد أو استُخدمت موافقته");
    if (!row.approval_expires_at || Date.parse(row.approval_expires_at) < now()) {
      db.run("UPDATE vps_actions SET status = 'expired', approval_hash = NULL WHERE id = ?", id);
      throw new HttpError(409, "approval-expired", "انتهت صلاحية الموافقة (5 دقائق)؛ أعد الموافقة");
    }
    const given = Buffer.from(hashToken(token ?? ""), "hex"), stored = Buffer.from(row.approval_hash || "", "hex");
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) throw new HttpError(403, "approval-invalid", "رمز الموافقة غير صالح لهذا الإجراء");
    if (locks.has(row.host_id)) throw new HttpError(409, "host-busy", "عملية أخرى قيد التنفيذ على هذا الخادم");
    locks.add(row.host_id);
    try {
      // Single use: the approval is consumed atomically before anything runs.
      if (db.run("UPDATE vps_actions SET status = 'running', approval_hash = NULL, started_at = ? WHERE id = ? AND status = 'approved' AND approval_hash = ?", iso(), id, row.approval_hash).changes !== 1) throw new HttpError(409, "approval-consumed", "استُخدمت هذه الموافقة بالفعل");
      const h = host(row.host_id);
      const params = parseJson(row.params, {});
      const finish = (statusText, fields) => {
        db.run("UPDATE vps_actions SET status = ?, finished_at = ?, pre_state = ?, post_state = ?, exit_code = ?, output = ?, result = ? WHERE id = ?", statusText, iso(),
          JSON.stringify(fields.pre ?? null), JSON.stringify(fields.post ?? null), fields.exitCode ?? null, JSON.stringify(fields.output ?? null), JSON.stringify(fields.result), id);
        company.log({ actorType: "owner", actorId: actor.id, action: `vps.action.${statusText}`, targetType: "vps", targetId: h.id, outcome: statusText === "succeeded" ? "success" : "failure",
          summary: `${h.name}: ${ACTIONS[row.operation].ar}${params.service ? ` (${params.service})` : ""} — ${statusText === "succeeded" ? "نجح وتحقق" : `فشل: ${fields.result.ar}`}`, metadata: { actionId: id, ...fields.result }, evidence: "post-action verification" });
        if (h.projectId) company.log({ actorType: "owner", actorId: actor.id, action: `vps.action.${statusText}`, targetType: "project", targetId: h.projectId, outcome: statusText === "succeeded" ? "success" : "failure", summary: `إجراء خادم: ${ACTIONS[row.operation].ar} (${statusText === "succeeded" ? "نجح" : "فشل"})` });
        return getAction(id);
      };
      // 1. host identity and current state (fresh probe; also proves SSH works with the pinned key)
      const before = await probeNow(h, "basic");
      if (!before.ok) return finish("failed", { result: { stage: "preflight", ar: `تعذر التحقق من الخادم قبل التنفيذ: ${SSH_ERRORS[before.category] ?? before.category}` } });
      if (h.expectedHostname && before.data.hostname !== h.expectedHostname) return finish("failed", { result: { stage: "identity", ar: "اسم الخادم لا يطابق المسجّل؛ لم يُنفذ شيء" } });
      let script, pre;
      if (row.operation === "pm2.restart") {
        const group = h.profile.pm2.find((g) => g.services.some((s) => s.name === params.service));
        const proc = before.data.pm2?.[group?.user]?.processes?.find((p) => p.name === params.service);
        if (!group || !proc) return finish("failed", { result: { stage: "preflight", ar: "الخدمة غير موجودة في PM2 الآن؛ لم يُنفذ شيء" } });
        pre = { status: proc.status, startedAt: proc.startedAt, restarts: proc.restarts };
        // group.user and params.service were validated against the registry patterns; they are the only interpolated values.
        script = `export LC_ALL=C\ntimeout 60 su -s /bin/bash '${group.user}' -c 'pm2 restart ${params.service}' >/dev/null 2>&1; rc=$?\necho @@exit; echo $rc\n`;
      } else if (row.operation === "nginx.reload") {
        pre = { nginx: before.data.systemd?.nginx ?? null };
        script = "export LC_ALL=C\necho @@test; nginx -t 2>&1 | tail -n 2\nif nginx -t >/dev/null 2>&1; then systemctl reload nginx; rc=$?; echo @@exit; echo $rc; else echo @@exit; echo config-invalid; fi\n";
      } else return finish("failed", { result: { stage: "registry", ar: "عملية غير قابلة للتنفيذ" } });
      // 2. the single allowlisted command
      const run = await ssh.exec(h, script, { timeoutMs: 75_000, maxBytes: 32 * 1024 });
      if (!run.ok) return finish("failed", { pre, result: { stage: "execute", ar: `فشل الاتصال أثناء التنفيذ: ${SSH_ERRORS[run.category] ?? run.category}. الحالة الفعلية غير مؤكدة؛ راجع الحالة يدويًا.` } });
      const out = P.sections(run.stdout);
      const exitText = out.exit?.[0]?.trim();
      const exitCode = /^\d+$/.test(exitText || "") ? Number(exitText) : null;
      const output = P.redactRemote(run.stdout, { maxLines: 12 });
      if (exitText === "config-invalid") return finish("failed", { pre, output, result: { stage: "preflight", ar: "فشل nginx -t؛ لم تتم إعادة التحميل" } });
      if (exitCode !== 0) return finish("failed", { pre, exitCode, output, result: { stage: "execute", ar: `أعاد الأمر رمز خروج ${exitText ?? "غير معروف"}` } });
      // 3. post-action verification: success is claimed only on evidence
      let post = null, verified = false;
      for (let attempt = 0; attempt < 4 && !verified; attempt++) {
        await pause(attempt === 0 ? 3000 : 5000);
        const after = await probeNow(h, "basic");
        if (!after.ok) continue;
        if (row.operation === "pm2.restart") {
          const group = h.profile.pm2.find((g) => g.services.some((s) => s.name === params.service));
          const proc = after.data.pm2?.[group.user]?.processes?.find((p) => p.name === params.service);
          post = proc ? { status: proc.status, startedAt: proc.startedAt, restarts: proc.restarts } : { status: "absent" };
          verified = proc?.status === "online" && (!pre.startedAt || (proc.startedAt && proc.startedAt > pre.startedAt));
        } else {
          post = { nginx: after.data.systemd?.nginx ?? null };
          verified = post.nginx === "active";
        }
      }
      const envDef = row.operation === "pm2.restart" ? h.profile.environments?.[row.environment] : h.profile.environments?.production;
      let site = null;
      if (verified && envDef?.url && envDef.expected === "active") {
        const sites = await probeNow(h, "sites");
        site = sites.data?.environments?.[row.environment === "host" ? "production" : row.environment] ?? sites.data?.environments?.production ?? null;
        if (site && site.state !== "ok") verified = false;
      }
      post = { ...post, site: site ? { state: site.state, healthStatus: site.healthStatus } : null };
      return finish(verified ? "succeeded" : "failed", { pre, post, exitCode, output,
        result: verified ? { stage: "verified", ar: "نُفذ وتحقق: الحالة اللاحقة سليمة" } : { stage: "verification", ar: "نُفذ الأمر لكن التحقق اللاحق لم يثبت النجاح؛ راجع الحالة" } });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      db.run("UPDATE vps_actions SET status = 'failed', finished_at = ?, result = ? WHERE id = ? AND status = 'running'", iso(), JSON.stringify({ stage: "internal", ar: "خطأ داخلي أثناء التنفيذ" }), id);
      throw error;
    } finally { locks.delete(row.host_id); }
  }

  // ---------------------------------------------------------------- agent tools (sanitized, compact outputs)
  // PM2's restart_time is cumulative since the daemon started (deploys included); the last-hour burst is what alerts use.
  const compactServices = (h) => {
    const recent = state(h.id).restartLog || [];
    return services(h).map((s) => ({ service: s.service, env: s.environment, state: s.state, stale: s.stale, since: s.changedAt, processStartedAt: s.detail.startedAt ?? null,
      restartsCumulativeSincePm2Start: s.detail.restarts ?? null, restartsLastHourObserved: s.kind === "pm2" ? recent.filter((r) => r.service === s.service).reduce((n, r) => n + r.n, 0) : null, memoryMb: s.detail.memoryMb ?? null }));
  };
  const tools = {
    listHosts: () => ({ hosts: hosts().filter((h) => h.enabled).map((h) => { const c = connection(h); return { id: h.id, name: h.name, provider: h.provider, projectId: h.projectId, environments: Object.keys(h.profile.environments || {}), connection: c.state, lastSuccessAt: state(h.id).lastGood?.at ?? null, dataAgeSec: c.ageSec ?? null }; }) }),
    async getHealth({ hostId, projectId }) {
      const h = resolveHost(hostId, projectId);
      const st = state(h.id);
      // Fresh data for the agent: a reading older than two minutes triggers one bounded probe (never an overlapping one).
      if (!st.lastAttempt || now() - Date.parse(st.lastAttempt.at) > 120_000) await probeNow(h, "basic");
      const o = overview(h);
      return { host: { id: h.id, name: h.name }, connection: o.connection, observedAt: o.lastSuccessAt, dataFresh: o.system?.observed?.fresh ?? false,
        system: o.system ? { uptimeHours: Math.round(o.system.uptimeSec / 3600), cpuPct: o.system.cpu.pct, load1: o.system.cpu.load1, cores: o.system.cpu.cores, memUsedPct: o.system.memory.usedPct, swapUsedPct: o.system.memory.swapUsedPct, diskUsedPct: o.system.disk?.usedPct ?? null, diskFreeGb: o.system.disk ? Math.round(o.system.disk.availBytes / 1073741824) : null, failedUnits: o.system.failedUnits } : null,
        services: compactServices(h), sites: Object.fromEntries(Object.entries(o.sites).map(([env, s]) => [env, { state: s.state, expected: s.expected, healthStatus: s.healthStatus, healthMs: s.healthMs, certDaysLeft: s.cert?.daysLeft ?? null }])),
        openIncidents: o.incidents.list.map((i) => ({ id: i.id, severity: i.severity, title: i.title, since: i.startedAt })), provenance: "deterministic read-only probes; no inference" };
    },
    getMetrics: ({ hostId, projectId, range = "24h" }) => { const h = resolveHost(hostId, projectId); const m = metrics(h.id, range); return { host: h.id, ...m, series: m.series.slice(-24) }; },
    listServices: ({ hostId, projectId }) => { const h = resolveHost(hostId, projectId); return { host: h.id, connection: connection(h).state, services: compactServices(h), note: "stale=true means the last SSH check failed or is old; the state shown is the last verified one" }; },
    getServiceStatus: ({ hostId, projectId, service }) => {
      const h = resolveHost(hostId, projectId);
      const s = services(h).find((x) => x.service === service);
      if (!s) throw new HttpError(404, "not-found", "الخدمة غير معروفة لهذا الخادم");
      return { host: h.id, ...s, incidents: incidents(h.id, { days: 7 }).filter((i) => i.service === service).slice(0, 5) };
    },
    getDeploymentInfo: ({ hostId, projectId }) => deployment(resolveHost(hostId, projectId)),
    getRecentEvents: ({ hostId, projectId }) => {
      const h = resolveHost(hostId, projectId);
      return { host: h.id, incidents: incidents(h.id, { days: 7, limit: 15 }).map((i) => ({ id: i.id, severity: i.severity, state: i.state, title: i.title, detection: i.detection, startedAt: i.startedAt, recoveredAt: i.recoveredAt, assignedAgent: i.assignedAgent })),
        events: company.activity({ targetType: "vps", targetId: h.id, limit: 20 }).map((e) => ({ at: e.at, action: e.action, outcome: e.outcome, summary: e.summary })),
        sshFailures24h: db.get("SELECT COUNT(*) AS n FROM vps_observations WHERE host_id = ? AND kind = 'basic' AND state = 'failed' AND at >= ?", h.id, isoAgo(86_400_000)).n,
        pendingActions: listActions({ hostId: h.id }).filter((a) => ["proposed", "approved"].includes(a.status)).map((a) => ({ id: a.id, operation: a.operation, params: a.params, status: a.status, requestedBy: a.requestedBy })) };
    },
    getRedactedLogs: ({ hostId, projectId, source, service }, actor) => logs(resolveHost(hostId, projectId).id, source, service, actor),
    runSafeDiagnostic: ({ hostId, projectId, diagnostic: key }, actor) => diagnostic(resolveHost(hostId, projectId).id, key, actor),
    createActionProposal: ({ hostId, projectId, operation, service, reason }, actor) => {
      const a = propose({ hostId: resolveHost(hostId, projectId).id, operation, service, reason }, actor);
      return { id: a.id, status: a.status, operation: a.operation, params: a.params, environment: a.environment, risk: a.review.risk, deduplicated: Boolean(a.deduplicated), note: "Proposal only. Nothing runs until the owner approves this exact action in the Company OS." };
    },
    getActionResult: ({ actionId }) => { const a = getAction(actionId); return { id: a.id, operation: a.operation, params: a.params, status: a.status, result: a.result, preState: a.preState, postState: a.postState, finishedAt: a.finishedAt }; }
  };

  return {
    reload, settings, updateSettings, hosts, host, resolveHost, status, overview: (id) => overview(host(id)), services: (id) => services(host(id)), metrics, deployment: (id) => deployment(host(id)),
    incidents, openIncidents, attention, forProject, diagnostic, logs, listActions, getAction, propose, approve, reject, execute, tools, prune,
    incident(id) { const r = db.get("SELECT * FROM vps_incidents WHERE id = ?", String(id)); if (!r) throw new HttpError(404, "not-found", "الحادثة غير موجودة"); return incidentRow(r); },
    linkDiagnosis(id, runId) { db.run("UPDATE vps_incidents SET diagnosis_run_id = ? WHERE id = ?", runId, id); },
    probe: async (id, kind = "all") => {
      const h = host(id);
      const out = {};
      if (kind === "all" || kind === "basic") out.basic = await probeNow(h, "basic");
      if ((kind === "all" && out.basic?.ok) || kind === "inventory") out.inventory = await probeInventory(h);
      if (kind === "all" || kind === "sites") { for (let i = 0; i < 60 && state(h.id).inFlight.has("sites"); i++) await pause(500); out.sites = await probeSites(h, { withCert: true }); }
      return { host: h.id, basic: out.basic ? { ok: out.basic.ok ?? false, category: out.basic.category ?? null, skipped: out.basic.skipped ?? null } : null, inventory: out.inventory ? { ok: out.inventory.ok ?? false, category: out.inventory.category ?? null } : null, sites: out.sites ? { ok: out.sites.ok ?? false } : null };
    },
    setEnqueue(fn) { enqueueRun = fn; },
    start() { if (timer) return; timer = setInterval(() => { tick().catch((error) => log(JSON.stringify({ event: "vps-tick-error", name: error?.name || "Error" }))); }, 15_000); timer.unref?.(); setTimeout(() => tick().catch(() => {}), 5000).unref?.(); },
    stop() { clearInterval(timer); timer = null; },
    _tick: tick, _evaluate: evaluate
  };
}
