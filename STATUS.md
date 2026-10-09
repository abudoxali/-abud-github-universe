# ABUD GitHub Universe — STATUS

Updated: 2026-10-09
Repository: `abudoxali/-abud-github-universe`
Production: https://abudoxali.github.io/-abud-github-universe/
State: **PUBLIC CATALOG RECONCILED — LIVE HTTPS VERIFIED**
Owner visual/content review: **NOT YET RECORDED**.

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
