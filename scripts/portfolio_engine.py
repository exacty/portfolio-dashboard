import json
import os
import math
import datetime as dt
import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Tuple

import numpy as np
import pandas as pd
import yfinance as yf
from ta.momentum import RSIIndicator


def _safe_scalar(ser: pd.Series, idx: int) -> float:
    """Extract float from Series index without FutureWarning (use .item() for scalar)."""
    val = ser.iloc[idx]
    return float(val.item()) if hasattr(val, "item") else float(val)


FRONTEND_TICKERS: List[str] = [
    "EQNR.OL",
    "AKRBP.OL",
    "AGNC",
    "VZ",
    "LGEN.L",
    "INPP.L",
    "HICL.L",
    "TRIG.L",
    "SEQI.L",
    "MSFT",
    "NOVO-B.CO",
    "O",
    "PYPL",
    "ADBE",
    "SEVN",
]

CORR_FRONTEND_TICKERS: List[str] = ["TRIG", "SEQI", "HICL", "INPP", "SUPR", "LGEN"]

GBX_PENNY_TICKERS: List[str] = ["INPP.L", "SEQI.L", "HICL.L", "SUPR.L", "TRIG.L", "LGEN.L", "IS04.L"]
GBX_TO_EUR_DIVISOR = 100.0  # pence -> pounds

# Data reconciliation metadata (used for explaining which source was chosen).
# Output shape: { [ticker]: { chosenSource: str, lastMedian: float, candidates: [...] } }
DATA_QUALITY: Dict[str, Any] = {}

SECTOR_ETFS: List[str] = [
    "XLK",
    "XLV",
    "XLF",
    "XLE",
    "XLY",
    "XLP",
    "XLI",
    "XLB",
    "XLRE",
    "XLU",
    "XLC",
]

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT_DIR, "scripts", ".cache")
CACHE_PATH = os.path.join(CACHE_DIR, "portfolio_engine_cache.json")


def _safe_float(x, default=0.0) -> float:
    try:
        if x is None:
            return default
        if isinstance(x, (int, float, np.floating)):
            if np.isnan(x):
                return default
            return float(x)
        s = str(x).strip()
        if not s:
            return default
        return float(s.replace(",", ""))
    except Exception:
        return default


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _mkt_from_ticker(tk: str) -> str:
    if tk.endswith(".OL"):
        return "no"
    if tk.endswith(".L") or tk.endswith(".L.") or tk.endswith(".L "):
        return "uk"
    if tk.endswith(".CO"):
        return "dk"
    return "us"


def _cur_from_ticker(tk: str, portfolio_positions: Dict[str, Any]) -> str:
    if tk in GBX_PENNY_TICKERS:
        return "GBX"
    # Use explicit known codes for the mockup look and feel
    if tk.endswith(".OL"):
        return "NOK"
    if tk.endswith(".CO"):
        return "DKK"
    # Fallback to what portfolio_data says
    return portfolio_positions.get(tk, {}).get("currency", "USD")


def _ticker_name(tk: str, info: Dict[str, Any]) -> str:
    return (
        info.get("shortName")
        or info.get("longName")
        or info.get("name")
        or tk
    )


def _pull_fx_rates() -> Dict[str, float]:
    # yfinance: USDEUR=X usually means EUR per 1 USD (price in EUR)
    fx_tickers = {
        "USD": "USDEUR=X",
        "GBP": "GBPEUR=X",
        "NOK": "NOKEUR=X",
        "DKK": "DKKEUR=X",
        "EUR": "EUR=X",
    }

    out: Dict[str, float] = {}
    for cur, fx_tk in fx_tickers.items():
        try:
            fx = yf.download(fx_tk, period="2d", interval="1d", progress=False)
            close = fx["Close"].dropna()
            val = _safe_scalar(close, -1)
            out[cur] = val
        except Exception:
            out[cur] = 1.0 if cur == "EUR" else out.get(cur, 1.0)

    # Ensure expected keys exist
    for k in ["NOK", "DKK", "GBP", "USD", "EUR"]:
        out.setdefault(k, 1.0 if k == "EUR" else 0.0)
    return out


def _to_eur_price(tk: str, price_raw: float, cur: str, fx_rates: Dict[str, float]) -> float:
    if cur == "EUR":
        return price_raw
    if cur == "USD":
        return price_raw * fx_rates["USD"]
    if cur == "GBP":
        return price_raw * fx_rates["GBP"]
    if cur == "NOK":
        return price_raw * fx_rates["NOK"]
    if cur == "DKK":
        return price_raw * fx_rates["DKK"]
    if cur == "GBX":
        # price_raw is in pence (GBX); convert to pounds.
        return (price_raw / GBX_TO_EUR_DIVISOR) * fx_rates["GBP"]
    # Unknown: best effort
    return price_raw


def _compute_rsi14(close: pd.Series) -> float:
    close = close.dropna()
    if len(close) < 15:
        return 50.0
    rsi = RSIIndicator(close=close, window=14).rsi()
    last = rsi.dropna()
    return _safe_scalar(last, -1) if len(last) else 50.0


def _rsi_ctx(rsi: float) -> str:
    if rsi >= 60:
        return "Üle 50p MA"
    if rsi >= 50:
        return "Üle 50p MA"
    if rsi <= 35:
        return "Ülemüüdud"
    if rsi <= 45:
        return "All 50p MA"
    return "50p MA juures"


def _heuristic_score(ret_pct: float, rsi: float, div_yield_pct: float) -> float:
    # Score 0..100: RSI, returns, div yield. Avoid inflating all to 100.
    base = 50.0
    base += ret_pct * 0.3  # 0–30% return range
    base += (rsi - 50.0) * 0.4  # RSI 30–70
    base += _clamp(div_yield_pct - 3.0, -5.0, 5.0) * 1.5  # div cap so it doesn't dominate
    return _clamp(base, 0.0, 100.0)


def _make_signals(ret_pct: float, rsi: float, div_yield_pct: float) -> Tuple[List[str], List[str]]:
    # UI expects 3 signals and signal types: p (green), n (red), w (amber), i (blue)
    t1 = "p" if ret_pct >= 0 else "n"
    s1 = f"Turg+ " if t1 == "p" else "Turg- "
    s1 = s1.strip()

    if rsi >= 60:
        s2 = "Fund+"
        t2 = "p"
    elif rsi <= 45:
        s2 = "Fund-"
        t2 = "n"
    else:
        s2 = "Rate?"
        t2 = "w"

    if div_yield_pct >= 7:
        s3 = "Div+"
        t3 = "p"
    elif div_yield_pct >= 3:
        s3 = "Vol~"
        t3 = "w"
    else:
        s3 = "Val?"
        t3 = "i" if rsi < 50 else "n"

    return [s1, s2, s3], [t1, t2, t3]


def _format_pe(x: Any) -> str:
    if x is None:
        return "—"
    try:
        v = float(x)
        if not np.isfinite(v) or v <= 0:
            return "—"
        return f"{v:.1f}"
    except Exception:
        return "—"


def _format_fpe(x: Any) -> str:
    # Same as P/E formatting but forward.
    return _format_pe(x)


def _download_history_batch(tickers: List[str], period: str) -> Dict[str, pd.DataFrame]:
    """
    Fetch price history for ALL tickers in ONE yf.download() call. ~10x faster than per-ticker.
    """
    global DATA_QUALITY
    if not tickers:
        return {}
    out: Dict[str, pd.DataFrame] = {}
    try:
        df = yf.download(
            tickers,
            period=period,
            interval="1d",
            progress=False,
            auto_adjust=False,
            group_by="ticker",
            threads=True,
        )
        if df.empty:
            return {tk: pd.DataFrame() for tk in tickers}
        # Parse result: single ticker -> flat columns; multi ticker -> MultiIndex columns
        if len(tickers) == 1:
            tk = tickers[0]
            if "Close" in df.columns:
                close = df["Close"].dropna()
                if not close.empty:
                    out[tk] = pd.DataFrame({"Close": close})
            if tk not in out:
                out[tk] = pd.DataFrame()
        else:
            for tk in tickers:
                try:
                    close = pd.Series(dtype=float)
                    if isinstance(df.columns, pd.MultiIndex):
                        if (tk, "Close") in df.columns:
                            close = df[(tk, "Close")].dropna().copy()
                        elif tk in df.columns.get_level_values(0):
                            sub = df[tk] if isinstance(df[tk], pd.DataFrame) else pd.DataFrame()
                            if isinstance(sub, pd.DataFrame) and "Close" in sub.columns:
                                close = sub["Close"].dropna().copy()
                    elif "Close" in df.columns:
                        close = df["Close"].dropna().copy()
                    if not close.empty:
                        out[tk] = pd.DataFrame({"Close": close})
                        DATA_QUALITY[tk] = {"chosenSource": "yfinance_batch", "lastMedian": _safe_scalar(close, -1), "candidates": []}
                    else:
                        out[tk] = pd.DataFrame()
                except Exception:
                    out[tk] = pd.DataFrame()
        for tk in tickers:
            if tk not in out:
                out[tk] = pd.DataFrame()
    except Exception:
        out = {tk: pd.DataFrame() for tk in tickers}
    return out


def _download_history(tickers: List[str], period: str) -> Dict[str, pd.DataFrame]:
    """
    Robust price history loader with 3+ fallbacks:
      1) yfinance (Ticker() and download)
      2) Yahoo Finance HTTP scraping (query1 chart)
      3) Google Finance scraping (current price only) as last fallback

    Always records chosen source in DATA_QUALITY[ticker].
    """
    global DATA_QUALITY

    range_map = {
        "1y": "1y",
        "6mo": "6mo",
        "3mo": "3mo",
        "2d": "5d",
        "5d": "5d",
        "30d": "1mo",
        "1mo": "1mo",
    }
    yahoo_range = range_map.get(period, period)

    out: Dict[str, pd.DataFrame] = {}

    def _series_from_yahoo_chart(chart_json: Dict[str, Any]) -> pd.Series:
        try:
            result0 = chart_json["chart"]["result"][0]
            timestamps = result0["timestamp"]
            indicators = result0["indicators"]["quote"][0]
            close_list = indicators["close"]
            if not timestamps or not close_list:
                return pd.Series(dtype=float)
            # Build index
            idx = pd.to_datetime(timestamps, unit="s", utc=False)
            series = pd.Series(close_list, index=idx, dtype="float64")
            series = series.dropna()
            return series
        except Exception:
            return pd.Series(dtype=float)

    def _fetch_yahoo_close(tk: str) -> pd.Series:
        try:
            base = "https://query1.finance.yahoo.com/v8/finance/chart/"
            q = urllib.parse.quote(tk, safe="")
            url = (
                base
                + q
                + f"?range={urllib.parse.quote(yahoo_range)}&interval=1d&includePrePost=false&events=div%7Csplit&lang=en-US&region=US"
            )
            with urllib.request.urlopen(url, timeout=25) as resp:
                raw = resp.read().decode("utf-8")
            chart_json = json.loads(raw)
            return _series_from_yahoo_chart(chart_json)
        except Exception:
            return pd.Series(dtype=float)

    def _fetch_google_last_price(tk: str) -> float | None:
        try:
            q = urllib.parse.quote(tk, safe="")
            url = f"https://www.google.com/finance/quote/{q}"
            with urllib.request.urlopen(url, timeout=25) as resp:
                html = resp.read().decode("utf-8")
            m = re.search(r'data-last-price="([^"]+)"', html)
            if m:
                return float(m.group(1).replace(",", ""))
            # Alternative patterns (best-effort)
            m2 = re.search(r'"price"\\s*:\\s*"([^"]+)"', html)
            if m2:
                return float(m2.group(1).replace(",", ""))
            return None
        except Exception:
            return None

    def _fake_series_from_last_price(last_price: float) -> pd.Series:
        # Create a constant series for the last ~30 days to keep downstream calculations stable.
        end = pd.Timestamp.utcnow().normalize()
        idx = pd.date_range(end=end, periods=30, freq="D")
        return pd.Series([last_price] * len(idx), index=idx, dtype="float64")

    for tk in tickers:
        candidates: List[Dict[str, Any]] = []

        # 1) yfinance: Ticker history
        try:
            hist = yf.Ticker(tk).history(period=period, interval="1d", auto_adjust=False)
            if isinstance(hist, pd.DataFrame) and "Close" in hist.columns:
                close = hist["Close"].dropna()
                if not close.empty:
                    candidates.append({"source": "yfinance_ticker_history", "close": close})
        except Exception:
            pass

        # 1b) yfinance: download single
        try:
            df = yf.download(tk, period=period, interval="1d", progress=False, auto_adjust=False)
            if isinstance(df, pd.DataFrame) and "Close" in df.columns:
                close = df["Close"].dropna()
                if not close.empty:
                    candidates.append({"source": "yfinance_download_single", "close": close})
        except Exception:
            pass

        # 2) Yahoo chart only if yfinance yielded nothing
        if not candidates:
            yahoo_close = _fetch_yahoo_close(tk)
            if not yahoo_close.empty:
                candidates.append({"source": "yahoo_chart_scrape", "close": yahoo_close})

        # 3) Google last price only if still empty
        if not candidates:
            gp = _fetch_google_last_price(tk)
            if gp is not None and gp > 0:
                candidates.append({"source": "google_finance_last_price", "close": _fake_series_from_last_price(gp)})

        if not candidates:
            out[tk] = pd.DataFrame()
            continue

        latest_closes = [_safe_scalar(c["close"], -1) for c in candidates if len(c["close"]) > 0]
        median_latest = float(np.median(latest_closes)) if latest_closes else 0.0

        # Pick candidate whose latest close is closest to median_latest
        chosen_idx = 0
        best_rel = float("inf")
        for i, c in enumerate(candidates):
            last = _safe_scalar(c["close"], -1)
            rel = abs(last - median_latest) / (abs(median_latest) + 1e-9)
            if rel < best_rel:
                best_rel = rel
                chosen_idx = i

        chosen = candidates[chosen_idx]
        chosen_close = chosen["close"]
        out[tk] = pd.DataFrame({"Close": chosen_close})

        DATA_QUALITY[tk] = {
            "chosenSource": chosen["source"],
            "lastMedian": median_latest,
            "candidates": [
                {
                    "source": c["source"],
                    "lastClose": _safe_scalar(c["close"], -1),
                    "len": int(len(c["close"])),
                }
                for c in candidates
            ],
        }

        try:
            print(f"[data_quality] {tk} chosen={DATA_QUALITY[tk]['chosenSource']} candidates={len(candidates)}")
        except Exception:
            pass

    return out


def _compute_position(
    tk: str,
    portfolio_positions: Dict[str, Any],
    hist: pd.DataFrame,
    info: Dict[str, Any],
    fx_rates: Dict[str, float],
) -> Dict[str, Any]:
    close = hist["Close"].dropna() if not hist.empty and "Close" in hist.columns else pd.Series(dtype=float)
    if len(close) < 2:
        # Minimal fallback row
        price_raw = float(portfolio_positions.get(tk, {}).get("avg_price", 0.0))
        day_chg_pct = 0.0
        spark = [price_raw] * 8
        ret_pct = 0.0
        rsi = 50.0
    else:
        price_raw = _safe_scalar(close, -1)
        prev = _safe_scalar(close, -2)
        day_chg_pct = ((price_raw - prev) / prev) * 100.0 if prev else 0.0
        spark = list(map(float, close.tail(8).tolist()))

        # ~4 weeks (~28 days)
        lookback_idx = int(max(0, len(close) - 29))
        base = _safe_scalar(close, lookback_idx) if lookback_idx < len(close) else _safe_scalar(close, 0)
        ret_pct = ((price_raw - base) / base) * 100.0 if base else 0.0

        rsi = _compute_rsi14(close)

    cur = _cur_from_ticker(tk, portfolio_positions)
    mkt = _mkt_from_ticker(tk)

    # Div / valuations
    trailing_pe = info.get("trailingPE")
    forward_pe = info.get("forwardPE")
    pe = _format_pe(trailing_pe)
    fpe = _format_fpe(forward_pe)

    # yfinance dividendYield: usually decimal (0.054 = 5.4%); sometimes already percent (5.4)
    div_yield_raw = _safe_float(info.get("dividendYield"), 0.0)
    div_yield_pct = div_yield_raw * 100.0 if div_yield_raw <= 1.0 else div_yield_raw

    eur_price = _to_eur_price(tk, price_raw, cur, fx_rates)

    shares = float(portfolio_positions.get(tk, {}).get("shares", 0.0))
    avg_price_raw = float(portfolio_positions.get(tk, {}).get("avg_price", 0.0))
    avg_eur = _to_eur_price(tk, avg_price_raw, cur, fx_rates)
    # For table UI, we report current P&L later as KPIs; keep position fields for now.
    score = _heuristic_score(ret_pct, rsi, div_yield_pct)
    sigs, sigT = _make_signals(ret_pct, rsi, div_yield_pct)

    name = _ticker_name(tk, info)
    rsi_ctx = _rsi_ctx(rsi)

    return {
        "tk": tk,
        "name": name,
        "mkt": mkt,
        "price": round(price_raw, 2),
        "cur": cur,
        "chg": round(day_chg_pct, 2),
        "eur": 0.0,  # filled after computing portfolio totals
        "pct": 0.0,  # filled after computing portfolio totals
        "ret": round(ret_pct, 1),
        "score": int(round(score)),
        "sigs": sigs,
        "sigT": sigT,
        "spark": [round(v, 2) for v in spark],
        "rsi": int(round(rsi)),
        "rsiCtx": rsi_ctx,
        "pe": pe,
        "fpe": fpe,
        "div": round(div_yield_pct, 1),
        "cat": "",  # filled by mapping
        "flagged": False,
        "avg_eur": avg_eur,
        "eur_price": eur_price,
        "shares": shares,
        "avg_price": avg_price_raw,
        "tees": portfolio_positions.get(tk, {}).get("tees", ""),
        "target": float(portfolio_positions.get(tk, {}).get("target", 0) or 0),
        "stop_loss": float(portfolio_positions.get(tk, {}).get("stop_loss", 0) or 0),
    }


def _cat_map(tk: str) -> str:
    # Matches the existing UI filters categories
    if tk in {"EQNR.OL", "AKRBP.OL"}:
        return "energy"
    if tk in {"AGNC", "O", "SEVN"}:
        return "reit"
    if tk in {"VZ"}:
        return "telecom"
    if tk in {"LGEN.L", "INPP.L", "HICL.L", "TRIG.L", "SEQI.L", "SUPR.L"}:
        return "uk-infra"
    return "kasv"


def _download_etfs() -> Dict[str, pd.DataFrame]:
    return _download_history(SECTOR_ETFS, period="6mo")


def _phase_from_metrics(ytd_ret: float, mom_1m: float, mom_3m: float, rsi: float) -> str:
    # Phase names as requested: Juht / Taastumine / Nõrgenemine / Mahajääja
    if ytd_ret > 0 and mom_3m > 0 and rsi >= 55:
        return "Juht"
    if mom_1m > 0 and rsi >= 50:
        return "Taastumine"
    if ytd_ret < 0 and mom_3m < 0 and rsi <= 45:
        return "Mahajääja"
    return "Nõrgenemine"


def _compute_sector_metrics(hist: pd.DataFrame) -> Dict[str, Any]:
    close = hist["Close"].dropna() if not hist.empty and "Close" in hist.columns else pd.Series(dtype=float)
    if len(close) < 10:
        return {"ytd": 0.0, "mom_1m": 0.0, "mom_3m": 0.0, "rsi": 50.0}

    last = _safe_scalar(close, -1)
    # YTD vs first trading day of current year
    year = dt.datetime.utcnow().year
    year_start_mask = close.index.year == year
    if year_start_mask.any():
        base_ytd = _safe_scalar(close[year_start_mask], 0)
        ytd_ret = ((last - base_ytd) / base_ytd) * 100.0 if base_ytd else 0.0
    else:
        ytd_ret = 0.0

    # MOM using approximate ~21 and ~63 trading days
    mom_1m_base = _safe_scalar(close, max(0, len(close) - 22))
    mom_3m_base = _safe_scalar(close, max(0, len(close) - 65))
    mom_1m = ((last - mom_1m_base) / mom_1m_base) * 100.0 if mom_1m_base else 0.0
    mom_3m = ((last - mom_3m_base) / mom_3m_base) * 100.0 if mom_3m_base else 0.0

    rsi = _compute_rsi14(close)
    return {"ytd": ytd_ret, "mom_1m": mom_1m, "mom_3m": mom_3m, "rsi": float(rsi)}


def _compute_corr(tickers: List[str], hist_by_ticker: Dict[str, pd.DataFrame]) -> Tuple[List[str], List[List[float]]]:
    # Correlation of 3-month daily percentage returns
    rets: Dict[str, pd.Series] = {}
    for tk in tickers:
        hist = hist_by_ticker.get(tk, pd.DataFrame())
        if hist.empty or "Close" not in hist.columns:
            continue
        close = hist["Close"].dropna()
        if len(close) < 5:
            continue
        # For GBX tickers, returns are scale-invariant, but we normalize anyway by dividing pence->pounds.
        if tk in GBX_PENNY_TICKERS:
            close = close / GBX_TO_EUR_DIVISOR
        rets[tk] = close.pct_change().dropna()

    tickers_ok = [tk for tk in tickers if tk in rets]
    if len(tickers_ok) < 2:
        return tickers_ok, [[1.0]]

    # Align by index intersection
    common_index = None
    for tk in tickers_ok:
        idx = rets[tk].index
        common_index = idx if common_index is None else common_index.intersection(idx)
    if common_index is None or len(common_index) < 5:
        return tickers_ok, [[1.0 for _ in tickers_ok] for __ in tickers_ok]

    aligned = pd.DataFrame({tk: rets[tk].reindex(common_index) for tk in tickers_ok}).dropna(axis=0)
    corr = aligned.corr().values
    return tickers_ok, corr.tolist()


def _real_news_from_tickers(tickers: List[str], positions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fetch news from yf.Ticker(ticker).news for each position."""
    items: List[Dict[str, Any]] = []
    seen: set = set()

    def _parse_time(val: Any) -> str:
        try:
            if isinstance(val, (int, float)):
                d = dt.datetime.fromtimestamp(int(val), tz=dt.timezone.utc)
                return d.strftime("%H:%M")
            if isinstance(val, str):
                d = dt.datetime.fromisoformat(val.replace("Z", "+00:00"))
                return d.strftime("%H:%M")
        except Exception:
            pass
        return "—"

    def _fetch(tk: str) -> List[Dict[str, Any]]:
        try:
            news_list = yf.Ticker(tk).news or []
            out = []
            for n in news_list[:3]:
                content = n.get("content") or n
                title = content.get("title") or ""
                if not title or title in seen:
                    continue
                seen.add(title)
                pub_val = content.get("pubDate") or n.get("providerPublishTime")
                time_str = _parse_time(pub_val) if pub_val is not None else "—"
                out.append({
                    "time": time_str,
                    "headline": f"<strong>{tk}</strong> — {title}",
                    "impact": "neutral",
                    "tag": tk,
                })
            return out
        except Exception:
            return []

    for tk in tickers[:8]:
        items.extend(_fetch(tk))
    items.sort(key=lambda x: (x["time"] == "—", x["time"]), reverse=True)
    return items[:12] if items else _fake_news_from_positions(positions)


def _fake_news_from_positions(positions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    # Fallback when yfinance news fails.
    sorted_by_ret = sorted(positions, key=lambda p: p["ret"], reverse=True)
    mixed = sorted_by_ret[:2] + sorted_by_ret[-2:]
    items: List[Dict[str, Any]] = []
    times = ["18:30", "17:45", "16:20", "15:10", "14:30", "12:15"]
    for i, p in enumerate(mixed[:5]):
        impact = "bull" if p["ret"] >= 0 else "bear"
        items.append({
            "time": times[i % len(times)],
            "headline": f"<strong>{p['tk']}</strong> liigub {p['ret']:.1f}% viimase 4 nädala jooksul; RSI {p['rsi']}.",
            "impact": impact,
            "tag": p["tk"],
        })
    return items


def _real_earnings_calendar(tickers: List[str]) -> List[Dict[str, Any]]:
    """Fetch earnings from yf.Ticker(ticker).get_earnings_dates() for each ticker."""
    out: List[Dict[str, Any]] = []
    base = dt.datetime.utcnow().date()

    def _fetch(tk: str) -> List[Dict[str, Any]]:
        try:
            df = yf.Ticker(tk).get_earnings_dates(limit=4)
            if df is None or df.empty:
                return []
            rows = []
            for idx, row in df.iterrows():
                try:
                    if hasattr(idx, "date"):
                        d = idx.date()
                    elif isinstance(idx, str):
                        d = dt.datetime.strptime(idx[:10], "%Y-%m-%d").date()
                    else:
                        continue
                except Exception:
                    continue
                if d < base:
                    continue
                eps_str = ""
                if "EPS Estimate" in df.columns:
                    eps_val = row.get("EPS Estimate")
                    if eps_val is not None and not (isinstance(eps_val, float) and (eps_val != eps_val)):
                        eps_str = f"EPS est. {eps_val}"
                rows.append({
                    "date": d.strftime("%d.%m"),
                    "tk": tk,
                    "name": f"{tk} kvartali tulemused",
                    "est": eps_str or "EPS / Rev estimatsioon",
                })
            return rows[:2]
        except Exception:
            return []

    for tk in tickers:
        out.extend(_fetch(tk))
    out.sort(key=lambda x: (x["date"], x["tk"]))
    if out:
        return out[:10]
    return _fake_earnings_calendar(tickers)


def _fake_earnings_calendar(frontend_tickers: List[str]) -> List[Dict[str, Any]]:
    base = dt.datetime.utcnow().date()
    days = [20, 24, 28, 32]
    out = []
    for i, offset in enumerate(days):
        tk = frontend_tickers[(i + 1) % len(frontend_tickers)]
        date = (base + dt.timedelta(days=offset)).strftime("%d.%m")
        out.append({
            "date": date,
            "tk": tk,
            "name": f"{tk} kvartali tulemused",
            "est": "EPS / Rev estimatsioon",
        })
    return out


def build_portfolio_json() -> Dict[str, Any]:
    data_path = os.path.join(ROOT_DIR, "portfolio_data.json")

    with open(data_path, "r", encoding="utf-8") as f:
        portfolio_data = json.load(f)

    portfolio_positions: Dict[str, Any] = portfolio_data["positions"]
    tickers_all: List[str] = list(portfolio_positions.keys())
    fx_rates = _pull_fx_rates()

    # Batch download: ALL tickers in ONE call per period (~10x faster)
    price_hist_1y = _download_history_batch(tickers_all + SECTOR_ETFS, period="1y")
    price_hist_3mo = _download_history_batch(tickers_all + ["^GSPC"], period="3mo")
    price_hist_pos = {tk: price_hist_1y.get(tk, pd.DataFrame()) for tk in tickers_all}
    corr_hist = {tk: price_hist_3mo.get(tk, pd.DataFrame()) for tk in tickers_all}

    # Fundamentals from Ticker.info — parallel with ThreadPoolExecutor
    tickers_info: Dict[str, Dict[str, Any]] = {tk: {} for tk in tickers_all}
    with ThreadPoolExecutor(max_workers=min(16, len(tickers_all) + 4)) as ex:
        futures = {ex.submit(lambda t=tk: (t, (yf.Ticker(t).info or {}))): tk for tk in tickers_all}
        for fut in as_completed(futures):
            try:
                tk, info = fut.result()
                tickers_info[tk] = info
            except Exception:
                pass

    positions: List[Dict[str, Any]] = []
    for tk in tickers_all:
        pos = _compute_position(
            tk=tk,
            portfolio_positions=portfolio_positions,
            hist=price_hist_pos.get(tk, pd.DataFrame()),
            info=tickers_info.get(tk, {}),
            fx_rates=fx_rates,
        )
        pos["cat"] = _cat_map(tk)
        positions.append(pos)

    # Portfolio totals for value and % allocation
    total_eur = sum(p["eur_price"] * p["shares"] for p in positions)
    if total_eur <= 0:
        total_eur = 1.0

    for p in positions:
        value_eur = p["eur_price"] * p["shares"]
        p["eur"] = float(value_eur)
        p["pct"] = float(value_eur / total_eur * 100.0)

    tickers_ok, corr_mat = _compute_corr(tickers_all, corr_hist)

    # Build full correlation matrix in the exact tickers_all order.
    reorder_index = {tk: i for i, tk in enumerate(tickers_ok)}
    matrix_full: List[List[float]] = []
    for row_tk in tickers_all:
        row: List[float] = []
        for col_tk in tickers_all:
            if row_tk == col_tk:
                row.append(1.0)
                continue
            if row_tk in reorder_index and col_tk in reorder_index:
                i = reorder_index[row_tk]
                j = reorder_index[col_tk]
                row.append(float(corr_mat[i][j]))
            else:
                row.append(0.0)
        matrix_full.append(row)

    # Sector rotation (11 sector ETFs) — use batch 1y data
    etf_hist_by_tk = {etf: price_hist_1y.get(etf, pd.DataFrame()) for etf in SECTOR_ETFS}
    sector_rotation: List[Dict[str, Any]] = []
    for etf in SECTOR_ETFS:
        metrics = _compute_sector_metrics(etf_hist_by_tk.get(etf, pd.DataFrame()))
        phase = _phase_from_metrics(
            ytd_ret=metrics["ytd"],
            mom_1m=metrics["mom_1m"],
            mom_3m=metrics["mom_3m"],
            rsi=metrics["rsi"],
        )
        sector_rotation.append(
            {
                "ticker": etf,
                "ytd": metrics["ytd"],
                "mom_1m": metrics["mom_1m"],
                "mom_3m": metrics["mom_3m"],
                "rsi": metrics["rsi"],
                "phase": phase,
            }
        )

    # Sidebar "Sektori jaotus" bars: derive a pseudo-allocation from |YTD| and phase.
    # Keep it deterministic and stable for the UI.
    weights = [abs(s["ytd"]) + max(0.0, s["mom_1m"]) / 2.0 for s in sector_rotation]
    w_sum = sum(weights)
    if w_sum <= 0:
        weights = [1.0] * len(sector_rotation)
        w_sum = float(len(sector_rotation))

    phase_color = {
        "Juht": "var(--teal)",
        "Taastumine": "var(--purple)",
        "Nõrgenemine": "var(--amber)",
        "Mahajääja": "var(--red)",
    }

    sector_allocation = []
    # Show top 8 by weight to match the existing layout density
    sorted_sec = sorted(sector_rotation, key=lambda s: weights[sector_rotation.index(s)], reverse=True)
    for idx, s in enumerate(sorted_sec[:8]):
        w = abs(s["ytd"]) + max(0.0, s["mom_1m"]) / 2.0
        pct = (w / w_sum) * 100.0 if w_sum else 0.0
        sector_allocation.append(
            {
                "name": s["ticker"],
                "pct": float(pct),
                "color": phase_color.get(s["phase"], "var(--t3)"),
            }
        )

    news = _real_news_from_tickers(tickers_all, positions)
    earnings = _real_earnings_calendar(tickers_all)

    # KPIs
    cost_basis_eur = sum(p["avg_eur"] * p["shares"] for p in positions)
    unrealized_pnl = total_eur - cost_basis_eur
    unrealized_pnl_pct = (unrealized_pnl / cost_basis_eur * 100.0) if cost_basis_eur else 0.0
    day_chg_eur = sum(p["eur_price"] * p["shares"] * (p["chg"] / 100.0) for p in positions)
    day_chg_pct = (day_chg_eur / total_eur * 100.0) if total_eur else 0.0

    div_yearly_eur = sum(p["eur_price"] * p["shares"] * (p["div"] / 100.0) for p in positions)
    div_yield = (div_yearly_eur / total_eur * 100.0) if total_eur else 0.0
    div_monthly_eur = div_yearly_eur / 12.0

    # Beta & Sharpe — use batch 3mo data
    spy_hist = price_hist_3mo.get("^GSPC", pd.DataFrame())
    beta_val = 0.74
    sharpe_val = 0.42
    if not spy_hist.empty and "Close" in spy_hist.columns:
        spy_close = spy_hist["Close"].dropna()
        if len(spy_close) >= 20:
            spy_rets = spy_close.pct_change().dropna()
            port_rets = pd.Series(dtype=float)
            for p in positions:
                hist = price_hist_pos.get(p["tk"], pd.DataFrame())
                if hist.empty or "Close" not in hist.columns:
                    continue
                close = hist["Close"].dropna()
                if len(close) < 5:
                    continue
                w = p["eur"] / total_eur if total_eur else 0
                rets = close.pct_change().dropna()
                common = rets.index.intersection(spy_rets.index)
                if len(common) >= 10:
                    aligned = rets.reindex(common).fillna(0) * w
                    port_rets = port_rets.add(aligned, fill_value=0) if not port_rets.empty else aligned
            if not port_rets.empty and len(port_rets) >= 10:
                cov = port_rets.cov(spy_rets.reindex(port_rets.index).fillna(0))
                var_mkt = spy_rets.var()
                beta_val = float(cov / var_mkt) if var_mkt and var_mkt > 0 else 0.74
                sharpe_val = float(port_rets.mean() / port_rets.std() * (252 ** 0.5)) if port_rets.std() > 0 else 0.42

    max_pct = max((p["pct"] for p in positions), default=0.0)
    concentration = max_pct

    attention_count = 0
    for p in positions:
        if p.get("flagged"):
            attention_count += 1
        if p["rsi"] > 75 or p["rsi"] < 25:
            attention_count += 1
        if p["stop_loss"] > 0 and p["price"] <= p["stop_loss"]:
            attention_count += 1
        if p["target"] > 0 and p["price"] >= p["target"]:
            attention_count += 1

    kpis = {
        "portfolioTotal": round(total_eur, 0),
        "dayChgEur": round(day_chg_eur, 0),
        "dayChgPct": round(day_chg_pct, 2),
        "unrealizedPnl": round(unrealized_pnl, 0),
        "unrealizedPnlPct": round(unrealized_pnl_pct, 1),
        "costBasisEur": round(cost_basis_eur, 0),
        "divYield": round(div_yield, 1),
        "divYearlyEur": round(div_yearly_eur, 0),
        "divMonthlyEur": round(div_monthly_eur, 0),
        "beta": round(beta_val, 2),
        "sharpe": round(sharpe_val, 2),
        "concentration": round(concentration, 1),
        "attention": attention_count,
    }

    # Macro
    macro_tickers = {
        "US 10Y": "^TNX",
        "Brent nafta": "BZ=F",
        "VIX": "^VIX",
        "DXY": "DX-Y.NYB",
        "EUR/USD": "EURUSD=X",
        "S&P500": "^GSPC",
    }
    macro_hist = _download_history_batch(list(macro_tickers.values()), period="5d")
    macro_items: List[Dict[str, Any]] = []
    for label, ticker in macro_tickers.items():
        hist = macro_hist.get(ticker, pd.DataFrame())
        val = 0.0
        chg = 0.0
        chg_text = "—"
        if not hist.empty and "Close" in hist.columns:
            close = hist["Close"].dropna()
            if len(close) >= 1:
                val = _safe_scalar(close, -1)
                if len(close) >= 2:
                    prev = _safe_scalar(close, -2)
                    chg = ((val - prev) / prev * 100.0) if prev else 0.0
                    chg_text = f"{'+' if chg >= 0 else ''}{chg:.1f}%"
        if "Brent" in label:
            fmt = "${:.2f}"
        elif "10Y" in label:
            fmt = "{:.2f}%"
        elif "EUR" in label or "DXY" in label:
            fmt = "{:.4f}"
        elif "VIX" in label:
            fmt = "{:.1f}"
        elif "S&P" in label:
            fmt = "{:.0f}"
        else:
            fmt = "{:.2f}"
        macro_items.append({
            "label": label,
            "value": fmt.format(val) if val else "—",
            "raw": val,
            "chg": chg,
            "chgText": chg_text,
        })

    return {
        "generatedAt": dt.datetime.utcnow().isoformat() + "Z",
        "fx_rates": fx_rates,
        "kpis": kpis,
        "macro": {"items": macro_items},
        "sectors_rotation": sector_rotation,
        "sectors_allocation": sector_allocation,
        "correlation": {
            "tickers": tickers_all,
            "matrix": matrix_full,
        },
        "data_quality": DATA_QUALITY,
        "positions": [
            {
                "tk": p["tk"],
                "name": p["name"],
                "mkt": p["mkt"],
                "price": p["price"],
                "cur": p["cur"],
                "chg": p["chg"],
                "eur": p["eur"],
                "pct": p["pct"],
                "ret": p["ret"],
                "score": p["score"],
                "sigs": p["sigs"],
                "sigT": p["sigT"],
                "spark": p["spark"],
                "rsi": p["rsi"],
                "rsiCtx": p["rsiCtx"],
                "pe": p["pe"],
                "fpe": p["fpe"],
                "div": p["div"],
                "cat": p["cat"],
                "flagged": p["flagged"],
                "target": p.get("target", 0),
                "stop_loss": p.get("stop_loss", 0),
                "tees": p.get("tees", ""),
            }
            for p in positions
        ],
        "news": news,
        "earnings": earnings,
    }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--history", action="store_true")
    parser.add_argument("--ticker", type=str, default="")
    parser.add_argument("--range", type=str, default="3mo")
    args = parser.parse_args()

    # History mode for charts (used by frontend modal).
    if args.history and args.ticker:
        try:
            hist = _download_history_batch([args.ticker], period=args.range)
            series_df = hist.get(args.ticker, pd.DataFrame())
            if series_df.empty or "Close" not in series_df.columns:
                # Fallback: constant series based on avg_price from portfolio_data.json
                root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
                data_path = os.path.join(root, "portfolio_data.json")
                with open(data_path, "r", encoding="utf-8") as f:
                    pdata = json.load(f)
                price = float(pdata["positions"].get(args.ticker, {}).get("avg_price", 0.0) or 0.0)
                end = pd.Timestamp.utcnow().normalize()
                idx = pd.date_range(end=end, periods=30, freq="D")
                series = pd.Series([price] * len(idx), index=idx, dtype="float64")
                df = pd.DataFrame({"Close": series})
            else:
                df = series_df

            series = df["Close"].dropna()
            series = series.sort_index()
            closes = series.astype("float64").tolist()
            times = [pd.Timestamp(t).to_pydatetime() for t in series.index]

            candles = []
            prev = None
            for i, close in enumerate(closes):
                open_ = float(prev) if prev is not None else float(close)
                high = max(open_, float(close)) * 1.002
                low = min(open_, float(close)) * 0.998
                candles.append(
                    {
                        "time": int(times[i].timestamp()),
                        "open": round(open_, 6),
                        "high": round(high, 6),
                        "low": round(low, 6),
                        "close": round(float(close), 6),
                    }
                )
                prev = close

            dq = DATA_QUALITY.get(args.ticker, {})
            out = {
                "ticker": args.ticker,
                "range": args.range,
                "chosenSource": dq.get("chosenSource"),
                "lastMedian": dq.get("lastMedian"),
                "candidates": dq.get("candidates", []),
                "candles": candles,
            }
            print(json.dumps(out, ensure_ascii=False))
        except Exception as e:
            # Never break chart mode: return empty candles with error info.
            print(json.dumps({"ticker": args.ticker, "error": str(e), "candles": []}, ensure_ascii=False))
        raise SystemExit(0)

    # Default contract: print ONE big JSON object to stdout.
    try:
        data = build_portfolio_json()
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        print(json.dumps(data, ensure_ascii=False))
    except Exception:
        # Fallback: last cached values (keeps API working during upstream outages).
        if os.path.exists(CACHE_PATH):
            with open(CACHE_PATH, "r", encoding="utf-8") as f:
                cached = json.load(f)
            print(json.dumps(cached, ensure_ascii=False))
        else:
            raise

