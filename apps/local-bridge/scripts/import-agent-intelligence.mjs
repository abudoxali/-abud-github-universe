#!/usr/bin/env node
/* Import the owner-authored profile/working-context sections into the private local SQLite memory store. */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { createCompany } from "../src/company.mjs";
import { importIntelligencePack } from "../src/intelligence-pack.mjs";

const [sourceFile, databaseFile] = process.argv.slice(2);
if (!sourceFile) {
  console.error("Usage: node scripts/import-agent-intelligence.mjs <private-pack.md> [company.db]");
  process.exitCode = 2;
} else {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dbPath = databaseFile ? resolve(databaseFile) : resolve(repoRoot, "local/company.db");
  const db = openDatabase(dbPath);
  try {
    const backup = db.backup(resolve(dirname(dbPath), "backups"));
    const company = createCompany({ db });
    company.seed();
    const records = importIntelligencePack({ company, markdown: await readFile(resolve(sourceFile), "utf8") });
    console.log(JSON.stringify({ database: "local/company.db", backup: { file: backup.file.split(/[\\/]/).at(-1), verified: backup.verified }, imported: records.map(({ key, state }) => ({ key, state })), count: records.length }));
  } finally {
    db.close();
  }
}
