# ABUD GitHub Universe

A bilingual (Arabic RTL / English LTR), privacy-conscious **interactive map of the public GitHub repositories** owned by [abudoxali](https://github.com/abudoxali).

**Live:** https://abudoxali.github.io/-abud-github-universe/

## What this is

An ABUD-styled visual command center with a project graph, status filters, search, product relationships, GitHub deep links, and a project details panel. It uses the dark purple design language from `abud.fun` without requiring a backend.

- Public-only snapshot reviewed on **2026-10-09**: **28 public repositories**. The connected account also held **16 private repositories**, which are **not displayed or included in `data.js`**.
- The project catalog can change. New public repositories appear as `UNREVIEWED`; repositories that become private or are deleted disappear from the displayed list after the next successful public-API sync.
- Public GitHub metadata (language, stars, last pushed) is refreshed automatically on page load and via **Sync GitHub**.
- GitHub Actions refreshes the checked-in public catalog on push, manual runs, and approximately **every six hours** (schedules can be delayed by GitHub).
- Human-curated product assessments are *not* changed by commit activity and should be verified against `STATUS.md` in each project before editing.

## V1.1 — Daily Command Center

The public GitHub Universe is now usable as a daily project reference:

- **Daily Command Center** appears at the top of the homepage, emphasizing a single main focus and two adjacent tracks (currently Video Factory, ReplyOps, RootRay), plus a privacy-safe public-only inventory summary.
- **Project Hub** pages use deep links like `#project/RootRay` and include the project's curated objective, review note, README/STATUS links, last public commit, latest GitHub Actions workflow and public repository metadata.
- **Real-time evidence is read only and on demand**: public GitHub API requests are made only when a project detail page is opened, rechecking its public visibility first. Results are cached in the visitor's browser for 15 minutes. A missing workflow or failed API request is never shown as passing.
- **Repository/CI activity is not product readiness**. A successful workflow run does not justify promoting a project to production-ready.
- **Bilingual and responsive:** Arabic RTL / English LTR, direct project links, copyable next-action handoff, desktop and mobile layouts.
- **Safety:** stale or private/deleted repo deep links are rejected after the public list refresh; no private repositories are deliberately requested or embedded in the site.

V1.1 is still **public-only**. An authenticated private workspace is a separate product milestone and must not be implemented by shipping private records or OAuth credentials through GitHub Pages.

## V1.2 — Project Intelligence & AI Agent Workflow

V1.2 extends the V1.1 daily board without introducing a backend or requesting private repository data.

- **Weekly public activity** shows which public repositories have a GitHub `pushed_at` date within the last seven days. It counts *repositories with recent pushes*, not commits, engineering output, user adoption, or release completion. Missing or partial metadata is explicitly labeled.
- **STATUS.md evidence** is fetched on demand from the root of the selected public repository. The browser first checks repository visibility, then requests only `STATUS.md` on the default branch. The UI extracts a few recognizable fields (Status, Updated, Completion, Phase, Blocker, etc.) and links back to the actual document.
- **Evidence quality:** the UI calls values *document claims*, not runtime proof. Missing, oversized or unavailable status files are explicitly marked. Remote markdown is treated as untrusted data and is never rendered as executable HTML.
- **Agent 1 / Agent 2 handoff:** select a copyable analysis-only handoff or an execution-focused local coding prompt. Both retain the repo identity, curated next action, optional verified STATUS blob SHA, and any publicly observed commit/CI evidence, with strong trust and security constraints. Neither blindly copies instructions or secret-looking values from remote status text.
- **Bilingual:** Arabic RTL and English LTR, responsive cards and copy-ready English agent prompts.
- **Security:** the public site remains public-only and uses no authentication tokens in frontend code. A private repository is never read by the status loader, and old project deep links cannot knowingly reveal hidden projects after public sync.

The `intelligence.js` and `intelligence.css` modules are deployed alongside `command-center.js` and `command-center.css`. Chromium tests cover public source parsing, Agent 1/2 prompts, qualified CI and commit evidence, weekly metadata, absent status files, private/deleted links and mobile usability.

**Limit:** this is an inspection and coordination reference, *not* an authenticated private project-management backend or autonomous coding service.

## V1.3 — Smarter Graph & Explainable Project Decisions

V1.3 makes the project reference **actionable without overstating what GitHub can prove**:

- **Six curated public-to-public relationships** are typed as potential scope overlap, succession, complementary workflows, or same-track portfolio links. Each has a bilingual rationale and a clear **EDITORIAL** provenance label. "Overlap" is not evidence of duplicate source code, nor is a visual relationship a confirmed dependency.
- **Real repository-to-repository graph lines** are drawn on the existing pannable/zoomable universe. Filter relationship types, inspect both sides, and highlight a specific edge directly on the map. The drawing is recomputed after graph/search/visibility updates.
- **Project Decisions** collects *review signals* instead of unverifiable automated completion scores: privacy-review categories, explicitly curated release gates, potential scope overlaps, unreviewed/new projects, and public repositories whose last known push was **90+ days ago**.
- **Data coverage** is explicit: inactivity review only runs when an actual public GitHub `pushed_at` timestamp exists. No recent push is **not proof** of a broken, abandoned or unshipped product.
- Signal filters and priority/name/oldest-push sorting are interactive on both desktop and mobile, with links to each public Project Hub.
- Privacy is preserved end-to-end: when a repository becomes private or disappears from the public API, its public relationships, map lines, and associated review signals are removed at the next successful reconciliation.
- The dashboard makes no destructive GitHub changes, and never merges or deletes repositories on a score or similarity guess.

Implementation: `decisions.js` / `decisions.css`, typed editorial relationships in `data.js`, and a small sidebar navigation update in `app.js`. Existing V1.0–V1.2 workflows remain intact.

## V1.4 — Local Personal Workboard

The **Personal Execution Workboard** is a device-local feature for prioritizing work, not a replacement for GitHub issue tracking or a centralized database.

- Select at most **three public repositories** as daily focus projects; the V1.1 Daily Command Center reflects that selection.
- Add up to **20 brief actionable tasks per project**, mark completed/reopened, delete tasks, and choose a manual execution stage: Backlog, In progress, Blocked, Needs review, Done.
- Save device-local workspace state using browser `localStorage`; it survives ordinary page reloads on the same browser, **not** browser clearing or automatic device syncing.
- Export/import a structured JSON backup. Import limits payloads to 1MB and revalidates project membership, task lengths, data types and invalid/sensitive-looking entries. Records for private, deleted or otherwise non-public repos are skipped.
- The workboard has **no authenticated backend**, cloud sync, secret management, or GitHub write permissions. Never enter passwords, keys, or other sensitive client data.

## V1.5 — Progress & Decision Journal

The workboard now includes a **local execution timeline**:

- Record brief manual decisions attached to currently focused public projects.
- Automatically journal focus/unfocus, stage updates, task creation, task completion/reopening, and task deletion.
- Filter activity by seven days, thirty days, or all available history.
- Store **up to 150 events** in the same local workspace and include sanitized, public-only events in JSON exports/imports.
- Clearly distinguish manually authored journal events from GitHub commits and real deployment evidence.
- The timeline is not synchronized between devices; clearing browser storage loses the local journal unless exported.

## V1.6–V2.0 product direction — not yet implemented

- **V1.6 Reporting:** printable weekly review, public project evidence links, owner-confirmed decisions, and safe exports.
- **V1.7 Quality & Privacy:** CI resilience, richer accessibility/browser support and a deliberate review of older public Git history. No history rewrite without owner approval.
- **V2.0 Secure ABUD OS:** authenticated, private workspace with GitHub App/OAuth authorization and server-side API access, encrypted credentials, least-privilege permissions, audited private repository access and a backend/database hosted separately from public GitHub Pages. A static Pages site cannot guarantee private project confidentiality.
- A complete private backend **must not be represented as shipped** without deployment, authorization, end-to-end tests and owner acceptance.

## Privacy boundaries

The deployed site is public. It must contain **public repositories only**, even when the connected owner's GitHub integration can see private repositories. Never insert private names, sensitive records, environment values or credentials into site source files.

**Important limitation:** Changing a repository from public to private does not erase its name from older, already-published Git commits or previously cached copies. The current site and scheduled inventory can stop displaying it, but a full public Git-history cleanup requires a separate, deliberate migration/history-rewrite decision. The app is not a private project manager or access-controlled dashboard.

If GitHub's API is unavailable, the site uses its most recently reviewed public snapshot; it cannot guarantee that a repository made private after that snapshot disappears until the next successful sync.

## Architecture

- `index.html` — semantic bilingual dashboard markup
- `styles.css` — site-aligned ABUD visual tokens and responsive layouts
- `data.js` — public-only curated repository snapshot and relationships
- `app.js` — graph, search, filtering, localization, details, public API reconciliation
- `command-center.js` / `command-center.css` — V1.1 daily workspace, project pages, public commit/CI evidence
- `intelligence.js` / `intelligence.css` — V1.2 weekly activity, STATUS.md source and Agent 1/2 prompts
- `decisions.js` / `decisions.css` — V1.3 explainable signals, relationship types and graph edge overlays
- `workboard.js` / `workboard.css` — V1.4–V1.5 device-local focus, tasks, stages, progress journal and safe JSON export/import
- `scripts/sync-public.mjs` — safe public membership diff, preserves human assessments
- `tests/smoke.mjs` — Chromium desktop/mobile and privacy-reconciliation checks
- `.github/workflows/pages.yml` — sync, test, deploy, HTTPS smoke
- `STATUS.md` — **single** canonical status report

No build tools or private tokens are required in the browser. GitHub Actions uses its scoped token during scheduled inventory checks, never publishes that token, and only accepts `visibility: public` repositories.

## Local preview

```bash
python -m http.server 8000
```

Open http://localhost:8000.

The optional GitHub browser refresh needs network access and may be limited by the GitHub public API. The dashboard remains usable with the latest reviewed snapshot.

## CI / publication

All pushes to `main`, scheduled inventory checks and manual GitHub Actions runs validate JS source, test the dashboard and V1.1 project hub in real Chromium (desktop and mobile), deploy via GitHub Pages and fetch the public HTTPS site.

[Latest Actions](https://github.com/abudoxali/-abud-github-universe/actions)

## Ownership

© ABUD FUN. Dashboard code is MIT licensed. Linked projects retain their own licenses and client rights.
