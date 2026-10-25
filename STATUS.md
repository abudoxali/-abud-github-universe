# ABUD FUN Company OS — STATUS

## V5 — final release acceptance — 2026-10-26 (Africa/Cairo)

**State: ABUD FUN Company OS V5 — operationally ready, awaiting the owner's manual Windows sign-in acceptance.** Everything else needed for the "Stable Local Release" classification was executed and verified on the owner's daily install. That covers backup and restore rehearsal, an isolated 5→11 migration and rollback rehearsal, the controlled cutover, OmniRoute repair, per-agent acceptance, a real multi-agent workflow, daily UI QA, the launcher and supervisor, read-only VPS checks, full regression and security. The one item that cannot be run from a session is a real Windows sign-out/sign-in; it is listed under owner steps. Branch `codex/v5-agent-intelligence`. The release is one local commit on top of V4.1 `ac7c6e8` (`release: finalize ABUD FUN Company OS V5 local stable`). **Nothing was pushed, merged into `main`, or deployed.**

### Daily runtime (verified)
- The daily Bridge runs V5 from this checkout on `http://127.0.0.1:4172`: apiVersion 5, schema 11, Node 24.11.0, one listener, one bridge process. The sign-in supervisor (alive since the V4.1 acceptance) adopted each restart.
- **Launcher fix (release blocker):** `ABUD-OS.ps1 Get-Health` accepted only apiVersion 3, so starting V5 timed out after 20 s. It now accepts `apiVersion ≥ 3`, which keeps the launcher valid for a V4.1 rollback.
- The launcher's `restart` (clean stop, WAL merged, then start) was run three times. An explicit `stop` → `status` ("stopped", no listener) → `start` was also run, and it came back healthy in about 3 s. A `start` against a healthy Bridge reuses it (`Using the healthy … PID`), with no duplicate process or listener. A conversation, two workflows and all knowledge survived each restart.
- `launcher-state.json`: `lastSuccessAt` is newer than `lastFailure`. The recorded failure is the pre-fix 20 s health timeout at cutover. `ownerStoppedAt` is older than the running session's start, so the supervisor would still recover a crash. Its crash recovery was proven in the V4.1 acceptance (`supervisor restarted the bridge after an unclean exit`) and was not re-triggered on the daily store.

### Database (verified)
- **Pre-cutover preservation:**
  - `refs/backup/v5-rc-pre-cutover` = `b24b5aa` snapshots the uncommitted V5 tree (140 files; only public `*.example.json` from `local/`).
  - Live `VACUUM INTO` backup `local/backups/company-2026-10-25T23-19-55-127Z-561f0e0fae6e.db`: integrity ok, 0 FK violations, schema 5.
  - A restore rehearsal from that copy reproduced every count.
- **Isolated rehearsal on a copy:** 5→11 with integrity ok, 0 FK violations, no row lost, project ids stable, 9/9 task links, policies unchanged, idempotent second start. V4.1 code then served both the schema-5 and the schema-11 copy (40 projects, 9 open tasks, 17 runs). That is the rollback proof.
- **Cutover:** the Bridge's automatic pre-migration copy `company-2026-10-25T23-24-28-967Z-940ccae1bfca.db` matches the pre-cutover counts. Every post-cutover difference was explained (migrations, ledger imports, quota/VPS observations, one activity entry and notification).
- **After acceptance (read-only count):** integrity ok, 0 FK violations, schema 11, 40 tables. projects 40, tasks 19 (9 before + 10 follow-ups LUNA filed from the acceptance workflows), runs 40, workflows 3, tool executions 52, artifacts 6, knowledge documents 1, conversations 1, approvals 3, VPS incidents 4 (all recovered).

### OmniRoute (verified live; policies changed through the owner API)
- OmniRoute 3.8.52 on `:20128` is connected. Each candidate was probed with one bounded request:
  - **Working:** `gemini/gemini-3.1-flash-lite` (3.0 s) and `gemini/gemini-3-flash-preview` (1.4 s).
  - **Retired (410):** `nvidia/openai/gpt-oss-120b` and `nvidia/deepseek-ai/deepseek-v4-pro-0813`.
  - **Unavailable at probe time:** the gemma free routes (429 cooldown), `gemini-3.8-flash` (timeout), `gemini-3.1-pro-preview` (429), `nemotron-3-super` (404), `nemotron-3.5-lightning` (empty output).
- **Routing repair.** The policies were backed up first. Retired models were removed and working models placed first. `maxOutputTokens` is now 1,600–4,000 by domain, and the allowed classes (free, api-free-tier), paid approval, `maxRetries` 1 and the budgets are unchanged. OmniRoute's global account configuration was not touched.

  | Domain | Candidates (in order) | maxOutputTokens |
  |---|---|---|
  | general | flash-lite, 3-flash-preview, gemma-31b:free | 3,200 |
  | admin | flash-lite, flash-preview, gemma-26b:free | 1,600 |
  | creative | flash-preview, flash-lite, 3.8-flash, gemma-31b | 2,400 |
  | research | flash-preview, 3.8-flash, flash-lite, nemotron-super | 3,200 |
  | analysis | flash-preview, flash-lite, 3.8-flash | 3,200 |
  | security | flash-preview, flash-lite, 3.8-flash | 3,200 |
  | coding | flash-preview, 3.8-flash, flash-lite | 4,000 |
  | architecture | 3.1-pro-preview, flash-preview, 3.8-flash | 4,000 |

- **Live daily chat** (LUNA): succeeded. **Live ORI syntheses:**
  - Project Review: `gemini-3.1-flash-lite`, 1,539 in / 1,404 out tokens, 13.1 s.
  - Two Security Reviews: `flash-lite` hit `first-output-timeout` on the larger prompt, and the next candidate `gemini-3-flash-preview` answered in 7.1 s. Fallback worked as designed.
  - Cost is **unknown** (the router sent none), counted as unknown and never $0.

### AI agents — per-agent acceptance on the daily install (verified)
| Agent | Result |
|---|---|
| ORI | company overview, project read and approvals list: 4/4 ok |
| MIA | status card; optimize 95,655 → 16,238 bytes (83% saved, metadata stripped); agent spotlight; template saved; artifact preview `image/png` with a sandbox CSP |
| NEX | agent stats, provider comparison, tool latency, traces all ok; accounting reconciled |
| LUNA | Arabic execution PDFs (project and company) ok. Calendar export refused honestly with `no-deadlines`, since no task has a due date. Follow-ups: 0 due |
| ZEN | Project README import (12,181 bytes) now ok. Search returns cited results (`knowledge:doc_…#chunk-1`), freshness 1/1 fresh, approved-host `web.extract` ok, and the SSRF target `169.254.169.254` was refused |
| REX | deterministic scan returned 1 finding. gitleaks history found 3 known synthetic fixtures, now labelled "in test files". Refusals for a path parameter, an ungranted agent (MIA) and OSV without confirmation |

**Defects found and fixed during acceptance (each has a regression test):**
1. **ZEN import refused this repository.** The checkout name "ABUD FUN Company OS" contains spaces and the source check rejected them. Inner spaces are now allowed, while leading/trailing spaces, absolute paths, `..`, backslashes and over-length names are still refused (`knowledge.test.mjs`).
2. **Security Review always failed one secret scan as `tool-busy`.** Its two gitleaks steps started in parallel, but gitleaks allows one run at a time. The scheduler now holds a step while its tool is at its concurrency limit. The new test reproduces the daily failure without the fix and passes with it (`orchestration.test.mjs`).
3. **ORI called synthetic test fixtures a "secret leak".** gitleaks findings in test files are now labelled (`inTestFile`, `findingsInTestFiles`) and the step summary says so. Nothing is suppressed, and a repository's own ignore file is still not honoured.
4. **A second store opened in the same process repeated the pre-migration backup notice.** The marker is now reset on each open.

### Multi-agent workflow (verified live, daily store)
- **Project Review** `wf_1639cadd38f14551` on the public Company OS project **succeeded** in 19.9 s.
  - All 7 steps succeeded: NEX overview + git, ZEN freshness, REX scan, MIA status card, ORI synthesis, LUNA follow-ups.
  - Each step has its own child run under parent `run_6987fe9a13104571`, and each tool call is audited.
  - The 5 evidence items (one artifact) were **all cited** (E1–E5), and LUNA filed 4 deduplicated follow-up tasks.
- **Privileged-action rejection** used a safe fixture: the OSV dependency scan, which needs per-run approval because it sends package names to api.osv.dev.
  - **Security Review** `wf_065986e252be4918` paused at `waiting-approval`. The owner rejected it, the approval was recorded as `rejected` by `owner`, the step was `skipped: rejected-by-owner`, and the workflow resumed and finished. OSV executions were 1 before and 1 after, so **no dependency data left the machine**. No VPS action was used.
  - After fix 2, **re-run** `wf_f7d0ea3f06924931`: both secret scans succeeded in sequence. Only the optional OSV step was skipped, so the status is `partial` with `optional-incomplete`, which is correct.
- **Persistence:** after a launcher restart, both workflows returned with all steps, evidence, reports and event logs (23 and 26 events).
- **Owner review needed:** the first Security Review (before fix 3) made LUNA file the task "Revoke leaked API keys and JWT". It is based on the synthetic test fixtures, and the owner may archive it.

### Accounting (verified)
- 24 h on the daily store: 26 requests, 10 inferences, 38 tool calls. Per-agent sums equal the direct counts (runs 26/26, input tokens 12,709/12,709, tool calls 38/38), and the reconciliation check reports `ok`.
- Cost: known $0 (0 events), estimated 2 events, unknown 8 events. Unknown is never shown as $0.
- 60,000-row synthetic ledger: 30-day report p50 133 ms, reconciled; the time query uses `agent_runs_created`.

### UI/UX (daily install, read-only)
- `node tests/visual.mjs http://127.0.0.1:4172 local/qa-v5-daily 1440,1024,768,390,360 all`: **260 screenshots, 52 routes × 5 widths**, covering home, projects, work, the AI Workforce (team, Operations Room, conversations, tools, memory, knowledge, conflicts, runs, every agent workspace, MIA studio, ORI usage, LUNA files, ZEN chat, REX tools), resources (accounting, quotas, usage, providers, routing, NEX), system (servers, activity, settings, integrations, data, security) and project details.
- **0 page overflow, 0 browser errors, 0 write requests.** The script records any non-GET request as an error.
- Team view: 59.5 FPS, p95 frame 16.8 ms, robot script 0.39 ms/frame, 16.3 MB heap.
- Inspected by eye: the 1440 Operations Room (security review with the owner's rejection, cited report, test-file label) and the 360 accounting view (reconciled badge, RTL charts).
- Cosmetic, not fixed: in the narrow «الموارد» column of a workflow at 1440, the cost value wraps one word per line.
- The six robots and their 12 forms are unchanged (`robot-qa`).

### Windows startup
- Autostart: `ABUD FUN Company OS.lnk` in the Startup folder runs `powershell.exe -WindowStyle Hidden -File …\ABUD-OS.ps1 -Action start -AtSignIn` (bounded retries 5/15/45 s at sign-in). OmniRoute starts from `OmniRoute.vbs` in the same folder. `autostart-status`: enabled.
- **Not verified: a real Windows sign-out/sign-in with V5.** It was deliberately not triggered from the session (owner step 1).

### VPS (read-only verification; no remote change)
- Host `elhabak` is connected; the last observation was 26 s old and the probe took 3.8 s. The SSH host key is pinned (SHA256 fingerprint stored).
- Services: nginx, postgresql, elhabak-api and elhabak-web running; the two staging services are retired. The production site is ok and staging is retired.
- The 4 historical critical incidents (SSH unreachable or public health check failing on 2026-10-25) are all **recovered**.
- 0 server actions exist or were created. Agents hold read tools only, plus `createActionProposal` for ORI, NEX and REX; executing a proposal stays owner-approved for the exact target.
- V5 was **not** deployed to the VPS, and no remote service was restarted or modified.

### Security (verified)
- Write requests need the loopback session token, tool authorization is server-side, and approvals are owner-only in the runtime.
- gitleaks 8.30.1 over every release candidate path (bridge src/tests/package.json, `internal/`, `tests/`, `scripts/`, `ABUD-OS.ps1`, STATUS.md): **0 findings in V5 changes**. The only hits are the 3 synthetic redaction-test inputs committed with V4.1 (`workspace.test.mjs:41`, `vps.test.mjs:142` with the public jwt.io sample, `runtime.test.mjs:371`).
- `_site` was rebuilt exactly as `pages.yml` does and `audit-static` passed: 28 public entries, 23 allowlisted assets, CSP, no internal UI or private data.
- `npm audit`: 0 vulnerabilities (all and production-only). No dependency data was sent to OSV.
- Nothing staged or committed from `local/`, `_site/`, `.claude/`, `node_modules/`, env files, databases, backups, logs or SSH data.

### Tests (final code)
| Check | Result |
|---|---|
| `cd apps/local-bridge; npm test` | **154/154 pass** (151 + the knowledge checkout-name test + 2 orchestration tests) |
| `npm run check` (28 modules), `node --check internal/*.js`, `git diff --check` | pass (line-ending notices only) |
| `node tests/ops.mjs` (synthetic isolated bridges) | **25/25 PASS**, zero uncaught browser errors |
| `node tests/robot-qa.mjs` | 6 identities, 12 forms, 9 states, unique SVG ids, 0 errors |
| `node tests/smoke.mjs` | pass (desktop and mobile, no overflow, 0 errors) |
| `node tests/stress.mjs 30` (isolated child bridge, temporary store) | pass: 3,017 requests, 0 server errors, 120 client aborts, router outage + recovery, same PID, integrity ok, 0 FK violations, 0 stuck runs. RSS rose 103 → 182 MB over the run, flattening to ~1 MB/round at the end. This is not a confirmed leak; watch the daily Bridge's memory in `status` |
| `tests/v5-a11y.mjs` (isolated dev bridge) | 0 problems on 13 V5 screens; 25/25 focus rings; reduced motion = 0 animated frames |
| `tests/v5-perf.mjs` (isolated dev bridge) | API p50 0.5–4.6 ms; 60k-row accounting p50 133 ms, reconciled |

### Recovery and rollback
1. **Stop:** `powershell -File .\ABUD-OS.ps1 -Action stop`. This is a clean stop; the supervisor does not restart after an owner stop.
2. **Code rollback:** `git switch release/v4.1-local`. V4.1 code reads schema 11 (rehearsed), so no database rollback is needed for V4.1 to run.
3. **Data rollback, only if needed:** with the Bridge stopped, restore `local/backups/company-2026-10-25T23-24-28-967Z-940ccae1bfca.db` (the automatic pre-migration copy, schema 5). Use **System → البيانات → استعادة** or copy it over `local/company.db` while nothing has the store open. Data created after the cutover would be lost.
4. **Routing rollback:** the pre-repair policies were exported to `local/backups/routing-policies-pre-v5-2026-10-25T23-26-09Z.json` before any change. Re-enter those candidates and limits in Resources → التوجيه والميزانيات if needed.
5. The V5 source snapshot before the cutover is `refs/backup/v5-rc-pre-cutover`, and the V5 Codex handoff is `refs/backup/v5-codex-handoff-40`.

### Remaining work and limitations
- **Owner acceptance:** a real Windows sign-out/sign-in (owner step 1).
- Free routes are volatile. `flash-lite` timed out on larger security prompts, and fallback covered it. Re-probe if runs start failing.
- Token counts are estimates until the router reports usage, and cost is mostly unknown on free routes.
- PDF text extraction returns Arabic glyphs in visual order (rendering is correct). No physical-device QA was done (Chromium viewports only).
- Synthetic temp folders `%TEMP%\abud-dev-bridge-*` left by stopped isolated dev bridges can be deleted by the owner; they contain only synthetic stores.

### Owner steps to complete the Stable Local Release
1. Sign out of Windows and sign back in. Within about a minute, run `powershell -File .\ABUD-OS.ps1 -Action status` and confirm "Healthy … apiVersion 5", "OmniRoute: connected", schema 11. Also check that `local/runtime/launcher-state.json` shows `"mode":"sign-in"` with a fresh `lastSuccessAt`. Then open the app once and confirm the robots and the Operations Room load.
2. Optionally archive the follow-up task "Revoke leaked API keys and JWT" (based on synthetic fixtures).
3. Decide later whether to push `codex/v5-agent-intelligence`. Nothing was pushed.

---

## V5 development record — 2026-10-25 (superseded where the final acceptance above differs)

**State then: 95% — V5 Release Candidate (isolated-verified). All five checkpoints are implemented and pass isolated tests. A live OmniRoute workflow and a live chat succeeded on an isolated store. Not yet a verified release:** the daily store is not migrated, the work is not committed, and a real Windows sign-in with V5 has not been run (owner steps, listed at the end). Updated 2026-10-26. Branch `codex/v5-agent-intelligence`. HEAD is still the V4.1 commit `ac7c6e8`, and **all V5 work is uncommitted** in the working tree. Nothing was pushed or deployed. The daily Bridge (PID observed 26488, schema 5) was **not** restarted or migrated. Live V5 behavior in the owner's daily app is **NOT VERIFIED**. V4.1 remains on `release/v4.1-local`.

### Session and routing (this session)
- Claude Code 2.1.263 ran on the **native Anthropic API** (`ANTHROPIC_BASE_URL=https://api.anthropic.com`), not through OmniRoute. The owner first chose to relaunch through `omniroute launch`, then instructed this session to continue ("كمل"). OmniRoute 3.8.52 was healthy on `:20128` (1,633 models; `agy`/`antigravity`, `codex`, `gemini` routes listed). Provider quota limit and usage were reported as `null` (unknown); no quota is claimed. The Company OS agents' own OmniRoute runtime and budgets are unchanged and independent of Claude Code.
- No application inference was spent in Checkpoint 3: every specialist capability is deterministic (no model call). Checkpoint 4 used live free-tier inference only on an isolated temporary store (below).

### Checkpoint 1 — conversations — COMPLETE (isolated tests; Codex)
Persistent threads, owner/assistant/tool/event messages, project/task links, SQLite BLOB attachments, streaming, search, pagination, rename/archive/restore/soft delete, stop/retry, concurrent-send protection, idempotent sends, bounded context. Migration 6. Unchanged this session.

### Checkpoint 2 — memory and knowledge — COMPLETE (isolated tests; Codex)
Memory provenance, scopes, owner review, FTS5 search, edit/archive/delete with index updates, knowledge documents, chunking, owner text and approved README/STATUS imports, citations and bounded retrieval. Migrations 7–8. Extended this session for web pages and freshness (below).

### Checkpoint 3 — capability engine and specialist tools — COMPLETE (isolated tests + real safe executions) → 60%
- **One registry, not a second engine.** The 22 reviewed V4.1 tools stay intact (VPS tools, grants, approvals, audits unchanged). They are extended to 40 capabilities in `catalog.mjs`. Each carries a stable id, Arabic name and description, category, version, adapter, input schema, output, approval tier, side effect, network requirement, timeout, rate limit and `maxConcurrent`. V5 grants are seeded once per agent through the import ledger, so the owner's later narrowing is never undone. Agents still cannot receive tools outside their reviewed set.
- **Server-side enforcement (`runtime.invokeTool`).** Checks run in order: unknown tool → agent disabled → grant → owner kill switch → approval tier → strict schema (unknown fields refused; types string/enum/integer/boolean/url/base64) → rate → live dependency health → per-tool concurrency. Execution is cancellable and timeout-aborted, and every attempt (including refusals) is a persistent `tool_executions` row with a redacted input, summary, artifacts and duration. Each run and tool call is also a local OpenTelemetry span. The model never chooses tools or arguments.
- **Migration 9** (`v5-capability-engine`): adds `tool_executions`, `artifacts` (BLOB, ≤8 MB), `capability_state`, `visual_templates` and `telemetry_spans`. It also rebuilds `knowledge_documents` to add `web-page` sources and freshness columns, with foreign keys suspended only for that migration and `foreign_key_check` before COMMIT. Tested from a real schema-8 file: chunks, FTS rows and cascade survive.
- **Pre-migration safety net (new):** opening an existing file store that needs a schema upgrade first writes a `VACUUM INTO` copy to `local/backups/company-<ts>-<hex>.db`, verifies its integrity and schema, then migrates. On start, the Bridge logs and notifies which backup was taken. A failed copy stops the upgrade.
- **Owner surfaces:** AI Workforce → «الأدوات والمهارات» offers a library grouped by category, with search that filters in place (focus kept), an agent filter, availability with reasons, grants and execution counts. It also has a tool console (form generated from the schema; approval-gated tools need an explicit confirmation that is recorded on the execution), result views (artifacts, charts, findings), «الملفات الناتجة» (preview, download, owner-only approval, archive, delete) and «سجل التنفيذ» (paginated audit). Each agent workspace gains specialist tools with an audit panel and «الملفات». MIA also gains «استوديو التصميم». V5 tabs appear only when the running bridge advertises `toolEngine`/`conversations`/`knowledge` in `/local-api/health` (apiVersion 5), so the V4.1 daily bridge serving these files stays usable.

| Agent | Integrated tools (selected libraries) | Real functions | Tested result |
|---|---|---|---|
| ORI | MCP TypeScript SDK 1.32.2; in-process company tools | `company.overview`, `approvals.list`; **stdio MCP server** (`npm run mcp`) exposing 7 read-only ORI capabilities to local MCP clients through the loopback Bridge, audited as actor `mcp` | In-memory MCP protocol + a real stdio MCP process against an isolated Bridge; write tools never exposed |
| MIA | sharp 0.35.5 (libvips; Pango shapes Arabic), Fabric.js 7.4.0 (browser) | branded project status card, announcement/milestone/agent-spotlight graphics (approved robot art composited unchanged), image optimize (resize/convert, metadata stripped, original kept), Fabric template studio → server-validated PNG artifact; reusable templates (image sources limited to embedded/bundled art) | PNG/WebP dimensions and formats verified; EXIF removed; canvas export and template save exercised in Chromium |
| NEX | @opentelemetry/api 1.10.0 + sdk-trace 3.0.0 (local SQLite exporter only), ECharts 6.1.0 (browser) | per-agent stats (runs, success, p50/p95, tokens, **known / estimated / unknown** cost kept separate), provider/model comparison from run attempts, tool latency/reliability from the audit, local traces | Reconciles with persisted runs; unknown cost never $0; RTL charts render |
| LUNA | ics 3.12.1, pdf-lib 1.17.1 + @pdf-lib/fontkit 1.1.1 | task-deadline `.ics` export, **Arabic execution PDF** (summary, overdue, upcoming, completed, approvals awaiting follow-up, agent runs, deliverables), idempotent approval follow-up tasks | ICS DATE events; PDF rendered with pdf.js and inspected visually: correct Arabic shaping, RTL tables, Latin/number order |
| ZEN | @mozilla/readability 0.6.0 + linkedom 0.18.14; existing SQLite FTS5 | SSRF-guarded approved-host page extraction with optional knowledge ingestion and citation, scoped search, freshness (changed project docs, stale/changed web pages) | Private/reserved addresses, DNS-rebinding answers, IP literals, credentials, ports, downgrades, unapproved redirects, oversize and non-text refused; embedded "ignore instructions" text reported, never obeyed |
| REX | gitleaks 8.30.1, osv-scanner 2.7.0 (installed via winget with owner approval) | secret scan of an authorized checkout (recent history or uncommitted changes; values never stored), dependency vulnerability scan (approval per run: package names/versions go to api.osv.dev; call analysis disabled) | Synthetic committed token found with rule/file/line and no value; a gitleaks failure is reported as "not scanned", never "clean" |

- **Arabic PDF:** pdf-lib does not reorder bidirectional text, and the bundled fonts are complementary subsets. `pdf-arabic.mjs` adds reduced-UBA bidi runs with per-character font fallback (Alexandria for Arabic, Manrope for Latin, digits and punctuation). It also works around two @pdf-lib/fontkit defects without patching `node_modules`: WOFF2 glyf corruption during subsetting, and a dropped final flag-repeat count that corrupted "X"/"w".
- **Dependency review.** Every selected package was checked for license, current version, Node ≥22/Windows and its dependency weight. `npm audit` reported 0 vulnerabilities, and exact versions are pinned in `apps/local-bridge/package.json` + `package-lock.json`. `pdfjs-dist` 6.4.299 is a dev dependency used only for PDF render QA, and `node_modules` stays ignored. Rejected or deferred:
  - `@opentelemetry/sdk-trace-base` — deprecated upstream; `sdk-trace` 3.0.0 used instead.
  - Server-side Fabric — needs node-canvas plus jsdom native builds; the browser build is used and the server re-encodes.
  - `sqlite-vec` — not installed. It needs extension loading in the store and paid or quota-consuming embedding calls, and FTS5 meets the current need.
  - `openai-agents-js` — not adopted. It would replace a tested runtime without adding a capability this design needs.
  - Fabric pulls jsdom as an optional dependency (installed, unused at runtime).
- **Real safe executions (live, in-memory store):**
  - gitleaks over this public repository's last 300 commits: 3 findings, all known synthetic test fixtures (`generic-api-key`, `jwt` in `apps/local-bridge/tests/*.test.mjs`); no real secret.
  - osv-scanner on a synthetic lockfile: lodash 4.17.15 → 6 GHSA advisories, fixed versions reported; the owner confirmation is recorded on the execution.
  - ZEN extracted `https://nodejs.org/en/about` (4,044 chars) and indexed it, and it is searchable with a citation.

### Checkpoint 4 — multi-agent orchestration and accounting — COMPLETE (isolated tests + one live workflow) → 80%
- **Generic bounded delegation (`orchestrator.mjs`, migration 10 `v5-orchestration`).** A workflow is a reviewed template materialized into a persisted plan: `workflows`, `workflow_steps` and `workflow_events`. Each step has one specialist, one approved tool and only the inputs it needs (never the company database), plus dependencies, a delegation depth and an optional flag.
  - **Plan checks:** before persisting, the plan is rejected for unknown agents/tools, tools outside the agent's reviewed set, dependency cycles, depth over 2, or more than one model call.
  - **Execution:** ORI runs ready steps in parallel (≤3; owner may lower), under a per-execution deadline (1–30 min) and an inference cap (1). Each step is its own child `agent_runs` row (`delegated_tool` / `synthesis` / `followups`) attributed to the specialist, and each tool call is audited with the `workflow_id`.
  - **Synthesis:** ORI's synthesis is the only model call. It goes through the existing `infer()` path with all eligibility, paid-approval and hard-budget checks, and is asked to cite evidence ids, which are parsed (`[E1]`, `[E2, E4]`). A failed synthesis leaves a deterministic evidence report and status `partial`, never a fabricated summary.
  - **Approvals and failures:** an approval-gated tool (OSV) pauses the workflow (`waiting-approval`, parent run `blocked`) until the owner decides. **Approval decisions are now owner-only everywhere.** Agent actors get a refusal, including on their own requests. A rejection skips the step, and the workflow resumes and completes. A revoked grant fails the step (`tool-forbidden`) without substituting another agent. Specialists cannot add steps, and follow-up tasks are bounded (≤6) and deduplicated.
  - **Owner controls and recovery:** the owner can cancel (aborts running specialists; remaining steps cancelled) and retry a failed step (dependents re-open). After a restart, interrupted read-only steps re-run, anything else is marked interrupted, and the parent run is re-queued so the same plan resumes.
- **Six functional templates:** project review, repository security review, company weekly report (with LUNA's PDF and calendar), AI resource audit, technical research brief (≤3 approved URLs + scoped search) and release readiness.
- **غرفة العمليات (AI Workforce).** Template launcher (inputs, parallelism, deadline) and the recent-workflow list. The detail view shows ORI with the participating specialists as the approved robots; a robot animates "working" only while one of its own steps is persisted as running, and reactions fire on observed transitions. It also shows a progress bar, phase timeline (agent, tool, duration, summary, files, errors, retry), inline owner approve/reject, persisted events, measured resources, the final report and the deliverables. Polling uses ordered responses, so a stale read never overwrites newer state.
- **Accounting (`accounting.mjs`; Resources → «محاسبة الوكلاء», agent workspace → «الاستخدام»).**
  - **Per agent:** requests (top-level vs delegated), succeeded/failed/blocked/cancelled, tool calls (succeeded/denied), inferences, input/output tokens, and cost on three separate bases: **known** (a recorded actual), **estimated** (router per-response estimate) and **unknown** (never $0). Also average execution time, open and completed tasks, projects and recent activity.
  - **Company-wide:** comparisons, a per-project breakdown, a daily chart, and range/project filters.
  - **Reconciliation:** a built-in check compares the per-agent sums with direct counts over the same rows and is shown as «مطابق للسجلات». Token volume is labelled as use, not productivity.
- **Reliability fixes found by the live run:** a stream that completes with no visible text (a reasoning model spending its whole output budget) is now `empty-output`, which is retryable on the next eligible model. It was `bad-response`, which stopped the fallback. Tokens consumed by such failed attempts are now recorded in the usage ledger.
- **Live verification (real OmniRoute 3.8.52, isolated temporary store; the daily store was not opened):**
  - **First attempt (owner's default candidates):** the five specialists' real tools succeeded. The synthesis failed honestly (`first-output-timeout`, then `bad-response`), and the workflow ended `partial` with the evidence report. Direct one-request probes then showed that **every default free candidate was unavailable at that moment**:
    - `gemini/gemini-3.1-flash-lite` 503 high demand after 41 s
    - `gemini/gemini-3.8-flash` and `gemini/gemini-3.7-flash` no answer in 60 s
    - `nvidia/openai/gpt-oss-120b` **410 model_shutdown** (retired)
    - `openrouter/google/gemma-4-31b-it:free` 429 cooldown
    - `gemini/gemini-2.5-flash-lite` 404 retired for new users
  - **Final run** (candidates overridden *in the temporary store only* to `gemini/gemini-3-flash-preview`, `openrouter/nvidia/nemotron-3.5-lightning:free`; `maxOutputTokens` 4000 because the model spends ~1,600 tokens on reasoning): `wf_4a0c0769114f4a9a` **succeeded** in 9.9 s.
    - All 7 steps: NEX overview + git, ZEN freshness, REX scan, MIA status card, ORI synthesis, LUNA follow-ups.
    - Synthesis on `gemini/gemini-3-flash-preview`: 1,477 in / 1,628 out tokens, 9.2 s, cost **unknown** (router sent none; counted as unknown).
    - Cited evidence: E1, E2, E3. LUNA created 4 follow-up tasks (temporary store). Accounting reconciled.
  - **Live V5 chat** (LUNA, same isolated bridge): succeeded on `gemini/gemini-3-flash-preview`, 423 in / 615 out tokens, 19.1 s, reply «جاهزة.».
  - **Owner decision needed (NEX finding, not changed automatically):** the daily routing policies list a retired model (`nvidia/openai/gpt-oss-120b`), and reasoning-heavy free models need a higher `maxOutputTokens` for synthesis.

### Checkpoint 5 — integration, polish and QA — COMPLETE in isolated tests → 95% (live owner acceptance pending)
- **Inherited Checkpoint 1/2 limitations, resolved (migration 11 `v5-integration`):**
  - **Search no longer interrupts typing.** Chat, memory and knowledge searches refresh only their result lists.
  - **No background redraw while editing.** Background redraws (agent polling, late page loads, a reply arriving) wait until focus leaves the form, and form drafts survive any rebuild. This fixed a real race where a late load wiped a half-typed knowledge form, found by the browser suite failing about 1 run in 2; after the fix it passed 7 consecutive runs.
  - **Rename** uses an accessible dialog instead of `window.prompt`.
  - **Token-budgeted context.** Conversation context is budgeted by estimated tokens (owner setting, default 3,000). Older turns become an **extractive, SHA-256-verified summary** stored in `conversation_summaries`, rebuilt whenever its source messages change, and the original messages are never removed. The chat shows what the next reply will see.
  - **Export and retention.** Transcripts export as Markdown or JSON. Attachment retention (owner setting, default 0 = keep) purges only files of conversations deleted longer than the period; messages remain and the purge is logged.
  - **Memory conflicts.** Same scope and normalized title with different content opens a conflict. An agent's conflicting note stays pending and never overrides owner-confirmed memory. Only the owner resolves it (keep new / keep existing / keep both); the loser is archived with `superseded_by`, and both keep their provenance.
  - **Indexes.** Time-range indexes were added for runs, tool executions and attachments.
- **AI Workforce tabs:** الفريق · غرفة العمليات · المحادثات · الأدوات والمهارات · الذاكرة والمعرفة (memory, knowledge library, conflicts; the old `agents/knowledge` route still resolves) · سجل التشغيل. Agent workspaces: overview, **conversations**, tasks, run history, tools, files, usage, (MIA) design studio, routing, memory, settings, character.
- **Visual identity:** the Arabic RTL violet/white system, Alexandria/Manrope, and the six approved robots with their 12 forms are unchanged (`robot-qa`: 6 identities, 12 forms, 9 states, unique SVG ids, 0 errors). New surfaces reuse the existing panels, badges, KPIs and drawers. RTL fixes: chart direction, number pairs, Arabic plurals in PDFs.
- **Performance (measured):**
  - Team view 60.5 FPS, p95 frame 16.8 ms, robot script 0.33 ms/frame, 13.6 MB JS heap.
  - Robot instances are reused per agent in the Operations Room.
  - API p50 0.4–2.7 ms on the dev store.
  - Accounting on a 60,000-row synthetic ledger: 400 ms → **117 ms** after single-pass aggregation, still reconciled; the time-range query uses `agent_runs_created`.
  - Polling is bounded (1.5 s only while a workflow is live), charts dispose with their DOM, and no knowledge or FTS rebuild happens at startup.
- **Accessibility (`tests/v5-a11y.mjs`, 13 V5 screens):** 0 unnamed controls, 0 unlabelled fields, 0 images without alt. 25/25 keyboard tab stops show a focus ring. Reduced motion means 0 animated robot frames; ECharts animation is also off under reduced motion.

### Verification (this session, fresh)
| Check | Result |
|---|---|
| `cd apps/local-bridge; npm test` (final) | **151/151 pass** (115 inherited + 16 capability engine + 3 capability API/MCP + 12 orchestration/accounting + 1 empty-output stream + 4 integration) |
| `npm run check` (28 modules), `node --check internal/*.js`, `git diff --check` | pass (line-ending notices only) |
| `node tests/ops.mjs` (synthetic isolated bridges, final) | **25/25 PASS**, zero uncaught browser errors. Covers the capability library, Operations Room (weekly report with a PDF deliverable; OSV step waits for the owner, rejection resumes; accounting reconciled) and integration (chat search keeps focus, rename dialog, Markdown export, context budget, conflict resolved with provenance) |
| `node tests/visual.mjs http://127.0.0.1:4191 … 1440,1024,768,390,360` (isolated dev bridge, 51 routes incl. every V5 screen) | **255 screenshots, 0 page overflow, 0 browser errors**, 0 write requests; perf as above |
| `node tests/robot-qa.mjs` · `node tests/smoke.mjs` · `node tests/stress.mjs 30` | pass (6/12/9, 0 errors) · 18 PASS · pass: 3,017 requests through load, aborts, router outage and recovery; integrity ok, 0 FK violations, 0 stuck runs |
| `_site` built as `pages.yml` → `node scripts/audit-static.mjs` | pass: 28 public entries, 23 assets; no internal UI, vendor bundles or private data in the public artifact |
| `tests/v5-a11y.mjs`, `tests/v5-perf.mjs` | as above |
| gitleaks over new/changed source and STATUS | 0 findings; the 3 known synthetic fixtures in V4.1 test files remain |
| Operations Room UI (`tests/v5-operations-shots.mjs`, isolated dev bridge) | project review launched from the UI → 7/7 steps, report cites evidence, "working" robot state observed only during a running step; no overflow at 1024/768/390/360; accounting and REX usage views; 0 errors |
| Live OmniRoute (`tests/v5-live-workflow.mjs`, isolated store) | workflow succeeded (with temporary-store candidate override, see above); live chat succeeded |
| Headless V5 screens (`tests/v5-shots.mjs`, isolated dev bridge `tests/dev-bridge.mjs` on :4191) | tools library, MIA tools, MIA studio at 1440/390: no page overflow, 0 errors; PDF/card/chart runs, search focus kept, files gallery |
| PDF readability (`tests/pdf-render.mjs`, pdf.js in Chromium) | real LUNA report inspected: readable Arabic |
| Live safe adapter run (`tests/v5-live-capabilities.mjs`) | gitleaks / osv / web.extract all succeeded (above) |

### Security notes
- Writes still need the loopback session token. Tool authorization is server-side only, and the UI showing a tool grants nothing. Agents cannot approve artifacts, toggle capabilities or approve their own actions.
- External processes run with fixed argument vectors on authorized checkouts only. gitleaks runs with an empty temp cwd and ignore path; a repository's own `.gitleaks.toml` is reported because gitleaks honours it.
- Artifacts are served with a sandbox CSP and `nosniff`. Vendor bundles come from a fixed two-file map.
- Approval decisions are owner-only in the runtime itself, not just the UI. Workflow steps cannot approve, add steps, escalate tools or substitute agents. Web content and scanner output are untrusted data, and embedded instructions were tested to create nothing.
- Incident (read-only, no impact): one command mistakenly ran `tests/visual.mjs` with its defaults against the **live daily bridge** (:4172). It took 260 screenshots, with **0 write requests**, 0 errors and 0 overflow, saved to the ignored `local/qa`. This also shows that the V4.1 daily bridge serving the V5 UI files degrades cleanly.
- Concern: the **daily Bridge serves this checkout's files**. Its UI therefore already loads in-progress V5 files; they degrade to V4.1 behavior via the health flags. If its supervisor or a Windows sign-in restarts it, it will run V5 code and migrate the daily store, but only after the new verified pre-migration backup. **Owner decision needed:** run the daily Bridge from a separate V4.1 worktree, or accept the backup-guarded upgrade.

### Recovery
- `refs/backup/v5-codex-handoff-40` (`6b847eb`) holds the Codex tree.
- V4.1 is on `release/v4.1-local`, and daily backups are in `local/backups/`.
- V5 schema is 11. Migrations 6–11 are additive, except the `knowledge_documents` rebuild, which V4.1 does not use. A V5 store therefore stays openable by V4.1 code.
- Any upgrade of an existing file store first writes a verified `VACUUM INTO` copy.
- V5 runtime dependencies are pinned in `apps/local-bridge/package-lock.json`; run `npm ci` in `apps/local-bridge` on a fresh checkout. gitleaks and osv-scanner come from winget, and a missing one shows as "unavailable".

### Remaining defects and limitations
- The owner's daily routing policies are stale (`nvidia/openai/gpt-oss-120b` was retired, and free Gemini routes were overloaded at test time). Reasoning-heavy free models need a larger `maxOutputTokens` for ORI's synthesis. This was not changed automatically.
- PDF text extraction returns Arabic glyphs in visual order, so copy and paste may reverse words; the visual rendering is correct.
- Token counts are estimates (by script) until the router reports usage.
- The OSV scan needs network access and the owner's approval each time.
- ECharts (~1 MB) and Fabric (~0.3 MB) load only on first use.
- No physical-device QA was done; viewport checks used Chromium.

### Owner steps to reach 100% (verified release)
1. Choose how the daily app runs V5: from this checkout after a verified backup (the Bridge does this automatically), or keep V4.1 daily from a separate worktree.
2. Stop the daily Bridge, take a verified backup (System → البيانات), start V5, and confirm schema 11, integrity ok, and the record counts.
3. Update the routing candidates and `maxOutputTokens` in Resources → التوجيه والميزانيات (for example add `gemini/gemini-3-flash-preview`, and remove the retired model).
4. Run one live project review and one chat from the daily UI.
5. Sign out and back in to Windows and confirm both autostarts.
6. Approve a local commit of this work. Nothing has been committed or pushed.

### Next unfinished task
Owner acceptance steps 1–6 above. No implementation task is open.

---

Updated: 2026-10-25 (Africa/Cairo)
State then: **V4.1 Stable Local Release** (previous release; rollback target `release/v4.1-local`). Windows sign-in startup is enabled for OmniRoute and Company OS. The VPS is connected through read-only, host-key-pinned SSH and monitored live. All six agents have permission-controlled infrastructure tools. Server actions require owner approval for the exact target. A live ORI→NEX/REX→LUNA infrastructure review succeeded. The final regression and visual suites passed. The isolated release branch was pushed without force and its remote SHA verified. `main` was not touched and nothing was deployed. Not verified: a real Windows sign-out/sign-in cycle or a live Tier-2 action.

## V4.1 — previous stable release

### Source and preservation
- Same checkout (branch `feat/restore-original-universe`, HEAD `df7dc2c` at start; remote `abudoxali/-abud-github-universe`, **public**).
- **Legacy V2 preserved before anything else:** `df7dc2c` (the last V2 private-server revision, previously on no remote) was pushed non-force to `origin/archive/v2-private-server-df7dc2c`. A verified git bundle (`df7dc2c` + `backup/v2-secure-os-before-universe-restore`) and a tar of the whole uncommitted V4 tree (122 files) were written to ignored `local/backups/`. The V2 tree also remains on `origin/feat/v2-secure-os` (`5b96753`, open draft PR abudoxali/-abud-github-universe#1, not closed).
- The staged deletion of `apps/private-server/`, `private-ci.yml` and `docs/V2_SECURE_WORKSPACE.md` was finalized only after confirming that no active file references it (`grep` across bridge, UI, launcher and tests: none). The evidence trail `docs/superpowers/` is committed with it.
- Release commits and push: see **Git release** below.

### Windows sign-in startup — LIVE VERIFIED (except a real sign-in)
| Item | Result |
|---|---|
| OmniRoute 3.8.52 autostart | Enabled with its own supported `omniroute autostart enable` (through System Center). Mechanism: hidden `OmniRoute.vbs` in the user Startup folder → `serve --no-open --tray`. No reinstall, no configuration, account, routing or credential change. `omniroute autostart status` → enabled. |
| Duplicate prevention | Ran the VBS while the router was up: no second instance survived, and the original PID was untouched. |
| Cold start through the VBS | `omniroute stop`, then the VBS launched detached → `/api/health` ok after 3–16 s. |
| Router outage / reconnect | During the cold start the running bridge reported `offline` (HQ/System honest) and then `connected` again **without a bridge restart**. |
| Company OS autostart | Enabled through System Center → launcher `autostart-on`: Startup shortcut → `powershell -WindowStyle Hidden -File ABUD-OS.ps1 -Action start -AtSignIn`. No admin, no service. |
| `-AtSignIn` with a healthy bridge | Reused it (no duplicate) and started exactly one hidden supervisor. |
| Crash recovery | External `Stop-Process` of the bridge → supervisor restarted it 27 s later. Recorded as `supervisorRestarts: 1`; the new bridge classified the previous exit as `unexpected-exit`. Bound: 3 restarts per hour, then it gives up and records why. |
| Clean owner stop | `stop` → bridge stayed stopped through 50 s of supervisor polling (owner stops, including `-Force`, are recorded and honoured). |
| Bounded start retries | Sign-in mode retries 3 times (5/15/45 s) and writes attempts, last success and last failure to `local/runtime/launcher-state.json` (shown in System Center). The browser opens at most once, after success, if the owner preference allows (default on, toggle in System → نظرة عامة). |
| Data persistence | 40 projects, 7 tasks, 6 agents, 17 runs identical across 5 bridge restarts. Integrity `ok`, 0 FK violations. |
- **Finding:** OmniRoute started from inside a coding-agent shell was ended together with that shell's process tree, while the same VBS launched detached kept running. This is a plausible explanation for the earlier unexplained V3 bridge exit. At real sign-in, Explorer launches both, so it does not apply.
- **Registered and tested through the startup commands; actual user sign-in acceptance remains unverified.** A real Windows sign-out/sign-in was not performed in this session.
- System → نظرة عامة → «التشغيل عند تسجيل الدخول إلى Windows» shows both autostart states, supervisor state, last launcher success and failure, the router's last successful connection, last failure and reconnect count. It offers enable/disable, «إعادة محاولة الاتصال», and «تشغيل OmniRoute» (only while it is offline; OmniRoute itself refuses a second instance). Each control maps to one fixed argument vector; no request value reaches a command line.

### VPS Operations Center — LIVE VERIFIED (read-only)
- **Host:** The monitored VPS uses an ignored `local/vps.json` for its address, SSH user, pinned ED25519 host-key fingerprint, expected hostname, key path and watch profile. The public repository contains only `local/vps.example.json` with placeholders. The private key is used by path only and is never read, stored, returned or sent to a model.
- **Transport:** Windows OpenSSH, `-F none`, one identity, `BatchMode`, `StrictHostKeyChecking=yes`, `HostKeyAlgorithms=ssh-ed25519`, pinned fingerprint re-checked from ssh's own `Server host key` line on every connection, no forwarding or TTY, the fixed remote command `bash -s`, and bounded time and output. A deliberately wrong pinned fingerprint failed closed live (`host-key-mismatch`).
- **Live inventory (verified now; the handoff's historical values were stale):**
  - Production health checks pass; the observed deployment matches the public health commit. Production application and host services are running.
  - **Staging is intentionally retired** and returns HTTP 410. It is shown as «مُوقَف عمدًا», not as an outage; no restart was attempted.
  - Nginx and PostgreSQL are healthy. Approximate utilization at the last detailed check: CPU 1%, memory 24%, disk 43%. TLS is valid. No business records were read.
  - Other tenants' applications are outside this monitor and were not touched. Error log reads are scoped and redacted.
- **Monitoring (deterministic, no AI):** basic probe every 60 s, inventory every 15 min, HTTPS every 2 min, TLS every 6 h. No overlap per host; backoff to 10 min on failure. Raw metrics kept 3 days, then hourly roll-up for 120 days; observations 30 days; recovered incidents 180 days. Intervals and thresholds are editable in the page.
- **Incidents:** debounced (3 SSH failures = unreachable, 2 checks for a stopped production service, 5 sustained CPU/memory readings, 2 for disk), one notification and one owner task per unresolved condition (reused if still open), automatic recovery, Cairo-time timeline, assigned agent (security→REX, resources→NEX, availability→ORI) and «اطلب تشخيص». A failed SSH check never marks services stopped: the last verified state is shown with its age. Live: 0 incidents (none fabricated).
- **UI:** النظام → السيرفرات (no seventh workspace): KPIs, meters, a CPU/memory/disk chart (1h/24h/7d/30d), services, sites/TLS, deployment/PostgreSQL/Nginx, incident timeline, allowlisted diagnostics and redacted logs, action approvals and history, and monitoring settings. The ELHABAK project page shows its server panel (linked to the existing project `gh:abudoxali/elhabak-construction-system-v1`, no duplicate created). HQ lists only open warning/critical incidents, unreachable hosts and pending server approvals. Activity records registrations, state changes, deployments seen, diagnostics, log reads and actions.

### Agents and infrastructure tools
- Eleven tools in the reviewed registry: `vps.listHosts`, `getHealth` (fresh ≤2 min), `getMetrics`, `listServices`, `getServiceStatus`, `getDeploymentInfo`, `getRecentEvents`, `getRedactedLogs`, `runSafeDiagnostic` (7 named read-only checks), `createActionProposal`, `getActionResult`. Each has a typed input schema (unknown fields such as `command` are refused), a timeout, a rate limit, redaction and an audit trail. None accepts a command.
- Grants (one-time ledger grant; later owner narrowing is respected): all six read; ORI/NEX/REX/ZEN run diagnostics; ORI/REX/ZEN read redacted logs; ORI/NEX/REX propose. Live store: ORI 11, REX 11, NEX 10, ZEN 10, LUNA 8, MIA 8 VPS tools.
- New capabilities: «مراجعة حالة السيرفرات» (all six) and ORI's «تقييم البنية التحتية» workflow. Server-related chat requests get fresh infrastructure evidence automatically. Prompts state that remote text is untrusted data, that stale data is not proof of an outage, and that the agent cannot act.
- **Workflow A — LIVE VERIFIED:** «راجع حالة السيرفر وقولي لو فيه مشكلة.» → `run_1b5b1647be324bdb` succeeded. NEX used `getHealth`, `getMetrics` 24h/7d and `getDeploymentInfo`; REX used `getRecentEvents` plus deterministic checks; one ORI inference on `gemini/gemini-3.1-flash-lite` (1,772 in / 758 out, cost unknown and shown as unknown, 26.8 s); LUNA created 2 follow-up tasks. The report was grounded: production healthy, staging retired, low resources, data age stated, no invented issue. The first attempt, `run_686f5397c4644a7c`, failed honestly with `first-output-timeout` on both free models. The digest was then made compact and the prompt shorter; the owner's 25 s timeout was not changed.
- **Workflow B (incident → dedup → notify → evidence → diagnosis) — TESTED WITH FIXTURES.** A production incident was not provoked. The live diagnose path is wired but unused because no live incident exists.
- **Workflow C (owner-approved recovery) — TESTED WITH FIXTURES; live REQUIRES OWNER APPROVAL.** There is no disposable or staging target: staging is retired, and restarting production to test is forbidden. The UI path (propose → approval card with exact command and target) passes in the browser suite against a synthetic host.

### Controlled actions (Tier 2 only)
- Registry: `pm2.restart` (one registered service that the latest probe shows exists) and `nginx.reload` (runs only if `nginx -t` passes in the same script). Tier 3 (deploy, rollback, migrate, restore, Nginx edit, firewall, SSH access, release delete) is refused with an explanation. Unknown operations are refused.
- Enforcement: proposals by agent or owner (deduplicated, expire after 24 h). Approval is **owner-only** (an agent's approval, even of its own proposal, is refused) and requires typing the exact target. It yields a 32-byte single-use token (stored as SHA-256) valid 5 minutes and bound to that action row. Execution consumes the token atomically, takes a per-host lock, re-probes host identity, runs only the registry script, and marks `succeeded` only after post-checks (PM2 online with a newer start time, or Nginx active, plus public health). A non-zero exit or unproven state is `failed`. Every step is in the activity log.

### Inference budget correctness
- `maxCostUsd` is a **post-hoc per-request cap**. After a paid call whose router-reported cost exceeds it, or whose cost is unknown, further paid calls in that domain are blocked until the owner acknowledges the notification. Free routes continue. Paid routes still need per-run approval, and `maxOutputTokens` bounds every call. The cost of a request cannot be known before it is sent; the UI does not promise a guaranteed pre-request cap. Live effect: none (no paid route is eligible by policy).

### Database
- Pre-change backup `local/backups/pre-v4.1-2026-10-25T13-47-21Z.db`: integrity `ok`, 0 FK violations, schema 4, 40 projects / 5 tasks / 6 agents / 10 runs.
- Migration 5 (`vps-operations`, additive): `vps_hosts`, `vps_observations`, `vps_metrics`, `vps_services`, `vps_incidents`, `vps_actions`.
- Live now: schema 5, integrity `ok`, 0 FK violations; 40 projects, 7 tasks, 6 agents, 17 runs, 1 host, 6 services. Post-change in-app backup `company-2026-10-25T14-32-13-333Z-7214ba74c108.db` (516,096 bytes, healthy). Isolated restore rehearsal ok: schema 5, projects 40/40, tasks 7/7, runs 17/17.

### Tests (final code)
| Command | Result |
|---|---|
| `cd apps/local-bridge; npm test` | **108/108 pass** (+14: SSH arguments and host-key fail-closed, probe-profile injection refusal, parsers, redaction, retired/protected sites, monitoring lifecycle, SSH outage without false "stopped", debounce/dedup/recovery, identity incident, six-agent tool permissions and arbitrary-command refusal, approval binding/single use/verification/failure, Tier-3/expiry safeguards, startup allowlist, cost cap, infrastructure workflow) |
| `npm run check` | pass (includes the four new modules) |
| `node tests/ops.mjs` | **19/19 PASS** (servers page with a synthetic host → proposal → approval card with exact command and target; 390 px approval dialog stays within the viewport and was cancelled without execution; SSH key path never in the DOM) |
| `node tests/robot-qa.mjs` | pass: 6 identities, 12 forms, 9 states, unique SVG IDs, 0 errors (robots unchanged) |
| `node tests/smoke.mjs` | pass (18 PASS) |
| `_site` built exactly as `pages.yml`, then `node scripts/audit-static.mjs` | pass: 28 entries, 23 assets; no VPS address or internal UI in the artifact |
| `node tests/stress.mjs 30` | pass: same process healthy through load, aborts, router cut and recovery; integrity `ok`, 0 FK violations, 0 stuck runs |
| `node tests/visual.mjs` (live, 34 routes × 1440/1024/768/390/360) | Inherited sweep: 170 saved screenshots, all five widths complete, 0 page overflow, 0 browser errors. Its three hardcoded project URLs used an unescaped slash in the ID and rendered “project not found” despite an error-free summary. The corrected route sweep captured those three pages at all five widths (15 screenshots), with 0 overflow and 0 errors; the ELHABAK server panel and desktop/mobile captures were inspected. The app's own links were already encoded correctly. |
| `git diff --check` | pass |
- Test isolation fixed: the stress test runs a *background* bridge and previously defaulted to the real `local/vps.json`, which would have started real SSH probes from a synthetic test. All test bridges now use isolated or absent VPS config and fake transports.

### Git release
Release source: `cfaf3f6220ef313b2dc2a9cc52ab592632fffa04` on `release/v4.1-local`, following historical removal commit `f1c5227`. QA and documentation commit `f9b23763922ce2fe6b47c04c612b73c19d69dadb` was pushed non-force and matched `origin/release/v4.1-local`; this acceptance update follows on the same branch. The V2 archive remains verified at `origin/archive/v2-private-server-df7dc2c` (`df7dc2c`). No merge, Pages deployment or VPS deployment occurred.

### Remaining limitations
- Not exercised: a real Windows sign-out/sign-in or reboot (each component was verified individually), and a live Tier-2 action (needs the owner's own approval; staging is retired, so there is no non-production target).
- OmniRoute's autostart uses its tray mode (`--tray`), its own default. The tray worker printed an exit message in one duplicate-start test, but the cold start through the same VBS served health normally.
- Infrastructure history starts today; 7- and 30-day trends fill over time.
- The GitHub Pages workflow on `main` is still failing remotely (not touched; `main` was not changed).
- No physical-device QA; viewport checks are Chromium.

### Release classification
**V4.1 Stable Local Release.** Operational and visual acceptance passed on this Windows machine, and the isolated source branch is preserved on GitHub. Actual Windows sign-in and a live owner-approved Tier-2 action remain manual acceptance items.

---

## V4 final acceptance (2026-10-25 16:15; superseded where V4.1 above differs)

### Source state
- Same checkout, branch `feat/restore-original-universe`, HEAD `df7dc2c`. There is no upstream; HEAD is 42 commits ahead of `origin/main`. No reset, restore, commit, push, deployment, Windows autostart, or OmniRoute configuration change. The six approved robots and twelve forms were not changed.

### OmniRoute: live status
- **Why it did not come back:** OmniRoute 3.8.52 is an npm global (`%APPDATA%\npm\omniroute.cmd`) with no autostart. `omniroute autostart status` reports `enabled: false`, and there is no scheduled task or Startup shortcut. Its application log ends at 05:49:20 UTC, which is the Windows shutdown at 08:49 local (event 1074). Shutdown ended the process and nothing restarted it. No crash was involved.
- **Started** with the supported command `omniroute serve --daemon --no-open --no-tray` (daemon PID 2664), with no reinstall, configuration or credential change. `/api/health` returned `{"status":"ok"}` after about 36 s. The running bridge reconnected without a restart. Autostart was **not** enabled; enabling it needs owner approval (`omniroute autostart enable`).

### AI inference: live verification
| | Run 1 (before fixes) | Run 2 (after fixes, restarted bridge) |
|---|---|---|
| Run | `run_ae989ea7ccea431e` | `run_43c23bbb3b594e32` |
| Path | `POST /local-api/company/runs` (the UI's path), ORI `chat`, priority low | same |
| Selected model | `gemini/gemini-3.1-flash-lite` (api-free-tier; chosen = requested = effective) | same |
| Result | `succeeded`, output `جاهز.` | `succeeded`, output `جاهز.` |
| Streaming | SSE; phases connecting → waiting-for-model → receiving-response → completed | SSE; connecting → waiting-for-model → completed |
| Timing | headers 1,146 ms, first token 3,480 ms, total 3,560 ms. Client wall time 8.96 s (5.1 s cold router overview before connecting) | headers 1,023 ms, first token 1,344 ms, total 1,357 ms. Client wall time 1.58 s |
| Usage | 406 in / 119 out (116 reasoning) | 406 in / 145 out (142 reasoning) |
| Cost | `null`, basis `unknown` (router sent no cost header); never shown as $0 | same |
| Persistence | run row, one `usage_events` row (`application-measured`), activity `agent.assigned` + `agent.run.succeeded`. Identical after three bridge restarts | stored |
- OmniRoute's own call log shows the request (gemini-3.1-flash-lite, 406/119 tokens). It holds **two** rows for this single bridge attempt (different id formats, one marked `rerouted`). Both carry the same tokens. This was observed but not investigated, and it is not evidence of a second upstream call.
- Both runs were within budget: free-tier model, company daily $1 / 2M-token and monthly $10 hard budgets, about 11K tokens used today.

### Windows lifecycle (real bridge)
- `status` → `start` while healthy ("Using the healthy … PID 21460", no duplicate) → `stop` (clean in 1.5 s; state `clean: true`; PID file removed) → `status` (stopped) → `stop` again (no-op) → `start` (3.6 s) → `restart` (4.5 s) → restart again after the code changes. Data was identical across all of them: 40 projects, 5 tasks, 6 agents, 9 runs, integrity `ok`, 0 FK violations, and live run 1 was intact.
- **Defect fixed: zero-byte PID file.** A 0-byte `local\runtime\bridge.pid` (what a power loss during the write can leave) made every launcher action fail with "You cannot call a method on a null-valued expression", and the file was never cleared. Reproduced, then fixed in `ABUD-OS.ps1`: an empty, unparsable, zero or negative record is discarded.
- **Defect fixed: status hid OmniRoute.** The first `/local-api/infra` read after a start took more than 5 s (measured 7.6 s for the whole `status`), and an empty `catch {}` silently dropped the OmniRoute and database line. The timeout is now 20 s, and a failure prints an explicit "details unavailable" line.
- **Disposable lab** (launcher copy in the session scratch folder, port 4199, stand-in `server.mjs` that is alive but never answers): zero-byte, empty, missing (999999), negative and garbage PID files are all discarded. A PID recycled by `explorer.exe` was discarded with explorer untouched. Owned-but-unresponsive: `status` exits 1 with guidance, plain `stop` refuses, and `stop -Force` terminated only the disposable PID. The real bridge (PID 1340 at the time) was unaffected.
- Not exercised: a real Windows shutdown (`SIGHUP`) and sign-in autostart, which is still not enabled.

### Budget safety
- **Defect fixed: unknown paid cost counted as $0 against hard budgets.** `budgetGate` compared only the known cost sum with USD limits, so a paid run whose cost the router did not report added nothing. The monthly company budget is USD-only ($10), so repeated unpriced paid runs could pass it indefinitely. Now a budget is `unverified` when a **paid-class** event in its period lacks the measure the budget limits (no router cost for a USD limit, or 0/0 tokens for a token limit). A hard-stop `unverified` budget blocks further **paid** candidates (fail closed, with an Arabic reason). Free and api-free-tier candidates continue. Paid-model approval and provider eligibility are unchanged and still checked first.
- Router analytics no longer turn a missing cost field into `$0` (`num` → `finite`, shown as `—`). NEX budget advice now says "المصروف المعروف … + n تشغيل بتكلفة غير معروفة" instead of a bare `$0.0000`. Resources shows the `غير قابل للتحقق` state.
- Live effect: none today. Every domain policy allows only `free` and `api-free-tier`, so no paid model is eligible. Both company budgets read `ok` (known $0, 5 unknown-cost free-tier events, 0 unverified paid events).
- Known limitation: the policy field `maxCostUsd` (0.05) is stored but neither enforced nor shown. Per-request cost cannot be known before a call. Paid exposure is bounded by owner approval per run, `maxOutputTokens`, and the hard budgets above.

### Tests (final code)
| Command | Result |
|---|---|
| `cd apps/local-bridge; npm test` | **94/94 pass** (+2: hard budget fails closed for paid unknown cost or tokens; live-path runtime test showing approval → unpriced paid run → second paid run blocked with no inference → free run continues) |
| `npm run check`, `node --check` on all public and internal UI files | pass |
| `node tests/ops.mjs` | **18/18 PASS**, including public/private isolation and zero uncaught browser errors |
| `node tests/robot-qa.mjs` | pass: 6 identities, 12 forms, 9 states, unique SVG IDs, 0 errors |
| `node tests/smoke.mjs` | pass (18 PASS) |
| `_site` rebuilt exactly as `pages.yml`, then `node scripts/audit-static.mjs` | pass: 28 public entries, 23 assets |
| `node tests/stress.mjs 30` (synthetic child bridge) | pass: 3,016 requests, 0 5xx, 120 client aborts, router cut and restored, integrity `ok`, 0 FK violations, 0 stuck runs |
| `node tests/visual.mjs http://127.0.0.1:4172 local/qa-v4-final` (live, read-only) | 160 shots (32 routes × 1440/1024/768/390/360), **0 overflow, 0 errors**. Same bridge PID 10552 throughout. Team view 59.8 FPS, 0.32 ms mean robot script per frame |
| `git diff --check` | pass |
| Live AI inference | **2/2 succeeded** (table above) |
- Visually checked: Resources → التوجيه والميزانيات at 1440 px (RTL, budgets with unknown-cost annotation) and Agents at 390 px (six robots, RTL).

### Operational verification (live store)
- HQ, Projects, Work, six agents, AI Resources and System Center all render across five widths with OmniRoute connected. `/summary` responds. Counts: 40 projects, 5 tasks, 6 agents, 9 runs (one new live run).
- **Backup:** in-app `company-2026-10-25T13-06-32-923Z-b91976da6348.db` (385,024 bytes, healthy). **Restore rehearsal** in an isolated temporary folder: integrity `ok`, 0 FK violations, schema 4, projects 40/40, tasks 5/5, runs 9/9, usage 6/6, budgets 2/2. Activity 53 vs 54 live, because the backup itself logs one event. The live DB was not replaced. Five backups are kept, and none was deleted.
- **GitHub (read-only, `gh`):** `abudoxali/-abud-github-universe` connected: 1 open draft PR (abudoxali/-abud-github-universe#1, the V2 secure-workspace beta from `feat/v2-secure-os`), 0 issues, 0 releases, 5 workflow runs (newest Pages deploy on `main` = `failure`), 5 commits, 2 branches. No write.

### Git release review
- **Staged deletion (21 files):** all of `apps/private-server/` (V2 OAuth/PostgreSQL/GitHub App server, Dockerfile, nginx/systemd examples), `.github/workflows/private-ci.yml` (it only tests `apps/private-server/**`), and `docs/V2_SECURE_WORKSPACE.md`. **Evidence that it is intentional:** `docs/superpowers/specs/2026-10-24-local-universe-design.md` says "Remove the owner-login/private-workspace product from this repository and replace it with a small loopback-only bridge". The new README says "There is no in-app login, OAuth flow, PostgreSQL database, GitHub App or GitHub write operation". The deletion set is internally consistent.
- **Is it safe?** Partly. The V2 tree survives at `5b96753` on `origin/feat/v2-secure-os` (open draft PR abudoxali/-abud-github-universe#1) and on local `backup/v2-secure-os-before-universe-restore`. HEAD `df7dc2c` (Devin, 2026-10-10) changed 7 private-server files again (`public/app.js`, `index.html`, `style.css`, `src/server.js`, `src/github.js` and two test files). **No remote contains `df7dc2c`**, so that last V2 revision exists only in this local branch. An empty `apps/private-server/` directory remains on disk; Git ignores it. The VPS deployment recorded in `5b96753` is outside this repository and was not checked.
- **Required for a reproducible V4 release (85 untracked + 8 modified + 21 deleted):**
  - Bridge: `apps/local-bridge/package.json`, `apps/local-bridge/src/*.mjs` (14), `apps/local-bridge/tests/*.mjs` (12; no npm dependencies).
  - Internal UI: `internal/*.js` (14), `internal/os.css`, `internal/assets/agents/*.webp` (18 approved robot/sheet images, ≤376 KB each), `internal/assets/fonts/*` (2 woff2 + 2 OFL licences). Total 2.5 MB of assets.
  - Public UI: `local-worlds.{js,css}`, `universe-experience.{js,css}`, `project-map.{js,css}`, `project-board.{js,css}`, plus modified `index.html`, `app.js`, `command-center.js`, `.github/workflows/pages.yml`, `scripts/audit-static.mjs`, `tests/smoke.mjs`.
  - Launcher: `ABUD-OS.ps1`, `Start-ABUD-OS.cmd`.
  - Tests: `tests/ops.mjs`, `tests/robot-qa.mjs`, `tests/stress.mjs`, `tests/visual.mjs`. These need `playwright` (local 1.64.1, ignored `node_modules`, no root `package.json`; CI installs it unpinned).
  - Config examples: `local/workspace.example.json`, `local/worlds.example.json` (the owner's Windows username was replaced by `YOU` this pass), `local/routing-policy.example.json`.
  - Docs: `.gitignore`, `README.md`, `STATUS.md`.
  - Owner's choice: `docs/superpowers/` (3 planning notes, 144 lines, no secrets or paths; they are the evidence trail for the deletion).
- **Excluded and verified with `git check-ignore`:** `local/company.db*`, `local/backups/`, `local/logs/`, `local/runtime/`, `local/qa*/` (about 160 MB of screenshots), `local/workspace.json`, `local/routing-policy.json`, `local/worlds.json`, `.env*`, `.claude/`, `_site/`, `node_modules/`. Nothing under `local/` is tracked. The secret scan of every candidate file found only redaction regexes and obvious fake test tokens.

### Proposed commit (not executed; run only after owner approval)
Before anything else, preserve the last V2 revision remotely, for example `git push origin df7dc2c:refs/heads/archive/v2-private-server-df7dc2c`. Then use explicit paths, never `git add -A`:
1. `git add .gitignore` (ignore rules must land before any data-adjacent path).
2. Commit the V2 removal that is already staged, on its own: "Remove the V2 private server in favour of the local-first Company OS" (21 staged deletions, optionally with `docs/superpowers/`).
3. `git add apps/local-bridge internal ABUD-OS.ps1 Start-ABUD-OS.cmd local/workspace.example.json local/worlds.example.json local/routing-policy.example.json local-worlds.js local-worlds.css universe-experience.js universe-experience.css project-map.js project-map.css project-board.js project-board.css index.html app.js command-center.js .github/workflows/pages.yml scripts/audit-static.mjs tests README.md STATUS.md`, then commit "Add ABUD FUN Company OS V4 local release".
4. Check `git status --short` (only `docs/superpowers/` may remain if it was declined) and `git ls-files local` (must list only the three `*.example.json` files) before any push.

### Remaining blockers and limitations
- **Blocker for Stable:** the V4 source is uncommitted (85 untracked files exist only on this disk). It needs the owner's decision on the private-server deletion and draft PR abudoxali/-abud-github-universe#1, then the commit above.
- **Owner decision (not a code defect):** OmniRoute does not start after a Windows restart, so the AI workforce stays offline until it is started by hand (`omniroute serve --daemon --no-open --no-tray`) or autostart is approved. HQ reports this honestly.
- The V3 screenshot-sweep bridge exit is still unexplained. It has not recurred in this pass's 160-shot sweep, stress run, or four launcher stop/start cycles, and any future exit is classified automatically.
- Not exercised live: Windows-shutdown graceful path, sign-in autostart, a paid-model run (none eligible by policy).
- The GitHub Pages workflow on `main` is failing remotely (not investigated). There was no physical-device QA.

### Release classification
**V4 Release Candidate (operationally ready).** Every required operational check passed in this pass. It becomes **V4 Stable Local Release** once the owner approves and the source commit above is made, so the release can be reproduced from Git.

---

## V4 second pass (2026-10-25 15:30; superseded where the section above differs)

### Source state
- this checkout, branch `feat/restore-original-universe`, HEAD `df7dc2c`, remote `https://github.com/abudoxali/-abud-github-universe.git`. The inherited staged deletion of `apps/private-server/` and the untracked V2–V4 source were preserved. No reset, commit, push, deployment, Windows startup registration or OmniRoute change.
- The six approved robots, twelve forms, SVG engine, palette, fonts and six workspaces were not changed. Robot QA output is identical (6 identities, 12 forms, 9 states).

### Bridge exit investigation (Priority 1)
- **Found:** the bridge launched at 05:28 UTC by the earlier pass vanished with no shutdown or fatal line and an empty stderr. The Windows System log shows a user-initiated shutdown (event 1074) at 08:49 local and boot at 14:40. That disappearance is therefore explained by the OS shutdown, not by a crash. The V3 screenshot-sweep exit remains **not reproduced and not root-caused**. A plausible but unproven cause is that the bridge was started inside a coding-agent shell whose process tree was ended; there is no surviving evidence to confirm it.
- **Added so any future exit is diagnosable:** `apps/local-bridge/src/lifecycle.mjs` writes a heartbeat (every 30 s, with RSS/heap and peak RSS) to ignored `local/runtime/bridge-state.json`. The next start classifies the previous session as `system-restart` (boot after last heartbeat), `fatal-error` (logged with redacted message and up to 8 stack frames, user paths masked), or `unexpected-exit` (terminated externally or native crash). It records an activity event and, except for Windows restarts, an Arabic notification; System → نظرة عامة shows it. A second process started while the first is alive neither classifies nor overwrites the live record.
- **Also hardened:** `SIGHUP` (Windows console close, sign-out, shutdown) and `SIGBREAK` now trigger graceful shutdown (untested against a real Windows shutdown). A process exit is guaranteed 3 s after the server closes. The run scheduler no longer turns a transient store error into an unhandled rejection that stops the bridge; it logs `scheduler-error` and retries in 5 s. Tool time-out timers are now cleared after each call.
- **Verified live on Windows:** external `Stop-Process` of the bridge, then `start` → classified `unexpected-exit` with PID, last heartbeat, boot time and memory, and a warning notification raised. That notification came from this deliberate test and was acknowledged. Clean stop → start → no previous-exit flag.
- **Stress (`tests/stress.mjs`, child bridge, synthetic data, background loops on):** 60 rounds, 6,010 requests, 240 client aborts mid-request, router cut at one third and restored at two thirds: 0 5xx, 0 transport failures, router reconnection detected, integrity `ok`, 0 FK violations, 0 stuck runs; runs succeeded while up, failed honestly while down, and cancellations worked. Post-GC heap stayed flat at 12–13 MB (`STRESS_HEAP=1`). RSS plateaued about 127 MB, so no leak was found.
- **Live sweep:** `tests/visual.mjs` against the real bridge, 160 captures (32 routes × 1440/1024/768/390/360): 0 overflow, 0 browser errors; the same PID 21460 stayed up throughout (RSS 64 → 80 MB). Team view: 60.3 FPS, 0.45 ms mean robot script time per frame.

### Windows launcher
- `Start-ABUD-OS.cmd` (CRLF, passes all arguments) / `ABUD-OS.ps1`: `start`, `status`, `stop`, `restart`, plus `-Force`, `shortcut`, `autostart-on|off|status`. Port 4172.
- **Defect fixed:** after a crash or reboot, a stale `bridge.pid` pointing at a recycled PID made the launcher throw and refuse to start. It now discards a PID that is not this project's `node … server.mjs` and never touches that process. Verified with a PID file pointing at `explorer.exe`: start succeeded and explorer was untouched.
- Startup now waits until `/health` reports the child's own PID (health now includes `pid`, `uptimeSec`). `status` shows uptime, memory, OmniRoute state and the previous-exit classification. `stop -Force` terminates only the verified owned PID when it no longer answers. Logs are kept for the newest 30 starts.
- Sign-in start is opt-in through a shortcut in the user's Startup folder (no admin, no service). It was tested only against a scratch folder; **it is not enabled**.

### Company data and workflows
- **Defect fixed — duplicate projects:** GitHub account `3bud-ZC` was renamed to `abudoxali` (`gh api repos/3bud-ZC/GuestFlow` redirects to `abudoxali/GuestFlow`, same repository ID). Local checkouts still had old remotes, so 8 repositories existed twice and 2 more were stored under the old owner. Migration 4 (`github_identities`, additive) stores GitHub's read-only answer per observed remote. Sync maps checkouts through confirmed identities. Duplicates are merged in one transaction (checkouts, tasks, runs, usage, milestones, agent links, memory, budgets, activity and notification targets re-pointed; the superseded row is snapshotted into the activity log). Live result: **48 → 40 projects, 0 duplicate names, all 27 checkouts kept, 0 FK violations** (8 merged, 2 renamed). Without `gh`, nothing is confirmed and identities stay as observed.
- **Defect fixed — `$0` for unknown cost:** usage aggregates folded router-unreported cost into `$0.00`. Three of five live usage events have unknown cost. Aggregates now carry `unknownCostEvents`; the UI shows `غير معروفة` or `$x + n غير معروفة`. Budget math still uses the known sum (behaviour unchanged).
- **Defect fixed — HQ while OmniRoute is offline:** HQ said agents were "on standby" and reported "no agents without a model" / "no quota pressure". It now says agents are stopped until OmniRoute returns and shows `غير معروف حاليًا`.
- Inference timeout settings now reject inconsistent combinations (connect > headers, or any phase > total) as well as out-of-range values.
- The router-offline notification now carries an Arabic reason plus the technical state.
- Live task store: 5 tasks, 6 agents, 8 runs (unchanged). The Work Hub, archive/restore and cross-module task views pass in `tests/ops.mjs` (synthetic). No live task was created.

### GitHub (read-only)
- `gh` is authenticated. Live read of `abudoxali/-abud-github-universe`: connected; 1 open PR, 0 issues, 5 workflow runs, 0 releases, 5 commits, 2 branches. The newest **Pages deployment on `main` concluded `failure`**. That is the repository's real remote state and was reported, not changed. Slugs with `.`/`..` segments are now refused before any `gh api` call. No GitHub write was made.

### OmniRoute / AI workforce
- OmniRoute 20128 is **not running** since the Windows restart (installed as an npm global; no autostart). It was not started, restarted or reconfigured. The offline path was verified live: HQ, System and Resources show the outage, agents are unavailable, and the bridge keeps working.
- **Live inference was not re-run in this pass.** The last live success remains `run_2d82f1593fed470c` from the earlier V4 pass (ORI, `gemini/gemini-3.1-flash-lite`). Streaming, timeout phases, fallback, cancellation, budgets and the multi-agent project assessment (NEX evidence → REX scan → ORI synthesis → LUNA follow-ups) remain covered by stub tests only in this pass.

### Database, backups, recovery
- Pre-change backup `local/backups/pre-v4-claude-2026-10-25T11-56-01Z.db`: integrity `ok`, schema 3, 48 projects / 5 tasks / 6 agents / 8 runs, 0 FK violations.
- Live store now: schema 4, integrity `ok`, 0 FK violations, 40 projects, 5 tasks, 6 agents, 8 runs, 22 GitHub identities, 51 activity events.
- Post-change in-app backup `company-2026-10-25T12-27-17-703Z-7b27d62a17f1.db` (372,736 bytes, healthy). The new **اختبار الاستعادة** action copied it to a temporary folder: integrity `ok`, 0 FK violations, schema 4, projects 40/40, tasks 5/5, runs 8/8. The temp copy was removed and the live DB was not touched. Backup failures are now logged as failed activity with an Arabic reason. Backup health verdicts are cached per file, so listing no longer re-checks every backup on each request. The JSON export now includes `githubIdentities`. No backup was deleted.

### UI defects fixed (no redesign)
- The desktop sidebar scrolled away on long pages: the public `body { overflow-x: hidden }` made `<body>` a scroll container, so `position: sticky` never engaged. Fixed in `internal/os.css` only (`overflow-x: clip` under `body.ops-mode`). The visual sweep now checks for it.
- Bidi: identifiers starting with a digit (`3bud-ZC/…`) rendered as `bud-ZC/…3`. `rich()` now keeps the digit run with the identifier.
- A regression introduced and fixed during this pass: `$` was briefly dropped from `fmt.usd`. `tests/ops.mjs` caught it, and the full suite was re-run after the fix.

### Tests (this pass, final code)
| Command | Result |
|---|---|
| `cd apps/local-bridge; npm test` | **92/92 pass** (85 → 92: identities, resolver, lifecycle ×4, unknown cost; migration/timeout tests extended) |
| `npm run check` | pass (now includes `lifecycle.mjs`) |
| `node tests/ops.mjs` | **18/18 pass** (offline check extended for HQ honesty) |
| `node tests/robot-qa.mjs` | pass: 6 identities, 12 forms, 9 states, 0 errors |
| `node tests/smoke.mjs` | pass (18 PASS lines) |
| `node scripts/audit-static.mjs` | pass: 28 public entries, 23 assets |
| `node tests/stress.mjs 60` (`STRESS_HEAP=1`) | pass; figures above (synthetic) |
| `node tests/visual.mjs http://127.0.0.1:4172 local/qa-v4-claude` | 160 shots, 0 overflow, 0 errors (live, read-only) |
| `git diff --check` | pass |
| Live AI inference | **not run** (OmniRoute offline) |

### Remaining limitations
- The V3 screenshot-sweep bridge exit is unexplained; future exits will now be classified.
- Live inference was not re-verified in this pass; it needs OmniRoute running.
- The Windows-shutdown graceful path (`SIGHUP`) and `stop -Force` termination were not exercised live.
- Autostart and desktop shortcut were tested only in a scratch folder.
- The GitHub Pages workflow on `main` is failing remotely (not investigated here).
- No physical-device QA, and no extended real owner use of every workflow.

### Release readiness
Usable **local release candidate**. It is not yet a declared stable release, because live AI was not re-verified after this pass's changes and the historical exit has no root cause.

### Git state / release review
- Nothing committed or pushed. `git status`: 29 tracked changes (21 staged deletions of `apps/private-server/`, `.github/workflows/private-ci.yml`, `docs/V2_SECURE_WORKSPACE.md`; modified `README.md`, `STATUS.md`, `app.js`, `command-center.js`, `index.html`, `.github/workflows/pages.yml`, `scripts/audit-static.mjs`, `tests/smoke.mjs`) and 85 untracked files (bridge, `internal/`, launcher, tests, public UI modules, `docs/superpowers/`, three `local/*.example.json`).
- Ignored and verified: `local/company.db*`, `local/backups/`, `local/logs/`, `local/runtime/`, `local/qa*/`, `local/workspace.json`, `local/routing-policy.json`, `local/worlds.json`, `.claude/`, `_site/`, `node_modules/`. A secret-pattern scan of untracked files found only redaction regexes and obvious fake test tokens. The largest untracked assets are the agent sheet `.webp` files (≤376 KB).
- Before any commit: confirm the staged `apps/private-server/` removal is intended, and decide whether `docs/superpowers/` planning notes belong in the repository.

---

## Earlier V4 pass (2026-10-25 morning; superseded where the section above differs)

- **Source:** this checkout, branch `feat/restore-original-universe`, HEAD `df7dc2c`, remote `https://github.com/abudoxali/-abud-github-universe.git`. Existing staged removal of the private-server tree and extensive untracked V3/V4 source were preserved. No reset, commit, push, deployment, or Windows startup task registration.
- **Daily Windows runtime:** `Start-ABUD-OS.cmd` and `ABUD-OS.ps1` start at `127.0.0.1:4172`, check Node >=22.13, project files and the existing database, verify health, avoid duplicate owned instances, open the browser, and support `status`, `stop`, `restart`. An unrelated port listener is refused rather than stopped. The launcher stores its PID and stdout/stderr under ignored `local/runtime/` and `local/logs/`. Optional sign-in startup is documented in README but not enabled. Actual start → status → graceful stop → start → restart → persisted run check passed on Windows using Node 24.11.0.
- **Bridge reliability:** standalone lifecycle events, structured fatal/listen errors, request IDs and slow/5xx request records were added without logging request bodies or router secrets. Shutdown uses a session-protected local request and closes the HTTP server, runtime, operations loop, and database. The previous screenshot-sweep exit remains unexplained. This V4 pass completed 125 browser route/width captures and 180 concurrent read requests (0 failures; the same bridge PID stayed healthy), followed by a clean restart. This is evidence of stability under those loads, not proof that the historical exit is impossible.
- **SQLite safety:** before changes, `local/backups/pre-v4-2026-10-25T05-13-20-711Z.db` was created with `VACUUM INTO`; live and backup integrity checks returned `ok`, schema version 2, 48 projects, five tasks, six agents, seven runs. The in-app backup endpoint then created `local/backups/company-2026-10-25T05-18-12-904Z.db` (339,968 bytes), marked healthy only after integrity/schema verification. Its isolated restored copy returned `ok` and 48 projects, five tasks, seven runs; the live store was not overwritten. A second healthy backup, `local/backups/company-2026-10-25T05-24-29-411Z.db`, protected the eight-run store before the additive task-archive migration. Backup listing now identifies unhealthy files and System Center selects the latest healthy one. Backup names now include a random suffix so rapid consecutive attempts cannot target the same filename; the new format was verified live with healthy `company-2026-10-25T05-28-05-649Z-0ee35c17aaf7.db` (348,160 bytes). After restart, the live store migrated to schema 3 with integrity `ok`, 48 projects, five tasks, six agents, and eight runs; no existing record was deleted.
- **Work Hub:** added confirmed soft archival and restoration of tasks. Archived tasks and their audit history remain in SQLite, are excluded from active task, project, HQ, agent, calendar, and overdue counts, and appear under the existing completed-work tab. Archival is refused while an agent run is queued or active. Synthetic browser and store tests verified archive → hidden from active views → restore, plus the additive migration from a v1 database.
- **GitHub:** authenticated `gh` CLI is available. Project repository views now fetch bounded, read-only remote metadata, open issues and PRs, recent Actions runs, releases, commits, and branches, with a 90-second cache and explicit disconnected/partial states. Local Git state and owner-controlled company project status remain separate. The live `abudoxali/-abud-github-universe` query returned connected metadata, one open PR, five recent workflow runs, five commits, and two branches; no GitHub write call was made.
- **AI and OmniRoute:** current router overview was connected and ORI's chosen route was the eligible free-tier `gemini/gemini-3.1-flash-lite`. One small live ORI request (`run_2d82f1593fed470c`) succeeded, answered `جاهز.`, recorded 516 tokens and unknown cost basis, and survived a bridge restart with identical output. Synthetic bridge tests cover SSE/JSON, timeout phases, fallback, cancellation, permissions, budgets, multi-agent assessment, and offline display. No OmniRoute setting or installation was changed.
- **UI/QA:** six approved workspaces, violet/white RTL UI, fonts, and approved SVG robots were preserved. The operational browser suite's obsolete 322-pixel viewBox assertion was updated to the approved 325-pixel viewBox; no robot geometry or colors changed. `tests/visual.mjs` captured 125 screenshots across 1440, 1024, 768, 390, and 360 px: zero horizontal overflow and zero browser errors. Selected 1440/390/360 captures were visually inspected. These are Chromium viewport checks, not physical Android device tests. Team view measured 59.5 FPS and 0.421 ms mean SVG scheduler time over four seconds on this host.
- **Tests:** `cd apps/local-bridge; npm test` 85/85 after the archive addition; a subsequent focused 12/12 company run verified distinct rapid-backup filenames. `npm run check` pass; `node tests/ops.mjs` 18/18 checks pass including archive/restore; `node tests/robot-qa.mjs` pass (six identities, twelve forms, nine states); `node tests/smoke.mjs` pass; `node scripts/audit-static.mjs` pass against an exact 23-file generated public artifact (28 public catalog entries); `git diff --check` pass. An initial direct static-audit call failed only because `_site` had not been prepared; it passed after the required artifact was assembled. The generated `_site`, logs, runtime PID, QA captures, SQLite files, backups, and local machine config are ignored by Git.
- **Remaining limitations / release decision:** V4 is a usable local release candidate, not an unconditional final stable release. The earlier unexplained bridge exit was not reproduced, so its root cause remains unknown. Core automated company workflows passed, but all workflows have not been accepted through extended real owner use. GitHub data depends on the authenticated CLI and its API availability. The inherited staged deletions and broad untracked source need a deliberate release review before any commit; no source-control publication was performed. No physical device QA or Windows sign-in auto-start registration was performed.

---

## Historical V3 verification record (superseded by V4 above)

- **Checkout:** this checkout, branch `feat/restore-original-universe`, HEAD `df7dc2c`. The older `.claude/worktrees/abud-os-v2-restructure-c607f8` remains untouched as historical V2 work; it is not the current implementation. No source was copied back from it in this pass.
- **Inherited from Claude:** the six-workspace V2 shell had already been copied into main, along with the SQLite bridge, routing/agent runtime, six code-rendered SVG robots, twelve forms, motion scheduler, portraits, gallery, and prior layout fixes. `omniroute.mjs` contained an unfinished SSE/timeout implementation; `runtime.mjs` still used flat calls and sequential retry order. The previous STATUS text below described the isolated V2 worktree and had become stale.
- **Working tree:** main contains extensive pre-existing uncommitted/staged changes and untracked V2/V3 files, including staged removal of the old private server. This V3 pass preserved them. None of these changes were committed, pushed, reset, or deployed.

### Router and persisted execution

- SSE now parses incremental UTF-8, split lines, multi-line data frames, `[DONE]`, usage frames, final snapshots without duplicate output, and provider errors. Truncated or empty streams fail. JSON responses remain supported with the same `chat()` response shape.
- Each inference checks the local health endpoint, then applies separate bounded limits for local connection, inference headers, first useful assistant content, streaming inactivity, and total attempt. These are company settings (`inferenceTimeouts`) exposed in System settings; no OmniRoute configuration was changed. A header delay is not asserted to be an upstream connection delay.
- Persisted attempts record route, provider, observed connection ID if present, start/finish, transport, header/first-content/total timing, outcome, timeout phase, and fallback reason. Progress is persisted by actual phase (`connecting`, `waiting-for-model`, `receiving-response`, `retrying`, `switching-provider`) with write throttling and visible in the run UI. No invented percentage is displayed.
- On a stalled route, other eligible providers are tried before another model of that provider within the same run. A 60-second cross-run cooldown applies **only** when the router identifies the actual failing connection and the overview maps the candidate uniquely to it. If the connection ID is absent, no cross-run provider ban is inferred. Eligibility, subscription restrictions, budgets, and paid-model approval still gate every attempt.
- **Live check after refactor:** ORI `run_c50d3debd95b4728` succeeded on `gemini/gemini-3.1-flash-lite` in one **SSE** attempt. Measured 1,013 ms to headers, 20,772 ms to first useful content, 20,782 ms total; 383 input and 123 output tokens. Router cost was unavailable, so no $0 claim. A separate small live run `run_e607e3bc895d46ad` also succeeded in one attempt; its transport was not recorded before that telemetry field was added. The selected connection ID was absent in the instrumented live response, so cross-run cooldown itself was verified with a stub, not this live run.

### Character engine and visual comparison

- Preserved the shared articulated SVG rig and lightweight code-derived portraits. Added richer armor gradients, specular surfaces, glossy visor framing, helmet side plates/chin, layered mechanical ear shells and hinges, deeper headset pods, split chest armor, core housing, abdominal/pelvis panels, forearm and leg plating, knee and ankle details, and per-agent chest marks. Ear changes were visually adjusted after the first browser render. Reduced-motion listener and reaction timer cleanup now release with the instance.
- Six identities retain their roles and source palettes. ORI has the command crest and directed working pose; MIA has the bow and creative prop; NEX has technical visor/HUD cues; LUNA has the butterfly and supportive gesture; ZEN has the sprout and exploratory pose; REX has heavier armor and a shield pose. All use the same rig, with a distinct standard and expressive form (12 total). Nine operational motion states and distinguishable face expressions are present.
- **Comparison:** the new forms have more readable mechanical anatomy, materials, and silhouette than the inherited card render. The original owner sheets remain the quality benchmark; the SVG output still has flatter lighting, simpler hands/joints, and less depth than those 3D renders. It is a substantial 2.5D improvement, not a match to the reference's 3D finish.
- Actual Chromium captures reviewed: `local/qa-v3-before/1440/agents.png` (before), `local/qa-v3-final/1440/agents.png` (after in the live app), `local/qa-v3-robots/twelve-forms.png` plus 12 individual form captures. All six original sheets under `internal/assets/agents/` were inspected. The REX expressive form initially exceeded the viewBox; the viewBox was expanded and all twelve form bounds rechecked.

### UI, data, and verification

- Run lists and detail views now show observed execution phases; System settings shows the five local inference limits. The existing violet/white RTL design, six workspaces, and font choices remain intact. No further redesign was introduced.
- `apps/local-bridge`: **82/82 tests pass**; syntax check passes. Tests cover JSON and SSE inference, split chunks, incomplete streams, auth, cancellation, connection/header/first-content/idle/overall timeout phases, connection cooldown, cross-provider fallback with and without connection ID, budget and paid approval, persisted run behavior, and pre-existing bridge behavior.
- `tests/ops.mjs`: **18 checks pass**, including six workspaces, task persistence, agent execution using a stub, project navigation, quota/resources, notifications, backup UI, migration, public isolation, and responsive checks. An outdated assertion expecting six static `<img>` avatars was updated to check six live code-rendered SVGs.
- `tests/robot-qa.mjs`: six identities, twelve forms, nine states, expressions, unique SVG IDs/references, finite rig transforms, all form/state bounds inside the viewBox, reduced motion, disposal, and zero browser exceptions pass. Individual screenshots were captured.
- Public `tests/smoke.mjs` passes. Static publication audit passes against a temporary exact 23-file artifact (28 public catalog entries, no internal asset leak). `git diff --check` passes for tracked changes.
- Chromium browser QA: **27 desktop/tablet screenshots** across 1440/1024/768 px and **50 mobile screenshots** across 390/360 px, all with zero horizontal overflow and zero recorded browser errors. These are browser viewport checks, not Android-device `adb` results. A prior live sweep also captured 75 desktop/tablet screens before the pre-existing bridge process stopped; its final summary was not written. The bridge was restarted and health checked, while the complete mobile/desktop QA summaries were produced against a separate in-memory bridge.
- Measured team-view performance at 1440 px: 60.3 FPS over four seconds, 16.7 ms p95 frame interval, 0.48 ms average and 0.9 ms max robot scheduler script time per frame with six instances (three visible). The 390 px isolated run measured 60.3 FPS with one visible robot; these are local Chromium measurements, not device benchmarks.
- Main live `local/company.db` and `local/backups/pre-v3-20261025-064422.db` each returned `PRAGMA integrity_check = ok`. The live store has 48 projects, five tasks, seven runs after the two authorized small live checks, and six agents. The backup has the same projects/tasks/agents and five earlier runs. No database reset or destructive migration occurred; existing backup files remain.

### Remaining limitations and release decision

- **Local functional RC: yes. Final visual acceptance: pending.** The original sheets have substantially richer 3D material depth and micro-mechanics. A further art pass would be needed to match them closely. No claim of full 3D parity is made.
- The live second SSE request needed 20.8 seconds for first content; upstream latency remains variable. The router did not expose a selected connection ID on that response, so only per-run provider ordering can be applied there. Cross-run cooldown needs an observed ID.
- The original live bridge on port 4172 stopped during the first long screenshot sweep for an undetermined reason. It was restarted with the current code and returned a healthy v3 response; the extra in-memory QA bridge was stopped afterward. The cause of the earlier process exit was not determined.
- No signed-in production QA, deployment, real Android test, or owner visual/Arabic-copy acceptance was performed. This is a local-only release candidate. The main working tree remains uncommitted and includes inherited staged deletions/untracked files; release packaging or push requires a separate review.

---

## Historical V2 record below (superseded by the V3 state above)

This archived account records the isolated V2 session. Its claims that the main checkout still runs V1 or that V2 is unmerged are no longer current.

### V2/0. Where that work was

- **Implementation location:** git worktree `.claude/worktrees/abud-os-v2-restructure-c607f8`, branch `claude/abud-os-v2-restructure-c607f8`.
- **Why a worktree:** the authoritative V1.x Company OS (`apps/local-bridge`, `internal/`, `local/`) exists only as **uncommitted files in the main checkout** (`feat/restore-original-universe`, HEAD `df7dc2c`). That state was copied byte-for-byte into this worktree, and all V2 work was done there. **The main checkout, its uncommitted files and its live `local/company.db` were not modified.**
- **Data safety:** before any change, a consistent online backup of the live store was made with `VACUUM INTO` and checked with `PRAGMA integrity_check = ok`: `local/backups/pre-v2-redesign-20261025-045528.db` in the main checkout (288 KB; 48 projects, 5 tasks, 5 runs, 6 agents, 37 quota observations, 28 activity events). The worktree's bridge runs on a **copy** of that store (`local/company.db` inside the worktree). The schema-2 migration was applied to that copy only.
- **Commit / push / deploy:** nothing was committed, pushed or deployed. The live OmniRoute configuration was not changed. To adopt V2, copy the changed files listed in §11 into the main checkout (or commit this branch and merge). On first start, the bridge migrates the live store to schema 2 additively.

### V2/1. Product structure

Six primary workspaces replace the nine V1 areas. Each workspace has contextual tabs. Exactly one workspace and one tab are visible at a time, and legacy sections are never stacked below new pages.

| Workspace | Tabs | Absorbed from V1 |
|---|---|---|
| **الرئيسية** (Company HQ) | — | Overview, Daily Command Center (now a Projects report) |
| **المشاريع** (Projects Hub) | نظرة عامة · كل المشاريع · عالم المشاريع (الخريطة / مسرح العوالم / الكتالوج العام / العلاقات / التركيز) · المشاريع المحلية (المستودعات / عوالم الجهاز) · التقارير والقرارات (تقرير الشركة / قرارات المشاريع / سجل المتصفح / نشاط GitHub العام) + a detail page per project | Project Universe, Projects, local repository table, decisions, weekly report, execution journal |
| **العمل** (Work Hub) | اليوم · اللوحة · التقويم · القادمة · حسب المشروع · حسب الوكيل · المنجزة | Work management + the legacy browser Workboard (now migrated; its old UI is a read-only archive) |
| **الوكلاء** (AI Workforce) | الفريق · طلب جديد · التشغيلات + a workspace per agent (8 tabs) | AI Workforce |
| **الموارد الذكية** (AI Resources, NEX) | نظرة عامة · الحصص · الاستهلاك · المزودون والنماذج · التوجيه والميزانيات · توصيات NEX | AI Usage & Quotas, NEX resource centre |
| **النظام** (System Center) | نظرة عامة · التكاملات · النشاط · البيانات والنسخ · الأمان · الإعدادات | Infrastructure, Activity, Settings, developer-tool discovery |

**Route compatibility:** `#view/overview → hq`, `#view/universe → projects/universe`, `#view/projects → projects`, `#view/workboard → work`, `#view/usage → resources`, `#view/infra → system/overview`, `#view/activity → system/activity`, `#view/settings → system/settings`. Old in-page anchors (`#map`, `#library`, `#relations`, `#worldConsole`, `#daily`, `#workboard`, `#reports`, `#decisions`, `#worlds`, `#agentSystem`, `#project/…`) are rewritten with `history.replaceState`. `#view/agents/<id>` deep links still work. New deep links: `#view/projects/p/<id>/<tab>` and `#view/agents/<id>/<tab>`.

### V2/2. Architecture changes

- **Frontend:** still dependency-free modular JavaScript (no framework added). `local-worlds.js` (public) now loads a single `internal/ops-loader.js`, which owns the module list and the one internal stylesheet. Modules:
  - `ops-core.js`: shell, data layer, router, design primitives.
  - `ops-company.js`: shared task/project/activity layer.
  - Workspaces: `ops-hq.js`, `ops-projects-hub.js`, `ops-work.js`, `ops-workforce.js`, `ops-resources.js`, `ops-system.js`.
  - Retained and adapted: `ops-usage.js` (live OmniRoute blocks) and `ops-agents.js` (dev-tool discovery).
  - Removed (superseded): `ops.css`, `company.css`, and `ops-projects.js` (its browser-local link table competed with the company store).
- **Visibility model:** sections declare `data-os-view` / `data-os-tab` / `data-os-part`. A generated stylesheet keyed on `body[data-os-*]` shows only the active one, so modules can re-render freely.
- **Bridge** (additive changes only):
  - Schema migration 2: `projects.focus` (0/1, at most 3) and `import_ledger`.
  - Richer `/summary` for HQ (priority/focus projects, active runs, pending approvals, quota pressure grouped per provider).
  - NEX recommendations grouped per provider and condition, each with a `category` (`critical | warning | optimization | info`). Normal quota exhaustion is now a **warning**, not critical, in both recommendations and notifications.
  - Bundled-font allowlist (`internal/assets/fonts/*.woff2`, `font/woff2`).
  - When the bridge serves `index.html`, it drops the Google Fonts `<link>`s and adds a CSS-only boot guard (no flash of the public layout).

### V2/3. Design system

- **Theme:** "Luminous Violet". Light canvas `#FAF9FF`, white and lavender surfaces, violet actions `#7C3AED`/`#8B5CF6`, deep-purple `#32145B` sidebar and hero areas, semantic ok/warn/bad/info colours with AA-contrast text tones. Tokens live under `body.ops-mode` in `internal/os.css`, so the public Universe is unaffected. No dark theme yet (optional; not started).
- **Fonts:** bundled locally under the SIL OFL 1.1 (licence texts in `internal/assets/fonts/`):
  - Alexandria (Arabic subset, variable weight, 31 KB).
  - Manrope (Latin subset, variable weight, 25 KB).
  - No runtime CDN; system fallbacks are kept.
- **Type scale:** page title 28–36 px, panel title 19 px, body 16 px (line height 1.75), labels 14.5 px. Nothing routine is below 12.5 px.
- **Components:** sidebar (collapsible rail, live health), top bar (global search across projects/tasks/agents, Create menu, notifications popover, OmniRoute pill, owner menu), page header with tabs/parts, KPI tiles, panels, badges (text plus marker, never colour-only), segmented controls, task card, quick-add composer, drawer with focus trap, confirmation dialog, toasts, skeletons, empty states, an Arabic date control (native picker, Arabic label), meters, tables.
- **Behaviour:**
  - `prefers-reduced-motion` and `forced-colors` are honoured.
  - Visible focus rings; keyboard shortcuts `/` and Ctrl+K open search.
  - Bidirectional isolation for Latin identifiers inside Arabic text (`rich()`, `<bdi>`, `unicode-bidi: plaintext`).
  - Re-renders keep focus, caret and in-progress form edits (`fill` focus restore, `editing()` deferral).

### V2/4. Workspaces — historical verification

| Area | Status |
|---|---|
| HQ | Compact hero (Cairo date, greeting, one-sentence operational summary from real counts, six-agent crew with live state), five KPIs, Today's Work with quick add, Priority Projects (focus projects first), Needs Attention (each signal shown once, most severe first), team, AI-resource health, recent activity. **Implemented + automated + live.** |
| Projects | Overview KPIs, attention list, 14-day deadlines, recently updated, local-repo health; card/table inventory with filters and a focus toggle; Universe parts (graph / list / board unchanged); repository manager (filters, expandable details, manual link/unlink stored in SQLite, targeted rescan, duplicate detection); company report generated from the store with Markdown export; per-project detail page (overview, tasks, repository, agents and runs, notes and decisions, activity). **Implemented + automated.** |
| Work | Seven views; stable quick-add; focus strip with real progress; drag-and-drop board plus a status-select keyboard alternative; Saturday-first Arabic calendar in Cairo time. **Implemented + automated.** |
| AI Workforce | Team hero (original lineup), six cards with original lineup art shown whole (`object-fit: contain`), guided request composer (pick agent → task type → project → request → live route review → send), runs history, agent workspaces with each agent's full studio render (NEX: lineup card and sheet; nothing generated), safe Markdown result rendering (headings, lists, bold, code) with provenance. **Implemented + automated + live (MIA).** |
| AI Resources | NEX executive summary, honest KPIs (provider-reported capacity, quota pressure, agent usage, budgets), grouped recommendations with evidence/recommendation/impact/risk/confidence/approval, quotas with provenance legend and manual reconciliation, stored quota history with a stale-reading warning, app-measured versus router-observed consumption, providers table, approval-gated router proposals, budgets, domain routing policies. **Implemented + automated + live (read-only).** |
| System | Service cards (bridge, OmniRoute, store, last backup, dev tools, remote connectors "غير مُعدّ"), integrations (OmniRoute, GitHub via `gh`, workspace roots without absolute paths, advisory policy, dev-tool discovery), searchable activity timeline filtered by actor/agent/project/outcome with technical details folded away, backups/export/migration, security boundaries, settings. **Implemented + automated.** |

### V2/5. Data consolidation

- **Single task system:** company SQLite. A task created in HQ, the Work Hub, a project page or an agent workspace appears in all of them (covered by an automated test).
- **Browser migration** (automatic, idempotent): when legacy browser data exists and has changed since the last run, the shell posts it to `/import/browser`. The import carries over:
  - tasks (deduplicated by `externalRef`);
  - focus projects (into `projects.focus`, at most 3, never un-focusing);
  - the execution journal (into owner activity events at their original timestamps);
  - project-board notes and manual links.

  Every step is recorded in `import_ledger`, and a re-run imports nothing and writes no audit noise. Browser data is never deleted. Board placements stay browser-local by design.
- **Single project identity:** `gh:owner/repo` (or `prj:…`). Checkout links now live only in SQLite (the V1 browser-local link table is no longer used).

### V2/6. AI Workforce and OmniRoute (historical live check, 2026-10-25)

- **OmniRoute:** 3.8.52 on `127.0.0.1:20128`, connected. Not reinstalled, restarted or reconfigured. Router writes are disabled (`ABUD_ROUTER_WRITES` unset).
- **Agents:** all six live route previews eligible (gemini-3.1-flash-lite / gemini-3.8-flash).
- **Live run — MIA's first:** run `run_731090a992864ac2` (chat) against the worktree store.
  - First candidate `gemini/gemini-3.8-flash` hit the 90 s per-attempt timeout.
  - The bounded fallback succeeded on `gemini/gemini-3.1-flash-lite` (424 / 1,035 tokens, router-estimated $0, 19.1 s).
  - The Markdown result rendered correctly in the new drawer.
- **Live quota pressure:** grouped as moonshot 3/3, antigravity 2/2 and agy 2/2 windows exhausted. Shown as warnings or info, not incidents.
- **Delegation:** OmniRoute-routed sub-agent delegation was **not used**. This coding environment (Claude Code) has no supported way to route its own sub-agents through OmniRoute, and no consumer-subscription quota was accessed.

### V2/7. Verification (historical worktree)

| Suite | Result |
|---|---|
| `cd apps/local-bridge && node --test tests/*.mjs` | **71 passed, 0 failed.** Baseline was 68/68. New tests: v1→v2 in-place migration preserving data, focus cap and validation, journal and focus migration exactly once, bundled-font serving, traversal refusal, no CDN font `<link>`, boot guard. One assertion legitimately changed: schema version 1 → `MIGRATIONS.at(-1)`. |
| `node tests/ops.mjs` (Chromium, stub router) | **18 PASS, exit 0 on the final code** (rewritten for V2; baseline V1 suite was 18 PASS). Coverage: six-workspace shell and Arabic RTL; legacy routes and anchors; global search; quotas, analytics and providers with provenance; manual reconciliation; dev-tool discovery; Universe graph/list/board; project sync, repository manager, manual link/unlink in the store, duplicates, targeted refresh; project detail and focus; secrets never reach the DOM or localStorage; no overflow on every workspace and tab at 1440 and mobile; router-offline honesty in resources/system/HQ; HQ; one task store across Work/agent/HQ; quick-add focus retention; six agents with uncropped art; composer → LUNA run → result drawer; NEX proposal → confirmation → approval with the router untouched and quota exhaustion not escalated; automatic idempotent migration; public isolation. |
| `node tests/smoke.mjs` (public Universe) | **All PASS (unchanged public site).** |
| `node scripts/audit-static.mjs` (simulated Pages artifact) | **PASS** (28 public entries, 23 allowlisted assets, no internal markers). |
| `npm run check`, `node --check` on every UI file | PASS |
| Responsive QA (Playwright screenshots, real bridge + live router) | 1440 / 1024 / 768 / 390 / 360 px across all workspaces and tabs: 0 horizontal overflow, 0 console errors. Screenshots were reviewed and the defects found were fixed (hero heading contrast, heading focus ring, browser-English date fields, mobile top-bar overflow, quick-add overflow, board width, agent-card text clipping, bidi ordering of provider/repo names). |

### V2/8. Known limitations and defects at that time

- **Not merged:** the main checkout still runs V1. See §0.
- **Slow first candidate:** `gemini/gemini-3.8-flash` timed out again live, so runs routed to it take about 110 s before falling back. Owner decision: demote it in the analysis/creative domain policies, or lower the per-attempt timeout. Not changed here.
- **Copy and theme:** no native-speaker review of the Arabic copy yet; no optional dark theme.
- **Live inference coverage:** never exercised for ZEN. Router writes are verified only against the stub.
- **Server-side Latin text:** some activity summaries from the server still contain Latin technical words (e.g. "project", model ids). They are bidi-isolated but not translated.
- **Legacy reports:** the browser-Workboard report and journal remain as a read-only archive. Their data is migrated, but the legacy weekly report reads browser data only.
- **Absent integrations:** no VPS/deploy/uptime connectors and no GitHub API features (as in V1). No authentication beyond loopback plus session token, so **do not expose the bridge on a network**.
- **CI:** `pages.yml` does not run the bridge or ops suites.
- **Untracked launch file:** `.claude/launch.json` in the worktree (dev bridge on port 4180) is a local dev-preview file and is not gitignored.

### V2/9. Previous technical priorities

1. Owner review of the six workspaces (visual and Arabic copy). Then adopt V2 into the main checkout (copy or merge); the live store migrates to schema 2 additively on first start.
2. Decide on `gemini-3.8-flash` in domain policies, or a shorter per-attempt timeout.
3. Add bridge and ops suites to CI (Node ≥ 22.13).
4. Read-only GitHub API integration (PRs, issues, workflow status) behind the tool registry.
5. Translate server-generated activity summaries fully to Arabic; optional dark theme; native-speaker copy pass.

### V2/10. Security verification

Unchanged contracts, re-verified by tests:
- loopback bind; Host / Origin / `Sec-Fetch-Site` guard; session token + JSON + size limit for writes;
- internal-asset allowlist, now including `.woff2`, with traversal refused;
- no secret in any response, DOM or localStorage;
- the public Pages artifact contains no internal UI or data.

No destructive migration was run, no data was deleted, and no router setting was changed.

### V2/11. Changed files (relative to the copied V1 baseline)

- **Bridge:** `apps/local-bridge/src/{db,company,nex,server,git}.mjs`; tests `apps/local-bridge/tests/{company,server-security}.test.mjs`.
- **Internal UI (new):** `internal/os.css`, `internal/ops-loader.js`, `internal/ops-hq.js`, `internal/ops-projects-hub.js`, `internal/ops-work.js`, `internal/assets/fonts/*` (2 woff2 files + 2 OFL texts).
- **Internal UI (rewritten):** `internal/ops-core.js`, `internal/ops-company.js`, `internal/ops-workforce.js`, `internal/ops-resources.js`, `internal/ops-system.js`.
- **Internal UI (adapted):** `internal/ops-usage.js`.
- **Internal UI (removed):** `internal/ops.css`, `internal/company.css`, `internal/ops-projects.js`.
- **Public:** `local-worlds.js` (loader call only).
- **Tests and docs:** `tests/ops.mjs` (rewritten), `STATUS.md`.

Exactly one canonical `STATUS.md` is maintained.
