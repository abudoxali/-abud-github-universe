import { createServer as createHttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, extname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, timingSafeEqual } from "node:crypto";
import vm from "node:vm";
import { isAllowedAsset, isInternalAsset, loadWorldConfig, readGitProject, sanitizeWorldConfig } from "./git.mjs";
import { createRouterClient, createRouterService, DEFAULT_THRESHOLDS, RANGES } from "./omniroute.mjs";
import { createAgentService } from "./agents.mjs";
import { createWorkspaceScanner, loadWorkspaceConfig, publicWorkspaceConfig } from "./workspace.mjs";
import { evaluatePolicy, loadPolicy } from "./policy.mjs";
import { createTtlCache, mapLimit, redact } from "./util.mjs";
import { classifyPreviousRun, createLifecycleRecorder, readPreviousRun, safeStack } from "./lifecycle.mjs";
import { openDatabase, preMigrationBackup } from "./db.mjs";
import { createCompany, HttpError } from "./company.mjs";
import { createRuntime } from "./runtime.mjs";
import { createConversations } from "./conversations.mjs";
import { createKnowledge } from "./knowledge.mjs";
import { createArtifacts, createTemplates } from "./artifacts.mjs";
import { createTelemetry } from "./telemetry.mjs";
import { MCP_TOOLS } from "./mcp-server.mjs";
import { createAccounting } from "./accounting.mjs";
import { createOperations, recommend } from "./nex.mjs";
import { AGENTS, agentById } from "./catalog.mjs";
import { createGitHubReader } from "./github.mjs";
import { createVps } from "./vps.mjs";
import { createStartup } from "./startup.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2"
};
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Browser libraries for the internal UI, served from the bridge's pinned npm dependencies by fixed name only. */
const BRIDGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const VENDOR = {
  "internal/vendor/fabric.min.js": join(BRIDGE_ROOT, "node_modules", "fabric", "dist", "index.min.js"),
  "internal/vendor/echarts.min.js": join(BRIDGE_ROOT, "node_modules", "echarts", "dist", "echarts.min.js")
};
const INLINE_ARTIFACT = new Set(["image/png", "image/webp", "image/jpeg", "image/avif", "application/pdf"]);
const FORCE_REFRESH_MIN_GAP_MS = 5000;
const MAX_JSON_BODY = 256 * 1024;
const IDENTITY_RESOLVE_LIMIT = 12; // per manual sync
const IDENTITY_STARTUP_LIMIT = 60; // one background pass over existing workspace projects

const send = (response, status, body, type = "application/json; charset=utf-8") => {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin"
  });
  if (Buffer.isBuffer(body) || typeof body === "string") response.end(body);
  else response.end(JSON.stringify(body));
};

async function localAccount() {
  try {
    const { stdout } = await execFileAsync("gh", ["api", "user", "--jq", ".login"], {
      windowsHide: true, timeout: 5000, maxBuffer: 4096
    });
    const login = String(stdout).trim();
    return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(login) ? login : null;
  } catch (_) {
    return null;
  }
}

async function localWorlds(configPath) {
  const config = await loadWorldConfig(configPath);
  const safe = sanitizeWorldConfig(config);
  safe.worlds = await Promise.all(config.worlds.map(async (world, worldIndex) => ({
    ...safe.worlds[worldIndex],
    projects: await Promise.all(world.projects.map((project) => readGitProject(project)))
  })));
  return { ...safe, account: await localAccount(), generatedAt: new Date().toISOString() };
}

/** Reads the public catalog (data.js, a repository file) in an isolated VM context. */
async function loadCatalog(root) {
  try {
    const source = await readFile(join(root, "data.js"), "utf8");
    const sandbox = { window: {} };
    vm.runInNewContext(source, sandbox, { timeout: 1000 });
    const data = sandbox.window.ABUD_DATA;
    return { owner: String(data?.owner || ""), repos: (Array.isArray(data?.repos) ? data.repos : []).map((r) => ({ name: String(r.name), summary: typeof r.ar === "string" ? r.ar : null })) };
  } catch (_) {
    return { owner: "", repos: [] };
  }
}

/** DNS-rebinding and cross-site defence for the privileged local API. */
export function requestIsLocal(request, port) {
  const host = String(request.headers.host || "");
  const match = host.match(/^(\[::1\]|[^:]+)(?::(\d+))?$/);
  if (!match || !LOCAL_HOSTS.has(match[1].toLowerCase()) || (match[2] && Number(match[2]) !== port)) return false;
  const site = request.headers["sec-fetch-site"];
  if (site && !["same-origin", "none"].includes(site)) return false;
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  return true;
}

async function readJson(request, limit = MAX_JSON_BODY) {
  const type = String(request.headers["content-type"] || "");
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, "unsupported-media-type", "المحتوى يجب أن يكون JSON");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "payload-too-large", "حجم الطلب كبير جدًا");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not-object");
    return value;
  } catch (_) {
    throw new HttpError(400, "invalid-json", "JSON غير صالح");
  }
}

export function createServer({
  root = REPO_ROOT,
  configPath = join(root, "local", "worlds.json"),
  workspaceConfigPath = join(root, "local", "workspace.json"),
  policyPath = join(root, "local", "routing-policy.json"),
  dbPath = join(root, "local", "company.db"),
  backupDir = join(root, "local", "backups"),
  vpsConfigPath = join(root, "local", "vps.json"),
  vpsOptions = {},
  startupOptions = {},
  env = process.env,
  routerClient = createRouterClient({ env }),
  githubReader = createGitHubReader(),
  agentOptions = {},
  capabilityOptions = {},
  background = false,
  instance = null,
  log = (line) => console.log(line)
} = {}) {
  const routerService = createRouterService({ client: routerClient });
  const github = githubReader;
  const snapshotCache = createTtlCache(20_000);
  const lastForced = new Map();
  let workspaceScanner = null;
  let scannerSignature = "";
  const knownRef = { current: new Map() };
  const sessionToken = randomBytes(32).toString("hex");
  const sessionBuffer = Buffer.from(sessionToken);

  const db = openDatabase(dbPath);
  const company = createCompany({ db });
  company.seed();
  const upgraded = dbPath !== ":memory:" ? preMigrationBackup() : null;
  if (upgraded && upgraded.file.startsWith(dirname(dbPath))) {
    company.log({ actorType: "system", actorId: "bridge", action: "store.migrated", targetType: "system", targetId: "store", outcome: "info", summary: `ترقية مخطط قاعدة البيانات من ${upgraded.fromVersion} إلى ${upgraded.toVersion} بعد نسخة احتياطية متحقق منها`, metadata: { backup: basename(upgraded.file) } });
    company.raise({ key: `store-migrated:${upgraded.toVersion}`, level: "info", kind: "store", title: `تمت ترقية قاعدة البيانات إلى الإصدار ${upgraded.toVersion}`, body: `أُخذت نسخة احتياطية متحقق منها قبل الترقية: ${basename(upgraded.file)}`, targetType: "system", targetId: "store" });
  }
  const knowledge = createKnowledge({ company });
  const artifacts = createArtifacts({ company });
  const templates = createTemplates({ company });
  const telemetry = createTelemetry({ db });
  const accounting = createAccounting({ company });
  const startup = createStartup({ root, env, log, ...startupOptions });
  const vps = createVps({ company, configPath: vpsConfigPath, log, ...vpsOptions });
  const vpsReady = vps.reload().catch((error) => { log(JSON.stringify({ event: "vps-config-error", name: error?.name || "Error" })); });

  const agentService = createAgentService({
    repoPaths: () => (workspaceScanner ? [...workspaceScanner.paths].map(([rel, dir]) => ({ rel, dir })) : []),
    routerHost: routerClient.config.host,
    ...agentOptions
  });

  async function cached(key, force, producer) {
    const hit = snapshotCache.get(key);
    const recentlyForced = (lastForced.get(key) ?? 0) + FORCE_REFRESH_MIN_GAP_MS > Date.now();
    if (hit && (!force || recentlyForced)) return { ...hit, cache: { served: true, throttled: Boolean(force && recentlyForced) } };
    if (force) lastForced.set(key, Date.now());
    const value = await producer();
    if (key === "overview") startup.observeRouter(value.connection?.state ?? "unknown");
    // An unreachable/unauthorized router state is cached only briefly so recovery is noticed quickly.
    snapshotCache.set(key, value, value.connection?.state === "connected" ? 20_000 : 3000);
    return { ...value, cache: { served: false, throttled: false } };
  }

  const policyState = () => loadPolicy(policyPath);

  async function overview(force) {
    const policy = await policyState();
    return cached("overview", force, () => routerService.overview({ thresholds: policy.valid ? policy.policy.thresholds : DEFAULT_THRESHOLDS }));
  }
  const usage = (range, force = false) => cached(`usage:${range}`, force, () => routerService.usage({ range }));

  async function knownWorldPaths() {
    const worldsConfig = await loadWorldConfig(configPath).catch(() => ({ worlds: [] }));
    const known = new Map();
    for (const world of worldsConfig.worlds) {
      for (const project of world.projects) {
        const key = process.platform === "win32" ? resolve(project.path).toLowerCase() : resolve(project.path);
        known.set(key, [...(known.get(key) ?? []), { worldId: world.id, projectId: project.id }]);
      }
    }
    return known;
  }

  async function runWorkspaceScan(refresh) {
    const config = await loadWorkspaceConfig({ configPath: workspaceConfigPath, env });
    if (!config.configured) return { ...publicWorkspaceConfig(config), repos: [], folders: [], summary: null, generatedAt: new Date().toISOString() };
    knownRef.current = await knownWorldPaths();
    const signature = JSON.stringify([config.maxDepth, config.roots.map((root) => root.path)]);
    if (!workspaceScanner || signature !== scannerSignature) {
      workspaceScanner = createWorkspaceScanner({ config, knownPaths: () => knownRef.current });
      scannerSignature = signature;
    }
    return { ...publicWorkspaceConfig(config), ...(await workspaceScanner.scan({ refresh })) };
  }

  const runtime = createRuntime({
    company, routerClient,
    getOverview: (force) => overview(force),
    getUsage: (range) => usage(range),
    workspace: { scan: (refresh) => runWorkspaceScan(refresh), paths: () => workspaceScanner?.paths ?? new Map() },
    vps,
    log,
    artifacts,
    telemetry,
    capabilityOptions
  });
  const conversations = createConversations({ company, runtime });
  runtime.setConversations(conversations);
  runtime.setKnowledge(knowledge);
  vps.setEnqueue((input, actor) => runtime.enqueue(input, actor));
  const operations = createOperations({ company, getOverview: (force) => overview(force), log });
  const interrupted = runtime.recoverInterrupted();
  if (interrupted) log(`marked ${interrupted} interrupted run(s) as failed`);
  if (background) { operations.start(); setImmediate(() => runtime.pump()); vpsReady.then(() => vps.start()); }
  const pruneTelemetry = () => { try { telemetry.prune(company.settings().telemetryRetentionDays); conversations.purgeAttachments(); } catch (_) { /* best effort */ } };
  const telemetryTimer = background ? setInterval(pruneTelemetry, 6 * 3_600_000) : null;
  telemetryTimer?.unref?.();
  if (background) setTimeout(pruneTelemetry, 30_000).unref();

  /** Asks GitHub (read-only, bounded) for the current identity of observed remotes so a renamed account or transferred
   * repository maps to one project. Without gh authentication nothing is confirmed and identities stay as observed. */
  async function resolveIdentities(slugs, limit = IDENTITY_RESOLVE_LIMIT) {
    if (typeof github.resolve !== "function") return [];
    const due = company.identitiesToResolve(slugs).slice(0, limit);
    const outcomes = await mapLimit(due, 3, async (slug) => ({ slug, ...(await github.resolve(slug)) }));
    return outcomes.map((outcome) => ({ slug: outcome.slug, state: outcome.state, reconciled: company.recordGithubIdentity(outcome) })).filter((o) => o.reconciled);
  }

  async function syncProjects() {
    const [catalog, scan] = await Promise.all([loadCatalog(root), runWorkspaceScan(null)]);
    const reconciled = await resolveIdentities((scan.repos || []).filter((r) => r.state === "ready").map((r) => r.remote?.github));
    return { ...company.syncProjects({ catalog: catalog.repos, owner: catalog.owner, repos: scan.repos || [] }), reconciled, catalogOwner: catalog.owner };
  }
  if (background) {
    // Existing workspace-sourced identities are rechecked once after start, so earlier duplicates are folded without
    // waiting for a manual sync.
    setTimeout(() => resolveIdentities(company.db.all("SELECT github FROM projects WHERE source = 'workspace' AND github IS NOT NULL").map((r) => r.github), IDENTITY_STARTUP_LIMIT)
      .then((done) => { if (done.length) log(JSON.stringify({ event: "github-identities-reconciled", count: done.length })); })
      .catch((error) => log(JSON.stringify({ event: "github-identities-failed", name: error?.name || "Error" }))), 4000).unref();
  }

  async function agentsView() {
    const today = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const router = await overview(false);
    const usageByAgent = new Map(company.usageByAgent(today).map((u) => [u.agentId, u]));
    return Promise.all(company.listAgents().map(async (def) => {
      const config = company.agentConfig(def.id);
      const runs = company.listRuns({ agentId: def.id, limit: 5 });
      const active = company.db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE agent_id = ? AND status IN ('queued','running') AND parent_run_id IS NULL", def.id).n;
      const route = await runtime.routePreview({ agentId: def.id });
      const availability = !config.enabled ? "disabled" : router?.connection?.state !== "connected" ? "router-offline" : !route.chosen ? "no-eligible-model" : active ? "working" : "available";
      return {
        ...def, profile: company.registry.get(def.id), config, availability, activeRuns: active, lastRun: runs[0] ?? null,
        openTasks: company.db.get("SELECT COUNT(*) AS n FROM tasks WHERE assignee = ? AND archived_at IS NULL AND status NOT IN ('done','cancelled')", def.id).n,
        currentTask: company.db.get("SELECT id, title FROM tasks WHERE assignee = ? AND archived_at IS NULL AND status = 'in_progress' ORDER BY updated_at DESC LIMIT 1", def.id) ?? null,
        route: { chosen: route.chosen, domain: route.domain }, usage24h: usageByAgent.get(def.id) ?? { runs: 0, tokens: 0, costUsd: 0, unknownCostEvents: 0 }
      };
    }));
  }

  async function summary() {
    const settings = company.settings();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone }).format(new Date());
    const in7 = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone }).format(new Date(Date.now() + 7 * 86_400_000));
    const open = company.listTasks({ includeClosed: false, limit: 2000 });
    const router = await overview(false);
    const done7 = company.db.all("SELECT id, title, completed_at, project_id, assignee FROM tasks WHERE archived_at IS NULL AND status = 'done' AND completed_at >= ? ORDER BY completed_at DESC LIMIT 8", new Date(Date.now() - 7 * 86_400_000).toISOString());
    const allProjects = company.listProjects();
    const compactProject = (p) => ({ id: p.id, name: p.name, github: p.github, status: p.status, priority: p.priority, focus: p.focus, blocker: p.blocker, tasks: p.tasks, checkouts: p.checkouts.length, agents: p.agents, updatedAt: p.updatedAt });
    const focused = allProjects.filter((p) => p.focus);
    // Priority projects: the owner's focus projects first, then active high-priority ones; never inferred from Git activity.
    const priority = [...focused, ...allProjects.filter((p) => !p.focus && p.status === "active" && p.priority === "high")].slice(0, 6);
    // Quota pressure grouped per provider so one depleted account never appears as many separate incidents.
    const quotaGroups = new Map();
    for (const w of router?.warnings || []) {
      if (!["exhausted", "critical", "low"].includes(w.level)) continue;
      const g = quotaGroups.get(w.provider) || { provider: w.provider, exhausted: 0, low: 0, windows: 0, nextReset: null };
      g.windows++; if (w.level === "exhausted") g.exhausted++; else g.low++;
      if (w.resetAt && (!g.nextReset || w.resetAt < g.nextReset)) g.nextReset = w.resetAt;
      quotaGroups.set(w.provider, g);
    }
    return {
      generatedAt: new Date().toISOString(), today, timezone: settings.timezone,
      tasks: {
        open: open.length, highOpen: open.filter((t) => t.priority === "high").length, blocked: open.filter((t) => t.status === "blocked"), inProgress: open.filter((t) => t.status === "in_progress").length,
        inProgressList: open.filter((t) => t.status === "in_progress").slice(0, 8),
        dueToday: open.filter((t) => t.dueDate === today), overdue: open.filter((t) => t.dueDate && t.dueDate < today),
        upcoming: open.filter((t) => t.dueDate && t.dueDate > today && t.dueDate <= in7).slice(0, 10),
        focus: open.filter((t) => t.priority === "high" && ["todo", "in_progress"].includes(t.status)).slice(0, 8), recentlyCompleted: done7
      },
      projects: { total: allProjects.length, active: allProjects.filter((p) => p.status === "active").length,
        blocked: allProjects.filter((p) => p.status === "blocked").map((p) => ({ id: p.id, name: p.name, blocker: p.blocker })),
        focusCount: focused.length, priority: priority.map(compactProject),
        recent: [...allProjects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5).map(compactProject) },
      runs: { active: company.listRuns({ limit: 50 }).filter((r) => ["queued", "running"].includes(r.status) && !r.parentRunId).slice(0, 6).map((r) => ({ id: r.id, agentId: r.agentId, capability: r.capability, status: r.status, createdAt: r.createdAt, request: r.request.slice(0, 120) })) },
      approvals: company.listApprovals({ status: "pending" }).slice(0, 5).map((a) => ({ id: a.id, title: a.title, kind: a.kind, createdAt: a.createdAt })),
      quota: { groups: [...quotaGroups.values()].sort((a, b) => b.exhausted - a.exhausted || b.windows - a.windows) },
      agents: (await agentsView()).map((a) => ({ id: a.id, name: a.name, color: a.color, titleAr: a.titleAr, availability: a.availability, activeRuns: a.activeRuns, openTasks: a.openTasks, lastRun: a.lastRun ? { status: a.lastRun.status, finishedAt: a.lastRun.finishedAt, capability: a.lastRun.capability } : null, art: a.art })),
      router: { state: router?.connection?.state ?? "unknown", version: router?.router?.version ?? null, warnings: (router?.warnings || []).slice(0, 8), lockouts: (router?.lockouts || []).length },
      notifications: company.notifications({ limit: 12 }), approvalsPending: company.listApprovals({ status: "pending" }).length,
      activity: company.activity({ limit: 12 }),
      // Only major infrastructure warnings reach HQ; detailed metrics stay in System → السيرفرات.
      infrastructure: { ...vps.attention(), actionsPending: vps.listActions({ status: "proposed" }).length }
    };
  }

  async function resources() {
    const settings = company.settings();
    const [router, usage7] = await Promise.all([overview(false), usage("7d")]);
    const periods = Object.fromEntries(["daily", "weekly", "monthly"].map((p) => {
      const since = new Date(Date.now() - ({ daily: 1, weekly: 7, monthly: 30 }[p]) * 86_400_000).toISOString();
      return [p, company.usageSince(since)];
    }));
    const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const appUsage = { byAgent: company.usageByAgent(since30), byModel: company.usageByModel(since30), unknownCostEvents: periods.monthly.unknownCostEvents };
    const budgets = company.listBudgets();
    const policies = company.listPolicies();
    return {
      generatedAt: new Date().toISOString(),
      recommendations: recommend({ overview: router, usage: usage7, policies, budgets, quotaMeta: company.lastQuotaObservation(), snapshotMinutes: settings.quotaSnapshotMinutes, appUsage, subscriptionOptIn: settings.subscriptionOptIn }),
      appUsage: { periods, ...appUsage, basis: "application-measured: only runs executed by ABUD agents; cost is the router's per-response estimate" },
      budgets, policies, quota: { last: company.lastQuotaObservation(), snapshotMinutes: settings.quotaSnapshotMinutes, retentionDays: settings.quotaRetentionDays },
      routerWrites: routerClient.config.writesEnabled === true
    };
  }

  async function infrastructure() {
    const router = await overview(false);
    let dbBytes = null;
    try { dbBytes = (await stat(dbPath)).size; } catch (_) { dbBytes = null; }
    const tools = await agentService.discover({ overview: router }).catch(() => null);
    const v = vps.status();
    const live = v.hosts.filter((h) => h.enabled);
    const connected = live.filter((h) => h.connection.state === "connected").length;
    const vpsState = !v.configured ? "not-configured" : connected === live.length ? "connected" : connected ? "partial" : "offline";
    return {
      generatedAt: new Date().toISOString(),
      connectors: [
        { id: "vps", ar: "خوادم VPS", state: vpsState, detail: v.configured ? `${connected}/${live.length} متصل` : null, note: v.configured ? "Read-only SSH probes from this machine; actions need owner approval." : "No host registered in local/vps.json." },
        { id: "deployments", ar: "مراقبة النشر", state: v.configured ? vpsState : "not-configured", note: v.configured ? "Read-only release observation (no deploys)." : "Needs a registered host." },
        { id: "uptime", ar: "فحوص الصحة العامة", state: v.configured ? "connected" : "not-configured", note: v.configured ? "HTTPS health checks from this machine." : "No health endpoints registered." },
        { id: "certificates", ar: "شهادات TLS", state: v.configured ? "connected" : "not-configured", note: v.configured ? "TLS handshake expiry checks every 6 hours." : "No domains registered." }
      ],
      startup: startup.status(),
      local: {
        bridge: { state: "running", bind: "127.0.0.1", pid: process.pid, uptimeSec: Math.round(process.uptime()), node: process.version, startedAt: instance?.startedAt ?? null,
          memoryMb: Math.round(process.memoryUsage().rss / 1048576), previousExit: instance?.previousExit ?? null },
        router: { state: router?.connection?.state ?? "unknown", version: router?.router?.version ?? null, host: routerClient.config.host ?? null },
        store: { engine: "SQLite (node:sqlite)", schemaVersion: db.schemaVersion(), bytes: dbBytes, backups: db.listBackups(backupDir).length }
      },
      devTools: tools
    };
  }

  // ---------------------------------------------------------------- company API router
  const owner = { type: "owner", id: "owner" };
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern: new RegExp(`^/local-api/company${pattern}$`), handler });

  route("GET", "/summary", () => summary());
  route("GET", "/catalog", () => ({ ...runtime.catalogView(), allAgents: company.listAgents({ activeOnly: false }) }));
  route("GET", "/projects", () => ({ projects: company.listProjects() }));
  route("GET", "/projects/([^/]+)/github", ({ params }) => github.read(company.getProject(params[0]).github));
  route("POST", "/projects", ({ body }) => company.createProject(body, owner));
  route("POST", "/projects/sync", () => syncProjects());
  route("GET", "/projects/([^/]+)", ({ params }) => ({ ...company.getProject(params[0]), runs: company.listRuns({ projectId: params[0], limit: 20 }), tasks: company.listTasks({ projectId: params[0] }), infrastructure: vps.forProject(params[0]) }));
  route("PATCH", "/projects/([^/]+)", ({ params, body }) => company.updateProject(params[0], body, owner));
  route("POST", "/projects/([^/]+)/milestones", ({ params, body }) => company.addMilestone(params[0], body));
  route("PATCH", "/milestones/([^/]+)", ({ params, body }) => company.updateMilestone(params[0], body));
  route("POST", "/checkouts/link", ({ body }) => company.linkCheckout(body.rel, body.projectId ?? null));
  route("GET", "/tasks", ({ query }) => ({ tasks: company.listTasks({ status: query.get("status"), projectId: query.get("projectId"), assignee: query.get("assignee"), includeClosed: query.get("open") !== "1", archivedOnly: query.get("archived") === "only" }) }));
  route("POST", "/tasks", ({ body }) => company.createTask(body, owner));
  route("POST", "/tasks/([^/]+)/archive", ({ params }) => company.setTaskArchived(params[0], true, owner));
  route("POST", "/tasks/([^/]+)/restore", ({ params }) => company.setTaskArchived(params[0], false, owner));
  route("GET", "/tasks/([^/]+)", ({ params }) => ({ ...company.getTask(params[0]), runs: company.listRuns({ taskId: params[0], limit: 10 }) }));
  route("PATCH", "/tasks/([^/]+)", ({ params, body }) => company.updateTask(params[0], body, owner));
  route("GET", "/auto-policies", () => ({ policies: runtime.autoPolicies.list() }));
  route("POST", "/auto-policies", ({ body }) => runtime.autoPolicies.create(body, owner));
  route("DELETE", "/auto-policies", ({ query, body }) => runtime.autoPolicies.remove(query.get("id") || body?.id, owner));
  route("DELETE", "/auto-policies/([^/]+)", ({ params }) => runtime.autoPolicies.remove(params[0], owner));
  route("GET", "/tools/select-preview", ({ query }) => runtime.toolSelectPreview({ agentId: query.get("agentId"), request: query.get("request") || "", projectId: query.get("projectId") || null }));
  route("GET", "/agent-registry", () => ({ agents: company.registry.list({ activeOnly: false }) }));
  route("GET", "/agent-templates", () => ({ templates: company.registry.listTemplates() }));
  route("GET", "/agent-templates/([^/]+)", ({ params }) => company.registry.getTemplate(params[0]));
  route("POST", "/agents", ({ body }) => company.registry.createFromTemplate(body));
  route("PATCH", "/agents/([^/]+)/profile", ({ params, body }) => company.registry.update(params[0], body));
  route("POST", "/agents/([^/]+)/deactivate", ({ params }) => company.registry.deactivate(params[0]));
  route("POST", "/agents/([^/]+)/activate", ({ params }) => company.registry.activate(params[0]));
  route("DELETE", "/agents/([^/]+)", ({ params }) => company.registry.remove(params[0]));
  route("GET", "/agents", async () => ({ agents: await agentsView() }));
  route("GET", "/agents/([a-z][a-z0-9_-]{1,23})", async ({ params }) => {
    const def = company.agentById(params[0]);
    if (!def) throw new HttpError(404, "not-found", "الوكيل غير موجود");
    const view = (await agentsView()).find((a) => a.id === def.id) ?? { ...def, config: company.agentConfig(def.id), profile: company.registry.get(def.id) };
    return { ...view, runs: company.listRuns({ agentId: def.id, limit: 30 }), tasks: company.listTasks({ assignee: def.id, limit: 100 }), routePreview: await runtime.routePreview({ agentId: def.id }),
      memory: company.listMemory({ scope: "agent", scopeRef: def.id }), activity: company.activity({ actorId: def.id, limit: 30 }), policy: company.getPolicy(view.config.policyDomain) };
  });
  route("PATCH", "/agents/([a-z][a-z0-9_-]{1,23})", ({ params, body }) => company.updateAgent(params[0], body));
  route("GET", "/route-preview", ({ query }) => runtime.routePreview({ agentId: query.get("agentId"), priority: query.get("priority") || "medium" }));
  route("GET", "/runs", ({ query }) => ({ runs: company.listRuns({ agentId: query.get("agentId"), workflowId: query.get("workflowId"), status: query.get("status"), limit: query.get("limit") }) }));
  route("POST", "/runs", ({ body }) => runtime.enqueue(body, owner));
  route("GET", "/runs/([^/]+)", ({ params }) => {
    const run = company.getRun(params[0]);
    return { ...run, steps: run.workflowId ? company.listRuns({ workflowId: run.workflowId, limit: 20 }).filter((r) => r.id !== run.id).reverse() : [] };
  });
  route("POST", "/runs/([^/]+)/cancel", ({ params }) => runtime.cancel(params[0], owner));
  route("GET", "/conversations", ({ query }) => ({ conversations: conversations.list({ agentId: query.get("agentId"), projectId: query.get("projectId"), state: query.get("state") || "active", before: query.get("before"), limit: query.get("limit"), q: query.get("q") }) }));
  route("POST", "/conversations", ({ body }) => conversations.create(body));
  route("GET", "/conversations/([^/]+)", ({ params }) => ({ ...conversations.get(params[0]), messages: conversations.messages(params[0]) }));
  route("PATCH", "/conversations/([^/]+)", ({ params, body }) => conversations.update(params[0], body));
  route("DELETE", "/conversations/([^/]+)", ({ params }) => conversations.update(params[0], { state: "deleted" }));
  route("GET", "/conversations/([^/]+)/context", ({ params }) => conversations.contextPreview(params[0]));
  route("GET", "/conversations/([^/]+)/messages", ({ params, query }) => ({ messages: conversations.messages(params[0], { before: query.get("before"), limit: query.get("limit") }) }));
  route("POST", "/conversations/([^/]+)/messages", ({ params, body }) => conversations.send(params[0], body));
  route("GET", "/conversations/([^/]+)/attachments", ({ params }) => ({ attachments: conversations.attachments(params[0], { pendingOnly: true }) }));
  route("POST", "/conversations/([^/]+)/attachments", ({ params, body }) => conversations.upload(params[0], body));
  route("DELETE", "/conversations/([^/]+)/attachments/([^/]+)", ({ params }) => conversations.removeAttachment(params[0], params[1]));
  route("GET", "/knowledge", ({ query }) => ({ documents: knowledge.list({ projectId: query.get("projectId"), sourceType: query.get("sourceType"), state: query.get("state") || "active" }) }));
  route("GET", "/knowledge/search", ({ query }) => ({ results: knowledge.search({ q: query.get("q"), projectId: query.get("projectId"), sourceType: query.get("sourceType") }) }));
  route("POST", "/knowledge", ({ body }) => knowledge.ingestOwner(body));
  route("POST", "/knowledge/import-project", async ({ body }) => {
    const projectId = company.getProject(body.projectId).id;
    if (!["README.md", "STATUS.md"].includes(body.doc)) throw new HttpError(422, "validation", "اختر README.md أو STATUS.md");
    await runWorkspaceScan("all");
    const result = await runtime.invokeTool("zen", "project.docs", { projectId, doc: body.doc }, { toolCalls: [] });
    if (!result.docs?.length) throw new HttpError(404, "knowledge-source", "لم يُعثر على مستند معتمد لهذا المشروع");
    return { documents: result.docs.map((doc) => knowledge.ingestProject(projectId, doc)) };
  });
  route("POST", "/knowledge/reindex", () => knowledge.reindex());
  route("GET", "/knowledge/([^/]+)", ({ params }) => knowledge.preview(params[0]));
  route("PATCH", "/knowledge/([^/]+)", ({ params, body }) => knowledge.setState(params[0], body.state));
  route("DELETE", "/knowledge/([^/]+)", ({ params }) => knowledge.remove(params[0]));
  // V5 capability engine
  route("GET", "/capabilities", async ({ query }) => ({ capabilities: await runtime.capabilityRegistry({ refresh: query.get("refresh") === "1" }), checkedAt: new Date().toISOString() }));
  route("PATCH", "/capabilities/([A-Za-z0-9.]+)", ({ params, body }) => runtime.setCapabilityEnabled(params[0], { enabled: body.enabled, reason: body.reason }, owner));
  route("POST", "/capabilities/([A-Za-z0-9.]+)/execute", ({ params, body }) => runtime.executeCapability({ agentId: typeof body.agentId === "string" ? body.agentId : "", toolId: params[0], input: body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input : {}, projectId: typeof body.projectId === "string" && body.projectId ? body.projectId : null, confirm: body.confirm === true }, owner));
  // V5 multi-agent workflows (ORI orchestration) and accounting
  route("GET", "/workflow-templates", () => ({ templates: runtime.orchestrator.templates() }));
  route("GET", "/workflows", ({ query }) => ({ workflows: runtime.orchestrator.list({ status: query.get("status"), projectId: query.get("projectId"), limit: query.get("limit") }) }));
  route("POST", "/workflows", ({ body }) => runtime.orchestrator.create({ template: String(body.template ?? ""), projectId: body.projectId || null, topic: body.topic ?? null, urls: body.urls ?? null, limits: body.limits && typeof body.limits === "object" ? body.limits : {}, priority: body.priority }, owner));
  route("GET", "/workflows/([^/]+)", ({ params }) => runtime.orchestrator.get(params[0]));
  route("POST", "/workflows/([^/]+)/cancel", ({ params }) => runtime.orchestrator.cancel(params[0], owner));
  route("POST", "/workflows/([^/]+)/steps/([A-Za-z0-9-]+)/retry", ({ params }) => runtime.orchestrator.retryStep(params[0], params[1], owner));
  route("GET", "/accounting", ({ query }) => accounting.report({ range: query.get("range") || "30d", agentId: query.get("agentId") || null, projectId: query.get("projectId") || null }));
  // MCP bridge (stdio server in mcp-server.mjs): ORI, read-only allowlist, audited as actor "mcp".
  route("POST", "/mcp/tools/([A-Za-z0-9.]+)", async ({ params, body }) => {
    if (!MCP_TOOLS.includes(params[0])) throw new HttpError(403, "mcp-not-exposed", "هذه الأداة غير متاحة عبر MCP");
    return runtime.executeCapability({ agentId: "ori", toolId: params[0], input: body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input : {} }, { type: "mcp", id: "mcp" });
  });
  route("GET", "/executions", ({ query }) => ({ executions: runtime.listExecutions({ agentId: query.get("agentId"), toolId: query.get("toolId"), runId: query.get("runId"), workflowId: query.get("workflowId"), status: query.get("status"), before: query.get("before"), limit: query.get("limit") }) }));
  route("GET", "/executions/([^/]+)", ({ params }) => runtime.getExecution(params[0]));
  route("GET", "/artifacts", ({ query }) => ({ artifacts: artifacts.list({ projectId: query.get("projectId"), agentId: query.get("agentId"), workflowId: query.get("workflowId"), state: query.get("state"), kind: query.get("kind"), before: query.get("before"), limit: query.get("limit") }) }));
  route("GET", "/artifacts/([^/]+)", ({ params }) => artifacts.get(params[0]));
  route("PATCH", "/artifacts/([^/]+)", ({ params, body }) => artifacts.setState(params[0], body.state, owner));
  route("DELETE", "/artifacts/([^/]+)", ({ params }) => artifacts.remove(params[0]));
  route("GET", "/templates", ({ query }) => ({ templates: templates.list({ state: query.get("state") }) }));
  route("POST", "/templates", ({ body }) => templates.create(body));
  route("PATCH", "/templates/([^/]+)", ({ params, body }) => templates.update(params[0], body));
  route("GET", "/telemetry/spans", ({ query }) => ({ spans: telemetry.recent({ runId: query.get("runId"), limit: Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200) }), exporter: "local SQLite only" }));
  route("GET", "/policies", () => ({ policies: company.listPolicies() }));
  route("PATCH", "/policies/([a-z]+)", ({ params, body }) => company.updatePolicy(params[0], body));
  route("GET", "/budgets", () => ({ budgets: company.listBudgets() }));
  route("POST", "/budgets", ({ body }) => ({ budgets: company.upsertBudget(body) }));
  route("DELETE", "/budgets/([^/]+)", ({ params }) => ({ budgets: company.deleteBudget(params[0]) }));
  route("GET", "/resources", () => resources());
  route("GET", "/quota-history", ({ query }) => company.quotaHistory({ sinceIso: new Date(Date.now() - Math.min(Math.max(Number(query.get("days")) || 7, 1), 90) * 86_400_000).toISOString() }));
  route("POST", "/quota/snapshot", () => operations.tick({ force: true }));
  route("GET", "/approvals", ({ query }) => ({ approvals: company.listApprovals({ status: query.get("status") }) }));
  route("POST", "/approvals/([^/]+)/decide", ({ params, body }) => {
    if (!["approve", "reject"].includes(body.decision)) throw new HttpError(422, "validation", "القرار يجب أن يكون approve أو reject");
    return runtime.decideApproval(params[0], body.decision, owner);
  });
  route("POST", "/approvals/([^/]+)/rollback", ({ params }) => runtime.rollbackRouterChange(params[0], owner));
  route("POST", "/router/proposals", ({ body }) => runtime.proposeRouterChange({ key: body.key, value: body.value, requestedBy: "owner", reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : null }));
  route("GET", "/activity", ({ query }) => ({ events: company.activity({ limit: query.get("limit"), before: query.get("before"), targetType: query.get("targetType"), targetId: query.get("targetId"), actorId: query.get("actorId") }) }));
  route("GET", "/notifications", ({ query }) => ({ notifications: company.notifications({ includeResolved: query.get("all") === "1" }) }));
  route("POST", "/notifications/([0-9]+)/ack", ({ params }) => company.acknowledge(params[0]));
  route("GET", "/settings", () => ({ settings: company.settings(), store: { schemaVersion: db.schemaVersion(), backups: db.listBackups(backupDir) }, router: { ...routerClient.config } }));
  route("PATCH", "/settings", ({ body }) => ({ settings: company.updateSettings(body) }));
  route("GET", "/memory", ({ query }) => ({ notes: company.listMemory({ scope: query.get("scope"), scopeRef: query.get("scopeRef"), state: query.get("state") || "active", approved: query.get("approved") == null ? null : query.get("approved") === "1" }) }));
  route("GET", "/memory/search", ({ query }) => ({ notes: company.searchMemory({ q: query.get("q"), scope: query.get("scope"), scopeRef: query.get("scopeRef"), includePending: query.get("pending") === "1" }) }));
  route("POST", "/memory/reindex", () => company.reindexMemory());
  route("POST", "/memory", ({ body }) => ({ notes: company.upsertMemory(body, owner) }));
  route("DELETE", "/memory/([^/]+)", ({ params }) => company.deleteMemory(params[0]));
  route("POST", "/memory/([^/]+)/resolve", ({ params, body }) => company.resolveMemoryConflict(params[0], String(body.decision ?? ""), owner));
  route("GET", "/memory-conflicts", () => ({ conflicts: company.memoryConflicts() }));
  route("POST", "/import/browser", ({ body }) => company.importBrowser(body));
  route("GET", "/export", () => company.exportAll());
  route("POST", "/backup", () => {
    let result;
    try { result = db.backup(backupDir); }
    catch (error) {
      company.log({ action: "store.backup", targetType: "store", outcome: "failure", summary: "فشل إنشاء نسخة احتياطية؛ لم تُحفظ نسخة غير سليمة", metadata: { reason: error?.message || "unknown" } });
      throw new HttpError(500, "backup-failed", "فشل إنشاء النسخة الاحتياطية أو التحقق منها؛ لم تُحفظ نسخة غير سليمة", { reason: error?.message || "unknown" });
    }
    company.log({ action: "store.backup", targetType: "store", summary: `نسخة احتياطية (${Math.round(result.bytes / 1024)} KB)` });
    return { backups: db.listBackups(backupDir) };
  });
  route("POST", "/backups/verify", ({ body }) => {
    let report;
    try { report = db.verifyRestore(backupDir, body.name); }
    catch (error) { throw new HttpError(error?.message === "backup-not-found" ? 404 : 422, error?.message || "restore-check-failed", "تعذر فحص استعادة هذه النسخة"); }
    company.log({ action: "store.restore-verified", targetType: "store", outcome: report.ok ? "success" : "failure",
      summary: `اختبار استعادة معزول لـ ${report.name}: ${report.ok ? "سليمة" : "غير سليمة"} (${report.counts.projects.backup} مشروع، ${report.counts.tasks.backup} مهمة، ${report.counts.agent_runs.backup} تشغيل)`, metadata: report });
    return report;
  });
  // ---------------- VPS Operations Center (owner routes; agents reach the same service only through tools)
  const probeGap = new Map();
  route("GET", "/vps", async () => { await vpsReady; return { ...vps.status(), hosts: vps.hosts().filter((h) => h.enabled).map((h) => vps.overview(h.id)) }; });
  route("GET", "/vps/hosts/([a-z0-9-]+)", async ({ params }) => { await vpsReady; return vps.overview(params[0]); });
  route("GET", "/vps/hosts/([a-z0-9-]+)/metrics", ({ params, query }) => vps.metrics(vps.host(params[0]).id, ["1h", "24h", "7d", "30d"].includes(query.get("range")) ? query.get("range") : "24h"));
  route("GET", "/vps/hosts/([a-z0-9-]+)/incidents", ({ params }) => ({ incidents: vps.incidents(vps.host(params[0]).id, { days: 60, limit: 200 }) }));
  route("POST", "/vps/hosts/([a-z0-9-]+)/probe", async ({ params, body }) => {
    const id = vps.host(params[0]).id;
    if ((probeGap.get(id) ?? 0) + 15_000 > Date.now()) throw new HttpError(429, "probe-throttled", "طُلب فحص قبل أقل من 15 ثانية");
    probeGap.set(id, Date.now());
    return vps.probe(id, ["basic", "inventory", "sites", "all"].includes(body.kind) ? body.kind : "all");
  });
  route("POST", "/vps/hosts/([a-z0-9-]+)/diagnostics", ({ params, body }) => vps.diagnostic(vps.host(params[0]).id, String(body.diagnostic ?? ""), owner));
  route("POST", "/vps/hosts/([a-z0-9-]+)/logs", ({ params, body }) => vps.logs(vps.host(params[0]).id, String(body.source ?? ""), typeof body.service === "string" ? body.service : null, owner));
  route("GET", "/vps/actions", ({ query }) => ({ actions: vps.listActions({ hostId: query.get("hostId"), status: query.get("status") }) }));
  route("POST", "/vps/actions", ({ body }) => vps.propose({ hostId: body.hostId, operation: body.operation, service: body.service ?? null, reason: body.reason, incidentId: body.incidentId ?? null }, owner));
  route("GET", "/vps/actions/([^/]+)", ({ params }) => vps.getAction(params[0]));
  route("POST", "/vps/actions/([^/]+)/approve", ({ params, body }) => vps.approve(params[0], { confirmText: body.confirmText }, owner));
  route("POST", "/vps/actions/([^/]+)/reject", ({ params }) => vps.reject(params[0], owner));
  route("POST", "/vps/actions/([^/]+)/execute", ({ params, body }) => vps.execute(params[0], { token: typeof body.token === "string" ? body.token : "" }, owner));
  route("POST", "/vps/incidents/([^/]+)/diagnose", ({ params }) => {
    const incident = vps.incident(params[0]);
    const host = vps.host(incident.hostId);
    const run = runtime.enqueue({ agentId: incident.assignedAgent || "ori", capability: "infra_review", priority: incident.severity === "critical" ? "high" : "medium", projectId: host.projectId ?? undefined,
      idempotencyKey: `diag-${incident.id}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80),
      request: `حلّل هذه الحادثة على الخادم ${host.name} اعتمادًا على الأدلة فقط، واذكر السبب المرجح ومستوى الثقة والخطوة التالية الآمنة: «${incident.title}» (رصد: ${incident.detection}، بدأت ${incident.startedAt}${incident.state === "recovered" ? `، تعافت ${incident.recoveredAt}` : ""}).` }, owner);
    vps.linkDiagnosis(incident.id, run.id);
    return run;
  });
  route("PATCH", "/vps/settings", ({ body }) => ({ settings: vps.updateSettings(body) }));
  route("GET", "/startup", () => startup.status());
  route("POST", "/startup/action", async ({ body }) => {
    const router = await overview(body.action === "router-retry");
    if (body.action === "router-retry") return { done: true, router: router?.connection?.state ?? "unknown", startup: startup.status() };
    const result = await startup.perform(String(body.action ?? ""), { routerConnected: router?.connection?.state === "connected" });
    company.log({ action: "startup.action", targetType: "system", targetId: "startup", outcome: result.done ? "success" : "failure", summary: `إجراء تشغيل النظام: ${body.action}`, metadata: { action: body.action, code: result.code ?? null } });
    return { ...result, startup: startup.status() };
  });

  route("POST", "/shutdown", () => {
    if (server.listenerCount("owner-shutdown") === 0) throw new HttpError(409, "shutdown-unavailable", "الإيقاف متاح من مشغل Windows فقط");
    setImmediate(() => server.emit("owner-shutdown"));
    return { stopping: true };
  });

  function sessionValid(request) {
    const header = String(request.headers["x-abud-session"] || "");
    const candidate = Buffer.from(header);
    return candidate.length === sessionBuffer.length && timingSafeEqual(candidate, sessionBuffer);
  }

  const server = createHttpServer(async (request, response) => {
    const requestId = randomBytes(8).toString("hex");
    const startedAt = Date.now();
    let requestPath = "<invalid>";
    try { requestPath = new URL(request.url || "/", "http://127.0.0.1").pathname; } catch (_) { /* malformed request URL */ }
    response.setHeader("X-Request-ID", requestId);
    response.once("finish", () => {
      const durationMs = Date.now() - startedAt;
      if (response.statusCode >= 500 || durationMs >= 5000) log(JSON.stringify({ event: "request", requestId, method: request.method, path: requestPath, status: response.statusCode, durationMs }));
    });
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const port = request.socket.localPort;
      if (!requestIsLocal(request, port)) return send(response, 403, { error: "forbidden-host" });
      const isCompany = url.pathname.startsWith("/local-api/company/");
      if (request.method !== "GET" && !isCompany) return send(response, 405, { error: "method-not-allowed" });
      const force = url.searchParams.get("refresh") === "1";

      if (isCompany) {
        if (request.method !== "GET" || ["/local-api/company/auto-policies", "/local-api/company/tools/select-preview"].includes(url.pathname)) {
          // Writes and owner tool diagnostics need the per-process session token (readable only by same-origin pages) and a JSON body.
          if (!sessionValid(request)) return send(response, 403, { error: "session-required", message: "انتهت الجلسة؛ أعد تحميل الصفحة" });
        }
        const events = request.method === "GET" && url.pathname.match(/^\/local-api\/company\/conversations\/([^/]+)\/runs\/([^/]+)\/events$/);
        if (events) {
          const conversation = conversations.get(decodeURIComponent(events[1]));
          const run = company.getRun(decodeURIComponent(events[2]));
          if (run.conversationId !== conversation.id) throw new HttpError(404, "not-found", "التشغيل غير موجود في هذه المحادثة");
          response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" });
          const write = (event) => { if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`); };
          write({ type: "snapshot", run, messages: conversations.messages(conversation.id).filter((m) => m.runId === run.id) });
          if (!["queued", "running"].includes(run.status)) { response.end(); return; }
          const unsubscribe = runtime.subscribe(run.id, (event) => { write(event); if (event.type === "done") response.end(); });
          const heartbeat = setInterval(() => { if (!response.destroyed) response.write(": keepalive\n\n"); }, 15000);
          const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
          response.once("close", cleanup);
          return;
        }
        const download = request.method === "GET" && url.pathname.match(/^\/local-api\/company\/conversations\/([^/]+)\/attachments\/([^/]+)$/);
        if (download) {
          const file = conversations.getAttachment(decodeURIComponent(download[1]), decodeURIComponent(download[2]));
          response.writeHead(200, { "Content-Type": file.mime, "Content-Length": file.size_bytes, "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.filename)}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" });
          response.end(file.data);
          return;
        }
        const exportMatch = request.method === "GET" && url.pathname.match(/^\/local-api\/company\/conversations\/([^/]+)\/export$/);
        if (exportMatch) {
          const file = conversations.exportThread(decodeURIComponent(exportMatch[1]), url.searchParams.get("format") === "json" ? "json" : "md");
          response.writeHead(200, { "Content-Type": file.mime, "Content-Disposition": `attachment; filename="conversation"; filename*=UTF-8''${encodeURIComponent(file.filename)}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" });
          response.end(file.body);
          return;
        }
        const artifactFile = request.method === "GET" && url.pathname.match(/^\/local-api\/company\/artifacts\/([^/]+)\/(download|view)$/);
        if (artifactFile) {
          const file = artifacts.content(decodeURIComponent(artifactFile[1]));
          const inline = artifactFile[2] === "view" && INLINE_ARTIFACT.has(file.mime);
          // Generated files are served as inert content: sandboxed, never sniffed, never framed by another origin.
          response.writeHead(200, { "Content-Type": file.mime, "Content-Length": file.sizeBytes, "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="artifact"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" });
          response.end(file.data);
          return;
        }
        const match = routes.find((r) => r.method === request.method && r.pattern.test(url.pathname));
        if (!match) return send(response, routes.some((r) => r.pattern.test(url.pathname)) ? 405 : 404, { error: routes.some((r) => r.pattern.test(url.pathname)) ? "method-not-allowed" : "not-found" });
        const params = url.pathname.match(match.pattern).slice(1).map((p) => decodeURIComponent(p));
        // Larger bodies only where the payload is a file: attachments, an exported canvas image, a template.
        const bodyLimit = /^\/local-api\/company\/conversations\/[^/]+\/attachments$/.test(url.pathname) ? 1_500_000
          : url.pathname === "/local-api/company/capabilities/design.saveCanvas/execute" ? 6_500_000
          : /^\/local-api\/company\/templates(?:\/[^/]+)?$/.test(url.pathname) ? 600_000 : MAX_JSON_BODY;
        const body = ["POST", "PATCH"].includes(request.method) ? await readJson(request, bodyLimit) : null;
        const result = await match.handler({ params, body: body ?? {}, query: url.searchParams });
        return send(response, request.method === "POST" && !/\/(decide|rollback|cancel|ack|sync|snapshot|backup|verify|browser|approve|reject|execute|probe|diagnostics|logs|action|retry|resolve)$/.test(url.pathname) ? 201 : 200, result);
      }

      if (url.pathname === "/local-api/session") return send(response, 200, { token: sessionToken });
      if (url.pathname === "/local-api/health") {
        return send(response, 200, {
          status: "ok", service: "abud-local-universe", apiVersion: 5, readOnly: false, pid: process.pid, uptimeSec: Math.round(process.uptime()),
          capabilities: { ops: true, company: true, omniroute: routerClient.config.valid, agents: true, workspace: true, policy: true, inference: routerClient.config.valid, routerWrites: routerClient.config.writesEnabled === true, conversations: true, knowledge: true, toolEngine: true, workflows: true }
        });
      }
      if (url.pathname === "/local-api/account") return send(response, 200, { account: await localAccount() });
      if (url.pathname === "/local-api/worlds") return send(response, 200, await localWorlds(configPath));
      if (url.pathname === "/local-api/omniroute/overview") return send(response, 200, await overview(force));
      if (url.pathname === "/local-api/omniroute/usage") {
        const range = RANGES.includes(url.searchParams.get("range")) ? url.searchParams.get("range") : "7d";
        return send(response, 200, await usage(range, force));
      }
      if (url.pathname === "/local-api/agents") {
        const router = await overview(false);
        return send(response, 200, await agentService.discover({ overview: router }));
      }
      if (url.pathname === "/local-api/workspace") {
        const refresh = url.searchParams.get("refresh");
        const target = refresh === "1" || refresh === "all" ? "all" : refresh && /^[A-Za-z0-9._\/-]{1,120}$/.test(refresh) ? refresh : null;
        return send(response, 200, await runWorkspaceScan(target));
      }
      if (url.pathname === "/local-api/infra") return send(response, 200, await infrastructure());
      if (url.pathname === "/local-api/policy") {
        const router = await overview(false);
        return send(response, 200, { generatedAt: new Date().toISOString(), ...evaluatePolicy({ policyState: await policyState(), overview: router }) });
      }
      if (url.pathname === "/local-api/settings") {
        const config = await loadWorkspaceConfig({ configPath: workspaceConfigPath, env });
        const policy = await policyState();
        const worlds = await loadWorldConfig(configPath).catch(() => ({ configured: false, worlds: [] }));
        return send(response, 200, {
          generatedAt: new Date().toISOString(),
          bridge: { bind: "loopback only (127.0.0.1)", port, readOnly: false, writeEndpoints: routes.filter((r) => r.method !== "GET").length, writeProtection: "session token + JSON + same-origin", hostHeaderCheck: true, crossSiteBlocked: true },
          router: { ...routerClient.config, secretsReturned: false },
          workspace: publicWorkspaceConfig(config),
          worlds: { configured: worlds.configured !== false, worldCount: worlds.worlds.length },
          policy: { source: policy.source, valid: policy.valid, errors: policy.errors },
          store: { engine: "SQLite (node:sqlite)", schemaVersion: db.schemaVersion() }
        });
      }
      if (url.pathname.startsWith("/local-api/")) return send(response, 404, { error: "not-found" });

      const asset = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      if (Object.hasOwn(VENDOR, asset)) return send(response, 200, await readFile(VENDOR[asset]), CONTENT_TYPES[".js"]);
      if (!isAllowedAsset(asset) && !isInternalAsset(asset)) return send(response, 404, { error: "not-found" });
      const file = resolve(root, asset);
      let body = await readFile(file);
      // Local-first: the Company OS bundles its own fonts, so the public page's Google Fonts links are dropped when the
      // bridge serves it (the public Pages artifact itself is unchanged).
      // It is also marked "booting" until the internal shell mounts, so the public layout never flashes; a CSS-only
      // timer reveals the page anyway if the internal modules fail to load.
      if (asset === "index.html") {
        body = body.toString("utf8").replace(/\s*<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, "")
          .replace(/<html([^>]*)>/, '<html$1 class="os-booting">')
          .replace("</head>", "<style>html.os-booting body{visibility:hidden;animation:os-reveal 0s 5s forwards}@keyframes os-reveal{to{visibility:visible}}</style>\n</head>");
      }
      return send(response, 200, body, CONTENT_TYPES[extname(asset)] || "application/octet-stream");
    } catch (error) {
      if (error instanceof HttpError) return send(response, error.status, { error: error.code, message: error.messageAr, details: error.details ?? undefined });
      if (error?.code === "ENOENT") return send(response, 404, { error: "not-found" });
      if (error?.message === "invalid-local-config") return send(response, 422, { error: "invalid-local-config" });
      if (/constraint/i.test(String(error?.message))) return send(response, 409, { error: "constraint", message: "تعارض مع بيانات موجودة" });
      log(JSON.stringify({ event: "request-error", requestId, name: error?.name || "Error", code: error?.code || null }));
      return send(response, 500, { error: "local-bridge-failed", message: "خطأ داخلي في الـ Bridge" });
    }
  });
  server.on("close", () => { if (telemetryTimer) clearInterval(telemetryTimer); operations.stop(); vps.stop(); runtime.stop().finally(() => { try { db.close(); } catch (_) { /* already closed */ } }); });
  server.company = company;
  server.vps = vps;
  server.vpsReady = vpsReady;
  server.runtime = runtime;
  server.artifacts = artifacts;
  server.telemetry = telemetry;
  server.operations = operations;
  return server;
}

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
};
const PREVIOUS_EXIT_AR = {
  "system-restart": "انتهت الجلسة السابقة مع إعادة تشغيل Windows أو إيقافه",
  "fatal-error": "توقفت الجلسة السابقة بسبب خطأ داخلي مسجل",
  "unexpected-exit": "توقفت الجلسة السابقة دون إيقاف نظيف ودون خطأ مسجل (إنهاء من خارج التطبيق أو تعطل)"
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.LOCAL_UNIVERSE_PORT || 4170);
  const lifecycle = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ...fields }));
  const stateFile = join(REPO_ROOT, "local", "runtime", "bridge-state.json");
  const previous = readPreviousRun(stateFile);
  // A second process (e.g. a manual start while the launcher's instance runs) must neither judge nor overwrite the live one.
  const otherInstanceAlive = Boolean(previous && !previous.clean && previous.pid !== process.pid && pidAlive(previous.pid));
  const previousExit = otherInstanceAlive ? null : classifyPreviousRun(previous);
  const recorder = otherInstanceAlive ? { state: { startedAt: new Date().toISOString() }, start() {}, fatal() {}, stopped() {} } : createLifecycleRecorder({ file: stateFile, port });
  recorder.start();
  const server = createServer({ background: true, instance: { startedAt: recorder.state.startedAt, previousExit } });
  if (previousExit) {
    lifecycle("previous-run-ended", previousExit);
    try {
      server.company.log({ actorType: "system", actorId: "bridge", action: "bridge.previous-exit", targetType: "system", targetId: "bridge",
        outcome: previousExit.kind === "system-restart" ? "info" : "failure", summary: `${PREVIOUS_EXIT_AR[previousExit.kind]} (آخر نبضة ${previousExit.lastSeenAt})`, metadata: previousExit });
      if (previousExit.kind !== "system-restart") {
        server.company.raise({ key: `bridge-exit:${previousExit.startedAt}`, level: "warning", kind: "bridge", title: "الجلسة السابقة للـ Bridge لم تُغلق بشكل نظيف",
          body: `${PREVIOUS_EXIT_AR[previousExit.kind]}. آخر نبضة ${previousExit.lastSeenAt}.`, targetType: "system", targetId: "bridge" });
      }
    } catch (_) { /* The record is diagnostic; startup continues. */ }
  }
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    lifecycle("shutdown-start", { signal });
    const timeout = setTimeout(() => { lifecycle("shutdown-timeout"); process.exitCode = 1; server.closeAllConnections(); }, 10_000);
    timeout.unref();
    server.close((error) => {
      clearTimeout(timeout);
      if (error) { lifecycle("shutdown-error", { code: error.code || "unknown" }); process.exitCode = 1; }
      else lifecycle("shutdown-complete");
      if (!server.fatal) recorder.stopped();
      // Nothing should keep the process alive after the store is closed; this guarantees the launcher sees it exit.
      setTimeout(() => process.exit(), 3000).unref();
    });
  };
  // SIGHUP is how Windows reports console close, sign-out and shutdown; SIGBREAK is Ctrl+Break.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.once(signal, () => stop(signal));
  server.on("owner-shutdown", () => stop("owner-request"));
  const fatal = (kind) => (error) => {
    const info = { kind, name: error?.name || "Error", code: error?.code || null, message: redact(error?.message || String(error), 200), stack: safeStack(error) };
    lifecycle("fatal-error", info);
    server.fatal = true;
    recorder.fatal(info);
    process.exitCode = 1;
    stop("fatal-error");
  };
  process.on("uncaughtException", fatal("uncaughtException"));
  process.on("unhandledRejection", fatal("unhandledRejection"));
  server.on("error", (error) => { lifecycle("listen-error", { code: error.code || "unknown" }); process.exitCode = 1; stop("listen-error"); });
  server.listen(port, "127.0.0.1", () => lifecycle("listening", { port }));
}
