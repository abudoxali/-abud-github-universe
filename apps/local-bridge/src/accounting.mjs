/* Per-agent and per-project resource accounting from persisted evidence only: agent_runs (work), usage_events (tokens
 * and cost as measured by the application), tool_executions (tool audit) and tasks. Cost has three separate bases and
 * is never summed across them: known (a recorded actual), estimated (the router's per-response estimate) and unknown
 * (inference whose cost was not reported — never treated as $0). High token use is reported as use, not productivity. */
import { AGENTS } from "./catalog.mjs";
import { HttpError } from "./company.mjs";

const RANGES = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };

export function createAccounting({ company, now = Date.now }) {
  const { db } = company;
  function report({ range = "30d", agentId = null, projectId = null } = {}) {
    const AGENTS = company.listAgents({ activeOnly: false });
    if (!RANGES[range]) throw new HttpError(422, "validation", "الفترة يجب أن تكون 24h أو 7d أو 30d أو 90d");
    if (agentId && !AGENTS.some((a) => a.id === agentId)) throw new HttpError(404, "not-found", "الوكيل غير موجود");
    if (projectId) company.getProject(projectId);
    const since = new Date(now() - RANGES[range] * 86_400_000).toISOString();
    const scope = (alias = "") => { const w = [`${alias}created_at >= ?`], p = [since]; if (projectId) { w.push(`${alias}project_id = ?`); p.push(projectId); } return { w, p }; };
    const r = scope();
    const runs = db.all(`SELECT id, agent_id, status, parent_run_id, workflow_id, capability, project_id, cost_basis, started_at, finished_at, created_at FROM agent_runs WHERE ${r.w.join(" AND ")} ORDER BY created_at DESC LIMIT 50000`, ...r.p);
    const uw = ["at >= ?"], up = [since];
    if (projectId) { uw.push("project_id = ?"); up.push(projectId); }
    const usage = db.all(`SELECT agent_id, project_id, cost_basis, source, cost_usd, prompt_tokens, completion_tokens, at FROM usage_events WHERE ${uw.join(" AND ")} LIMIT 100000`, ...up);
    const tw = ["started_at >= ?"], tp = [since];
    if (projectId) { tw.push("project_id = ?"); tp.push(projectId); }
    const tools = db.all(`SELECT agent_id, tool_id, status, duration_ms, project_id, started_at FROM tool_executions WHERE ${tw.join(" AND ")} LIMIT 100000`, ...tp);
    const tasks = db.all(`SELECT assignee, status, completed_at, project_id FROM tasks WHERE archived_at IS NULL ${projectId ? "AND project_id = ?" : ""}`, ...(projectId ? [projectId] : []));

    const money = (rows) => {
      const known = rows.filter((u) => u.source === "manual" && u.cost_usd != null);
      const estimated = rows.filter((u) => u.cost_basis === "router-estimate" && u.cost_usd != null && u.source !== "manual");
      return { knownUsd: round(known.reduce((s, u) => s + u.cost_usd, 0)), knownEvents: known.length, estimatedUsd: round(estimated.reduce((s, u) => s + u.cost_usd, 0)), estimatedEvents: estimated.length,
        unknownEvents: rows.filter((u) => u.cost_usd == null).length };
    };
    // Rows are grouped once (one pass each), so the report stays linear in the ledger size.
    const group = (rows, key) => { const map = new Map(); for (const r of rows) { const k = r[key]; if (!map.has(k)) map.set(k, []); map.get(k).push(r); } return map; };
    const runsBy = group(runs, "agent_id"), usageBy = group(usage, "agent_id"), toolsBy = group(tools, "agent_id");
    const agents = (agentId ? AGENTS.filter((a) => a.id === agentId) : AGENTS).map((a) => {
      const mine = runsBy.get(a.id) ?? [];
      const u = usageBy.get(a.id) ?? [];
      const t = toolsBy.get(a.id) ?? [];
      const done = mine.filter((x) => x.started_at && x.finished_at);
      const assigned = tasks.filter((x) => x.assignee === a.id);
      return {
        agentId: a.id, name: a.name, color: a.color,
        requests: mine.length, topLevel: mine.filter((x) => !x.parent_run_id).length, delegated: mine.filter((x) => x.parent_run_id).length,
        succeeded: mine.filter((x) => x.status === "succeeded").length, failed: mine.filter((x) => x.status === "failed").length, blocked: mine.filter((x) => x.status === "blocked").length, cancelled: mine.filter((x) => x.status === "cancelled").length,
        toolCalls: t.length, toolSucceeded: t.filter((x) => x.status === "succeeded").length, toolDenied: t.filter((x) => x.status === "denied").length,
        inferences: u.length, inputTokens: u.reduce((s, x) => s + (x.prompt_tokens || 0), 0), outputTokens: u.reduce((s, x) => s + (x.completion_tokens || 0), 0),
        cost: { ...money(u), noInferenceRuns: mine.filter((x) => x.cost_basis === "no-inference").length },
        avgExecutionMs: done.length ? Math.round(done.reduce((s, x) => s + (Date.parse(x.finished_at) - Date.parse(x.started_at)), 0) / done.length) : null,
        assignedOpenTasks: assigned.filter((x) => !["done", "cancelled"].includes(x.status)).length, completedTasks: assigned.filter((x) => x.status === "done" && x.completed_at >= since).length,
        projects: [...new Set(mine.map((x) => x.project_id).filter(Boolean))].map((id) => ({ id, name: projectName(id) })),
        recent: mine.slice(0, 6).map((x) => ({ id: x.id, capability: x.capability, status: x.status, at: x.created_at, workflowId: x.workflow_id }))
      };
    });
    const sum = (key) => agents.reduce((s, a) => s + a[key], 0);
    const totals = { requests: sum("requests"), succeeded: sum("succeeded"), failed: sum("failed"), toolCalls: sum("toolCalls"), inferences: sum("inferences"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"),
      cost: money(agentId ? usage.filter((x) => x.agent_id === agentId) : usage), workflows: new Set(runs.map((x) => x.workflow_id).filter(Boolean)).size };
    // Reconciliation: the per-agent figures must add up to direct counts over the same persisted rows.
    const scopedRuns = agentId ? runs.filter((x) => x.agent_id === agentId) : runs.filter((x) => AGENTS.some((a) => a.id === x.agent_id));
    const scopedUsage = agentId ? usage.filter((x) => x.agent_id === agentId) : usage.filter((x) => AGENTS.some((a) => a.id === x.agent_id));
    const reconciliation = {
      runs: { perAgentSum: totals.requests, direct: scopedRuns.length }, inputTokens: { perAgentSum: totals.inputTokens, direct: scopedUsage.reduce((s, x) => s + (x.prompt_tokens || 0), 0) },
      toolCalls: { perAgentSum: totals.toolCalls, direct: agentId ? tools.filter((x) => x.agent_id === agentId).length : tools.length }
    };
    reconciliation.ok = Object.values(reconciliation).every((v) => typeof v !== "object" || v.perAgentSum === v.direct);
    const runsByProject = group(runs.filter((x) => x.project_id), "project_id"), usageByProject = group(usage.filter((x) => x.project_id), "project_id"), toolsByProject = group(tools.filter((x) => x.project_id), "project_id");
    const projects = projectId ? [] : [...runsByProject.keys()].map((id) => {
      const pr = runsByProject.get(id), pu = usageByProject.get(id) ?? [];
      return { id, name: projectName(id), requests: pr.length, agents: [...new Set(pr.map((x) => x.agent_id))], inputTokens: pu.reduce((s, x) => s + (x.prompt_tokens || 0), 0), outputTokens: pu.reduce((s, x) => s + (x.completion_tokens || 0), 0), cost: money(pu),
        toolCalls: (toolsByProject.get(id) ?? []).length };
    }).sort((a, b) => b.requests - a.requests).slice(0, 25);
    const days = [];
    for (let d = Math.min(RANGES[range], 30) - 1; d >= 0; d--) days.push(new Date(now() - d * 86_400_000).toISOString().slice(0, 10));
    const byDay = new Map(days.map((day) => [day, { day, byAgent: Object.fromEntries(AGENTS.map((a) => [a.id, 0])), tokens: 0 }]));
    for (const x of runs) { const slot = byDay.get(x.created_at.slice(0, 10)); if (slot && x.agent_id in slot.byAgent) slot.byAgent[x.agent_id]++; }
    for (const x of usage) { const slot = byDay.get(x.at.slice(0, 10)); if (slot) slot.tokens += (x.prompt_tokens || 0) + (x.completion_tokens || 0); }
    const daily = [...byDay.values()];
    return { range, since, scope: { agentId, projectId }, agents, totals, projects, daily, reconciliation, generatedAt: new Date(now()).toISOString(),
      basis: "Persisted company records: agent_runs, usage_events (application-measured), tool_executions, tasks. Estimated cost is the router's per-response estimate, not a bill. Unknown cost is counted separately and never as $0. Token volume is not a productivity measure." };
  }
  const names = new Map();
  function projectName(id) { if (!names.has(id)) { try { names.set(id, company.getProject(id).name); } catch (_) { names.set(id, null); } } return names.get(id); }
  return { report: (opts) => { names.clear(); return report(opts); } };
}
const round = (v) => Math.round(v * 1e6) / 1e6;
