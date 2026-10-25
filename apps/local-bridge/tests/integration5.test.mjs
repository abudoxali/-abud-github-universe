/* V5 Checkpoint 5 fixes for inherited limitations: token-budgeted conversation context with a hash-verified extractive
 * summary (originals kept), transcript export, attachment retention, and owner-only memory conflict resolution. */
import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.mjs";
import { createCompany } from "../src/company.mjs";
import { createConversations, estimateTokens } from "../src/conversations.mjs";

function setup() {
  const company = createCompany({ db: openDatabase(":memory:") });
  company.seed();
  let n = 0;
  const runtime = { enqueue: () => { const id = `run_${String(++n).padStart(4, "0")}`; company.db.run("INSERT INTO agent_runs (id, agent_id, capability, domain, mode, priority, request, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)", id, "luna", "chat", "admin", "standard", "medium", "x", "queued", new Date().toISOString()); return company.getRun(id); } };
  const conversations = createConversations({ company, runtime });
  return { company, conversations };
}
/** Adds one completed owner/assistant turn directly (the runtime is not needed for context tests). */
function turn(company, conversations, thread, owner, reply) {
  const sent = conversations.send(thread.id, { content: owner });
  company.db.run("UPDATE agent_runs SET status = 'succeeded' WHERE id = ?", sent.run.id);
  conversations.settle(sent.run.id, "succeeded", reply);
  return sent.run.id;
}

test("token estimate distinguishes scripts", () => {
  assert.ok(estimateTokens("مرحبا بك في شركة ABUD") > 0);
  assert.ok(estimateTokens("a".repeat(400)) === 100);
  assert.ok(estimateTokens("ب".repeat(250)) === 100);
});

test("context stays within the token budget and summarizes older turns with a verified, reusable digest", () => {
  const { company, conversations } = setup();
  company.updateSettings({ conversationContextTokens: 1000 });
  const thread = conversations.create({ agentId: "luna" });
  for (let i = 1; i <= 30; i++) turn(company, conversations, thread, `سؤال رقم ${i}: ${"تفاصيل إضافية ".repeat(12)}`, `إجابة رقم ${i}: ${"شرح مطول ".repeat(12)}`);
  const preview = conversations.contextPreview(thread.id);
  assert.ok(preview.estimatedTokens <= 1000 * 1.05, `estimate ${preview.estimatedTokens}`);
  assert.ok(preview.summarizedMessages > 0 && preview.recentMessages > 0);
  assert.equal(preview.recentMessages + preview.summarizedMessages, 60);
  const stored = company.db.get("SELECT * FROM conversation_summaries WHERE conversation_id = ?", thread.id);
  assert.equal(stored.covered, preview.summarizedMessages);
  assert.equal(company.db.get("SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ? AND role IN ('owner','assistant')", thread.id).n, 60, "original messages are never removed");
  // a new turn moves the boundary; an edited old message invalidates the digest
  const run = turn(company, conversations, thread, "سؤال جديد", "إجابة جديدة");
  const ctx = conversations.context(thread.id, "run_none");
  assert.match(ctx.messages[0].content, /ملخص مستخرج حرفيًا/);
  assert.equal(ctx.summary.verified, true);
  const before = company.db.get("SELECT digest FROM conversation_summaries WHERE conversation_id = ?", thread.id).digest;
  company.db.run("UPDATE conversation_messages SET content = 'سؤال رقم 1 (معدل)' WHERE conversation_id = ? AND rowid = (SELECT MIN(rowid) FROM conversation_messages WHERE conversation_id = ?)", thread.id, thread.id);
  conversations.contextPreview(thread.id);
  assert.notEqual(company.db.get("SELECT digest FROM conversation_summaries WHERE conversation_id = ?", thread.id).digest, before, "a changed source message rebuilds the summary");
  assert.ok(run);
});

test("export returns the full transcript; retention purges only files of long-deleted conversations", () => {
  const { company, conversations } = setup();
  const thread = conversations.create({ agentId: "luna", title: "متابعة الإصدار" });
  const file = conversations.upload(thread.id, { filename: "notes.md", data: Buffer.from("# ملاحظات\nبند 1").toString("base64") });
  const sent = conversations.send(thread.id, { content: "راجع الملاحظات", attachmentIds: [file.id] });
  company.db.run("UPDATE agent_runs SET status = 'succeeded' WHERE id = ?", sent.run.id);
  conversations.settle(sent.run.id, "succeeded", "تمت المراجعة");
  const md = conversations.exportThread(thread.id, "md");
  assert.match(md.body, /# متابعة الإصدار/);
  assert.match(md.body, /راجع الملاحظات/);
  assert.match(md.body, /مرفق: notes\.md/);
  const json = JSON.parse(conversations.exportThread(thread.id, "json").body);
  assert.equal(json.attachments.length, 1);
  assert.equal(json.attachments[0].data, undefined, "file contents are not embedded in the export");
  // retention off: nothing removed
  assert.equal(conversations.purgeAttachments().removed, 0);
  company.updateSettings({ attachmentRetentionDays: 30 });
  const keep = conversations.create({ agentId: "luna" });
  conversations.upload(keep.id, { filename: "keep.txt", data: Buffer.from("keep").toString("base64") });
  conversations.update(thread.id, { state: "deleted" });
  company.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", new Date(Date.now() - 40 * 86_400_000).toISOString(), thread.id);
  const result = conversations.purgeAttachments();
  assert.equal(result.removed, 1);
  assert.equal(company.db.get("SELECT COUNT(*) AS n FROM conversation_attachments WHERE conversation_id = ?", keep.id).n, 1, "active conversations keep their files");
  assert.equal(company.db.get("SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?", thread.id).n >= 2, true, "messages remain");
});

test("memory conflicts keep both notes and provenance; only the owner resolves them", () => {
  const { company } = setup();
  company.upsertMemory({ scope: "company", title: "موعد الإطلاق", body: "الإطلاق في نوفمبر", sourceRef: "اجتماع 10/1" });
  const original = company.listMemory({ scope: "company" })[0];
  // an agent proposes conflicting content: it stays pending and flagged; the owner's note is untouched
  company.upsertMemory({ scope: "company", title: "موعد الإطلاق!", body: "الإطلاق في ديسمبر" }, { type: "agent", id: "ori" });
  const conflicts = company.memoryConflicts();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].other.id, original.id);
  assert.equal(conflicts[0].note.approved, false);
  assert.equal(company.listMemory({ scope: "company", state: "active" }).find((n) => n.id === original.id).body, "الإطلاق في نوفمبر");
  assert.throws(() => company.resolveMemoryConflict(conflicts[0].note.id, "kept-new", { type: "agent", id: "ori" }), (e) => e.code === "owner-only");
  const resolved = company.resolveMemoryConflict(conflicts[0].note.id, "kept-new");
  assert.equal(resolved.note.approved, true);
  assert.equal(resolved.other.state, "archived");
  assert.equal(resolved.other.supersededBy, resolved.note.id);
  assert.equal(resolved.other.sourceRef, "اجتماع 10/1", "provenance of the superseded note is kept");
  assert.equal(company.memoryConflicts().length, 0);
  assert.ok(company.activity({ limit: 20 }).some((e) => e.action === "memory.conflict.resolved"));
  // identical content is not a conflict
  company.upsertMemory({ scope: "company", title: "قاعدة الرد", body: "الرد خلال يوم" });
  company.upsertMemory({ scope: "company", title: "قاعدة الرد", body: "الرد خلال يوم" });
  assert.equal(company.memoryConflicts().length, 0);
});
