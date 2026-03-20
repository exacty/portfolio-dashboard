import { NextResponse } from "next/server";
import { parseStringPromise } from "xml2js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const IBKR_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
const WAIT_MS = 7000;

// IBKR symbol → yfinance ticker (exact mapping from user)
const TICKER_MAP: Record<string, string> = {
  EQNR: "EQNR.OL",
  AKRBP: "AKRBP.OL",
  NOVOBc: "NOVO-B.CO",
  A8X: "A8X.F",
  IS04: "IS04.L",
  UPM: "UPM.HE",
  HICL: "HICL.L",
  INPP: "INPP.L",
  LGEN: "LGEN.L",
  SEQI: "SEQI.L",
  SUPR: "SUPR.L",
  TRIG: "TRIG.L",
  ADBE: "ADBE",
  AGNC: "AGNC",
  ARCC: "ARCC",
  FIG: "FIG",
  IFN: "IFN",
  IIPR: "IIPR",
  LEG: "LEG",
  MSFT: "MSFT",
  O: "O",
  PYPL: "PYPL",
  SEVN: "SEVN",
  TIRXF: "TIRXF",
  TLT: "TLT",
  VICI: "VICI",
  VZ: "VZ",
  OXY: "OXY",
};

type IbkrPosition = {
  symbol: string;
  currency: string;
  quantity: number;
  avgPrice: number;
  marketPrice: number;
};

type IbkrFxRates = Record<string, number>;

function extractNumber(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  const s = String(val).replace(/,/g, "").trim();
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

function extractText(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val.trim();
  if (Array.isArray(val) && val[0] != null) return extractText(val[0]);
  return String(val).trim();
}

function resolveYfTicker(ibkrSymbol: string): string {
  const mapped = TICKER_MAP[ibkrSymbol.trim()];
  if (mapped) return mapped;
  // Bond: "OXY 4 5/8 06/15/45" → OXY
  if (ibkrSymbol.includes(" ")) {
    const first = ibkrSymbol.trim().split(/\s+/)[0];
    return TICKER_MAP[first] ?? first;
  }
  return ibkrSymbol.trim().toUpperCase();
}

function collectNetLiquidationNodes(obj: unknown): Array<{ value: number; currency: string }> {
  const out: Array<{ value: number; currency: string }> = [];
  const visit = (x: unknown): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const it of x) visit(it);
      return;
    }
    const o = x as Record<string, unknown>;

    // Common IBKR Flex shape: attributes merged onto the current node
    // like { currency: "EUR", netLiquidation: "123456.78" }.
    const ownValue = extractNumber(o.netliquidation);
    if (ownValue > 0) {
      const ownCurrency =
        extractText(o.currency ?? o.basecurrency ?? o.reportcurrency).toUpperCase() || "EUR";
      out.push({ value: ownValue, currency: ownCurrency });
    }

    const raw = o.netliquidation;
    const items =
      raw != null && typeof raw === "object" ? (Array.isArray(raw) ? raw : [raw]) : [];
    for (const item of items) {
      const p = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const value = extractNumber(p.value ?? item);
      const currency =
        extractText(p.currency ?? p.basecurrency ?? p.reportcurrency ?? o.currency).toUpperCase() || "EUR";
      if (value > 0) out.push({ value, currency });
    }
    for (const v of Object.values(o)) visit(v);
  };
  visit(obj);
  return out;
}

function pickNetLiquidation(
  entries: Array<{ value: number; currency: string }>
): { value: number; currency: string } | undefined {
  if (!entries.length) return undefined;
  const eur = entries.find((e) => e.currency === "EUR" || e.currency === "BASE_SUMMARY");
  return eur ?? entries[entries.length - 1];
}

function toEur(amount: number, currency: string, fx: IbkrFxRates & Record<string, number>): number | null {
  const cur = currency.toUpperCase();
  if (cur === "EUR") return amount;
  const r = fx[cur];
  if (typeof r === "number" && r > 0) return amount * r;
  return null;
}

function sumPositionsGrossEur(
  positions: IbkrPosition[],
  fx: IbkrFxRates & Record<string, number>
): number {
  let s = 0;
  for (const p of positions) {
    const mv = p.quantity * p.marketPrice;
    const eur = toEur(mv, p.currency, fx);
    if (eur != null && eur > 0) s += eur;
  }
  return s;
}

async function parseFlexXml(xml: string): Promise<{
  positions: IbkrPosition[];
  fxRates: IbkrFxRates;
  netLiquidationCandidates: Array<{ value: number; currency: string }>;
}> {
  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    ignoreAttrs: false,
    mergeAttrs: true,
    tagNameProcessors: [(n) => n.toLowerCase()],
  });

  const positions: IbkrPosition[] = [];
  const fxRates: IbkrFxRates = { EUR: 1 };

  const walk = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;

    if (o.openposition) {
      const items = Array.isArray(o.openposition) ? o.openposition : [o.openposition];
      for (const item of items) {
        const pos = parsePosition(item);
        if (pos) positions.push(pos);
      }
      return;
    }
    if (o.conversionrate) {
      const items = Array.isArray(o.conversionrate) ? o.conversionrate : [o.conversionrate];
      for (const item of items) {
        const rate = parseConversionRate(item);
        if (rate) fxRates[rate.from] = rate.rate;
      }
      return;
    }
    if (o.openpositions) {
      walk(o.openpositions);
      return;
    }
    if (o.conversionrates) {
      walk(o.conversionrates);
      return;
    }
    if (o.flexstatement) {
      walk(o.flexstatement);
      return;
    }
    if (o.flexstatements) {
      walk(o.flexstatements);
      return;
    }
    if (o.flexqueryresponse) {
      walk(o.flexqueryresponse);
      return;
    }

    for (const v of Object.values(o)) {
      if (v && typeof v === "object") walk(v);
    }
  };

  function parsePosition(item: unknown): IbkrPosition | null {
    if (!item || typeof item !== "object") return null;
    const p = item as Record<string, unknown>;
    const assetCategory = extractText(p.assetcategory ?? p.assetCategory).toLowerCase();
    if (assetCategory && !["stk", "bond"].includes(assetCategory)) return null;

    const symbol = extractText(p.symbol);
    if (!symbol) return null;

    const qty = extractNumber(p.position);
    if (qty <= 0) return null;

    const currency = extractText(p.currency) || "USD";
    const avgPrice =
      extractNumber(p.costbasisprice ?? p.costBasisPrice) ||
      extractNumber(p.openprice ?? p.openPrice) ||
      0;
    const marketPrice = extractNumber(p.markprice ?? p.markPrice) || avgPrice;

    return {
      symbol,
      currency,
      quantity: Math.abs(qty),
      avgPrice: avgPrice || marketPrice,
      marketPrice: marketPrice || avgPrice,
    };
  }

  function parseConversionRate(item: unknown): { from: string; rate: number } | null {
    if (!item || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    const from = extractText(r.fromcurrency ?? r.fromCurrency);
    const to = extractText(r.tocurrency ?? r.toCurrency);
    const rate = extractNumber(r.rate);
    if (from && to?.toUpperCase() === "EUR" && rate > 0) return { from, rate };
    return null;
  }

  walk(parsed);
  const netLiquidationCandidates = collectNetLiquidationNodes(parsed);
  return { positions, fxRates, netLiquidationCandidates };
}

export async function GET() {
  const token = process.env.IBKR_FLEX_TOKEN;
  const queryId = process.env.IBKR_FLEX_QUERY_ID;

  if (!token || !queryId) {
    return NextResponse.json(
      { error: "IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID must be set in environment" },
      { status: 500 }
    );
  }

  try {
    const sendUrl = `${IBKR_BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`;
    const sendRes = await fetch(sendUrl, {
      headers: { "User-Agent": "PortfolioDashboard/1.0" },
    });
    const sendXml = await sendRes.text();

    const sendParsed = await parseStringPromise(sendXml, {
      explicitArray: false,
      mergeAttrs: true,
      tagNameProcessors: [(n) => n.toLowerCase()],
    });
    const resp = (sendParsed as Record<string, unknown>).flexstatementresponse as Record<string, unknown> | undefined;
    const status = extractText(resp?.status);
    const refCode = extractText(resp?.referencecode);

    if (status.toLowerCase() !== "success" || !refCode) {
      const errMsg = extractText(resp?.errormessage);
      console.error("[ibkr-sync] SendRequest failed:", status, errMsg);
      return NextResponse.json(
        { error: errMsg || status || "SendRequest failed", synced: false },
        { status: 502 }
      );
    }

    await new Promise((r) => setTimeout(r, WAIT_MS));

    const getUrl = `${IBKR_BASE}/GetStatement?t=${encodeURIComponent(token)}&q=${encodeURIComponent(refCode)}&v=3`;
    const getRes = await fetch(getUrl, {
      headers: { "User-Agent": "PortfolioDashboard/1.0" },
    });
    const statementXml = await getRes.text();

    if (!getRes.ok) {
      console.error("[ibkr-sync] GetStatement HTTP error:", getRes.status);
      return NextResponse.json(
        { error: `GetStatement failed: ${getRes.status}`, synced: false },
        { status: 502 }
      );
    }

    const { positions: ibkrPositions, fxRates: ibkrFxRates, netLiquidationCandidates } =
      await parseFlexXml(statementXml);

    const dataPath = path.join(process.cwd(), "portfolio_data.json");
    let existing: {
      positions: Record<string, { avg_price: number; shares: number; currency: string; tees?: string; target?: number; stop_loss?: number; source?: string }>;
      fx_rates?: Record<string, number>;
      portfolio_meta?: { margin_loan?: number; [key: string]: unknown };
    } = { positions: {} };
    try {
      const raw = await fs.readFile(dataPath, "utf-8");
      existing = JSON.parse(raw) as typeof existing;
    } catch {
      existing = { positions: {} };
    }

    const ibkrYfTickers = new Set(ibkrPositions.map((p) => resolveYfTicker(p.symbol)));

    const changes: string[] = [];
    const updatedFromIbkr: Record<string, { avg_price: number; shares: number; currency: string; tees?: string; target?: number; stop_loss?: number; source: string }> = {};

    for (const p of ibkrPositions) {
      const yfTicker = resolveYfTicker(p.symbol);
      const prev = existing.positions[yfTicker];

      const avgPrice = p.avgPrice;
      const currency = p.currency;

      const entry = {
        avg_price: avgPrice,
        shares: p.quantity,
        currency,
        tees: prev?.tees ?? "",
        target: prev?.target ?? 0,
        stop_loss: prev?.stop_loss ?? 0,
        source: "ibkr" as const,
      };

      if (prev) {
        if (prev.shares !== p.quantity || Math.abs(prev.avg_price - avgPrice) > 0.001) {
          changes.push(`${yfTicker}: shares ${prev.shares}→${p.quantity}, avg ${prev.avg_price.toFixed(2)}→${avgPrice.toFixed(2)}`);
        }
      } else {
        changes.push(`${yfTicker}: NEW position (${p.quantity} @ ${avgPrice.toFixed(2)} ${currency})`);
      }
      updatedFromIbkr[yfTicker] = entry;
    }

    const mergedPositions: Record<string, { avg_price: number; shares: number; currency: string; tees?: string; target?: number; stop_loss?: number; source?: string }> = {};
    for (const [tk, pos] of Object.entries(updatedFromIbkr)) {
      mergedPositions[tk] = pos;
    }
    for (const [tk, pos] of Object.entries(existing.positions)) {
      if (!ibkrYfTickers.has(tk)) {
        if (pos.source === "manual") {
          mergedPositions[tk] = pos;
        } else {
          changes.push(`Eemaldatud: ${tk} (pole enam IBKR-is)`);
        }
      }
    }

    const defaultFx = {
      NOK: 0.090839,
      DKK: 0.13382,
      GBP: 1.1577,
      USD: 0.87325,
      EUR: 1,
    };
    const fx_rates = {
      ...defaultFx,
      ...(Object.keys(ibkrFxRates).length > 0 ? ibkrFxRates : existing.fx_rates ?? {}),
    };

    const nlPick = pickNetLiquidation(netLiquidationCandidates);
    const netLiqEur =
      nlPick != null ? toEur(nlPick.value, nlPick.currency, fx_rates as IbkrFxRates & Record<string, number>) : null;
    const positionsGrossEur = sumPositionsGrossEur(ibkrPositions, fx_rates as IbkrFxRates & Record<string, number>);
    const marginFromIbkr =
      netLiqEur != null && netLiqEur > 0 && positionsGrossEur > 0
        ? Math.max(0, Math.round(positionsGrossEur - netLiqEur))
        : undefined;

    const portfolio_meta = {
      ...(existing.portfolio_meta ?? {}),
      ...(marginFromIbkr !== undefined ? { margin_loan: marginFromIbkr } : {}),
    };

    const output = { positions: mergedPositions, fx_rates, portfolio_meta };

    await fs.writeFile(dataPath, JSON.stringify(output, null, 2), "utf-8");

    /** Dashboard loeb positsioonid SQLite’ist; ilma selle sammuta jäävad müüdud tickerid (nt EQNR) DB-sse. */
    let sqliteSynced = false;
    try {
      const migrateScript = path.join(process.cwd(), "scripts", "migrate.py");
      await execFileAsync("python3", [migrateScript, "--skip-engine"], {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      });
      sqliteSynced = true;
    } catch (e) {
      console.error("[ibkr-sync] SQLite sync (migrate.py --skip-engine) failed:", e);
      changes.push(
        "HOIATUS: SQLite positsioonid ei uuendunud — käivita käsitsi: python3 scripts/migrate.py --skip-engine"
      );
    }

    return NextResponse.json({
      synced: true,
      sqliteSynced,
      positions: Object.keys(updatedFromIbkr),
      changes,
      fxRates: fx_rates,
      marginLoan: marginFromIbkr ?? existing.portfolio_meta?.margin_loan ?? null,
      ibkrNetLiquidationEur: netLiqEur,
      ibkrPositionsGrossEur: positionsGrossEur > 0 ? Math.round(positionsGrossEur) : null,
      message: `Synced ${Object.keys(updatedFromIbkr).length} positions${sqliteSynced ? " (+ SQLite)" : ""}${
        marginFromIbkr !== undefined ? " (+ margin)" : ""
      }`,
    });
  } catch (err) {
    console.error("[ibkr-sync] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed", synced: false },
      { status: 500 }
    );
  }
}
