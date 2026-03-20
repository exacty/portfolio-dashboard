#!/usr/bin/env python3
"""
Tõmbab dividendid mitmest allikast, salvestab kõik read dividend_source_snapshots,
arvutab ühendatud seeria + kuvamiseks display_avg_yield_pct → dividend_display.
Stdout: API-le sobiv JSON.

Allikad:
  - yfinance (alati)
  - Financial Modeling Prep (kui FMP_API_KEY; US + paljud tickerid)

Ühendamine: sama makse eri allikates (±3 päeva) → mediaan summa → üks tulp graafikus.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Tuple

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from database import (  # noqa: E402
    init_db,
    insert_dividend_source_snapshot,
    upsert_dividend_display,
)
from ticker_dividends import build_payload, yield_stats_from_payments  # noqa: E402


def _median(vals: List[float]) -> float:
    s = sorted(vals)
    n = len(s)
    if not s:
        return 0.0
    mid = n // 2
    if n % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2.0


def merge_payment_clusters(
    labeled: List[Tuple[date, float, str]], window_days: int = 3
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Sama makse eri kuupäevaga (kuni window_days) → üks klaster, summa = mediaan."""
    if not labeled:
        return [], {"clusters": 0, "conflicts": [], "mergeWindowDays": window_days}
    labeled = sorted(labeled, key=lambda x: x[0])
    clusters: List[List[Tuple[date, float, str]]] = []
    bucket: List[Tuple[date, float, str]] = [labeled[0]]
    for i in range(1, len(labeled)):
        d, amt, src = labeled[i]
        anchor_min = min(x[0] for x in bucket)
        if (d - anchor_min).days <= window_days:
            bucket.append((d, amt, src))
        else:
            clusters.append(bucket)
            bucket = [(d, amt, src)]
    clusters.append(bucket)

    out: List[Dict[str, Any]] = []
    conflicts: List[str] = []
    for cl in clusters:
        amounts = [x[1] for x in cl]
        dates_ = [x[0] for x in cl]
        med = _median(amounts)
        lo, hi = min(amounts), max(amounts)
        if hi > 1e-12 and (hi - lo) / hi > 0.05 and len(amounts) > 1:
            conflicts.append(
                f"{min(dates_).isoformat()}: amounts={amounts} providers={[x[2] for x in cl]}"
            )
        rep = min(dates_)
        out.append({"date": rep.isoformat(), "amount": round(med, 8)})
    return out, {"clusters": len(clusters), "conflicts": conflicts, "mergeWindowDays": window_days}


def fetch_fmp_dividend_rows(ticker: str, years: int) -> Dict[str, Any]:
    key = os.environ.get("FMP_API_KEY", "").strip()
    if not key:
        return {"skipped": True, "reason": "no_api_key", "payments": []}

    sym = ticker.upper().strip()
    url = f"https://financialmodelingprep.com/api/v3/historical-price-full/stock_dividend/{sym}?apikey={key}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "portfolio-dashboard/1.0"})
        with urllib.request.urlopen(req, timeout=50) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        data = json.loads(raw)
    except urllib.error.HTTPError as e:
        return {"error": f"http_{e.code}", "payments": []}
    except Exception as e:
        return {"error": str(e)[:400], "payments": []}

    if isinstance(data, list) and data and isinstance(data[0], dict):
        hist = data[0].get("historical")
    elif isinstance(data, dict):
        hist = data.get("historical")
    else:
        hist = None

    if not isinstance(hist, list):
        return {"error": "no_historical_array", "payments": [], "raw": str(data)[:200]}

    years = max(1, min(int(years), 10))
    cutoff = date.today() - timedelta(days=365 * years + 7)
    payments: List[Dict[str, Any]] = []
    for row in hist:
        if not isinstance(row, dict):
            continue
        ds = str(row.get("date", ""))[:10]
        try:
            pd = date.fromisoformat(ds)
        except ValueError:
            continue
        if pd < cutoff:
            continue
        amt = row.get("adjDividend", row.get("dividend"))
        try:
            amt_f = float(amt)
        except (TypeError, ValueError):
            continue
        if amt_f <= 0:
            continue
        payments.append({"date": pd.isoformat(), "amount": amt_f})

    payments.sort(key=lambda x: x["date"])
    return {"payments": payments, "rawHistoricalCount": len(hist)}


def run_pipeline(ticker: str, years: int) -> Dict[str, Any]:
    years = max(1, min(int(years), 10))
    ticker = ticker.strip()
    init_db()

    yf: Dict[str, Any]
    try:
        yf = build_payload(ticker, years)
    except Exception as e:
        yf = {
            "ticker": ticker,
            "payments": [],
            "avgAnnualYieldPct": 0.0,
            "currency": "",
            "yearsInAvg": 0,
            "error": str(e)[:500],
        }

    insert_dividend_source_snapshot(ticker, "yfinance", years, yf)

    fmp = fetch_fmp_dividend_rows(ticker, years)
    insert_dividend_source_snapshot(ticker, "fmp", years, fmp)

    labeled: List[Tuple[date, float, str]] = []
    for p in yf.get("payments") or []:
        try:
            labeled.append((date.fromisoformat(str(p["date"])[:10]), float(p["amount"]), "yfinance"))
        except (ValueError, KeyError, TypeError):
            continue
    for p in fmp.get("payments") or []:
        try:
            labeled.append((date.fromisoformat(str(p["date"])[:10]), float(p["amount"]), "fmp"))
        except (ValueError, KeyError, TypeError):
            continue

    merged, merge_meta = merge_payment_clusters(labeled, window_days=3)
    stats = yield_stats_from_payments(ticker, merged, years)

    yf_n = len(yf.get("payments") or [])
    fmp_n = len(fmp.get("payments") or [])

    analysis: Dict[str, Any] = {
        "sourcesAttempted": ["yfinance", "fmp"],
        "sourcesWithPayments": [
            s
            for s in ("yfinance", "fmp")
            if (s == "yfinance" and yf_n > 0) or (s == "fmp" and fmp_n > 0)
        ],
        "perSource": {
            "yfinance": {
                "paymentCount": yf_n,
                "rawYieldPctHint": yf.get("avgAnnualYieldPct"),
                "error": yf.get("error"),
            },
            "fmp": {
                "paymentCount": fmp_n,
                "skipped": fmp.get("skipped"),
                "reason": fmp.get("reason"),
                "error": fmp.get("error"),
            },
        },
        "merge": merge_meta,
        "chosenSeries": "merged_cluster_median",
        "displayYieldRule": "mean_trailing_calendar_year_totals_from_merged_payments_over_latest_price",
        "yieldComparison": {
            "yfinanceOnlyPct": yf.get("avgAnnualYieldPct"),
            "displayFromMergedPct": stats.get("avgAnnualYieldPct"),
            "deltaVsYfinance": round(
                float(stats.get("avgAnnualYieldPct") or 0) - float(yf.get("avgAnnualYieldPct") or 0),
                3,
            )
            if yf_n
            else None,
        },
    }

    upsert_dividend_display(
        ticker=ticker,
        years=years,
        payments=merged,
        display_avg_yield_pct=float(stats.get("avgAnnualYieldPct") or 0),
        currency=str(stats.get("currency") or ""),
        price_used=float(stats.get("price") or 0),
        years_in_avg=int(stats.get("yearsInAvg") or 0),
        analysis=analysis,
    )

    return {
        "ticker": ticker,
        "years": years,
        "payments": merged,
        "displayAvgAnnualYieldPct": stats.get("avgAnnualYieldPct", 0),
        "avgAnnualYieldPct": stats.get("avgAnnualYieldPct", 0),
        "currency": stats.get("currency", ""),
        "yearsInAvg": stats.get("yearsInAvg", 0),
        "analysis": analysis,
        "sourcesActive": analysis["sourcesWithPayments"],
    }


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: dividend_pipeline.py TICKER [YEARS]"}))
        sys.exit(1)
    tk = sys.argv[1].strip()
    yrs = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    try:
        out = run_pipeline(tk, yrs)
    except Exception as e:
        print(
            json.dumps(
                {
                    "ticker": tk,
                    "payments": [],
                    "displayAvgAnnualYieldPct": 0.0,
                    "avgAnnualYieldPct": 0.0,
                    "error": str(e)[:500],
                },
                ensure_ascii=False,
            )
        )
        sys.exit(1)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
