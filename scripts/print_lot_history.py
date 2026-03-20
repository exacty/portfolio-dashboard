#!/usr/bin/env python3
"""
Print archived closed lots (realized trades) as JSON, newest first.

Usage:
  python3 scripts/print_lot_history.py
  python3 scripts/print_lot_history.py EQNR.OL 50
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from database import init_db, list_position_lot_history  # noqa: E402


def main() -> None:
    init_db()
    ticker: str | None = None
    limit = 200
    if len(sys.argv) > 1 and sys.argv[1].strip():
        a1 = sys.argv[1].strip()
        if a1.isdigit():
            limit = int(a1)
        else:
            ticker = a1
            if len(sys.argv) > 2:
                try:
                    limit = int(sys.argv[2].strip())
                except ValueError:
                    pass
    rows = list_position_lot_history(ticker=ticker, limit=limit)
    print(json.dumps(rows, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
