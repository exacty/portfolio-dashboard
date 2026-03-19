#!/usr/bin/env python3
"""Fetch quarterly earnings for CANSLIM chart. Outputs JSON."""
import json
import sys

try:
    import yfinance as yf
except ImportError:
    print(json.dumps({"ticker": "", "quarterlyEarnings": [], "canslim": {}}))
    sys.exit(0)

def main():
    ticker = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
    if not ticker:
        print(json.dumps({"ticker": "", "quarterlyEarnings": [], "canslim": {}}))
        return

    out: list = []
    t = yf.Ticker(ticker)

    try:
        qis = t.quarterly_income_stmt
        if qis is not None and hasattr(qis, "columns"):
            for col in qis.columns:
                row = qis[col]
                eps = None
                for key in ["Basic EPS", "Diluted EPS", "Net Income"]:
                    if hasattr(row, "index") and key in row.index:
                        val = row[key]
                        if val is not None and str(val) != "nan":
                            try:
                                eps = float(val)
                                break
                            except (ValueError, TypeError):
                                pass
                date_str = str(col)[:10] if col else ""
                if eps is not None:
                    out.append({"date": date_str, "eps": eps})
    except Exception:
        pass

    # Sort by date descending (newest first), then reverse for chart (oldest first)
    out.sort(key=lambda x: x["date"], reverse=True)
    out = out[:8]  # last 8 quarters
    out.reverse()

    # Compute EPS growth %
    for i in range(1, len(out)):
        prev = out[i - 1].get("eps")
        curr = out[i].get("eps")
        if prev and curr and prev != 0:
            out[i]["epsGrowth"] = round(((curr - prev) / abs(prev)) * 100, 1)

    # CANSLIM placeholder (simplified)
    canslim = {
        "C": "Current earnings" + (f": {out[-1]['eps']:.2f}" if out and out[-1].get("eps") else " —"),
        "A": "Annual earnings growth",
        "N": "New product/high",
        "S": "Supply & demand",
        "L": "Leader/laggard",
        "I": "Institutional",
        "M": "Market direction",
    }

    result = {"ticker": ticker, "quarterlyEarnings": out, "canslim": canslim}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
