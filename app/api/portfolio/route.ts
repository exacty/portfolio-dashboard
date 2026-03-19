import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

export const runtime = "nodejs";

type PortfolioJson = Record<string, unknown>;

const CACHE_MS = 5 * 60 * 1000;
const CACHE_PATH = path.join(process.cwd(), "scripts", ".cache", "portfolio_cache.json");

const execFileAsync = promisify(execFile);

async function runPortfolioEngine(): Promise<PortfolioJson> {
  const scriptPath = path.join(process.cwd(), "scripts", "portfolio_engine.py");
  const result = (await execFileAsync("python3", [scriptPath], {
    maxBuffer: 1024 * 1024 * 20,
    cwd: process.cwd(),
    encoding: "utf8",
  })) as { stdout: string; stderr: string };

  return JSON.parse(result.stdout) as unknown as PortfolioJson;
}

function spawnBackgroundRefresh(): void {
  const scriptPath = path.join(process.cwd(), "scripts", "portfolio_engine.py");
  const child = execFile(
    "python3",
    [scriptPath],
    { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 20,
      encoding: "utf8",
    },
    () => {
      // Done; cache file updated by engine
    }
  );
  child.unref();
}

export async function GET() {
  try {
    const now = Date.now();
    const cacheExists = existsSync(CACHE_PATH);
    console.log("[portfolio] Cache exists:", cacheExists);

    let cached: PortfolioJson;
    let cacheAgeMs = 0;

    try {
      const raw = await fs.readFile(CACHE_PATH, "utf-8");
      cached = JSON.parse(raw) as PortfolioJson;
      const stat = await fs.stat(CACHE_PATH);
      cacheAgeMs = now - (stat.mtimeMs ?? stat.mtime.getTime());
      const cacheAgeSec = Math.round(cacheAgeMs / 1000);
      console.log("[portfolio] Cache age:", cacheAgeSec, "seconds");
    } catch {
      console.log("[portfolio] No cache or read failed, running engine...");
      const data = await runPortfolioEngine();
      const res = NextResponse.json(data);
      res.headers.set("X-Cache-Age", "0");
      return res;
    }

    if (cacheAgeMs < CACHE_MS) {
      const res = NextResponse.json(cached);
      res.headers.set("X-Cache-Age", String(Math.round(cacheAgeMs / 1000)));
      return res;
    }

    spawnBackgroundRefresh();
    const res = NextResponse.json(cached);
    res.headers.set("X-Cache-Age", String(Math.round(cacheAgeMs / 1000)));
    return res;
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to fetch portfolio", detail: String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { action: string; ticker?: string; target?: number; stop_loss?: number; tees?: string };
    if (body.action !== "update") {
      return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }
    if (!body.ticker) {
      return NextResponse.json({ error: "Missing ticker" }, { status: 400 });
    }

    const filePath = path.join(process.cwd(), "portfolio_data.json");
    type PositionEntry = { target?: number; stop_loss?: number; [key: string]: unknown };
    type PortfolioDataFile = { positions?: Record<string, PositionEntry> };

    const raw = await fs.readFile(filePath, "utf-8");
    const json = JSON.parse(raw) as PortfolioDataFile;
    json.positions ??= {};

    const pos = json.positions[body.ticker];
    if (!pos) {
      return NextResponse.json({ error: "Ticker not found in portfolio_data.json" }, { status: 404 });
    }

    if (typeof body.target === "number") pos.target = body.target;
    if (typeof body.stop_loss === "number") pos.stop_loss = body.stop_loss;
    if (typeof body.tees === "string") pos.tees = body.tees;

    await fs.writeFile(filePath, JSON.stringify(json, null, 2), "utf-8");

    try {
      await fs.unlink(CACHE_PATH);
    } catch {
      // ignore
    }

    return NextResponse.json({ ok: true, updated: { ticker: body.ticker, target: pos.target, stop_loss: pos.stop_loss } });
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to update portfolio", detail: String(e) },
      { status: 500 }
    );
  }
}
