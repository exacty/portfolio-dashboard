import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { promisify } from "node:util";

type EnginePosition = {
  tk: string;
  price: number;
  rsi: number;
  score: number;
  target?: number;
  stop_loss?: number;
  tees?: string;
};

type EngineOutput = {
  generatedAt?: string;
  positions: EnginePosition[];
  earnings?: Array<{ date: string; tk: string; est?: string }>;
  kpis?: { portfolioTotal?: number };
  macro?: { items?: Array<{ label: string; raw?: number }> };
};

type ScanSnapshot = {
  generatedAt: string;
  positions: Record<string, { price: number; rsi: number; score: number; target: number; stop_loss: number; tees: string }>;
};

type HistoryEntry = {
  generatedAt: string;
  positions: ScanSnapshot["positions"];
  totalEur?: number;
  spyClose?: number;
};

const execFileAsync = promisify(execFile);

const CACHE_MS = 5 * 60 * 1000;
let cached: { fetchedAt: number; data: EngineOutput } | null = null;

async function runEngine(): Promise<EngineOutput> {
  const scriptPath = path.join(process.cwd(), "scripts", "portfolio_engine.py");
  const result = (await execFileAsync("python3", [scriptPath], {
    maxBuffer: 1024 * 1024 * 60,
    cwd: process.cwd(),
    encoding: "utf8",
  })) as { stdout: string; stderr: string };

  return JSON.parse(result.stdout) as EngineOutput;
}

async function getEngineCached(): Promise<EngineOutput> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_MS) return cached.data;
  const data = await runEngine();
  cached = { fetchedAt: now, data };
  return data;
}

function getResultsPath(file: string) {
  return path.join(process.cwd(), "results", file);
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(getResultsPath(file), "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseCETHour(now: Date) {
  // Use Europe/Helsinki which follows CET/CEST similarly to Estonia.
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Helsinki", hour: "numeric", hour12: false });
  const hourStr = fmt.format(now);
  const hour = Number(hourStr);
  return Number.isFinite(hour) ? hour : now.getHours();
}

function buildSnapshot(engine: EngineOutput): ScanSnapshot {
  const generatedAt = engine.generatedAt ?? new Date().toISOString();
  const positions: ScanSnapshot["positions"] = {};
  for (const p of engine.positions) {
    positions[p.tk] = {
      price: Number(p.price ?? 0),
      rsi: Number(p.rsi ?? 50),
      score: Number(p.score ?? 50),
      target: Number(p.target ?? 0),
      stop_loss: Number(p.stop_loss ?? 0),
      tees: String(p.tees ?? ""),
    };
  }
  return { generatedAt, positions };
}

function absPctChange(cur: number, prev: number) {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return 0;
  return ((cur - prev) / prev) * 100.0;
}

function sendNotify(messages: string[], type: "urgent" | "warning" | "info") {
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";
  return fetch(`${base}/api/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, messages }),
  });
}

async function appendHistory(snapshot: ScanSnapshot, engine: EngineOutput) {
  const historyPath = getResultsPath("history.json");
  const raw = await fs.readFile(historyPath, "utf-8").catch(() => "[]");
  const parsed = JSON.parse(raw) as unknown;
  const arr: HistoryEntry[] = Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  const totalEur = engine.kpis?.portfolioTotal ?? (engine.positions as Array<{ eur?: number }>).reduce((s, p) => s + (p.eur ?? 0), 0);
  const spyItem = engine.macro?.items?.find((i) => i.label === "S&P500");
  const spyClose = spyItem?.raw;
  arr.push({
    generatedAt: snapshot.generatedAt,
    positions: snapshot.positions,
    totalEur: totalEur > 0 ? totalEur : undefined,
    spyClose: typeof spyClose === "number" && spyClose > 0 ? spyClose : undefined,
  });
  await fs.writeFile(historyPath, JSON.stringify(arr, null, 2), "utf-8");
}

export async function GET() {
  try {
    const engine = await getEngineCached();
    const snapshot = buildSnapshot(engine);
    const prev = await readJsonFile<ScanSnapshot>("last_scan.json");

    const urgent: string[] = [];
    const warning: string[] = [];
    const info: string[] = [];

    for (const [tk, curPos] of Object.entries(snapshot.positions)) {
      const prevPos = prev?.positions?.[tk];
      if (!prevPos) continue;

      const pricePct = absPctChange(curPos.price, prevPos.price);
      const rsiDelta = curPos.rsi - prevPos.rsi;
      const scoreDelta = curPos.score - prevPos.score;

      const stopLossHit = curPos.stop_loss > 0 && curPos.price <= curPos.stop_loss;
      const targetHit = curPos.target > 0 && curPos.price >= curPos.target;

      if (stopLossHit) {
        urgent.push(
          `🔴 *${tk}* — stop-loss puudutatud!\nHind: ${curPos.price.toFixed(2)} | Stop: ${curPos.stop_loss.toFixed(2)}\nTees: ${curPos.tees || "—"}\n▸ _Soovitus: vähenda/katkesta positsioon kohe_`
        );
        continue;
      }

      // RSI warning band
      if (curPos.rsi > 75 || curPos.rsi < 25) {
        warning.push(`🟡 *${tk}* — RSI äärmuses!\nRSI: ${curPos.rsi}\nHind: ${curPos.price.toFixed(2)}\n▸ _Soovitus: jälgi volatiilsust ja riski_`);
      }

      // Target proximity warning
      if (curPos.target > 0) {
        const distPct = absPctChange(curPos.price, curPos.target);
        // distPct is target vs price; use abs distance from target
        if (Math.abs(distPct) <= 2.5) {
          warning.push(`🟡 *${tk}* — hind liigub targeti lähedale.\nHind: ${curPos.price.toFixed(2)} | Target: ${curPos.target.toFixed(2)}`);
        }
      }

      // Tees broken = score < 30 (approx rule)
      if (curPos.score < 30 && (curPos.tees ?? "").trim().length > 0) {
        urgent.push(
          `🔴 *${tk}* — tees katkes!\nSkoor: ${curPos.score} (Δ ${scoreDelta.toFixed(0)})\nTees: ${curPos.tees || "—"}\n▸ _Soovitus: analüüsi müüki/vahetust_`
        );
      }

      if (targetHit) {
        info.push(`🟢 *${tk}* — target saavutatud!\nHind: ${curPos.price.toFixed(2)} | Target: ${curPos.target.toFixed(2)}\n▸ _Soovitus: realiseeri ja tõsta stop-loss_`);
      }

      // Big movements
      if (Math.abs(pricePct) > 5) {
        info.push(`📊 *${tk}* — hinnamuutus > 5%.\nHind: ${curPos.price.toFixed(2)} (Δ ${pricePct.toFixed(1)}%)`);
      }
      if (Math.abs(rsiDelta) > 10) {
        info.push(`📊 *${tk}* — RSI muutus > 10.\nRSI: ${curPos.rsi} (Δ ${rsiDelta.toFixed(0)})`);
      }
    }

    // Always generate and store the snapshot + categorized alert messages.
    const lastScanToWrite = {
      ...snapshot,
      alerts: {
        urgent,
        warning,
        info,
      },
    };
    await fs.writeFile(getResultsPath("last_scan.json"), JSON.stringify(lastScanToWrite, null, 2), "utf-8");
    await appendHistory(snapshot, engine);

    // Telegram notifications
    const notifyPromises: Promise<Response>[] = [];
    if (urgent.length) notifyPromises.push(sendNotify(urgent, "urgent"));
    if (warning.length) notifyPromises.push(sendNotify(warning, "warning"));
    if (info.length) notifyPromises.push(sendNotify(info, "info"));
    await Promise.all(notifyPromises);

    // Optional daily reports (script can do more detail)
    const hour = parseCETHour(new Date());
    if (hour === 6 || hour === 7) {
      const morningScript = path.join(process.cwd(), "scripts", "daily_report.py");
      execFile("python3", [morningScript, "--mode", "morning"], { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 20 }, () => null);
    } else if (hour === 17 || hour === 18) {
      const eveningScript = path.join(process.cwd(), "scripts", "daily_report.py");
      execFile("python3", [eveningScript, "--mode", "evening"], { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 20 }, () => null);
    }

    return NextResponse.json({ ok: true, urgent: urgent.length, warning: warning.length, info: info.length });
  } catch (e) {
    return NextResponse.json({ error: "Cron scan failed", detail: String(e) }, { status: 500 });
  }
}

