#!/usr/bin/env python3
"""
Run portfolio_engine and persist JSON snapshot to SQLite (and engine still writes portfolio_cache.json).
Used by API background refresh after stale cache.
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

from database import save_portfolio_snapshot  # noqa: E402


def main() -> None:
    script = ROOT / "scripts" / "portfolio_engine.py"
    proc = subprocess.run(
        [sys.executable, str(script)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=600,
        encoding="utf-8",
    )
    if proc.returncode != 0:
        print(proc.stderr or proc.stdout, file=sys.stderr)
        sys.exit(proc.returncode)
    data = json.loads(proc.stdout)
    save_portfolio_snapshot(data)

    if os.environ.get("WARM_MARKET_CACHE_AFTER_REFRESH", "").strip().lower() in ("1", "true", "yes"):
        try:
            from warm_market_caches import warm_all_tickers

            warm_all_tickers()
        except Exception as exc:
            print(f"[refresh_portfolio] warm_market_caches failed: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
