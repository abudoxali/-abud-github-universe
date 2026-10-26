/* Cognitive Memory & Learning Engine for ABUD FUN Company OS V6.
 * Manages learning proposals, detects owner corrections, records verified outcomes,
 * evaluates and activates procedural skills, and computes learning metrics. */
import { HttpError } from "./company.mjs";
import { newId, nowIso, parseJson } from "./db.mjs";
import { TOOLS, toolById } from "./catalog.mjs";
import { normalizeToolText, selectTools } from "./tool-selector.mjs";

const bad = (code, messageAr, details) => new HttpError(422, code, messageAr, details);
const notFound = (what) => new HttpError(404, "not-found", `${what} غير موجود`);

const PROPOSAL_KINDS = ["new-fact", "preference", "procedure", "recurring-failure", "better-strategy", "memory-correction"];
const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "superseded"];
const CONFIDENCES = ["verified", "supported", "unverified"];
const SCOPES = ["company", "project", "agent", "owner", "meeting"];
const SKILL_STATUSES = ["draft", "testing", "active", "retired"];

// Arabic Egyptian, MSA and English correction cues
const CORRECTION_CUES = /(?:لا\s+مش\s+ك[ده]|م[ات]ستخدم[ي]?ش|بلاش|مش\s+عايز[هة]?|غلط|صح\s+ك[ده]|من\s+دلوقتي|من\s+ال[اآ]ن|دايم[ااً]|دائم[ااً]|\b(?:always|never|don'?t\s+use|prefer|stop\s+using|avoid)\b)/iu;
const IMPERATIVE_CUES = /(?:من\s+دلوقتي|من\s+ال[اآ]ن|دايم[ااً]|دائم[ااً]|م[ات]ستخدم[ي]?ش|\b(?:always|never|don'?t\s+use)\b)/iu;

export function detectCorrection(text) {
  if (typeof text !== "string" || !text.trim()) return { isCorrection: false, isExplicit: false, matchText: "" };
  const clean = text.trim();
  const match = CORRECTION_CUES.exec(clean);
  if (!match) return { isCorrection: false, isExplicit: false, matchText: "" };
  const isExplicit = IMPERATIVE_CUES.test(clean);
  return { isCorrection: true, isExplicit, matchText: match[0] };
}

function proposalRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    agentId: r.agent_id,
    projectId: r.project_id ?? null,
    kind: r.kind,
    title: r.title,
    body: r.body,
    scope: r.scope,
    scopeRef: r.scope_ref,
    source: r.source,
    sourceRef: r.source_ref ?? null,
    evidence: parseJson(r.evidence, []),
    status: r.status,
    proposedConfidence: r.proposed_confidence,
    autoPromoted: r.auto_promoted === 1,
    resultingMemoryId: r.resulting_memory_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    decidedAt: r.decided_at ?? null,
    decidedBy: r.decided_by ?? null,
    promotedAt: r.promoted_at ?? null
  };
}

function skillRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    agentId: r.agent_id,
    title: r.title,
    steps: parseJson(r.steps, []),
    applicability: parseJson(r.applicability, []),
    version: r.version,
    status: r.status,
    evaluation: parseJson(r.evaluation, null),
    rollbackTo: r.rollback_to ?? null,
    createdFromProposal: r.created_from_proposal ?? null,
    approvedBy: r.approved_by ?? null,
    approvedAt: r.approved_at ?? null,
    useCount: r.use_count ?? 0,
    lastUsedAt: r.last_used_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export function createLearning({ company, runtime, db = company.db, now = () => new Date() }) {
  const atIso = () => (typeof now === "function" ? now() : new Date()).toISOString();

  // ---------------------------------------------------------------- Proposals
  function propose(input, actor = { type: "agent", id: input.agentId }) {
    const agentId = String(input.agentId ?? "").trim();
    if (!agentId || !company.agentById(agentId)) throw bad("validation", "وكيل غير معروف أو غير متاح", { agentId });
    if (!PROPOSAL_KINDS.includes(input.kind)) throw bad("validation", "نوع المقترح غير مسموح", { kind: input.kind, allowed: PROPOSAL_KINDS });
    const title = String(input.title ?? "").trim();
    if (title.length < 1 || title.length > 160) throw bad("validation", "عنوان المقترح يجب أن يكون بين حرف و160 حرفًا", { title });
    const body = String(input.body ?? "").trim();
    if (body.length < 1 || body.length > 30000) throw bad("validation", "محتوى المقترح يجب أن يكون بين حرف و30000 حرف", { bodyLength: body.length });
    const scope = SCOPES.includes(input.scope) ? input.scope : "company";
    const scopeRef = String(input.scopeRef ?? "").trim();
    const projectId = input.projectId ? String(input.projectId).trim() : null;
    const source = String(input.source ?? `${actor.type}:${actor.id}`).trim();
    const sourceRef = input.sourceRef ? String(input.sourceRef).trim() : null;
    const evidenceList = Array.isArray(input.evidence) ? input.evidence.map(String) : [];
    const proposedConfidence = CONFIDENCES.includes(input.proposedConfidence) ? input.proposedConfidence : "unverified";
    const id = newId("prop");
    const at = atIso();

    db.run(
      `INSERT INTO learning_proposals (
        id, agent_id, project_id, kind, title, body, scope, scope_ref,
        source, source_ref, evidence, status, proposed_confidence,
        auto_promoted, resulting_memory_id, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, agentId, projectId, input.kind, title, body, scope, scopeRef,
      source, sourceRef, JSON.stringify(evidenceList), "pending", proposedConfidence,
      0, null, at, at
    );

    company.log({
      actorType: actor.type,
      actorId: actor.id,
      action: "learning.proposal.created",
      targetType: "proposal",
      targetId: id,
      summary: `مقترح تعلم جديد (${input.kind}): ${title}`,
      metadata: { agentId, kind: input.kind, scope }
    });

    return getProposal(id);
  }

  function getProposal(id) {
    const row = db.get("SELECT * FROM learning_proposals WHERE id = ?", String(id));
    if (!row) throw notFound("المقترح");
    return proposalRow(row);
  }

  function listProposals({ agentId = null, kind = null, status = null, projectId = null, limit = 100 } = {}) {
    const where = [], params = [];
    if (agentId) { where.push("agent_id = ?"); params.push(agentId); }
    if (kind) { where.push("kind = ?"); params.push(kind); }
    if (status) { where.push("status = ?"); params.push(status); }
    if (projectId) { where.push("project_id = ?"); params.push(projectId); }
    const rows = db.all(
      `SELECT * FROM learning_proposals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
      ...params, Math.min(Math.max(Number(limit) || 100, 1), 300)
    );
    return rows.map(proposalRow);
  }

  function approveProposal(id, overrides = {}, actor = { type: "owner", id: "owner" }) {
    if (actor?.type !== "owner") throw new HttpError(403, "owner-only", "الموافقة على مقترحات التعلم للمالك فقط");
    const proposal = getProposal(id);
    if (proposal.status !== "pending") throw new HttpError(409, "already-decided", "تم البت في هذا المقترح مسبقًا");

    const memKind = overrides.kind || (proposal.kind === "preference" ? "preference" : proposal.kind === "procedure" ? "procedural" : proposal.kind === "recurring-failure" ? "episodic" : proposal.kind === "better-strategy" ? "procedural" : "fact");
    const at = atIso();

    const memNotes = company.upsertMemory({
      scope: overrides.scope || proposal.scope,
      scopeRef: overrides.scopeRef !== undefined ? overrides.scopeRef : proposal.scopeRef,
      title: overrides.title || proposal.title,
      body: overrides.body || proposal.body,
      kind: memKind,
      confidence: "verified",
      evidence: proposal.evidence,
      sourceRef: `proposal:${proposal.id}`,
      ownerAgent: proposal.agentId,
      approved: true
    }, actor);

    const resultingNote = memNotes.find(n => n.title === (overrides.title || proposal.title)) || memNotes[0];

    db.run(
      "UPDATE learning_proposals SET status = 'approved', decided_by = ?, decided_at = ?, resulting_memory_id = ?, updated_at = ? WHERE id = ?",
      actor.id, at, resultingNote?.id ?? null, at, id
    );

    company.log({
      actorType: actor.type,
      actorId: actor.id,
      action: "learning.proposal.approved",
      targetType: "proposal",
      targetId: id,
      summary: `موافقة المالك على مقترح التعلم: ${proposal.title}`,
      metadata: { memoryNoteId: resultingNote?.id ?? null }
    });

    return { proposal: getProposal(id), memoryNote: resultingNote ?? null };
  }

  function rejectProposal(id, reason = null, actor = { type: "owner", id: "owner" }) {
    if (actor?.type !== "owner") throw new HttpError(403, "owner-only", "رفض مقترحات التعلم للمالك فقط");
    const proposal = getProposal(id);
    if (proposal.status !== "pending") throw new HttpError(409, "already-decided", "تم البت في هذا المقترح مسبقًا");

    const at = atIso();
    db.run(
      "UPDATE learning_proposals SET status = 'rejected', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?",
      actor.id, at, at, id
    );

    company.log({
      actorType: actor.type,
      actorId: actor.id,
      action: "learning.proposal.rejected",
      targetType: "proposal",
      targetId: id,
      summary: `رفض مقترح التعلم: ${proposal.title}${reason ? ` (${reason})` : ""}`,
      metadata: { reason }
    });

    return { proposal: getProposal(id) };
  }

  // ---------------------------------------------------------------- Correction Learning
  function onOwnerMessage({ conversationId, messageId, agentId, projectId = null, content }) {
    if (!content || typeof content !== "string" || !agentId) return null;
    const { isCorrection, isExplicit } = detectCorrection(content);
    if (!isCorrection) return null;

    const at = atIso();
    const title = `تفضيل المالك: ${content.trim().slice(0, 100)}`;
    const evidence = [`message:${messageId}`, `conversation:${conversationId}`];
    const autoPromote = isExplicit && (company.settings()?.learning?.autoPromoteExplicitCorrections !== false);

    if (autoPromote) {
      const memId = newId("mem");
      const propId = newId("prop");

      db.tx(() => {
        // Archive and supersede any earlier contradictory active preference for this agent
        const previousNotes = db.all(
          "SELECT id FROM memory_notes WHERE scope = 'owner' AND scope_ref = ? AND kind = 'preference' AND state = 'active'",
          agentId
        );
        for (const prev of previousNotes) {
          db.run("UPDATE memory_notes SET state = 'archived', superseded_by = ?, updated_at = ? WHERE id = ?", memId, at, prev.id);
          db.run("UPDATE learning_proposals SET status = 'superseded', updated_at = ? WHERE resulting_memory_id = ?", at, prev.id);
        }

        // Create the approved owner-scoped preference memory note
        db.run(
          `INSERT INTO memory_notes (
            id, scope, scope_ref, title, body, source, approved, created_at, updated_at,
            owner_agent, source_ref, source_at, reviewed_at, confidence, sensitivity,
            retention_until, state, kind, evidence
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          memId, "owner", agentId, title, content.trim(), "owner:correction", 1, at, at,
          agentId, `message:${messageId}`, at, at, "supported", "internal",
          null, "active", "preference", JSON.stringify(evidence)
        );

        // Record the auto-promoted proposal
        db.run(
          `INSERT INTO learning_proposals (
            id, agent_id, project_id, kind, title, body, scope, scope_ref,
            source, source_ref, evidence, status, proposed_confidence,
            auto_promoted, resulting_memory_id, created_at, updated_at,
            decided_at, decided_by, promoted_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          propId, agentId, projectId, "preference", title, content.trim(), "owner", agentId,
          `conversation:${conversationId}`, `message:${messageId}`, JSON.stringify(evidence),
          "approved", "supported", 1, memId, at, at, at, "system:auto-promote", at
        );

        company.log({
          actorType: "owner",
          actorId: "owner",
          action: "learning.correction.auto_promoted",
          targetType: "memory",
          targetId: memId,
          summary: `ترقية تفضيل المالك للوكيل ${agentId} تلقائيًا: ${title}`,
          metadata: { proposalId: propId, agentId, supersededCount: previousNotes.length }
        });
      });

      return {
        proposal: getProposal(propId),
        memoryNote: company.listMemory({ scope: "owner", scopeRef: agentId, state: null }).find(n => n.id === memId)
      };
    }

    // Non-explicit correction -> pending proposal for owner review
    return {
      proposal: propose({
        agentId,
        projectId,
        kind: "preference",
        title,
        body: content.trim(),
        scope: "owner",
        scopeRef: agentId,
        source: `conversation:${conversationId}`,
        sourceRef: `message:${messageId}`,
        evidence,
        proposedConfidence: "supported"
      }, { type: "owner", id: "conversation" })
    };
  }

  // ---------------------------------------------------------------- Outcome Learning
  function recordOutcome({ agentId, problem, resolution, verification, evidence = [], applicability = [], projectId = null, title = null }) {
    const cleanAgent = String(agentId ?? "").trim();
    if (!cleanAgent || !company.agentById(cleanAgent)) throw bad("validation", "وكيل غير معروف أو غير متاح", { agentId });

    const probText = String(problem ?? "").trim();
    const resText = String(resolution ?? "").trim();
    const verText = String(verification ?? "").trim();
    if (!probText || !resText || !verText) throw bad("validation", "المشكلة والحل والتحقق حقول مطلوبة");

    const appList = (Array.isArray(applicability) ? applicability : [applicability]).map(String).filter(Boolean);
    const bodyObj = {
      problem: probText,
      resolution: resText,
      verification: verText,
      applicability: appList,
      date: atIso()
    };

    const propTitle = title ? String(title).slice(0, 160) : `إجراء معتمد: ${probText}`.slice(0, 160);

    return propose({
      agentId: cleanAgent,
      projectId,
      kind: "procedure",
      title: propTitle,
      body: JSON.stringify(bodyObj, null, 2),
      scope: "company",
      scopeRef: "",
      source: "agent:outcome",
      evidence: Array.isArray(evidence) ? evidence : [evidence],
      proposedConfidence: "supported"
    }, { type: "agent", id: cleanAgent });
  }

  // ---------------------------------------------------------------- Procedural Skills
  function createSkill({ agentId, title, steps = [], applicability = [], sourceProposalId = null }, actor = { type: "owner", id: "owner" }) {
    const cleanAgent = String(agentId ?? "").trim();
    if (!cleanAgent || !company.agentById(cleanAgent)) throw bad("validation", "وكيل غير معروف أو غير متاح", { agentId });
    const cleanTitle = String(title ?? "").trim();
    if (cleanTitle.length < 1 || cleanTitle.length > 160) throw bad("validation", "عنوان المهارة يجب أن يكون بين حرف و160 حرفًا");
    if (!Array.isArray(steps)) throw bad("validation", "خطوات المهارة يجب أن تكون قائمة");
    const cleanApplicability = (Array.isArray(applicability) ? applicability : [applicability]).map(String).filter(Boolean);

    const id = newId("skill");
    const at = atIso();

    db.run(
      `INSERT INTO agent_skills (
        id, agent_id, title, steps, applicability, version, status,
        evaluation, rollback_to, created_from_proposal, approved_by, approved_at,
        use_count, last_used_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, cleanAgent, cleanTitle, JSON.stringify(steps), JSON.stringify(cleanApplicability), 1, "draft",
      null, null, sourceProposalId, null, null, 0, null, at, at
    );

    company.log({
      actorType: actor.type,
      actorId: actor.id,
      action: "learning.skill.created",
      targetType: "skill",
      targetId: id,
      summary: `إنشاء مسودة مهارة إجرائية: ${cleanTitle}`,
      metadata: { agentId: cleanAgent }
    });

    return getSkill(id);
  }

  function createSkillFromProposal(proposalId, overrides = {}, actor = { type: "owner", id: "owner" }) {
    const proposal = getProposal(proposalId);
    let parsedBody = {};
    try { parsedBody = JSON.parse(proposal.body); } catch (_) {}

    const title = overrides.title || proposal.title;
    const steps = overrides.steps || (Array.isArray(parsedBody.steps) ? parsedBody.steps : []);
    const applicability = overrides.applicability || (Array.isArray(parsedBody.applicability) ? parsedBody.applicability : [proposal.title]);

    return createSkill({
      agentId: proposal.agentId,
      title,
      steps,
      applicability,
      sourceProposalId: proposal.id
    }, actor);
  }

  function getSkill(id) {
    const row = db.get("SELECT * FROM agent_skills WHERE id = ?", String(id));
    if (!row) throw notFound("المهارة الإجرائية");
    return skillRow(row);
  }

  function listSkills({ agentId = null, status = null, limit = 100 } = {}) {
    const where = [], params = [];
    if (agentId) { where.push("agent_id = ?"); params.push(agentId); }
    if (status) { where.push("status = ?"); params.push(status); }
    const rows = db.all(
      `SELECT * FROM agent_skills ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`,
      ...params, Math.min(Math.max(Number(limit) || 100, 1), 300)
    );
    return rows.map(skillRow);
  }

  function evaluateSkill(id) {
    const skill = getSkill(id);
    const agent = company.agentById(skill.agentId);
    if (!agent) throw notFound("الوكيل المرتبط بالمهارة");

    const grantedTools = new Set(Array.isArray(agent.tools) ? agent.tools : []);
    const errors = [];
    const steps = Array.isArray(skill.steps) ? skill.steps : [];

    if (steps.length === 0) {
      errors.push("المهارة لا تحتوي على خطوات تنفيذية");
    }

    for (const step of steps) {
      const toolId = step?.toolId;
      if (!toolId) {
        errors.push("خطوة تفتقد معرف الأداة toolId");
        continue;
      }
      const tool = toolById(toolId);
      if (!tool) {
        errors.push(`unknown-tool: أداة غير معروفة «${toolId}»`);
        continue;
      }
      if (!grantedTools.has(toolId)) {
        errors.push(`tool-not-granted: الأداة «${toolId}» غير ممنوحة للوكيل «${skill.agentId}»`);
      }
      if (tool.tier === "C") {
        errors.push(`tier-c-refused: لا يُسمح بإدراج أداة من الفئة C «${toolId}» في مهارة إجرائية`);
      }
    }

    // Dry-run tool selection on applicability examples
    let dryRunPassed = true;
    for (const app of (skill.applicability || []).slice(0, 3)) {
      try {
        const preview = selectTools({
          agent,
          grants: [...grantedTools],
          request: String(app),
          skills: [skill]
        });
        if (!preview) dryRunPassed = false;
      } catch (_) {
        dryRunPassed = false;
      }
    }
    if (!dryRunPassed) errors.push("dry-run-failed: فشل الاختبار التجريبي لاكتشاف أدوات المهارة");

    const passed = errors.length === 0;
    const evaluation = {
      ok: passed,
      passed,
      errors,
      evaluatedAt: atIso(),
      stepsCount: steps.length,
      allGranted: !errors.some(e => e.startsWith("tool-not-granted")),
      noTierC: !errors.some(e => e.startsWith("tier-c-refused")),
      dryRunPassed,
      estimatedCostUsd: steps.reduce((acc, s) => {
        const t = toolById(s.toolId);
        return acc + (t?.tier === "B" ? 0.001 : 0.0);
      }, 0.0)
    };

    db.run("UPDATE agent_skills SET evaluation = ?, updated_at = ? WHERE id = ?", JSON.stringify(evaluation), atIso(), id);
    return { ok: passed, passed, errors, evaluation };
  }

  function activateSkill(id, actor = { type: "owner", id: "owner" }) {
    if (actor?.type !== "owner") throw new HttpError(403, "owner-only", "تفعيل المهارات للمالك فقط");
    const skill = getSkill(id);
    if (!skill.evaluation || !skill.evaluation.passed) {
      throw new HttpError(422, "evaluation-required", "لا يمكن تفعيل المهارة دون اجتياز التقييم بنجاح");
    }

    const at = atIso();
    db.run(
      "UPDATE agent_skills SET status = 'active', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?",
      actor.id, at, at, id
    );

    company.log({
      actorType: actor.type,
      actorId: actor.id,
      action: "learning.skill.activated",
      targetType: "skill",
      targetId: id,
      summary: `تفعيل المهارة الإجرائية: ${skill.title}`
    });

    return getSkill(id);
  }

  function updateSkill(id, patch, actor = { type: "owner", id: "owner" }) {
    if (actor?.type !== "owner") throw new HttpError(403, "owner-only", "تعديل المهارات للمالك فقط");
    const skill = getSkill(id);
    const at = atIso();

    // If active and structural changes are made, produce a new version with rollback pointer
    if (skill.status === "active" && (patch.steps !== undefined || patch.applicability !== undefined || patch.title !== undefined)) {
      const nextId = newId("skill");
      const nextTitle = patch.title ? String(patch.title).trim() : skill.title;
      const nextSteps = patch.steps !== undefined ? patch.steps : skill.steps;
      const nextApp = patch.applicability !== undefined ? patch.applicability : skill.applicability;

      db.run(
        `INSERT INTO agent_skills (
          id, agent_id, title, steps, applicability, version, status,
          evaluation, rollback_to, created_from_proposal, approved_by, approved_at,
          use_count, last_used_at, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        nextId, skill.agentId, nextTitle, JSON.stringify(nextSteps), JSON.stringify(nextApp), skill.version + 1, "draft",
        null, skill.id, skill.createdFromProposal, null, null, 0, null, at, at
      );

      return getSkill(nextId);
    }

    const nextTitle = patch.title ? String(patch.title).trim() : skill.title;
    const nextSteps = patch.steps !== undefined ? JSON.stringify(patch.steps) : JSON.stringify(skill.steps);
    const nextApp = patch.applicability !== undefined ? JSON.stringify(patch.applicability) : JSON.stringify(skill.applicability);
    const nextStatus = SKILL_STATUSES.includes(patch.status) ? patch.status : skill.status;

    db.run(
      "UPDATE agent_skills SET title = ?, steps = ?, applicability = ?, status = ?, updated_at = ? WHERE id = ?",
      nextTitle, nextSteps, nextApp, nextStatus, at, id
    );

    return getSkill(id);
  }

  function rollbackSkill(id, actor = { type: "owner", id: "owner" }) {
    if (actor?.type !== "owner") throw new HttpError(403, "owner-only", "استرجاع إصدار المهارة للمالك فقط");
    const skill = getSkill(id);
    if (!skill.rollbackTo) throw new HttpError(422, "no-rollback-target", "لا يوجد إصدار سابق للاسترجاع إليه");

    const previous = getSkill(skill.rollbackTo);
    const at = atIso();

    db.tx(() => {
      db.run("UPDATE agent_skills SET status = 'retired', updated_at = ? WHERE id = ?", at, skill.id);
      db.run("UPDATE agent_skills SET status = 'active', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?", actor.id, at, at, previous.id);
    });

    company.log({
      actorType: actor.type,
      actorId: actor.id,
      action: "learning.skill.rolled_back",
      targetType: "skill",
      targetId: previous.id,
      summary: `استرجاع المهارة الإجرائية «${previous.title}» إلى الإصدار ${previous.version}`
    });

    return getSkill(previous.id);
  }

  function matchingSkills({ agentId, request }) {
    if (!agentId || !request) return [];
    const active = listSkills({ agentId, status: "active" });
    const norm = normalizeToolText(request);
    const tokens = new Set(norm.split(" ").filter(Boolean));

    return active.filter(s => {
      const keywords = (s.applicability || []).map(normalizeToolText).filter(Boolean);
      return keywords.some(kw => norm.includes(kw) || kw.split(" ").filter(Boolean).some(tok => tokens.has(tok)));
    });
  }

  function recordSkillUsage(id) {
    if (!id) return;
    db.run("UPDATE agent_skills SET use_count = use_count + 1, last_used_at = ? WHERE id = ?", atIso(), String(id));
  }

  // ---------------------------------------------------------------- Dashboard Metrics
  function dashboardSummary() {
    const nowMs = now ? (typeof now === "function" ? now().getTime() : new Date(now).getTime()) : Date.now();
    const sevenDaysAgo = new Date(nowMs - 7 * 86_400_000).toISOString();
    const thirtyDaysAgo = new Date(nowMs - 30 * 86_400_000).toISOString();

    const verifiedKnowledge7d = db.get(
      "SELECT COUNT(*) AS n FROM memory_notes WHERE confidence = 'verified' AND created_at >= ?",
      sevenDaysAgo
    ).n;

    const verifiedKnowledge30d = db.get(
      "SELECT COUNT(*) AS n FROM memory_notes WHERE confidence = 'verified' AND created_at >= ?",
      thirtyDaysAgo
    ).n;

    const pendingProposals = db.get(
      "SELECT COUNT(*) AS n FROM learning_proposals WHERE status = 'pending'"
    ).n;

    const approvedSkills = db.get(
      "SELECT COUNT(*) AS n FROM agent_skills WHERE status = 'active'"
    ).n;

    const supersededNotes = db.get(
      "SELECT COUNT(*) AS n FROM memory_notes WHERE superseded_by IS NOT NULL"
    ).n;

    const recentCorrections = db.get(
      "SELECT COUNT(*) AS n FROM learning_proposals WHERE (kind = 'preference' OR kind = 'memory-correction' OR auto_promoted = 1) AND created_at >= ?",
      thirtyDaysAgo
    ).n;

    // Repeated failures: same tool error code for the same agent
    const failureRows = db.all(`
      SELECT agent_id, tool_id, error_code, COUNT(*) AS count
      FROM tool_executions
      WHERE status = 'failed' AND error_code IS NOT NULL
      GROUP BY agent_id, tool_id, error_code
      HAVING count > 1
    `);
    const repeatedFailures = failureRows.reduce((sum, f) => sum + (f.count - 1), 0);

    return {
      verifiedKnowledge7d,
      verifiedKnowledge30d,
      pendingProposals,
      approvedSkills,
      supersededNotes,
      recentCorrections,
      repeatedFailures
    };
  }

  return {
    propose,
    getProposal,
    listProposals,
    approveProposal,
    rejectProposal,
    detectCorrection,
    onOwnerMessage,
    recordOutcome,
    createSkill,
    createSkillFromProposal,
    getSkill,
    listSkills,
    evaluateSkill,
    activateSkill,
    updateSkill,
    rollbackSkill,
    matchingSkills,
    recordSkillUsage,
    dashboardSummary
  };
}
