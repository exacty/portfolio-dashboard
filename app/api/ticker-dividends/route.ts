import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";

type DividendPayment = { date: string; amount: number };
type TickerDividendsResponse = {
  ticker: string;
  years?: number;
  payments: DividendPayment[];
  /** Kuvamiseks valitud yield (mitme allika ühendus + reeglid); eelistatud väli. */
  displayAvgAnnualYieldPct?: number;
  avgAnnualYieldPct: number;
  currency?: string;
  yearsInAvg?: number;
  analysis?: Record<string, unknown>;
  updatedAt?: string;
  error?: string;
};

const execFileAsync = promisify(execFile);

async function runCachedDividends(ticker: string, years: number, forceRefresh: boolean): Promise<TickerDividendsResponse> {
  const scriptPath = path.join(process.cwd(), "scripts", "market_data_fetch.py");
  const env = { ...process.env };
  if (forceRefresh) {
    env.FORCE_MARKET_REFRESH = "1";
  }
  const result = (await execFileAsync("python3", [scriptPath, "dividends", ticker, String(years)], {
    maxBuffer: 1024 * 1024 * 5,
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  })) as { stdout: string; stderr: string };

  return JSON.parse(result.stdout) as TickerDividendsResponse;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ticker = url.searchParams.get("ticker") ?? "";
    const years = Math.min(10, Math.max(1, Number(url.searchParams.get("years") ?? "3") || 3));
    const forceRefresh =
      url.searchParams.get("refresh") === "1" ||
      url.searchParams.get("force") === "1" ||
      url.searchParams.get("nocache") === "1";
    if (!ticker) return NextResponse.json({ error: "Missing ticker" }, { status: 400 });

    const data = await runCachedDividends(ticker, years, forceRefresh);
    const res = NextResponse.json(data);
    res.headers.set("X-Market-Data-Store", "sqlite");
    return res;
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to load dividends", detail: String(e) },
      { status: 500 }
    );
  }
}
