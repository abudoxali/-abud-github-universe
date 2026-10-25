/* Approved local knowledge. Documents and FTS live only in the ignored SQLite store. */
import { createHash } from "node:crypto";
import { HttpError } from "./company.mjs";
import { newId, nowIso } from "./db.mjs";

const fail = (status, code, ar) => { throw new HttpError(status, code, ar); };
const safeText = (value, max, label) => {
  if (typeof value !== "string") fail(422, "validation", `«${label}» يجب أن يكون نصًا`);
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!clean || clean.length > max) fail(422, "validation", `«${label}» يجب أن يكون بين 1 و${max} حرفًا`);
  return clean;
};
const row = (r) => r && ({ id: r.id, projectId: r.project_id, sourceType: r.source_type, sourceRef: r.source_ref, title: r.title, state: r.state,
  bytes: r.bytes, sourceBytes: r.source_bytes, truncated: r.truncated === 1, indexedAt: r.indexed_at, createdAt: r.created_at, updatedAt: r.updated_at,
  sourceUrl: r.source_url ?? null, fetchedAt: r.fetched_at ?? null, lastCheckedAt: r.last_checked_at ?? null, freshness: r.freshness ?? null });
/** The digest ingest() stores, so freshness checks can compare a source's current content without re-indexing it. */
export const contentDigest = (value) => createHash("sha256").update(String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim()).digest("hex");
function chunksOf(content) {
  const chunks = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + 1200, content.length);
    if (end < content.length) {
      const breakAt = content.lastIndexOf(" ", end);
      if (breakAt > start + 600) end = breakAt;
    }
    const text = content.slice(start, end).trim();
    if (text) chunks.push({ ordinal: chunks.length, content: text, start, end });
    if (end >= content.length) break;
    start = Math.max(start + 1, end - 80);
  }
  return chunks;
}
export function createKnowledge({ company }) {
  const { db } = company;
  function get(id) {
    const found = db.get("SELECT * FROM knowledge_documents WHERE id = ?", String(id));
    if (!found) fail(404, "not-found", "المصدر المعرفي غير موجود");
    return row(found);
  }
  function list({ projectId = null, sourceType = null, state = "active", limit = 100 } = {}) {
    const where = ["state = ?"], params = [state];
    if (projectId) { where.push("project_id = ?"); params.push(projectId); }
    if (sourceType) { where.push("source_type = ?"); params.push(sourceType); }
    return db.all(`SELECT * FROM knowledge_documents WHERE ${where.join(" AND ")} ORDER BY indexed_at DESC LIMIT ?`, ...params, Math.min(Math.max(Number(limit) || 100, 1), 200)).map(row);
  }
  function ingest({ projectId = null, sourceType, sourceRef, title, content, sourceBytes = null, truncated = false, sourceUrl = null, fetchedAt = null, etag = null }) {
    if (projectId) company.getProject(projectId);
    const heading = safeText(title, 160, "العنوان");
    const text = safeText(content, 30000, "المحتوى");
    if (Buffer.byteLength(text, "utf8") > 100000) fail(413, "knowledge-size", "المستند أكبر من الحد المسموح");
    if (/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{16,})/.test(text)) fail(422, "secret-rejected", "المصدر يبدو أنه يحتوي على مفتاح سري");
    const ref = safeText(sourceRef, 240, "مرجع المصدر");
    const digest = createHash("sha256").update(text).digest("hex");
    if (sourceType === "owner-text") {
      const duplicate = db.get("SELECT * FROM knowledge_documents WHERE project_id IS ? AND source_type = 'owner-text' AND content_sha256 = ? AND state = 'active' LIMIT 1", projectId, digest);
      if (duplicate) return { ...row(duplicate), unchanged: true };
    }
    const existing = db.get("SELECT * FROM knowledge_documents WHERE project_id IS ? AND source_type = ? AND source_ref = ?", projectId, sourceType, ref);
    if (existing?.content_sha256 === digest && existing.state === "active") return { ...row(existing), unchanged: true };
    const id = existing?.id ?? newId("doc"), at = nowIso();
    db.tx(() => {
      if (existing) {
        db.run("UPDATE knowledge_documents SET title=?,content_sha256=?,state='active',bytes=?,source_bytes=?,truncated=?,indexed_at=?,updated_at=?,source_url=?,fetched_at=?,etag=?,last_checked_at=?,freshness='fresh' WHERE id=?",
          heading, digest, Buffer.byteLength(text), sourceBytes, truncated ? 1 : 0, at, at, sourceUrl, fetchedAt, etag, at, id);
        db.run("DELETE FROM knowledge_chunks WHERE document_id = ?", id);
      } else db.run("INSERT INTO knowledge_documents (id,project_id,source_type,source_ref,title,content_sha256,state,bytes,source_bytes,truncated,created_at,indexed_at,updated_at,source_url,fetched_at,etag,last_checked_at,freshness) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id, projectId, sourceType, ref, heading, digest, "active", Buffer.byteLength(text), sourceBytes, truncated ? 1 : 0, at, at, at, sourceUrl, fetchedAt, etag, at, "fresh");
      for (const chunk of chunksOf(text)) db.run("INSERT INTO knowledge_chunks (document_id,ordinal,content,start_char,end_char) VALUES (?,?,?,?,?)", id, chunk.ordinal, chunk.content, chunk.start, chunk.end);
      company.log({ action: existing ? "knowledge.reindexed" : "knowledge.ingested", targetType: "knowledge", targetId: id, summary: `${existing ? "تحديث" : "إضافة"} مصدر معرفي: ${heading}` });
    });
    return get(id);
  }
  function ingestOwner(input) {
    return ingest({ projectId: input.projectId || null, sourceType: "owner-text", sourceRef: `owner:${newId("source")}`, title: input.title, content: input.content });
  }
  function ingestProject(projectId, doc) {
    // Checkout names come from the owner's workspace scan and may contain inner spaces ("ABUD FUN Company OS").
    if (!doc || typeof doc.rel !== "string" || !/^[A-Za-z0-9._/-](?:[A-Za-z0-9._ /-]{0,118}[A-Za-z0-9._/-])?$/.test(doc.rel) || doc.rel.startsWith("/") || doc.rel.split("/").includes("..") || !["README.md", "STATUS.md"].includes(doc.doc)) fail(422, "knowledge-source", "المستند ليس من مصدر مشروع معتمد");
    return ingest({ projectId, sourceType: "project-doc", sourceRef: `${doc.rel}:${doc.doc}`, title: `${doc.doc} · ${doc.rel}`, content: doc.excerpt, sourceBytes: doc.bytes, truncated: doc.truncated });
  }
  /** An approved web page extracted by ZEN. The URL is the stable reference; re-ingesting the same URL updates it. */
  function ingestWeb({ projectId = null, url, title, content, fetchedAt, etag = null, sourceBytes = null, truncated = false }) {
    const ref = url.length <= 240 ? url : `web:${createHash("sha256").update(url).digest("hex").slice(0, 40)}`;
    return ingest({ projectId, sourceType: "web-page", sourceRef: ref, title: title || url, content, sourceBytes, truncated, sourceUrl: url, fetchedAt, etag });
  }
  /** Sources with the fields a freshness check needs (digest, origin, last check). */
  function sources({ projectId = null } = {}) {
    const rows = projectId ? db.all("SELECT * FROM knowledge_documents WHERE state = 'active' AND (project_id = ? OR project_id IS NULL) ORDER BY indexed_at LIMIT 200", projectId)
      : db.all("SELECT * FROM knowledge_documents WHERE state = 'active' ORDER BY indexed_at LIMIT 200");
    return rows.map((r) => ({ ...row(r), contentSha256: r.content_sha256 }));
  }
  function markChecked(id, freshness) {
    if (!["fresh", "stale", "changed", "unreachable", "missing"].includes(freshness)) fail(422, "validation", "حالة الحداثة غير صالحة");
    db.run("UPDATE knowledge_documents SET last_checked_at = ?, freshness = ? WHERE id = ?", nowIso(), freshness, id);
  }
  function search({ q, projectId = null, sourceType = null, forAgent = false, limit = 20 } = {}) {
    const terms = String(q ?? "").match(/[\p{L}\p{N}_]{2,}/gu)?.slice(0, 8) ?? [];
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
    const where = ["knowledge_fts MATCH ?", "d.state = 'active'"], params = [match];
    if (forAgent) { where.push("(d.project_id IS NULL OR d.project_id = ?)"); params.push(projectId ?? ""); }
    else if (projectId) { where.push("d.project_id = ?"); params.push(projectId); }
    if (sourceType) { where.push("d.source_type = ?"); params.push(sourceType); }
    return db.all(`SELECT d.*,c.id AS chunk_id,c.content AS excerpt FROM knowledge_fts JOIN knowledge_chunks c ON c.id = knowledge_fts.rowid JOIN knowledge_documents d ON d.id = c.document_id WHERE ${where.join(" AND ")} ORDER BY bm25(knowledge_fts),d.indexed_at DESC LIMIT ?`, ...params, Math.min(Math.max(Number(limit) || 20, 1), 50))
      .map((r) => ({ document: row(r), chunkId: r.chunk_id, excerpt: r.excerpt.slice(0, 500), citation: `knowledge:${r.id}#chunk-${r.chunk_id}` }));
  }
  function preview(id) {
    const document = get(id);
    return { ...document, chunks: db.all("SELECT id,ordinal,content,start_char,end_char FROM knowledge_chunks WHERE document_id = ? ORDER BY ordinal LIMIT 80", id).map((c) => ({ id: c.id, ordinal: c.ordinal, content: c.content, start: c.start_char, end: c.end_char })) };
  }
  function setState(id, state) {
    if (!["active", "archived"].includes(state)) fail(422, "validation", "حالة المستند غير صالحة");
    get(id); db.run("UPDATE knowledge_documents SET state = ?,updated_at = ? WHERE id = ?", state, nowIso(), id);
    return get(id);
  }
  function remove(id) {
    get(id); db.tx(() => { db.run("DELETE FROM knowledge_documents WHERE id = ?", id); company.log({ action: "knowledge.deleted", targetType: "knowledge", targetId: id, summary: "حذف مصدر معرفي وفهرسه" }); });
    return { deleted: id };
  }
  function reindex() { db.run("INSERT INTO knowledge_fts(knowledge_fts) VALUES ('rebuild')"); return { chunks: db.get("SELECT COUNT(*) AS n FROM knowledge_chunks").n, at: nowIso() }; }
  return { get, list, ingestOwner, ingestProject, ingestWeb, sources, markChecked, search, preview, setState, remove, reindex };
}
