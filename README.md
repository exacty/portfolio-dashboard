This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Portfolio SQLite (`data/portfolio.db`)

**Lihtne mudel (ET):** välisandmed tulevad sisse **refresh’i** ajal → salvestuvad **SQLite**’i → UI loeb **API kaudu DB-st**. Täpsem joonis: [`docs/ANDMEVOOD.md`](docs/ANDMEVOOD.md).

Täis uuendus (portfell + tickerite graafik/earnings cache, kui env lubab):

```bash
python3 scripts/full_refresh.py
```

`/api/portfolio` reads the latest snapshot via `scripts/db_reader.py` (fast). After clone:

```bash
python3 scripts/migrate.py              # sync positions from JSON + run portfolio_engine + save snapshot
python3 scripts/migrate.py --skip-engine # sync positions only; then: python3 scripts/refresh_portfolio.py
```

The DB file is gitignored under `data/`.

**Müük / ajalugu:** `migrate.py` ja IBKR-järgne sünk **ei kustuta** SQLite ridu. Kui ticker kaob `portfolio_data.json`-ist (müük), avatud lot suletakse: kirje jääb `positions` ridadeks (`status=closed`, `shares=0`, `closed_at`, `exit_price`, …) ja **arhiiv** kopeeritakse tabelisse **`position_lot_history`** (ostu/keskmine hind, müügihetk, väljumishind, aktsiad) — hiljem saab arvutada realiseeritud tootlust. Uuesti ostes sama tickerit kirjutatakse sama rida uuesti lahti (`opened_at` uuendub). Vaata: `python3 scripts/print_lot_history.py [TICKER] [LIMIT]`.

**Saving target / stop / tees:** `POST /api/portfolio` with `{ "action": "update", "ticker", "target"?, "stop_loss"?, "tees"? }` updates SQLite `positions` (and mirrors into `portfolio_data.json` if that ticker exists there), then triggers a background `refresh_portfolio.py`. Requires the ticker to exist in the DB (`migrate.py` first).

**Market data cache:** `/api/ticker-history`, `/api/ticker-earnings`, and `/api/ticker-dividends` read/write JSON in SQLite (`market_data_cache` via `scripts/market_data_fetch.py`) so repeat page loads avoid yfinance on every request. Defaults: history **4h**, earnings **24h**, dividends **24h** (override with `MARKET_CACHE_HISTORY_TTL_SEC` / `MARKET_CACHE_EARNINGS_TTL_SEC` / `MARKET_CACHE_DIVIDENDS_TTL_SEC`). Add **`?refresh=1`** to force a new upstream fetch and DB update.

**Dividend quality (SQLite):** Each refresh appends rows to **`dividend_source_snapshots`** (per provider: yfinance, optional FMP with `FMP_API_KEY`). The resolved chart series + **`displayAvgAnnualYieldPct`** live in **`dividend_display`** (one row per `ticker` + `years`). Pipeline: `scripts/dividend_pipeline.py`; API still goes through `market_data_fetch.py dividends`.

**Snapshots:** Each `refresh_portfolio` append is capped with `PORTFOLIO_SNAPSHOT_MAX_ROWS` (default **500**); set `0` to disable pruning.

**Snapshot reset (vale ajalugu):** kustutab kõik `portfolio_snapshots` read, lisab drawdowni ankrusnapshoti (vaikimisi max **€2.27M**) ja salvestab ühe värske `portfolio_engine` väljundi. Ankrurida märgitakse sünteetiliseks ja seda ei kasutata performance chartis. Kasuta sama Pythoni keskkonda kus on `numpy` (nt `scripts/.venv`).

```bash
python3 scripts/reset_snapshots.py
python3 scripts/reset_snapshots.py --peak 2270000
```

**IBKR margin (`portfolio_meta.margin_loan`):** pärast `/api/ibkr-sync` arvutatakse `margin_loan ≈ max(0, positsioonide kogumark EUR − NetLiquidation EUR)`. Flex päringus peab olema **NetLiquidation** (Account / Equity summary); ilma selleta jäetakse `portfolio_data.json` olemasolev `margin_loan` alles.

**Performance chart:** `/api/performance` prefers SQLite snapshot history when there are enough points (≥2 with `totalEur`); otherwise falls back to `results/history.json` (cron scan).

**Sectors page:** `/api/sectors` reads the same SQLite snapshot as `/api/portfolio` (no extra full engine run).

**Still JSON-only:** `/positions` and `/api/portfolio-data` edit `portfolio_data.json` (migrate later if you want a single store).

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
