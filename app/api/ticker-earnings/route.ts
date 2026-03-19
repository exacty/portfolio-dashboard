import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";

type QuarterlyEarning = { date: string; eps: number | null; epsGrowth?: number };
type TickerEarningsResponse = {
  ticker: string;
  quarterlyEarnings: QuarterlyEarning[];
  canslim: Record<string, string>;
};

const execFileAsync = promisify(execFile);

async function runEarningsScript(ticker: string): Promise<TickerEarningsResponse> {
  const scriptPath = path.join(process.cwd(), "scripts", "ticker_earnings.py");
  const result = (await execFileAsync("python3", [scriptPath, ticker], {
    maxBuffer: 1024 * 1024 * 10,
    cwd: process.cwd(),
    encoding: "utf8",
  })) as { stdout: string; stderr: string };

  return JSON.parse(result.stdout) as TickerEarningsResponse;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ticker = url.searchParams.get("ticker") ?? "";
    if (!ticker) return NextResponse.json({ error: "Missing ticker" }, { status: 400 });

    const data = await runEarningsScript(ticker);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to load earnings", detail: String(e) },
      { status: 500 }
    );
  }
}
