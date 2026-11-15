-- SAQO Wallet & Flutterwave Payment System Schema, RLS Policies & Atomic RPCs
-- Target: Supabase PostgreSQL (public schema)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Wallets
CREATE TABLE IF NOT EXISTS public.wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  balance_ngn NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (balance_ngn >= 0),
  locked_balance_ngn NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (locked_balance_ngn >= 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Immutable Wallet Ledger Transactions
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES public.wallets(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('credit', 'debit', 'refund', 'adjustment')),
  category TEXT NOT NULL CHECK (category IN ('funding', 'delivery_payment', 'refund', 'admin_adjustment', 'reversal')),
  amount_ngn NUMERIC(14, 2) NOT NULL CHECK (amount_ngn > 0),
  balance_before_ngn NUMERIC(14, 2) NOT NULL CHECK (balance_before_ngn >= 0),
  balance_after_ngn NUMERIC(14, 2) NOT NULL CHECK (balance_after_ngn >= 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  reference TEXT NOT NULL UNIQUE,
  idempotency_key TEXT UNIQUE,
  delivery_id TEXT,
  payment_transaction_id UUID,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
  description TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT,
  actor_role TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.prevent_wallet_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'wallet_transactions ledger is immutable and cannot be modified or deleted';
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_transactions_immutable ON public.wallet_transactions;
CREATE TRIGGER trg_wallet_transactions_immutable
  BEFORE UPDATE OR DELETE ON public.wallet_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_wallet_ledger_mutation();

-- 3. Payment Methods Configuration
CREATE TABLE IF NOT EXISTS public.payment_methods (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Payment Transactions
CREATE TABLE IF NOT EXISTS public.payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  idempotency_key TEXT UNIQUE,
  provider_tx_id TEXT,
  provider_tx_ref TEXT,
  user_id TEXT NOT NULL,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  wallet_id UUID REFERENCES public.wallets(id) ON DELETE RESTRICT,
  delivery_id TEXT,
  tracking_code TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('wallet_funding', 'delivery_payment')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('wallet', 'flutterwave', 'cash', 'bank_transfer')),
  provider TEXT NOT NULL DEFAULT 'internal' CHECK (provider IN ('internal', 'flutterwave', 'cash', 'bank_transfer')),
  amount_ngn NUMERIC(14, 2) NOT NULL CHECK (amount_ngn >= 0),
  fee_ngn NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (fee_ngn >= 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'pending_verification', 'collected_by_rider', 'paid', 'failed', 'refunded', 'reversed')),
  checkout_url TEXT,
  transfer_reference TEXT,
  transfer_proof_note TEXT,
  failure_reason TEXT,
  verified_at TIMESTAMPTZ,
  verified_by TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Encrypted Payment Gateway Settings (service_role only)
CREATE TABLE IF NOT EXISTS public.payment_gateway_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  provider TEXT NOT NULL DEFAULT 'flutterwave',
  public_key TEXT NOT NULL DEFAULT '',
  secret_key_encrypted TEXT NOT NULL DEFAULT '',
  encryption_key_encrypted TEXT NOT NULL DEFAULT '',
  webhook_secret_hash_encrypted TEXT NOT NULL DEFAULT '',
  webhook_url TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  bank_name TEXT NOT NULL DEFAULT '',
  bank_account_name TEXT NOT NULL DEFAULT '',
  bank_account_number TEXT NOT NULL DEFAULT '',
  bank_instructions TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Webhook Event Audit & Idempotency Store (service_role only)
CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'flutterwave',
  event_type TEXT NOT NULL,
  event_id TEXT,
  tx_ref TEXT,
  flw_tx_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  signature_valid BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  processing_error TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- 7. Refunds Ledger
CREATE TABLE IF NOT EXISTS public.refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  payment_transaction_id UUID REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  delivery_id TEXT,
  user_id TEXT NOT NULL,
  amount_ngn NUMERIC(14, 2) NOT NULL CHECK (amount_ngn > 0),
  destination TEXT NOT NULL CHECK (destination IN ('wallet', 'flutterwave', 'manual')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  provider_refund_id TEXT,
  initiated_by TEXT NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. Cash & Bank Transfer Collections
CREATE TABLE IF NOT EXISTS public.cash_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id TEXT NOT NULL UNIQUE,
  tracking_code TEXT NOT NULL,
  payment_transaction_id UUID REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL,
  rider_id TEXT,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'bank_transfer')),
  expected_amount_ngn NUMERIC(14, 2) NOT NULL CHECK (expected_amount_ngn >= 0),
  collected_amount_ngn NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (collected_amount_ngn >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'pending_verification', 'collected_by_rider', 'reconciled', 'disputed')),
  transfer_reference TEXT,
  transfer_proof_note TEXT,
  rider_confirmed_at TIMESTAMPTZ,
  reconciled_by TEXT,
  reconciled_at TIMESTAMPTZ,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet_id ON public.wallet_transactions(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_id ON public.wallet_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_delivery_id ON public.wallet_transactions(delivery_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_user_id ON public.payment_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_tx_delivery_id ON public.payment_transactions(delivery_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_status_method ON public.payment_transactions(status, payment_method, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_tx_provider_ref ON public.payment_transactions(provider_tx_id, provider_tx_ref);
CREATE INDEX IF NOT EXISTS idx_webhook_events_tx_ref ON public.payment_webhook_events(tx_ref, flw_tx_id);
CREATE INDEX IF NOT EXISTS idx_refunds_user_delivery ON public.refunds(user_id, delivery_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_collections_status_rider ON public.cash_collections(status, rider_id, created_at DESC);

-- Seed Payment Methods & Singleton Gateway Settings
INSERT INTO public.payment_methods (code, name, description, is_enabled, sort_order)
VALUES
  ('wallet', 'SAQO Wallet', 'Pay instantly from your SAQO wallet balance', true, 1),
  ('flutterwave', 'Pay Online (Flutterwave)', 'Pay securely via card, bank, or USSD with Flutterwave', true, 2),
  ('cash', 'Cash on Delivery', 'Pay cash directly to the assigned SAQO rider', true, 3),
  ('bank_transfer', 'Bank Transfer', 'Transfer directly to SAQO bank account with reference verification', true, 4)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO public.payment_gateway_settings (id, provider, mode, is_enabled)
VALUES ('default', 'flutterwave', 'test', false)
ON CONFLICT (id) DO NOTHING;

-- Atomic PL/pgSQL RPCs with Row Locking & Idempotency

CREATE OR REPLACE FUNCTION public.saqo_ensure_wallet(p_user_id TEXT)
RETURNS public.wallets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet public.wallets;
BEGIN
  INSERT INTO public.wallets (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_wallet FROM public.wallets WHERE user_id = p_user_id;
  RETURN v_wallet;
END;
$$;

CREATE OR REPLACE FUNCTION public.saqo_credit_wallet(
  p_user_id TEXT,
  p_amount_ngn NUMERIC,
  p_reference TEXT,
  p_idempotency_key TEXT DEFAULT NULL,
  p_category TEXT DEFAULT 'funding',
  p_description TEXT DEFAULT 'Wallet funded',
  p_delivery_id TEXT DEFAULT NULL,
  p_payment_transaction_id UUID DEFAULT NULL,
  p_actor_user_id TEXT DEFAULT NULL,
  p_actor_role TEXT DEFAULT 'system',
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS public.wallet_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet public.wallets;
  v_existing public.wallet_transactions;
  v_before NUMERIC(14, 2);
  v_after NUMERIC(14, 2);
  v_inserted public.wallet_transactions;
BEGIN
  IF p_amount_ngn IS NULL OR p_amount_ngn <= 0 THEN
    RAISE EXCEPTION 'Credit amount must be positive';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.wallet_transactions WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_existing FROM public.wallet_transactions WHERE reference = p_reference;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  INSERT INTO public.wallets (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_wallet FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  IF v_wallet.status <> 'active' THEN
    RAISE EXCEPTION 'Wallet is not active (%).', v_wallet.status;
  END IF;

  v_before := v_wallet.balance_ngn;
  v_after := ROUND(v_before + p_amount_ngn, 2);

  UPDATE public.wallets
  SET balance_ngn = v_after, updated_at = now()
  WHERE id = v_wallet.id;

  INSERT INTO public.wallet_transactions (
    wallet_id, user_id, type, category, amount_ngn,
    balance_before_ngn, balance_after_ngn, currency,
    reference, idempotency_key, delivery_id, payment_transaction_id,
    status, description, actor_user_id, actor_role, metadata
  ) VALUES (
    v_wallet.id, p_user_id, 'credit', p_category, ROUND(p_amount_ngn, 2),
    v_before, v_after, v_wallet.currency,
    p_reference, p_idempotency_key, p_delivery_id, p_payment_transaction_id,
    'completed', p_description, p_actor_user_id, p_actor_role, COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING * INTO v_inserted;

  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.saqo_debit_wallet(
  p_user_id TEXT,
  p_amount_ngn NUMERIC,
  p_reference TEXT,
  p_idempotency_key TEXT DEFAULT NULL,
  p_category TEXT DEFAULT 'delivery_payment',
  p_description TEXT DEFAULT 'Delivery payment',
  p_delivery_id TEXT DEFAULT NULL,
  p_payment_transaction_id UUID DEFAULT NULL,
  p_actor_user_id TEXT DEFAULT NULL,
  p_actor_role TEXT DEFAULT 'client',
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS public.wallet_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet public.wallets;
  v_existing public.wallet_transactions;
  v_before NUMERIC(14, 2);
  v_after NUMERIC(14, 2);
  v_inserted public.wallet_transactions;
BEGIN
  IF p_amount_ngn IS NULL OR p_amount_ngn <= 0 THEN
    RAISE EXCEPTION 'Debit amount must be positive';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.wallet_transactions WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_existing FROM public.wallet_transactions WHERE reference = p_reference;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  INSERT INTO public.wallets (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_wallet FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  IF v_wallet.status <> 'active' THEN
    RAISE EXCEPTION 'Wallet is not active (%).', v_wallet.status;
  END IF;

  v_before := v_wallet.balance_ngn;
  IF v_before < ROUND(p_amount_ngn, 2) THEN
    RAISE EXCEPTION 'Insufficient wallet balance';
  END IF;

  v_after := ROUND(v_before - p_amount_ngn, 2);

  UPDATE public.wallets
  SET balance_ngn = v_after, updated_at = now()
  WHERE id = v_wallet.id;

  INSERT INTO public.wallet_transactions (
    wallet_id, user_id, type, category, amount_ngn,
    balance_before_ngn, balance_after_ngn, currency,
    reference, idempotency_key, delivery_id, payment_transaction_id,
    status, description, actor_user_id, actor_role, metadata
  ) VALUES (
    v_wallet.id, p_user_id, 'debit', p_category, ROUND(p_amount_ngn, 2),
    v_before, v_after, v_wallet.currency,
    p_reference, p_idempotency_key, p_delivery_id, p_payment_transaction_id,
    'completed', p_description, p_actor_user_id, p_actor_role, COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING * INTO v_inserted;

  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.saqo_adjust_wallet(
  p_user_id TEXT,
  p_direction TEXT,
  p_amount_ngn NUMERIC,
  p_reference TEXT,
  p_reason TEXT,
  p_actor_user_id TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS public.wallet_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet public.wallets;
  v_existing public.wallet_transactions;
  v_before NUMERIC(14, 2);
  v_after NUMERIC(14, 2);
  v_inserted public.wallet_transactions;
BEGIN
  IF p_reason IS NULL OR LENGTH(TRIM(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Adjustment reason is mandatory';
  END IF;
  IF p_amount_ngn IS NULL OR p_amount_ngn <= 0 THEN
    RAISE EXCEPTION 'Adjustment amount must be positive';
  END IF;
  IF p_direction NOT IN ('credit', 'debit') THEN
    RAISE EXCEPTION 'Direction must be credit or debit';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.wallet_transactions WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  INSERT INTO public.wallets (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_wallet FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  v_before := v_wallet.balance_ngn;
  IF p_direction = 'debit' THEN
    IF v_before < ROUND(p_amount_ngn, 2) THEN
      RAISE EXCEPTION 'Insufficient wallet balance for debit adjustment';
    END IF;
    v_after := ROUND(v_before - p_amount_ngn, 2);
  ELSE
    v_after := ROUND(v_before + p_amount_ngn, 2);
  END IF;

  UPDATE public.wallets SET balance_ngn = v_after, updated_at = now() WHERE id = v_wallet.id;

  INSERT INTO public.wallet_transactions (
    wallet_id, user_id, type, category, amount_ngn,
    balance_before_ngn, balance_after_ngn, currency,
    reference, idempotency_key, status, description,
    actor_user_id, actor_role, metadata
  ) VALUES (
    v_wallet.id, p_user_id, 'adjustment', 'admin_adjustment', ROUND(p_amount_ngn, 2),
    v_before, v_after, v_wallet.currency,
    p_reference, p_idempotency_key, 'completed', TRIM(p_reason),
    p_actor_user_id, 'admin', jsonb_build_object('direction', p_direction, 'reason', TRIM(p_reason))
  )
  RETURNING * INTO v_inserted;

  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.saqo_process_refund(
  p_refund_reference TEXT,
  p_payment_transaction_id UUID,
  p_delivery_id TEXT,
  p_user_id TEXT,
  p_amount_ngn NUMERIC,
  p_destination TEXT,
  p_reason TEXT,
  p_initiated_by TEXT,
  p_provider_refund_id TEXT DEFAULT NULL
)
RETURNS public.refunds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.refunds;
  v_refund public.refunds;
BEGIN
  IF p_reason IS NULL OR LENGTH(TRIM(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Refund reason is mandatory';
  END IF;
  IF p_amount_ngn IS NULL OR p_amount_ngn <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be positive';
  END IF;

  SELECT * INTO v_existing FROM public.refunds WHERE reference = p_refund_reference;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  IF p_destination = 'wallet' THEN
    PERFORM public.saqo_credit_wallet(
      p_user_id,
      p_amount_ngn,
      'WLT-' || p_refund_reference,
      'refund:' || p_refund_reference,
      'refund',
      'Refund: ' || TRIM(p_reason),
      p_delivery_id,
      p_payment_transaction_id,
      p_initiated_by,
      'admin',
      jsonb_build_object('refund_reference', p_refund_reference)
    );
  END IF;

  INSERT INTO public.refunds (
    reference, payment_transaction_id, delivery_id, user_id,
    amount_ngn, destination, reason, status, provider_refund_id,
    initiated_by, processed_at
  ) VALUES (
    p_refund_reference, p_payment_transaction_id, p_delivery_id, p_user_id,
    ROUND(p_amount_ngn, 2), p_destination, TRIM(p_reason), 'completed', p_provider_refund_id,
    p_initiated_by, now()
  )
  RETURNING * INTO v_refund;

  IF p_payment_transaction_id IS NOT NULL THEN
    UPDATE public.payment_transactions
    SET status = 'refunded', updated_at = now()
    WHERE id = p_payment_transaction_id;
  END IF;

  RETURN v_refund;
END;
$$;

-- Row Level Security Policies
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_gateway_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_collections ENABLE ROW LEVEL SECURITY;

-- Service role full access & user scoped policies
DROP POLICY IF EXISTS wallets_select_own ON public.wallets;
CREATE POLICY wallets_select_own ON public.wallets
  FOR SELECT TO authenticated
  USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS wallet_tx_select_own ON public.wallet_transactions;
CREATE POLICY wallet_tx_select_own ON public.wallet_transactions
  FOR SELECT TO authenticated
  USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS payment_methods_select_all ON public.payment_methods;
CREATE POLICY payment_methods_select_all ON public.payment_methods
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS payment_tx_select_own ON public.payment_transactions;
CREATE POLICY payment_tx_select_own ON public.payment_transactions
  FOR SELECT TO authenticated
  USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS refunds_select_own ON public.refunds;
CREATE POLICY refunds_select_own ON public.refunds
  FOR SELECT TO authenticated
  USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS cash_collections_select_participant ON public.cash_collections;
CREATE POLICY cash_collections_select_participant ON public.cash_collections
  FOR SELECT TO authenticated
  USING (auth.uid()::text = customer_id OR auth.uid()::text = rider_id);

-- Gateway settings & webhook events have zero authenticated/anon SELECT policies -> denied by default, service_role bypasses RLS.

-- Realtime publication (best-effort if publication exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.wallets;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.wallet_transactions;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.payment_transactions;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.cash_collections;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.refunds;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END;
$$;
