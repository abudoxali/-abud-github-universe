import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentService, listProcessCounts, matchEncodedProject, parseCodexConfig } from "../src/agents.mjs";
import { DEFAULT_POLICY, evaluatePolicy, loadPolicy, modelAvailability, validatePolicy } from "../src/policy.mjs";
import { createRouterClient, createRouterService } from "../src/omniroute.mjs";
import { TEST_KEY, startStubRouter } from "./fixtures.mjs";

test("codex config reader returns only allowlisted keys and flags router routing by host", () => {
  const toml = [
    'model = "m1"', 'model_provider = "omni"', 'approval_policy = "on-request"', "",
    '[model_providers.omni]', 'name = "OmniRoute"', 'base_url = "http://127.0.0.1:20128/v1"', 'api_key = "SHOULD-NOT-APPEAR"', "",
    '[mcp_servers.x.env]', 'TOKEN = "SHOULD-NOT-APPEAR"'
  ].join("\n");
  const parsed = parseCodexConfig(toml, "127.0.0.1:20128");
  assert.equal(parsed.routedThroughRouter, true);
  assert.equal(parsed.model, "m1");
  assert.doesNotMatch(JSON.stringify(parsed), /SHOULD-NOT-APPEAR/);
  assert.equal(parseCodexConfig(toml, "127.0.0.1:9").routedThroughRouter, false);
});

test("claude project folders map to authorized repositories by encoded path only", () => {
  const repos = [{ rel: "app", dir: "C:\\Users\\me\\Code\\app" }, { rel: "app-2", dir: "C:\\Users\\me\\Code\\app-2" }];
  assert.equal(matchEncodedProject("C--Users-me-Code-app", repos), "app");
  assert.equal(matchEncodedProject("C--Users-me-Code-app--claude-worktrees-feature", repos), "app");
  assert.equal(matchEncodedProject("C--Users-me-Code-app-2", repos), "app-2");
  assert.equal(matchEncodedProject("C--Users-me-Other", repos), null);
});

test("process listing counts only requested image names and reports unavailability", async () => {
  const runImpl = async () => ({ ok: true, stdout: '"codex.exe","1","Console"\n"codex-helper.exe","2","x"\n"Antigravity.exe","3","x"\n' });
  const result = await listProcessCounts(["codex", "antigravity", "claude"], { runImpl, platform: "win32" });
  assert.deepEqual(result.counts, { codex: 1, antigravity: 1, claude: 0 });
  assert.equal((await listProcessCounts(["codex"], { runImpl: async () => ({ ok: false }), platform: "win32" })).available, false);
});

test("agent discovery keeps provider health, process presence and active session as separate facts", async () => {
  const home = await mkdtemp(join(tmpdir(), "abud-home-"));
  await mkdir(join(home, ".codex", "sessions", "2030", "01", "01"), { recursive: true });
  await writeFile(join(home, ".codex", "sessions", "2030", "01", "01", "s.jsonl"), "SESSION-CONTENT-NEVER-READ");
  await writeFile(join(home, ".codex", "config.toml"), 'model = "m"\n');
  const runImpl = async (file, args) => {
    if (file === "powershell.exe") return { ok: true, stdout: args.join(" ").includes("OpenAI.Codex") ? "1.2.3.4\n" : "5.6.7\n" };
    if (file === "claude") return { ok: true, stdout: "9.9.9 (Claude Code)" };
    if (file === "tasklist") return { ok: true, stdout: '"codex.exe","1"\n' };
    return { ok: false, reason: "not-found" };
  };
  const stub = await startStubRouter();
  try {
    const overview = await createRouterService({ client: createRouterClient({ env: { OMNIROUTE_BASE_URL: `http://127.0.0.1:${stub.port}`, OMNIROUTE_API_KEY: TEST_KEY } }) }).overview();
    const service = createAgentService({ home, platform: "win32", env: { APPDATA: join(home, "AppData"), LOCALAPPDATA: join(home, "Local") }, runImpl, routerHost: `127.0.0.1:${stub.port}`, repoPaths: () => [] });
    const { agents } = await service.discover({ overview });
    const codex = agents.find((a) => a.id === "codex");
    assert.equal(codex.install.version, "1.2.3.4");
    assert.equal(codex.process.running, true);
    assert.equal(codex.provider.health, "healthy");
    assert.equal(codex.quota.state, "critical");
    assert.equal(codex.activeSession.state, "not-exposed");
    assert.equal(codex.execution.enabled, false);
    assert.equal(codex.quota.nativeStatus.supported, false);
    assert.equal(codex.lastObserved.at !== null, true);
    const agy = agents.find((a) => a.id === "antigravity");
    assert.equal(agy.install.state, "not-found");
    assert.equal(agy.process.running, false);
    assert.equal(agy.provider.health, "degraded", "an exhausted/locked provider does not imply a stopped process, and vice versa");
    assert.equal(agents.find((a) => a.id === "claude-code").install.version, "9.9.9");
    assert.ok(!JSON.stringify(agents).includes("SESSION-CONTENT-NEVER-READ"));
    assert.ok(agents.every((a) => a.execution.enabled === false));
  } finally { await stub.close(); }
});

test("agent discovery without a reachable router reports provider state as unknown, never healthy", async () => {
  const service = createAgentService({ home: await mkdtemp(join(tmpdir(), "abud-home-")), platform: "win32", env: {}, runImpl: async () => ({ ok: false, reason: "not-found" }) });
  const { agents } = await service.discover({ overview: { connection: { state: "offline" }, connections: [] } });
  assert.ok(agents.every((a) => a.provider?.health === "unknown" || a.provider?.health === "not-applicable"));
  assert.ok(agents.every((a) => a.quota.state === "unknown"));
});

test("policy validation rejects unsafe settings and keeps Retry-After mandatory", () => {
  assert.equal(validatePolicy({ version: 1 }).valid, true);
  assert.equal(validatePolicy({ version: 1, retry: { honorRetryAfter: false } }).valid, false);
  assert.equal(validatePolicy({ version: 1, thresholds: { warnPercent: 5, criticalPercent: 10 } }).valid, false);
  assert.equal(validatePolicy({ version: 1, retry: { maxRetries: 50 } }).valid, false);
  assert.equal(validatePolicy({ version: 1, priorityGroups: [{ id: "Bad Id", models: [] }] }).valid, false);
  assert.equal(validatePolicy({ version: 1, fallbackChains: [{ id: "one", steps: ["only-one"] }] }).valid, false);
  assert.equal(validatePolicy("nope").valid, false);
  assert.deepEqual(validatePolicy({ version: 2 }).policy, DEFAULT_POLICY);
});

test("policy loading falls back to defaults when missing and rejects invalid JSON without crashing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abud-pol-"));
  assert.equal((await loadPolicy(join(dir, "missing.json"))).source, "built-in default");
  await writeFile(join(dir, "bad.json"), "{nope");
  const bad = await loadPolicy(join(dir, "bad.json"));
  assert.equal(bad.valid, false);
  assert.equal(bad.policy.retry.maxRetries, 2);
});

test("policy evaluation is advisory: availability from provider-reported windows, chains pick the first usable step, nothing is applied", async () => {
  const stub = await startStubRouter();
  try {
    const overview = await createRouterService({ client: createRouterClient({ env: { OMNIROUTE_BASE_URL: `http://127.0.0.1:${stub.port}`, OMNIROUTE_API_KEY: TEST_KEY } }) }).overview();
    assert.equal(modelAvailability("agy/claude-opus", overview).state, "locked-out");
    assert.equal(modelAvailability("agy/gemini-flash", overview).state, "available");
    assert.equal(modelAvailability("nvidia/anything", overview).state, "unknown");
    const policyState = validatePolicy({ version: 1, fallbackChains: [{ id: "coding", requires: "tools", steps: ["agy/claude-opus", "codex/gpt-x"] }] });
    const result = evaluatePolicy({ policyState: { ...policyState, source: "test" }, overview });
    assert.equal(result.chains[0].firstUsable, "codex/gpt-x");
    assert.equal(result.appliedToRouter, false);
    assert.ok(result.findings.some((f) => f.code === "retry-above-policy"));
    assert.ok(result.findings.some((f) => f.code === "quota-exhausted"));
    assert.ok(stub.hits.every((h) => h.method === "GET"), "evaluation never writes to the router");
  } finally { await stub.close(); }
  const offline = evaluatePolicy({ policyState: { valid: true, errors: [], source: "x", policy: DEFAULT_POLICY }, overview: { connection: { state: "offline" } } });
  assert.equal(offline.findings[0].code, "router-unavailable");
});
