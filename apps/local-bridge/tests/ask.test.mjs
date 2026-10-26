/* V6 «اسأل الشركة»: deterministic routing to the right employee, then a normal conversation run. */
import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.mjs";
import { createCompany } from "../src/company.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { createConversations } from "../src/conversations.mjs";
import { createAsk } from "../src/ask.mjs";
import { createRouterClient, createRouterService } from "../src/omniroute.mjs";
import { startStubRouter, TEST_KEY } from "./fixtures.mjs";

test("ask routes by name, by tools/specialization, and falls back to ORI; the request runs as a conversation", async () => {
  const stub = await startStubRouter();
  const client = createRouterClient({ env: { OMNIROUTE_BASE_URL: `http://127.0.0.1:${stub.port}`, OMNIROUTE_API_KEY: TEST_KEY } });
  const service = createRouterService({ client });
  const company = createCompany({ db: openDatabase(":memory:") });
  company.seed();
  for (const policy of company.listPolicies()) company.updatePolicy(policy.domain, { candidates: ["nvidia/model-a"] });
  const runtime = createRuntime({ company, routerClient: client, getOverview: () => service.overview(), getUsage: async () => ({}), workspace: { paths: () => new Map(), scan: async () => ({ repos: [] }) } });
  const conversations = createConversations({ company, runtime });
  runtime.setConversations(conversations);
  const ask = createAsk({ company, runtime, conversations });
  try {
    assert.equal((await ask.route("ريكس، افحص المستودع")).agentId, "rex");
    assert.equal((await ask.route("يا لونا ايه المواعيد الجاية؟")).agentId, "luna");
    assert.equal((await ask.route("راجع استهلاكنا وحالة النماذج")).agentId, "nex");
    assert.equal((await ask.route("صباح الخير، إيه الأخبار؟")).agentId, "ori");
    const result = await ask.ask({ content: "راجع استهلاكنا وحالة النماذج" });
    assert.equal(result.agentId, "nex");
    assert.ok(result.reasonAr);
    const thread = conversations.get(result.conversationId);
    assert.equal(thread.agentId, "nex");
    assert.equal(company.getRun(result.runId).conversationId, result.conversationId);
    await assert.rejects(() => ask.ask({ content: "  " }), (e) => e.status === 422);
  } finally { await runtime.stop(); company.db.close(); await stub.close(); }
});
