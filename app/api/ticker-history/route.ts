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

async function runCachedHistory(ticker: string, range: string, forceRefresh: boolean): Promise<TickerHistoryResponse> {
  const scriptPath = path.join(process.cwd(), "scripts", "market_data_fetch.py");
  const env = { ...process.env };
  if (forceRefresh) {
    env.FORCE_MARKET_REFRESH = "1";
  }
  const result = (await execFileAsync("python3", [scriptPath, "history", ticker, range], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 60,
    encoding: "utf8",
    env,
    shell: false,
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
    const forceRefresh =
      url.searchParams.get("refresh") === "1" ||
      url.searchParams.get("force") === "1" ||
      url.searchParams.get("nocache") === "1";
    if (!ticker) return NextResponse.json({ error: "Missing ticker" }, { status: 400 });

    const data = await runCachedHistory(ticker, range, forceRefresh);
    const res = NextResponse.json(data);
    res.headers.set("X-Market-Data-Store", "sqlite");
    return res;
  } catch (e) {
    return NextResponse.json({ error: "Failed to load ticker history", detail: String(e) }, { status: 500 });
  }
}
