#!/usr/bin/env python3
"""Usage: list_ai_analyses.py [TICKER|-] [LIMIT]. JSON array to stdout (oldest first within limit)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from database import get_ai_analyses, init_db  # noqa: E402


def main() -> None:
    init_db()
    ticker_arg = sys.argv[1] if len(sys.argv) > 1 else None
    ticker = None if not ticker_arg or ticker_arg == "-" else ticker_arg.strip()
    try:
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    except ValueError:
        limit = 60
    limit = max(1, min(limit, 200))
    rows = get_ai_analyses(ticker=ticker, limit=limit)
    rows.reverse()
    print(json.dumps(rows, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
