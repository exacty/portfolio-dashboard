import { NextResponse } from "next/server";

type RebalancePlan = {
  sells: Array<{ ticker: string; shares: number; reason: string }>;
  buys: Array<{ ticker: string; shares: number; reason: string }>;
  summaryHtml: string;
};

export const runtime = "nodejs";

// NOTE: Full optimizer (sector caps/correlation constraints) will be added later.
// Endpoint is scaffolded so frontend/cron can depend on it immediately.
export async function POST() {
  const plan: RebalancePlan = {
    sells: [],
    buys: [],
    summaryHtml:
      "<em>Rebalanss optimeerimine on ajutiselt skeemirežiimis. Lisan optimizer-logic ja Claude/AI põhjendused järgmiseks sammuks.</em>",
  };
  return NextResponse.json({ ok: true, plan });
}

