import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.mjs";
import { createCompany } from "../src/company.mjs";
import { importIntelligencePack, intelligencePackRecords } from "../src/intelligence-pack.mjs";

const pack = `# ABUD FUN — Corporate Agent Intelligence & Operating Context Pack
> **Version:** 1.0 | **Prepared:** 2026-10-26 | **Maintainer:** owner

## 0. EXECUTION DIRECTIVE
This implementation text must never be imported as a profile fact.

## 2. OWNER IDENTITY — ABDULLAH RAGAB
### 2.1 Professional identity
Founder of ABUD FUN.
### 2.2 Professional capabilities
TypeScript, JavaScript and AI agents.
### 2.3 Working style — standing owner policies
Talk to Abdullah in practical Egyptian Arabic.
### 2.4 Owner's success criteria
Prioritize real customer value.

## 3. COMPANY IDENTITY — ABUD FUN
### 3.1 Positioning
ABUD FUN builds practical software.
### 3.2 Brand/communications posture
Use evidence-backed claims.
### 3.3 Organization operating model
The owner makes final decisions.

## 4. OFFICIAL IDENTITY, ACCOUNTS & CHANNELS
Professional contact references.
### 4.1 Account-use rules
Drafting and publishing are separate permissions.

## 5. PROFESSIONAL PROFILE, CVs & CAREER ASSETS
### 5.1 CV knowledge
Use the latest verified CV and never invent metrics.

## 6. CONTENT SYSTEM — PERSONAL BRAND & COMPANY COMMUNICATIONS
### 6.1 Content themes
Software building.
### 6.2 LinkedIn publishing policy
Do not auto-publish.
### 6.3 Blog, portfolio, and product content
Show evidence.
### 6.4 Media and publication guardrails
Do not invent testimonials.

## 7. ENGINEERING DELIVERY SYSTEM
### 7.1 Baseline workflow
Inspect, diagnose, implement, verify.
### 7.2 Repository/source-control rules
Preserve local changes.
### 7.3 Tech choice policy
Use the existing architecture.
### 7.4 Product stages and reporting
Distinguish local testing from production verification.

## 8. INFRASTRUCTURE & DEPLOYMENT OPERATIONS
Last-known private host details that must not be imported.
`;

test("intelligence pack imports only owner/company profile and work-style sections with provenance", () => {
  const db = openDatabase(":memory:");
  try {
    const company = createCompany({ db });
    company.seed();
    const extracted = intelligencePackRecords(pack);
    assert.equal(extracted.length, 6);
    assert.ok(extracted.every((note) => note.sourceAt === "2026-10-26T00:00:00.000Z" && note.approved && note.sensitivity === "internal"));
    assert.ok(extracted.every((note) => !note.body.includes("implementation text") && !note.body.includes("private host details")));

    const first = importIntelligencePack({ company, markdown: pack });
    assert.equal(first.filter((note) => note.state === "created").length, 6);
    const second = importIntelligencePack({ company, markdown: pack });
    assert.equal(second.filter((note) => note.state === "unchanged").length, 6);

    const profile = company.searchMemory({ q: "Founder ABUD FUN", agentId: "ori" });
    assert.ok(profile.some((note) => note.sourceRef.endsWith("sections-2.1-2.2")));
    const workstyle = company.listMemory({ scope: "owner", scopeRef: "", kind: "preference" });
    assert.ok(workstyle.some((note) => note.body.includes("practical Egyptian Arabic") && note.confidence === "verified"));
  } finally { db.close(); }
});
