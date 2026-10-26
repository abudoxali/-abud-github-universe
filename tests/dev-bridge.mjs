/* Isolated development bridge for interactive V5 checks: synthetic stub OmniRoute, a temporary SQLite file and a temporary
 * workspace with sample repositories. It never reads local/company.db, local/vps.json or any other private file.
 * Usage: node tests/dev-bridge.mjs [port=4191]   (Ctrl+C stops it and removes the temporary folder). */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../apps/local-bridge/src/server.mjs";
import { TEST_KEY, startStubRouter } from "../apps/local-bridge/tests/fixtures.mjs";

const port = Number(process.argv[2] || process.env.LOCAL_UNIVERSE_PORT || 4191);
const work = await mkdtemp(join(tmpdir(), "abud-dev-bridge-"));
const workspace = join(work, "GitHub");
await mkdir(workspace);
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
for (const [name, status] of [["atlas-web", "Active — sprint 4"], ["nova-api", "Blocked on review"]]) {
  const dir = join(workspace, name);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), `# ${name}\nSynthetic development repository.\n`);
  await writeFile(join(dir, "STATUS.md"), `# ${name}\nUpdated: 2026-10-25\nState: ${status}\n`);
  await writeFile(join(dir, "package-lock.json"), JSON.stringify({ name, lockfileVersion: 3, packages: { "": { name } } }));
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "init");
  git(dir, "remote", "add", "origin", `https://github.com/example/${name}.git`);
}
await writeFile(join(work, "worlds.json"), JSON.stringify({ githubOwner: "example", worlds: [] }));
// Scopes live in a config file (not an environment variable) so the owner-managed folder flow can be exercised.
await writeFile(join(work, "workspace.json"), JSON.stringify({ roots: [{ path: workspace, label: "عمل تجريبي" }] }));
// Synthetic model replies that cite the evidence ids they were given, so the Operations Room shows a realistic synthesis.
const FENCE = "```";
// A meeting chair's closing turn gets a structured outcome block, so the Meeting Center's confirm/reject flow is testable.
const MEETING_SUMMARY = `ملخص تجريبي للاجتماع.
${"```"}json
${JSON.stringify({ summary: "راجع الفريق أولويات الأسبوع (رد تجريبي).", decisions: ["التركيز على إصدار V6 هذا الأسبوع"], action_items: [{ title: "تجهيز خطة اختبار الإصدار", responsible: "luna", due: "2026-11-02" }], open_questions: ["هل نحتاج ميزانية نماذج إضافية؟"], disagreements: ["REX يفضّل تأجيل الإصدار حتى اكتمال المراجعة الأمنية"], follow_ups: [] })}
${"```"}`;
const stub = await startStubRouter({ chat: (model, body) => body?.messages?.at(-1)?.content?.includes("انتهى اجتماع") ? { status: 200, headers: { "x-omniroute-provider": "nvidia", "x-omniroute-model": model.split("/").slice(1).join("/") }, body: { model, usage: { prompt_tokens: 900, completion_tokens: 220 }, choices: [{ message: { role: "assistant", content: MEETING_SUMMARY } }] } } : ({ status: 200, headers: { "x-omniroute-provider": "nvidia", "x-omniroute-model": model.split("/").slice(1).join("/") },
  body: { model, usage: { prompt_tokens: 820, completion_tokens: 160 }, choices: [{ message: { role: "assistant", content: `## الخلاصة (رد تجريبي من خادم اختبار)\nالمشروع نشط ولا توجد عوائق حرجة مثبتة [E1]. حالة Git مقروءة [E2]، والفحص الأمني الحتمي لم يجد سرًا [E3].\n\n${FENCE}json\n{"tasks":[{"title":"مراجعة نتائج الفحص الأسبوعي","priority":"medium"}]}\n${FENCE}` } }] } }) });
// DEV_REAL_ROUTER=1 sends the synthetic company's requests to the real local OmniRoute (still a temporary DB and synthetic
// repositories — none of the owner's data) so a developer can verify live model behavior. Models come from DEV_ROUTER_MODELS.
const realRouter = process.env.DEV_REAL_ROUTER === "1";
const liveModels = (process.env.DEV_ROUTER_MODELS || "gemini/gemini-3.1-flash-lite,gemini/gemini-3-flash-preview").split(",").map((m) => m.trim()).filter(Boolean);
const server = createServer({
  configPath: join(work, "worlds.json"), workspaceConfigPath: join(work, "workspace.json"), policyPath: join(work, "policy.json"), dbPath: join(work, "company.db"), backupDir: join(work, "backups"),
  vpsConfigPath: join(work, "no-vps.json"), env: { ...(realRouter ? { OMNIROUTE_BASE_URL: process.env.OMNIROUTE_BASE_URL || "http://localhost:20128", OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY } : { OMNIROUTE_BASE_URL: `http://127.0.0.1:${stub.port}`, OMNIROUTE_API_KEY: TEST_KEY }),
    // The synthetic browser can exercise recognition; local neural TTS is opt-in for this isolated test server.
    ...(process.env.ABUD_LIVE_VOICE_HOME ? { ABUD_LIVE_VOICE_HOME: process.env.ABUD_LIVE_VOICE_HOME, ABUD_LIVE_VOICE_PYTHON: process.env.ABUD_LIVE_VOICE_PYTHON || "" } : {}) },
  startupOptions: { env: {}, platform: "test" }, agentOptions: { home: work, env: {}, runImpl: async () => ({ ok: false, reason: "not-found" }) },
  githubReader: { resolve: async () => ({ state: "unavailable" }), read: async (github) => ({ state: "not-linked", github, fetchedAt: new Date().toISOString(), cached: false, unavailable: [] }) },
  background: true, log: () => {}
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
// Synthetic company data so every workspace has something real to show.
const company = server.company;
for (const p of company.listPolicies()) company.updatePolicy(p.domain, { candidates: realRouter ? liveModels : ["nvidia/model-a", "nvidia/model-b"], maxRetries: 1 });
const sync = await fetch(`http://127.0.0.1:${port}/local-api/company/projects/sync`, { method: "POST", headers: { "Content-Type": "application/json", "X-Abud-Session": (await (await fetch(`http://127.0.0.1:${port}/local-api/session`)).json()).token }, body: "{}" }).then((r) => r.json()).catch(() => null);
const project = company.listProjects().find((p) => p.checkouts.length) || company.listProjects()[0];
if (project && !company.listTasks({ limit: 5 }).length) {
  const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  company.createTask({ title: "مراجعة تصميم صفحة الهبوط", projectId: project.id, assignee: "mia", priority: "high", dueDate: day(2) });
  company.createTask({ title: "تقرير الموارد الأسبوعي", projectId: project.id, assignee: "nex", dueDate: day(5) });
  company.createTask({ title: "فحص أمني قبل الإطلاق", projectId: project.id, assignee: "rex", priority: "high", dueDate: day(-1) });
  company.createTask({ title: "تحديث خطة الإصدار", projectId: project.id, assignee: "luna", status: "blocked", blocker: "بانتظار قرار المالك" });
}
console.log(JSON.stringify({ event: "dev-bridge-ready", url: `http://127.0.0.1:${port}/`, projects: company.listProjects().length, synced: Boolean(sync), data: "synthetic (temporary folder)" }));
const stop = async () => { await new Promise((r) => server.close(r)); await stub.close(); await rm(work, { recursive: true, force: true }).catch(() => {}); process.exit(0); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
