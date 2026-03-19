import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

type NewsSentiment = {
  ticker: string;
  sentiment: "bullish" | "bearish" | "neutral";
  impact: "high" | "medium" | "low";
  affectedPositions: string[];
  reasoningHtml: string;
};

type NewsResponse = { items: NewsSentiment[] };

const DATA_PATH = path.join(process.cwd(), "portfolio_data.json");

export const runtime = "nodejs";

async function readTickers(): Promise<string[]> {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf-8");
    const json = JSON.parse(raw) as { positions?: Record<string, unknown> };
    return json.positions ? Object.keys(json.positions) : [];
  } catch {
    return [];
  }
}

// NOTE: Full yfinance.news + Claude analysis can be added later.
// This endpoint is scaffolded to be safe and compilable.
export async function POST() {
  const tickers = await readTickers();
  const items: NewsSentiment[] = tickers.slice(0, 20).map((t) => ({
    ticker: t,
    sentiment: "neutral",
    impact: "low",
    affectedPositions: [t],
    reasoningHtml: "<em>Sentiment analyse on ajutiselt välja lülitatud.</em>",
  }));

  const res: NewsResponse = { items };
  return NextResponse.json(res);
}

