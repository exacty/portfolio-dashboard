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
  ma50?: Array<{ time: number; value: number }>;
  ma200?: Array<{ time: number; value: number }>;
  ema21?: Array<{ time: number; value: number }>;
  volume?: Array<{ time: number; value: number }>;
};

const execFileAsync = promisify(execFile);
const CACHE_MS = 5 * 60 * 1000;
let cached: { fetchedAt: number; data: Record<string, TickerHistoryResponse> } | null = null;

function cacheKey(ticker: string, range: string) {
  return `${ticker}:${range}`;
}

async function runHistory(ticker: string, range: string): Promise<TickerHistoryResponse> {
  const scriptPath = path.join(process.cwd(), "scripts", "portfolio_engine.py");
  const result = (await execFileAsync("python3", [scriptPath, "--history", "--ticker", ticker, "--range", range], {
    maxBuffer: 1024 * 1024 * 60,
    cwd: process.cwd(),
    encoding: "utf8",
  })) as { stdout: string; stderr: string };

  return JSON.parse(result.stdout) as TickerHistoryResponse;
}

const PERIOD_TO_RANGE: Record<string, string> = {
  "1N": "1w",
  "1K": "1mo",
  "3K": "3mo",
  "6K": "6mo",
  "1A": "1y",
  "3A": "3y",
  "1w": "1w",
  "1mo": "1mo",
  "3mo": "3mo",
  "6mo": "6mo",
  "1y": "1y",
  "3y": "3y",
};

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ticker = url.searchParams.get("ticker") ?? "";
    const periodParam = url.searchParams.get("period") ?? url.searchParams.get("range") ?? "1y";
    const range = PERIOD_TO_RANGE[periodParam] ?? periodParam;
    if (!ticker) return NextResponse.json({ error: "Missing ticker" }, { status: 400 });

    const now = Date.now();
    const key = cacheKey(ticker, range);
    if (cached && now - cached.fetchedAt < CACHE_MS && cached.data[key]) {
      return NextResponse.json(cached.data[key]);
    }

    const data = await runHistory(ticker, range);
    if (!cached) cached = { fetchedAt: now, data: { [key]: data } };
    else {
      cached = { fetchedAt: now, data: { ...cached.data, [key]: data } };
    }
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: "Failed to load ticker history", detail: String(e) }, { status: 500 });
  }
}

