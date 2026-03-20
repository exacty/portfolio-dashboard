import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

/**
 * SQLite-backed AI log (ai_analyses). Newest-first from DB, reversed to chronological in script.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ticker = url.searchParams.get("ticker")?.trim() || "-";
    const limitRaw = url.searchParams.get("limit") ?? "60";
    const limit = String(Math.min(200, Math.max(1, parseInt(limitRaw, 10) || 60)));

    const scriptPath = path.join(process.cwd(), "scripts", "list_ai_analyses.py");
    const result = (await execFileAsync("python3", [scriptPath, ticker, limit], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 5,
    })) as { stdout: string; stderr: string };

    const parsed = JSON.parse((result.stdout || "").trim()) as unknown;
    const res = NextResponse.json(Array.isArray(parsed) ? parsed : []);
    res.headers.set("X-AI-History-Store", "sqlite");
    return res;
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to load AI history", detail: String(e) },
      { status: 500 }
    );
  }
}
