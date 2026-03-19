"""
Multi-source data providers with automatic fallback.
FMP and Alpha Vantage require API keys in env. Yahoo HTTP is free fallback.
"""
import math
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
import requests
import yfinance as yf

# Alpha Vantage ticker mapping (different from yfinance/FMP)
AV_TICKER_MAP = {
    "EQNR.OL": "EQNR.OSL",
    "AKRBP.OL": "AKRBP.OSL",
    "NOVO-B.CO": "NOVO-B.CPH",
    "UPM.HE": "UPM.HEL",
    "A8X.F": "A8X.FRK",
    "LGEN.L": "LGEN.LON",
    "INPP.L": "INPP.LON",
    "HICL.L": "HICL.LON",
    "SEQI.L": "SEQI.LON",
    "SUPR.L": "SUPR.LON",
    "TRIG.L": "TRIG.LON",
    "IS04.L": "IS04.LON",
}

GBX_TICKERS = {"INPP.L", "SEQI.L", "HICL.L", "SUPR.L", "TRIG.L", "LGEN.L", "IS04.L"}

# Simple in-memory cache (5 min TTL)
_CACHE: Dict[str, tuple] = {}
_CACHE_TTL = 5 * 60


def _cached(key: str, fetch_fn):
    now = time.time()
    if key in _CACHE:
        val, ts = _CACHE[key]
        if now - ts < _CACHE_TTL:
            return val
    try:
        val = fetch_fn()
        _CACHE[key] = (val, now)
        return val
    except Exception:
        raise


def _av_symbol(ticker: str) -> str:
    return AV_TICKER_MAP.get(ticker, ticker)


class YFinanceProvider:
    """Allikas 1: yfinance Python teek"""

    def get_price(self, ticker: str) -> Optional[float]:
        try:
            t = yf.Ticker(ticker)
            info = t.info or {}
            price = info.get("regularMarketPrice") or info.get("currentPrice") or info.get("previousClose")
            if price is not None and float(price) > 0:
                return float(price)
            hist = t.history(period="5d", interval="1d")
            if not hist.empty and "Close" in hist.columns:
                return float(hist["Close"].iloc[-1])
        except Exception:
            pass
        return None

    def get_history(self, ticker: str, period: str = "1y") -> pd.DataFrame:
        try:
            df = yf.download(ticker, period=period, interval="1d", progress=False, auto_adjust=False)
            if df.empty or "Close" not in df.columns:
                return pd.DataFrame()
            cols = [c for c in ["Open", "High", "Low", "Close", "Volume"] if c in df.columns]
            return df[cols].dropna(subset=["Close"])
        except Exception:
            return pd.DataFrame()

    def get_fundamentals(self, ticker: str) -> Dict[str, Any]:
        try:
            info = yf.Ticker(ticker).info or {}
            pe = info.get("trailingPE")
            fpe = info.get("forwardPE")
            ev_ebitda = info.get("enterpriseToEbitda")
            roe = info.get("returnOnEquity")
            div_yield = info.get("dividendYield") or info.get("trailingAnnualDividendYield")
            if div_yield and div_yield > 1:
                div_yield = div_yield / 100.0
            payout = info.get("payoutRatio")
            rev_growth = info.get("revenueGrowth")
            eps_growth = info.get("earningsGrowth")
            return {
                "pe": float(pe) if pe is not None else None,
                "fwd_pe": float(fpe) if fpe is not None else None,
                "ev_ebitda": float(ev_ebitda) if ev_ebitda is not None else None,
                "roe": float(roe) if roe is not None else None,
                "div_yield": float(div_yield) * 100 if div_yield else None,
                "payout_ratio": float(payout) if payout is not None else None,
                "revenue_growth": float(rev_growth) * 100 if rev_growth else None,
                "eps_growth": float(eps_growth) * 100 if eps_growth else None,
            }
        except Exception:
            return {}

    def get_earnings(self, ticker: str) -> List[Dict]:
        try:
            df = yf.Ticker(ticker).get_earnings_dates(limit=8)
            if df is None or df.empty:
                return []
            out = []
            for idx, row in df.tail(8).iterrows():
                out.append({
                    "date": str(idx)[:10] if hasattr(idx, "__str__") else "",
                    "eps": row.get("Reported EPS"),
                    "revenue": None,
                    "surprise": row.get("Surprise(%)"),
                })
            return out
        except Exception:
            return []

    def get_dividends(self, ticker: str) -> List[Dict]:
        try:
            divs = yf.Ticker(ticker).dividends
            if divs is None or divs.empty:
                return []
            return [{"date": str(d)[:10], "amount": float(v)} for d, v in divs.tail(12).items()]
        except Exception:
            return []

    def get_news(self, ticker: str) -> List[Dict]:
        try:
            news = yf.Ticker(ticker).news or []
            return [{"title": n.get("title", ""), "url": n.get("link", ""), "published": n.get("providerPublishTime")} for n in news[:10]]
        except Exception:
            return []


class FMPProvider:
    """Allikas 2: Financial Modeling Prep API"""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.environ.get("FMP_API_KEY", "")
        self.base = "https://financialmodelingprep.com/api/v3"

    def _get(self, path: str, params: Optional[Dict] = None) -> Any:
        if not self.api_key:
            raise ValueError("FMP_API_KEY not set")
        url = f"{self.base}{path}"
        p = dict(params or {})
        p["apikey"] = self.api_key
        r = requests.get(url, params=p, timeout=15)
        r.raise_for_status()
        return r.json()

    def get_price(self, ticker: str) -> Optional[float]:
        try:
            data = self._get(f"/quote/{ticker}")
            if isinstance(data, list) and data:
                price = data[0].get("price") or data[0].get("close")
                if price is not None and float(price) > 0:
                    return float(price)
        except Exception:
            pass
        return None

    def get_history(self, ticker: str, period: str = "1y") -> pd.DataFrame:
        try:
            data = self._get(f"/historical-price-full/{ticker}")
            if not isinstance(data, dict) or "historical" not in data:
                return pd.DataFrame()
            hist = data["historical"]
            if not hist:
                return pd.DataFrame()
            df = pd.DataFrame(hist)
            df["date"] = pd.to_datetime(df["date"])
            df = df.set_index("date").sort_index()
            cols = [c for c in ["open", "high", "low", "close", "volume"] if c in df.columns]
            df = df[cols].rename(columns={"open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"})
            if period == "3mo":
                df = df.tail(70)
            elif period == "6mo":
                df = df.tail(130)
            elif period == "1y":
                df = df.tail(260)
            return df.dropna(subset=["Close"])
        except Exception:
            return pd.DataFrame()

    def get_fundamentals(self, ticker: str) -> Dict[str, Any]:
        try:
            out = {}
            metrics = self._get(f"/key-metrics-ttm/{ticker}")
            ratios = self._get(f"/ratios-ttm/{ticker}")
            if isinstance(metrics, list) and metrics:
                m = metrics[0]
                out["pe"] = m.get("peRatioTTM")
                out["ev_ebitda"] = m.get("enterpriseValueOverEBITDATTM")
                out["roe"] = m.get("roeTTM")
            if isinstance(ratios, list) and ratios:
                r = ratios[0]
                out["pe"] = out.get("pe") or r.get("priceEarningsRatio")
                out["div_yield"] = r.get("dividendYield")
                if out.get("div_yield") and out["div_yield"] < 1:
                    out["div_yield"] = out["div_yield"] * 100
                out["payout_ratio"] = r.get("payoutRatio")
            return {k: float(v) for k, v in out.items() if v is not None}
        except Exception:
            return {}

    def get_earnings(self, ticker: str) -> List[Dict]:
        try:
            data = self._get(f"/income-statement/{ticker}", {"period": "quarter", "limit": 8})
            if not isinstance(data, list) or len(data) < 4:
                return []
            out = []
            for item in data[:8]:
                rev = item.get("revenue")
                eps = item.get("eps")
                if eps is None and item.get("netIncome") and item.get("weightedAverageShsOut"):
                    try:
                        eps = item["netIncome"] / item["weightedAverageShsOut"]
                    except Exception:
                        pass
                out.append({
                    "date": item.get("date", "")[:10],
                    "revenue": float(rev) if rev is not None else None,
                    "eps": float(eps) if eps is not None else None,
                })
            return out
        except Exception:
            return []

    def get_dividends(self, ticker: str) -> List[Dict]:
        try:
            data = self._get(f"/historical-price-full/stock_dividend/{ticker}")
            if not isinstance(data, dict) or "historical" not in data:
                return []
            return [{"date": h.get("date", "")[:10], "amount": float(h.get("dividend", 0))} for h in data["historical"][:12]]
        except Exception:
            return []

    def get_news(self, ticker: str) -> List[Dict]:
        try:
            data = self._get("/stock_news", {"tickers": ticker, "limit": 10})
            if not isinstance(data, list):
                return []
            return [{"title": n.get("title", ""), "url": n.get("url", ""), "published": n.get("publishedDate")} for n in data]
        except Exception:
            return []


class AlphaVantageProvider:
    """Allikas 3: Alpha Vantage API"""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.environ.get("ALPHA_VANTAGE_API_KEY", "")
        self.base = "https://www.alphavantage.co/query"

    def _get(self, params: Dict) -> Any:
        if not self.api_key:
            raise ValueError("ALPHA_VANTAGE_API_KEY not set")
        p = dict(params)
        p["apikey"] = self.api_key
        r = requests.get(self.base, params=p, timeout=15)
        r.raise_for_status()
        return r.json()

    def get_price(self, ticker: str) -> Optional[float]:
        try:
            sym = _av_symbol(ticker)
            data = self._get({"function": "GLOBAL_QUOTE", "symbol": sym})
            quote = data.get("Global Quote", {})
            price = quote.get("05. price") or quote.get("08. previous close")
            if price and float(price) > 0:
                return float(price)
        except Exception:
            pass
        return None

    def get_history(self, ticker: str, period: str = "1y") -> pd.DataFrame:
        try:
            sym = _av_symbol(ticker)
            data = self._get({"function": "TIME_SERIES_DAILY", "symbol": sym, "outputsize": "full"})
            key = "Time Series (Daily)"
            if key not in data:
                return pd.DataFrame()
            series = data[key]
            rows = [{"date": d, "open": float(v["1. open"]), "high": float(v["2. high"]), "low": float(v["3. low"]), "close": float(v["4. close"]), "volume": int(float(v["5. volume"]))} for d, v in series.items()]
            df = pd.DataFrame(rows)
            df["date"] = pd.to_datetime(df["date"])
            df = df.set_index("date").sort_index()
            if period == "3mo":
                df = df.tail(70)
            elif period == "6mo":
                df = df.tail(130)
            else:
                df = df.tail(260)
            return df
        except Exception:
            return pd.DataFrame()

    def get_fundamentals(self, ticker: str) -> Dict[str, Any]:
        try:
            sym = _av_symbol(ticker)
            data = self._get({"function": "OVERVIEW", "symbol": sym})
            out = {}
            pe = data.get("PERatio")
            fpe = data.get("ForwardPE")
            ev = data.get("EVToEBITDA")
            roe = data.get("ReturnOnEquityTTM")
            div = data.get("DividendYield")
            if pe and pe != "None":
                out["pe"] = float(pe)
            if fpe and fpe != "None":
                out["fwd_pe"] = float(fpe)
            if ev and ev != "None":
                out["ev_ebitda"] = float(ev)
            if roe and roe != "None":
                out["roe"] = float(roe)
            if div and div != "None":
                d = float(div)
                out["div_yield"] = d * 100 if d < 1 else d
            return out
        except Exception:
            return {}

    def get_earnings(self, ticker: str) -> List[Dict]:
        try:
            sym = _av_symbol(ticker)
            data = self._get({"function": "EARNINGS", "symbol": sym})
            q = data.get("quarterlyEarnings", [])
            if not q or len(q) < 4:
                return []
            out = []
            for x in q[:8]:
                eps = x.get("reportedEPS")
                try:
                    eps = float(eps) if eps not in (None, "None", "") else None
                except (ValueError, TypeError):
                    eps = None
                out.append({"date": x.get("fiscalDateEnding", "")[:10], "eps": eps, "revenue": None})
            return out
        except Exception:
            return []

    def get_news(self, ticker: str) -> List[Dict]:
        return []


class YahooHTTPProvider:
    """Allikas 4: Yahoo Finance otse HTTP (fallback, pole API key vaja)"""

    def get_price(self, ticker: str) -> Optional[float]:
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=1d&interval=5m"
            r = requests.get(url, timeout=10)
            r.raise_for_status()
            j = r.json()
            meta = j.get("chart", {}).get("result", [{}])[0].get("meta", {})
            price = meta.get("regularMarketPrice") or meta.get("previousClose")
            if price and float(price) > 0:
                return float(price)
        except Exception:
            pass
        return None

    def get_history(self, ticker: str, period: str = "1y") -> pd.DataFrame:
        try:
            rng = "1y" if period == "1y" else "3mo" if period == "3mo" else "6mo"
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range={rng}&interval=1d"
            r = requests.get(url, timeout=15)
            r.raise_for_status()
            j = r.json()
            res = j.get("chart", {}).get("result", [{}])[0]
            ts = res.get("timestamp", [])
            q = res.get("indicators", {}).get("quote", [{}])[0]
            if not ts or not q.get("close"):
                return pd.DataFrame()
            closes = q["close"]
            opens = q.get("open", closes)
            highs = q.get("high", closes)
            lows = q.get("low", closes)
            vols = q.get("volume", [0] * len(ts))
            idx = pd.to_datetime(ts, unit="s")
            df = pd.DataFrame({"Open": opens, "High": highs, "Low": lows, "Close": closes, "Volume": vols}, index=idx)
            df = df.dropna(subset=["Close"])
            return df
        except Exception:
            return pd.DataFrame()


class DataAggregator:
    """Koondab andmed mitmest allikast, valib parima"""

    def __init__(self):
        self.yf = YFinanceProvider()
        self.fmp = FMPProvider()
        self.av = AlphaVantageProvider()
        self.yahoo_http = YahooHTTPProvider()

    def _is_gbx(self, ticker: str) -> bool:
        return ticker in GBX_TICKERS or (ticker.endswith(".L") and ticker not in GBX_TICKERS)

    def _normalize_price(self, ticker: str, price: float, source: str) -> float:
        """FMP/AV return GBP in pounds; yf/yahoo_http return pence for .L"""
        if not (ticker.endswith(".L") or ticker in GBX_TICKERS):
            return price
        if source in ("fmp", "alpha_vantage"):
            return price  # already in pounds
        return price / 100.0  # pence -> pounds

    PRICE_PRIORITY = ["ibkr", "fmp", "yfinance", "yahoo_http", "alpha_vantage"]

    def _detect_outliers(self, results: Dict[str, float], pct_threshold: float = 5.0) -> List[str]:
        if len(results) < 2:
            return []
        prices = list(results.values())
        mean = sum(prices) / len(prices)
        variance = sum((p - mean) ** 2 for p in prices) / len(prices)
        std = math.sqrt(variance) if variance > 0 else 0
        if std == 0:
            return []
        outliers = []
        for name, p in results.items():
            if mean != 0 and abs(p - mean) / abs(mean) > pct_threshold / 100:
                outliers.append(name)
        return outliers

    def _count_agreeing_sources(self, results: Dict[str, float], outliers: List[str], pct_tolerance: float = 2.0) -> int:
        valid = {k: v for k, v in results.items() if k not in outliers}
        if len(valid) < 2:
            return len(valid)
        prices = list(valid.values())
        mean = sum(prices) / len(prices)
        count = 0
        for p in prices:
            if mean != 0 and abs(p - mean) / abs(mean) <= pct_tolerance / 100:
                count += 1
        return max(count, 1)

    def get_price(
        self, ticker: str, ibkr_price: Optional[float] = None, ibkr_sync_age_hours: Optional[float] = None
    ) -> Dict[str, Any]:
        results: Dict[str, float] = {}
        if ibkr_price and ibkr_price > 0 and ibkr_sync_age_hours is not None and ibkr_sync_age_hours < 24:
            results["ibkr"] = float(ibkr_price)

        for name, provider in [("yfinance", self.yf), ("fmp", self.fmp), ("yahoo_http", self.yahoo_http), ("alpha_vantage", self.av)]:
            try:
                price = provider.get_price(ticker)
                if price is not None and price > 0:
                    norm = self._normalize_price(ticker, price, name)
                    results[name] = round(norm, 4)
            except Exception:
                pass

        if not results:
            return {
                "price": 0.0,
                "source": "none",
                "all_sources": {},
                "data_quality": {
                    "price_source": "none",
                    "price_confidence": "low",
                    "all_prices": {},
                    "outliers": [],
                    "conflict": False,
                },
            }

        outliers = self._detect_outliers(results, pct_threshold=5.0)
        valid = {k: v for k, v in results.items() if k not in outliers}

        conflict = False
        if len(valid) >= 2:
            prices = list(valid.values())
            mean = sum(prices) / len(prices)
            max_dev = max(abs(p - mean) / abs(mean) * 100 for p in prices) if mean else 0
            conflict = max_dev > 2.0

        agree_count = self._count_agreeing_sources(results, outliers, pct_tolerance=2.0)
        if agree_count >= 3:
            confidence = "high"
        elif agree_count >= 2:
            confidence = "medium"
        else:
            confidence = "low"

        best_source = None
        for name in self.PRICE_PRIORITY:
            if name in valid:
                best_source = name
                break
        if not best_source and valid:
            best_source = next(iter(valid))

        chosen_price = results[best_source] if best_source else 0.0

        return {
            "price": chosen_price,
            "source": best_source or "none",
            "all_sources": results,
            "data_quality": {
                "price_source": best_source or "none",
                "price_confidence": confidence,
                "all_prices": {k: round(v, 4) for k, v in results.items()},
                "outliers": outliers,
                "conflict": conflict,
            },
        }

    FUNDAMENTALS_PRIORITY = ["fmp", "alpha_vantage", "yfinance"]

    def get_fundamentals(self, ticker: str) -> Dict[str, Any]:
        fmp_data: Dict[str, Any] = {}
        yf_data: Dict[str, Any] = {}
        av_data: Dict[str, Any] = {}
        try:
            fmp_data = self.fmp.get_fundamentals(ticker)
        except Exception:
            pass
        try:
            yf_data = self.yf.get_fundamentals(ticker)
        except Exception:
            pass
        try:
            av_data = self.av.get_fundamentals(ticker)
        except Exception:
            pass

        def pick(*keys):
            for k in keys:
                for d in (fmp_data, av_data, yf_data):
                    v = d.get(k)
                    if v is not None:
                        return v
            return None

        def pick_by_priority(key: str, alt_key: Optional[str] = None):
            for name in self.FUNDAMENTALS_PRIORITY:
                d = {"fmp": fmp_data, "alpha_vantage": av_data, "yfinance": yf_data}[name]
                v = d.get(key) or (d.get(alt_key) if alt_key else None)
                if v is not None:
                    return v
            return None

        pe_by_source: Dict[str, float] = {}
        for name, d in [("fmp", fmp_data), ("alpha_vantage", av_data), ("yfinance", yf_data)]:
            v = d.get("pe")
            if v is not None and float(v) > 0:
                pe_by_source[name] = float(v)

        pe_conflict = False
        if len(pe_by_source) >= 2:
            vals = list(pe_by_source.values())
            mean_pe = sum(vals) / len(vals)
            max_dev = max(abs(v - mean_pe) / mean_pe * 100 for v in vals) if mean_pe else 0
            pe_conflict = max_dev > 20.0

        chosen_pe = pick_by_priority("pe") or pick("pe")

        out: Dict[str, Any] = {
            "pe": chosen_pe,
            "fwd_pe": pick_by_priority("fwd_pe", "fpe") or pick("fwd_pe", "fpe"),
            "ev_ebitda": pick("ev_ebitda"),
            "roe": pick("roe"),
            "div_yield": pick("div_yield"),
            "payout_ratio": pick("payout_ratio"),
            "revenue_growth": pick("revenue_growth"),
            "eps_growth": pick("eps_growth"),
            "source": "fmp" if fmp_data else ("alpha_vantage" if av_data else "yfinance"),
        }
        if pe_by_source:
            out["pe_all_sources"] = pe_by_source
        if pe_conflict:
            out["pe_conflict"] = True
        return out

    def get_earnings_history(self, ticker: str) -> List[Dict]:
        data, _ = self.get_earnings_with_source(ticker)
        return data

    def get_earnings_with_source(self, ticker: str) -> tuple:
        """Returns (list of earnings dicts, source_name)"""
        for name, provider in [("fmp", self.fmp), ("alpha_vantage", self.av), ("yfinance", self.yf)]:
            try:
                data = provider.get_earnings(ticker)
                if data and len(data) >= 4:
                    return (data, name)
            except Exception:
                pass
        return ([], "none")

    def get_history(self, ticker: str, period: str = "1y") -> pd.DataFrame:
        df, _ = self.get_history_with_source(ticker, period)
        return df

    def get_history_with_source(self, ticker: str, period: str = "1y") -> tuple:
        """Returns (DataFrame, source_name)"""
        for name, provider in [("yfinance", self.yf), ("fmp", self.fmp), ("yahoo_http", self.yahoo_http), ("alpha_vantage", self.av)]:
            try:
                h = provider.get_history(ticker, period)
                if h is not None and len(h) > 20:
                    if ticker.endswith(".L") or ticker in GBX_TICKERS:
                        if name in ("yfinance", "yahoo_http"):
                            for c in ["Open", "High", "Low", "Close"]:
                                if c in h.columns:
                                    h[c] = h[c] / 100.0
                    return (h, name)
            except Exception:
                pass
        return (pd.DataFrame(), "none")
