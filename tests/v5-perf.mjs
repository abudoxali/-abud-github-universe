/* Measured V5 performance: (1) API latency on an ISOLATED dev bridge, (2) accounting and registry cost on a large
 * synthetic ledger in memory. Usage: node tests/v5-perf.mjs <origin> */
import { openDatabase } from "../apps/local-bridge/src/db.mjs";
import { createCompany } from "../apps/local-bridge/src/company.mjs";
import { createAccounting } from "../apps/local-bridge/src/accounting.mjs";
const origin = process.argv[2] || "http://127.0.0.1:4191";
if (!/^http:\/\/127\.0\.0\.1:41(8\d|9\d)$/.test(origin)) throw new Error("isolated dev bridge only");
const q = (arr, p) => +[...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(1);
const out = { api: {}, ledger: null };
for (const path of ["/summary", "/capabilities", "/workflows?limit=25", "/accounting?range=30d", "/conversations?limit=50", "/executions?limit=30", "/artifacts?limit=60", "/memory"]) {
  const times = [];
  for (let i = 0; i < 12; i++) { const t = performance.now(); const r = await fetch(`${origin}/local-api/company${path}`); await r.arrayBuffer(); times.push(performance.now() - t); }
  out.api[path] = { p50ms: q(times.slice(2), 0.5), p95ms: q(times.slice(2), 0.95) };
}
const company = createCompany({ db: openDatabase(":memory:") });
company.seed();
const agents = ["ori", "mia", "nex", "luna", "zen", "rex"];
const t0 = performance.now();
company.db.tx(() => {
  for (let i = 0; i < 20000; i++) {
    const at = new Date(Date.now() - (i % 30) * 86_400_000 - i * 1000).toISOString();
    const a = agents[i % 6];
    company.db.run("INSERT INTO agent_runs (id, agent_id, capability, domain, mode, priority, request, status, created_at, started_at, finished_at, cost_basis) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", `run_p${i}`, a, "chat", "general", "standard", "medium", "x", i % 9 ? "succeeded" : "failed", at, at, at, i % 3 ? "unknown" : "router-estimate");
    company.db.run("INSERT INTO usage_events (at, run_id, agent_id, provider, model, prompt_tokens, completion_tokens, cost_usd, cost_basis, source) VALUES (?,?,?,?,?,?,?,?,?,?)", at, `run_p${i}`, a, "gemini", "gemini/x", 400, 120, i % 3 ? null : 0.001, i % 3 ? "unknown" : "router-estimate", "application-measured");
    company.db.run("INSERT INTO tool_executions (id, tool_id, tool_version, agent_id, actor_type, actor_id, status, started_at, finished_at, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?)", `exe_p${i}`, "company.overview", "5.0", a, "agent", a, "succeeded", at, at, 12);
  }
});
const seedMs = performance.now() - t0;
const acct = createAccounting({ company });
const times = [];
let rep;
for (let i = 0; i < 5; i++) { const t = performance.now(); rep = acct.report({ range: "30d" }); times.push(performance.now() - t); }
const plan = company.db.all("EXPLAIN QUERY PLAN SELECT id FROM agent_runs WHERE created_at >= ?", new Date(0).toISOString()).map((r) => r.detail);
out.ledger = { rows: { runs: 20000, usage: 20000, toolExecutions: 20000 }, seedMs: Math.round(seedMs), accounting30dMs: { p50: q(times, 0.5), max: q(times, 1) }, reconciled: rep.reconciliation.ok, requests: rep.totals.requests, unknownCost: rep.totals.cost.unknownEvents, runsQueryPlan: plan };
console.log(JSON.stringify(out, null, 1));
