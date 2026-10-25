/* One real, safe execution of the external-facing V5 adapters, in an in-memory store (nothing persisted):
 *  - REX gitleaks over this public repository's own recent history (offline),
 *  - REX osv-scanner over a SYNTHETIC lockfile (only the public package name/version reaches api.osv.dev),
 *  - ZEN extraction of one public page from a default approved host.
 * Usage: node tests/v5-live-capabilities.mjs */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../apps/local-bridge/src/db.mjs";
import { createCompany } from "../apps/local-bridge/src/company.mjs";
import { createRuntime } from "../apps/local-bridge/src/runtime.mjs";
import { createKnowledge } from "../apps/local-bridge/src/knowledge.mjs";

const repoRoot = resolve(".");
const synthetic = await mkdtemp(join(tmpdir(), "abud-osv-live-"));
execFileSync("git", ["init", "-q"], { cwd: synthetic });
await writeFile(join(synthetic, "package-lock.json"), JSON.stringify({ name: "osv-live-sample", lockfileVersion: 3, requires: true, packages: { "": { name: "osv-live-sample", dependencies: { lodash: "4.17.15" } }, "node_modules/lodash": { version: "4.17.15", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz" } } }));
const company = createCompany({ db: openDatabase(":memory:") });
company.seed();
company.syncProjects({ catalog: [{ name: "CompanyOS" }, { name: "OsvSample" }], owner: "owner", repos: [{ rel: "CompanyOS", state: "ready", remote: { kind: "github", github: "owner/CompanyOS" } }, { rel: "OsvSample", state: "ready", remote: { kind: "github", github: "owner/OsvSample" } }] });
const paths = new Map([["CompanyOS", repoRoot], ["OsvSample", synthetic]]);
const runtime = createRuntime({ company, routerClient: { config: {} }, getOverview: async () => ({ connection: { state: "offline" } }), getUsage: async () => null, workspace: { scan: async () => ({ repos: [] }), paths: () => paths } });
runtime.setKnowledge(createKnowledge({ company }));
const byName = (n) => company.listProjects().find((p) => p.name === n || p.github?.endsWith(`/${n}`));
const owner = { type: "owner", id: "owner" };
const out = {};
try {
  const leaks = await runtime.executeCapability({ agentId: "rex", toolId: "security.gitleaks", input: { projectId: byName("CompanyOS").id, mode: "history" } }, owner);
  out.gitleaks = { status: leaks.execution.status, ms: leaks.execution.durationMs, findings: leaks.result.findings, rules: [...new Set(leaks.result.checkouts.flatMap((c) => (c.findings || []).map((f) => f.rule)))], files: [...new Set(leaks.result.checkouts.flatMap((c) => (c.findings || []).map((f) => f.file)))].slice(0, 10), scanOk: leaks.result.checkouts.every((c) => c.ok), repoConfig: leaks.result.checkouts[0]?.repoConfig };
} catch (error) { out.gitleaks = { error: error.code, message: error.messageAr || error.message }; }
try {
  const osv = await runtime.executeCapability({ agentId: "rex", toolId: "security.osv", input: { projectId: byName("OsvSample").id }, confirm: true }, owner);
  const pkg = osv.result.checkouts[0]?.vulnerable?.[0];
  out.osv = { status: osv.execution.status, ms: osv.execution.durationMs, vulnerablePackages: osv.result.vulnerablePackages, sample: pkg ? { name: pkg.name, version: pkg.version, advisories: pkg.advisories.map((a) => a.id).slice(0, 6), fixed: [...new Set(pkg.advisories.flatMap((a) => a.fixed))].slice(0, 4) } : null, approvalRecorded: osv.execution.input._approval };
} catch (error) { out.osv = { error: error.code, message: error.messageAr || error.message }; }
try {
  const page = await runtime.executeCapability({ agentId: "zen", toolId: "web.extract", input: { url: "https://nodejs.org/en/about", ingest: true } }, owner);
  out.web = { status: page.execution.status, ms: page.execution.durationMs, url: page.result.url, redirects: page.result.redirects, title: page.result.title, characters: page.result.characters, suspectedInstructions: page.result.suspectedInstructions, knowledgeDocumentId: page.result.knowledgeDocumentId, excerptStart: page.result.excerpt.slice(0, 140) };
  out.webSearch = (await runtime.executeCapability({ agentId: "zen", toolId: "knowledge.search", input: { q: "Node.js asynchronous" } }, owner)).result.results.slice(0, 2).map((r) => ({ citation: r.citation, title: r.title }));
} catch (error) { out.web = { error: error.code, message: error.messageAr || error.message }; }
out.audit = runtime.listExecutions({ limit: 20 }).map((e) => `${e.toolId}:${e.status}`);
console.log(JSON.stringify(out, null, 1));
await rm(synthetic, { recursive: true, force: true });
