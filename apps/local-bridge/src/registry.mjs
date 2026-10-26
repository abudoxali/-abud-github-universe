/* V6 Dynamic Agent Registry: agents become extensible roster, profiles stored in DB, templates define allowed tool sets.
 * Built-in six are seeded from catalog.AGENTS; custom agents created from templates with owner-editable fields. */
import { nowIso, newId, parseJson } from "./db.mjs";
import { AGENTS, AGENT_TEMPLATES, agentById, templateById, VPS_AGENT_TOOLS, V5_AGENT_TOOLS } from "./catalog.mjs";
import { HttpError } from "./company.mjs";

function validateProfile(input, partial = false) {
  for (const key of ["name", "titleAr", "roleAr", "summaryAr"]) {
    const value = input[key];
    if (partial && value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new HttpError(400, "validation", 'Invalid ' + key);
  }
  if (input.mode !== undefined && !["standard", "creative", "analytical", "research", "strict", "execution"].includes(input.mode)) throw new HttpError(400, "validation", "Invalid mode");
  if (input.specializations !== undefined && (!Array.isArray(input.specializations) || input.specializations.length > 40 || input.specializations.some(v => typeof v !== "string" || v.length > 200))) throw new HttpError(400, "validation", "Invalid specializations");
  if (input.instructions !== undefined && (typeof input.instructions !== "string" || input.instructions.length > 4000)) throw new HttpError(400, "validation", "Invalid instructions");
  if (input.department != null && (typeof input.department !== "string" || input.department.length > 200)) throw new HttpError(400, "validation", "Invalid department");
  if (input.modelOverride != null && (typeof input.modelOverride !== "string" || !/^[A-Za-z0-9._:/@+-]{1,120}$/.test(input.modelOverride))) throw new HttpError(400, "validation", "Invalid model");
  if (input.voiceProfile !== undefined && (!input.voiceProfile || typeof input.voiceProfile !== "object" || Array.isArray(input.voiceProfile) || JSON.stringify(input.voiceProfile).length > 2000)) throw new HttpError(400, "validation", "Invalid voice");
}

export function createRegistry({ db, company }) {
  /** Seeds the six built-in agent profiles from catalog.AGENTS (idempotent; never overwrites owner edits). */
  function seedBuiltinProfiles() {
    return db.tx(() => {
      for (const agent of AGENTS) {
        const existing = db.get("SELECT id FROM agents WHERE id = ?", agent.id);
        if (existing) {
          // Update only the fields that come from catalog, not owner-editable fields
          db.run(`UPDATE agents SET name = ?, title_ar = ?, role_ar = ?, summary_ar = ?, specializations = ?,
                   identity_profile = ?, updated_at = ? WHERE id = ? AND builtin = 1 AND name = ''`,
            agent.name, agent.titleAr, agent.roleAr, agent.summaryAr,
            JSON.stringify(agent.specializationsAr || []),
            JSON.stringify({ color: agent.color, order: agent.order, art: agent.art }),
            nowIso(), agent.id
          );
        } else {
          // Insert new built-in agent
          const tools = JSON.stringify([...agent.tools, ...VPS_AGENT_TOOLS[agent.id], ...V5_AGENT_TOOLS[agent.id]]);
          db.run(`INSERT INTO agents (id, enabled, mode, instructions, policy_domain, model_override, tools, updated_at,
                   builtin, name, title_ar, role_ar, department, summary_ar, specializations, identity_profile,
                   voice_profile, memory_scope, model_routing_profile, resource_limits, collaboration_permissions,
                   approval_policy, availability, active, template_id, profile_schema_version, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            agent.id, 1, agent.defaultMode, "", agent.domain, null, tools, nowIso(),
            1, agent.name, agent.titleAr, agent.roleAr, null, agent.summaryAr,
            JSON.stringify(agent.specializationsAr || []),
            JSON.stringify({ color: agent.color, order: agent.order, art: agent.art }),
            JSON.stringify({ status: "provisional", engine: null, speaker: null }),
            "conversation", JSON.stringify({ domain: agent.domain, mode: agent.defaultMode }),
            JSON.stringify({}), JSON.stringify({}), "default", "active", 1, null, 1, nowIso()
          );
        }
      }
      return { seeded: AGENTS.length };
    });
  }

  /** Lists agents (active only or all). Returns array with profile fields and builtin flag. */
  function list({ activeOnly = true } = {}) {
    const where = activeOnly ? "WHERE active = 1" : "";
    const rows = db.all(`SELECT id, builtin, name, title_ar, role_ar, department, summary_ar, specializations,
                          identity_profile, voice_profile, memory_scope, model_routing_profile, template_id,
                          availability, active, enabled, mode, policy_domain, tools, created_at, updated_at
                        FROM agents ${where} ORDER BY builtin DESC, id`);
    return rows.map((row) => ({
      id: row.id,
      builtin: row.builtin === 1,
      name: row.name,
      titleAr: row.title_ar,
      roleAr: row.role_ar,
      department: row.department,
      summaryAr: row.summary_ar,
      specializations: parseJson(row.specializations, []),
      identityProfile: parseJson(row.identity_profile, {}),
      voiceProfile: parseJson(row.voice_profile, { status: "provisional", engine: null, speaker: null }),
      memoryScope: row.memory_scope,
      modelRoutingProfile: parseJson(row.model_routing_profile, {}),
      templateId: row.template_id,
      availability: row.availability,
      active: row.active === 1,
      enabled: row.enabled === 1,
      mode: row.mode,
      policyDomain: row.policy_domain,
      tools: parseJson(row.tools, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  /** Gets one agent profile by id (throws 404 if not found). */
  function get(id) {
    const row = db.get(`SELECT id, builtin, name, title_ar, role_ar, department, summary_ar, specializations,
                         identity_profile, voice_profile, memory_scope, model_routing_profile, resource_limits,
                         collaboration_permissions, approval_policy, template_id, availability, active, enabled,
                         mode, instructions, policy_domain, model_override, tools, profile_schema_version,
                         created_at, updated_at
                       FROM agents WHERE id = ?`, id);
    if (!row) throw new HttpError(404, "agent-not-found", `الوكيل ${id} غير موجود.`);
    return {
      id: row.id,
      builtin: row.builtin === 1,
      name: row.name,
      titleAr: row.title_ar,
      roleAr: row.role_ar,
      department: row.department,
      summaryAr: row.summary_ar,
      specializations: parseJson(row.specializations, []),
      identityProfile: parseJson(row.identity_profile, {}),
      voiceProfile: parseJson(row.voice_profile, { status: "provisional", engine: null, speaker: null }),
      memoryScope: row.memory_scope,
      modelRoutingProfile: parseJson(row.model_routing_profile, {}),
      resourceLimits: parseJson(row.resource_limits, {}),
      collaborationPermissions: parseJson(row.collaboration_permissions, {}),
      approvalPolicy: row.approval_policy,
      templateId: row.template_id,
      availability: row.availability,
      active: row.active === 1,
      enabled: row.enabled === 1,
      mode: row.mode,
      instructions: row.instructions,
      policyDomain: row.policy_domain,
      modelOverride: row.model_override,
      tools: parseJson(row.tools, []),
      profileSchemaVersion: row.profile_schema_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /** Creates a new agent from a template. Validates tool subset, returns agent id. */
  function createFromTemplate({ templateId, id, name, titleAr, roleAr, department, summaryAr, specializations, tools, mode, instructions }) {
    const template = templateById(templateId);
    if (!template) throw new HttpError(400, "invalid-template", `قالب ${templateId} غير موجود.`);

    // Validate id format
    if (!id || !/^[a-z][a-z0-9_-]{1,23}$/.test(id)) {
      throw new HttpError(400, "invalid-agent-id", "معرف الوكيل يجب أن يبدأ بحرف صغير ويحتوي على 2-24 حرفًا (a-z, 0-9, _, -).");
    }

    // Check if id already exists
    const existing = db.get("SELECT id FROM agents WHERE id = ?", id);
    if (existing) throw new HttpError(409, "agent-exists", `الوكيل ${id} موجود بالفعل.`);

    // Validate tools are subset of template's allowed tools
    const requestedTools = tools ?? template.allowedTools;
    if (!Array.isArray(requestedTools) || requestedTools.some(t => typeof t !== "string")) throw new HttpError(400, "tools-not-allowed", "Invalid tools");
    validateProfile({ name, titleAr, roleAr, summaryAr, specializations, mode, instructions });
    const invalidTools = requestedTools.filter((t) => !template.allowedTools.includes(t));
    if (invalidTools.length > 0) {
      throw new HttpError(400, "tools-not-allowed", `الأدوات التالية غير مسموحة لهذا القالب: ${invalidTools.join(", ")}`);
    }

    return db.tx(() => {
      const agentId = id;
      const now = nowIso();
      db.run(`INSERT INTO agents (id, enabled, mode, instructions, policy_domain, model_override, tools, updated_at,
               builtin, name, title_ar, role_ar, department, summary_ar, specializations, identity_profile,
               voice_profile, memory_scope, model_routing_profile, resource_limits, collaboration_permissions,
               approval_policy, availability, active, template_id, profile_schema_version, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        agentId, 1, mode || template.defaultMode, instructions || "", template.defaultDomain, null,
        JSON.stringify(requestedTools), now, 0, name, titleAr, roleAr, department || null, summaryAr,
        JSON.stringify(specializations || []),
        JSON.stringify({ color: "#888888", order: 99, art: { card: null, full: null, sheet: null, lineup: null } }),
        JSON.stringify({ status: "provisional", engine: null, speaker: null }),
        template.defaultMemoryScope,
        JSON.stringify({ domain: template.defaultDomain, mode: mode || template.defaultMode }),
        JSON.stringify({}), JSON.stringify({}), "default", "active", 1, templateId, 1, now
      );
      company.log({
        actorType: "owner", actorId: "owner", action: "agent.created",
        targetType: "agent", targetId: agentId, outcome: "success",
        summary: `تم إنشاء وكيل جديد: ${name} (${agentId}) من قالب ${template.nameAr}`,
        metadata: JSON.stringify({ templateId, requestedToolsCount: requestedTools.length })
      });
      return { id: agentId, createdAt: now };
    });
  }

  /** Updates owner-editable fields of an agent (not builtin constraints, tools, or domain). */
  function update(id, { name, titleAr, roleAr, department, summaryAr, specializations, mode, instructions, modelOverride, voiceProfile }) {
    const agent = db.get("SELECT builtin, active FROM agents WHERE id = ?", id);
    if (!agent) throw new HttpError(404, "agent-not-found", `الوكيل ${id} غير موجود.`);

    validateProfile({ name, titleAr, roleAr, department, summaryAr, specializations, mode, instructions, modelOverride, voiceProfile }, true);
    if (id === "rex" && mode && !["strict", "analytical"].includes(mode)) throw new HttpError(400, "mode-not-permitted", "Invalid security mode");
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push("name = ?"); params.push(name); }
    if (titleAr !== undefined) { updates.push("title_ar = ?"); params.push(titleAr); }
    if (roleAr !== undefined) { updates.push("role_ar = ?"); params.push(roleAr); }
    if (department !== undefined) { updates.push("department = ?"); params.push(department); }
    if (summaryAr !== undefined) { updates.push("summary_ar = ?"); params.push(summaryAr); }
    if (specializations !== undefined) { updates.push("specializations = ?"); params.push(JSON.stringify(specializations)); }
    if (mode !== undefined) { updates.push("mode = ?"); params.push(mode); }
    if (instructions !== undefined) { updates.push("instructions = ?"); params.push(instructions); }
    if (modelOverride !== undefined) { updates.push("model_override = ?"); params.push(modelOverride); }
    if (voiceProfile !== undefined) { updates.push("voice_profile = ?"); params.push(JSON.stringify(voiceProfile)); }

    if (updates.length === 0) throw new HttpError(400, "no-updates", "لا توجد تحديثات.");

    updates.push("updated_at = ?");
    params.push(nowIso(), id);

    return db.tx(() => {
      db.run(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`, ...params);
      company.log({
        actorType: "owner", actorId: "owner", action: "agent.updated",
        targetType: "agent", targetId: id, outcome: "success",
        summary: `تم تحديث ملف الوكيل: ${id}`,
        metadata: JSON.stringify({ updatedFields: updates.length - 1 })
      });
      return { updated: true };
    });
  }

  /** Deactivates an agent (built-ins cannot be deactivated; custom agents can only be deactivated if no runs exist). */
  function deactivate(id) {
    const agent = db.get("SELECT builtin, active FROM agents WHERE id = ?", id);
    if (!agent) throw new HttpError(404, "agent-not-found", `الوكيل ${id} غير موجود.`);
    if (agent.builtin === 1) throw new HttpError(409, "builtin-cannot-deactivate", "الوكلاء المدمجون لا يمكن تعطيلهم.");
    if (agent.active === 0) throw new HttpError(400, "already-inactive", "الوكيل معطل بالفعل.");

    return db.tx(() => {
      db.run("UPDATE agents SET active = 0, updated_at = ? WHERE id = ?", nowIso(), id);
      company.log({
        actorType: "owner", actorId: "owner", action: "agent.deactivated",
        targetType: "agent", targetId: id, outcome: "success",
        summary: `تم تعطيل الوكيل: ${id}`
      });
      return { deactivated: true };
    });
  }

  /** Reactivates an agent. */
  function activate(id) {
    const agent = db.get("SELECT active FROM agents WHERE id = ?", id);
    if (!agent) throw new HttpError(404, "agent-not-found", `الوكيل ${id} غير موجود.`);
    if (agent.active === 1) throw new HttpError(400, "already-active", "الوكيل مفعّل بالفعل.");

    return db.tx(() => {
      db.run("UPDATE agents SET active = 1, updated_at = ? WHERE id = ?", nowIso(), id);
      company.log({
        actorType: "owner", actorId: "owner", action: "agent.activated",
        targetType: "agent", targetId: id, outcome: "success",
        summary: `تم تفعيل الوكيل: ${id}`
      });
      return { activated: true };
    });
  }

  /** Lists all agent templates. */
  function listTemplates() {
    return AGENT_TEMPLATES.map((t) => ({
      id: t.id,
      nameAr: t.nameAr,
      basedOn: t.basedOn,
      descriptionAr: t.descriptionAr,
      allowedToolsCount: t.allowedTools.length,
      capabilities: t.capabilities,
      defaultDomain: t.defaultDomain,
      defaultMode: t.defaultMode
    }));
  }

  /** Gets one template by id. */
  function getTemplate(id) {
    const template = templateById(id);
    if (!template) throw new HttpError(404, "template-not-found", `قالب ${id} غير موجود.`);
    return {
      id: template.id,
      nameAr: template.nameAr,
      basedOn: template.basedOn,
      descriptionAr: template.descriptionAr,
      allowedTools: template.allowedTools,
      capabilities: template.capabilities,
      defaultDomain: template.defaultDomain,
      defaultMode: template.defaultMode,
      defaultMemoryScope: template.defaultMemoryScope
    };
  }

  function remove(id) {
    const agent = get(id);
    if (agent.builtin) throw new HttpError(409, "builtin-cannot-delete", "Built-in agent");
    if (db.get("SELECT id FROM agent_runs WHERE agent_id = ? LIMIT 1", id)) throw new HttpError(409, "agent-has-runs", "Agent has runs");
    return db.tx(() => {
      try { db.run("DELETE FROM agents WHERE id = ?", id); } catch (error) { if (/FOREIGN KEY/.test(error.message)) throw new HttpError(409, "agent-in-use", "Agent has records"); throw error; }
      company.log({ action: "agent.deleted", targetType: "agent", targetId: id, summary: 'Deleted ' + id });
      return { deleted: true };
    });
  }
  return { remove, seedBuiltinProfiles, list, get, createFromTemplate, update, deactivate, activate, listTemplates, getTemplate };
}
