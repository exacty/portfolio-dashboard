#!/usr/bin/env python3
"""
Pre-fill SQLite market_data_cache + dividend_display for each portfolio ticker (history, earnings, dividends).
Call after refresh_portfolio so modal chart/earnings/dividends load from DB without waiting on Yahoo.

Env:
  WARM_MAX_TICKERS   max tickers to process (0 = all), default 50
  WARM_HISTORY_RANGE default 1y
"""
from __future__ import annotations

import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from database import get_positions, init_db  # noqa: E402


def _max_tickers() -> int:
    raw = os.environ.get("WARM_MAX_TICKERS", "50").strip()
    try:
        n = int(raw)
    except ValueError:
        return 50
    return max(0, n)


def _range() -> str:
    return os.environ.get("WARM_HISTORY_RANGE", "1y").strip() or "1y"


def _warm_one(ticker: str, range_: str) -> tuple[str, bool]:
    py = sys.executable
    fetch = str(ROOT / "scripts" / "market_data_fetch.py")
    ok = True
    for args in (
        [py, fetch, "history", ticker, range_],
        [py, fetch, "earnings", ticker],
        [py, fetch, "dividends", ticker, "3"],
    ):
        proc = subprocess.run(
            args,
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=400,
            encoding="utf-8",
        )
        if proc.returncode != 0:
            ok = False
    return ticker, ok


def warm_all_tickers() -> None:
    init_db()
    rows = get_positions()
    tickers = sorted({str(r["ticker"]).strip() for r in rows if r.get("ticker")})
    cap = _max_tickers()
    # cap == 0 → all tickers; cap > 0 → first N (sorted)
    if cap > 0 and len(tickers) > cap:
        tickers = tickers[:cap]
    if not tickers:
        print("[warm_market_caches] No tickers in positions.", file=sys.stderr)
        return
    r_ = _range()
    print(f"[warm_market_caches] Warming {len(tickers)} tickers, range={r_}", file=sys.stderr)
    workers = min(4, max(1, len(tickers)))
    failed: list[str] = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_warm_one, t, r_): t for t in tickers}
        for fut in as_completed(futs):
            t, ok = fut.result()
            if not ok:
                failed.append(t)
    if failed:
        print(f"[warm_market_caches] Partial failures: {', '.join(failed[:20])}", file=sys.stderr)


def main() -> None:
    warm_all_tickers()


if __name__ == "__main__":
    main()
