import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

type PortfolioData = {
  positions: Record<
    string,
    {
      avg_price: number;
      shares: number;
      currency: string;
      tees?: string;
      target?: number;
      stop_loss?: number;
    }
  >;
  fx_rates?: Record<string, number>;
};

export const runtime = "nodejs";

function getDataPath() {
  return path.join(process.cwd(), "portfolio_data.json");
}

export async function GET() {
  try {
    const filePath = getDataPath();
    const raw = await fs.readFile(filePath, "utf-8");
    const json = JSON.parse(raw) as PortfolioData;
    return NextResponse.json(json);
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to read portfolio_data.json", detail: String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as
      | { action: "update"; ticker: string; patch: Partial<PortfolioData["positions"][string]> }
      | { action: "add"; ticker: string; position: PortfolioData["positions"][string] }
      | { action: "delete"; ticker: string };

    if (!body || typeof body !== "object" || !("action" in body)) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const filePath = getDataPath();
    const raw = await fs.readFile(filePath, "utf-8");
    const json = JSON.parse(raw) as PortfolioData;
    json.positions ??= {};

    if (body.action === "delete") {
      delete json.positions[body.ticker];
      await fs.writeFile(filePath, JSON.stringify(json, null, 2), "utf-8");
      return NextResponse.json({ ok: true });
    }

    if (body.action === "add") {
      json.positions[body.ticker] = {
        ...body.position,
        target: body.position.target ?? 0,
        stop_loss: body.position.stop_loss ?? 0,
        tees: body.position.tees ?? "",
      };
      await fs.writeFile(filePath, JSON.stringify(json, null, 2), "utf-8");
      return NextResponse.json({ ok: true, ticker: body.ticker });
    }

    if (body.action === "update") {
      const current = json.positions[body.ticker];
      if (!current) {
        return NextResponse.json({ error: "Ticker not found" }, { status: 404 });
      }
      json.positions[body.ticker] = {
        ...current,
        ...body.patch,
      };
      await fs.writeFile(filePath, JSON.stringify(json, null, 2), "utf-8");
      return NextResponse.json({ ok: true, ticker: body.ticker });
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to update portfolio_data.json", detail: String(e) },
      { status: 500 }
    );
  }
}

