#!/usr/bin/env python3
"""
Emit latest portfolio JSON from SQLite (<1s). Same top-level shape as portfolio_engine.build_portfolio_json.
Falls back to minimal JSON if no snapshot exists.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from database import (  # noqa: E402
    compute_drawdown_pct_from_snapshots,
    compute_realized_pnl_eur_from_trades,
    get_fx_rates,
    get_latest_portfolio_snapshot,
    get_portfolio_margin_loan_eur,
    get_positions,
)

SECTOR_MAP = {
    "EQNR.OL": "Energia",
    "AKRBP.OL": "Energia",
    "OXY": "Energia",
    "VZ": "Telecom",
    "O": "REIT",
    "VICI": "REIT",
    "IIPR": "REIT",
    "AGNC": "REIT",
    "SEVN": "REIT",
    "INPP.L": "UK Infra",
    "SEQI.L": "UK Infra",
    "HICL.L": "UK Infra",
    "TRIG.L": "UK Infra",
    "SUPR.L": "UK Infra",
    "LGEN.L": "UK Finants",
    "ARCC": "BDC/Finants",
    "MSFT": "Tehnoloogia",
    "ADBE": "Tehnoloogia",
    "FIG": "Tehnoloogia",
    "PYPL": "Fintech",
    "NOVO-B.CO": "Tervishoid",
    "TLT": "Võlakirjad",
    "IS04.L": "Võlakirjad",
    "UPM.HE": "Materjalid",
    "A8X.F": "Tarbekaubad",
    "IFN": "Arenevad turud",
    "LEG": "Tööstus",
    "TIRXF": "Spekulatiivne",
}
DEFAULT_SECTOR = "Muu"


def _load_portfolio_meta() -> dict:
    path = ROOT / "portfolio_data.json"
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("portfolio_meta") or {}
    except Exception:
        return {}


def _safe_float(v: Any, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _to_eur(price: float, currency: str, fx_rates: dict[str, float]) -> float:
    cur = (currency or "EUR").upper()
    if cur == "EUR":
        return price
    if cur == "GBX":
        return (price / 100.0) * _safe_float(fx_rates.get("GBP"), 0.0)
    return price * _safe_float(fx_rates.get(cur), 0.0)


def _build_sector_allocation(positions: list[dict], total_eur: float) -> list[dict]:
    if total_eur <= 0:
        return []
    sector_eur: dict[str, float] = {}
    for p in positions:
        sector = SECTOR_MAP.get(str(p.get("tk") or ""), DEFAULT_SECTOR)
        sector_eur[sector] = sector_eur.get(sector, 0.0) + _safe_float(p.get("eur"), 0.0)
    return sorted(
        [{"name": name, "pct": round(val / total_eur * 100.0, 1), "color": ""} for name, val in sector_eur.items()],
        key=lambda x: x["pct"],
        reverse=True,
    )


def _attention_metrics(positions: list[dict]) -> tuple[int, int, int, int, int, str]:
    attention_sell = sum(1 for p in positions if p.get("flagged"))
    attention_rsi = sum(1 for p in positions if int(_safe_float(p.get("rsi"), 50)) > 75 or int(_safe_float(p.get("rsi"), 50)) < 25)
    attention_target = sum(
        1 for p in positions if _safe_float(p.get("target")) > 0 and _safe_float(p.get("price")) >= _safe_float(p.get("target"))
    )
    attention_stop = sum(
        1 for p in positions if _safe_float(p.get("stop_loss")) > 0 and _safe_float(p.get("price")) <= _safe_float(p.get("stop_loss"))
    )

    tickers: set[str] = set()
    for p in positions:
        tk = str(p.get("tk") or "")
        if not tk:
            continue
        rsi = int(_safe_float(p.get("rsi"), 50))
        if p.get("flagged") or rsi > 75 or rsi < 25:
            tickers.add(tk)
        if _safe_float(p.get("target")) > 0 and _safe_float(p.get("price")) >= _safe_float(p.get("target")):
            tickers.add(tk)
        if _safe_float(p.get("stop_loss")) > 0 and _safe_float(p.get("price")) <= _safe_float(p.get("stop_loss")):
            tickers.add(tk)

    summary_bits: list[str] = []
    for p in positions:
        if p.get("flagged"):
            summary_bits.append(f"{p.get('tk')} müü")
    for p in positions:
        rsi = int(_safe_float(p.get("rsi"), 50))
        if (rsi > 75 or rsi < 25) and not p.get("flagged"):
            summary_bits.append(f"{p.get('tk')} RSI")
    for p in positions:
        if _safe_float(p.get("target")) > 0 and _safe_float(p.get("price")) >= _safe_float(p.get("target")):
            summary_bits.append(f"{p.get('tk')} target")
    for p in positions:
        bit = f"{p.get('tk')} müü"
        if _safe_float(p.get("stop_loss")) > 0 and _safe_float(p.get("price")) <= _safe_float(p.get("stop_loss")) and bit not in summary_bits:
            summary_bits.append(f"{p.get('tk')} stop")
    already = {str(x).split()[0] for x in summary_bits}
    for p in positions:
        tk = str(p.get("tk") or "")
        sigs = p.get("sigs") or []
        if "Val?" in sigs and int(_safe_float(p.get("score"), 50)) < 52 and tk and tk not in already:
            summary_bits.append(f"{tk} ülevaata")
            already.add(tk)

    return len(tickers), attention_sell, attention_rsi, attention_target, attention_stop, " · ".join(summary_bits[:10])


def _rebuild_kpis(positions: list[dict], base_kpis: dict | None = None) -> dict:
    base = dict(base_kpis or {})
    meta = _load_portfolio_meta()
    total_eur = sum(_safe_float(p.get("eur")) for p in positions)
    cost_basis_positions_eur = sum(_safe_float(p.get("avg_eur")) * _safe_float(p.get("shares")) for p in positions)
    unrealized_pnl = total_eur - cost_basis_positions_eur
    unrealized_pct = (unrealized_pnl / cost_basis_positions_eur * 100.0) if cost_basis_positions_eur > 0 else 0.0
    day_chg_eur = sum(_safe_float(p.get("eur_price")) * _safe_float(p.get("shares")) * (_safe_float(p.get("chg")) / 100.0) for p in positions)
    day_chg_pct = (day_chg_eur / total_eur * 100.0) if total_eur > 0 else 0.0
    div_yearly_eur = sum(_safe_float(p.get("eur")) * (_safe_float(p.get("div")) / 100.0) for p in positions)
    div_yield = (div_yearly_eur / total_eur * 100.0) if total_eur > 0 else 0.0
    sectors_allocation = _build_sector_allocation(positions, total_eur)
    concentration = max((_safe_float(s.get("pct")) for s in sectors_allocation), default=0.0)
    attention_count, attention_sell, attention_rsi, attention_target, attention_stop, attention_summary = _attention_metrics(positions)
    account_total = _safe_float(base.get("portfolioTotal")) or _safe_float(meta.get("market_value_eur"))
    account_unrealized = _safe_float(base.get("unrealizedPnl")) if base.get("unrealizedPnl") is not None else _safe_float(meta.get("unrealized_pnl_eur"))
    account_day_eur = _safe_float(base.get("dayChgEur")) if base.get("dayChgEur") is not None else _safe_float(meta.get("day_pnl_eur"))
    account_day_pct = _safe_float(base.get("dayChgPct")) if base.get("dayChgPct") is not None else _safe_float(meta.get("day_pnl_pct"))
    margin_loan = _safe_float(base.get("marginLoan")) or _safe_float(meta.get("margin_loan")) or get_portfolio_margin_loan_eur()
    net_liquidation = _safe_float(meta.get("net_liquidation")) or _safe_float(base.get("netEquity"))
    display_total = account_total if account_total > 0 else total_eur
    use_account_unrealized = base.get("unrealizedPnl") is not None or meta.get("unrealized_pnl_eur") is not None
    display_unrealized = account_unrealized if use_account_unrealized else unrealized_pnl
    cost_basis_total = (display_total - display_unrealized) if use_account_unrealized else cost_basis_positions_eur
    unrealized_pct = (display_unrealized / cost_basis_total * 100.0) if cost_basis_total > 0 else 0.0
    if net_liquidation <= 0:
        net_equity = display_total - margin_loan if margin_loan > 0 else display_total
    else:
        net_equity = net_liquidation
    leverage_ratio = (display_total / net_equity) if net_equity > 1e-6 and (margin_loan > 0 or net_liquidation > 0) else None
    fx_rates = get_fx_rates()
    try:
        realized_pnl = float(compute_realized_pnl_eur_from_trades(fx_rates))
    except Exception:
        realized_pnl = _safe_float(base.get("realizedPnl"))
    try:
        drawdown = compute_drawdown_pct_from_snapshots(display_total) if display_total > 0 else None
    except Exception:
        drawdown = base.get("portfolioDrawdownPct")

    return {
        **base,
        "portfolioTotal": round(display_total, 0),
        "dayChgEur": round(account_day_eur if (base.get("dayChgEur") is not None or meta.get("day_pnl_eur") is not None) else day_chg_eur, 0),
        "dayChgPct": round(account_day_pct if (base.get("dayChgPct") is not None or meta.get("day_pnl_pct") is not None) else day_chg_pct, 1),
        "unrealizedPnl": round(display_unrealized, 0),
        "unrealizedPnlPct": round(unrealized_pct, 1),
        "realizedPnl": round(realized_pnl, 0),
        "costBasisEur": round(cost_basis_total, 0),
        "costBasisPositionsEur": round(cost_basis_positions_eur, 0),
        "cashInvestedEur": round(cost_basis_positions_eur, 0) if cost_basis_positions_eur > 0 else None,
        "marginUsedEur": round(base.get("marginUsedEur"), 0) if _safe_float(base.get("marginUsedEur")) > 0 else None,
        "marginLoan": round(margin_loan, 0) if margin_loan > 0 else None,
        "netEquity": round(net_equity, 0),
        "leverageRatio": round(leverage_ratio, 3) if leverage_ratio is not None else None,
        "divYield": round(div_yield, 1),
        "divYearlyEur": round(div_yearly_eur, 0),
        "divMonthlyEur": round(div_yearly_eur / 12.0, 0),
        "concentration": round(concentration, 1),
        "attention": attention_count,
        "attentionSell": attention_sell,
        "attentionRsi": attention_rsi,
        "attentionTarget": attention_target,
        "attentionStop": attention_stop,
        "attentionSummary": attention_summary,
        "portfolioDrawdownPct": drawdown,
    }, sectors_allocation


def _align_snapshot_positions_to_open_db(snap: dict) -> dict:
    """
    Latest portfolio_snapshots row can still list sold tickers until refresh_portfolio finishes.
    Drop any position not in SQLite open rows so the dashboard matches current holdings.
    """
    rows = get_positions()
    open_set = {r["ticker"] for r in rows}
    pos = snap.get("positions")
    if not isinstance(pos, list):
        return snap

    filtered: list[dict] = []
    for p in pos:
        if isinstance(p, dict) and p.get("tk") in open_set:
            filtered.append(dict(p))

    if len(filtered) == len(pos):
        return snap

    total_eur = sum(float(p.get("eur") or 0) for p in filtered)
    for p in filtered:
        p["pct"] = round(float(p.get("eur") or 0) / total_eur * 100.0, 1) if total_eur > 0 else 0.0

    out = dict(snap)
    out["positions"] = filtered
    kpis, sectors_allocation = _rebuild_kpis(filtered, dict(snap.get("kpis") or {}))
    out["kpis"] = kpis
    out["sectors_allocation"] = sectors_allocation

    new_tks = [str(p.get("tk")) for p in filtered if p.get("tk")]
    corr = snap.get("correlation")
    if isinstance(corr, dict) and isinstance(corr.get("tickers"), list):
        old_tks = [str(t) for t in corr["tickers"]]
        mat = corr.get("matrix")
        idx_map = {t: i for i, t in enumerate(old_tks)}
        indices = [idx_map[t] for t in new_tks if t in idx_map]
        if (
            isinstance(mat, list)
            and len(indices) == len(new_tks)
            and all(isinstance(row, list) and len(row) == len(old_tks) for row in mat)
        ):
            new_mat = [[mat[i][j] for j in indices] for i in indices]
            out["correlation"] = {"tickers": new_tks, "matrix": new_mat}
        else:
            n = len(new_tks)
            out["correlation"] = {
                "tickers": new_tks,
                "matrix": [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)],
            }

    out["_positionsFilteredToOpenDb"] = True
    return out


def _minimal_portfolio_json() -> dict:
    rows = get_positions()
    fx_rates = get_fx_rates()
    tickers = [r["ticker"] for r in rows]
    n = len(tickers)
    matrix = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
    out_pos = []
    total_eur = 0.0
    for r in rows:
        ap = float(r["avg_price"] or 0)
        sh = float(r["shares"] or 0)
        cur = str(r["currency"] or "EUR").upper()
        avg_eur = _to_eur(ap, cur, fx_rates)
        eur = avg_eur * sh
        total_eur += eur
        out_pos.append(
            {
                "tk": r["ticker"],
                "name": r["ticker"],
                "mkt": "us",
                "price": round(ap, 2),
                "cur": cur,
                "chg": 0.0,
                "eur": round(eur, 0),
                "pct": 0.0,
                "ret": 0.0,
                "ret_4w": 0.0,
                "score": 50,
                "sigs": ["Turg?", "Rate?", "Val?"],
                "sigT": ["w", "w", "i"],
                "spark": [round(ap, 2)] * 8,
                "rsi": 50,
                "rsiCtx": "—",
                "pe": "—",
                "fpe": "—",
                "div": 0.0,
                "cat": "",
                "flagged": False,
                "target": float(r["target"] or 0),
                "stop_loss": float(r["stop_loss"] or 0),
                "tees": str(r["tees"] or ""),
                "shares": sh,
                "avg_price": ap,
                "avg_eur": avg_eur,
                "eur_price": avg_eur,
                "data_source": {},
                "data_quality": {},
            }
        )
    for p in out_pos:
        p["pct"] = round(float(p["eur"]) / total_eur * 100.0, 1) if total_eur > 0 else 0.0

    kpis, sectors_allocation = _rebuild_kpis(out_pos)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "fx_rates": fx_rates,
        "kpis": kpis,
        "macro": {"items": []},
        "sectors_rotation": [],
        "sectors_allocation": sectors_allocation,
        "correlation": {"tickers": tickers, "matrix": matrix},
        "data_quality": {},
        "positions": out_pos,
        "news": [],
        "earnings": [],
        "_fallback": True,
    }


def main() -> None:
    snap = get_latest_portfolio_snapshot()
    if snap is not None:
        snap = _align_snapshot_positions_to_open_db(snap)
        print(json.dumps(snap, ensure_ascii=False))
        return
    print(json.dumps(_minimal_portfolio_json(), ensure_ascii=False))


if __name__ == "__main__":
    main()
