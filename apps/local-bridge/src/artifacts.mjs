/* Generated deliverables (graphics, calendars, PDF reports). Stored as BLOBs in the ignored company store, linked to the
 * agent, project, run, workflow and tool execution that produced them. Drafts become "approved" only by the owner. */
import { createHash } from "node:crypto";
import { HttpError } from "./company.mjs";
import { newId, nowIso, parseJson } from "./db.mjs";
import { text } from "./util.mjs";

export const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
const KINDS = new Set(["image", "calendar", "pdf", "report", "canvas"]);
const MIMES = new Set(["image/png", "image/webp", "image/jpeg", "image/avif", "text/calendar", "application/pdf"]);

const meta = (r) => r && ({
  id: r.id, kind: r.kind, title: r.title, filename: r.filename, mime: r.mime, sizeBytes: r.size_bytes, sha256: r.sha256, agentId: r.agent_id, projectId: r.project_id,
  runId: r.run_id, executionId: r.execution_id, workflowId: r.workflow_id, state: r.state, metadata: parseJson(r.metadata, {}), approvedAt: r.approved_at, createdAt: r.created_at
});
const COLUMNS = "id, kind, title, filename, mime, size_bytes, sha256, agent_id, project_id, run_id, execution_id, workflow_id, state, metadata, approved_at, created_at";

export function createArtifacts({ company }) {
  const { db } = company;
  function save({ kind, title, filename, mime, data, agentId = null, projectId = null, runId = null, executionId = null, workflowId = null, metadata = {} }) {
    if (!KINDS.has(kind) || !MIMES.has(mime)) throw new HttpError(422, "artifact-type", "نوع الملف الناتج غير مدعوم");
    const bytes = Buffer.from(data);
    if (!bytes.length || bytes.length > ARTIFACT_MAX_BYTES) throw new HttpError(413, "artifact-size", "حجم الملف الناتج خارج الحد المسموح");
    const id = newId("art");
    const safeName = text(filename, 120).replace(/[\\/:*?"<>|]+/g, "-") || `${id}.bin`;
    db.run(`INSERT INTO artifacts (id, kind, title, filename, mime, size_bytes, sha256, data, agent_id, project_id, run_id, execution_id, workflow_id, state, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, kind, text(title, 160) || safeName, safeName, mime, bytes.length, createHash("sha256").update(bytes).digest("hex"), bytes, agentId, projectId, runId, executionId, workflowId, "draft", JSON.stringify(metadata), nowIso());
    company.log({ actorType: agentId ? "agent" : "owner", actorId: agentId || "owner", action: "artifact.created", targetType: projectId ? "project" : "artifact", targetId: projectId || id,
      summary: `ملف ناتج: ${text(title, 80)} (${kind})`, metadata: { artifactId: id, executionId, runId } });
    return get(id);
  }
  function get(id) {
    const row = db.get(`SELECT ${COLUMNS} FROM artifacts WHERE id = ?`, String(id));
    if (!row) throw new HttpError(404, "not-found", "الملف الناتج غير موجود");
    return meta(row);
  }
  function content(id) {
    const row = db.get("SELECT id, filename, mime, size_bytes, data FROM artifacts WHERE id = ?", String(id));
    if (!row) throw new HttpError(404, "not-found", "الملف الناتج غير موجود");
    return { id: row.id, filename: row.filename, mime: row.mime, sizeBytes: row.size_bytes, data: Buffer.from(row.data) };
  }
  function list({ projectId = null, agentId = null, workflowId = null, state = null, kind = null, limit = 60, before = null } = {}) {
    const where = [], params = [];
    if (projectId) { where.push("project_id = ?"); params.push(projectId); }
    if (agentId) { where.push("agent_id = ?"); params.push(agentId); }
    if (workflowId) { where.push("workflow_id = ?"); params.push(workflowId); }
    if (state) { where.push("state = ?"); params.push(state); } else where.push("state != 'archived'");
    if (kind) { where.push("kind = ?"); params.push(kind); }
    if (before) { where.push("created_at < ?"); params.push(before); }
    return db.all(`SELECT ${COLUMNS} FROM artifacts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`, ...params, Math.min(Math.max(Number(limit) || 60, 1), 200)).map(meta);
  }
  function setState(id, state, actor = { type: "owner", id: "owner" }) {
    if (!["draft", "approved", "archived"].includes(state)) throw new HttpError(422, "validation", "حالة الملف غير صالحة");
    // Approval is an owner decision; an agent can never mark its own output approved.
    if (state === "approved" && actor.type !== "owner") throw new HttpError(403, "owner-only", "اعتماد الملفات للمالك فقط");
    const current = get(id);
    db.run("UPDATE artifacts SET state = ?, approved_at = ? WHERE id = ?", state, state === "approved" ? nowIso() : current.approvedAt, id);
    company.log({ actorType: actor.type, actorId: actor.id, action: `artifact.${state}`, targetType: "artifact", targetId: id, summary: `${{ approved: "اعتماد", archived: "أرشفة", draft: "إعادة إلى مسودة" }[state]}: ${current.title}` });
    return get(id);
  }
  function remove(id) {
    const current = get(id);
    db.run("DELETE FROM artifacts WHERE id = ?", id);
    company.log({ action: "artifact.deleted", targetType: "artifact", targetId: id, summary: `حذف ملف ناتج: ${current.title}` });
    return { deleted: id };
  }
  return { save, get, content, list, setState, remove };
}

/** Reusable Fabric.js templates for MIA's editor. The canvas JSON is stored, never executed by the server; image sources
 * are limited to embedded data URIs and the bundled agent artwork, so a template cannot make the browser fetch elsewhere. */
const SAFE_SRC = /^(?:data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+|\.\/internal\/assets\/agents\/[a-z0-9-]{1,40}\.webp)$/;
export function validateTemplateSpec(spec) {
  let parsed;
  try { parsed = typeof spec === "string" ? JSON.parse(spec) : spec; } catch (_) { throw new HttpError(422, "template-json", "القالب ليس JSON صالحًا"); }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.objects)) throw new HttpError(422, "template-shape", "القالب لا يحتوي على عناصر لوحة Fabric");
  let nodes = 0;
  const walk = (value, depth) => {
    if (depth > 12 || ++nodes > 20000) throw new HttpError(422, "template-size", "القالب معقد أكثر من الحد المسموح");
    if (typeof value === "string") { if (/javascript:|<script|on\w+\s*=/i.test(value)) throw new HttpError(422, "template-unsafe", "القالب يحتوي على نص غير آمن"); return; }
    if (Array.isArray(value)) { value.forEach((v) => walk(v, depth + 1)); return; }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (["src", "source", "href", "xlink:href"].includes(key) && typeof child === "string" && !SAFE_SRC.test(child)) throw new HttpError(422, "template-source", "مصادر الصور في القالب يجب أن تكون مضمّنة أو من صور الوكلاء المعتمدة");
        walk(child, depth + 1);
      }
    }
  };
  walk(parsed, 0);
  const json = JSON.stringify(parsed);
  if (json.length > 400000) throw new HttpError(413, "template-size", "القالب أكبر من الحد المسموح");
  return json;
}
export function createTemplates({ company }) {
  const { db } = company;
  const row = (r) => r && ({ id: r.id, name: r.name, kind: r.kind, spec: JSON.parse(r.spec), width: r.width, height: r.height, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at });
  const dims = (value, field) => { if (!Number.isInteger(value) || value < 64 || value > 4096) throw new HttpError(422, "validation", `${field} يجب أن يكون بين 64 و4096`); return value; };
  function get(id) { const r = db.get("SELECT * FROM visual_templates WHERE id = ?", String(id)); if (!r) throw new HttpError(404, "not-found", "القالب غير موجود"); return row(r); }
  function list({ state = "active" } = {}) { return db.all("SELECT * FROM visual_templates WHERE state = ? ORDER BY updated_at DESC LIMIT 100", state === "archived" ? "archived" : "active").map(row); }
  function create({ name, spec, width, height }) {
    const title = text(name, 80);
    if (!title) throw new HttpError(422, "validation", "اكتب اسم القالب");
    const id = newId("tpl"), at = nowIso();
    db.run("INSERT INTO visual_templates (id, name, kind, spec, width, height, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", id, title, "fabric", validateTemplateSpec(spec), dims(width, "العرض"), dims(height, "الارتفاع"), "active", at, at);
    company.log({ action: "template.created", targetType: "template", targetId: id, summary: `قالب بصري جديد: ${title}` });
    return get(id);
  }
  function update(id, patch) {
    const current = get(id);
    const next = { name: "name" in patch ? text(patch.name, 80) || current.name : current.name, spec: "spec" in patch ? validateTemplateSpec(patch.spec) : JSON.stringify(current.spec),
      width: "width" in patch ? dims(patch.width, "العرض") : current.width, height: "height" in patch ? dims(patch.height, "الارتفاع") : current.height,
      state: "state" in patch ? (["active", "archived"].includes(patch.state) ? patch.state : current.state) : current.state };
    db.run("UPDATE visual_templates SET name = ?, spec = ?, width = ?, height = ?, state = ?, updated_at = ? WHERE id = ?", next.name, next.spec, next.width, next.height, next.state, nowIso(), id);
    return get(id);
  }
  return { get, list, create, update };
}
