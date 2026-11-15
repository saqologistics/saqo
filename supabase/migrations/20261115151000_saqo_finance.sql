-- The API and existing SQLite IDs are preserved in the private SAQO schema.
BEGIN;
SET LOCAL search_path = saqo, pg_catalog;

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  balance_ngn numeric(14, 2) NOT NULL DEFAULT 0 CHECK(balance_ngn >= 0),
  locked_balance_ngn numeric(14, 2) NOT NULL DEFAULT 0 CHECK(locked_balance_ngn >= 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'frozen', 'closed')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('credit', 'debit', 'refund', 'adjustment')),
  category TEXT NOT NULL CHECK(category IN ('funding', 'delivery_payment', 'refund', 'admin_adjustment', 'reversal')),
  amount_ngn numeric(14, 2) NOT NULL CHECK(amount_ngn > 0),
  balance_before_ngn numeric(14, 2) NOT NULL CHECK(balance_before_ngn >= 0),
  balance_after_ngn numeric(14, 2) NOT NULL CHECK(balance_after_ngn >= 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  reference TEXT NOT NULL UNIQUE,
  idempotency_key TEXT UNIQUE,
  delivery_id TEXT REFERENCES delivery_requests(id) ON DELETE SET NULL,
  payment_transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('pending', 'completed', 'failed', 'reversed')),
  description TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT,
  actor_role TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);

CREATE FUNCTION saqo.prevent_wallet_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'wallet_transactions ledger is immutable';
END;
$$;

CREATE TRIGGER wallet_ledger_immutable
  BEFORE UPDATE OR DELETE ON wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION saqo.prevent_wallet_ledger_mutation();

CREATE TABLE IF NOT EXISTS payment_methods (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  idempotency_key TEXT UNIQUE,
  provider_tx_id TEXT,
  provider_tx_ref TEXT,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  wallet_id TEXT REFERENCES wallets(id) ON DELETE SET NULL,
  delivery_id TEXT REFERENCES delivery_requests(id) ON DELETE SET NULL,
  tracking_code TEXT,
  purpose TEXT NOT NULL CHECK(purpose IN ('wallet_funding', 'delivery_payment')),
  payment_method TEXT NOT NULL CHECK(payment_method IN ('wallet', 'flutterwave', 'cash', 'bank_transfer')),
  provider TEXT NOT NULL DEFAULT 'internal' CHECK(provider IN ('internal', 'flutterwave', 'cash', 'bank_transfer')),
  amount_ngn numeric(14, 2) NOT NULL CHECK(amount_ngn >= 0),
  fee_ngn numeric(14, 2) NOT NULL DEFAULT 0 CHECK(fee_ngn >= 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'pending_verification', 'collected_by_rider', 'paid', 'failed', 'refunded', 'reversed')),
  checkout_url TEXT,
  transfer_reference TEXT,
  transfer_proof_note TEXT,
  failure_reason TEXT,
  verified_at timestamptz,
  verified_by TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_gateway_settings (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'flutterwave',
  public_key TEXT NOT NULL DEFAULT '',
  secret_key_encrypted TEXT NOT NULL DEFAULT '',
  encryption_key_encrypted TEXT NOT NULL DEFAULT '',
  webhook_secret_hash_encrypted TEXT NOT NULL DEFAULT '',
  webhook_url TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'test' CHECK(mode IN ('test', 'live')),
  is_enabled INTEGER NOT NULL DEFAULT 0,
  bank_name TEXT NOT NULL DEFAULT '',
  bank_account_name TEXT NOT NULL DEFAULT '',
  bank_account_number TEXT NOT NULL DEFAULT '',
  bank_instructions TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'flutterwave',
  event_type TEXT NOT NULL,
  event_id TEXT,
  tx_ref TEXT,
  flw_tx_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received', 'processed', 'ignored', 'failed')),
  processing_error TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL,
  processed_at timestamptz
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  payment_transaction_id TEXT REFERENCES payment_transactions(id) ON DELETE SET NULL,
  delivery_id TEXT REFERENCES delivery_requests(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount_ngn numeric(14, 2) NOT NULL CHECK(amount_ngn > 0),
  destination TEXT NOT NULL CHECK(destination IN ('wallet', 'flutterwave', 'manual')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed')),
  provider_refund_id TEXT,
  initiated_by TEXT NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS cash_collections (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE REFERENCES delivery_requests(id) ON DELETE CASCADE,
  tracking_code TEXT NOT NULL,
  payment_transaction_id TEXT REFERENCES payment_transactions(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rider_id TEXT REFERENCES riders(id) ON DELETE SET NULL,
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cash', 'bank_transfer')),
  expected_amount_ngn numeric(14, 2) NOT NULL CHECK(expected_amount_ngn >= 0),
  collected_amount_ngn numeric(14, 2) NOT NULL DEFAULT 0 CHECK(collected_amount_ngn >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'pending_verification', 'collected_by_rider', 'reconciled', 'disputed')),
  transfer_reference TEXT,
  transfer_proof_note TEXT,
  rider_confirmed_at timestamptz,
  reconciled_by TEXT,
  reconciled_at timestamptz,
  notes TEXT NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_audit_logs (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  amount_ngn numeric(14, 2) NOT NULL DEFAULT 0,
  direction TEXT,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet ON wallet_transactions(wallet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_tx_user ON payment_transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_tx_delivery ON payment_transactions(delivery_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_status_method ON payment_transactions(status, payment_method, created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_tx_ref ON payment_webhook_events(tx_ref, flw_tx_id);
CREATE INDEX IF NOT EXISTS idx_cash_collections_status ON cash_collections(status, rider_id);

INSERT INTO payment_methods (code, name, description, is_enabled, sort_order, config, updated_at)
VALUES ('wallet', 'SAQO Wallet', 'Pay instantly from your SAQO wallet balance', 1, 1, '{}', now()),
       ('flutterwave', 'Pay Online (Flutterwave)', 'Pay securely via card, bank, or USSD with Flutterwave', 1, 2, '{}', now()),
       ('cash', 'Cash on Delivery', 'Pay cash directly to the assigned SAQO rider', 1, 3, '{}', now()),
       ('bank_transfer', 'Bank Transfer', 'Transfer directly to SAQO bank account with verification', 1, 4, '{}', now())
ON CONFLICT (code) DO NOTHING;

INSERT INTO payment_gateway_settings (id, updated_at) VALUES ('default', now()) ON CONFLICT (id) DO NOTHING;

COMMIT;
