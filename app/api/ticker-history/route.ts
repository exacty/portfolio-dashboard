import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";

type TickerHistoryResponse = {
  ticker: string;
  range: string;
  chosenSource?: string;
  lastMedian?: number;
  candidates?: Array<{ source: string; lastClose: number; len: number }>;
  candles: Array<{ time: number; open: number; high: number; low: number; close: number }>;
};

const execFileAsync = promisify(execFile);
const CACHE_MS = 5 * 60 * 1000;
let cached: { fetchedAt: number; data: Record<string, TickerHistoryResponse> } | null = null;

async function runHistory(ticker: string, range: string): Promise<TickerHistoryResponse> {
  const scriptPath = path.join(process.cwd(), "scripts", "portfolio_engine.py");
  const result = (await execFileAsync("python3", [scriptPath, "--history", "--ticker", ticker, "--range", range], {
    maxBuffer: 1024 * 1024 * 60,
    cwd: process.cwd(),
    encoding: "utf8",
  })) as { stdout: string; stderr: string };

  return JSON.parse(result.stdout) as TickerHistoryResponse;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ticker = url.searchParams.get("ticker") ?? "";
    const range = url.searchParams.get("range") ?? "3mo";
    if (!ticker) return NextResponse.json({ error: "Missing ticker" }, { status: 400 });

    const now = Date.now();
    if (cached && now - cached.fetchedAt < CACHE_MS && cached.data[ticker]) {
      return NextResponse.json(cached.data[ticker]);
    }

    const data = await runHistory(ticker, range);
    if (!cached) cached = { fetchedAt: now, data: { [ticker]: data } };
    else {
      cached = { fetchedAt: now, data: { ...cached.data, [ticker]: data } };
    }
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: "Failed to load ticker history", detail: String(e) }, { status: 500 });
  }
}

