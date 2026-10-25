import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.mjs";
import { createCompany } from "../src/company.mjs";
import { createKnowledge } from "../src/knowledge.mjs";

test("approved text knowledge indexes locally, deduplicates, scopes retrieval and deletes derived terms", () => {
  const company = createCompany({ db: openDatabase(":memory:") }); company.seed();
  const knowledge = createKnowledge({ company });
  const alpha = company.createProject({ name: "Alpha", github: "owner/alpha" });
  const beta = company.createProject({ name: "Beta", github: "owner/beta" });
  const one = knowledge.ingestOwner({ projectId: alpha.id, title: "قرار الإصدار", content: "نؤجل إصدار ألفا حتى ينجح اختبار الهاتف الحقيقي." });
  assert.equal(knowledge.ingestOwner({ projectId: alpha.id, title: "نسخة أخرى", content: "نؤجل إصدار ألفا حتى ينجح اختبار الهاتف الحقيقي." }).unchanged, true);
  knowledge.ingestOwner({ projectId: beta.id, title: "قرار آخر", content: "نؤجل إصدار بيتا حتى تنتهي مراجعة الأداء." });
  assert.equal(knowledge.search({ q: "إصدار ألفا", projectId: alpha.id, forAgent: true }).length, 1);
  assert.equal(knowledge.search({ q: "إصدار بيتا", projectId: alpha.id, forAgent: true }).length, 0, "another project's text is not retrieved");
  assert.match(knowledge.preview(one.id).chunks[0].content, /الهاتف الحقيقي/);
  knowledge.remove(one.id);
  assert.equal(knowledge.search({ q: "الهاتف الحقيقي", projectId: alpha.id, forAgent: true }).length, 0);
  knowledge.reindex();
  assert.equal(knowledge.search({ q: "الهاتف الحقيقي", projectId: alpha.id, forAgent: true }).length, 0);
  assert.equal(company.db.raw.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(company.db.raw.prepare("PRAGMA foreign_key_check").all().length, 0);
  company.db.close();
});

test("knowledge rejects secrets and only accepts approved project document identities", () => {
  const company = createCompany({ db: openDatabase(":memory:") }); company.seed();
  const knowledge = createKnowledge({ company });
  const project = company.createProject({ name: "Alpha", github: "owner/alpha" });
  assert.throws(() => knowledge.ingestOwner({ title: "secret", content: "-----BEGIN RSA PRIVATE KEY----- sample" }), { code: "secret-rejected" });
  assert.throws(() => knowledge.ingestProject(project.id, { rel: "Alpha", doc: "../../secret", excerpt: "x" }), { code: "knowledge-source" });
  const imported = knowledge.ingestProject(project.id, { rel: "Alpha", doc: "STATUS.md", excerpt: "Local test project is ready for review.", bytes: 45, truncated: false });
  assert.equal(imported.sourceType, "project-doc");
  assert.equal(imported.sourceRef, "Alpha:STATUS.md");
  assert.equal(knowledge.ingestProject(project.id, { rel: "Alpha", doc: "STATUS.md", excerpt: "Local test project is ready for review.", bytes: 45 }).unchanged, true);
  company.db.close();
});

test("project documents import from checkouts whose names contain spaces; unsafe references are still refused", () => {
  const company = createCompany({ db: openDatabase(":memory:") }); company.seed();
  const knowledge = createKnowledge({ company });
  const project = company.createProject({ name: "Company OS", github: "owner/company-os" });
  const doc = { rel: "ABUD FUN Company OS", doc: "README.md", excerpt: "# Company OS\nنظام تشغيل الشركة.", bytes: 40, truncated: false };
  assert.equal(knowledge.ingestProject(project.id, doc).sourceRef, "ABUD FUN Company OS:README.md");
  for (const rel of [" leading", "trailing ", "/abs/path", "a/../b", "C:\\Users\\x","x".repeat(121)]) {
    assert.throws(() => knowledge.ingestProject(project.id, { ...doc, rel }), /knowledge-source/);
  }
});
