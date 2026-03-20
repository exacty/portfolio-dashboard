import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";

type HistoryEntry = {
  generatedAt: string;
  totalEur?: number;
  spyClose?: number;
};

const execFileAsync = promisify(execFile);

async function loadHistoryFromSqlite(limit: number): Promise<HistoryEntry[] | null> {
  try {
    const scriptPath = path.join(process.cwd(), "scripts", "performance_history.py");
    const result = (await execFileAsync("python3", [scriptPath, String(limit)], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
    })) as { stdout: string; stderr: string };
    const parsed = JSON.parse((result.stdout || "").trim()) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as HistoryEntry[];
  } catch {
    return null;
  }
}

async function loadHistoryFromFile(): Promise<HistoryEntry[]> {
  const filePath = path.join(process.cwd(), "results", "history.json");
  const raw = await fs.readFile(filePath, "utf-8").catch(() => "[]");
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
}

function countUsablePortfolio(entries: HistoryEntry[]) {
  return entries.filter((e) => typeof e.totalEur === "number" && e.totalEur > 0).length;
}

export async function GET() {
  try {
    const sqliteLimit = 8000;
    const fromDb = await loadHistoryFromSqlite(sqliteLimit);
    const fileArr = await loadHistoryFromFile();

    const dbN = fromDb ? countUsablePortfolio(fromDb) : 0;
    const fileN = countUsablePortfolio(fileArr);

    let arr: HistoryEntry[];
    let source: "sqlite" | "file";
    if (dbN >= 2) {
      arr = fromDb!;
      source = "sqlite";
    } else if (fileN >= 2) {
      arr = fileArr;
      source = "file";
    } else if (dbN > 0) {
      arr = fromDb!;
      source = "sqlite";
    } else {
      arr = fileArr;
      source = "file";
    }

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

    const res = NextResponse.json({
      portfolio: portfolioNorm,
      spy: spyNorm,
      raw: { portfolio, spy },
      source,
    });
    res.headers.set("X-Performance-Source", source);
    return res;
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to read performance history", detail: String(e) },
      { status: 500 }
    );
  }
}
