/* Durable owner/agent conversations. Runs remain the sole inference and audit records. */
import { AGENT_IDS } from "./catalog.mjs";
import { HttpError } from "./company.mjs";
import { newId, nowIso, parseJson } from "./db.mjs";
import { createHash } from "node:crypto";
import { redact } from "./util.mjs";

/** Token estimate by script (no tokenizer dependency): Arabic ≈ 2.5 chars/token, Latin ≈ 4, other symbols ≈ 2. It is a
 * budget heuristic and is reported as an estimate. */
export function estimateTokens(value) {
  const text = String(value ?? "");
  const arabic = (text.match(/[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9]/g) || []).length;
  const other = text.length - arabic - latin;
  return Math.ceil(arabic / 2.5 + latin / 4 + Math.max(0, other) / 2);
}

const fail = (status, code, message) => { throw new HttpError(status, code, message); };
const clean = (value, max, label) => {
  if (typeof value !== "string") fail(422, "validation", `«${label}» يجب أن يكون نصًا`);
  const result = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!result || result.length > max) fail(422, "validation", `«${label}» يجب أن يكون بين 1 و${max} حرفًا`);
  return result;
};
const row = (r) => r && ({ id: r.id, agentId: r.agent_id, projectId: r.project_id, taskId: r.task_id, title: r.title, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at });
const message = (r) => r && ({ id: r.id, conversationId: r.conversation_id, runId: r.run_id, role: r.role, content: r.content, state: r.state, source: r.source, metadata: parseJson(r.metadata, null), actionsAr: parseJson(r.metadata, {})?.actionsAr ?? [], createdAt: r.created_at, updatedAt: r.updated_at });
const attachment = (r) => r && ({ id: r.id, conversationId: r.conversation_id, messageId: r.message_id, filename: r.filename, mime: r.mime, sizeBytes: r.size_bytes, readableByAgent: r.extracted_text != null, createdAt: r.created_at });
const TEXT_EXTENSIONS = new Set(["txt", "md", "js", "mjs", "ts", "json", "py", "css", "html", "gd", "sql"]);
const BINARY_MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
function decodeAttachment(input) {
  const filename = clean(input.filename, 120, "اسم الملف");
  if (/[\\/]/.test(filename) || filename.startsWith(".")) fail(422, "filename-invalid", "اسم الملف غير مسموح");
  const ext = filename.split(".").at(-1)?.toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext) && !BINARY_MIME[ext]) fail(415, "attachment-type", "نوع الملف غير مدعوم");
  const mime = BINARY_MIME[ext] || (ext === "md" ? "text/markdown" : "text/plain");
  if (typeof input.data !== "string" || input.data.length > 1_400_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) fail(422, "attachment-data", "بيانات الملف غير صالحة");
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length || bytes.length > 1_048_576 || bytes.toString("base64") !== input.data) fail(413, "attachment-size", "الحد الأقصى للملف 1 ميغابايت");
  if (BINARY_MIME[ext]) {
    const valid = ext === "pdf" ? bytes.subarray(0, 5).toString("ascii") === "%PDF-"
      : ext === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : ext === "webp" ? bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!valid) fail(415, "attachment-mime", "محتوى الملف لا يطابق نوعه");
    return { filename, mime, bytes, extractedText: null };
  }
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (_) { fail(415, "attachment-text", "الملف النصي ليس UTF-8 صالحًا"); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) fail(415, "attachment-text", "الملف النصي يحوي بيانات غير نصية");
  if (/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{16,})/.test(content)) fail(422, "secret-rejected", "الملف يبدو أنه يحوي مفتاحًا سريًا");
  return { filename, mime, bytes, extractedText: content.slice(0, 8000) };
}

export function createConversations({ company, runtime, learning = null }) {
  const { db } = company;
  // V6: Dynamic agent validation helper
  const isActiveAgent = (id) => db.get("SELECT 1 FROM agents WHERE id = ? AND active = 1", id) != null;

  function get(id, { includeDeleted = false } = {}) {
    const found = db.get("SELECT * FROM conversations WHERE id = ?", String(id));
    if (!found || (!includeDeleted && found.state === "deleted")) fail(404, "not-found", "المحادثة غير موجودة");
    return row(found);
  }
  function list({ agentId = null, projectId = null, state = "active", limit = 50, before = null, q = null } = {}) {
    if (agentId && !db.get("SELECT id FROM agents WHERE id = ?", agentId)) fail(422, "validation", "الوكيل غير معروف أو معطل");
    if (!["active", "archived"].includes(state)) fail(422, "validation", "حالة المحادثة غير صالحة");
    const where = ["state = ?"], params = [state];
    if (agentId) { where.push("agent_id = ?"); params.push(agentId); }
    if (projectId) { where.push("project_id = ?"); params.push(projectId); }
    if (q) {
      const needle = clean(q, 120, "البحث").replace(/[\\%_]/g, "\\$&");
      where.push("(title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = conversations.id AND m.content LIKE ? ESCAPE '\\'))");
      params.push(`%${needle}%`, `%${needle}%`);
    }
    if (before) { where.push("updated_at < ?"); params.push(before); }
    return db.all(`SELECT * FROM conversations WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`, ...params, Math.min(Math.max(Number(limit) || 50, 1), 100)).map(row);
  }
  function create(input) {
    if (!isActiveAgent(input.agentId)) fail(422, "validation", "اختر وكيلًا معروفًا ومفعّلًا");
    if (!company.agentConfig(input.agentId).enabled) fail(409, "agent-disabled", "الوكيل معطّل");
    const projectId = input.projectId ? company.getProject(input.projectId).id : null;
    const task = input.taskId ? company.getTask(input.taskId) : null;
    if (task && projectId && task.projectId !== projectId) fail(409, "task-project-mismatch", "المهمة لا تنتمي إلى المشروع المختار");
    const taskId = task?.id ?? null;
    const title = input.title == null ? "محادثة جديدة" : clean(input.title, 160, "العنوان");
    const id = newId("conv"), at = nowIso();
    db.tx(() => {
      db.run("INSERT INTO conversations (id,agent_id,project_id,task_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", id, input.agentId, projectId, taskId, title, "active", at, at);
      company.log({ action: "conversation.created", targetType: "conversation", targetId: id, summary: `إنشاء محادثة مع ${input.agentId.toUpperCase()}` });
    });
    return get(id);
  }
  function update(id, patch) {
    const current = get(id);
    const active = db.get("SELECT id FROM agent_runs WHERE conversation_id = ? AND status IN ('queued','running') LIMIT 1", id);
    if (active && (patch.state === "deleted" || patch.projectId !== undefined || patch.taskId !== undefined)) fail(409, "conversation-busy", "انتظر انتهاء تشغيل المحادثة قبل تغييرها");
    if ((patch.projectId !== undefined || patch.taskId !== undefined) && db.get("SELECT id FROM conversation_messages WHERE conversation_id = ? LIMIT 1", id)) fail(409, "conversation-project-locked", "لا يمكن تغيير سياق محادثة بها رسائل؛ ابدأ محادثة جديدة");
    const fields = [], params = [];
    if (patch.title !== undefined) { fields.push("title = ?"); params.push(clean(patch.title, 160, "العنوان")); }
    if (patch.state !== undefined) {
      if (!["active", "archived", "deleted"].includes(patch.state)) fail(422, "validation", "حالة المحادثة غير صالحة");
      fields.push("state = ?"); params.push(patch.state);
    }
    if (patch.projectId !== undefined) { fields.push("project_id = ?"); params.push(patch.projectId ? company.getProject(patch.projectId).id : null); }
    if (patch.taskId !== undefined) { fields.push("task_id = ?"); params.push(patch.taskId ? company.getTask(patch.taskId).id : null); }
    if (!fields.length) return current;
    db.tx(() => {
      db.run(`UPDATE conversations SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
      company.log({ action: "conversation.updated", targetType: "conversation", targetId: id, summary: `تحديث محادثة ${current.title}` });
    });
    return patch.state === "deleted" ? { ...current, state: "deleted" } : get(id);
  }
  function messages(id, { before = null, limit = 50 } = {}) {
    get(id);
    const cursor = before ? db.get("SELECT rowid FROM conversation_messages WHERE id = ? AND conversation_id = ?", before, id)?.rowid : null;
    if (before && !cursor) fail(422, "validation", "مؤشر الرسائل غير صالح");
    const results = db.all(`SELECT * FROM conversation_messages WHERE conversation_id = ? ${cursor ? "AND rowid < ?" : ""} ORDER BY rowid DESC LIMIT ?`, id, ...(cursor ? [cursor] : []), Math.min(Math.max(Number(limit) || 50, 1), 100)).reverse().map(message);
    const byMessage = new Map();
    for (const file of db.all("SELECT id,conversation_id,message_id,filename,mime,size_bytes,extracted_text,created_at FROM conversation_attachments WHERE conversation_id = ? AND message_id IS NOT NULL", id)) {
      byMessage.set(file.message_id, [...(byMessage.get(file.message_id) || []), attachment(file)]);
    }
    return results.map((entry) => ({ ...entry, attachments: byMessage.get(entry.id) || [] }));
  }
  function upload(id, input) {
    const thread = get(id);
    if (thread.state !== "active") fail(409, "conversation-archived", "أعد تفعيل المحادثة أولًا");
    if (db.get("SELECT COUNT(*) AS n FROM conversation_attachments WHERE conversation_id = ?", id).n >= 50) fail(409, "attachment-limit", "بلغت المحادثة حد المرفقات");
    const file = decodeAttachment(input);
    const recordId = newId("att");
    db.run("INSERT INTO conversation_attachments (id,conversation_id,message_id,filename,mime,size_bytes,data,extracted_text,created_at) VALUES (?,?,?,?,?,?,?,?,?)", recordId, id, null, file.filename, file.mime, file.bytes.length, file.bytes, file.extractedText, nowIso());
    return attachment(db.get("SELECT * FROM conversation_attachments WHERE id = ?", recordId));
  }
  function getAttachment(id, attachmentId) {
    get(id);
    const file = db.get("SELECT * FROM conversation_attachments WHERE id = ? AND conversation_id = ?", attachmentId, id);
    if (!file) fail(404, "not-found", "المرفق غير موجود");
    return file;
  }
  function attachments(id, { pendingOnly = false } = {}) {
    get(id);
    return db.all(`SELECT id,conversation_id,message_id,filename,mime,size_bytes,extracted_text,created_at FROM conversation_attachments WHERE conversation_id = ? ${pendingOnly ? "AND message_id IS NULL" : ""} ORDER BY created_at DESC LIMIT 50`, id).map(attachment);
  }
  function removeAttachment(id, attachmentId) {
    const file = getAttachment(id, attachmentId);
    db.run("DELETE FROM conversation_attachments WHERE id = ?", file.id);
    return { removed: true, id: file.id };
  }
  function send(id, input) {
    const conversation = get(id);
    if (conversation.state !== "active") fail(409, "conversation-archived", "أعد تفعيل المحادثة قبل الإرسال");
    const content = clean(input.content, 4000, "الرسالة");
    const key = typeof input.idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(input.idempotencyKey) ? input.idempotencyKey : null;
    if (key) {
      const existing = db.get("SELECT id, conversation_id FROM agent_runs WHERE idempotency_key = ?", key);
      if (existing) {
        if (existing.conversation_id !== id) fail(409, "idempotency-conflict", "مفتاح الطلب مستخدم لمحادثة أخرى");
        return { run: company.getRun(existing.id), messages: messages(id).filter((m) => m.runId === existing.id), deduplicated: true };
      }
    }
    if (db.get("SELECT id FROM agent_runs WHERE conversation_id = ? AND status IN ('queued','running') LIMIT 1", id)) fail(409, "conversation-busy", "انتظر رد الوكيل الحالي أو ألغِ التشغيل قبل إرسال رسالة أخرى");
    const attachmentIds = Array.isArray(input.attachmentIds) ? [...new Set(input.attachmentIds)] : [];
    if (attachmentIds.length > 3 || attachmentIds.some((value) => typeof value !== "string")) fail(422, "attachment-limit", "حد الرسالة ثلاثة مرفقات");
    for (const attachmentId of attachmentIds) {
      const file = getAttachment(id, attachmentId);
      if (file.message_id) fail(409, "attachment-used", "المرفق مستخدم في رسالة سابقة");
    }
    return db.tx(() => {
      const run = runtime.enqueue({ agentId: conversation.agentId, projectId: conversation.projectId, taskId: conversation.taskId, conversationId: id, capability: "chat", request: content, priority: "medium", idempotencyKey: key }, { type: "owner", id: "conversation" });
      const at = nowIso();
      const ownerMessageId = newId("msg");
      db.run("INSERT INTO conversation_messages (id,conversation_id,run_id,role,content,state,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", ownerMessageId, id, run.id, "owner", content, "complete", "owner", at, at);
      for (const attachmentId of attachmentIds) db.run("UPDATE conversation_attachments SET message_id = ? WHERE id = ?", ownerMessageId, attachmentId);
      db.run("INSERT INTO conversation_messages (id,conversation_id,run_id,role,content,state,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", newId("msg"), id, run.id, "assistant", "", "pending", `agent:${conversation.agentId}`, at, at);
      const title = conversation.title === "محادثة جديدة" ? content.slice(0, 100) : conversation.title;
      db.run("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", title, at, id);
      const learningEngine = learning || runtime?.learning;
      if (learningEngine?.onOwnerMessage) {
        try {
          learningEngine.onOwnerMessage({
            conversationId: id,
            messageId: ownerMessageId,
            agentId: conversation.agentId,
            projectId: conversation.projectId,
            content
          });
        } catch (_) {
          /* non-blocking learning hook */
        }
      }
      return { run, conversation: get(id) };
    });
  }
  /** Recent turns that fit the token budget, plus a verified extractive summary of the older turns. Nothing is
   * deleted or rewritten: the summary is derived from the stored messages, keyed to the last message it covers and a
   * SHA-256 digest of those messages, and rebuilt whenever they no longer match. No model is involved. */
  function buildContext(id, currentRunId) {
    const budget = company.settings().conversationContextTokens;
    const rows = db.all("SELECT rowid, id, role, content FROM conversation_messages WHERE conversation_id = ? AND run_id IS NOT ? AND state = 'complete' AND role IN ('owner','assistant') ORDER BY rowid DESC LIMIT 400", id, currentRunId ?? "");
    const recent = [];
    let used = 0;
    for (const entry of rows) {
      const cost = estimateTokens(entry.content);
      if (recent.length >= 2 && used + cost > budget * 0.75) break;
      used += cost;
      recent.push(entry);
      if (recent.length >= 40) break;
    }
    const older = rows.slice(recent.length).reverse();
    let summary = null;
    if (older.length) {
      const digest = createHash("sha256").update(older.map((m) => `${m.id}\u0001${m.content}`).join("\u0002")).digest("hex");
      const stored = db.get("SELECT * FROM conversation_summaries WHERE conversation_id = ?", id);
      const agentName = get(id).agentId.toUpperCase();
      if (stored && stored.upto_rowid === older.at(-1).rowid && stored.digest === digest) summary = { text: stored.text, covered: stored.covered, verified: true, reused: true };
      else {
        // Most recent first, one bounded line per turn, until a quarter of the budget is used.
        const lines = [];
        let cost = 0;
        for (const m of [...older].reverse()) {
          const first = m.content.replace(/\s+/g, " ").trim();
          const line = `- ${m.role === "owner" ? "المالك" : agentName}: ${first.length > 160 ? `${first.slice(0, 159)}…` : first}`;
          cost += estimateTokens(line);
          if (cost > budget * 0.25) break;
          lines.unshift(line);
        }
        const text = `ملخص مستخرج حرفيًا من ${older.length} رسالة أقدم${lines.length < older.length ? ` (يظهر آخر ${lines.length} منها)` : ""}:\n${lines.join("\n")}`.slice(0, 12000);
        db.run("INSERT INTO conversation_summaries (conversation_id, upto_rowid, covered, digest, text, method, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET upto_rowid = excluded.upto_rowid, covered = excluded.covered, digest = excluded.digest, text = excluded.text, method = excluded.method, created_at = excluded.created_at",
          id, older.at(-1).rowid, older.length, digest, text, "extractive-v1", nowIso());
        summary = { text, covered: older.length, verified: true, reused: false };
      }
      used += estimateTokens(summary.text);
    }
    return { recent: recent.reverse(), summary, estimatedTokens: used, budget };
  }
  function context(id, currentRunId) {
    const conversation = get(id);
    const built = buildContext(id, currentRunId);
    const bounded = built.recent.map((entry) => ({ role: entry.role === "owner" ? "user" : "assistant", content: entry.content }));
    if (built.summary) bounded.unshift({ role: "user", content: `[سياق سابق — ${built.summary.text}\nالرسائل الأصلية محفوظة كاملة؛ هذا ملخص آلي محدود وليس طلبًا جديدًا.]` }, { role: "assistant", content: "تم استيعاب السياق السابق." });
    const files = db.all("SELECT filename,mime,extracted_text FROM conversation_attachments WHERE message_id = (SELECT id FROM conversation_messages WHERE run_id = ? AND role = 'owner') ORDER BY created_at LIMIT 3", currentRunId);
    let fileChars = 0;
    const attachments = files.map((file) => {
      if (file.extracted_text == null) return { filename: file.filename, mime: file.mime, note: "Stored for owner; this text-only model cannot inspect the binary file." };
      const excerpt = file.extracted_text.slice(0, Math.max(0, 6000 - fileChars)); fileChars += excerpt.length;
      return { filename: file.filename, mime: file.mime, excerpt };
    });
    return { conversation, messages: bounded, attachments, summary: built.summary ? { covered: built.summary.covered, verified: true } : null, estimatedTokens: built.estimatedTokens };
  }
  /** What the next reply would see: recent turn count, summarized turn count and the token estimate (read-only). */
  function contextPreview(id) {
    get(id);
    const built = buildContext(id, null);
    return { recentMessages: built.recent.length, summarizedMessages: built.summary?.covered ?? 0, estimatedTokens: built.estimatedTokens, budgetTokens: built.budget, estimate: "approximate (chars per token by script)" };
  }
  /** Full transcript for the owner: Markdown or JSON with attachment metadata (files stay individually downloadable). */
  function exportThread(id, format = "md") {
    const thread = get(id, { includeDeleted: false });
    const all = db.all("SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY rowid", id).map(message);
    const files = db.all("SELECT id,message_id,filename,mime,size_bytes,created_at FROM conversation_attachments WHERE conversation_id = ? ORDER BY created_at", id);
    const name = thread.agentId.toUpperCase();
    if (format === "json") return { mime: "application/json", filename: `conversation-${id}.json`, body: JSON.stringify({ conversation: thread, messages: all, attachments: files.map((f) => ({ id: f.id, messageId: f.message_id, filename: f.filename, mime: f.mime, sizeBytes: f.size_bytes, createdAt: f.created_at })), exportedAt: nowIso() }, null, 2) };
    const lines = [`# ${thread.title}`, "", `- الوكيل: ${name}`, `- أُنشئت: ${thread.createdAt}`, `- صُدّرت: ${nowIso()}`, ""];
    for (const m of all) {
      if (m.role === "event") { lines.push(`> ${m.createdAt} · ${m.content}`, ""); continue; }
      if (m.role === "tool") { lines.push(`<details><summary>نتيجة أداة · ${m.source}</summary>`, "", "```json", m.content, "```", "</details>", ""); continue; }
      lines.push(`## ${m.role === "owner" ? "المالك" : name} · ${m.createdAt}${m.state !== "complete" ? ` (${m.state})` : ""}`, "", m.content || "—", "");
      for (const f of files.filter((x) => x.message_id === m.id)) lines.push(`- مرفق: ${f.filename} (${f.mime}, ${f.size_bytes} بايت)`);
    }
    return { mime: "text/markdown; charset=utf-8", filename: `conversation-${id}.md`, body: lines.join("\n") };
  }
  /** Retention: attachment files of deleted conversations are removed after the owner's retention period (0 = keep).
   * Messages remain; the removal is logged. Active and archived threads are never purged automatically. */
  function purgeAttachments(now = Date.now()) {
    const days = company.settings().attachmentRetentionDays;
    if (!days) return { removed: 0, retentionDays: 0 };
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    const victims = db.all("SELECT a.id FROM conversation_attachments a JOIN conversations c ON c.id = a.conversation_id WHERE c.state = 'deleted' AND c.updated_at < ? LIMIT 500", cutoff);
    if (victims.length) db.tx(() => {
      for (const v of victims) db.run("DELETE FROM conversation_attachments WHERE id = ?", v.id);
      company.log({ actorType: "system", actorId: "retention", action: "attachments.purged", targetType: "conversation", targetId: "retention", outcome: "info", summary: `حُذفت ${victims.length} مرفقات لمحادثات محذوفة منذ أكثر من ${days} يومًا` });
    });
    return { removed: victims.length, retentionDays: days };
  }
  function settle(runId, state, content = "") {
    const mapped = { succeeded: "complete", failed: "failed", blocked: "blocked", cancelled: "cancelled" }[state];
    if (!mapped) return;
    db.run("UPDATE conversation_messages SET state = ?, content = ?, updated_at = ? WHERE run_id = ? AND role = 'assistant'", mapped, String(content).slice(0, 30000), nowIso(), runId);
    const run = db.get("SELECT conversation_id, actions_ar FROM agent_runs WHERE id = ?", runId);
    db.run("UPDATE conversation_messages SET metadata = ? WHERE run_id = ? AND role = 'assistant'", JSON.stringify({ actionsAr: parseJson(run?.actions_ar, []) }), runId);
    if (run?.conversation_id) {
      const at = nowIso();
      db.run("INSERT INTO conversation_messages (id,conversation_id,run_id,role,content,state,source,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", newId("msg"), run.conversation_id, runId, "event", { succeeded: "اكتمل الرد", failed: "فشل الرد", blocked: "الرد ينتظر موافقة أو تعذر تنفيذه", cancelled: "أُلغي الرد" }[state], "complete", "runtime", JSON.stringify({ event: `run.${state}` }), at, at);
    }
  }
  function recordTools(runId, results) {
    const run = db.get("SELECT conversation_id FROM agent_runs WHERE id = ?", runId);
    if (!run?.conversation_id) return;
    for (const [toolId, output] of Object.entries(results).slice(0, 8)) {
      const at = nowIso();
      db.run("INSERT INTO conversation_messages (id,conversation_id,run_id,role,content,state,source,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", newId("msg"), run.conversation_id, runId, "tool", redact(JSON.stringify(output), 4000), "complete", toolId, JSON.stringify({ toolId, observedAt: at, trustedAsInstructions: false }), at, at);
    }
  }
  function reopen(runId) { db.run("UPDATE conversation_messages SET state = 'pending', content = '', updated_at = ? WHERE run_id = ? AND role = 'assistant'", nowIso(), runId); }
  return { create, get, list, update, messages, attachments, upload, getAttachment, removeAttachment, send, context, contextPreview, exportThread, purgeAttachments, settle, recordTools, reopen };
}
