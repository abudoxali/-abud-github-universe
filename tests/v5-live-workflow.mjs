/* LIVE verification against the real local OmniRoute, on an ISOLATED bridge with a temporary database (the daily store
 * is never opened). One bounded ORI project review of this public repository (real tools, one free-tier synthesis
 * request) and one minimal V5 chat message. Prints measured results only; no credential is printed.
 * Usage: node tests/v5-live-workflow.mjs */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "../apps/local-bridge/src/server.mjs";

const repoRoot = resolve(".");
const work = await mkdtemp(join(tmpdir(), "abud-live-v5-"));
await writeFile(join(work, "worlds.json"), JSON.stringify({ githubOwner: "abudoxali", worlds: [] }));
const server = createServer({
  configPath: join(work, "worlds.json"), workspaceConfigPath: join(work, "none.json"), policyPath: join(work, "policy.json"), dbPath: join(work, "company.db"), backupDir: join(work, "backups"),
  vpsConfigPath: join(work, "no-vps.json"), env: { ...process.env, ABUD_WORKSPACE_ROOTS: dirname(repoRoot) }, startupOptions: { env: {}, platform: "test" },
  agentOptions: { home: work, env: {}, runImpl: async () => ({ ok: false, reason: "not-found" }) }, background: false, log: () => {}
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const token = (await (await fetch(`${base}/local-api/session`)).json()).token;
const call = async (method, path, body) => { const r = await fetch(`${base}/local-api/company${path}`, { method, headers: { "Content-Type": "application/json", "X-Abud-Session": token }, body: body ? JSON.stringify(body) : undefined }); const d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.message || r.status), { data: d }); return d; };
const out = {};
try {
  const health = await (await fetch(`${base}/local-api/omniroute/overview`)).json();
  out.router = { state: health.connection?.state, version: health.router?.version };
  // Optional: LIVE_CANDIDATES overrides the routing candidates in this TEMPORARY store only (never the daily policies).
  if (process.env.LIVE_CANDIDATES) { for (const p of server.company.listPolicies()) server.company.updatePolicy(p.domain, { candidates: process.env.LIVE_CANDIDATES.split(","), maxRetries: 1, ...(process.env.LIVE_MAX_TOKENS ? { maxOutputTokens: Number(process.env.LIVE_MAX_TOKENS) } : {}) }); out.candidatesOverride = process.env.LIVE_CANDIDATES.split(","); out.maxOutputTokensOverride = process.env.LIVE_MAX_TOKENS ?? null; }
  await call("POST", "/projects/sync", {});
  const project = server.company.listProjects().find((p) => p.checkouts.some((c) => /ABUD FUN Company OS$/i.test(c.rel)));
  if (!project) throw new Error("Company OS checkout not found in the workspace scan");
  out.project = project.name;
  const preview = await call("GET", "/route-preview?agentId=ori");
  out.routeChosen = preview.chosen;
  server.runtime.pump();
  const started = Date.now();
  const wf = await call("POST", "/workflows", { template: "project_review", projectId: project.id, limits: { maxParallel: 3, deadlineMinutes: 5 } });
  let detail;
  for (;;) {
    detail = await call("GET", `/workflows/${wf.id}`);
    if (["succeeded", "partial", "failed", "cancelled", "waiting-approval"].includes(detail.status)) break;
    if (Date.now() - started > 6 * 60_000) throw new Error("live workflow exceeded 6 minutes");
    await new Promise((r) => setTimeout(r, 500));
  }
  const synthRun = server.company.db.get("SELECT * FROM agent_runs WHERE workflow_id = ? AND capability = 'synthesis'", wf.id);
  out.workflow = { id: wf.id, status: detail.status, wallMs: Date.now() - started, steps: detail.steps.map((s) => `${s.key}(${s.agentId}):${s.status}${s.errorCode ? `:${s.errorCode}` : ""}`),
    synthesis: synthRun ? { status: synthRun.status, model: synthRun.effective_model, provider: synthRun.provider, promptTokens: synthRun.prompt_tokens, completionTokens: synthRun.completion_tokens, costUsd: synthRun.cost_usd, costBasis: synthRun.cost_basis, latencyMs: synthRun.latency_ms, error: synthRun.error_category, attempts: (JSON.parse(synthRun.routing || "{}").attempts || []).map((a) => `${a.ref}:${a.code}:${a.message || ""}:${a.latencyMs ?? ""}ms`) } : null,
    cited: detail.steps.find((s) => s.kind === "synthesis")?.output?.cited ?? null, evidence: detail.evidence.length, followups: detail.steps.find((s) => s.kind === "followups")?.output?.summary ?? null,
    reportStart: (detail.steps.find((s) => s.kind === "synthesis")?.output?.text || detail.report || "").slice(0, 700), resources: detail.resources };
  const acct = await call("GET", "/accounting?range=24h");
  out.accounting = { reconciled: acct.reconciliation.ok, requests: acct.totals.requests, inferences: acct.totals.inferences, cost: acct.totals.cost };
  // minimal V5 chat through the conversation service (streamed by the same runtime)
  const thread = await call("POST", "/conversations", { agentId: "luna" });
  const sent = await call("POST", `/conversations/${thread.id}/messages`, { content: "ردّ بكلمة واحدة فقط: جاهز", idempotencyKey: `live-${Date.now()}` });
  let run;
  for (let i = 0; i < 240; i++) { run = await call("GET", `/runs/${sent.run.id}`); if (!["queued", "running"].includes(run.status)) break; await new Promise((r) => setTimeout(r, 500)); }
  const messages = (await call("GET", `/conversations/${thread.id}`)).messages;
  out.chat = { status: run.status, model: run.effectiveModel, promptTokens: run.promptTokens, completionTokens: run.completionTokens, costBasis: run.costBasis, latencyMs: run.latencyMs, reply: messages.find((m) => m.role === "assistant")?.content?.slice(0, 80), error: run.errorCategory };
} catch (error) { out.error = error.message; out.details = error.data; }
console.log(JSON.stringify(out, null, 1));
await new Promise((r) => server.close(r));
await rm(work, { recursive: true, force: true });
