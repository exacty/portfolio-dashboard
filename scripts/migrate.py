#!/usr/bin/env python3
"""
Create SQLite DB, sync positions from portfolio_data.json (no DELETE — sold lots → position_lot_history),
optionally refresh full snapshot via portfolio_engine.
Usage: python3 scripts/migrate.py [--skip-engine]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Ensure scripts package can import database
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from database import (  # noqa: E402
    DB_PATH,
    init_db,
    save_portfolio_snapshot,
    sync_positions_from_portfolio_data,
    upsert_portfolio_margin_loan_eur,
)


def load_portfolio_json() -> dict:
    path = ROOT / "portfolio_data.json"
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def run_engine_snapshot() -> dict:
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
        raise RuntimeError(proc.stderr or proc.stdout or "portfolio_engine failed")
    return json.loads(proc.stdout)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-engine", action="store_true", help="Only import positions; no full snapshot (db_reader will use fallback until refresh)")
    args = ap.parse_args()

    init_db()
    data = load_portfolio_json()

    stats = sync_positions_from_portfolio_data(data)
    print(
        f"Synced {DB_PATH}: upserted_open={stats['upserted']}, "
        f"archived_closed_lots={stats['closed_lots']}"
    )

    meta = data.get("portfolio_meta") or {}
    ml = meta.get("margin_loan")
    if ml is not None:
        try:
            upsert_portfolio_margin_loan_eur(float(ml))
        except (TypeError, ValueError):
            pass

    if args.skip_engine:
        print("Skipped portfolio_engine; run: python3 scripts/refresh_portfolio.py")
        return

    print("Running portfolio_engine (may take a few minutes)...")
    try:
        snap = run_engine_snapshot()
        save_portfolio_snapshot(snap)
        print("Saved portfolio snapshot to SQLite.")
    except Exception as e:
        print(f"Engine/snapshot failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
