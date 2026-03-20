#!/usr/bin/env python3
"""Read one JSON object from stdin: { ticker?, action, payload }. Append to ai_analyses."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from database import init_db, save_ai_analysis  # noqa: E402


def main() -> int:
    init_db()
    raw = sys.stdin.read()
    if not raw.strip():
        return 0
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return 1
    if not isinstance(data, dict) or not data.get("action"):
        return 1
    ticker = data.get("ticker")
    if ticker is not None:
        ticker = str(ticker).strip() or None
    payload = data.get("payload")
    if not isinstance(payload, dict):
        payload = {}
    save_ai_analysis(ticker, str(data["action"]), payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
