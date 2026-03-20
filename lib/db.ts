/**
 * Postgres connection pool for portfolio-dashboard.
 * Used only when DATABASE_URL is set; no behavior change until routes switch to DB.
 */
import { Pool } from "pg";

let pool: Pool | null = null;

function getPool(): Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === "") return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

export async function query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
  const p = getPool();
  if (!p) throw new Error("DATABASE_URL not set");
  const result = await p.query(text, params);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

export function getDbPool(): Pool | null {
  return getPool();
}

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}
