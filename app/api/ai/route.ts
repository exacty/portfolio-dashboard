import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";

type PortfolioJson = Record<string, unknown>;
type JsonObject = Record<string, unknown>;

const CACHE_MS = 5 * 60 * 1000;
let cachedPortfolio: { fetchedAt: number; data: PortfolioJson } | null = null;

const execFileAsync = promisify(execFile);

async function runPortfolioEngine(): Promise<PortfolioJson> {
  const scriptPath = path.join(process.cwd(), "scripts", "portfolio_engine.py");
  const result = (await execFileAsync("python3", [scriptPath], {
    maxBuffer: 1024 * 1024 * 30,
    cwd: process.cwd(),
    encoding: "utf8",
  })) as { stdout: string; stderr: string };

  return JSON.parse(result.stdout) as unknown as PortfolioJson;
}

async function getPortfolioCached(): Promise<PortfolioJson> {
  const now = Date.now();
  if (cachedPortfolio && now - cachedPortfolio.fetchedAt < CACHE_MS) return cachedPortfolio.data;
  const data = await runPortfolioEngine();
  cachedPortfolio = { fetchedAt: now, data };
  return data;
}

function extractJson(text: string): JsonObject | null {
  // Claude may wrap output in code fences; try to robustly locate the JSON.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const candidate = text.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate) as JsonObject;
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT =
  "Sa oled maailma kogeneim portfellihaldur (30a+ kogemus Bridgewater, Citadel, Renaissance). Analüüsi portfelli ja anna KONKREETSED tegevusjuhised.";

const MODEL = "claude-sonnet-4-20250514";

export async function POST(req: Request) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing ANTHROPIC_API_KEY" },
        { status: 500 }
      );
    }

    const body = (await req.json()) as {
      action: "scan" | "analyze" | "chat";
      ticker?: string;
      message?: string;
    };

    const anthropic = new Anthropic({ apiKey });
    const portfolio = await getPortfolioCached();

    if (body.action === "scan") {
      const scanInstruction = body.message
        ? `Lisafookus: ${body.message}`
        : "Fookus: rebalansseerimine, müügi/ostu signaalid ja riskid.";

      const userPayload = {
        action: "scan",
        instruction: scanInstruction,
        portfolio: {
          generatedAt: portfolio.generatedAt,
          fx_rates: portfolio.fx_rates,
          sectors_rotation: portfolio.sectors_rotation,
          correlation: portfolio.correlation,
          positions: portfolio.positions,
          news: portfolio.news,
        },
      };

      const completion = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1200,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content:
              "Anna TÄPNE JSON ilma jutumärkideta (välja arvatud JSON stringide sees). Skeem:\n" +
              "{\n" +
              '  "advisorMessage": string (HTML lubatud),\n' +
              '  "alerts": Array<{ticker:string, severity:"critical"|"warning"|"success", message:string, buttonLabel:string, buttonVariant:"danger"|"amber"|"primary"}>,\n' +
              '  "positionUpdates": Record<string, {score:number, sigs:string[], sigT:["p"|"n"|"w"|"i","p"|"n"|"w"|"i","p"|"n"|"w"|"i"], target:number, stop_loss:number, flagged:boolean}>\n' +
              "}\n\n" +
              "Sisend (JSON):\n" +
              JSON.stringify(userPayload),
          },
        ],
      });

      const text = completion.content?.[0]?.type === "text" ? completion.content[0].text : "";
      const parsed = extractJson(text);
      if (!parsed) {
        return NextResponse.json({ error: "AI returned non-JSON", raw: text }, { status: 500 });
      }
      return NextResponse.json(parsed);
    }

    if (body.action === "analyze") {
      if (!body.ticker) {
        return NextResponse.json({ error: "Missing ticker" }, { status: 400 });
      }
      const ticker = body.ticker;
      const positions = Array.isArray(portfolio["positions"]) ? (portfolio["positions"] as Array<{ tk: string; [key: string]: unknown }>) : [];
      const position = positions.find((p) => p.tk === ticker);

      const userPayload = {
        action: "analyze",
        ticker,
        request: body.message ?? "Anna konkreetne SIGNAAL, SKOOR, TARGET ja STOP_LOSS ning lühike põhjendus.",
        position,
        // Provide minimal context for pricing/technical fields:
        correlation_subset: portfolio.correlation,
        sectors_rotation: portfolio.sectors_rotation,
      };

      const completion = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 900,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content:
              "Anna TÄPNE JSON ilma jutumärkideta (välja arvatud JSON stringide sees). Skeem:\n" +
              "{\n" +
              '  "ticker": string,\n' +
              '  "signal": "OST"|"MÜÜ"|"HOIA",\n' +
              '  "score": number,\n' +
              '  "target": number,\n' +
              '  "stop_loss": number,\n' +
              '  "sigs": string[],\n' +
              '  "sigT": ["p"|"n"|"w"|"i","p"|"n"|"w"|"i","p"|"n"|"w"|"i"],\n' +
              '  "rationaleHtml": string\n' +
              "}\n\n" +
              "Sisend (JSON):\n" +
              JSON.stringify(userPayload),
          },
        ],
      });

      const text = completion.content?.[0]?.type === "text" ? completion.content[0].text : "";
      const parsed = extractJson(text);
      if (!parsed) {
        return NextResponse.json({ error: "AI returned non-JSON", raw: text }, { status: 500 });
      }
      return NextResponse.json(parsed);
    }

    if (body.action === "chat") {
      if (!body.ticker) {
        return NextResponse.json({ error: "Missing ticker" }, { status: 400 });
      }
      if (!body.message) {
        return NextResponse.json({ error: "Missing message" }, { status: 400 });
      }

      const ticker = body.ticker;
      const positions = Array.isArray(portfolio["positions"]) ? (portfolio["positions"] as Array<{ tk: string; [key: string]: unknown }>) : [];
      const position = positions.find((p) => p.tk === ticker);

      const completion = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 600,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content:
              "Vasta investeerimisküsimusele ühe aktsia kohta. Anna TÄPNE JSON skeemiga:\n" +
              '{ "replyHtml": string }\n\n' +
              "Ticker: " +
              ticker +
              "\nPositsioon (JSON):\n" +
              JSON.stringify(position) +
              "\nKasutaja: " +
              body.message,
          },
        ],
      });

      const text = completion.content?.[0]?.type === "text" ? completion.content[0].text : "";
      const parsed = extractJson(text);
      if (!parsed) {
        return NextResponse.json({ error: "AI returned non-JSON", raw: text }, { status: 500 });
      }
      return NextResponse.json(parsed);
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: "AI request failed", detail: String(e) },
      { status: 500 }
    );
  }
}

