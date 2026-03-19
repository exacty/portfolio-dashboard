import { NextResponse } from "next/server";
import { parseStringPromise } from "xml2js";
import fs from "node:fs/promises";
import path from "node:path";

const IBKR_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
const WAIT_MS = 7000; // 5–10 sec between SendRequest and GetStatement

// IBKR symbol → yfinance ticker mapping (European stocks need suffixes)
const TICKER_MAP: Record<string, string> = {
  EQNR: "EQNR.OL",
  AKRBP: "AKRBP.OL",
  "NOVO B": "NOVO-B.CO",
  "NOVO-B": "NOVO-B.CO",
  NOVOB: "NOVO-B.CO",
  UPM: "UPM.HE",
  "A8X": "A8X.F",
  INPP: "INPP.L",
  SEQI: "SEQI.L",
  HICL: "HICL.L",
  TRIG: "TRIG.L",
  LGEN: "LGEN.L",
  SUPR: "SUPR.L",
  IS04: "IS04.L",
};

function mapIbkrToYf(symbol: string): string | null {
  const normalized = symbol.trim().toUpperCase();
  const noSpace = normalized.replace(/\s+/g, "");
  const withDash = normalized.replace(/\s+/g, "-");
  return (
    TICKER_MAP[normalized] ??
    TICKER_MAP[symbol.trim()] ??
    TICKER_MAP[noSpace] ??
    TICKER_MAP[withDash] ??
    null
  );
}

type IbkrPosition = {
  symbol: string;
  currency: string;
  quantity: number;
  avgPrice: number;
  marketPrice?: number;
  marketValue?: number;
  unrealizedPnl?: number;
};

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

function getKeyIgnoreCase(obj: Record<string, unknown>, ...keys: string[]): unknown {
  const lower = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of keys) {
    const val = lower[key.toLowerCase()];
    if (val !== undefined) return val;
  }
  return undefined;
}

async function parseFlexXml(xml: string): Promise<IbkrPosition[]> {
  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    ignoreAttrs: true,
    mergeAttrs: true,
    tagNameProcessors: [(name) => name.toLowerCase()],
  });

  const positions: IbkrPosition[] = [];

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
    if (o.openpositions) {
      walk(o.openpositions);
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
    const assetCategory = extractText(getKeyIgnoreCase(p, "assetcategory", "assetCategory")).toLowerCase();
    if (assetCategory && !["stock", "stk", "equity", ""].includes(assetCategory)) return null;

    const symbol = extractText(getKeyIgnoreCase(p, "symbol"));
    if (!symbol) return null;

    const qty = extractNumber(getKeyIgnoreCase(p, "quantity", "position"));
    if (qty <= 0) return null;

    const currency = extractText(getKeyIgnoreCase(p, "currency")) || "USD";
    const avgPrice =
      extractNumber(getKeyIgnoreCase(p, "costbasisprice", "costBasisPrice", "costbasis")) ||
      extractNumber(getKeyIgnoreCase(p, "openprice", "openPrice", "averagecost", "averageCost", "avgprice")) ||
      0;
    const marketPrice =
      extractNumber(getKeyIgnoreCase(p, "markprice", "markPrice")) || avgPrice;
    const marketValue = extractNumber(getKeyIgnoreCase(p, "positionvalue", "positionValue", "marketvalue"));
    const unrealizedPnl = extractNumber(getKeyIgnoreCase(p, "fifopnlunrealized", "fifoPnlUnrealized", "unrealizedpnl"));

    return {
      symbol,
      currency,
      quantity: Math.abs(qty),
      avgPrice: avgPrice || marketPrice,
      marketPrice: marketPrice || undefined,
      marketValue: marketValue || undefined,
      unrealizedPnl: unrealizedPnl || undefined,
    };
  }

  walk(parsed);
  return positions;
}

function resolveYfTicker(ibkrSymbol: string): string {
  const mapped = mapIbkrToYf(ibkrSymbol);
  if (mapped) return mapped;
  return ibkrSymbol.trim().toUpperCase().replace(/\s+/g, "");
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
    // Step 1: SendRequest
    const sendUrl = `${IBKR_BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`;
    const sendRes = await fetch(sendUrl, {
      headers: { "User-Agent": "PortfolioDashboard/1.0" },
    });
    const sendXml = await sendRes.text();

    const sendParsed = await parseStringPromise(sendXml, {
      explicitArray: false,
      ignoreAttrs: true,
      tagNameProcessors: [(n) => n.toLowerCase()],
    });
    const resp = (sendParsed as Record<string, unknown>).flexstatementresponse as Record<string, unknown> | undefined;
    const status = extractText(resp?.status);
    const refCode = extractText(resp?.referencecode);

    if (status.toLowerCase() !== "success" || !refCode) {
      const errCode = extractText(resp?.errorcode);
      const errMsg = extractText(resp?.errormessage);
      console.error("[ibkr-sync] SendRequest failed:", status, errCode, errMsg);
      return NextResponse.json(
        { error: errMsg || status || "SendRequest failed", synced: false },
        { status: 502 }
      );
    }

    // Step 2: Wait 5–10 seconds
    await new Promise((r) => setTimeout(r, WAIT_MS));

    // Step 3: GetStatement
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

    const ibkrPositions = await parseFlexXml(statementXml);
    if (ibkrPositions.length === 0) {
      return NextResponse.json({
        synced: true,
        positions: [],
        changes: [],
        message: "No positions found in Flex statement",
      });
    }

    const dataPath = path.join(process.cwd(), "portfolio_data.json");
    let existing: { positions: Record<string, { avg_price: number; shares: number; currency: string; tees?: string; target?: number; stop_loss?: number }>; fx_rates?: Record<string, number> } = {
      positions: {},
    };
    try {
      const raw = await fs.readFile(dataPath, "utf-8");
      existing = JSON.parse(raw) as typeof existing;
    } catch {
      existing = { positions: {} };
    }

    const changes: string[] = [];
    const updatedFromIbkr: Record<string, { avg_price: number; shares: number; currency: string; tees?: string; target?: number; stop_loss?: number }> = {};
    const gbxTickers = ["INPP.L", "SEQI.L", "HICL.L", "SUPR.L", "TRIG.L", "LGEN.L", "IS04.L"];

    for (const p of ibkrPositions) {
      const yfTicker = resolveYfTicker(p.symbol);
      const prev = existing.positions[yfTicker];

      const avgPrice = p.avgPrice;
      const currency =
        p.currency === "GBP" && gbxTickers.includes(yfTicker)
          ? "GBX"
          : p.currency;

      const entry = {
        avg_price: avgPrice,
        shares: p.quantity,
        currency,
        tees: prev?.tees ?? "",
        target: prev?.target ?? 0,
        stop_loss: prev?.stop_loss ?? 0,
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

    const mergedPositions = { ...existing.positions };
    for (const [tk, pos] of Object.entries(updatedFromIbkr)) {
      mergedPositions[tk] = pos;
    }

    const output = {
      positions: mergedPositions,
      fx_rates: existing.fx_rates ?? {
        NOK: 0.087,
        DKK: 0.134,
        GBP: 1.17,
        USD: 0.92,
        EUR: 1,
      },
    };

    await fs.writeFile(dataPath, JSON.stringify(output, null, 2), "utf-8");

    return NextResponse.json({
      synced: true,
      positions: Object.keys(updatedFromIbkr),
      changes,
      message: `Synced ${Object.keys(updatedFromIbkr).length} positions`,
    });
  } catch (err) {
    console.error("[ibkr-sync] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed", synced: false },
      { status: 500 }
    );
  }
}
