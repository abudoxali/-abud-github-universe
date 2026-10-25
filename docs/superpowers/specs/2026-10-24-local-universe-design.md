# Local Universe Design

## Intent

Keep the ABUD GitHub Universe as a local-first visual map of the owner's projects. Remove the owner-login/private-workspace product from this repository and replace it with a small loopback-only bridge that reads configured local Git checkouts and their GitHub remotes.

## Goals

- Preserve the existing map, Project Hub, public GitHub metadata and browser-local workboard.
- Add explicit local “worlds” backed by a local JSON configuration file.
- Show local repository state without putting credentials, private content or filesystem paths into the public static catalog.
- Use the existing local Git checkout and optional GitHub CLI identity; no in-app OAuth, PostgreSQL, GitHub App or cloud sync.

## Non-goals

- No remote deployment or production-service changes.
- No GitHub write operations.
- No automatic discovery of arbitrary folders; the owner explicitly configures paths.

## Architecture

`apps/local-bridge` serves the existing static Universe on `127.0.0.1` and exposes read-only `/local-api/account` and `/local-api/worlds` endpoints. The bridge validates configured paths, reads `git` metadata, and returns sanitized status. `local-worlds.js` renders the response only when the page is running on localhost; GitHub Pages remains unchanged.

## Security constraints

- Bind only to loopback by default.
- Keep `local/worlds.json` ignored; commit only `local/worlds.example.json`.
- Never return file contents, environment values, tokens or arbitrary command output.
- Use an explicit static asset allowlist and reject path traversal.
