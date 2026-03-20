#!/usr/bin/env node
/**
 * Run Phase 1A schema migration.
 * Requires DATABASE_URL in env.
 */
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const url = process.env.DATABASE_URL;
if (!url || !url.trim()) {
  console.error("DATABASE_URL is required. Set it in .env.local or export it.");
  process.exit(1);
}

async function main() {
  const schemaPath = path.join(process.cwd(), "lib", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(sql);
    console.log("Migration complete: accounts, holdings, fx_rates, broker_snapshots");
  } catch (e) {
    console.error("Migration failed:", e);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
