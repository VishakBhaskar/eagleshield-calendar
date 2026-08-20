import { readFile } from "node:fs/promises";
import pg from "pg";

const { Pool } = pg;
const url = process.env.DATABASE_URL;

if (!url) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production.");
  }
  process.stdout.write("DATABASE_URL is not set; skipping the external database migration.\n");
  process.exit(0);
}

const sql = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const pool = new Pool({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
});

try {
  await pool.query(sql);
  process.stdout.write("Eagle Shield database migration complete.\n");
} finally {
  await pool.end();
}
