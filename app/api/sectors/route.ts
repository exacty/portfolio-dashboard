import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";

type PortfolioJson = Record<string, unknown>;

const CACHE_MS = 5 * 60 * 1000;
let cached: { fetchedAt: number; data: PortfolioJson } | null = null;

const execFileAsync = promisify(execFile);

async function runPortfolioEngine(): Promise<PortfolioJson> {
  const scriptPath = path.join(process.cwd(), "scripts", "portfolio_engine.py");
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
  const data = await runPortfolioEngine();
  cached = { fetchedAt: now, data };
  return data;
}

export async function GET() {
  try {
    const data = await getPortfolioCached();
    return NextResponse.json({
      sectors_rotation: data.sectors_rotation ?? [],
      sectors_allocation: data.sectors_allocation ?? [],
    });
  } catch (e) {
    return NextResponse.json({ error: "Failed to fetch sectors", detail: String(e) }, { status: 500 });
  }
}

