/**
 * Versioned schema migrations. Each migration runs inside a transaction and bumps PRAGMA user_version.
 * Never edit a released migration: add a new one.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('essential','discretionary','neutral')),
  color TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  excluded_from_spending INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_spending IN (0,1)),
  system_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE merchants (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per imported file (PDF / CSV / demo batch). sha256 deduplicates identical files.
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual','email','demo')),
  status TEXT NOT NULL CHECK (status IN ('imported','needs_review','discarded')),
  parser_id TEXT,
  stored_path TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  imported_at TEXT NOT NULL
);

-- Parsed statement metadata (1:1 with a document when parsing succeeded).
CREATE TABLE statements (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  bank TEXT NOT NULL,
  kind TEXT NOT NULL,
  account_hint TEXT,
  period_start TEXT,
  period_end TEXT,
  declared_total_cents INTEGER,
  computed_total_cents INTEGER NOT NULL,
  issues TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_statements_period ON statements(bank, account_hint, period_start, period_end);

-- Gmail (or other provider) messages already looked at. UNIQUE avoids re-downloading.
CREATE TABLE email_imports (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  message_id TEXT NOT NULL,
  attachment_key TEXT NOT NULL,
  subject TEXT,
  sender TEXT,
  received_at TEXT,
  score_bp INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('imported','duplicate','needs_review','password_required','failed','not_statement','skipped')),
  error_code TEXT,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  processed_at TEXT NOT NULL,
  UNIQUE (provider, message_id, attachment_key)
);

CREATE TABLE categorization_rules (
  id INTEGER PRIMARY KEY,
  match_type TEXT NOT NULL CHECK (match_type IN ('merchant','contains')),
  pattern TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (match_type, pattern)
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  booking_date TEXT,
  description_raw TEXT NOT NULL,
  description_normalized TEXT NOT NULL,
  merchant_raw TEXT,
  merchant_id INTEGER REFERENCES merchants(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  type TEXT NOT NULL CHECK (type IN ('expense','income','refund','transfer','cash_withdrawal','fee','unknown')),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  classification_source TEXT NOT NULL CHECK (classification_source IN ('USER','RULE','MERCHANT','HEURISTIC','UNKNOWN')),
  classification_confidence REAL NOT NULL DEFAULT 0,
  classification_detail TEXT,
  rule_id INTEGER REFERENCES categorization_rules(id) ON DELETE SET NULL,
  category_locked INTEGER NOT NULL DEFAULT 0 CHECK (category_locked IN (0,1)),
  is_excluded INTEGER NOT NULL DEFAULT 0 CHECK (is_excluded IN (0,1)),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tx_date ON transactions(date);
CREATE INDEX idx_tx_category_date ON transactions(category_id, date);
CREATE INDEX idx_tx_merchant_date ON transactions(merchant_id, date);
CREATE INDEX idx_tx_document ON transactions(document_id);

-- Rows that could not be imported automatically. Nothing here counts in analytics.
CREATE TABLE import_review_items (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  date TEXT,
  booking_date TEXT,
  description TEXT NOT NULL,
  amount_cents INTEGER,
  type TEXT NOT NULL,
  errors TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','discarded')),
  UNIQUE (document_id, row_index)
);

CREATE TABLE recurring_expenses (
  id INTEGER PRIMARY KEY,
  merchant_id INTEGER NOT NULL UNIQUE REFERENCES merchants(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('probable','confirmed','dismissed')),
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','bimonthly','quarterly','annual')),
  kind TEXT NOT NULL CHECK (kind IN ('subscription','fixed')),
  average_cents INTEGER NOT NULL,
  last_date TEXT NOT NULL,
  next_date TEXT NOT NULL,
  occurrences INTEGER NOT NULL,
  confidence_bp INTEGER NOT NULL,
  reason TEXT NOT NULL,
  user_set INTEGER NOT NULL DEFAULT 0 CHECK (user_set IN (0,1)),
  detected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE income (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('salary','recurring','extraordinary')),
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  start_month TEXT NOT NULL,
  end_month TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_month IS NULL OR end_month >= start_month)
);

CREATE TABLE savings_goals (
  id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('amount','percent')),
  amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  percent_bp INTEGER CHECK (percent_bp IS NULL OR (percent_bp >= 0 AND percent_bp <= 10000)),
  effective_from TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Generated recommendations (regenerated on demand) and user dismissals.
CREATE TABLE recommendations (
  key TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','dismissed')),
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'savings pots and wealth tracking',
    sql: `
-- Savings goals ("huchas"): money the user sets aside, tracked with explicit contributions/withdrawals.
CREATE TABLE savings_pots (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('goal','emergency')),
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  target_date TEXT,
  color TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_single_emergency_pot ON savings_pots(kind) WHERE kind = 'emergency' AND archived = 0;

CREATE TABLE pot_movements (
  id INTEGER PRIMARY KEY,
  pot_id INTEGER NOT NULL REFERENCES savings_pots(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_pot_movements ON pot_movements(pot_id, date);

-- Wealth: assets and liabilities valued manually over time (no market data, no product advice).
CREATE TABLE assets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('cash','deposit','fund','stocks','pension','crypto','real_estate','other','loan','mortgage','credit_card')),
  institution TEXT,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE asset_valuations (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  value_cents INTEGER NOT NULL CHECK (value_cents >= 0),
  contributed_cents INTEGER CHECK (contributed_cents IS NULL OR contributed_cents >= 0),
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, date)
);
CREATE INDEX idx_asset_valuations ON asset_valuations(asset_id, date);
`,
  },
  {
    version: 3,
    name: 'estimated valuations and loans',
    sql: `
-- manual: value = last valuation · rate: last valuation grown at an annual rate (+ monthly contribution)
-- loan: outstanding balance from a French amortization schedule (principal, TIN, term, start date)
ALTER TABLE assets ADD COLUMN valuation_mode TEXT NOT NULL DEFAULT 'manual' CHECK (valuation_mode IN ('manual','rate','loan'));
ALTER TABLE assets ADD COLUMN annual_rate_bp INTEGER CHECK (annual_rate_bp IS NULL OR (annual_rate_bp > -10000 AND annual_rate_bp < 100000));
ALTER TABLE assets ADD COLUMN monthly_contribution_cents INTEGER CHECK (monthly_contribution_cents IS NULL OR monthly_contribution_cents >= 0);
ALTER TABLE assets ADD COLUMN principal_cents INTEGER CHECK (principal_cents IS NULL OR principal_cents > 0);
ALTER TABLE assets ADD COLUMN term_months INTEGER CHECK (term_months IS NULL OR (term_months > 0 AND term_months <= 600));
ALTER TABLE assets ADD COLUMN start_date TEXT;
-- Public market symbol used to look up past returns (only the symbol ever leaves the computer) and where the rate came from.
ALTER TABLE assets ADD COLUMN symbol TEXT;
ALTER TABLE assets ADD COLUMN rate_source TEXT;
`,
  },
  {
    version: 4,
    name: 'bank accounts, balances and internal transfers',
    sql: `
-- One row per bank account or card the movements come from. Created automatically when importing.
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  bank TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'current' CHECK (kind IN ('current','savings','card','investment','other')),
  -- 'account' or 'card': which statements belong here (with bank and last4).
  -- manual: an account whose statements are not imported (e.g. a remunerated account at another bank).
  source_kind TEXT NOT NULL DEFAULT 'account' CHECK (source_kind IN ('account','card','manual')),
  last4 TEXT,
  -- Known balance at the end of a day (entered by the user or printed in a statement): balances are derived from it.
  anchor_balance_cents INTEGER,
  anchor_date TEXT,
  anchor_source TEXT CHECK (anchor_source IS NULL OR anchor_source IN ('user','statement')),
  include_in_net_worth INTEGER NOT NULL DEFAULT 1 CHECK (include_in_net_worth IN (0,1)),
  -- Remunerated accounts: annual rate (TAE) used to estimate interest on the balance.
  annual_rate_bp INTEGER CHECK (annual_rate_bp IS NULL OR (annual_rate_bp > -10000 AND annual_rate_bp < 100000)),
  -- Where transfers to your own name go when that account is not imported (one default).
  own_transfer_target INTEGER NOT NULL DEFAULT 0 CHECK (own_transfer_target IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE statements ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE statements ADD COLUMN end_balance_cents INTEGER;
ALTER TABLE statements ADD COLUMN end_balance_date TEXT;
ALTER TABLE transactions ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
-- Other leg of a transfer between two of the user's accounts.
ALTER TABLE transactions ADD COLUMN transfer_match_id INTEGER;
-- The other account of a transfer between your own accounts (imported or manual).
ALTER TABLE transactions ADD COLUMN counter_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX idx_tx_account_date ON transactions(account_id, date);
-- Who is on the other side of your transfers, decided once by you: own account, partner or someone else.
CREATE TABLE counterparties (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('own','partner','other')),
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
-- Transfers now only mean money moved between your own accounts.
UPDATE categories SET name = 'Entre mis cuentas' WHERE system_key = 'transfers' AND name = 'Transferencias'
  AND NOT EXISTS (SELECT 1 FROM categories WHERE name = 'Entre mis cuentas');

-- Existing imports: one account per bank / kind / last digits.
INSERT INTO accounts(name, bank, kind, source_kind, last4, include_in_net_worth, created_at, updated_at)
SELECT bank || CASE WHEN kind = 'card' THEN ' · tarjeta' ELSE ' · cuenta' END || COALESCE(' ···' || account_hint, ''),
       bank, CASE WHEN kind = 'card' THEN 'card' ELSE 'current' END, CASE WHEN kind = 'card' THEN 'card' ELSE 'account' END,
       account_hint, CASE WHEN kind = 'card' THEN 0 ELSE 1 END, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM statements GROUP BY bank, CASE WHEN kind = 'card' THEN 'card' ELSE 'account' END, account_hint;
UPDATE statements SET account_id = (
  SELECT a.id FROM accounts a WHERE a.bank = statements.bank
    AND a.source_kind = CASE WHEN statements.kind = 'card' THEN 'card' ELSE 'account' END
    AND COALESCE(a.last4, '') = COALESCE(statements.account_hint, ''));
UPDATE transactions SET account_id = (SELECT s.account_id FROM statements s WHERE s.document_id = transactions.document_id)
WHERE document_id IS NOT NULL;
`,
  },
  {
    version: 5,
    name: 'budgets and alerts',
    sql: `
-- Monthly spending limit per category (the same every month until changed).
CREATE TABLE budgets (
  category_id INTEGER PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Alerts already raised (so each one is shown/notified once).
CREATE TABLE alerts (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  page TEXT NOT NULL,
  section TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX idx_alerts_created ON alerts(created_at);
`,
  },
  {
    version: 6,
    name: 'stocks: watchlist, trades, prices and signals',
    sql: `
-- Public market data cache (only the symbol is ever sent to the data provider).
CREATE TABLE market_symbols (
  symbol TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT,
  exchange TEXT,
  type TEXT,
  live_price REAL,
  live_date TEXT,
  fetched_at TEXT
);
CREATE TABLE market_prices (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL CHECK (close > 0),
  PRIMARY KEY (symbol, date)
) WITHOUT ROWID;
-- Stocks you follow, with an optional purchase price you are waiting for.
CREATE TABLE stock_watchlist (
  symbol TEXT PRIMARY KEY,
  target_price REAL CHECK (target_price IS NULL OR target_price > 0),
  created_at TEXT NOT NULL
);
-- Your own buys and sells (entered by you). Euros are fixed with each trade's exchange rate.
CREATE TABLE stock_trades (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  date TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  price REAL NOT NULL CHECK (price > 0),
  currency TEXT NOT NULL,
  fx_per_eur REAL NOT NULL CHECK (fx_per_eur > 0),
  fees_cents INTEGER NOT NULL DEFAULT 0 CHECK (fees_cents >= 0),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_stock_trades_symbol ON stock_trades(symbol, date);
-- Since when each signal is active (an alert is raised once per episode).
CREATE TABLE stock_signal_state (
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  active_since TEXT NOT NULL,
  PRIMARY KEY (symbol, kind)
);
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
