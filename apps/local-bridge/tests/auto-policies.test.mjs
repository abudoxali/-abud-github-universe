/* Owner policy boundaries and additive tool-intelligence persistence. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.mjs";
import { createCompany } from "../src/company.mjs";
import { createAutoPolicies } from "../src/auto-policies.mjs";

test("automatic policies require an owner, granted tier B tool and exact scope", () => {
  const db = openDatabase(":memory:");
  try {
    const company = createCompany({ db });
    company.seed();
    const policies = createAutoPolicies({ company });
    assert.throws(() => policies.create({ agentId: "luna", toolId: "tasks.create" }, { type: "agent", id: "luna" }), { code: "owner-only" });
    assert.throws(() => policies.create({ agentId: "luna", toolId: "tasks.query" }), { code: "invalid-auto-policy" });
    assert.throws(() => policies.create({ agentId: "mia", toolId: "security.scan" }), { code: "invalid-auto-policy" });
    assert.throws(() => policies.create({ agentId: "luna", toolId: "tasks.create", scope: "project" }), { code: "validation" });
    const rule = policies.create({ agentId: "luna", toolId: "tasks.create" });
    assert.equal(policies.create({ agentId: "luna", toolId: "tasks.create" }).id, rule.id);
    assert.equal(policies.allows({ agentId: "luna", toolId: "tasks.create" }), true);
    assert.equal(policies.allows({ agentId: "ori", toolId: "tasks.create" }), false);
    assert.equal(policies.list().length, 1);
    policies.remove(rule.id);
    assert.equal(policies.allows({ agentId: "luna", toolId: "tasks.create" }), false);
    assert.equal(policies.list().length, 0);
    company.syncProjects({ catalog: [{ name: "Alpha" }, { name: "Beta" }], owner: "owner", repos: [] });
    const projects = db.all("SELECT id FROM projects ORDER BY id");
    assert.throws(() => policies.create({ agentId: "luna", toolId: "approvals.followupTasks", scope: "project", projectId: projects[0].id }), { code: "invalid-auto-policy" });
    const scoped = policies.create({ agentId: "luna", toolId: "tasks.create", scope: "project", projectId: projects[0].id });
    assert.equal(policies.allows({ agentId: "luna", toolId: "tasks.create", projectId: projects[0].id }), true);
    assert.equal(policies.allows({ agentId: "luna", toolId: "tasks.create", projectId: projects[1].id }), false);
    assert.equal(policies.allows({ agentId: "luna", toolId: "tasks.create" }), false);
    policies.remove(scoped.id);
    assert.equal(db.all("PRAGMA foreign_key_check").length, 0);
    const columns = db.all("PRAGMA table_info(agent_runs)").map(r => r.name);
    assert.ok(columns.includes("tool_selection"));
    assert.ok(columns.includes("actions_ar"));
  } finally { db.close(); }
});
