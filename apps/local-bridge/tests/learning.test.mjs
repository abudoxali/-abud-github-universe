/* Cognitive Memory & Learning Engine tests (V6 Checkpoint 2)
 * Tests Scenarios B and C, proposal lifecycle, outcome learning,
 * memoryContext hierarchical retrieval, usage tracking, dashboard counts,
 * owner-only approval guards, and schema 11 -> 14 migration. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, openDatabase, nowIso, newId } from "../src/db.mjs";
import { createCompany, HttpError } from "../src/company.mjs";
import { createRegistry } from "../src/registry.mjs";
import { createLearning, detectCorrection } from "../src/learning.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { createConversations } from "../src/conversations.mjs";
import { selectTools } from "../src/tool-selector.mjs";
import { createServer } from "../src/server.mjs";

describe("V6 Cognitive Memory & Learning Engine", () => {
  const tempDb = () => openDatabase(":memory:");

  function createEnv() {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });
    registry.seedBuiltinProfiles();
    const runtime = createRuntime({
      company,
      routerClient: { config: {}, patchSettings: async () => ({ ok: true }) },
      getOverview: async () => ({ connection: { state: "connected" }, connections: [] }),
      getUsage: async () => ({}),
      workspace: { scan: async () => ({ repos: [] }), paths: () => new Map() }
    });
    const learning = createLearning({ company, runtime, db });
    runtime.setLearning(learning);
    const conversations = createConversations({ company, runtime, learning });
    runtime.setConversations(conversations);
    return { db, company, registry, runtime, learning, conversations };
  }

  it("detects Arabic (Egyptian & MSA) and English correction cues", () => {
    // Egyptian Arabic cues
    assert.equal(detectCorrection("لا مش كده خالص").isCorrection, true);
    assert.equal(detectCorrection("بلاش ألوان فاقعة").isCorrection, true);
    assert.equal(detectCorrection("متستخدمش الأداة دي").isCorrection, true);
    assert.equal(detectCorrection("متستخدمش الأداة دي").isExplicit, true);
    assert.equal(detectCorrection("مش عايز كود طويل").isCorrection, true);

    // Explicit Arabic imperatives
    assert.equal(detectCorrection("من دلوقتي استعمل التصميم الهادئ").isExplicit, true);
    assert.equal(detectCorrection("دايمًا ركز على الأداء").isExplicit, true);
    assert.equal(detectCorrection("من الآن فصاعدًا اعتمد هذا").isExplicit, true);

    // English cues
    assert.equal(detectCorrection("always write clean code").isCorrection, true);
    assert.equal(detectCorrection("always write clean code").isExplicit, true);
    assert.equal(detectCorrection("never use eval").isExplicit, true);
    assert.equal(detectCorrection("don't use inline styles").isExplicit, true);
    assert.equal(detectCorrection("prefer functional style").isCorrection, true);
    assert.equal(detectCorrection("stop using this library").isCorrection, true);
    assert.equal(detectCorrection("avoid global variables").isCorrection, true);

    // Non-correction text
    assert.equal(detectCorrection("مرحبا كيف حالك اليوم").isCorrection, false);
    assert.equal(detectCorrection("please create a new report").isCorrection, false);
  });

  it("Scenario B: MIA design correction auto-promotes, supersedes old, and retrieves first", () => {
    const { company, runtime, learning, conversations } = createEnv();
    const owner = { type: "owner", id: "owner" };

    // 1. Seed an initial active owner preference note for MIA
    const initialNotes = company.upsertMemory({
      scope: "owner",
      scopeRef: "mia",
      title: "تفضيل سابق: ألوان نيون فاقعة",
      body: "استخدم ألوان نيون قوية في كل التصاميم",
      kind: "preference",
      confidence: "verified",
      approved: true
    }, owner);
    const initialNoteId = initialNotes[0].id;

    // Verify initial note is active
    let notes = company.listMemory({ scope: "owner", scopeRef: "mia" });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].id, initialNoteId);
    assert.equal(notes[0].state, "active");

    // 2. Create conversation with MIA
    const conv = conversations.create({ agentId: "mia", title: "تصميم الواجهة" });

    // 3. Owner sends explicit correction in Egyptian Arabic: "من دلوقتي بلاش ألوان نيون، خليك دايمًا في الهادئ"
    conversations.send(conv.id, {
      content: "من دلوقتي بلاش ألوان نيون، خليك دايمًا في الهادئ"
    });

    // 4. Verify learning engine auto-promoted the new preference
    const proposals = learning.listProposals({ agentId: "mia" });
    assert.equal(proposals.length, 1);
    const proposal = proposals[0];
    assert.equal(proposal.autoPromoted, true);
    assert.equal(proposal.status, "approved");
    assert.equal(proposal.proposedConfidence, "supported");
    assert.ok(proposal.resultingMemoryId);

    // 5. Verify the old note was archived and superseded
    const oldNote = company.listMemory({ scope: "owner", scopeRef: "mia", state: null }).find(n => n.id === initialNoteId);
    assert.equal(oldNote.state, "archived");
    assert.equal(oldNote.supersededBy, proposal.resultingMemoryId);

    // 6. Verify the new memory note is active with confidence 'supported'
    const newNote = company.listMemory({ scope: "owner", scopeRef: "mia", state: "active" })
      .find(n => n.id === proposal.resultingMemoryId);
    assert.ok(newNote);
    assert.equal(newNote.kind, "preference");
    assert.equal(newNote.confidence, "supported");
    assert.equal(newNote.scope, "owner");
    assert.equal(newNote.scopeRef, "mia");
    assert.equal(newNote.useCount, 0);

    // 7. Next MIA run calls memoryContext: must retrieve the new owner preference FIRST
    const context = runtime.memoryContext("mia", null, "تصميم شاشة جديدة");
    assert.ok(context.length >= 1);
    assert.equal(context[0].id, newNote.id);
    assert.equal(context[0].scope, "owner");
    assert.equal(context[0].kind, "preference");

    // 8. Verify batched usage tracking bumped useCount and lastUsedAt
    const updatedNote = company.listMemory({ scope: "owner", scopeRef: "mia", state: "active" })
      .find(n => n.id === newNote.id);
    assert.equal(updatedNote.useCount, 1);
    assert.ok(updatedNote.lastUsedAt);
  });

  it("Scenario B (English): English imperative correction auto-promotes and supersedes", () => {
    const { company, runtime, learning, conversations } = createEnv();
    const owner = { type: "owner", id: "owner" };

    const conv = conversations.create({ agentId: "mia", title: "Design system" });
    conversations.send(conv.id, {
      content: "Always prefer minimal pastel colors and never use heavy drop shadows"
    });

    const proposals = learning.listProposals({ agentId: "mia" });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].autoPromoted, true);
    assert.equal(proposals[0].status, "approved");

    const context = runtime.memoryContext("mia", null, "card design");
    assert.equal(context[0].id, proposals[0].resultingMemoryId);
  });

  it("non-explicit correction creates a pending proposal without auto-promoting", () => {
    const { learning, conversations } = createEnv();

    const conv = conversations.create({ agentId: "mia", title: "محادثة استشارية" });
    conversations.send(conv.id, {
      content: "لا مش كده، جرب لون تاني لو سمحت"
    });

    const proposals = learning.listProposals({ agentId: "mia" });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].autoPromoted, false);
    assert.equal(proposals[0].status, "pending");
  });

  it("Scenario C: REX security procedure -> skill draft -> evaluate -> activate -> tool selector -> rollback", () => {
    const { company, runtime, learning } = createEnv();
    const owner = { type: "owner", id: "owner" };
    const agentActor = { type: "agent", id: "rex" };

    // 1. Create a draft skill with invalid tool (Tier C tool and ungranted tool)
    const draftSkill = learning.createSkill({
      agentId: "rex",
      title: "Security inspection with dangerous tools",
      steps: [
        { toolId: "vps.executeDangerous", description: "Tier C tool" },
        { toolId: "design.saveCanvas", description: "Not granted to REX" }
      ],
      applicability: ["security check", "فحص أمني", "فحص الثغرات"]
    }, owner);

    assert.equal(draftSkill.status, "draft");
    assert.equal(draftSkill.version, 1);

    // 2. Evaluate skill: must fail because tools are ungranted and Tier C
    const evalFail = learning.evaluateSkill(draftSkill.id);
    assert.equal(evalFail.ok, false);
    assert.equal(evalFail.passed, false);
    assert.ok(evalFail.errors.some(e => e.includes("tier-c-refused") || e.includes("C")));
    assert.ok(evalFail.errors.some(e => e.includes("tool-not-granted")));

    // 3. Attempting to activate unpassed skill must throw 422
    assert.throws(() => {
      learning.activateSkill(draftSkill.id, owner);
    }, (err) => err.status === 422 && err.code === "evaluation-required");

    // 4. Agent actor attempting to activate must throw 403
    assert.throws(() => {
      learning.activateSkill(draftSkill.id, agentActor);
    }, (err) => err.status === 403 && err.code === "owner-only");

    // 5. Owner updates skill with granted tools (REX has security.gitleaks)
    learning.updateSkill(draftSkill.id, {
      steps: [
        { toolId: "security.gitleaks", description: "Scan repository for leaked secrets" }
      ]
    }, owner);

    // 6. Evaluate again: must pass
    const evalPass = learning.evaluateSkill(draftSkill.id);
    assert.equal(evalPass.ok, true);
    assert.equal(evalPass.passed, true);
    assert.equal(evalPass.errors.length, 0);

    // 7. Owner activates the skill
    const activated = learning.activateSkill(draftSkill.id, owner);
    assert.equal(activated.status, "active");
    assert.equal(activated.approvedBy, "owner");
    assert.ok(activated.approvedAt);

    // 8. Tool selector preferences: matching request boosts security.gitleaks (+20)
    const rexConfig = company.agentConfig("rex");
    const rexDef = company.agentById("rex");
    const selection = selectTools({
      agent: { ...rexDef, ...rexConfig },
      grants: rexConfig.tools,
      request: "فحص أمني للثغرات وتسريب المفاتيح في المستودع",
      projectId: "proj-1",
      availability: { "security.gitleaks": true },
      skills: [activated]
    });

    const gitleaksTool = selection.selected.find(t => t.toolId === "security.gitleaks");
    assert.ok(gitleaksTool, "security.gitleaks should be selected");
    assert.ok(gitleaksTool.score >= 20, "tool should receive score boost from skill");
    assert.ok(gitleaksTool.reasonAr.includes(activated.title));

    // 9. Owner updates active skill: produces version 2 with rollback pointer
    const v2 = learning.updateSkill(activated.id, {
      title: "Security inspection v2",
      steps: [{ toolId: "security.gitleaks", description: "Scan with extra rules" }]
    }, owner);

    assert.equal(v2.version, 2);
    assert.equal(v2.rollbackTo, activated.id);
    assert.equal(v2.status, "draft");

    // Evaluate and activate v2
    learning.evaluateSkill(v2.id);
    learning.activateSkill(v2.id, owner);
    assert.equal(learning.getSkill(v2.id).status, "active");

    // 10. Agent attempting rollback throws 403
    assert.throws(() => {
      learning.rollbackSkill(v2.id, agentActor);
    }, (err) => err.status === 403 && err.code === "owner-only");

    // 11. Owner rolls back: v2 retired, v1 active
    const restored = learning.rollbackSkill(v2.id, owner);
    assert.equal(restored.id, activated.id);
    assert.equal(restored.status, "active");
    assert.equal(learning.getSkill(v2.id).status, "retired");
  });

  it("Outcome learning records structured procedure proposals and allows skill creation", () => {
    const { company, learning } = createEnv();
    const owner = { type: "owner", id: "owner" };
    const agentActor = { type: "agent", id: "rex" };

    const outcome = learning.recordOutcome({
      agentId: "rex",
      problem: "تسريب مفاتيح واجهات برمجة التطبيقات",
      resolution: "تشغيل فحص gitleaks وتأمين المستودع",
      verification: "فحص نظيف بدون تسريبات",
      evidence: ["run:123", "log:456"],
      applicability: ["تسريب مفاتيح", "فحص أمني"]
    });

    assert.ok(outcome.id);
    assert.equal(outcome.agentId, "rex");
    assert.equal(outcome.kind, "procedure");
    assert.equal(outcome.status, "pending");

    // Agent cannot approve
    assert.throws(() => {
      learning.approveProposal(outcome.id, {}, agentActor);
    }, (err) => err.status === 403 && err.code === "owner-only");

    // Owner approves -> creates verified procedural memory note
    const { proposal, memoryNote } = learning.approveProposal(outcome.id, {}, owner);
    assert.equal(proposal.status, "approved");
    assert.ok(memoryNote);
    assert.equal(memoryNote.kind, "procedural");
    assert.equal(memoryNote.confidence, "verified");

    // Create procedural skill from approved proposal
    const skill = learning.createSkillFromProposal(proposal.id, {
      steps: [{ toolId: "security.gitleaks", description: "Run automated gitleaks scanner" }]
    }, owner);
    assert.equal(skill.agentId, "rex");
    assert.equal(skill.createdFromProposal, proposal.id);
  });

  it("learning dashboard API returns real measurable counts only", () => {
    const { db, company, learning } = createEnv();
    const owner = { type: "owner", id: "owner" };

    // Insert 1 verified note
    company.upsertMemory({
      scope: "company",
      scopeRef: "",
      title: "معلومة موثقة",
      body: "ملاحظة موثقة للاختبار",
      kind: "fact",
      confidence: "verified",
      approved: true
    }, owner);

    // Insert 1 pending proposal
    learning.propose({
      agentId: "ori",
      kind: "new-fact",
      title: "مقترح حقيقة جديدة",
      body: "محتوى المقترح المعلق",
      scope: "company",
      scopeRef: ""
    }, { type: "agent", id: "ori" });

    // Insert 1 active skill
    const skill = learning.createSkill({
      agentId: "rex",
      title: "Active audit skill",
      steps: [{ toolId: "security.gitleaks" }],
      applicability: ["audit"]
    }, owner);
    learning.evaluateSkill(skill.id);
    learning.activateSkill(skill.id, owner);

    // Insert 2 failed tool executions with the same error code to test repeated failures
    const at = nowIso();
    db.run(
      `INSERT INTO tool_executions (id, tool_id, tool_version, agent_id, actor_type, actor_id, status, error_code, started_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      newId("tex"), "security.gitleaks", "1.0", "rex", "agent", "rex", "failed", "timeout", at
    );
    db.run(
      `INSERT INTO tool_executions (id, tool_id, tool_version, agent_id, actor_type, actor_id, status, error_code, started_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      newId("tex"), "security.gitleaks", "1.0", "rex", "agent", "rex", "failed", "timeout", at
    );

    const summary = learning.dashboardSummary();

    // Verify all keys are present and are exact numbers
    assert.equal(typeof summary.verifiedKnowledge7d, "number");
    assert.ok(summary.verifiedKnowledge7d >= 1);
    assert.equal(typeof summary.verifiedKnowledge30d, "number");
    assert.ok(summary.verifiedKnowledge30d >= 1);
    assert.equal(typeof summary.pendingProposals, "number");
    assert.ok(summary.pendingProposals >= 1);
    assert.equal(typeof summary.approvedSkills, "number");
    assert.ok(summary.approvedSkills >= 1);
    assert.equal(typeof summary.supersededNotes, "number");
    assert.equal(typeof summary.recentCorrections, "number");
    assert.equal(typeof summary.repeatedFailures, "number");
    assert.ok(summary.repeatedFailures >= 1);

    // Strict check: NO fabricated intelligence scores
    assert.equal(summary.intelligenceScore, undefined);
    assert.equal(summary.learningVelocity, undefined);
    assert.equal(summary.learningRate, undefined);
  });

  it("migrates a real schema 11 DB to schema 14 retaining all existing data and foreign keys", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys=ON");

    // Apply migrations up to 11
    for (const m of MIGRATIONS.filter(m => m.version <= 11)) {
      raw.exec("PRAGMA foreign_keys=OFF");
      raw.exec(m.sql);
      raw.exec("PRAGMA foreign_keys=ON");
    }

    const at = nowIso();
    // Seed an agent and a memory note in schema 11
    raw.prepare("INSERT INTO agents VALUES (?,?,?,?,?,?,?,?)").run("rex", 0, "standard", "instructions", "security", "model/ref", "[]", at);
    raw.prepare(`
      INSERT INTO memory_notes (
        id, scope, scope_ref, title, body, source, approved, created_at, updated_at,
        owner_agent, source_ref, source_at, reviewed_at, confidence, sensitivity,
        retention_until, state, superseded_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run("mem1", "company", "", "Old Fact Title", "Old Fact Body Content", "agent:rex", 1, at, at,
      "rex", "ref1", at, at, "verified", "internal", null, "active", null);

    // Run migrations 12, 13, 14
    for (const m of MIGRATIONS.filter(m => m.version > 11 && m.version <= 14)) {
      raw.exec("PRAGMA foreign_keys=OFF; BEGIN");
      raw.exec(m.sql);
      raw.exec("COMMIT; PRAGMA foreign_keys=ON");
    }

    // Check foreign keys
    assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);

    // Verify memory note was preserved with schema 14 defaults
    const migratedNote = raw.prepare("SELECT * FROM memory_notes WHERE id = 'mem1'").get();
    assert.ok(migratedNote);
    assert.equal(migratedNote.title, "Old Fact Title");
    assert.equal(migratedNote.kind, "fact");
    assert.equal(migratedNote.evidence, "[]");
    assert.equal(migratedNote.use_count, 0);
    assert.equal(migratedNote.last_used_at, null);

    // Verify FTS5 is operational on the migrated table
    const ftsSearch = raw.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'Old Fact'").all();
    assert.ok(ftsSearch.length >= 1);

    // Verify new learning tables exist and can accept records
    const propId = newId("prop");
    raw.prepare(`
      INSERT INTO learning_proposals (
        id, agent_id, project_id, kind, title, body, scope, scope_ref,
        source, source_ref, evidence, status, proposed_confidence,
        auto_promoted, resulting_memory_id, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(propId, "rex", null, "preference", "Prop title", "Prop body", "agent", "rex", "manual", null, "[]", "pending", "supported", 0, null, at, at);
    assert.equal(raw.prepare("SELECT count(*) n FROM learning_proposals").get().n, 1);

    const skillId = newId("skill");
    raw.prepare(`
      INSERT INTO agent_skills (
        id, agent_id, title, steps, applicability, version, status,
        evaluation, rollback_to, created_from_proposal, approved_by, approved_at,
        use_count, last_used_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(skillId, "rex", "Skill title", "[]", "[]", 1, "draft", null, null, null, null, null, 0, null, at, at);
    assert.equal(raw.prepare("SELECT count(*) n FROM agent_skills").get().n, 1);
  });

  it("honors learning.autoPromoteExplicitCorrections configuration setting", () => {
    const { company, learning, conversations } = createEnv();
    company.updateSettings({ learning: { autoPromoteExplicitCorrections: false } });

    const conv = conversations.create({ agentId: "mia", title: "Test toggle" });
    conversations.send(conv.id, {
      content: "من دلوقتي دايمًا استخدم هذا التنسيق"
    });

    const proposals = learning.listProposals({ agentId: "mia" });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].autoPromoted, false);
    assert.equal(proposals[0].status, "pending");
  });

  it("strictly enforces owner-only permissions on approvals and activations (agents get 403)", () => {
    const { learning } = createEnv();
    const agentActor = { type: "agent", id: "ori" };

    const prop = learning.propose({
      agentId: "ori",
      kind: "new-fact",
      title: "Test fact",
      body: "Test content",
      scope: "company"
    }, agentActor);

    // Agent attempts to approve proposal
    assert.throws(() => {
      learning.approveProposal(prop.id, {}, agentActor);
    }, (err) => err.status === 403 && err.code === "owner-only");

    // Agent attempts to reject proposal
    assert.throws(() => {
      learning.rejectProposal(prop.id, "reason", agentActor);
    }, (err) => err.status === 403 && err.code === "owner-only");

    const skill = learning.createSkill({
      agentId: "rex",
      title: "Audit skill",
      steps: [{ toolId: "security.gitleaks" }]
    }, { type: "owner", id: "owner" });
    learning.evaluateSkill(skill.id);

    // Agent attempts to activate skill
    assert.throws(() => {
      learning.activateSkill(skill.id, agentActor);
    }, (err) => err.status === 403 && err.code === "owner-only");

    // Agent attempts to update skill
    assert.throws(() => {
      learning.updateSkill(skill.id, { title: "Hacked" }, agentActor);
    }, (err) => err.status === 403 && err.code === "owner-only");
  });

  it("HTTP API serves learning dashboard, proposals, skills, and outcomes with session security", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abud-learning-api-"));
    const repoRoot = resolve(process.cwd(), "../..");
    await writeFile(join(dir, "worlds.json"), JSON.stringify({ githubOwner: "x", worlds: [] }));
    const server = createServer({
      root: repoRoot,
      configPath: join(dir, "worlds.json"),
      workspaceConfigPath: join(dir, "workspace.json"),
      policyPath: join(dir, "policy.json"),
      dbPath: ":memory:",
      vpsConfigPath: join(dir, "no-vps.json"),
      env: {},
      agentOptions: { runImpl: async () => ({ ok: false, reason: "not-found" }), home: dir },
      log: () => {}
    });

    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const request = (path, { method = "GET", body, token } = {}) => new Promise((done, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", ...(token ? { "X-Abud-Session": token } : {}) } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(buf.toString()); } catch (_) {}
          done({ status: res.statusCode, headers: res.headers, body: buf, json });
        });
      });
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

    try {
      const token = (await request("/local-api/session")).json.token;
      const base = "/local-api/company/learning";

      // GET /summary (measurable counts)
      const summaryRes = await request(`${base}/summary`);
      assert.equal(summaryRes.status, 200);
      assert.equal(typeof summaryRes.json.verifiedKnowledge7d, "number");
      assert.equal(typeof summaryRes.json.pendingProposals, "number");
      assert.equal(typeof summaryRes.json.approvedSkills, "number");

      // POST /proposals without session token -> 403
      const unauthProp = await request(`${base}/proposals`, {
        method: "POST",
        body: { agentId: "ori", kind: "new-fact", title: "Unauth fact", body: "body", scope: "company" }
      });
      assert.equal(unauthProp.status, 403);

      // POST /proposals with session token -> 201
      const createProp = await request(`${base}/proposals`, {
        method: "POST",
        token,
        body: { agentId: "ori", kind: "new-fact", title: "Auth fact", body: "body", scope: "company" }
      });
      assert.equal(createProp.status, 201);
      const propId = createProp.json.id;

      // GET /proposals
      const listProps = await request(`${base}/proposals`);
      assert.equal(listProps.status, 200);
      assert.ok(listProps.json.proposals.some(p => p.id === propId));

      // GET /proposals/:id
      const getProp = await request(`${base}/proposals/${propId}`);
      assert.equal(getProp.status, 200);
      assert.equal(getProp.json.title, "Auth fact");

      // POST /proposals/:id/approve -> 200
      const approveRes = await request(`${base}/proposals/${propId}/approve`, {
        method: "POST",
        token,
        body: {}
      });
      assert.equal(approveRes.status, 200);
      assert.equal(approveRes.json.proposal.status, "approved");

      // POST /outcomes -> 201
      const outcomeRes = await request(`${base}/outcomes`, {
        method: "POST",
        token,
        body: {
          agentId: "rex",
          problem: "تسريب سر",
          resolution: "تنظيف الكود",
          verification: "فحص ناجح",
          applicability: ["تسريب"]
        }
      });
      assert.equal(outcomeRes.status, 201);
      assert.equal(outcomeRes.json.kind, "procedure");

      // POST /skills -> 201
      const createSkillRes = await request(`${base}/skills`, {
        method: "POST",
        token,
        body: {
          agentId: "rex",
          title: "فحص أمني دوري",
          steps: [{ toolId: "security.gitleaks" }],
          applicability: ["فحص أمني"]
        }
      });
      assert.equal(createSkillRes.status, 201);
      const skillId = createSkillRes.json.id;

      // GET /skills/:id
      const getSkillRes = await request(`${base}/skills/${skillId}`);
      assert.equal(getSkillRes.status, 200);
      assert.equal(getSkillRes.json.title, "فحص أمني دوري");

      // POST /skills/:id/evaluate -> 200
      const evalRes = await request(`${base}/skills/${skillId}/evaluate`, {
        method: "POST",
        token
      });
      assert.equal(evalRes.status, 200);
      assert.equal(evalRes.json.ok, true);

      // POST /skills/:id/activate -> 200
      const actRes = await request(`${base}/skills/${skillId}/activate`, {
        method: "POST",
        token
      });
      assert.equal(actRes.status, 200);
      assert.equal(actRes.json.status, "active");

      // GET /skills (status=active filter)
      const listActive = await request(`${base}/skills?status=active`);
      assert.equal(listActive.status, 200);
      assert.ok(listActive.json.skills.some(s => s.id === skillId));
    } finally {
      await new Promise((r) => server.close(r));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
