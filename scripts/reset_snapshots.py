#!/usr/bin/env python3
"""
Kustutab kõik portfolio_snapshots read (valed ajaloolised väärtused),
lisab ankrusnapshoti reaalse kõrgpunktiga (drawdown max),
seejärel salvestab ühe värske täissnapshoti portfolio_engine väljundist.

Kasutus:
  python3 scripts/reset_snapshots.py
  python3 scripts/reset_snapshots.py --peak 2270000
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from database import clear_portfolio_snapshots, init_db, save_portfolio_snapshot  # noqa: E402

DEFAULT_PEAK_EUR = 2_270_000.0


def python_for_engine() -> str:
    """Prefer scripts/.venv kui olemas (numpy/yfinance)."""
    for cand in (
        ROOT / "scripts" / ".venv" / "bin" / "python3",
        ROOT / "scripts" / ".venv" / "bin" / "python",
        ROOT / ".venv" / "bin" / "python3",
    ):
        if cand.is_file():
            return str(cand)
    return sys.executable


def run_engine_snapshot() -> dict:
    script = ROOT / "scripts" / "portfolio_engine.py"
    py = python_for_engine()
    proc = subprocess.run(
        [py, str(script)],
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
    ap = argparse.ArgumentParser(description="Reset portfolio_snapshots + seed peak + fresh engine snapshot")
    ap.add_argument(
        "--peak",
        type=float,
        default=DEFAULT_PEAK_EUR,
        help=f"Drawdowni jaoks ajalooline max portfelli väärtus EUR (vaikimisi {DEFAULT_PEAK_EUR:,.0f})",
    )
    args = ap.parse_args()
    peak = float(args.peak)
    if peak <= 0:
        print("--peak peab olema > 0", file=sys.stderr)
        sys.exit(1)

    init_db()

    print("Käivitan portfolio_engine (enne kustutamist, et vältida poolikut DB-d)…")
    snap = run_engine_snapshot()

    clear_portfolio_snapshots()
    print("Kustutatud: portfolio_snapshots")

    save_portfolio_snapshot(
        {
            "generatedAt": "2000-01-01T12:00:00Z",
            "_snapshotMeta": {"syntheticPeakAnchor": True},
            "kpis": {"portfolioTotal": peak},
            "positions": [],
            "macro": {"items": []},
        }
    )
    print(f"Lisatud ankur: kõrgpunkt €{peak:,.0f} (drawdown baas)")

    save_portfolio_snapshot(snap)
    tot = (snap.get("kpis") or {}).get("portfolioTotal")
    print(f"Salvestatud värske snapshot (portfolioTotal≈{tot}). Valmis.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
