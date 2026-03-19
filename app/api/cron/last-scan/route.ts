import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), "results", "last_scan.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const json = JSON.parse(raw);
    return NextResponse.json(json ?? {});
  } catch (e) {
    return NextResponse.json({ alerts: [], generatedAt: null, error: String(e) }, { status: 200 });
  }
}

