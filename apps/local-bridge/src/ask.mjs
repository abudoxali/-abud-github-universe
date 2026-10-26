/* «اسأل الشركة»: one request box for the whole company. Routing is deterministic and explainable — an employee named
 * at the start of the request gets it; otherwise the employee whose approved tools and specializations match best;
 * otherwise ORI coordinates. The request then runs as a normal conversation (same tools, approvals and audit). */
import { HttpError } from "./company.mjs";
import { normalizeToolText } from "./tool-selector.mjs";
import { ALIASES } from "./meetings.mjs";

export function createAsk({ company, runtime, conversations }) {
  async function route(text, projectId = null) {
    const active = company.listAgents().filter((a) => company.agentConfig(a.id).enabled);
    const tokens = normalizeToolText(text).split(/\s+/).filter(Boolean);
    const first = (tokens[0] === "يا" ? tokens[1] : tokens[0])?.replace(/^@/, "");
    const named = active.find((a) => [a.id, a.name, ...(ALIASES[a.id] || [])].map(normalizeToolText).includes(first));
    if (named) return { agentId: named.id, reasonAr: `طلبت ${named.name} بالاسم` };
    const words = new Set(tokens.filter((w) => w.length > 2));
    let best = null;
    for (const agent of active) {
      let tools = [];
      try { tools = (await runtime.toolSelectPreview({ agentId: agent.id, request: text, projectId })).selected; } catch (_) { /* no eligible tools */ }
      const spec = normalizeToolText([...(agent.specializationsAr || agent.specializations || []), agent.roleAr || ""].join(" ")).split(/\s+/);
      const score = 3 * tools.length + spec.filter((w) => words.has(w)).length;
      if (score >= 3 && (!best || score > best.score)) best = { agentId: agent.id, score, tools: tools.map((t) => t.toolId) };
    }
    if (best && best.agentId !== "ori") return { agentId: best.agentId, reasonAr: `الأنسب لأدوات وتخصص الطلب (${best.tools.slice(0, 3).join("، ") || "تخصص"})` };
    const ori = active.find((a) => a.id === "ori") || active[0];
    return { agentId: ori.id, reasonAr: best ? "طلب عام يخص التنسيق والأولويات" : "لا يوجد متخصص واضح؛ ORI ينسّق الطلب" };
  }

  async function ask(input = {}) {
    const content = String(input.content ?? "").trim();
    if (!content || content.length > 4000) throw new HttpError(422, "validation", "اكتب طلبك (حتى 4000 حرف)");
    const projectId = input.projectId ? company.getProject(input.projectId).id : null;
    const decision = await route(content, projectId);
    const thread = conversations.create({ agentId: decision.agentId, projectId, title: content.slice(0, 100) });
    const sent = conversations.send(thread.id, { content, idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : undefined });
    return { ...decision, agentName: company.agentById(decision.agentId).name, conversationId: thread.id, runId: sent.run.id };
  }

  return { route, ask };
}
