CREATE TABLE ledgers (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  currency_code TEXT NOT NULL CHECK (
    length(currency_code) = 3 AND currency_code = upper(currency_code)
  ),
  currency_scale INTEGER NOT NULL CHECK (currency_scale BETWEEN 0 AND 3),
  owner_user_id TEXT NOT NULL,
  balance_revision INTEGER NOT NULL DEFAULT 0 CHECK (balance_revision >= 0),
  last_balance_operation_id TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE UNIQUE INDEX ledgers_active_name_unique
  ON ledgers (guild_id, name COLLATE NOCASE)
  WHERE archived_at IS NULL;

CREATE INDEX ledgers_guild_id_index ON ledgers (guild_id);

CREATE TABLE ledger_members (
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ledger_id, user_id)
);

CREATE INDEX ledger_members_user_id_index ON ledger_members (user_id);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('expense', 'settlement')),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 200),
  total_amount_minor INTEGER NOT NULL CHECK (total_amount_minor > 0),
  occurred_on TEXT NOT NULL CHECK (
    occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_operation_id TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE INDEX transactions_ledger_date_index
  ON transactions (ledger_id, occurred_on DESC, created_at DESC);

CREATE INDEX transactions_ledger_type_index
  ON transactions (ledger_id, type, occurred_on DESC);

CREATE TABLE expense_details (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  payer_user_id TEXT NOT NULL
);

CREATE TABLE expense_shares (
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (transaction_id, user_id),
  UNIQUE (transaction_id, position)
);

CREATE INDEX expense_shares_user_id_index ON expense_shares (user_id);

CREATE TABLE settlement_details (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  payer_user_id TEXT NOT NULL,
  receiver_user_id TEXT NOT NULL,
  CHECK (payer_user_id <> receiver_user_id)
);

CREATE TABLE postings (
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  PRIMARY KEY (transaction_id, user_id)
);

CREATE INDEX postings_user_id_index ON postings (user_id);

CREATE TABLE transaction_audits (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  actor_user_id TEXT NOT NULL,
  before_snapshot TEXT,
  after_snapshot TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX transaction_audits_transaction_index
  ON transaction_audits (transaction_id, created_at);

CREATE TABLE interaction_receipts (
  interaction_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE interaction_sessions (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX interaction_sessions_expiry_index
  ON interaction_sessions (expires_at);
