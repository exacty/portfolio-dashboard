#!/usr/bin/env python3
"""
Persist ticker history / earnings JSON in SQLite; refresh only when TTL expired or FORCE_MARKET_REFRESH=1.
Next.js APIs call this instead of hitting yfinance on every request.

Env:
  MARKET_CACHE_HISTORY_TTL_SEC   default 14400 (4h)
  MARKET_CACHE_EARNINGS_TTL_SEC default 86400 (24h)
  MARKET_CACHE_DIVIDENDS_TTL_SEC default 86400 (24h)
  FMP_API_KEY                      optional second dividend source (see dividend_pipeline.py)
  FORCE_MARKET_REFRESH=1         bypass cache (still writes fresh row)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from database import (  # noqa: E402
    get_dividend_display,
    get_market_data_cache,
    init_db,
    market_cache_age_sec,
    set_market_data_cache,
)


def _ttl_history() -> float:
    return float(os.environ.get("MARKET_CACHE_HISTORY_TTL_SEC", "14400"))


def _ttl_earnings() -> float:
    return float(os.environ.get("MARKET_CACHE_EARNINGS_TTL_SEC", "86400"))


def _ttl_dividends() -> float:
    return float(os.environ.get("MARKET_CACHE_DIVIDENDS_TTL_SEC", "86400"))


def _force() -> bool:
    return os.environ.get("FORCE_MARKET_REFRESH", "").strip().lower() in ("1", "true", "yes")


def fetch_history(ticker: str, range_: str) -> None:
    key = f"history:{ticker}:{range_}"
    cached = get_market_data_cache(key)
    if cached and not _force():
        payload, updated_at = cached
        if market_cache_age_sec(updated_at) < _ttl_history():
            print(json.dumps(payload, ensure_ascii=False))
            return

    proc = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "portfolio_engine.py"),
            "--history",
            "--ticker",
            ticker,
            "--range",
            range_,
        ],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=300,
        encoding="utf-8",
    )
    raw = (proc.stdout or "").strip()
    if proc.returncode != 0 or not raw:
        if cached:
            print(json.dumps(cached[0], ensure_ascii=False))
            return
        err = (proc.stderr or proc.stdout or "portfolio_engine failed")[:800]
        print(
            json.dumps(
                {"ticker": ticker, "range": range_, "error": err, "candles": []},
                ensure_ascii=False,
            )
        )
        sys.exit(1)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        if cached:
            print(json.dumps(cached[0], ensure_ascii=False))
            return
        print(
            json.dumps(
                {"ticker": ticker, "range": range_, "error": "invalid json from engine", "candles": []},
                ensure_ascii=False,
            )
        )
        sys.exit(1)

    if not isinstance(payload, dict):
        if cached:
            print(json.dumps(cached[0], ensure_ascii=False))
            return
        print(json.dumps({"ticker": ticker, "range": range_, "error": "unexpected payload type", "candles": []}, ensure_ascii=False))
        sys.exit(1)

    if payload.get("candles") is not None:
        set_market_data_cache(key, payload)
    print(json.dumps(payload, ensure_ascii=False))


def fetch_earnings(ticker: str) -> None:
    key = f"earnings:{ticker}"
    cached = get_market_data_cache(key)
    if cached and not _force():
        payload, updated_at = cached
        if market_cache_age_sec(updated_at) < _ttl_earnings():
            print(json.dumps(payload, ensure_ascii=False))
            return

    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "ticker_earnings.py"), ticker],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=120,
        encoding="utf-8",
    )
    raw = (proc.stdout or "").strip()
    if proc.returncode != 0 or not raw:
        if cached:
            print(json.dumps(cached[0], ensure_ascii=False))
            return
        print(json.dumps({"ticker": ticker, "quarterlyEarnings": [], "canslim": {}, "error": (proc.stderr or "ticker_earnings failed")[:500]}, ensure_ascii=False))
        sys.exit(1)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        if cached:
            print(json.dumps(cached[0], ensure_ascii=False))
            return
        print(json.dumps({"ticker": ticker, "quarterlyEarnings": [], "canslim": {}}, ensure_ascii=False))
        sys.exit(1)

    if isinstance(payload, dict):
        set_market_data_cache(key, payload)
    print(json.dumps(payload, ensure_ascii=False))


def _dividend_display_to_api_payload(row: dict) -> dict:
    """dividend_display rida → sama kuju JSON mis pipeline."""
    return {
        "ticker": row["ticker"],
        "years": row["years"],
        "payments": row.get("payments") or [],
        "displayAvgAnnualYieldPct": float(row.get("display_avg_yield_pct") or 0),
        "avgAnnualYieldPct": float(row.get("display_avg_yield_pct") or 0),
        "currency": row.get("currency") or "",
        "yearsInAvg": int(row.get("years_in_avg") or 0),
        "analysis": row.get("analysis") or {},
        "updatedAt": row.get("updated_at"),
    }


def fetch_dividends(ticker: str, years: int = 3) -> None:
    key = f"dividends:{ticker}:{years}"
    legacy_cached = get_market_data_cache(key)

    disp = get_dividend_display(ticker, years)
    if disp and not _force() and market_cache_age_sec(disp["updated_at"]) < _ttl_dividends():
        api = _dividend_display_to_api_payload(disp)
        print(json.dumps(api, ensure_ascii=False))
        return

    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "dividend_pipeline.py"), ticker, str(years)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=180,
        encoding="utf-8",
    )
    raw = (proc.stdout or "").strip()
    if proc.returncode == 0 and raw:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict) and payload.get("payments") is not None:
            set_market_data_cache(key, payload)
            print(json.dumps(payload, ensure_ascii=False))
            return

    # Fallback: ainult yfinance (vanem käitumine)
    proc2 = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "ticker_dividends.py"), ticker, str(years)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=120,
        encoding="utf-8",
    )
    raw2 = (proc2.stdout or "").strip()
    if proc2.returncode != 0 or not raw2:
        if legacy_cached:
            print(json.dumps(legacy_cached[0], ensure_ascii=False))
            return
        err = (proc.stderr or proc2.stderr or "dividend fetch failed")[:500]
        print(
            json.dumps(
                {
                    "ticker": ticker,
                    "payments": [],
                    "displayAvgAnnualYieldPct": 0.0,
                    "avgAnnualYieldPct": 0.0,
                    "error": err,
                },
                ensure_ascii=False,
            )
        )
        sys.exit(1)
    try:
        payload = json.loads(raw2)
    except json.JSONDecodeError:
        if legacy_cached:
            print(json.dumps(legacy_cached[0], ensure_ascii=False))
            return
        print(json.dumps({"ticker": ticker, "payments": [], "avgAnnualYieldPct": 0.0}, ensure_ascii=False))
        sys.exit(1)

    if isinstance(payload, dict):
        if "displayAvgAnnualYieldPct" not in payload and payload.get("avgAnnualYieldPct") is not None:
            payload["displayAvgAnnualYieldPct"] = payload["avgAnnualYieldPct"]
        if payload.get("payments") is not None:
            set_market_data_cache(key, payload)
    print(json.dumps(payload, ensure_ascii=False))


def main() -> None:
    init_db()
    if len(sys.argv) < 2:
        print(
            json.dumps(
                {"error": "usage: market_data_fetch.py history TICKER RANGE | earnings TICKER | dividends TICKER [YEARS]"},
                ensure_ascii=False,
            )
        )
        sys.exit(1)
    mode = sys.argv[1].lower()
    if mode == "history":
        if len(sys.argv) < 4:
            sys.exit(1)
        fetch_history(sys.argv[2], sys.argv[3])
        return
    if mode == "earnings":
        if len(sys.argv) < 3:
            sys.exit(1)
        fetch_earnings(sys.argv[2])
        return
    if mode == "dividends":
        if len(sys.argv) < 3:
            sys.exit(1)
        yrs = int(sys.argv[3]) if len(sys.argv) > 3 else 3
        fetch_dividends(sys.argv[2], yrs)
        return
    sys.exit(1)


if __name__ == "__main__":
    main()
