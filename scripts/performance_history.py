#!/usr/bin/env python3
"""
Emit performance history as JSON array for GET /api/performance.
Each element: { "generatedAt", "totalEur"?, "spyClose"? } from portfolio_snapshots payloads.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from database import get_performance_history, init_db  # noqa: E402


def main() -> None:
    init_db()
    lim = 5000
    if len(sys.argv) > 1:
        try:
            lim = max(1, min(int(sys.argv[1]), 50_000))
        except ValueError:
            pass
    arr = get_performance_history(limit=lim)
    print(json.dumps(arr, ensure_ascii=False))


if __name__ == "__main__":
    main()
