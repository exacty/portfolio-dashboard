import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";

type PortfolioJson = Record<string, unknown>;
type JsonObject = Record<string, unknown>;

const CACHE_MS = 5 * 60 * 1000;
const CACHE_PATH = path.join(process.cwd(), "scripts", ".cache", "portfolio_cache.json");
const PORTFOLIO_DATA_PATH = path.join(process.cwd(), "portfolio_data.json");

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

  try {
    const raw = await fs.readFile(CACHE_PATH, "utf-8");
    const data = JSON.parse(raw) as PortfolioJson;
    cachedPortfolio = { fetchedAt: now, data };
    return data;
  } catch {
    const data = await runPortfolioEngine();
    cachedPortfolio = { fetchedAt: now, data };
    return data;
  }
}

async function readPortfolioData(): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(PORTFOLIO_DATA_PATH, "utf-8");
    const json = JSON.parse(raw) as { positions?: Record<string, unknown> };
    return json.positions ?? {};
  } catch {
    return {};
  }
}

function buildPortfolioContext(portfolio: PortfolioJson, portfolioData: Record<string, unknown>): string {
  const parts: string[] = [];

  parts.push("## Portfelli kontekst (ALATI kasuta seda)");
  parts.push("");

  const kpis = portfolio.kpis as Record<string, unknown> | undefined;
  if (kpis) {
    parts.push("### KPI-d");
    parts.push(`- Portfell kokku: €${Number(kpis.portfolioTotal ?? 0).toLocaleString("de-DE", { maximumFractionDigits: 0 })}`);
    parts.push(`- Päeva muutus: ${Number(kpis.dayChgPct ?? 0).toFixed(1)}%`);
    parts.push(`- Realiseerimata P&L: €${Number(kpis.unrealizedPnl ?? 0).toLocaleString("de-DE", { maximumFractionDigits: 0 })} (${Number(kpis.unrealizedPnlPct ?? 0).toFixed(1)}%)`);
    parts.push(`- Div yield: ${Number(kpis.divYield ?? 0).toFixed(1)}%`);
    parts.push(`- Beta: ${Number(kpis.beta ?? 0).toFixed(2)} | Sharpe: ${Number(kpis.sharpe ?? 0).toFixed(2)}`);
    parts.push("");
  }

  const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
  if (positions.length) {
    parts.push("### Positsioonid");
    for (const p of positions as Array<Record<string, unknown>>) {
      const tk = String(p.tk ?? "");
      const name = String(p.name ?? tk);
      const price = Number(p.price ?? 0);
      const cur = String(p.cur ?? "");
      const eur = Number(p.eur ?? 0);
      const pct = Number(p.pct ?? 0);
      const ret = Number(p.ret ?? 0);
      const score = Number(p.score ?? 50);
      const rsi = Number(p.rsi ?? 50);
      const sigs = Array.isArray(p.sigs) ? (p.sigs as string[]) : [];
      const target = Number(p.target ?? 0);
      const stopLoss = Number(p.stop_loss ?? 0);
      const tees = String(p.tees ?? "");
      const meta = portfolioData[tk] as Record<string, unknown> | undefined;
      const metaTarget = meta ? Number(meta.target ?? 0) : target;
      const metaStop = meta ? Number(meta.stop_loss ?? 0) : stopLoss;
      const metaTees = meta ? String(meta.tees ?? "") : tees;

      parts.push(
        `- **${tk}** (${name}): ${price.toFixed(2)} ${cur} | €${eur.toLocaleString("de-DE", { maximumFractionDigits: 0 })} (${pct.toFixed(1)}%) | ret ${ret >= 0 ? "+" : ""}${ret.toFixed(1)}% | skoor ${score} | RSI ${rsi} | sigs [${sigs.join(", ")}]`
      );
      if (metaTarget > 0 || metaStop > 0 || (metaTees && metaTees.trim())) {
        parts.push(`  Target: ${metaTarget > 0 ? metaTarget : "—"} | Stop: ${metaStop > 0 ? metaStop : "—"} | Tees: ${metaTees || "—"}`);
      }
    }
    parts.push("");
  }

  const sectors = Array.isArray(portfolio.sectors_allocation) ? portfolio.sectors_allocation : [];
  if (sectors.length) {
    parts.push("### Sektori jaotus");
    for (const s of sectors as Array<{ name: string; pct: number }>) {
      parts.push(`- ${s.name}: ${s.pct.toFixed(1)}%`);
    }
    parts.push("");
  }

  const rotation = Array.isArray(portfolio.sectors_rotation) ? portfolio.sectors_rotation : [];
  if (rotation.length) {
    parts.push("### Sektori rotatsioon (faasid)");
    for (const r of rotation as Array<{ ticker: string; phase?: string; ytd?: number }>) {
      parts.push(`- ${r.ticker}: ${r.phase ?? "—"} (YTD ${typeof r.ytd === "number" ? r.ytd.toFixed(1) + "%" : "—"})`);
    }
    parts.push("");
  }

  const macro = portfolio.macro as { items?: Array<{ label: string; value: string; chgText?: string }> } | undefined;
  if (macro?.items?.length) {
    parts.push("### Makro");
    for (const m of macro.items) {
      parts.push(`- ${m.label}: ${m.value} ${m.chgText ?? ""}`);
    }
    parts.push("");
  }

  const news = Array.isArray(portfolio.news) ? portfolio.news : [];
  if (news.length) {
    parts.push("### Viimased uudised");
    for (const n of (news.slice(0, 8) as Array<{ time?: string; headline?: string; tag?: string }>)) {
      parts.push(`- [${n.tag ?? ""}] ${n.time ?? ""}: ${(n.headline ?? "").replace(/<[^>]+>/g, "").slice(0, 80)}...`);
    }
    parts.push("");
  }

  const correlation = portfolio.correlation as { tickers?: string[] } | undefined;
  if (correlation?.tickers?.length) {
    parts.push(`### Korrelatsioon (${correlation.tickers.length} tickerit)`);
    parts.push("");
  }

  return parts.join("\n");
}

function extractJson(text: string): JsonObject | null {
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

const ALPHA_SYSTEM_PROMPT = `Sa oled ALPHA — maailma kõige kogenum ja edukam investeerimisprofessionaal. Sinu taust:

KOGEMUS (35+ aastat):
- Bridgewater Associates: Ray Dalio parem käsi, juhtisid All Weather portfelli riskijuhtimist. Õppisid makro tsükleid, riskipariteet ja "masina" ehitamist.
- Renaissance Technologies: Jim Simonsi Medallion fondi kvantstrateeg. Tead kuidas andmetest alfat leida, statistiline arbitraaž, mean reversion.
- Citadel: Ken Griffini multi-strategy fondi portfellihaldur. Long/short equity, event-driven, convertible arb.
- Goldman Sachs Asset Management: Juhtisid $50B global equity portfelli. Institutional-grade stock picking, sector rotation.
- Soros Fund Management: George Sorosi makromeeskonnas. Tead kuidas valuutad, intressimäärad ja geopoliitika turge liigutavad.
- Berkshire Hathaway: Buffetti ja Mungeri kõrval. Value investing sügavaimal tasemel — moat, pricing power, capital allocation.
- Family Office ($2B+): Juhtisid ultra-high-net-worth perekonna kogu vara. Tead kuidas kaitsta ja kasvatada põlvkondade ülest vara.

SINU INVESTEERIMISTEADMISED:
Fundamentaalanalüüs:
- DCF modelleerimine, SOTP (sum-of-the-parts), residual income model
- Financial statement analüüs: income statement, balance sheet, cash flow statement kõik seosed
- Quality metrics: ROIC vs WACC spread, incremental ROIC, capital efficiency
- Earnings quality: akruaalide analüüs, cash conversion, recurring vs non-recurring
- Dividend sustainability: FCF payout ratio, dividend coverage, dividend growth rate vs earnings growth

Tehniline analüüs:
- William O'Neil CANSLIM: C(current earnings), A(annual earnings), N(new), S(supply/demand), L(leader/laggard), I(institutional), M(market)
- Mark Minervini SEPA: stage analysis, proper buy points, tight risk management
- Stan Weinstein: 4 etapi tsükkel — accumulation, markup, distribution, decline
- Küünlajalgade mustrid: hammer, engulfing, doji, morning/evening star
- Elliott Wave, Fibonacci retracements, Wyckoff method

Makro:
- Intressitsüklid: kuidas Fed/ECB/BoE otsused mõjutavad erinevaid varaklasse
- Yield curve: inversions, steepening, flattening — mida need tähendavad portfellile
- Inflatsioonikeskkond: TIPS breakeven, commodity super-cycles, wage growth
- Currency impact: DXY tugevus/nõrkus, carry trade, valuutahedging
- Credit cycle: HY spreads, IG spreads, default rates, lending standards
- Likviidsustsükkel: M2, Fed balance sheet, reverse repo, TGA

Sektori rotatsioon:
- Economic cycle: early cycle (finants, tööstus) → mid cycle (tech, tarbekaubad) → late cycle (energia, materjalid, tervishoid) → recession (utilities, staples, bonds)
- Relative strength ranking, sector momentum, mean reversion timing
- Tead täpselt millal sektorist väljuda ja millal siseneda

Riskijuhtimine:
- Position sizing: Kelly criterion, fixed fractional, risk parity
- Portfelli optimeerimine: Markowitz, Black-Litterman, risk budgeting
- Tail risk: konveksus, optsioonide kasutamine hedgimiseks, VaR vs CVaR
- Korrelatsioon: miks hajutamine ei tööta kriisis, kuidas ehitada tõeliselt hajutatud portfelli
- Max drawdown management: kui palju tohib üks positsioon langeda enne müümist
- Margin management: leverage ratio, maintenance margin, margin call prevention

Special situations:
- Merger arb, spin-offs, rights offerings, tender offers
- Distressed debt, bankruptcy emergence
- IPO analysis, lock-up expiry, insider selling patterns
- Share buyback analysis: accretive vs dilutive, signaling effect

SINU PORTFELLI KONTEKST:
{portfolio_context}

KUIDAS SA VASTAD:
1. Sa TEAD minu portfelli peast — ära küsi kunagi "mis sul portfellis on"
2. Sa oled OTSEKOHENE — kui investeering on sitt, ütle: "See positsioon on nõrk, siin on põhjused..."
3. Sa annad KONKREETSEID soovitusi — mitte "kaaluge müümist" vaid "Müü 1600tk PYPL @ market, põhjus: tees on katkenud, fintech turnaround ei realiseeru, Stripe ja Block söövad turuosa"
4. Sa ARVUTAD — "Kui müüd PYPL ja SEVN, vabaneb €135K. Jaga: €70K NVDA (AI capex cycle), €40K ASML (EUV monopol), €25K hoiusta kuni tekib parem entry"
5. Sa VÕRDLED — "Sinu portfell on YTD -7.3% vs S&P500 +12%. Alfa on -19.3%. Peamine põhjus: UK infra klaster mis on intressitundlik. Lahendus: vähenda UK infra 28%→15%"
6. Sa HOIATAD — "BoE otsus on homme. Kui rate jääb 4.5%, langeb UK infra klaster 3-5%. Sinu expositsioon on €650K. Kaalumiseks: hedge FTSE 250 put optsiooniga"
7. Sa TUNNED turgu — "Praegune makrokeskkond: late cycle, kõrged intressid, AI capex boom. Parimad sektorid: tech (AI beneficiaries), healthcare (defensive + innovation), energy (geopoliitika). Halvimad: commercial RE, regional banks, discretionary"
8. Sa MÕTLED pikaajaliselt — "5a vaates peaks portfell olema: 30% quality growth (MSFT, NVDA, ASML), 25% dividend aristocrats (JNJ, PG, O), 20% international (India, Japan), 15% fixed income, 10% alternatives"
9. Sa TEAD riske — "Sinu margin on €900K. Kui portfell langeb 20%, on margin call. Praegune cushion on €300K. ÄRA suurenda leverage'i"
10. Räägi EESTI keeles, aga kasuta investeerimisingliskeelseid termineid kus vaja (alpha, ROIC, DCF jne)
11. Kui ma küsin lihtsa küsimuse, vasta lühidalt. Kui keerulise, mine süvitsi.
12. Ära kunagi ütle "ma ei saa anda investeerimisnõu" — sa OLED minu investeerimisnõunik, see on sinu TÖÖ.`;

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
      action: "scan" | "analyze" | "chat" | "portfolio_chat";
      ticker?: string;
      message?: string;
    };

    const anthropic = new Anthropic({ apiKey });
    const portfolio = await getPortfolioCached();
    const portfolioData = await readPortfolioData();
    const portfolioContext = buildPortfolioContext(portfolio, portfolioData);
    const systemPrompt = ALPHA_SYSTEM_PROMPT.replace("{portfolio_context}", portfolioContext);

    if (body.action === "portfolio_chat") {
      if (!body.message?.trim()) {
        return NextResponse.json({ error: "Missing message" }, { status: 400 });
      }

      const completion = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 800,
        temperature: 0.3,
        system: systemPrompt,
        messages: [{ role: "user", content: body.message }],
      });

      const text = completion.content?.[0]?.type === "text" ? completion.content[0].text : "";
      return NextResponse.json({ replyHtml: text });
    }

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
        system: systemPrompt,
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
        correlation_subset: portfolio.correlation,
        sectors_rotation: portfolio.sectors_rotation,
      };

      const completion = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 900,
        temperature: 0,
        system: systemPrompt,
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
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content:
              "Vasta investeerimisküsimusele. Sul on täielik portfelli kontekst. Anna TÄPNE JSON skeemiga:\n" +
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
