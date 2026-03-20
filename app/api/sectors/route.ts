import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";

type PortfolioJson = Record<string, unknown>;

/** Same as /api/portfolio: read latest snapshot from SQLite via db_reader (no full engine run). */
const CACHE_MS = 5 * 60 * 1000;
let cached: { fetchedAt: number; data: PortfolioJson } | null = null;

const execFileAsync = promisify(execFile);

async function runDbReader(): Promise<PortfolioJson> {
  const scriptPath = path.join(process.cwd(), "scripts", "db_reader.py");
  const result = (await execFileAsync("python3", [scriptPath], {
    maxBuffer: 1024 * 1024 * 30,
    cwd: process.cwd(),
    encoding: "utf8",
  })) as { stdout: string; stderr: string };

  return JSON.parse(result.stdout) as unknown as PortfolioJson;
}

async function getPortfolioCached(): Promise<PortfolioJson> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_MS) return cached.data;
  const data = await runDbReader();
  cached = { fetchedAt: now, data };
  return data;
}

export async function GET() {
  try {
    const data = await getPortfolioCached();
    const res = NextResponse.json({
      sectors_rotation: data.sectors_rotation ?? [],
      sectors_allocation: data.sectors_allocation ?? [],
    });
    res.headers.set("X-Sectors-Source", "sqlite");
    return res;
  } catch (e) {
    return NextResponse.json({ error: "Failed to fetch sectors", detail: String(e) }, { status: 500 });
  }
}

