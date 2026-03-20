-- Phase 1A: Minimal Postgres schema for portfolio-dashboard
-- Run with: npm run db:migrate

-- accounts: portfolio accounts (e.g. IBKR, manual)
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'default',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- holdings: position-level data (maps to portfolio_data.json positions)
CREATE TABLE IF NOT EXISTS holdings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  avg_price NUMERIC(20, 8) NOT NULL,
  shares NUMERIC(20, 6) NOT NULL,
  currency TEXT NOT NULL,
  tees TEXT,
  target NUMERIC(20, 4),
  stop_loss NUMERIC(20, 4),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('ibkr', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, ticker)
);

CREATE INDEX IF NOT EXISTS holdings_ticker_idx ON holdings(ticker);
CREATE INDEX IF NOT EXISTS holdings_account_idx ON holdings(account_id);

-- fx_rates: currency -> EUR rate (maps to portfolio_data.json fx_rates)
CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT PRIMARY KEY,
  rate NUMERIC(20, 8) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- broker_snapshots: scan snapshots (maps to results/last_scan.json)
CREATE TABLE IF NOT EXISTS broker_snapshots (
  id SERIAL PRIMARY KEY,
  generated_at TIMESTAMPTZ NOT NULL,
  positions JSONB NOT NULL DEFAULT '{}',
  total_eur NUMERIC(20, 2),
  spy_close NUMERIC(20, 4),
  alerts JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broker_snapshots_generated_at_idx ON broker_snapshots(generated_at DESC);
