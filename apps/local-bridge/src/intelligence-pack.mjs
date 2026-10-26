/* Imports owner-authored profile and operating context into the existing scoped memory store.
 * It deliberately ignores implementation specs, runtime infrastructure, credentials and model/account snapshots. */

const section = (markdown, expression, nextExpression) => {
  const lines = String(markdown).split(/\r?\n/);
  const start = lines.findIndex((line) => expression.test(line));
  if (start < 0) throw new Error(`Required intelligence-pack section is missing: ${expression}`);
  const end = lines.findIndex((line, index) => index > start && nextExpression.test(line));
  return lines.slice(start, end < 0 ? lines.length : end).join("\n").trim();
};

const subsection = (markdown, id) => section(markdown, new RegExp(`^### ${id.replaceAll(".", "\\.")}\\b`), /^###?\s/);
const major = (markdown, id) => section(markdown, new RegExp(`^## ${id.replaceAll(".", "\\.")}\\b`), /^##\s/);
const joinSections = (markdown, refs) => refs.map((ref) => ref.startsWith("##")
  ? major(markdown, ref.slice(2))
  : subsection(markdown, ref)).join("\n\n");

const RECORDS = [
  {
    key: "owner-profile",
    scope: "owner",
    scopeRef: "",
    kind: "fact",
    confidence: "supported",
    title: "Agent Intelligence Pack v1 — owner identity and capabilities",
    sourceRef: "owner-document:ABUD_FUN_AGENT_INTELLIGENCE_PACK_v1.md#sections-2.1-2.2",
    sections: ["2.1", "2.2"]
  },
  {
    key: "owner-workstyle",
    scope: "owner",
    scopeRef: "",
    kind: "preference",
    confidence: "verified",
    title: "Agent Intelligence Pack v1 — Abdullah's working style and success criteria",
    sourceRef: "owner-document:ABUD_FUN_AGENT_INTELLIGENCE_PACK_v1.md#sections-2.3-2.4",
    sections: ["2.3", "2.4"]
  },
  {
    key: "company-profile",
    scope: "company",
    scopeRef: "",
    kind: "fact",
    confidence: "supported",
    title: "Agent Intelligence Pack v1 — ABUD FUN identity and positioning",
    sourceRef: "owner-document:ABUD_FUN_AGENT_INTELLIGENCE_PACK_v1.md#sections-3.1-3.3",
    sections: ["3.1", "3.2", "3.3"]
  },
  {
    key: "company-communications",
    scope: "company",
    scopeRef: "",
    kind: "procedural",
    confidence: "verified",
    title: "Agent Intelligence Pack v1 — brand, content and publication policy",
    sourceRef: "owner-document:ABUD_FUN_AGENT_INTELLIGENCE_PACK_v1.md#sections-6.1-6.4",
    sections: ["6.1", "6.2", "6.3", "6.4"]
  },
  {
    key: "owner-career-and-channels",
    scope: "owner",
    scopeRef: "",
    kind: "fact",
    confidence: "supported",
    title: "Agent Intelligence Pack v1 — professional profile and official channels",
    sourceRef: "owner-document:ABUD_FUN_AGENT_INTELLIGENCE_PACK_v1.md#sections-4-5.1",
    sections: ["##4", "5.1"]
  },
  {
    key: "engineering-workflow",
    scope: "owner",
    scopeRef: "",
    kind: "procedural",
    confidence: "verified",
    title: "Agent Intelligence Pack v1 — engineering delivery workflow",
    sourceRef: "owner-document:ABUD_FUN_AGENT_INTELLIGENCE_PACK_v1.md#sections-7.1-7.4",
    sections: ["7.1", "7.2", "7.3", "7.4"]
  }
];

/** Extracts only owner/company profile and working guidance; operational snapshots and implementation specs stay out. */
export function intelligencePackRecords(markdown) {
  const prepared = String(markdown).match(/^> \*\*Version:\*\* [^|]+\| \*\*Prepared:\*\* (\d{4}-\d{2}-\d{2})/m)?.[1] ?? null;
  return RECORDS.map((record) => ({
    ...record,
    body: joinSections(markdown, record.sections),
    sourceAt: prepared ? `${prepared}T00:00:00.000Z` : null,
    sensitivity: "internal",
    approved: true,
    evidence: [`Owner-provided ABUD_FUN_AGENT_INTELLIGENCE_PACK_v1.md; ${record.sourceRef}; user requested agent learning from this source.`]
  }));
}

/** Idempotently imports the selected records into the current scoped memory system. */
export function importIntelligencePack({ company, markdown }) {
  const imported = [];
  for (const record of intelligencePackRecords(markdown)) {
    const existing = company.listMemory({ scope: record.scope, scopeRef: record.scopeRef, state: null })
      .find((note) => note.sourceRef === record.sourceRef);
    if (existing?.body === record.body && existing.approved && existing.sensitivity === record.sensitivity) {
      imported.push({ key: record.key, id: existing.id, state: "unchanged" });
      continue;
    }
    const [saved] = company.upsertMemory({ ...record, ...(existing ? { id: existing.id } : {}) }, { type: "owner", id: "owner" });
    imported.push({ key: record.key, id: saved.id, state: existing ? "updated" : "created" });
  }
  return imported;
}
