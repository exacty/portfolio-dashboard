import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

type HistoryEntry = {
  generatedAt: string;
  totalEur?: number;
  spyClose?: number;
};

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), "results", "history.json");
    const raw = await fs.readFile(filePath, "utf-8").catch(() => "[]");
    const parsed = JSON.parse(raw) as unknown;
    const arr: HistoryEntry[] = Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];

    const portfolio = arr
      .filter((e) => typeof e.totalEur === "number" && e.totalEur > 0)
      .map((e) => ({
        date: e.generatedAt,
        value: e.totalEur as number,
      }))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const spy = arr
      .filter((e) => typeof e.spyClose === "number" && e.spyClose > 0)
      .map((e) => ({
        date: e.generatedAt,
        value: e.spyClose as number,
      }))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Normalize to same base (100) for comparison
    const portfolioBase = portfolio[0]?.value ?? 1;
    const spyBase = spy[0]?.value ?? 1;
    const portfolioNorm = portfolio.map((p) => ({
      date: p.date,
      value: (p.value / portfolioBase) * 100,
    }));
    const spyNorm = spy.map((s) => ({
      date: s.date,
      value: (s.value / spyBase) * 100,
    }));

    return NextResponse.json({
      portfolio: portfolioNorm,
      spy: spyNorm,
      raw: { portfolio, spy },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to read performance history", detail: String(e) },
      { status: 500 }
    );
  }
}
