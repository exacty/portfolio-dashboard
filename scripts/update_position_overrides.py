#!/usr/bin/env python3
"""
CLI: update target / stop_loss / tees in SQLite positions (used by POST /api/portfolio).

Usage:
  python3 scripts/update_position_overrides.py TICKER '{"target":120,"stop_loss":100,"tees":"..."}'

Mirrors the same fields into portfolio_data.json when that file exists and contains the ticker
(so git-tracked JSON stays aligned for local workflows).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from database import get_position, init_db, update_position_overrides  # noqa: E402


def _mirror_portfolio_json(ticker: str, patch: dict[str, object]) -> None:
    path = ROOT / "portfolio_data.json"
    if not path.is_file():
        return
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return
    positions = data.get("positions")
    if not isinstance(positions, dict) or ticker not in positions:
        return
    pos = positions[ticker]
    if not isinstance(pos, dict):
        return
    if "target" in patch:
        pos["target"] = patch["target"]
    if "stop_loss" in patch:
        pos["stop_loss"] = patch["stop_loss"]
    if "tees" in patch:
        pos["tees"] = patch["tees"]
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    """Exit 0 + JSON on stdout for API parsing; non-zero only for unexpected failures."""
    init_db()
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "missing_ticker"}))
        return 0
    ticker = sys.argv[1].strip() if sys.argv[1] else ""
    if not ticker:
        print(json.dumps({"ok": False, "error": "missing_ticker"}))
        return 0

    try:
        extra = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    except json.JSONDecodeError:
        print(json.dumps({"ok": False, "error": "invalid_json"}))
        return 0

    if not isinstance(extra, dict):
        print(json.dumps({"ok": False, "error": "invalid_payload"}))
        return 0

    kwargs: dict[str, object] = {}
    mirror: dict[str, object] = {}
    if "target" in extra and isinstance(extra["target"], (int, float)):
        kwargs["target"] = float(extra["target"])
        mirror["target"] = kwargs["target"]
    if "stop_loss" in extra and isinstance(extra["stop_loss"], (int, float)):
        kwargs["stop_loss"] = float(extra["stop_loss"])
        mirror["stop_loss"] = kwargs["stop_loss"]
    if "tees" in extra and isinstance(extra["tees"], str):
        kwargs["tees"] = extra["tees"]
        mirror["tees"] = kwargs["tees"]

    if not kwargs:
        print(json.dumps({"ok": False, "error": "no_fields"}))
        return 0

    ok = update_position_overrides(
        ticker,
        target=kwargs["target"] if "target" in kwargs else None,
        stop_loss=kwargs["stop_loss"] if "stop_loss" in kwargs else None,
        tees=kwargs["tees"] if "tees" in kwargs else None,
    )
    if not ok:
        print(json.dumps({"ok": False, "error": "not_found"}))
        return 0

    _mirror_portfolio_json(ticker, mirror)

    row = get_position(ticker)
    out = {
        "ok": True,
        "ticker": ticker,
        "target": float(row["target"] or 0) if row else None,
        "stop_loss": float(row["stop_loss"] or 0) if row else None,
        "tees": (row.get("tees") or "") if row else "",
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
