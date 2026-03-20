import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";

type PortfolioJson = Record<string, unknown>;

const CACHE_MS = 5 * 60 * 1000;

const execFileAsync = promisify(execFile);

async function runDbReader(): Promise<PortfolioJson> {
  const scriptPath = path.join(process.cwd(), "scripts", "db_reader.py");
  const result = (await execFileAsync("python3", [scriptPath], {
    maxBuffer: 1024 * 1024 * 20,
    cwd: process.cwd(),
    encoding: "utf8",
  })) as { stdout: string; stderr: string };

  return JSON.parse(result.stdout) as unknown as PortfolioJson;
}

function spawnBackgroundRefresh(): void {
  const scriptPath = path.join(process.cwd(), "scripts", "refresh_portfolio.py");
  const child = execFile("python3", [scriptPath], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 20,
    encoding: "utf8",
  });
  child.unref();
}

function snapshotAgeMs(data: PortfolioJson): number {
  const g = data.generatedAt;
  if (typeof g !== "string") return Number.POSITIVE_INFINITY;
  const t = Date.parse(g);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Date.now() - t;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const forceRefresh =
      url.searchParams.get("refresh") === "1" ||
      url.searchParams.get("force") === "1" ||
      url.searchParams.get("nocache") === "1";

    const data = await runDbReader();
    const age = snapshotAgeMs(data);
    const ageSec = Math.round(age / 1000);
    console.log("[portfolio] SQLite snapshot age:", ageSec, "seconds");

    if (forceRefresh || age >= CACHE_MS) {
      spawnBackgroundRefresh();
    }

    const res = NextResponse.json(data);
    res.headers.set("X-Cache-Age", String(Number.isFinite(age) ? ageSec : 0));
    res.headers.set("X-Portfolio-Source", "sqlite");
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

    const payload: Record<string, number | string> = {};
    if (typeof body.target === "number") payload.target = body.target;
    if (typeof body.stop_loss === "number") payload.stop_loss = body.stop_loss;
    if (typeof body.tees === "string") payload.tees = body.tees;
    if (Object.keys(payload).length === 0) {
      return NextResponse.json({ error: "No fields to update (target, stop_loss, tees)" }, { status: 400 });
    }

    const scriptPath = path.join(process.cwd(), "scripts", "update_position_overrides.py");
    const result = (await execFileAsync("python3", [scriptPath, body.ticker, JSON.stringify(payload)], {
      maxBuffer: 1024 * 1024,
      cwd: process.cwd(),
      encoding: "utf8",
    })) as { stdout: string; stderr: string };

    let parsed: { ok?: boolean; error?: string; ticker?: string; target?: number; stop_loss?: number; tees?: string };
    try {
      parsed = JSON.parse((result.stdout || "").trim()) as typeof parsed;
    } catch {
      return NextResponse.json(
        { error: "Update script returned invalid JSON", detail: result.stderr || result.stdout },
        { status: 500 }
      );
    }

    if (!parsed.ok) {
      if (parsed.error === "not_found") {
        return NextResponse.json(
          {
            error: "Ticker not found in SQLite positions",
            hint: "Run: python3 scripts/migrate.py (imports portfolio_data.json into data/portfolio.db)",
          },
          { status: 404 }
        );
      }
      if (parsed.error === "no_fields") {
        return NextResponse.json({ error: "No fields to update" }, { status: 400 });
      }
      return NextResponse.json({ error: "Update failed", detail: parsed.error ?? result.stderr }, { status: 500 });
    }

    spawnBackgroundRefresh();

    return NextResponse.json({
      ok: true,
      updated: {
        ticker: parsed.ticker ?? body.ticker,
        target: parsed.target,
        stop_loss: parsed.stop_loss,
        tees: parsed.tees,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to update portfolio", detail: String(e) },
      { status: 500 }
    );
  }
}
