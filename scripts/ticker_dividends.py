#!/usr/bin/env python3
"""
Per-ticker dividend payments (yfinance) for the last N years + average annual yield vs current price.
Stdout: one JSON object.
Usage: python3 scripts/ticker_dividends.py TICKER [YEARS]
"""
from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))


def _payment_date(idx: Any) -> date:
    if hasattr(idx, "date") and callable(idx.date):
        try:
            d = idx.date()
            if isinstance(d, date):
                return d
        except Exception:
            pass
    s = str(idx)[:10]
    return date.fromisoformat(s)


def _latest_price(ticker: str) -> float:
    t = yf.Ticker(ticker)
    try:
        fi = t.fast_info
        for k in ("last_price", "regular_market_price", "previous_close"):
            v = fi.get(k)
            if v is not None and float(v) > 0:
                return float(v)
    except Exception:
        pass
    try:
        hist = t.history(period="5d")
        if hist is not None and not hist.empty and "Close" in hist.columns:
            v = float(hist["Close"].iloc[-1])
            if v > 0:
                return v
    except Exception:
        pass
    return 0.0


def build_payload(ticker: str, years: int = 3) -> Dict[str, Any]:
    years = max(1, min(int(years), 10))
    t = yf.Ticker(ticker)
    divs = t.dividends
    if divs is None or len(divs) == 0:
        return {
            "ticker": ticker,
            "payments": [],
            "avgAnnualYieldPct": 0.0,
            "currency": "",
            "yearsInAvg": 0,
        }

    cutoff = date.today() - timedelta(days=365 * years + 7)

    payments: List[Dict[str, Any]] = []
    year_sum: Dict[int, float] = {}

    # Oldest → newest for chart left-to-right
    items = list(divs.items())
    items.sort(key=lambda x: _payment_date(x[0]))

    for idx, val in items:
        try:
            amt = float(val)
        except (TypeError, ValueError):
            continue
        if amt <= 0:
            continue
        pd = _payment_date(idx)
        if pd < cutoff:
            continue
        payments.append({"date": pd.isoformat(), "amount": amt})
        year_sum[pd.year] = year_sum.get(pd.year, 0.0) + amt

    sorted_years = sorted(year_sum.keys())
    tail_years = sorted_years[-years:] if len(sorted_years) > years else sorted_years
    yearly_vals = [year_sum[y] for y in tail_years]
    avg_annual = sum(yearly_vals) / len(yearly_vals) if yearly_vals else 0.0

    price = _latest_price(ticker)
    avg_yield = (avg_annual / price * 100.0) if price > 0 and avg_annual > 0 else 0.0

    cur = ""
    try:
        cur = str(yf.Ticker(ticker).fast_info.get("currency") or "")
    except Exception:
        pass

    return {
        "ticker": ticker,
        "payments": payments,
        "avgAnnualYieldPct": round(avg_yield, 2),
        "currency": cur,
        "yearsInAvg": len(yearly_vals),
    }


def yield_stats_from_payments(
    ticker: str,
    payments: List[Dict[str, Any]],
    years: int = 3,
) -> Dict[str, Any]:
    """
    Sama aastakeskmise yieldi loogika kui build_payload, aga etteantud maksete listiga
    (ühhendatud mitmest allikast). Maksete kuupäevad ISO stringid.
    """
    years = max(1, min(int(years), 10))
    year_sum: Dict[int, float] = {}
    for p in payments:
        try:
            d = str(p.get("date", ""))[:10]
            pd = date.fromisoformat(d)
            amt = float(p.get("amount", 0))
        except (TypeError, ValueError):
            continue
        if amt <= 0:
            continue
        year_sum[pd.year] = year_sum.get(pd.year, 0.0) + amt

    sorted_years = sorted(year_sum.keys())
    tail_years = sorted_years[-years:] if len(sorted_years) > years else sorted_years
    yearly_vals = [year_sum[y] for y in tail_years]
    avg_annual = sum(yearly_vals) / len(yearly_vals) if yearly_vals else 0.0
    price = _latest_price(ticker)
    avg_yield = (avg_annual / price * 100.0) if price > 0 and avg_annual > 0 else 0.0
    cur = ""
    try:
        cur = str(yf.Ticker(ticker).fast_info.get("currency") or "")
    except Exception:
        pass
    return {
        "avgAnnualYieldPct": round(avg_yield, 2),
        "currency": cur,
        "yearsInAvg": len(yearly_vals),
        "price": price,
        "yearlyTotals": {str(y): round(year_sum[y], 6) for y in tail_years},
    }


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing ticker", "payments": [], "avgAnnualYieldPct": 0.0}))
        sys.exit(1)
    tk = sys.argv[1].strip()
    yrs = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    try:
        out = build_payload(tk, yrs)
    except Exception as e:
        print(json.dumps({"ticker": tk, "payments": [], "avgAnnualYieldPct": 0.0, "error": str(e)[:500]}))
        sys.exit(1)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
