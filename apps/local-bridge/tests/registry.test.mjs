/* V6 Dynamic Agent Registry tests: seeding, CRUD, templates, validation, migration from schema 11. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MIGRATIONS, openDatabase, nowIso } from "../src/db.mjs";
import { createCompany } from "../src/company.mjs";
import { createRegistry } from "../src/registry.mjs";
import { AGENTS, AGENT_TEMPLATES } from "../src/catalog.mjs";

describe("V6 Agent Registry", () => {
  const tempDb = () => openDatabase(":memory:");

  it("seeds built-in agent profiles idempotently", () => {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });

    // First seed
    const result1 = registry.seedBuiltinProfiles();
    assert.equal(result1.seeded, 6);

    // Verify all six built-ins exist with correct profile data
    const agents = registry.list({ activeOnly: false });
    assert.equal(agents.length, 6);

    const ori = agents.find((a) => a.id === "ori");
    assert.ok(ori.builtin);
    assert.equal(ori.name, "ORI");
    assert.equal(ori.titleAr, "القائد");
    assert.ok(ori.specializations.length > 0);
    assert.ok(ori.active);

    // Second seed (idempotent, no duplicates)
    const result2 = registry.seedBuiltinProfiles();
    assert.equal(result2.seeded, 6);
    assert.equal(registry.list({ activeOnly: false }).length, 6);
  });

  it("lists active agents only by default", () => {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });
    registry.seedBuiltinProfiles();

    // Create and deactivate a custom agent
    const { id } = registry.createFromTemplate({
      templateId: "analyst", id: "sam", name: "Sam", titleAr: "المحلل الثاني",
      roleAr: "تحليل", summaryAr: "محلل تجريبي", specializations: []
    });
    registry.deactivate(id);

    const activeList = registry.list({ activeOnly: true });
    assert.equal(activeList.length, 6); // six built-ins only
    assert.ok(!activeList.some((a) => a.id === "sam"));

    const allList = registry.list({ activeOnly: false });
    assert.equal(allList.length, 7); // six built-ins + sam
    assert.ok(allList.some((a) => a.id === "sam"));
  });

  it("creates agent from template with tool subset validation", () => {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });
    registry.seedBuiltinProfiles();

    const analystTemplate = AGENT_TEMPLATES.find((t) => t.id === "analyst");
    const allowedTools = analystTemplate.allowedTools.slice(0, 3);

    const result = registry.createFromTemplate({
      templateId: "analyst", id: "alex", name: "Alex", titleAr: "محلل",
      roleAr: "التحليل", summaryAr: "محلل مخصص", specializations: ["test"],
      tools: allowedTools, mode: "analytical", instructions: "test instructions"
    });

    assert.equal(result.id, "alex");

    const agent = registry.get("alex");
    assert.equal(agent.name, "Alex");
    assert.equal(agent.templateId, "analyst");
    assert.deepEqual(agent.tools, allowedTools);
    assert.equal(agent.mode, "analytical");
    assert.equal(agent.instructions, "test instructions");
    assert.ok(!agent.builtin);
    assert.ok(agent.active);

    // Voice profile defaults to provisional
    assert.equal(agent.voiceProfile.status, "provisional");
  });

  it("rejects agent creation with tools beyond template", () => {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });
    registry.seedBuiltinProfiles();

    const analystTemplate = AGENT_TEMPLATES.find((t) => t.id === "analyst");
    const unauthorizedTools = [...analystTemplate.allowedTools, "router.settings.propose"];

    assert.throws(() => {
      registry.createFromTemplate({
        templateId: "analyst", id: "bad", name: "Bad", titleAr: "سيء",
        roleAr: "test", summaryAr: "test", tools: unauthorizedTools
      });
    }, (err) => err.code === "tools-not-allowed");
  });

  it("rejects invalid agent id format", () => {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });
    registry.seedBuiltinProfiles();

    const invalidIds = ["1bad", "A-upper", "bad@symbol", "x", "a".repeat(25)];
    for (const id of invalidIds) {
      assert.throws(() => {
        registry.createFromTemplate({
          templateId: "analyst", id, name: "Test", titleAr: "test",
          roleAr: "test", summaryAr: "test"
        });
      }, (err) => err.code === "invalid-agent-id");
    }
  });

  it("updates owner-editable fields only", () => {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });
    registry.seedBuiltinProfiles();

    registry.createFromTemplate({
      templateId: "coordinator", id: "coord1", name: "Coordinator", titleAr: "المنسق",
      roleAr: "التنسيق", summaryAr: "منسق"
    });

    const before = registry.get("coord1");

    registry.update("coord1", {
      name: "Updated Coordinator",
      titleAr: "المنسق المحدث",
      specializations: ["new spec"],
      mode: "execution",
      instructions: "new instructions"
    });

    const after = registry.get("coord1");
    assert.equal(after.name, "Updated Coordinator");
    assert.equal(after.titleAr, "المنسق المحدث");
    assert.deepEqual(after.specializations, ["new spec"]);
    assert.equal(after.mode, "execution");
    assert.equal(after.instructions, "new instructions");

    // Template, tools, domain stay unchanged
    assert.equal(after.templateId, before.templateId);
    assert.deepEqual(after.tools, before.tools);
    assert.equal(after.policyDomain, before.policyDomain);
  });

  it("deactivates custom agent but refuses built-in deactivation", () => {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });
    registry.seedBuiltinProfiles();

    const { id } = registry.createFromTemplate({
      templateId: "analyst", id: "test1", name: "Test", titleAr: "test",
      roleAr: "test", summaryAr: "test"
    });

    registry.deactivate(id);
    const agent = registry.get(id);
    assert.ok(!agent.active);

    // Built-in deactivation refused
    assert.throws(() => {
      registry.deactivate("ori");
    }, (err) => err.code === "builtin-cannot-deactivate");
  });

  it("reactivates deactivated agent", () => {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });
    registry.seedBuiltinProfiles();

    const { id } = registry.createFromTemplate({
      templateId: "operations", id: "ops1", name: "Ops", titleAr: "test",
      roleAr: "test", summaryAr: "test"
    });

    registry.deactivate(id);
    assert.ok(!registry.get(id).active);

    registry.activate(id);
    assert.ok(registry.get(id).active);
  });

  it("lists all templates with metadata", () => {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });

    const templates = registry.listTemplates();
    assert.equal(templates.length, 6);

    const coordinator = templates.find((t) => t.id === "coordinator");
    assert.equal(coordinator.basedOn, "ori");
    assert.ok(coordinator.allowedToolsCount > 0);
    assert.ok(coordinator.capabilities.length > 0);
    assert.equal(coordinator.defaultDomain, "general");
  });

  it("gets template by id with full details", () => {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });

    const template = registry.getTemplate("security");
    assert.equal(template.basedOn, "rex");
    assert.ok(Array.isArray(template.allowedTools));
    assert.ok(template.allowedTools.length > 0);
    assert.equal(template.defaultMode, "strict");
  });

  it("validates assignee against active agents in tasks", () => {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });
    registry.seedBuiltinProfiles();

    // Create and deactivate custom agent
    registry.createFromTemplate({
      templateId: "analyst", id: "inactive1", name: "Inactive", titleAr: "test",
      roleAr: "test", summaryAr: "test"
    });
    registry.deactivate("inactive1");

    // Task with active agent succeeds
    const task1 = company.createTask({ title: "Test task", assignee: "ori" });
    assert.equal(task1.assignee, "ori");

    // Task with inactive agent fails
    assert.throws(() => {
      company.createTask({ title: "Bad task", assignee: "inactive1" });
    }, (err) => err.code === "validation");
  });

  it("validates conversation creation against active agents", async () => {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });
    const conversations = { company, runtime: null };
    const { createConversations } = await import("../src/conversations.mjs");
    const conv = createConversations(conversations);

    registry.seedBuiltinProfiles();

    // Create and deactivate custom agent
    registry.createFromTemplate({
      templateId: "designer", id: "inactive2", name: "Inactive", titleAr: "test",
      roleAr: "test", summaryAr: "test"
    });
    registry.deactivate("inactive2");

    // Conversation with inactive agent fails
    assert.throws(() => {
      conv.create({ agentId: "inactive2", title: "Test" });
    }, (err) => err.status === 422);
  });

  it("migrates a real schema 11 retaining rows, indexes, triggers and foreign keys", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys=ON");
    for (const migration of MIGRATIONS.filter(m => m.version <= 11)) {
      raw.exec("PRAGMA foreign_keys=OFF"); raw.exec(migration.sql); raw.exec("PRAGMA foreign_keys=ON");
    }
    const at = nowIso();
    raw.prepare("INSERT INTO agents VALUES (?,?,?,?,?,?,?,?)").run("ori", 0, "standard", "keep", "general", "model/ref", "[]", at);
    raw.prepare("INSERT INTO tasks (id,title,assignee,created_at,updated_at) VALUES (?,?,?,?,?)").run("task", "preserved", "ori", at, at);
    raw.prepare("INSERT INTO task_events(task_id,at,actor,kind) VALUES (?,?,?,?)").run("task", at, "owner", "created");
    raw.prepare("INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?)").run("conv", "ori", null, "task", "thread", "active", at, at);
    const schema = raw.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all();
    raw.exec("PRAGMA foreign_keys=OFF; BEGIN"); raw.exec(MIGRATIONS.find(m => m.version === 12).sql); raw.exec("COMMIT; PRAGMA foreign_keys=ON");
    assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
    for (const obj of schema) assert.equal(raw.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(obj.name).sql, obj.sql);
    assert.equal(raw.prepare("SELECT instructions FROM agents").get().instructions, "keep");
    assert.equal(raw.prepare("SELECT count(*) n FROM task_events").get().n, 1);
    assert.equal(raw.prepare("SELECT task_id FROM conversations").get().task_id, "task");
    for (const id of ["ab!", "a.b", "a B", "aé"]) assert.throws(() => raw.prepare("UPDATE agents SET id=?").run(id));
    raw.close();
  });

  it("preserves owner profiles and enforces deletion and dynamic runtime grants", async () => {
    const db = tempDb(), company = createCompany({ db }); company.seed();
    const registry = company.registry;
    registry.update("ori", { name: "Owner name", specializations: ["owner specialty"] }); company.seed();
    assert.equal(registry.get("ori").name, "Owner name");
    assert.deepEqual(registry.get("ori").specializations, ["owner specialty"]);
    assert.throws(() => registry.remove("ori"), e => e.code === "builtin-cannot-delete");
    registry.createFromTemplate({ templateId: "analyst", id: "custom_analyst-123", name: "Custom", titleAr: "Analyst", roleAr: "Analysis", summaryAr: "Test", tools: ["tasks.query", "telemetry.agentStats"] });
    const id = "custom_analyst-123";
    company.updateAgent(id, { tools: ["tasks.query"] });
    assert.throws(() => company.updateAgent(id, { tools: ["router.settings.propose"] }));
    const { createRuntime } = await import("../src/runtime.mjs");
    const runtime = createRuntime({ company, routerClient: {}, getOverview: async () => ({ connection: { state: "disconnected" } }), getUsage: async () => ({}), workspace: { paths: () => new Map() } });
    assert.ok(runtime.catalogView().agents.some(a => a.id === id));
    const result = await runtime.invokeTool(id, "tasks.query", {}, {}); assert.ok(Array.isArray(result.tasks));
    registry.deactivate(id);
    await assert.rejects(runtime.invokeTool(id, "tasks.query", {}, {}), e => e.code === "agent-disabled");
    assert.throws(() => runtime.enqueue({ agentId: id, request: "test" }), e => e.code === "agent-disabled");
    registry.activate(id);
    db.run("INSERT INTO agent_runs (id,agent_id,capability,domain,mode,priority,request,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)", "run-custom", id, "chat", "analysis", "analytical", "medium", "test", "succeeded", nowIso());
    assert.throws(() => registry.remove(id), e => e.code === "agent-has-runs");
    const { createAccounting } = await import("../src/accounting.mjs");
    const report = createAccounting({ company }).report({ agentId: id }); assert.equal(report.totals.requests, 1); assert.ok(report.reconciliation.ok);
    await runtime.stop(); db.close();
  });

  it("includes specializations in agent profiles", () => {
    const db = tempDb();
    const company = createCompany({ db });
    const registry = createRegistry({ db, company });
    registry.seedBuiltinProfiles();

    const ori = registry.get("ori");
    assert.ok(ori.specializations.includes("تحليل المحفظة"));
    assert.ok(ori.specializations.includes("تنسيق سير العمل"));

    const rex = registry.get("rex");
    assert.ok(rex.specializations.includes("مراجعة سلسلة التوريد"));
    assert.ok(rex.specializations.includes("ثغرات الاعتماديات"));
  });
});
