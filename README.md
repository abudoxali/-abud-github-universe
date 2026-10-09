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

## Privacy boundaries

The deployed site is public. It must contain **public repositories only**, even when the connected owner's GitHub integration can see private repositories. Never insert private names, sensitive records, environment values or credentials into site source files.

**Important limitation:** Changing a repository from public to private does not erase its name from older, already-published Git commits or previously cached copies. The current site and scheduled inventory can stop displaying it, but a full public Git-history cleanup requires a separate, deliberate migration/history-rewrite decision. The app is not a private project manager or access-controlled dashboard.

If GitHub's API is unavailable, the site uses its most recently reviewed public snapshot; it cannot guarantee that a repository made private after that snapshot disappears until the next successful sync.

## Architecture

- `index.html` — semantic bilingual dashboard markup
- `styles.css` — site-aligned ABUD visual tokens and responsive layouts
- `data.js` — public-only curated repository snapshot and relationships
- `app.js` — graph, search, filtering, localization, details, public API reconciliation
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

All pushes to `main`, scheduled inventory checks and manual GitHub Actions runs validate JS source, test the dashboard in real Chromium (desktop and mobile), deploy via GitHub Pages and fetch the public HTTPS site.

[Latest Actions](https://github.com/abudoxali/-abud-github-universe/actions)

## Ownership

© ABUD FUN. Dashboard code is MIT licensed. Linked projects retain their own licenses and client rights.
