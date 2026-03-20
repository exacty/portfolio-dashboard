#!/usr/bin/env python3
"""
Full local refresh: portfolio_engine → SQLite snapshot, then (by default) warm per-ticker market cache.

Env:
  WARM_MARKET_CACHE_AFTER_REFRESH=1   (default here: we set it for this subprocess)
  WARM_MAX_TICKERS, WARM_HISTORY_RANGE  passed through
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    env = os.environ.copy()
    # Opt-out: WARM_MARKET_CACHE_AFTER_REFRESH=0 python3 scripts/full_refresh.py
    if env.get("WARM_MARKET_CACHE_AFTER_REFRESH", "").strip() == "":
        env["WARM_MARKET_CACHE_AFTER_REFRESH"] = "1"
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "refresh_portfolio.py")],
        cwd=str(ROOT),
        env=env,
    )
    return int(proc.returncode or 0)


if __name__ == "__main__":
    raise SystemExit(main())
