# Command Center, 3D Worlds, and Agent System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the public/local Universe into a more dependable daily command center, make the three worlds visually and interactively legible through a lightweight 3D scene, and add a future-ready Agent System page without inventing agent behavior.

**Architecture:** Keep the zero-build static frontend and the loopback-only Local Bridge. Add one focused browser module for the 3D world stage and Agent System placeholder, with CSS-only 3D transforms so GitHub Pages stays dependency-free. Treat the existing local worlds endpoint as the source for machine-specific repository status; public pages receive safe inert UI only.

**Tech Stack:** Existing HTML/CSS/vanilla JavaScript, CSS transforms and custom properties, existing Node smoke tests and static artifact audit.

**Spec:** `docs/superpowers/specs/2026-10-24-local-universe-design.md` plus the approved Command Center direction in the conversation.

## Global Constraints

- No OAuth, PostgreSQL, GitHub App, browser tokens or GitHub write operations.
- The public artifact must not contain local paths, repository contents, credentials or bridge responses.
- The 3D scene must remain usable with keyboard navigation, touch layouts and `prefers-reduced-motion`.
- Agent System is a structural placeholder only; it must not claim that agents, runs, policies or logs exist.
- Preserve the existing public catalog, workboard, project hub, map controls and local bridge behavior.

## Review Focus

- A keyboard user can reach each world node and the Agent System page, with visible focus and useful text alternatives.
- Reduced-motion users get a stable 3D composition without continuous animation or pointer tilt.
- The Agent System empty states explain what is unavailable and do not imply execution or automation.
- The public static audit allowlists the new assets and still rejects private/local data.
- Mobile layouts do not introduce horizontal overflow or make the world stage unusable.

### Task 1: 3D world stage and navigation

**Files:** Create `universe-experience.js`, `universe-experience.css`; modify `index.html`, `app.js`, `.github/workflows/pages.yml`, `scripts/audit-static.mjs`.

- Add a hero world stage with three selectable orbiting world nodes: Core, Games, and Studio.
- Add pointer tilt only when motion is allowed; keep a keyboard and reduced-motion fallback.
- Selecting a world updates a status/detail panel and routes the user to the local worlds section on localhost or the project map on the public site.
- Add bilingual labels through `abud:language`, include `worlds` and `agentSystem` in active-section tracking, and keep the existing map separate.
- Include the new assets in the Pages build and fail-closed audit.

### Task 2: Agent System placeholder

**Files:** Modify `index.html`, create or extend `universe-experience.css` and `universe-experience.js`.

- Add a visible navigation entry and `#agentSystem` section titled `نظام الوكلاء` / `Agent System`.
- Render four future slots—Agents, Runs, Policies, Logs—with clear “not configured yet” empty states.
- Add a single descriptive next-step panel that invites the later agent concept without exposing controls that suggest execution.

### Task 3: Command-center polish and local worlds hierarchy

**Files:** Modify `index.html`, `local-worlds.css`, `universe-experience.css`, and translations in `app.js`.

- Add a compact local-world summary strip for connection state, world count and project count.
- Improve hierarchy, spacing, contrast, focus states and mobile behavior around worlds and the new Agent System page.
- Keep local-only world data hidden off loopback and preserve the existing safe empty state when the bridge is unavailable.

### Task 4: Verification

- Run `node --check` for all changed JavaScript files.
- Run `apps/local-bridge` tests, root smoke tests, static artifact audit, and `git diff --check`.
- Inspect the local browser view at `http://127.0.0.1:4170` for the 3D stage, world selection, Agent System empty states and mobile layout.

