/* V5 specialist capabilities. Handlers are registered server-side under the reviewed tool ids in catalog.mjs and are
 * reached only through runtime.invokeTool (permission, schema, rate, concurrency, timeout, cancellation, audit). Heavy
 * dependencies load lazily, so a missing package or binary makes only its own capability "unavailable" with the reason.
 * External content (web pages, scanner output, repository files) is untrusted data: it is bounded, redacted and never
 * turned into instructions, tool choices or shell arguments. */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS, agentById } from "./catalog.mjs";
import { HttpError } from "./company.mjs";
import { contentDigest } from "./knowledge.mjs";
import { redact, text } from "./util.mjs";
import { safeFetch } from "./web-fetch.mjs";

const ASSETS = fileURLToPath(new URL("../../../internal/assets/", import.meta.url));
const RANGE_MS = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
const STATUS_AR = { active: "نشط", paused: "متوقف مؤقتًا", blocked: "متعطّل", done: "مكتمل", archived: "مؤرشف", idea: "فكرة", planning: "تخطيط" };
const TASK_AR = { todo: "للتنفيذ", in_progress: "قيد التنفيذ", blocked: "متعطّلة", review: "مراجعة", done: "منجزة", cancelled: "ملغاة" };
const PRIORITY_AR = { high: "عالية", medium: "متوسطة", low: "منخفضة" };
const MAX_PIXELS = 4096 * 4096;
// Text that tries to address the reader as a model. Reported (never obeyed); the content itself is kept as data.
const INJECTION_HINTS = [/ignore (all |any )?(previous|prior|above) instructions/i, /disregard (the )?(system|previous) (prompt|instructions)/i, /you are now\b/i, /system prompt/i,
  /\bassistant\s*:/i, /call (the )?tool/i, /تجاهل (كل |جميع )?التعليمات/, /أنت الآن/, /نفّ?ذ الأمر/];

const fail = (status, code, ar) => { throw new HttpError(status, code, ar); };
const xml = (value) => String(value ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
const clip = (value, max) => { const chars = [...String(value ?? "")]; return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join(""); };
const percentile = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
/** Arabic counted noun for days: يوم واحد، يومان، 3–10 أيام، 11+ يومًا. */
export const daysAr = (n) => (n === 1 ? "يوم واحد" : n === 2 ? "يومين" : n <= 10 ? `${n} أيام` : `${n} يومًا`);
const sinceIso = (range, now) => new Date(now() - (RANGE_MS[range] ?? RANGE_MS["7d"])).toISOString();

/** Lazily imported optional modules; a failed import is remembered and reported as the capability's health. */
function lazyModules(importer) {
  const cache = new Map();
  return (name) => {
    if (!cache.has(name)) cache.set(name, importer(name).then((m) => m, (error) => { cache.delete(name); throw error; }));
    return cache.get(name);
  };
}

/** Fixed-location binary resolution: the WinGet links folder, then PATH. Nothing from a request influences it. */
export function resolveBinary(name, { env = process.env, platform = process.platform } = {}) {
  const exe = platform === "win32" ? `${name}.exe` : name;
  const candidates = [];
  if (platform === "win32" && env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", exe));
  for (const dir of String(env.PATH || env.Path || "").split(delimiter)) if (dir) candidates.push(join(dir, exe));
  for (const candidate of candidates) {
    try { if (existsSync(candidate) && statSync(candidate).isFile()) return candidate; } catch (_) { /* next */ }
  }
  return null;
}

function runBinary(file, args, { cwd, timeoutMs, signal, env = {} }) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024, signal, env: { ...process.env, NO_COLOR: "1", ...env } }, (error, stdout, stderr) => {
      if (error?.name === "AbortError" || signal?.aborted) return resolve({ cancelled: true });
      resolve({ code: typeof error?.code === "number" ? error.code : error ? -1 : 0, killed: Boolean(error?.killed), notFound: error?.code === "ENOENT", stdout: String(stdout), stderr: redact(String(stderr), 300) });
    });
  });
}

export function createCapabilities({ company, artifacts, knowledge, telemetry, workspace, readProjectDoc, getConversations = () => null, vps = null, now = Date.now,
  importModule = (name) => import(name), binaries = { gitleaks: () => resolveBinary("gitleaks"), osv: () => resolveBinary("osv-scanner") }, fetchImpl = safeFetch }) {
  const load = lazyModules(importModule);
  const { db } = company;
  const iso = (ms = now()) => new Date(ms).toISOString();
  const todayLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: company.settings().timezone }).format(new Date(now()));

  /** Authorized checkout directories of a project (owner-configured workspace roots only). */
  async function checkoutDirs(projectId) {
    const project = company.getProject(projectId);
    if (!project.checkouts.length) return { project, dirs: [] };
    if (!workspace.paths().size) await workspace.scan(null);
    const paths = workspace.paths();
    return { project, dirs: project.checkouts.slice(0, 2).map((c) => ({ rel: c.rel, dir: paths.get(c.rel) })).filter((c) => c.dir && existsSync(c.dir)) };
  }
  const saveArtifact = (extra, fields) => artifacts.save({ ...fields, runId: extra.runId ?? null, executionId: extra.executionId ?? null, workflowId: extra.workflowId ?? null, projectId: fields.projectId ?? extra.projectId ?? null });

  // ------------------------------------------------------------------ ORI
  function companyOverview({ projectId = null }) {
    const project = projectId ? company.getProject(projectId) : null;
    const today = todayLocal();
    const tasks = company.listTasks({ projectId: project?.id ?? null, includeClosed: true, limit: 2000 });
    const open = tasks.filter((t) => !["done", "cancelled"].includes(t.status));
    const byStatus = Object.fromEntries(Object.keys(TASK_AR).map((s) => [s, tasks.filter((t) => t.status === s).length]));
    const projects = project ? [project] : company.listProjects();
    const runs = db.all(`SELECT status, COUNT(*) AS n FROM agent_runs WHERE parent_run_id IS NULL ${project ? "AND project_id = ?" : ""} AND created_at >= ? GROUP BY status`, ...(project ? [project.id] : []), iso(now() - 7 * 86_400_000));
    return {
      scope: project ? { projectId: project.id, name: project.name } : "company", today, basis: "persisted company records",
      projects: { total: projects.length, byStatus: Object.fromEntries([...new Set(projects.map((p) => p.status))].map((s) => [s, projects.filter((p) => p.status === s).length])), blocked: projects.filter((p) => p.status === "blocked").slice(0, 8).map((p) => ({ id: p.id, name: p.name, blocker: p.blocker })) },
      tasks: { open: open.length, byStatus, overdue: open.filter((t) => t.dueDate && t.dueDate < today).slice(0, 10).map((t) => ({ id: t.id, title: t.title, dueDate: t.dueDate, assignee: t.assignee })),
        blocked: open.filter((t) => t.status === "blocked").slice(0, 10).map((t) => ({ id: t.id, title: t.title, blocker: t.blocker })), dueThisWeek: open.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10)).length,
        completed7d: tasks.filter((t) => t.status === "done" && t.completedAt && t.completedAt >= iso(now() - 7 * 86_400_000)).length },
      approvalsPending: company.listApprovals({ status: "pending" }).length,
      runs7d: Object.fromEntries(runs.map((r) => [r.status, r.n])),
      activeRuns: db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE status IN ('queued','running') AND parent_run_id IS NULL").n
    };
  }
  function approvalsList({ status = "pending" }) {
    const list = company.listApprovals({ status: status === "all" ? null : "pending" }).slice(0, 40);
    const actions = vps ? vps.listActions({ status: "proposed" }).slice(0, 20) : [];
    return {
      approvals: list.map((a) => ({ id: a.id, kind: a.kind, title: a.title, status: a.status, requestedBy: a.requestedBy, risk: a.risk, createdAt: a.createdAt, ageHours: Math.round((now() - Date.parse(a.createdAt)) / 36e5) })),
      serverActions: actions.map((a) => ({ id: a.id, operation: a.operation, status: a.status, requestedBy: a.requestedBy, createdAt: a.createdAt })),
      note: "Only the owner can approve; agents may list and follow up."
    };
  }

  // ------------------------------------------------------------------ MIA (sharp; SVG text is shaped by Pango, so Arabic joins and orders correctly)
  const AGENT_COLORS = Object.fromEntries(AGENTS.map((a) => [a.id, a.color]));
  const RTL = `direction="rtl" text-anchor="start"`;
  const FONT = `font-family="Segoe UI, Tahoma, Arial, sans-serif"`;
  function frame(width, height, theme = "violet", accent = "#7c3aed") {
    const bg = theme === "light" ? `<rect width="${width}" height="${height}" fill="#faf8ff"/><rect width="${width}" height="${height}" fill="url(#glow)" opacity="0.5"/>`
      : `<rect width="${width}" height="${height}" fill="url(#bg)"/><circle cx="${width * 0.12}" cy="${height * 1.05}" r="${height * 0.75}" fill="#ffffff" opacity="0.06"/>`;
    return `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#3b0f7a"/></linearGradient>
      <radialGradient id="glow" cx="0.85" cy="0.1" r="0.9"><stop offset="0" stop-color="${accent}" stop-opacity="0.35"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs>${bg}
      <rect x="0" y="0" width="${width}" height="10" fill="${accent}"/>`;
  }
  async function rasterize(svg, format, composites = []) {
    const sharp = (await load("sharp")).default;
    let image = sharp(Buffer.from(svg), { limitInputPixels: MAX_PIXELS });
    if (composites.length) image = sharp(await image.png().toBuffer()).composite(composites);
    const data = format === "webp" ? await image.webp({ quality: 90 }).toBuffer() : await image.png({ compressionLevel: 9 }).toBuffer();
    return { data, mime: format === "webp" ? "image/webp" : "image/png" };
  }
  async function statusCard({ projectId, format = "png", theme = "violet" }, actor, extra) {
    const project = company.getProject(projectId);
    const tasks = company.listTasks({ projectId: project.id, includeClosed: true, limit: 2000 });
    const open = tasks.filter((t) => !["done", "cancelled"].includes(t.status));
    const today = todayLocal();
    const facts = [
      ["المهام المفتوحة", open.length], ["متعطّلة", open.filter((t) => t.status === "blocked").length],
      ["متأخرة", open.filter((t) => t.dueDate && t.dueDate < today).length], ["أُنجزت خلال 7 أيام", tasks.filter((t) => t.status === "done" && t.completedAt >= iso(now() - 7 * 86_400_000)).length]
    ];
    const next = project.milestones?.find((m) => m.status !== "done");
    const light = theme === "light";
    const ink = light ? "#1e1147" : "#ffffff", soft = light ? "#5b4b8a" : "#e9defe";
    const W = 1200, H = 630;
    const tiles = facts.map(([label, value], i) => {
      const x = W - 70 - (i + 1) * 262 + 12;
      return `<rect x="${x}" y="300" width="250" height="150" rx="22" fill="${light ? "#ffffff" : "#ffffff"}" fill-opacity="${light ? 1 : 0.12}" stroke="${light ? "#e4dcfb" : "none"}"/>
        <text x="${x + 226}" y="372" ${FONT} font-size="54" font-weight="700" fill="${ink}" ${RTL}>${value}</text>
        <text x="${x + 226}" y="418" ${FONT} font-size="24" fill="${soft}" ${RTL}>${xml(label)}</text>`;
    }).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${frame(W, H, theme)}
      <text x="${W - 70}" y="110" ${FONT} font-size="26" fill="${soft}" ${RTL}>بطاقة حالة المشروع · ABUD FUN</text>
      <text x="${W - 70}" y="185" ${FONT} font-size="62" font-weight="700" fill="${ink}" ${RTL}>${xml(clip(project.name, 30))}</text>
      <text x="${W - 70}" y="245" ${FONT} font-size="28" fill="${soft}" ${RTL}>${xml(`الحالة: ${STATUS_AR[project.status] || project.status} · الأولوية: ${PRIORITY_AR[project.priority] || project.priority}`)}</text>
      ${tiles}
      <text x="${W - 70}" y="520" ${FONT} font-size="26" fill="${ink}" ${RTL}>${xml(next ? clip(`المرحلة القادمة: ${next.title}${next.dueDate ? ` (${next.dueDate})` : ""}`, 70) : project.blocker ? clip(`العائق: ${project.blocker}`, 70) : "لا توجد مرحلة مفتوحة مسجلة")}</text>
      <text x="${W - 70}" y="585" ${FONT} font-size="20" fill="${soft}" ${RTL}>${xml(`من سجلات الشركة الفعلية · ${today}`)}</text></svg>`;
    const { data, mime } = await rasterize(svg, format);
    const artifact = saveArtifact(extra, { kind: "image", title: `بطاقة حالة — ${project.name}`, filename: `status-${project.id.replace(/[^A-Za-z0-9-]+/g, "-").slice(0, 60)}.${format}`, mime, data, agentId: actor.id, projectId: project.id,
      metadata: { template: "status-card", theme, facts: Object.fromEntries(facts), width: W, height: H } });
    return { artifactIds: [artifact.id], artifact, facts: Object.fromEntries(facts), source: "persisted project and task records" };
  }
  async function brandGraphic({ template, title, subtitle = "", agentId = null, projectId = null, format = "png" }, actor, extra) {
    const project = projectId ? company.getProject(projectId) : null;
    const spotlight = template === "agent-spotlight";
    const subject = spotlight ? agentById(agentId || actor.id) : null;
    if (spotlight && !subject) fail(422, "validation", "اختر الوكيل لبطاقة التعريف");
    const accent = subject ? AGENT_COLORS[subject.id] : template === "milestone" ? "#22c55e" : "#f59e0b";
    const W = 1200, H = 675;
    const kicker = { announcement: "إعلان داخلي", milestone: "إنجاز مرحلة", "agent-spotlight": "تعريف بالوكيل" }[template];
    const textRight = spotlight ? W - 60 : W - 80;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${frame(W, H, "violet", accent)}
      <rect x="${textRight - 190}" y="96" width="190" height="44" rx="22" fill="${accent}"/>
      <text x="${textRight - 20}" y="127" ${FONT} font-size="22" font-weight="700" fill="#ffffff" ${RTL}>${xml(kicker)}</text>
      <text x="${textRight}" y="250" ${FONT} font-size="64" font-weight="700" fill="#ffffff" ${RTL}>${xml(clip(title, spotlight ? 22 : 30))}</text>
      ${subtitle ? `<text x="${textRight}" y="320" ${FONT} font-size="30" fill="#e9defe" ${RTL}>${xml(clip(subtitle, spotlight ? 40 : 60))}</text>` : ""}
      ${subject ? `<text x="${textRight}" y="400" ${FONT} font-size="34" font-weight="700" fill="${accent}" ${RTL}>${xml(`${subject.name} · ${subject.titleAr}`)}</text>
        <text x="${textRight}" y="450" ${FONT} font-size="26" fill="#e9defe" ${RTL}>${xml(clip(subject.roleAr, 40))}</text>` : ""}
      ${project ? `<text x="${textRight}" y="${subject ? 510 : 420}" ${FONT} font-size="26" fill="#e9defe" ${RTL}>${xml(clip(`المشروع: ${project.name}`, 50))}</text>` : ""}
      <text x="${textRight}" y="${H - 50}" ${FONT} font-size="22" fill="#d8c8fb" ${RTL}>ABUD FUN · Company OS</text></svg>`;
    // The agent's approved artwork is composited unchanged (resized only); no character is redrawn or altered.
    const composites = [];
    if (subject) {
      const sharp = (await load("sharp")).default;
      const art = await sharp(join(ASSETS, "agents", `${subject.id}-card.webp`)).resize({ height: 520, fit: "inside" }).png().toBuffer();
      composites.push({ input: art, left: 60, top: Math.round((H - 520) / 2) });
    }
    const { data, mime } = await rasterize(svg, format, composites);
    const artifact = saveArtifact(extra, { kind: "image", title: `${kicker} — ${clip(title, 60)}`, filename: `${template}-${now()}.${format}`, mime, data, agentId: actor.id, projectId: project?.id ?? null,
      metadata: { template, title, subtitle, subjectAgent: subject?.id ?? null, width: W, height: H } });
    return { artifactIds: [artifact.id], artifact };
  }
  async function imageOptimize({ source, sourceId, conversationId = null, format = "webp", maxWidth = 1600, quality = 82 }, actor, extra) {
    let input, title, projectId = extra.projectId ?? null;
    if (source === "artifact") {
      const meta = artifacts.get(sourceId);
      if (!meta.mime.startsWith("image/")) fail(422, "not-an-image", "الملف المصدر ليس صورة");
      input = artifacts.content(sourceId).data; title = meta.title; projectId = meta.projectId ?? projectId;
    } else {
      const conversations = getConversations();
      if (!conversations || !conversationId) fail(422, "validation", "حدد المحادثة التي تحتوي المرفق");
      const file = conversations.getAttachment(conversationId, sourceId);
      if (!/^image\/(png|jpeg|webp)$/.test(file.mime)) fail(422, "not-an-image", "المرفق ليس صورة PNG أو JPEG أو WebP");
      input = Buffer.from(file.data); title = file.filename;
    }
    const sharp = (await load("sharp")).default;
    const before = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
    // rotate() applies EXIF orientation; sharp writes no input metadata (EXIF/GPS/ICC) unless asked, so it is stripped.
    let pipeline = sharp(input, { limitInputPixels: MAX_PIXELS }).rotate().resize({ width: maxWidth, withoutEnlargement: true });
    pipeline = format === "png" ? pipeline.png({ compressionLevel: 9, palette: true }) : format === "jpeg" ? pipeline.jpeg({ quality, mozjpeg: true }) : format === "avif" ? pipeline.avif({ quality }) : pipeline.webp({ quality });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    const artifact = saveArtifact(extra, { kind: "image", title: `نسخة محسّنة — ${clip(title, 80)}`, filename: `optimized-${now()}.${format === "jpeg" ? "jpg" : format}`, mime: `image/${format}`, data, agentId: actor.id, projectId,
      metadata: { source, sourceId, before: { width: before.width, height: before.height, format: before.format, bytes: input.length, hadExif: Boolean(before.exif) }, after: { width: info.width, height: info.height, format, bytes: data.length } } });
    return { artifactIds: [artifact.id], artifact, before: { width: before.width, height: before.height, bytes: input.length, format: before.format }, after: { width: info.width, height: info.height, bytes: data.length, format }, savedPct: Math.round((1 - data.length / input.length) * 100) };
  }
  async function saveCanvas({ title, imageBase64, templateId = null, projectId = null }, actor, extra) {
    if (templateId && !db.get("SELECT id FROM visual_templates WHERE id = ?", templateId)) fail(404, "not-found", "القالب غير موجود");
    if (projectId) company.getProject(projectId);
    const raw = Buffer.from(imageBase64, "base64");
    if (raw.length < 8 || raw.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") fail(422, "not-png", "الملف ليس صورة PNG صالحة");
    const sharp = (await load("sharp")).default;
    const meta = await sharp(raw, { limitInputPixels: MAX_PIXELS }).metadata();
    if (!meta.width || meta.width > 4096 || meta.height > 4096) fail(422, "canvas-size", "أبعاد اللوحة خارج الحد المسموح (4096 بكسل)");
    const data = await sharp(raw, { limitInputPixels: MAX_PIXELS }).png({ compressionLevel: 9 }).toBuffer();
    const artifact = saveArtifact(extra, { kind: "canvas", title, filename: `canvas-${now()}.png`, mime: "image/png", data, agentId: actor.id, projectId, metadata: { templateId, width: meta.width, height: meta.height, editor: "fabric.js" } });
    return { artifactIds: [artifact.id], artifact };
  }

  // ------------------------------------------------------------------ NEX (persisted ledgers + local spans)
  function agentStats({ range = "7d", agentId = null }) {
    const since = sinceIso(range, now);
    const filter = agentId ? "AND agent_id = ?" : "";
    const params = agentId ? [since, agentId] : [since];
    const runs = db.all(`SELECT agent_id, status, parent_run_id, workflow_id, cost_basis, cost_usd, prompt_tokens, completion_tokens, started_at, finished_at, project_id, task_id FROM agent_runs WHERE created_at >= ? ${filter} LIMIT 20000`, ...params);
    const tools = db.all(`SELECT agent_id, status, COUNT(*) AS n FROM tool_executions WHERE started_at >= ? ${filter} GROUP BY agent_id, status`, ...params);
    const usage = db.all(`SELECT agent_id, cost_basis, source, COUNT(*) AS n, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, SUM(cost_usd) AS usd FROM usage_events WHERE at >= ? ${filter} GROUP BY agent_id, cost_basis, source`, ...params);
    const agents = (agentId ? [agentId] : AGENTS.map((a) => a.id)).map((id) => {
      const mine = runs.filter((r) => r.agent_id === id);
      const durations = mine.filter((r) => r.started_at && r.finished_at).map((r) => Date.parse(r.finished_at) - Date.parse(r.started_at));
      const u = usage.filter((x) => x.agent_id === id);
      const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] ?? 0), 0);
      const estimated = u.filter((x) => x.cost_basis === "router-estimate");
      const known = u.filter((x) => x.source === "manual" && x.cost_basis !== "unknown");
      return {
        agentId: id, runs: mine.length, topLevel: mine.filter((r) => !r.parent_run_id).length, workflowSteps: mine.filter((r) => r.parent_run_id).length,
        byStatus: Object.fromEntries(["succeeded", "failed", "blocked", "cancelled", "queued", "running"].map((s) => [s, mine.filter((r) => r.status === s).length])),
        successRatePct: mine.filter((r) => ["succeeded", "failed"].includes(r.status)).length ? Math.round((100 * mine.filter((r) => r.status === "succeeded").length) / mine.filter((r) => ["succeeded", "failed"].includes(r.status)).length) : null,
        latencyMs: { p50: percentile(durations, 50), p95: percentile(durations, 95), samples: durations.length },
        tokens: { prompt: sum(u, "p"), completion: sum(u, "c") },
        cost: { knownUsd: known.length ? sum(known, "usd") : 0, knownEvents: sum(known, "n"), estimatedUsd: estimated.length ? Math.round(sum(estimated, "usd") * 1e6) / 1e6 : 0, estimatedEvents: sum(estimated, "n"),
          unknownEvents: sum(u.filter((x) => x.cost_basis === "unknown"), "n"), noInferenceRuns: mine.filter((r) => r.cost_basis === "no-inference").length },
        toolCalls: Object.fromEntries(tools.filter((t) => t.agent_id === id).map((t) => [t.status, t.n])),
        projects: [...new Set(mine.map((r) => r.project_id).filter(Boolean))].length
      };
    });
    return { range, since, basis: "application-measured runs, usage ledger and tool audit; estimated cost is the router's per-response estimate; unknown cost is never counted as $0", agents };
  }
  function providerCompare({ range = "7d" }) {
    const since = sinceIso(range, now);
    const rows = db.all("SELECT routing, effective_model, provider, latency_ms, status FROM agent_runs WHERE created_at >= ? AND routing IS NOT NULL ORDER BY created_at DESC LIMIT 3000", since);
    const models = new Map();
    for (const row of rows) {
      let routing; try { routing = JSON.parse(row.routing); } catch (_) { continue; }
      for (const attempt of routing.attempts || []) {
        const key = attempt.ref;
        const m = models.get(key) || { ref: key, provider: attempt.provider, attempts: 0, ok: 0, failures: {}, latencies: [], fallbacksFrom: 0 };
        m.attempts++;
        if (attempt.ok) { m.ok++; if (attempt.latencyMs != null) m.latencies.push(attempt.latencyMs); }
        else m.failures[attempt.code] = (m.failures[attempt.code] || 0) + 1;
        if (attempt.fallbackReason) m.fallbacksFrom++;
        models.set(key, m);
      }
    }
    const list = [...models.values()].map((m) => ({ ref: m.ref, provider: m.provider, attempts: m.attempts, successRatePct: Math.round((100 * m.ok) / m.attempts), failures: m.failures, fallbacksFrom: m.fallbacksFrom, latencyMs: { p50: percentile(m.latencies, 50), p95: percentile(m.latencies, 95) } }))
      .sort((a, b) => b.attempts - a.attempts);
    const usage = db.all("SELECT provider, model, COUNT(*) AS n, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown FROM usage_events WHERE at >= ? GROUP BY provider, model ORDER BY n DESC LIMIT 30", since);
    return { range, since, models: list, usage: usage.map((u) => ({ provider: u.provider, model: u.model, events: u.n, promptTokens: u.p, completionTokens: u.c, unknownCostEvents: u.unknown })), basis: "attempts recorded by ABUD runs (not the router's global traffic)" };
  }
  function toolLatency({ range = "7d" }) {
    const since = sinceIso(range, now);
    const rows = db.all("SELECT tool_id, status, duration_ms FROM tool_executions WHERE started_at >= ? LIMIT 20000", since);
    const tools = new Map();
    for (const r of rows) {
      const t = tools.get(r.tool_id) || { toolId: r.tool_id, executions: 0, byStatus: {}, durations: [] };
      t.executions++; t.byStatus[r.status] = (t.byStatus[r.status] || 0) + 1;
      if (r.duration_ms != null && r.status === "succeeded") t.durations.push(r.duration_ms);
      tools.set(r.tool_id, t);
    }
    return { range, since, tools: [...tools.values()].map((t) => ({ toolId: t.toolId, executions: t.executions, byStatus: t.byStatus, reliabilityPct: Math.round((100 * (t.byStatus.succeeded || 0)) / Math.max(1, t.executions - (t.byStatus.denied || 0))), latencyMs: { p50: percentile(t.durations, 50), p95: percentile(t.durations, 95) } })).sort((a, b) => b.executions - a.executions) };
  }
  const traces = ({ runId = null, limit = 50 }) => ({ spans: telemetry.recent({ runId, limit }), exporter: "local SQLite only (no remote collector)" });

  // ------------------------------------------------------------------ LUNA
  async function exportCalendar({ projectId = null, assignee = null }, actor, extra) {
    const { createEvents } = await load("ics");
    const project = projectId ? company.getProject(projectId) : null;
    const tasks = company.listTasks({ projectId: project?.id ?? null, assignee, includeClosed: false, limit: 2000 }).filter((t) => t.dueDate);
    if (!tasks.length) fail(422, "no-deadlines", "لا توجد مهام مفتوحة لها موعد نهائي في هذا النطاق");
    const events = tasks.slice(0, 500).map((t) => {
      const [y, m, d] = t.dueDate.split("-").map(Number);
      return {
        uid: `${t.id}@abud-company-os.local`, start: [y, m, d], duration: { days: 1 }, title: `موعد: ${t.title}`, productId: "abud-company-os/v5",
        description: `${TASK_AR[t.status] || t.status} · أولوية ${PRIORITY_AR[t.priority] || t.priority}${t.projectId ? ` · ${company.getProject(t.projectId).name}` : ""}${t.assignee && t.assignee !== "owner" ? ` · مسندة إلى ${agentById(t.assignee)?.name || t.assignee}` : ""}`,
        categories: ["ABUD FUN", ...(t.projectId ? [company.getProject(t.projectId).name] : [])], status: "CONFIRMED", busyStatus: "FREE",
        alarms: [{ action: "display", description: `موعد مهمة: ${t.title}`, trigger: { hours: 9, before: true } }]
      };
    });
    const { error, value } = createEvents(events);
    if (error) fail(500, "calendar-build-failed", "تعذر إنشاء ملف التقويم");
    const artifact = saveArtifact(extra, { kind: "calendar", title: `مواعيد المهام${project ? ` — ${project.name}` : ""}`, filename: `deadlines-${todayLocal()}.ics`, mime: "text/calendar", data: Buffer.from(value, "utf8"), agentId: actor.id, projectId: project?.id ?? null,
      metadata: { events: events.length, assignee } });
    return { artifactIds: [artifact.id], artifact, events: events.length, firstDue: tasks.map((t) => t.dueDate).sort()[0] };
  }
  async function executionPdf({ projectId = null, rangeDays = 7 }, actor, extra) {
    const { createPdfWriter } = await load("./pdf-arabic.mjs");
    const project = projectId ? company.getProject(projectId) : null;
    const since = iso(now() - rangeDays * 86_400_000);
    const today = todayLocal();
    const tasks = company.listTasks({ projectId: project?.id ?? null, includeClosed: true, limit: 3000 });
    const open = tasks.filter((t) => !["done", "cancelled"].includes(t.status));
    const overdue = open.filter((t) => t.dueDate && t.dueDate < today);
    const upcoming = open.filter((t) => t.dueDate && t.dueDate >= today).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 12);
    const done = tasks.filter((t) => t.status === "done" && t.completedAt >= since);
    const approvals = company.listApprovals({ status: "pending" });
    const runs = db.all(`SELECT agent_id, status, COUNT(*) AS n FROM agent_runs WHERE parent_run_id IS NULL AND created_at >= ? ${project ? "AND project_id = ?" : ""} GROUP BY agent_id, status`, since, ...(project ? [project.id] : []));
    const deliverables = artifacts.list({ projectId: project?.id ?? null, limit: 20 }).filter((a) => a.createdAt >= since);
    const w = await createPdfWriter();
    const scope = project ? `مشروع ${project.name}` : "الشركة كلها";
    w.heading(`تقرير تنفيذ — ${scope}`, { size: 18 });
    w.paragraph(`الفترة: آخر ${daysAr(rangeDays)} حتى ${today}. أعدّته LUNA من سجلات الشركة المحفوظة؛ الأرقام مقيسة وليست تقديرات.`, { size: 10.5 });
    w.heading("الخلاصة");
    w.table([{ label: "المؤشر", weight: 3 }, { label: "القيمة", weight: 1 }], [
      ["مهام مفتوحة", String(open.length)], ["متعطّلة", String(open.filter((t) => t.status === "blocked").length)], ["متأخرة عن موعدها", String(overdue.length)],
      [`أُنجزت خلال ${daysAr(rangeDays)}`, String(done.length)], ["موافقات بانتظار المالك", String(approvals.length)], ["ملفات ناتجة في الفترة", String(deliverables.length)]]);
    const taskRows = (list) => list.map((t) => [t.title, TASK_AR[t.status] || t.status, agentById(t.assignee)?.name || (t.assignee === "owner" ? "المالك" : "—"), t.dueDate || "—"]);
    const taskCols = [{ label: "المهمة", weight: 3.2 }, { label: "الحالة", weight: 1.1 }, { label: "المسؤول", weight: 1 }, { label: "الموعد", weight: 1.2 }];
    if (overdue.length) { w.heading("مهام متأخرة"); w.table(taskCols, taskRows(overdue.slice(0, 15))); }
    w.heading("المواعيد القادمة");
    if (upcoming.length) w.table(taskCols, taskRows(upcoming)); else w.paragraph("لا توجد مواعيد قادمة مسجلة.");
    w.heading(`ما أُنجز خلال ${daysAr(rangeDays)}`);
    if (done.length) w.table([{ label: "المهمة", weight: 4 }, { label: "تاريخ الإنجاز", weight: 1.4 }], done.slice(0, 15).map((t) => [t.title, t.completedAt.slice(0, 10)])); else w.paragraph("لا مهام منجزة في الفترة.");
    w.heading("موافقات تحتاج متابعة");
    if (approvals.length) w.table([{ label: "الطلب", weight: 4 }, { label: "منذ (ساعة)", weight: 1.2 }], approvals.slice(0, 12).map((a) => [a.title, String(Math.round((now() - Date.parse(a.createdAt)) / 36e5))]));
    else w.paragraph("لا توجد موافقات معلّقة.");
    w.heading("تشغيلات الوكلاء");
    const runRows = AGENTS.map((a) => { const mine = runs.filter((r) => r.agent_id === a.id); const n = (s) => String(mine.find((r) => r.status === s)?.n ?? 0); return [a.name, n("succeeded"), n("failed"), n("blocked")]; });
    w.table([{ label: "الوكيل", weight: 1.5 }, { label: "نجح", weight: 1 }, { label: "فشل", weight: 1 }, { label: "متوقف", weight: 1 }], runRows);
    if (deliverables.length) { w.heading("الملفات الناتجة"); w.table([{ label: "الملف", weight: 4 }, { label: "الحالة", weight: 1.2 }], deliverables.map((a) => [a.title, a.state === "approved" ? "معتمد" : "مسودة"])); }
    const bytes = await w.finish({ title: `تقرير تنفيذ — ${scope}`, footer: "ABUD FUN Company OS" });
    const artifact = saveArtifact(extra, { kind: "pdf", title: `تقرير تنفيذ — ${scope} (${today})`, filename: `execution-report-${today}.pdf`, mime: "application/pdf", data: Buffer.from(bytes), agentId: actor.id, projectId: project?.id ?? null,
      metadata: { rangeDays, counts: { open: open.length, overdue: overdue.length, done: done.length, approvals: approvals.length, deliverables: deliverables.length }, rtl: true, fonts: ["Alexandria", "Manrope"] } });
    return { artifactIds: [artifact.id], artifact, counts: artifact.metadata.counts };
  }
  function approvalFollowups({ olderThanHours = 24 }, actor) {
    const cutoff = now() - olderThanHours * 36e5;
    const created = [], skipped = [];
    for (const approval of company.listApprovals({ status: "pending" }).filter((a) => Date.parse(a.createdAt) <= cutoff).slice(0, 20)) {
      // externalRef makes the follow-up idempotent per approval, even across repeated runs.
      const task = company.createTask({ title: text(`متابعة طلب موافقة: ${approval.title}`, 160), priority: approval.risk === "spend" ? "high" : "medium", assignee: "owner", tags: [`by-${actor.id}`, "approval-followup"],
        description: `طلب الموافقة ${approval.id} (${approval.kind}) معلّق منذ ${Math.round((now() - Date.parse(approval.createdAt)) / 36e5)} ساعة. القرار للمالك فقط.` }, actor, { externalRef: `approval-followup:${approval.id}`, source: `agent:${actor.id}` });
      (task.deduplicated ? skipped : created).push({ taskId: task.id, approvalId: approval.id, title: task.title });
    }
    return { created, skipped, olderThanHours };
  }

  // ------------------------------------------------------------------ ZEN
  async function extract(url, signal) {
    const page = await fetchImpl(url, { allowHosts: company.settings().webAllowedHosts, signal });
    let title = null, body = page.text, byline = null, lang = null;
    if (/html/i.test(page.contentType)) {
      const [{ Readability }, { parseHTML }] = await Promise.all([load("@mozilla/readability"), load("linkedom")]);
      const { document } = parseHTML(page.text);
      // Scripts are parsed as inert text by linkedom and removed before extraction; nothing is executed.
      for (const node of document.querySelectorAll("script,style,noscript,iframe,object,embed,template")) node.remove();
      const article = new Readability(document, { charThreshold: 200 }).parse();
      title = text(article?.title || document.title || "", 160) || null;
      body = article?.textContent || document.body?.textContent || "";
      byline = article?.byline ? text(article.byline, 120) : null;
      lang = article?.lang || document.documentElement?.getAttribute?.("lang") || null;
    }
    const clean = body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const suspected = INJECTION_HINTS.filter((re) => re.test(clean)).length;
    return { ...page, title, byline, lang, content: clean.slice(0, 30000), contentTruncated: clean.length > 30000, suspectedInstructions: suspected };
  }
  async function webExtract({ url, ingest = false, projectId = null }, actor, extra) {
    if (projectId) company.getProject(projectId);
    const page = await extract(url, extra.signal);
    if (!page.content) fail(422, "web-empty", "لم يُعثر على نص قابل للقراءة في الصفحة");
    let document = null;
    if (ingest) document = knowledge.ingestWeb({ projectId, url: page.url, title: page.title, content: page.content, fetchedAt: page.fetchedAt, etag: page.etag, sourceBytes: page.bytes, truncated: page.truncated || page.contentTruncated });
    return {
      url: page.url, redirects: page.redirects, title: page.title, byline: page.byline, lang: page.lang, fetchedAt: page.fetchedAt, bytes: page.bytes, truncated: page.truncated || page.contentTruncated,
      excerpt: redact(page.content.slice(0, 2400), 2400), characters: page.content.length, citation: document ? `knowledge:${document.id}` : page.url,
      knowledgeDocumentId: document?.id ?? null, untrusted: true, suspectedInstructions: page.suspectedInstructions,
      warning: page.suspectedInstructions ? "The page contains text addressed to an AI; it was kept as data and not followed." : null
    };
  }
  function knowledgeSearch({ q, projectId = null, limit = 6 }) {
    if (projectId) company.getProject(projectId);
    const hits = knowledge.search({ q, projectId, forAgent: true, limit });
    return { query: q, scope: projectId ? "company + project" : "company", results: hits.map((h) => ({ citation: h.citation, title: h.document.title, sourceType: h.document.sourceType, source: h.document.sourceRef, indexedAt: h.document.indexedAt, freshness: h.document.freshness, excerpt: h.excerpt })), untrusted: true };
  }
  async function knowledgeFreshness({ projectId = null, maxAgeDays = 30, recheckWeb = false }, actor, extra) {
    if (projectId) company.getProject(projectId);
    const cutoff = iso(now() - maxAgeDays * 86_400_000);
    const report = [];
    let webChecks = 0;
    for (const doc of knowledge.sources({ projectId })) {
      let state = doc.indexedAt < cutoff ? "stale" : "fresh", detail = null;
      if (doc.sourceType === "project-doc") {
        const [rel, name] = doc.sourceRef.split(/:(?=[^:]+$)/);
        const current = await readProjectDoc(rel, name).catch(() => null);
        if (!current) { state = "missing"; detail = "the authorized checkout or document is not readable now"; }
        else if (contentDigest(current.excerpt) !== doc.contentSha256) { state = "changed"; detail = "document changed since it was indexed; re-import to refresh"; }
        else state = "fresh";
      } else if (doc.sourceType === "web-page" && recheckWeb && webChecks < 5 && doc.sourceUrl) {
        webChecks++;
        try { const page = await extract(doc.sourceUrl, extra.signal); state = contentDigest(page.content) === doc.contentSha256 ? "fresh" : "changed"; }
        catch (error) { state = "unreachable"; detail = error?.code || "fetch-failed"; }
      }
      knowledge.markChecked(doc.id, state);
      report.push({ id: doc.id, title: doc.title, sourceType: doc.sourceType, source: doc.sourceRef, indexedAt: doc.indexedAt, state, detail });
    }
    return { maxAgeDays, checked: report.length, webRechecked: webChecks, summary: Object.fromEntries(["fresh", "stale", "changed", "missing", "unreachable"].map((s) => [s, report.filter((r) => r.state === s).length])), sources: report };
  }

  // ------------------------------------------------------------------ REX (bounded external scanners)
  async function withTemp(fn) {
    const dir = await mkdtemp(join(tmpdir(), "abud-scan-"));
    try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }
  async function readJsonBounded(file, max = 8 * 1024 * 1024) {
    const info = await stat(file).catch(() => null);
    if (!info) return null;
    if (info.size > max) fail(502, "scanner-report-too-large", "تقرير الفاحص أكبر من الحد المسموح");
    const raw = (await readFile(file, "utf8")).trim();
    return raw ? JSON.parse(raw) : null;
  }
  async function gitleaks({ projectId, mode = "history" }, actor, extra) {
    const binary = binaries.gitleaks();
    if (!binary) fail(503, "capability-unavailable", "Gitleaks غير مثبت على هذا الجهاز");
    const { project, dirs } = await checkoutDirs(projectId);
    if (!dirs.length) fail(422, "no-checkout", "لا يوجد Checkout محلي مصرّح لهذا المشروع");
    const results = [];
    for (const { rel, dir } of dirs) {
      const outcome = await withTemp(async (tmp) => {
        const report = join(tmp, "gitleaks.json");
        // Fixed argument vector. cwd and the ignore path are the empty temp folder, so no file from the scan target can
        // inject a baseline; a repository's own .gitleaks.toml is reported because gitleaks would honour it.
        const args = ["git", dir, "--report-format", "json", "--report-path", report, "--redact=100", "--no-banner", "--no-color", "--exit-code", "0", "--log-level", "error", "--max-target-megabytes", "5", "-i", tmp, "--timeout", "100",
          ...(mode === "uncommitted" ? ["--pre-commit"] : ["--log-opts=--max-count=300"])];
        // Git line-ending warnings on stderr make gitleaks abort its diff silently, so they are switched off for this
        // process only; any gitleaks error line still marks the checkout as not scanned rather than clean.
        const run = await runBinary(binary, args, { cwd: tmp, timeoutMs: 110_000, signal: extra.signal, env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.safecrlf", GIT_CONFIG_VALUE_0: "false" } });
        if (run.cancelled) fail(499, "cancelled", "أُلغي الفحص");
        if (run.code !== 0) return { rel, ok: false, error: run.killed ? "timeout" : `exit-${run.code}`, detail: run.stderr };
        if (/\bERR\b|error=/.test(run.stderr)) return { rel, ok: false, error: "scanner-error", detail: run.stderr };
        const parsed = (await readJsonBounded(report)) || [];
        // Labelled, never suppressed: a finding in a test file is usually a synthetic fixture, but the owner still reviews it.
        const inTestFile = (file) => /(^|[\\/])(tests?|__tests__|fixtures?|specs?)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/i.test(file || "");
        return {
          rel, ok: true, repoConfig: existsSync(join(dir, ".gitleaks.toml")), repoIgnoreFile: existsSync(join(dir, ".gitleaksignore")),
          findings: parsed.slice(0, 200).map((f) => ({ rule: text(f.RuleID, 80), description: text(f.Description, 160), file: text(isAbsolute(f.File || "") ? relative(dir, f.File) : f.File, 240), line: f.StartLine ?? null, commit: f.Commit ? String(f.Commit).slice(0, 10) : null, date: f.Date ? String(f.Date).slice(0, 10) : null, fingerprint: f.Fingerprint ? String(f.Fingerprint).replace(/:[^:]*$/, "").slice(0, 160) : null, inTestFile: inTestFile(f.File) })),
          total: parsed.length, inTestFiles: parsed.filter((f) => inTestFile(f.File)).length
        };
      });
      results.push(outcome);
    }
    const total = results.reduce((s, r) => s + (r.total || 0), 0);
    return { project: project.name, mode, scanner: "gitleaks", checkouts: results, findings: total, findingsInTestFiles: results.reduce((s, r) => s + (r.inTestFiles || 0), 0), secretValuesStored: false, method: mode === "uncommitted" ? "git diff of uncommitted changes" : "most recent 300 commits of local history", evidence: `gitleaks ${mode} scan of ${results.map((r) => r.rel).join(", ")}` };
  }
  async function osv({ projectId }, actor, extra) {
    const binary = binaries.osv();
    if (!binary) fail(503, "capability-unavailable", "OSV-Scanner غير مثبت على هذا الجهاز");
    const { project, dirs } = await checkoutDirs(projectId);
    if (!dirs.length) fail(422, "no-checkout", "لا يوجد Checkout محلي مصرّح لهذا المشروع");
    const results = [];
    for (const { rel, dir } of dirs) {
      results.push(await withTemp(async (tmp) => {
        const out = join(tmp, "osv.json");
        // Lockfile/SBOM extraction only: call analysis (which can run build scripts) is explicitly disabled.
        const args = ["scan", "source", "-r", "--format", "json", "--output-file", out, "--verbosity", "error", "--no-call-analysis=go", "--no-call-analysis=rust", dir];
        const run = await runBinary(binary, args, { cwd: tmp, timeoutMs: 170_000, signal: extra.signal });
        if (run.cancelled) fail(499, "cancelled", "أُلغي الفحص");
        if (run.code === 128) return { rel, ok: true, packagesScanned: 0, vulnerable: [], note: "no supported lockfiles found" };
        if (![0, 1].includes(run.code)) return { rel, ok: false, error: run.killed ? "timeout" : `exit-${run.code}`, detail: run.stderr };
        const parsed = (await readJsonBounded(out)) || { results: [] };
        const vulnerable = [];
        let scanned = 0;
        for (const source of parsed.results || []) {
          for (const pkg of source.packages || []) {
            scanned++;
            if (!pkg.vulnerabilities?.length) continue;
            vulnerable.push({
              lockfile: text(relative(dir, source.source?.path || "") || source.source?.path, 200), name: text(pkg.package?.name, 120), version: text(pkg.package?.version, 60), ecosystem: text(pkg.package?.ecosystem, 30),
              maxSeverity: pkg.groups?.map((g) => Number(g.max_severity)).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? null,
              advisories: pkg.vulnerabilities.slice(0, 10).map((v) => ({ id: text(v.id, 40), summary: text(v.summary, 200), aliases: (v.aliases || []).slice(0, 4).map((a) => text(a, 40)),
                fixed: [...new Set((v.affected || []).flatMap((a) => (a.ranges || []).flatMap((r) => (r.events || []).map((e) => e.fixed).filter(Boolean))))].slice(0, 4) }))
            });
          }
        }
        return { rel, ok: true, packagesScanned: scanned, vulnerable: vulnerable.slice(0, 100) };
      }));
    }
    return { project: project.name, scanner: "osv-scanner", checkouts: results, vulnerablePackages: results.reduce((s, r) => s + (r.vulnerable?.length || 0), 0), dataSent: "package names and versions to api.osv.dev", evidence: `osv-scanner lockfile scan of ${results.map((r) => r.rel).join(", ")}` };
  }

  // ------------------------------------------------------------------ registry wiring + health
  const handlers = {
    "company.overview": companyOverview, "approvals.list": approvalsList,
    "design.statusCard": statusCard, "design.brandGraphic": brandGraphic, "image.optimize": imageOptimize, "design.saveCanvas": saveCanvas,
    "telemetry.agentStats": agentStats, "telemetry.providerCompare": providerCompare, "telemetry.toolLatency": toolLatency, "telemetry.traces": traces,
    "calendar.exportTasks": exportCalendar, "report.executionPdf": executionPdf, "approvals.followupTasks": approvalFollowups,
    "web.extract": webExtract, "knowledge.search": knowledgeSearch, "knowledge.freshness": knowledgeFreshness,
    "security.gitleaks": gitleaks, "security.osv": osv
  };
  const versionCache = new Map();
  async function binaryVersion(name, file, args) {
    const key = `${name}:${file}`;
    if (versionCache.has(key)) return versionCache.get(key);
    const run = await runBinary(file, args, { timeoutMs: 8000 });
    const version = run.code === 0 ? (run.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null) : null;
    versionCache.set(key, version);
    return version;
  }
  const moduleCheck = async (...names) => { for (const name of names) await load(name); };
  const HEALTH = {
    "design.statusCard": () => moduleCheck("sharp"), "design.brandGraphic": () => moduleCheck("sharp"), "image.optimize": () => moduleCheck("sharp"), "design.saveCanvas": () => moduleCheck("sharp"),
    "telemetry.traces": () => moduleCheck("@opentelemetry/sdk-trace"),
    "calendar.exportTasks": () => moduleCheck("ics"),
    "report.executionPdf": async () => { await moduleCheck("pdf-lib", "@pdf-lib/fontkit"); for (const f of ["alexandria-arabic.woff2", "manrope-latin.woff2"]) if (!existsSync(join(ASSETS, "fonts", f))) throw new Error(`font missing: ${f}`); },
    "web.extract": async () => { await moduleCheck("@mozilla/readability", "linkedom"); if (!company.settings().webAllowedHosts.length) throw Object.assign(new Error("no approved hosts"), { reasonAr: "لا توجد مواقع معتمدة؛ أضفها من إعدادات الأدوات" }); },
    "security.gitleaks": async () => { const file = binaries.gitleaks(); if (!file) throw Object.assign(new Error("gitleaks not installed"), { reasonAr: "Gitleaks غير مثبت (winget install Gitleaks.Gitleaks)" }); return { version: await binaryVersion("gitleaks", file, ["version"]) }; },
    "security.osv": async () => { const file = binaries.osv(); if (!file) throw Object.assign(new Error("osv-scanner not installed"), { reasonAr: "OSV-Scanner غير مثبت (winget install Google.OSVScanner)" }); return { version: await binaryVersion("osv", file, ["--version"]) }; }
  };
  /** Live dependency check for one capability: { state: available|unavailable, reason, detail, checkedAt }. */
  async function health(toolId) {
    const check = HEALTH[toolId];
    if (!check) return { state: "available", reason: null, checkedAt: iso() };
    try { const detail = await check(); return { state: "available", reason: null, detail: detail ?? null, checkedAt: iso() }; }
    catch (error) { return { state: "unavailable", reason: error?.reasonAr || `اعتمادية غير متاحة: ${text(error?.message, 120)}`, checkedAt: iso() }; }
  }
  return { handlers, health, extract };
}
