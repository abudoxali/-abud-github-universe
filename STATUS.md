# ABUD GitHub Universe — STATUS

Updated: 2026-10-09
Repository: `abudoxali/-abud-github-universe`
Production: https://abudoxali.github.io/-abud-github-universe/
State: **V2.0 PRIVATE WORKSPACE ALPHA — CODE IMPLEMENTED, NOT DEPLOYED OR AUTHENTICATED LIVE**
Private target domain: `os.abud.fun` (selected, DNS and TLS NOT verified)
Public GitHub Pages: unchanged at `https://abudoxali.github.io/-abud-github-universe/`
Owner visual/content review: **NOT YET RECORDED**.

## V2.0 — Secure Owner-Only Workspace Alpha (2026-10-09)

**Scope:** New isolated backend under `apps/private-server/` on branch `feat/v2-secure-os`. Keep the V1.x public site unchanged. This is **not** a production V2.0 release.

### Implemented in source
- Backend: Fastify on Node.js >=22. Isolated private server, default local-only port 3164, expected public origin `https://os.abud.fun`. No browser GitHub tokens.
- Authentication: GitHub OAuth identity-only sign-in, one-time database-backed OAuth state, strict owner numeric ID + login validation, discard OAuth access token after identity check.
- Authorization: opaque SHA-256 hashed, server-side PostgreSQL sessions, expiring HttpOnly Secure SameSite cookies; server-side logout; CSRF token and exact Origin checks on writes.
- GitHub App: installed read-only **selected repository** access, permission gate rejecting all write scopes or unexpected owner; contents `STATUS.md` read on behalf of the installation, verifying membership on each request.
- Data persistence: owner-scoped PostgreSQL workspace with revision-based 409 conflict prevention, validated task/focus/event formats. Private JSON is never uploaded to public GitHub Pages.
- Private owner report: authenticated, `no-store` Markdown 7/30-day export, explicitly no permanent public download URL.
- UI: responsive bilingual Arabic RTL and English LTR owner portal, approved repos, private/public badges, up to three focus projects, tasks, status document claims and exports.
- Deployment references: isolated Nginx TLS vhost, isolated systemd service example, explicit fresh-database checks and live security acceptance checklist.
- CI pipeline `.github/workflows/private-ci.yml` is separate from public Pages pipeline. It runs Node security tests and isolated PostgreSQL 16 integration tests in GitHub Actions, with no real OAuth/installation credentials.

### Verified boundaries
- Source tree contains only code and examples, not live app secrets. `.env.example` contains placeholders.
- Existing public GitHub Pages `_site` allowlist and deployed dashboard are unchanged by this feature branch.
- OAuth callback and GitHub App installation are **NOT** verified live, because actual app registrations/client secrets/private signing key and a selected installation have not been connected for this application.
- No SSH/session or DNS editing connector for the current VPS/Cloudflare zone was available. **No DNS records were changed** and **no VPS deployment occurred**.
- The isolated production PostgreSQL target has not been created, migrated or backed up, and cross-device access has not been verified live.
- The old public repo Git history may expose earlier names; no history rewrite or destructive Git changes have occurred.
- Manual visual acceptance and production access-control acceptance: **PENDING**.

### Release gate
1. Confirm actual VPS identity/current SSH authorization, spare port, app/service directory, new PostgreSQL DB name/role and backup strategy without altering other projects.
2. Connect DNS management for the selected `os.abud.fun` subdomain; create the correct DNS record and install valid TLS.
3. Owner authorizes a dedicated GitHub OAuth App and installs an owner-selected, read-only GitHub App. Put all credentials **server-side only**.
4. Deploy a timestamped isolated release; verify OAuth owner/stranger flows, revoked installation, unauthenticated private reads, valid sessions and logout, CSRF, PostgreSQL migrations, encrypted transport, reports and cross-device workspace.
5. Manual Arabic/English desktop/mobile acceptance and rollback/restore before marking V2 READY.

**Next permitted work:** prepare and review the staged GitHub PR, then production configuration through a validated infrastructure integration. No release-ready claims before actual E2E.

## V1.6–V1.7 — Evidence-Based Reports & Hardening (2026-10-09)

**Delivered:** V1.6 reporting and V1.7 static privacy/accessibility hardening. GitHub Pages remains PUBLIC-ONLY and backend-free.

### V1.6 — Local Reports
- Responsive bilingual 7/30-day report inside the Personal Workboard: focus projects, user-set status, task completion, blocked stages, local journal decisions, and available GitHub public last-push metrics.
- Public data coverage shown explicitly; no claim that GitHub Push, GitHub Actions, or local task completion proves real product deployment or revenue.
- On-demand **Markdown download** and **browser Print/PDF dialog** with a print-specific A4 layout. This is not a server-generated PDF or cloud-synchronized report.
- Reports filter against the currently visible PUBLIC-only repository membership and exclude removed/private project records after successful public membership reconciliation.
- Implemented in `reports.js`, `reports.css`, `index.html`; added desktop/mobile coverage to `tests/smoke.mjs`.

### V1.7 — Reliability, Accessibility, Privacy
- Added HTML meta-delivered Content Security Policy with same-origin JavaScript and a restricted network allowlist, plus `referrer=no-referrer`. **Not** a configurable server-sent CSP header.
- Keyboard `:focus-visible` treatment, reduced-motion accessibility and forced-colors focus support.
- `scripts/audit-static.mjs` allows only the 15 intended public static files in the Pages artifact, validates PUBLIC_ONLY catalog structure, link consistency, static security markup, and specific credential signatures in released assets. GitHub Actions must pass this gate **before** publication.
- No sensitive private data was intentionally imported into the website, and no backend/token architecture was added.
- The publicly accessible **old Git history may still contain the earlier all-repository inventory**. V1.7 does not remove it; a separate, approved history migration and impact review is required.

### Verification evidence
- GitHub Actions run https://github.com/abudoxali/-abud-github-universe/actions/runs/37908756720 — **SUCCESS**, including `main` commit `5a9f3cc64a249c720812622fe4efe99df2570f55`.
- PASS: Node JavaScript syntax validation and static existence checks.
- PASS: Chromium Desktop RTL/LTR, prior V1.0–V1.5 features and V1.6 7/30-day reporting, locally authored decisions, Markdown download, Print/PDF invocation and report privacy filtering.
- PASS: Chromium CSP/no-referrer and reduced-motion verification; mobile smoke, no horizontal overflow and no uncaught JavaScript errors.
- PASS: Static publication audit: 28 public repositories, **15 allowlisted site assets**, security checks and no stale relationships.
- PASS: Real GitHub Pages deployment and public HTTPS fetch of the actual site and its added report JavaScript.
- Final post-documentation regression verification: https://github.com/abudoxali/-abud-github-universe/actions/runs/37909267666 — **SUCCESS**, revision `a39ff9c98cf98a75306a8dcc6f711730ace98efb`. Browser, static audit, and public HTTPS passed.
- A timing-sensitive V1.2 regression was caught in a CI rerun: the agent prompt could be rendered before public GitHub commit/CI evidence arrived. Fixed by dispatching `abud:project-activity` after the project activity panel updates and regenerating the prompt. The follow-up complete Playwright/HTTPS run passed. No commit/CI evidence is fabricated when requests have not completed.
- Owner's **manual visual approval: PENDING**, independent of CI/HTTPS success.

### V2 status — defined, NOT SHIPPED
- Security and live-acceptance contract added at `docs/V2_SECURE_WORKSPACE.md`.
- A genuine authenticated private workspace with cross-device database state, read-only scoped GitHub App credentials, owner sessions and per-repository authorization is NOT implemented or verified.
- V2 implementation/deployment requires the owner to choose a current backend domain/host, approve the GitHub authorization method/selected repositories, and approve the intended security/backup policy.
- Never store private repository details or OAuth tokens on the public GitHub Pages app.

## V1.4–V1.5 — Daily Execution Workboard & Local Progress Journal (2026-10-09)

**Current shipped state:** V1.5. Scope is device-local, public-only, no backend and no automatic changes to source repositories.

### V1.4 — Personal Workboard
- Add a responsive **Personal Execution Workboard** containing a maximum of three user-selected public focus repositories.
- User choices drive the **Daily Command Center** priorities rather than the original fixed priority array.
- For each selected repository: bounded short task list, done/undone task state, task completion summary and user-set manual stage (Backlog, In Progress, Blocked, Review, Done).
- Data is persisted **only in this browser's localStorage** (key `abud-os-workboard-v1`). No account sync, GitHub write, public Markdown storage or backend storage occurs.
- Safe JSON export/import with a 1MB file cap, public-membership filtering, input length/shape validation and rejection of obvious secret-looking input.
- On successful public API synchronization, projects removed or made private are removed from the current local focus and local project/task records, and are not included in current exports.
- GitHub Actions **SUCCESS** including browser and HTTPS on https://github.com/abudoxali/-abud-github-universe/actions/runs/37906793645.

### V1.5 — Progress & Decision Journal
- Add browser-local event history for focus/unfocus actions, stage updates, task creation/completion/reopening/deletion.
- Allow a short, self-authored decision or blocker note linked to a currently focused public project.
- Filter local history by 7 days, 30 days or all history.
- Cap history at 150 events and include public-only, validated events in JSON exports and imports; remove events relating to repositories no longer public.
- History is explicitly distinct from GitHub `pushed_at`, commits, CI, product completion and live deployment verification.
- Files: `index.html`, `workboard.js`, `workboard.css`, `command-center.js`, `app.js`, Playwright smoke tests, GitHub Pages workflow.

### Verification
- https://github.com/abudoxali/-abud-github-universe/actions/runs/37907185146 — **SUCCESS**.
- Node syntax and static asset checks: **PASS**.
- Chromium desktop: previous V1.0–V1.3 dashboard, graph, public membership, Arabic/English, evidence and agent prompts: **PASS**.
- V1.4: 3-project cap, tasks, completion and stage, refresh persistence, custom focus integration, JSON import filtering of synthetic private repos: **PASS**.
- V1.5: local journal entries, manually authored decisions, 7/30/all filter, public-only event export/import, missing/private project cleanup: **PASS**.
- Chromium mobile: workboard, empty journal, responsive navigation, project hub and no uncaught JS errors: **PASS**.
- GitHub Pages publish + actual HTTPS content verification: **PASS**.

### Caveats and gates
- LocalStorage is **not encrypted private storage**. Use it for public project coordination and non-sensitive notes only; don't store customer data, tokens, private repository details or secrets.
- Workboard state is *local to the current browser*. Users need to export/import backups when switching browsers/devices. A browser clear or incognito session may erase local data.
- Current public repo membership must be successfully refreshed to reflect new GitHub visibility immediately; during a network outage the last published public snapshot may be stale.
- The existing public Git history contains earlier repository catalogs; their presence is not fixed by the current HEAD. No destructive rewrite was performed.
- Owner screenshot/visual acceptance is **not yet recorded**, distinct from passing CI and real HTTPS availability.
- **V1.6, V1.7 and V2.0 are proposed, not implemented**. V2 private workspace requires secure server-side GitHub authorization and a backend beyond public GitHub Pages.

### Future release direction (not delivered)
- V1.6: owner-directed weekly review and printable/exportable summaries.
- V1.7: accessibility, privacy hardening, CI reliability and review of historical public data exposure.
- V2.0: authenticated secure ABUD OS with owner-private repository access, server-managed credentials and audited authorization; only after an approved backend deployment and end-to-end live tests.

## V1.3 — Smarter Project Graph & Decision Dashboard (2026-10-09)

**Scope:** Extend the existing public-only ABUD GitHub Universe; retain ABUD theme, Arabic RTL / English LTR, previous features, one STATUS.md, and GitHub Pages static deployment.

### Verified implementation
- **Six curated public-to-public relationships**, each carrying an explicit type, Arabic/English rationale, and `basis: editorial`: succession, potential scope overlap, complementary tools, or same-track portfolio. No unverified dependency, duplicate-code, or automatic merger claims.
- **Interactive graph edges between actual repository nodes** on the existing zoomable/pannable map. Relationship type filters, focus/highlight, public-project detail links, and synchronized edge removal when a repo becomes private or unavailable.
- **Decision Dashboard** aggregates conservative, explainable review signals from public-only catalog labels and optional public GitHub `pushed_at` metadata: privacy review, curated release gates, potential overlap, unreviewed/new projects, and 90+ days since last public push.
- **Filters and sorts** by signal type, priority, name and oldest push, including stated public-data coverage.
- Inactivity is **not** product abandonment; scope overlap is **not** proof of duplicated source; CI does **not** prove real production acceptance. No automated write, archive, delete, or merge operations.
- Bilingual responsive `decisions.js` and `decisions.css`, updated main navigation, data relationship rationale, unchanged deployment model.
- The public catalog remains **28 public repositories** at the last documented connected audit; private repositories are not included.

### Automated + public verification
- Latest successful code/test/production deployment before this status-document change:
  https://github.com/abudoxali/-abud-github-universe/actions/runs/37903150115 — **SUCCESS** (commit `424f38e90b103050e6587b8f69bffb7b2826b80a`).
- Node syntax and static asset validation **PASS**.
- Playwright Chromium desktop **PASS**: six typed relations, graph line focus, relation filters, privacy/release/overlap signals, sorting, Arabic and English, earlier V1.1/V1.2 coverage.
- Dynamic public API reconciliation **PASS**: private/deleted repo removed from cards, edges and relationship explorer, new public repo discovered, private API row ignored.
- 90+ day synthetic public push **PASS**: inactivity appears as a review signal with an explicit no-failure qualification.
- Playwright Chromium mobile **PASS**: existing navigation, project hub, public cards, no page overflow and zero uncaught JavaScript errors.
- GitHub Pages deployment + actual HTTPS checks of index, app, command-center, intelligence and decisions modules **PASS**.
- Manual owner visual/content acceptance: **PENDING**.

### Boundaries / next acceptance
- GitHub Actions and `pushed_at` are not business/completion telemetry. Review labels are editorial until updated with recent project STATUS and genuine runtime evidence.
- GitHub Pages remains **public-only**. Former private repo names may still exist in historical public Git commits, which were not force-rewritten.
- The authenticated private workspace and V1.4 functionality have not been implemented or approved.
- Recommended next step after owner visual acceptance: examine secure access architecture and objective-based review automation without broadening the public data exposure.

## V1.2 — Public Project Intelligence & AI Workflow (2026-10-09)

**Scope:** Extend the public GitHub Universe into a practical reference with source-aware project cards, public status evidence and safe AI agent handoff prompts. No authenticated private data, backend, credential storage, or self-executing agent functionality.

### Implementation
- Weekly overview uses public GitHub `pushed_at` dates to show repositories with pushes in the last seven days, and explicitly distinguishes this from commits, completion, or released products. Partial/missing metadata is labeled.
- On-demand `STATUS.md` reader rechecks the selected repository's public visibility before requesting the public root file from its default branch. Recognized status fields are displayed as **document claims**, with the document URL and SHA. Missing or unavailable files are not treated as completed.
- Public markdown is untrusted and rendered as text only. Agent prompts do not blindly copy remote status text, embedded instructions or secret-looking values.
- Agent handoff has two modes: **Agent 1 — audit/handoff only** and **Agent 2 — local coding execution**. Both are directly copyable and emphasize code-first verification, scoped work, tests, one `STATUS.md`, honest results and no secrets.
- Generated prompts use curated objective notes with an explicit freshness qualification, document presence/SHA when verified, and publicly observed commit/CI outcomes with an explicit warning that CI success is **not** production readiness.
- HTML, CSS, JS, desktop and mobile integration are additive; the V1.1 daily board and V1 sitemap are retained.

### Tested and deployed
- Full GitHub Actions run: https://github.com/abudoxali/-abud-github-universe/actions/runs/37900951102 — **SUCCESS**.
- Node syntax and static asset validation: **PASS**.
- Playwright Chromium desktop: 28 public cards, 8 clusters, search/filter, Arabic RTL / English LTR, original details: **PASS**.
- V1.1 daily board and direct project hub with mocked public commit and workflow state: **PASS**.
- V1.2 simulated public `STATUS.md` field display, safe Agent 1 and Agent 2 prompts, qualified SHA/CI evidence: **PASS**.
- Seven-day public metadata availability and count: **PASS**.
- Missing `STATUS.md` handled accurately on mobile: **PASS**.
- Removed/private deep-link and synchronized-list protections: **PASS**.
- Zoom/fit and mobile navigation/no horizontal overflow/zero JS exceptions: **PASS**.
- GitHub Pages deployment and actual HTTPS retrieval of `index.html`, `app.js`, `command-center.js`, and `intelligence.js`: **PASS**.

### Limitations / acceptance
- Owner's visual/content acceptance is **PENDING**.
- All repository visibility and freshness claims are subject to public GitHub API availability and rate limits; browser data may be stale.
- Status percentage and release-readiness claims belong to source documents and require independent live/runtime verification.
- GitHub Pages remains a **public static site only**; 16 private repositories at the last audit are excluded from its source catalog and runtime UI.
- Historical public commits predating this catalog may still expose previously published names; no Git history rewrite was undertaken.
- V1.3+ functionality and authenticated private data access are **NOT IMPLEMENTED**.

## V1.1 — Daily Command Center (2026-10-09)

**Scope:** Convert the public sitemap into a practical daily reference without creating a backend or exposing the account's private projects.

### Implemented
- New **Daily Command Center** above the original hero: main priority, next two tracks, current public repository inventory and review reminders.
- Dedicated, linkable **Project Hub** per public repository (`#project/<repo-name>`) rather than only a basic details drawer.
- Project Hub shows curated current objective, status/review context, README / canonical `STATUS.md` links, and direct GitHub link.
- **On-demand public GitHub evidence:** last branch commit SHA/message/time, latest workflow run and explicit outcome, language/stars/last push/default branch.
- Public repository visibility is checked at each activity request; missing/failed APIs display unknown/unavailable, never fake successes. Public activity is distinct from product/runtime acceptance.
- Priority handoff text can be copied directly from the project view.
- Full Arabic RTL and English LTR treatment for the new dashboard, responsive to desktop and phone; legacy map/search/filter functionality preserved.
- V1.1 source: `command-center.js` and `command-center.css`, plus additive changes to `index.html` / `app.js`.
- GitHub Pages pipeline now validates, tests, packages and deploys the added assets.

### Final verification
- **Successful browser + deployment run:** https://github.com/abudoxali/-abud-github-universe/actions/runs/37896393335
- Node syntax and static asset checks: **PASS**.
- Playwright Chromium desktop: 28 public repository cards, 8 clusters, five KPIs, Arabic RTL, English LTR, search, clear and detail drawer: **PASS**.
- V1.1 desktop: daily priorities and direct project page; mocked public last commit and passing CI are shown with distinct labels: **PASS**.
- Public privacy gate: simulated private/deleted repository disappears, its direct project link is blocked, new public repository discovered, simulated private API row rejected: **PASS**.
- Graph zoom and fit: **PASS**.
- Playwright mobile: navigation backdrop, daily priorities, project hub, no page overflow or uncaught JS errors: **PASS**.
- Pages deployment and actual public HTTPS fetch: **PASS**.

### V1.1 known limitations
- Public-only: 16 private repositories are not part of the deployed dashboard. An authenticated private workspace needs a separate secure architecture and approval.
- GitHub API requests for project detail are subject to rate limits, network access and a 15-minute visitor-side cache. “Unknown” is a valid UI result.
- Editorial `next action` is still manually curated and can become outdated after commits. Source files or a GitHub Actions status alone do not establish real product readiness.
- Any older public Git commit containing a former all-repo list remains historically accessible; current-head cleanup does not purge historical commits.
- Owner screenshot/content acceptance of the new UI is still **pending**. Code/test/HTTPS acceptance alone is not owner visual approval.

## Current inventory — verified via the connected GitHub account
- **44 total repositories** under the account at review time.
- **28 PUBLIC** repos displayed, across eight editorial categories.
- **16 PRIVATE** repos excluded from the current public catalog, map, links, data.js and visible relationships.
- One newly created public repo, `stickman-video-factory`, was discovered during the audit. It was empty when checked and is labeled `NEW / EMPTY`.
- The 43 repositories from the previous inventory were still present under those names at the time of the check; the new Stickman repo increased the total to 44.
- Category counts: active 6, live/commercial 2, revive/build 8, showcase 5, personal 2, frozen 2, superseded 1, privacy/cleanup 2.

## What changed
- Rebuilt `data.js` from **public-only** connected GitHub visibility; removed all 16 newly/private repositories from the current source snapshot.
- Re-evaluated public project statuses from recent commits and repository files where available. Relevant revisions include `Source-of-Truth` at a documented **99%** core completion with deployment/device verification still outstanding; `Video_Factory` marked NOT READY for the full live Golden Path; `ReplyOps` awaiting live provider acceptance; `Grantly` and `GuestFlow` retain documented production verification, and `VoidShift` remains at last owner-accepted 40%.
- Updated public-only project relationships and omitted any relationship referring to a private repository.
- Browser GitHub synchronization now reconciles membership: **removed/private** repositories disappear after a successful public-API call; newly public repositories appear as `UNREVIEWED` until a human classifies them.
- Automatic public API refresh runs at page load. Manual **Sync GitHub** is retained. Cached metadata is filtered to the current public dataset.
- Added `scripts/sync-public.mjs` and GitHub Actions scheduled refresh, approximately every six hours, plus on push/manual execution. A successfully detected public membership change updates `data.js` using the workflow's scoped token. It does not alter editorial completion labels.
- Reworked automated browser smoke to test simulated membership removal, discovery of a new public repository and explicit rejection of a simulated private repository.
- Updated the privacy boundaries and synchronization limits in `README.md`.

## Tests and verified deployment
- GitHub Actions success: https://github.com/abudoxali/-abud-github-universe/actions/runs/37894584026
- Public inventory refresh: **PASS**.
- JavaScript syntax and static asset gates: **PASS**.
- Chromium desktop: public registry, 8 category clusters, 5 KPIs, Arabic RTL: **PASS**.
- English LTR, search/reset, details drawer: **PASS**.
- Live-public membership simulation: removed public item hidden; new public item discovered; simulated private entry rejected: **PASS**.
- Map zoom and fit controls: **PASS**.
- Chromium mobile: menu/backdrop, public registry, no horizontal overflow and no uncaught JS errors: **PASS**.
- GitHub Pages build, deploy and public HTTPS smoke (index + app.js): **PASS**.

## Truth boundaries and limitations
- Public GitHub visibility is authoritative for *display eligibility*. Editorial project state is an assessment from source files, **not proof that every app has been tested live**.
- The browser fallback uses the latest published public-only snapshot if GitHub API is unavailable. A visibility change made after publication cannot be guaranteed to vanish until a successful refresh.
- GitHub scheduled jobs are approximate and may be delayed. This is not instant or guaranteed private-data erasure.
- Previous public Git commits of this dashboard contained the older all-repository catalog. Even though the current HEAD is sanitized, **older Git history is still publicly accessible** unless explicitly rewritten/migrated. No force-push/history rewrite was attempted.
- Do not put private repo names, sensitive personal data, credentials or environment values in future public source, logs or status reports.

## Next owner decision
- Verify the live Arabic/English UI and project descriptions. Edit any curated status only after checking the relevant repo's actual `STATUS.md` and release/runtime evidence.
- If old publicly accessible Git history must be sanitized, handle it in a separate agreed, safe history migration operation; it is not solved by the current commit.
- Keep production/runtime testing for each actual project separate from this GitHub catalog review.

Exactly one canonical `STATUS.md` is maintained.
