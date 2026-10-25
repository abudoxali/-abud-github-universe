import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadWorldConfig,
  normalizeRemote,
  readGitProject,
  isAllowedAsset,
  sanitizeWorldConfig
} from "../src/git.mjs";
import { createServer } from "../src/server.mjs";

test("normalizes GitHub SSH and HTTPS remotes to owner/repository", () => {
  assert.equal(normalizeRemote("git@github.com:abudoxali/Blender.git"), "abudoxali/Blender");
  assert.equal(normalizeRemote("https://github.com/abudoxali/Blender/"), "abudoxali/Blender");
  assert.equal(normalizeRemote("https://example.com/not-github.git"), null);
});

test("loads a safe world config and drops malformed projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "abud-universe-"));
  const config = join(root, "worlds.json");
  await writeFile(config, JSON.stringify({
    githubOwner: "abudoxali",
    worlds: [{
      id: "game",
      name: "Game World",
      projects: [
        { id: "blender", name: "Blender", path: resolve(root, "Blender"), github: "abudoxali/Blender" },
        { id: "bad", name: "", path: "relative/path", github: "not-valid" }
      ]
    }]
  }));

  const result = await loadWorldConfig(config);
  assert.equal(result.githubOwner, "abudoxali");
  assert.equal(result.worlds.length, 1);
  assert.equal(result.worlds[0].projects.length, 1);
  assert.equal(result.worlds[0].projects[0].github, "abudoxali/Blender");
});

test("missing config is a usable empty local universe", async () => {
  const result = await loadWorldConfig(join(await mkdtemp(join(tmpdir(), "abud-universe-")), "missing.json"));
  assert.deepEqual(result, { githubOwner: null, worlds: [], configured: false });
});

test("invalid project paths never invoke Git and return a bounded error", async () => {
  const result = await readGitProject({ id: "bad", name: "Bad", path: "relative/path", github: "abudoxali/Bad" });
  assert.deepEqual(result, {
    id: "bad", name: "Bad", github: "abudoxali/Bad", status: "invalid-path"
  });
});

test("static assets are restricted to the local Universe allowlist", () => {
  assert.equal(isAllowedAsset("index.html"), true);
  assert.equal(isAllowedAsset("local-worlds.js"), true);
  assert.equal(isAllowedAsset("universe-experience.js"), true);
  assert.equal(isAllowedAsset("universe-experience.css"), true);
  assert.equal(isAllowedAsset("project-map.js"), true);
  assert.equal(isAllowedAsset("project-map.css"), true);
  assert.equal(isAllowedAsset("project-board.js"), true);
  assert.equal(isAllowedAsset("project-board.css"), true);
  assert.equal(isAllowedAsset("../.env"), false);
  assert.equal(isAllowedAsset("apps/local-bridge/src/git.mjs"), false);
});

test("config sanitizer never returns local path strings", () => {
  const safe = sanitizeWorldConfig({ githubOwner: "abudoxali", worlds: [{
    id: "one", name: "One", projects: [{ id: "p", name: "P", path: "C:\\secret", github: "abudoxali/P" }]
  }] });
  assert.equal(Object.hasOwn(safe.worlds[0].projects[0], "path"), false);
  assert.equal(safe.worlds[0].projects[0].github, "abudoxali/P");
});

test("local bridge serves sanitized worlds and rejects non-allowlisted files", async () => {
  const root = resolve(process.cwd(), "../..");
  const configRoot = await mkdtemp(join(tmpdir(), "abud-universe-"));
  const config = join(configRoot, "worlds.json");
  await writeFile(config, JSON.stringify({
    githubOwner: "abudoxali",
    worlds: [{ id: "universe", name: "Universe", projects: [{
      id: "self", name: "Universe", path: root, github: "abudoxali/-abud-github-universe"
    }] }]
  }));
  const server = createServer({ root, configPath: config, dbPath: ":memory:", vpsConfigPath: join(root, "no-vps.json") });
  await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const worlds = await (await fetch(origin + "/local-api/worlds")).json();
    assert.equal(worlds.worlds[0].projects[0].status, "ready");
    assert.equal(Object.hasOwn(worlds.worlds[0].projects[0], "path"), false);
    assert.equal((await fetch(origin + "/apps/local-bridge/src/git.mjs")).status, 404);
    assert.match(await (await fetch(origin + "/index.html")).text(), /mapWorld/);
  } finally {
    await new Promise((resolveClosed) => server.close(resolveClosed));
  }
});
