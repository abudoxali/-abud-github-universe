/* Owner-managed, narrowly scoped permission for automatic reversible internal tools. */
import { newId, nowIso } from "./db.mjs";
import { toolById } from "./catalog.mjs";
import { HttpError } from "./company.mjs";

export function createAutoPolicies({ company }) {
  const { db } = company;
  const ownerOnly = (actor) => {
    if (actor?.type !== "owner") throw new HttpError(403, "owner-only", "سياسات التنفيذ التلقائي للمالك فقط");
  };
  const view = (r) => ({ id: r.id, agentId: r.agent_id, toolId: r.tool_id, scope: r.scope, projectId: r.project_id, createdAt: r.created_at });
  function list() { return db.all("SELECT * FROM auto_policies ORDER BY created_at, id").map(view); }
  function create({ agentId, toolId, scope = "company", projectId = null }, actor = { type: "owner", id: "owner" }) {
    ownerOnly(actor);
    const config = company.agentConfig(agentId);
    if (toolById(toolId)?.tier !== "B" || !config.tools.includes(toolId)) throw new HttpError(422, "invalid-auto-policy", "تسمح السياسة فقط بأداة داخلية قابلة للتراجع وممنوحة للوكيل");
    if (!["company", "project"].includes(scope) || (scope === "company" && projectId) || (scope === "project" && !projectId)) throw new HttpError(422, "validation", "حدد نطاق السياسة ومشروعها");
    if (scope === "project" && !toolById(toolId).input.projectId) throw new HttpError(422, "invalid-auto-policy", "هذه الأداة لا تدعم عزل التغييرات داخل مشروع");
    if (projectId) company.getProject(projectId);
    return db.tx(() => {
      const existing = db.get("SELECT * FROM auto_policies WHERE agent_id = ? AND tool_id = ? AND scope = ? AND project_id IS ?", agentId, toolId, scope, projectId);
      if (existing) return view(existing);
      const id = newId("aut");
      db.run("INSERT INTO auto_policies(id, agent_id, tool_id, scope, project_id, created_at) VALUES (?,?,?,?,?,?)", id, agentId, toolId, scope, projectId, nowIso());
      company.log({ actorType: "owner", actorId: actor.id, action: "auto-policy.created", targetType: "auto-policy", targetId: id, summary: `السماح بالتنفيذ التلقائي: ${agentId} / ${toolId}`, metadata: { scope, projectId } });
      return view(db.get("SELECT * FROM auto_policies WHERE id = ?", id));
    });
  }
  function remove(id, actor = { type: "owner", id: "owner" }) {
    ownerOnly(actor);
    if (!db.get("SELECT id FROM auto_policies WHERE id = ?", id)) throw new HttpError(404, "not-found", "السياسة غير موجودة");
    return db.tx(() => {
      db.run("DELETE FROM auto_policies WHERE id = ?", id);
      company.log({ actorType: "owner", actorId: actor.id, action: "auto-policy.deleted", targetType: "auto-policy", targetId: id, summary: "إلغاء سياسة التنفيذ التلقائي" });
      return { deleted: true };
    });
  }
  function allows({ agentId, toolId, projectId = null }) {
    return toolById(toolId)?.tier === "B" && Boolean(db.get("SELECT id FROM auto_policies WHERE agent_id = ? AND tool_id = ? AND (scope = 'company' OR (scope = 'project' AND project_id = ?))", agentId, toolId, projectId));
  }
  return { list, create, remove, allows };
}
