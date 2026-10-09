# ABUD GitHub Universe

A bilingual (Arabic / English) interactive command center for the full GitHub portfolio of [abudoxali](https://github.com/abudoxali).

## Website

GitHub Pages: https://abudoxali.github.io/-abud-github-universe/

## Features

- All repositories in one categorized, searchable registry
- Interactive visual project sitemap with pan, zoom, and project details
- Editorial priorities: active, growth, live, showcase, revive, freeze, archive, cleanup
- Repository relationships and lineage
- Arabic RTL and English LTR
- Read-only refresh of *public GitHub metadata* (stars, language, activity) without tokens
- Responsive, accessible, static files — no backend or build system

## Deployment

Files live at repository root. GitHub Pages may serve **main / (root)**, or use the provided Pages Actions workflow if the repository is set to **GitHub Actions** as its source. No API keys, deployment secrets, or server are required.

## Project status and trust

The static project classifications are **editorial assessments**, last reviewed in October 2026; they are not automatically equivalent to current runtime availability, production health, or owner approval. The optional GitHub refresh updates repository metadata only. It does not silently change product/completion labels.

This site is **public**. Do not put secret values, personal records, or private internal documentation into its source. Repositories flagged for privacy review are labels only and should be handled in their respective repositories.

## Files

- `index.html` — page structure and semantic HTML
- `styles.css` — ABUD dark/purple design system
- `data.js` — editable repository catalog and relationships
- `app.js` — client-side rendering, filtering, map and sync
- `favicon.svg` — site icon
- `.github/workflows/pages.yml` — optional GitHub Pages workflow
- `STATUS.md` — single project status document

## Local preview

Open `index.html` in a browser, or for a local static server:

```sh
python -m http.server 8000
```

Visit http://localhost:8000 and confirm the repository registry, graph, search, language switch, drawer and mobile layout.

**Data updates:** Edit `data.js`. Public GitHub metadata refresh requires network access in the browser and is subject to GitHub's unauthenticated API limits.

---
© ABUD FUN. MIT license applies to the dashboard's own code; linked third-party or client repositories retain their own rights.
