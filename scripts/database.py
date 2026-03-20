"""
SQLite portfolio store: data/portfolio.db
"""
from __future__ import annotations

import json
import os
import sqlite3
from collections import defaultdict, deque
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "portfolio.db"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _migrate_positions_schema(conn: sqlite3.Connection) -> None:
    """Add lifecycle columns (opened/closed, exit price) for older DBs."""
    cur = conn.execute("PRAGMA table_info(positions)")
    have = {str(r[1]) for r in cur.fetchall()}
    alters: List[str] = []
    if "status" not in have:
        alters.append("ALTER TABLE positions ADD COLUMN status TEXT DEFAULT 'open'")
    if "opened_at" not in have:
        alters.append("ALTER TABLE positions ADD COLUMN opened_at TEXT")
    if "closed_at" not in have:
        alters.append("ALTER TABLE positions ADD COLUMN closed_at TEXT")
    if "exit_price" not in have:
        alters.append("ALTER TABLE positions ADD COLUMN exit_price REAL")
    if "closed_shares" not in have:
        alters.append("ALTER TABLE positions ADD COLUMN closed_shares REAL")
    for sql in alters:
        conn.execute(sql)
    conn.execute(
        """
        UPDATE positions
        SET opened_at = COALESCE(opened_at, updated_at)
        WHERE opened_at IS NULL AND COALESCE(status, 'open') != 'closed'
        """
    )


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS positions (
                ticker TEXT PRIMARY KEY,
                avg_price REAL NOT NULL,
                shares REAL NOT NULL,
                currency TEXT NOT NULL,
                tees TEXT,
                target REAL DEFAULT 0,
                stop_loss REAL DEFAULT 0,
                source TEXT DEFAULT 'manual',
                market_price REAL,
                updated_at TEXT NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS position_lot_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticker TEXT NOT NULL,
                opened_at TEXT,
                closed_at TEXT NOT NULL,
                entry_avg_price REAL NOT NULL,
                exit_price REAL,
                shares REAL NOT NULL,
                currency TEXT NOT NULL,
                tees TEXT,
                target REAL,
                stop_loss REAL,
                source TEXT,
                market_price_at_close REAL,
                created_at TEXT NOT NULL
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_lot_history_ticker ON position_lot_history(ticker, closed_at DESC)")
        _migrate_positions_schema(conn)
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS price_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticker TEXT NOT NULL,
                ts INTEGER NOT NULL,
                open REAL,
                high REAL,
                low REAL,
                close REAL NOT NULL,
                volume INTEGER DEFAULT 0,
                UNIQUE(ticker, ts)
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_price_history_ticker_ts ON price_history(ticker, ts DESC)")
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS fundamentals (
                ticker TEXT PRIMARY KEY,
                pe REAL,
                forward_pe REAL,
                div_yield REAL,
                raw_json TEXT,
                updated_at TEXT NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS fx_rates (
                currency TEXT PRIMARY KEY,
                rate REAL NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS macro_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                label TEXT NOT NULL,
                value_text TEXT,
                raw REAL,
                chg REAL,
                chg_text TEXT,
                snapshot_at TEXT NOT NULL
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_macro_snapshot ON macro_data(snapshot_at DESC)")
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS portfolio_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                payload TEXT NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_analyses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticker TEXT,
                action TEXT,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS market_data_cache (
                cache_key TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS dividend_source_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticker TEXT NOT NULL,
                provider TEXT NOT NULL,
                years INTEGER NOT NULL,
                fetched_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )
            """
        )
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_div_src_ticker ON dividend_source_snapshots(ticker, provider, years, fetched_at DESC)"
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS dividend_display (
                ticker TEXT NOT NULL,
                years INTEGER NOT NULL,
                payments_json TEXT NOT NULL,
                display_avg_yield_pct REAL NOT NULL,
                currency TEXT,
                price_used REAL,
                years_in_avg INTEGER,
                analysis_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (ticker, years)
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS portfolio_overrides (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                margin_loan_eur REAL NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticker TEXT NOT NULL,
                action TEXT NOT NULL,
                shares REAL NOT NULL,
                price REAL NOT NULL,
                currency TEXT NOT NULL,
                fee REAL DEFAULT 0,
                date TEXT NOT NULL,
                notes TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_trades_ticker_date ON trades(ticker, date)")
        now0 = _utc_now_iso()
        c.execute(
            "INSERT OR IGNORE INTO portfolio_overrides (id, margin_loan_eur, updated_at) VALUES (1, 0, ?)",
            (now0,),
        )


# --- positions ---

_OPEN_SQL = "COALESCE(status, 'open') = 'open' AND shares > 1e-9"


def upsert_position(
    ticker: str,
    avg_price: float,
    shares: float,
    currency: str,
    tees: str = "",
    target: float = 0.0,
    stop_loss: float = 0.0,
    source: str = "manual",
    market_price: Optional[float] = None,
) -> None:
    """Insert/update an **open** lot. Preserves opened_at while the lot stays open; new opened_at after full close + re-buy."""
    now = _utc_now_iso()
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM positions WHERE ticker = ?", (ticker,)).fetchone()
        d = dict(row) if row else None

        if d is None:
            conn.execute(
                """
                INSERT INTO positions (
                    ticker, avg_price, shares, currency, tees, target, stop_loss, source, market_price,
                    updated_at, status, opened_at, closed_at, exit_price, closed_shares
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL, NULL)
                """,
                (
                    ticker,
                    float(avg_price),
                    float(shares),
                    currency,
                    tees,
                    float(target),
                    float(stop_loss),
                    source,
                    market_price,
                    now,
                    now,
                ),
            )
            return

        prev_status = (d.get("status") or "open").lower()
        if prev_status == "closed":
            conn.execute(
                """
                UPDATE positions SET
                    avg_price = ?,
                    shares = ?,
                    currency = ?,
                    tees = ?,
                    target = ?,
                    stop_loss = ?,
                    source = ?,
                    market_price = ?,
                    updated_at = ?,
                    status = 'open',
                    opened_at = ?,
                    closed_at = NULL,
                    exit_price = NULL,
                    closed_shares = NULL
                WHERE ticker = ?
                """,
                (
                    float(avg_price),
                    float(shares),
                    currency,
                    tees,
                    float(target),
                    float(stop_loss),
                    source,
                    market_price,
                    now,
                    now,
                    ticker,
                ),
            )
            return

        opened_at = d.get("opened_at") or now
        conn.execute(
            """
            UPDATE positions SET
                avg_price = ?,
                shares = ?,
                currency = ?,
                tees = ?,
                target = ?,
                stop_loss = ?,
                source = ?,
                market_price = ?,
                updated_at = ?,
                status = 'open',
                opened_at = ?
            WHERE ticker = ?
            """,
            (
                float(avg_price),
                float(shares),
                currency,
                tees,
                float(target),
                float(stop_loss),
                source,
                market_price,
                now,
                opened_at,
                ticker,
            ),
        )


def close_position(ticker: str, exit_price: Optional[float] = None) -> bool:
    """
    Archive an open lot to position_lot_history and mark the row closed (shares=0).
    exit_price defaults to last market_price, then avg_price.
    """
    now = _utc_now_iso()
    with get_connection() as conn:
        row = conn.execute(
            f"SELECT * FROM positions WHERE ticker = ? AND {_OPEN_SQL}",
            (ticker,),
        ).fetchone()
        if not row:
            return False
        d = dict(row)
        sh = float(d["shares"] or 0)
        if sh <= 0:
            return False
        avg = float(d["avg_price"] or 0)
        mkt = d.get("market_price")
        try:
            mkt_f = float(mkt) if mkt is not None and mkt != "" else None
        except (TypeError, ValueError):
            mkt_f = None
        ex = float(exit_price) if exit_price is not None else (mkt_f if mkt_f is not None else avg)

        conn.execute(
            """
            INSERT INTO position_lot_history (
                ticker, opened_at, closed_at, entry_avg_price, exit_price, shares, currency,
                tees, target, stop_loss, source, market_price_at_close, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                ticker,
                d.get("opened_at"),
                now,
                avg,
                ex,
                sh,
                str(d.get("currency") or "USD"),
                d.get("tees") or "",
                float(d.get("target") or 0),
                float(d.get("stop_loss") or 0),
                d.get("source") or "manual",
                mkt_f,
                now,
            ),
        )
        conn.execute(
            """
            UPDATE positions SET
                shares = 0,
                status = 'closed',
                closed_shares = ?,
                exit_price = ?,
                closed_at = ?,
                market_price = NULL,
                updated_at = ?
            WHERE ticker = ?
            """,
            (sh, ex, now, now, ticker),
        )
    return True


def sync_positions_from_portfolio_data(data: dict) -> Dict[str, int]:
    """
    Align SQLite with portfolio_data.json / IBKR merge: upsert all open lots; close lots that disappeared.
    Does **not** DELETE rows — closed tickers stay on `positions` (shares=0) and each close is copied to `position_lot_history`.
    """
    init_db()
    positions = data.get("positions") or {}
    json_open: Dict[str, Dict[str, Any]] = {}
    for t, p in positions.items():
        if not isinstance(p, dict):
            continue
        sh = float(p.get("shares") or 0)
        if sh <= 1e-9:
            continue
        json_open[str(t)] = p

    upserted = 0
    for ticker, p in json_open.items():
        upsert_position(
            ticker=ticker,
            avg_price=float(p.get("avg_price") or 0),
            shares=float(p.get("shares") or 0),
            currency=str(p.get("currency") or "USD"),
            tees=str(p.get("tees") or ""),
            target=float(p.get("target") or 0),
            stop_loss=float(p.get("stop_loss") or 0),
            source=str(p.get("source") or "manual"),
            market_price=float(p["market_price"]) if p.get("market_price") else None,
        )
        upserted += 1

    closed_lots = 0
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT ticker FROM positions WHERE {_OPEN_SQL}",
        ).fetchall()
    for r in rows:
        tk = str(r["ticker"])
        if tk not in json_open:
            if close_position(tk):
                closed_lots += 1

    return {"upserted": upserted, "closed_lots": closed_lots}


def get_positions() -> List[Dict[str, Any]]:
    """Active (open) positions only — for engine, charts, dashboard."""
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT * FROM positions WHERE {_OPEN_SQL} ORDER BY ticker",
        ).fetchall()
    return [dict(r) for r in rows]


def get_position(ticker: str) -> Optional[Dict[str, Any]]:
    """Single **open** position row (target/stop updates)."""
    with get_connection() as conn:
        row = conn.execute(
            f"SELECT * FROM positions WHERE ticker = ? AND {_OPEN_SQL}",
            (ticker,),
        ).fetchone()
    return dict(row) if row else None


def get_position_row_any_status(ticker: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM positions WHERE ticker = ?", (ticker,)).fetchone()
    return dict(row) if row else None


def list_position_lot_history(
    ticker: Optional[str] = None,
    limit: int = 500,
) -> List[Dict[str, Any]]:
    """Closed lots (for realized P&L / history). Newest first."""
    lim = max(1, min(int(limit), 10_000))
    with get_connection() as conn:
        if ticker:
            rows = conn.execute(
                """
                SELECT * FROM position_lot_history
                WHERE ticker = ?
                ORDER BY closed_at DESC, id DESC
                LIMIT ?
                """,
                (ticker, lim),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM position_lot_history
                ORDER BY closed_at DESC, id DESC
                LIMIT ?
                """,
                (lim,),
            ).fetchall()
    return [dict(r) for r in rows]


def update_position_overrides(
    ticker: str,
    *,
    target: Optional[float] = None,
    stop_loss: Optional[float] = None,
    tees: Optional[str] = None,
) -> bool:
    """Update only provided fields. Returns False if open ticker row is missing."""
    sets: List[str] = []
    vals: List[Any] = []
    if target is not None:
        sets.append("target = ?")
        vals.append(float(target))
    if stop_loss is not None:
        sets.append("stop_loss = ?")
        vals.append(float(stop_loss))
    if tees is not None:
        sets.append("tees = ?")
        vals.append(tees)
    if not sets:
        with get_connection() as conn:
            row = conn.execute(
                f"SELECT ticker FROM positions WHERE ticker = ? AND {_OPEN_SQL}",
                (ticker,),
            ).fetchone()
        return row is not None

    sets.append("updated_at = ?")
    vals.append(_utc_now_iso())
    with get_connection() as conn:
        row = conn.execute(
            f"SELECT ticker FROM positions WHERE ticker = ? AND {_OPEN_SQL}",
            (ticker,),
        ).fetchone()
        if not row:
            return False
        vals.append(ticker)
        conn.execute(f"UPDATE positions SET {', '.join(sets)} WHERE ticker = ?", vals)
    return True


def delete_all_positions() -> None:
    """Destructive: clears **open** state table only. Prefer sync_positions_from_portfolio_data. Does not clear lot history."""
    with get_connection() as conn:
        conn.execute("DELETE FROM positions")


# --- price_history ---


def save_price(
    ticker: str,
    ts: int,
    close: float,
    open_: Optional[float] = None,
    high: Optional[float] = None,
    low: Optional[float] = None,
    volume: int = 0,
) -> None:
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO price_history (ticker, ts, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker, ts) DO UPDATE SET
                open = excluded.open, high = excluded.high, low = excluded.low,
                close = excluded.close, volume = excluded.volume
            """,
            (ticker, ts, open_, high, low, close, volume),
        )


def get_latest_prices() -> Dict[str, float]:
    """Latest close per ticker."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT ph.ticker, ph.close FROM price_history ph
            INNER JOIN (
                SELECT ticker, MAX(ts) AS mx FROM price_history GROUP BY ticker
            ) x ON ph.ticker = x.ticker AND ph.ts = x.mx
            """
        ).fetchall()
    return {r["ticker"]: float(r["close"]) for r in rows}


def get_price_history(ticker: str, limit: int = 500) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM price_history WHERE ticker = ? ORDER BY ts DESC LIMIT ?",
            (ticker, limit),
        ).fetchall()
    return [dict(r) for r in rows]


# --- fundamentals ---


def save_fundamentals(
    ticker: str,
    pe: Optional[float] = None,
    forward_pe: Optional[float] = None,
    div_yield: Optional[float] = None,
    raw: Optional[Dict[str, Any]] = None,
) -> None:
    now = _utc_now_iso()
    raw_json = json.dumps(raw, ensure_ascii=False) if raw else None
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO fundamentals (ticker, pe, forward_pe, div_yield, raw_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker) DO UPDATE SET
                pe = excluded.pe, forward_pe = excluded.forward_pe, div_yield = excluded.div_yield,
                raw_json = excluded.raw_json, updated_at = excluded.updated_at
            """,
            (ticker, pe, forward_pe, div_yield, raw_json, now),
        )


def get_fundamentals(ticker: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM fundamentals WHERE ticker = ?", (ticker,)).fetchone()
    if not row:
        return None
    d = dict(row)
    if d.get("raw_json"):
        try:
            d["raw"] = json.loads(d["raw_json"])
        except json.JSONDecodeError:
            d["raw"] = None
    return d


# --- fx_rates ---


def save_fx_rate(currency: str, rate: float) -> None:
    now = _utc_now_iso()
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO fx_rates (currency, rate, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(currency) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at
            """,
            (currency, rate, now),
        )


def save_fx_rates_bulk(rates: Dict[str, float]) -> None:
    for cur, r in rates.items():
        save_fx_rate(cur, float(r))


def get_fx_rates() -> Dict[str, float]:
    with get_connection() as conn:
        rows = conn.execute("SELECT currency, rate FROM fx_rates").fetchall()
    return {r["currency"]: float(r["rate"]) for r in rows}


# --- macro_data ---


def save_macro_snapshot(items: List[Dict[str, Any]], snapshot_at: Optional[str] = None) -> None:
    at = snapshot_at or _utc_now_iso()
    with get_connection() as conn:
        for it in items:
            conn.execute(
                """
                INSERT INTO macro_data (label, value_text, raw, chg, chg_text, snapshot_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    it.get("label", ""),
                    it.get("value"),
                    it.get("raw"),
                    it.get("chg"),
                    it.get("chgText"),
                    at,
                ),
            )


def get_latest_macro() -> List[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT MAX(snapshot_at) AS mx FROM macro_data").fetchone()
        if not row or row["mx"] is None:
            return []
        mx = row["mx"]
        rows = conn.execute(
            "SELECT label, value_text AS value, raw, chg, chg_text AS chgText FROM macro_data WHERE snapshot_at = ? ORDER BY id",
            (mx,),
        ).fetchall()
    return [dict(r) for r in rows]


# --- market_data_cache (ticker history JSON, earnings JSON; reduces yfinance/API churn) ---


def _parse_cache_time(updated_at: str) -> Optional[datetime]:
    if not updated_at:
        return None
    try:
        s = updated_at.replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def market_cache_age_sec(updated_at: str) -> float:
    t = _parse_cache_time(updated_at)
    if t is None:
        return float("inf")
    now = datetime.now(timezone.utc)
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return max(0.0, (now - t).total_seconds())


def get_market_data_cache(cache_key: str) -> Optional[Tuple[Dict[str, Any], str]]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT payload, updated_at FROM market_data_cache WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row["payload"]), str(row["updated_at"])
    except json.JSONDecodeError:
        return None


def set_market_data_cache(cache_key: str, payload: Dict[str, Any]) -> None:
    now = _utc_now_iso()
    body = json.dumps(payload, ensure_ascii=False)
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO market_data_cache (cache_key, payload, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (cache_key, body, now),
        )


# --- dividend multi-source (snapshots = kõik allikad; display = kuvamiseks valitud) ---


def insert_dividend_source_snapshot(ticker: str, provider: str, years: int, payload: Dict[str, Any]) -> int:
    """Append-only: iga uue tõmbega uus rida (andmekvaliteedi audit)."""
    now = _utc_now_iso()
    body = json.dumps(payload, ensure_ascii=False)
    with get_connection() as conn:
        cur = conn.execute(
            """
            INSERT INTO dividend_source_snapshots (ticker, provider, years, fetched_at, payload_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (ticker, provider, int(years), now, body),
        )
        return int(cur.lastrowid or 0)


def upsert_dividend_display(
    ticker: str,
    years: int,
    payments: List[Dict[str, Any]],
    display_avg_yield_pct: float,
    currency: str,
    price_used: float,
    years_in_avg: int,
    analysis: Dict[str, Any],
) -> None:
    now = _utc_now_iso()
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO dividend_display (
                ticker, years, payments_json, display_avg_yield_pct, currency, price_used, years_in_avg, analysis_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker, years) DO UPDATE SET
                payments_json = excluded.payments_json,
                display_avg_yield_pct = excluded.display_avg_yield_pct,
                currency = excluded.currency,
                price_used = excluded.price_used,
                years_in_avg = excluded.years_in_avg,
                analysis_json = excluded.analysis_json,
                updated_at = excluded.updated_at
            """,
            (
                ticker,
                int(years),
                json.dumps(payments, ensure_ascii=False),
                float(display_avg_yield_pct),
                currency or "",
                float(price_used or 0),
                int(years_in_avg),
                json.dumps(analysis, ensure_ascii=False),
                now,
            ),
        )


def get_dividend_display(ticker: str, years: int) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute(
            """
            SELECT ticker, years, payments_json, display_avg_yield_pct, currency, price_used,
                   years_in_avg, analysis_json, updated_at
            FROM dividend_display WHERE ticker = ? AND years = ?
            """,
            (ticker, int(years)),
        ).fetchone()
    if not row:
        return None
    d = dict(row)
    raw_pay = d.pop("payments_json", "[]")
    raw_an = d.pop("analysis_json", "{}")
    try:
        d["payments"] = json.loads(raw_pay) if isinstance(raw_pay, str) else []
    except json.JSONDecodeError:
        d["payments"] = []
    try:
        d["analysis"] = json.loads(raw_an) if isinstance(raw_an, str) else {}
    except json.JSONDecodeError:
        d["analysis"] = {}
    if d.get("display_avg_yield_pct") is not None:
        d["display_avg_yield_pct"] = float(d["display_avg_yield_pct"])
    if d.get("price_used") is not None:
        d["price_used"] = float(d["price_used"])
    if d.get("years_in_avg") is not None:
        d["years_in_avg"] = int(d["years_in_avg"])
    return d


# --- portfolio_snapshots ---


def _portfolio_snapshot_max_rows() -> int:
    raw = os.environ.get("PORTFOLIO_SNAPSHOT_MAX_ROWS", "500").strip()
    try:
        n = int(raw)
    except ValueError:
        return 500
    return max(0, n)


def _prune_portfolio_snapshots(conn: sqlite3.Connection) -> None:
    """Keep the newest N rows (by id); 0 = unlimited."""
    cap = _portfolio_snapshot_max_rows()
    if cap <= 0:
        return
    row = conn.execute("SELECT COUNT(*) AS c FROM portfolio_snapshots").fetchone()
    cnt = int(row["c"]) if row else 0
    excess = cnt - cap
    if excess <= 0:
        return
    conn.execute(
        """
        DELETE FROM portfolio_snapshots WHERE id IN (
            SELECT id FROM portfolio_snapshots ORDER BY id ASC LIMIT ?
        )
        """,
        (excess,),
    )


def clear_portfolio_snapshots() -> None:
    """Delete all rows (e.g. after bad data); use scripts/reset_snapshots.py to re-seed."""
    with get_connection() as conn:
        conn.execute("DELETE FROM portfolio_snapshots")


def save_portfolio_snapshot(payload: Dict[str, Any]) -> int:
    now = _utc_now_iso()
    body = json.dumps(payload, ensure_ascii=False)
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO portfolio_snapshots (created_at, payload) VALUES (?, ?)",
            (now, body),
        )
        rid = int(cur.lastrowid or 0)
        _prune_portfolio_snapshots(conn)
        return rid


def get_latest_portfolio_snapshot() -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT payload FROM portfolio_snapshots ORDER BY id DESC LIMIT 1"
        ).fetchone()
    if not row:
        return None
    return json.loads(row["payload"])


def get_performance_history(limit: int = 5000) -> List[Dict[str, Any]]:
    """
    One row per saved portfolio snapshot, oldest→newest (for charts).
    Newest `limit` rows are taken when the table is larger than `limit`.
    Shapes match appendHistory in cron/scan: generatedAt, totalEur?, spyClose?.
    """
    cap = max(1, min(int(limit), 50_000))
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT created_at, payload FROM portfolio_snapshots
            ORDER BY id DESC LIMIT ?
            """,
            (cap,),
        ).fetchall()
    rows = list(reversed(rows))

    out: List[Dict[str, Any]] = []
    for r in rows:
        try:
            pl = json.loads(r["payload"])
        except json.JSONDecodeError:
            continue
        meta = pl.get("_snapshotMeta") or {}
        if meta.get("syntheticPeakAnchor") or pl.get("syntheticPeakAnchor"):
            continue
        gen = pl.get("generatedAt") or r["created_at"]
        if not gen:
            continue
        kpis = pl.get("kpis") or {}
        total = kpis.get("portfolioTotal")
        if (total is None or total == 0) and isinstance(pl.get("positions"), list):
            try:
                total = sum(float(p.get("eur") or 0) for p in pl["positions"])
            except (TypeError, ValueError):
                total = None
        spy_close: Optional[float] = None
        macro = pl.get("macro") or {}
        for item in macro.get("items") or []:
            if item.get("label") == "S&P500":
                raw = item.get("raw")
                if isinstance(raw, (int, float)) and float(raw) > 0:
                    spy_close = float(raw)
                break
        entry: Dict[str, Any] = {"generatedAt": gen}
        if isinstance(total, (int, float)) and float(total) > 0:
            entry["totalEur"] = float(total)
        if spy_close is not None:
            entry["spyClose"] = spy_close
        out.append(entry)
    return out


# --- ai_analyses ---


def save_ai_analysis(ticker: Optional[str], action: str, payload: Dict[str, Any]) -> None:
    now = _utc_now_iso()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO ai_analyses (ticker, action, payload, created_at) VALUES (?, ?, ?, ?)",
            (ticker, action, json.dumps(payload, ensure_ascii=False), now),
        )


def get_ai_analyses(ticker: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        if ticker:
            rows = conn.execute(
                "SELECT * FROM ai_analyses WHERE ticker = ? ORDER BY id DESC LIMIT ?",
                (ticker, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM ai_analyses ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["payload"] = json.loads(d["payload"])
        except json.JSONDecodeError:
            pass
        out.append(d)
    return out


# --- portfolio margin (singleton row id=1) ---


def upsert_portfolio_margin_loan_eur(margin_loan_eur: float) -> None:
    now = _utc_now_iso()
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO portfolio_overrides (id, margin_loan_eur, updated_at)
            VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET margin_loan_eur = excluded.margin_loan_eur, updated_at = excluded.updated_at
            """,
            (float(margin_loan_eur or 0), now),
        )


def get_portfolio_margin_loan_eur() -> float:
    with get_connection() as conn:
        row = conn.execute("SELECT margin_loan_eur FROM portfolio_overrides WHERE id = 1").fetchone()
    if not row:
        return 0.0
    return float(row["margin_loan_eur"] or 0)


# --- trades → realized P&L (FIFO, EUR, current FX on all legs) ---


def _trade_cash_to_eur(amount: float, currency: str, fx_rates: Dict[str, float]) -> float:
    cur = (currency or "EUR").upper()
    if cur == "EUR":
        return float(amount)
    if cur == "USD":
        return float(amount) * float(fx_rates.get("USD") or 0)
    if cur == "GBP":
        return float(amount) * float(fx_rates.get("GBP") or 0)
    if cur == "NOK":
        return float(amount) * float(fx_rates.get("NOK") or 0)
    if cur == "DKK":
        return float(amount) * float(fx_rates.get("DKK") or 0)
    if cur == "GBX":
        return (float(amount) / 100.0) * float(fx_rates.get("GBP") or 0)
    return float(amount)


def list_trades_chronological() -> List[Dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM trades ORDER BY date ASC, id ASC").fetchall()
    return [dict(r) for r in rows]


def compute_realized_pnl_eur_from_trades(fx_rates: Dict[str, float]) -> float:
    """
    FIFO realized P&L in EUR (approximation: kõik tehingud konverteeritakse praeguste kurssidega).
    Tühi tabel → 0.
    """
    rows = list_trades_chronological()
    if not rows:
        return 0.0
    fifo: Dict[str, deque] = defaultdict(deque)  # deque of [shares_left, cost_eur_per_share]
    realized = 0.0
    for r in rows:
        tk = str(r.get("ticker") or "").strip()
        if not tk:
            continue
        action = str(r.get("action") or "").lower().strip()
        sh = float(r.get("shares") or 0)
        pr = float(r.get("price") or 0)
        cur = str(r.get("currency") or "EUR")
        fee = float(r.get("fee") or 0)
        if sh <= 0 or pr < 0:
            continue
        fee_eur = _trade_cash_to_eur(fee, cur, fx_rates)
        if action == "buy":
            gross_eur = _trade_cash_to_eur(sh * pr, cur, fx_rates)
            cost_total = gross_eur + fee_eur
            cps = cost_total / sh
            fifo[tk].append([sh, cps])
        elif action == "sell":
            gross_eur = _trade_cash_to_eur(sh * pr, cur, fx_rates)
            proceeds = gross_eur - fee_eur
            rem = sh
            cost_matched = 0.0
            while rem > 1e-9 and fifo[tk]:
                lot = fifo[tk][0]
                lot_sh, lot_cps = float(lot[0]), float(lot[1])
                take = min(rem, lot_sh)
                cost_matched += take * lot_cps
                lot_sh -= take
                rem -= take
                if lot_sh <= 1e-9:
                    fifo[tk].popleft()
                else:
                    lot[0] = lot_sh
            realized += proceeds - cost_matched
    return round(realized, 0)


def compute_drawdown_pct_from_snapshots(current_total_eur: float) -> Optional[float]:
    """
    drawdown = (current - peak) / peak * 100; peak = max(portfolio total kõigist snapshotidest).
    None kui ajalugu < 2 kehtivat punkti või peak <= 0.
    """
    if current_total_eur <= 0:
        return None
    with get_connection() as conn:
        rows = conn.execute("SELECT payload FROM portfolio_snapshots ORDER BY id ASC").fetchall()
    totals: List[float] = []
    for r in rows:
        try:
            pl = json.loads(r["payload"])
            kpis = pl.get("kpis") or {}
            t = kpis.get("portfolioTotal")
            if t is not None and float(t) > 0:
                totals.append(float(t))
            elif isinstance(pl.get("positions"), list):
                s = sum(float(p.get("eur") or 0) for p in pl["positions"])
                if s > 0:
                    totals.append(float(s))
        except Exception:
            continue
    totals.append(float(current_total_eur))
    usable = [x for x in totals if x > 0]
    if len(usable) < 2:
        return None
    peak = max(usable)
    if peak <= 0:
        return None
    return round((float(current_total_eur) - peak) / peak * 100.0, 1)
