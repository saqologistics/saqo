import crypto from 'node:crypto';
import { db, pool, sqlite, databaseTransaction } from './database';
export { db, databaseTransaction as persistDispatchChange } from './database';
import { DEFAULT_PLATFORM_SETTINGS } from '../shared/pricing';
import type {
  AccountStatus,
  ComplaintRecord,
  CustomerSummary,
  DeliveryAssignment,
  DeliveryPaymentStatus,
  DeliveryRequest,
  DeliveryStatus,
  DeliveryStatusHistoryItem,
  NotificationItem,
  ParcelCategory,
  PaymentMethodCode,
  PaymentRecord,
  PlatformSettings,
  Profile,
  RiderProfile,
  SupportConversation,
  SupportConversationStatus,
  SupportMessage,
  SupportSenderRole,
  UserRole,
  VerificationStatus,
} from '../shared/types';

const configuredSecret = process.env.SAQO_SESSION_SECRET?.trim();
if (process.env.NODE_ENV === 'production' &&
    (!configuredSecret || configuredSecret.length < 32 || configuredSecret === 'saqo-dev-hmac-secret-2026')) {
  throw new Error('Set SAQO_SESSION_SECRET to a randomly generated secret of at least 32 characters.');
}
const SESSION_SECRET = configuredSecret || 'saqo-dev-hmac-secret-2026';
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, keyHex] = stored.split(':');
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

export function signSessionToken(payload: { userId: string; role: UserRole }): string {
  const data = Buffer.from(
    JSON.stringify({ ...payload, iat: Date.now() }),
    'utf8'
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifySessionToken(token: string): { userId: string; role: UserRole; expiresAt: number } | null {
  if (token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(data)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    const now = Date.now();
    if (typeof parsed.userId === 'string' && parsed.userId &&
        ['client', 'rider', 'admin'].includes(parsed.role) &&
        Number.isSafeInteger(parsed.iat) && parsed.iat <= now && now - parsed.iat < SESSION_LIFETIME_MS) {
      return { userId: parsed.userId, role: parsed.role, expiresAt: parsed.iat + SESSION_LIFETIME_MS };
    }
    return null;
  } catch {
    return null;
  }
}

function initSqliteDatabase(): void {
  const db = sqlite!;
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('client', 'rider', 'admin')),
      account_status TEXT NOT NULL DEFAULT 'active' CHECK(account_status IN ('active', 'suspended')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      profile_id TEXT UNIQUE NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      default_state TEXT NOT NULL DEFAULT 'Lagos'
    );

    CREATE TABLE IF NOT EXISTS riders (
      id TEXT PRIMARY KEY,
      profile_id TEXT UNIQUE NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      vehicle_type TEXT NOT NULL,
      plate_number TEXT NOT NULL,
      home_state TEXT NOT NULL,
      verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending', 'verified', 'rejected')),
      is_online INTEGER NOT NULL DEFAULT 1,
      current_lat REAL NOT NULL,
      current_lng REAL NOT NULL,
      last_location_at TEXT NOT NULL,
      completed_deliveries_count INTEGER NOT NULL DEFAULT 0,
      total_earnings_ngn REAL NOT NULL DEFAULT 0,
      rating REAL NOT NULL DEFAULT 5.0
    );

    CREATE TABLE IF NOT EXISTS rider_locations (
      id TEXT PRIMARY KEY,
      rider_id TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delivery_requests (
      id TEXT PRIMARY KEY,
      tracking_code TEXT UNIQUE NOT NULL,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      pickup_state TEXT NOT NULL,
      pickup_address TEXT NOT NULL,
      pickup_lat REAL NOT NULL,
      pickup_lng REAL NOT NULL,
      destination_state TEXT NOT NULL,
      destination_address TEXT NOT NULL,
      destination_lat REAL NOT NULL,
      destination_lng REAL NOT NULL,
      recipient_name TEXT NOT NULL,
      recipient_phone TEXT NOT NULL,
      service_tier TEXT NOT NULL CHECK(service_tier IN ('local', 'inter_city', 'inter_state')),
      distance_km REAL NOT NULL,
      estimated_minutes INTEGER NOT NULL,
      delivery_fee_ngn REAL NOT NULL,
      delivery_otp TEXT NOT NULL,
      otp_verified INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      assigned_rider_id TEXT REFERENCES riders(id),
      rider_rating REAL,
      rider_rating_comment TEXT,
      rated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS parcels (
      id TEXT PRIMARY KEY,
      delivery_id TEXT UNIQUE NOT NULL REFERENCES delivery_requests(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      weight_kg REAL NOT NULL DEFAULT 1.0
    );

    CREATE TABLE IF NOT EXISTS delivery_assignments (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL REFERENCES delivery_requests(id) ON DELETE CASCADE,
      rider_id TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('offered', 'accepted', 'rejected', 'timed_out', 'reassigned')),
      score REAL NOT NULL,
      distance_to_pickup_km REAL NOT NULL,
      route_compatibility_score REAL NOT NULL,
      offered_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      responded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS delivery_status_history (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL REFERENCES delivery_requests(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      note TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delivery_otp_attempts (
      delivery_id TEXT PRIMARY KEY REFERENCES delivery_requests(id) ON DELETE CASCADE,
      attempts INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      bucket TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_login_attempts_reset ON login_attempts(reset_at);

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      delivery_id TEXT UNIQUE NOT NULL REFERENCES delivery_requests(id) ON DELETE CASCADE,
      amount_ngn REAL NOT NULL,
      rider_payout_ngn REAL NOT NULL,
      platform_fee_ngn REAL NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'settled', 'refunded')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      delivery_id TEXT REFERENCES delivery_requests(id) ON DELETE SET NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS complaints (
      id TEXT PRIMARY KEY,
      ticket_type TEXT NOT NULL DEFAULT 'complaint' CHECK(ticket_type IN ('complaint', 'suggestion')),
      delivery_id TEXT REFERENCES delivery_requests(id) ON DELETE SET NULL,
      reporter_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'investigating', 'resolved')),
      resolution_note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      max_active_parcels_per_rider INTEGER NOT NULL,
      search_radius_km REAL NOT NULL,
      offer_timeout_seconds INTEGER NOT NULL,
      base_local_fee_ngn REAL NOT NULL,
      per_km_rate_ngn REAL NOT NULL,
      inter_state_surcharge_ngn REAL NOT NULL,
      rider_commission_percent REAL NOT NULL,
      whatsapp_support_number TEXT NOT NULL,
      show_delivery_state_selectors INTEGER NOT NULL DEFAULT 0,
      admin_accepting_chats INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      phone TEXT PRIMARY KEY,
      draft TEXT,
      profile_id TEXT REFERENCES profiles(id),
      support_conversation_id TEXT REFERENCES support_conversations(id) ON DELETE SET NULL,
      last_inbound_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages (
      message_sid TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_conversations (
      id TEXT PRIMARY KEY,
      visitor_token TEXT NOT NULL,
      user_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
      visitor_name TEXT NOT NULL,
      visitor_email TEXT,
      visitor_phone TEXT,
      tracking_code TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'pending', 'resolved', 'closed')),
      assigned_admin_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
      unread_by_admin INTEGER NOT NULL DEFAULT 0,
      unread_by_visitor INTEGER NOT NULL DEFAULT 0,
      last_message_preview TEXT,
      last_message_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL CHECK(sender_role IN ('visitor', 'client', 'admin', 'system')),
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_deliveries_customer ON delivery_requests(customer_id);
    CREATE INDEX IF NOT EXISTS idx_deliveries_rider ON delivery_requests(assigned_rider_id);
    CREATE INDEX IF NOT EXISTS idx_deliveries_status ON delivery_requests(status);
    CREATE INDEX IF NOT EXISTS idx_assignments_delivery ON delivery_assignments(delivery_id);
    CREATE INDEX IF NOT EXISTS idx_assignments_rider ON delivery_assignments(rider_id);
    CREATE INDEX IF NOT EXISTS idx_rider_locations_rider ON rider_locations(rider_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_support_conv_visitor ON support_conversations(visitor_token);
    CREATE INDEX IF NOT EXISTS idx_support_conv_user ON support_conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_support_msg_conv ON support_messages(conversation_id);

    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
      balance_ngn REAL NOT NULL DEFAULT 0 CHECK(balance_ngn >= 0),
      locked_balance_ngn REAL NOT NULL DEFAULT 0 CHECK(locked_balance_ngn >= 0),
      currency TEXT NOT NULL DEFAULT 'NGN',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'frozen', 'closed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('credit', 'debit', 'refund', 'adjustment')),
      category TEXT NOT NULL CHECK(category IN ('funding', 'delivery_payment', 'refund', 'admin_adjustment', 'reversal')),
      amount_ngn REAL NOT NULL CHECK(amount_ngn > 0),
      balance_before_ngn REAL NOT NULL CHECK(balance_before_ngn >= 0),
      balance_after_ngn REAL NOT NULL CHECK(balance_after_ngn >= 0),
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
      created_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS trg_wallet_transactions_no_update
      BEFORE UPDATE ON wallet_transactions
      BEGIN
        SELECT RAISE(ABORT, 'wallet_transactions ledger is immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_wallet_transactions_no_delete
      BEFORE DELETE ON wallet_transactions
      BEGIN
        SELECT RAISE(ABORT, 'wallet_transactions ledger is immutable');
      END;

    CREATE TABLE IF NOT EXISTS payment_methods (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      config TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
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
      amount_ngn REAL NOT NULL CHECK(amount_ngn >= 0),
      fee_ngn REAL NOT NULL DEFAULT 0 CHECK(fee_ngn >= 0),
      currency TEXT NOT NULL DEFAULT 'NGN',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'pending_verification', 'collected_by_rider', 'paid', 'failed', 'refunded', 'reversed')),
      checkout_url TEXT,
      transfer_reference TEXT,
      transfer_proof_note TEXT,
      failure_reason TEXT,
      verified_at TEXT,
      verified_by TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
      updated_at TEXT NOT NULL
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
      received_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      payment_transaction_id TEXT REFERENCES payment_transactions(id) ON DELETE SET NULL,
      delivery_id TEXT REFERENCES delivery_requests(id) ON DELETE SET NULL,
      user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      amount_ngn REAL NOT NULL CHECK(amount_ngn > 0),
      destination TEXT NOT NULL CHECK(destination IN ('wallet', 'flutterwave', 'manual')),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed')),
      provider_refund_id TEXT,
      initiated_by TEXT NOT NULL,
      processed_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_collections (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL UNIQUE REFERENCES delivery_requests(id) ON DELETE CASCADE,
      tracking_code TEXT NOT NULL,
      payment_transaction_id TEXT REFERENCES payment_transactions(id) ON DELETE SET NULL,
      customer_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      rider_id TEXT REFERENCES riders(id) ON DELETE SET NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('cash', 'bank_transfer')),
      expected_amount_ngn REAL NOT NULL CHECK(expected_amount_ngn >= 0),
      collected_amount_ngn REAL NOT NULL DEFAULT 0 CHECK(collected_amount_ngn >= 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'pending_verification', 'collected_by_rider', 'reconciled', 'disputed')),
      transfer_reference TEXT,
      transfer_proof_note TEXT,
      rider_confirmed_at TEXT,
      reconciled_by TEXT,
      reconciled_at TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_audit_logs (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      amount_ngn REAL NOT NULL DEFAULT 0,
      direction TEXT,
      reason TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet ON wallet_transactions(wallet_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_payment_tx_user ON payment_transactions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_payment_tx_delivery ON payment_transactions(delivery_id);
    CREATE INDEX IF NOT EXISTS idx_payment_tx_status_method ON payment_transactions(status, payment_method, created_at);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_tx_ref ON payment_webhook_events(tx_ref, flw_tx_id);
    CREATE INDEX IF NOT EXISTS idx_cash_collections_status ON cash_collections(status, rider_id);
  `);

  // Safe migrations on delivery_requests for payment method & status
  const settingsCols = db.prepare('PRAGMA table_info(platform_settings)').all() as Array<{ name: string }>;
  if (!settingsCols.some((column) => column.name === 'show_delivery_state_selectors')) {
    db.exec('ALTER TABLE platform_settings ADD COLUMN show_delivery_state_selectors INTEGER NOT NULL DEFAULT 0');
  }
  if (!settingsCols.some((column) => column.name === 'admin_accepting_chats')) {
    db.exec('ALTER TABLE platform_settings ADD COLUMN admin_accepting_chats INTEGER NOT NULL DEFAULT 1');
  }
  const deliveryCols = db.prepare('PRAGMA table_info(delivery_requests)').all() as Array<{ name: string }>;
  const colNames = new Set(deliveryCols.map((c) => c.name));
  if (!colNames.has('payment_method')) {
    db.exec("ALTER TABLE delivery_requests ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash'");
  }
  if (!colNames.has('payment_status')) {
    db.exec("ALTER TABLE delivery_requests ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'pending'");
  }
  if (!colNames.has('payment_reference')) {
    db.exec('ALTER TABLE delivery_requests ADD COLUMN payment_reference TEXT');
  }
  if (!colNames.has('rider_rating')) {
    db.exec('ALTER TABLE delivery_requests ADD COLUMN rider_rating REAL');
  }
  if (!colNames.has('rider_rating_comment')) {
    db.exec('ALTER TABLE delivery_requests ADD COLUMN rider_rating_comment TEXT');
  }
  if (!colNames.has('rated_at')) {
    db.exec('ALTER TABLE delivery_requests ADD COLUMN rated_at TEXT');
  }

  const nowIso = new Date().toISOString();
  const seedMethodStmt = db.prepare(`
    INSERT OR IGNORE INTO payment_methods (code, name, description, is_enabled, sort_order, config, updated_at)
    VALUES (?, ?, ?, 1, ?, '{}', ?)
  `);
  seedMethodStmt.run('wallet', 'SAQO Wallet', 'Pay instantly from your SAQO wallet balance', 1, nowIso);
  seedMethodStmt.run('flutterwave', 'Pay Online (Flutterwave)', 'Pay securely via card, bank, or USSD with Flutterwave', 2, nowIso);
  seedMethodStmt.run('cash', 'Cash on Delivery', 'Pay cash directly to the assigned SAQO rider', 3, nowIso);
  seedMethodStmt.run('bank_transfer', 'Bank Transfer', 'Transfer directly to SAQO bank account with verification', 4, nowIso);

  db.prepare(`
    INSERT OR IGNORE INTO payment_gateway_settings (
      id, provider, public_key, secret_key_encrypted, encryption_key_encrypted,
      webhook_secret_hash_encrypted, webhook_url, mode, is_enabled,
      bank_name, bank_account_name, bank_account_number, bank_instructions, updated_at
    ) VALUES (
      'default', 'flutterwave', '', '', '', '', '', 'test', 0,
      'Access Bank', 'SAQO Logistics Ltd', '0000000000',
      'Use your tracking code or payment reference as transfer narration.', ?
    )
  `).run(nowIso);

  const settingsCount = db.prepare('SELECT COUNT(*) as c FROM platform_settings').get() as { c: number };
  if (settingsCount.c === 0) {
    db.prepare(`
      INSERT INTO platform_settings (
        id, max_active_parcels_per_rider, search_radius_km, offer_timeout_seconds,
        base_local_fee_ngn, per_km_rate_ngn, inter_state_surcharge_ngn,
        rider_commission_percent, whatsapp_support_number
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      DEFAULT_PLATFORM_SETTINGS.maxActiveParcelsPerRider,
      DEFAULT_PLATFORM_SETTINGS.searchRadiusKm,
      DEFAULT_PLATFORM_SETTINGS.offerTimeoutSeconds,
      DEFAULT_PLATFORM_SETTINGS.baseLocalFeeNgn,
      DEFAULT_PLATFORM_SETTINGS.perKmRateNgn,
      DEFAULT_PLATFORM_SETTINGS.interStateSurchargeNgn,
      DEFAULT_PLATFORM_SETTINGS.riderCommissionPercent,
      DEFAULT_PLATFORM_SETTINGS.whatsappSupportNumber
    );
  }

  // Migrate legacy complaints table if ticket_type is missing or delivery_id is NOT NULL
  const complaintCols = db.prepare('PRAGMA table_info(complaints)').all() as Array<{
    name: string;
    notnull: number;
  }>;
  const hasTicketType = complaintCols.some((c) => c.name === 'ticket_type');
  const deliveryIdCol = complaintCols.find((c) => c.name === 'delivery_id');
  if (!hasTicketType || (deliveryIdCol && deliveryIdCol.notnull === 1)) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE complaints_v2 (
        id TEXT PRIMARY KEY,
        ticket_type TEXT NOT NULL DEFAULT 'complaint' CHECK(ticket_type IN ('complaint', 'suggestion')),
        delivery_id TEXT REFERENCES delivery_requests(id) ON DELETE SET NULL,
        reporter_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'investigating', 'resolved')),
        resolution_note TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO complaints_v2 (id, ticket_type, delivery_id, reporter_id, subject, details, status, resolution_note, created_at)
      SELECT id, 'complaint', delivery_id, reporter_id, subject, details, status, resolution_note, created_at FROM complaints;
      DROP TABLE complaints;
      ALTER TABLE complaints_v2 RENAME TO complaints;
      PRAGMA foreign_keys = ON;
    `);
  }

}

let schemaExtensionsEnsured = false;

async function ensurePostgresSchemaExtensions(): Promise<void> {
  if (!pool || schemaExtensionsEnsured) return;
  await db.prepare('ALTER TABLE delivery_requests ADD COLUMN IF NOT EXISTS rider_rating REAL').run();
  await db.prepare('ALTER TABLE delivery_requests ADD COLUMN IF NOT EXISTS rider_rating_comment TEXT').run();
  await db.prepare('ALTER TABLE delivery_requests ADD COLUMN IF NOT EXISTS rated_at TEXT').run();
  await db.prepare('ALTER TABLE riders ALTER COLUMN is_online SET DEFAULT 1').run();
  await db.prepare('ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS admin_accepting_chats INTEGER NOT NULL DEFAULT 1').run();
  schemaExtensionsEnsured = true;
}

export async function getAdminAcceptingChats(): Promise<boolean> {
  const row = (await db.prepare('SELECT admin_accepting_chats FROM platform_settings WHERE id = 1').get()) as
    | { admin_accepting_chats?: number }
    | undefined;
  return row ? Number(row.admin_accepting_chats ?? 1) !== 0 : true;
}

export async function setAdminAcceptingChatsDb(available: boolean): Promise<void> {
  await db.prepare('UPDATE platform_settings SET admin_accepting_chats = ? WHERE id = 1').run(available ? 1 : 0);
}

export async function initDatabase() {
  if (sqlite) initSqliteDatabase();
  if (pool) await ensurePostgresSchemaExtensions();
  await databaseTransaction(bootstrapAdminAccount);
}

async function bootstrapAdminAccount(): Promise<void> {
  const adminCount = await db
    .prepare("SELECT COUNT(*) as c FROM profiles WHERE role = 'admin'")
    .get() as { c: number };
  if (adminCount.c > 0) {
    if (process.env.NODE_ENV === 'production') {
      const admins = await db.prepare("SELECT password_hash FROM profiles WHERE role = 'admin' AND account_status = 'active'")
        .all() as Array<{ password_hash: string }>;
      if (admins.some((admin) => verifyPassword('saqo1234', admin.password_hash))) {
        throw new Error('Change the default admin password before starting in production.');
      }
    }
    return;
  }

  const now = new Date().toISOString();
  const initialPassword = process.env.SAQO_ADMIN_PASSWORD;
  if (process.env.NODE_ENV === 'production' &&
      (!initialPassword || initialPassword.length < 16 || initialPassword === 'saqo1234' || !process.env.SAQO_ADMIN_EMAIL?.trim())) {
    throw new Error('Set SAQO_ADMIN_EMAIL and a unique SAQO_ADMIN_PASSWORD of at least 16 characters for the initial admin.');
  }
  const adminEmail = (process.env.SAQO_ADMIN_EMAIL || 'admin@saqo.ng').trim().toLowerCase();
  const adminPass = hashPassword(initialPassword || 'saqo1234');
  const adminName = process.env.SAQO_ADMIN_NAME || 'SAQO Operations Admin';
  const adminPhone = process.env.SAQO_ADMIN_PHONE || '+2348007276000';

  await db.prepare(`
    INSERT INTO profiles (id, email, password_hash, full_name, phone, role, account_status, created_at)
    VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?)
  `).run(`prof-admin-${crypto.randomUUID().slice(0, 8)}`, adminEmail, adminPass, adminName, adminPhone, now);
}

// Query helpers
export async function getPlatformSettings(): Promise<PlatformSettings> {
  const row = await db.prepare('SELECT * FROM platform_settings WHERE id = 1').get() as any;
  return {
    maxActiveParcelsPerRider: row.max_active_parcels_per_rider,
    showDeliveryStateSelectors: Boolean(row.show_delivery_state_selectors),
    searchRadiusKm: row.search_radius_km,
    offerTimeoutSeconds: row.offer_timeout_seconds,
    baseLocalFeeNgn: row.base_local_fee_ngn,
    perKmRateNgn: row.per_km_rate_ngn,
    interStateSurchargeNgn: row.inter_state_surcharge_ngn,
    riderCommissionPercent: row.rider_commission_percent,
    whatsappSupportNumber: row.whatsapp_support_number,
  };
}

export async function getProfileById(id: string): Promise<Profile | null> {
  const row = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    role: row.role,
    accountStatus: row.account_status,
    createdAt: row.created_at,
  };
}

export async function getAllRiders(): Promise<RiderProfile[]> {
  const rows = await db.prepare(`
    SELECT p.*, r.id as rider_id, r.vehicle_type, r.plate_number, r.home_state,
      r.verification_status, r.is_online, r.current_lat, r.current_lng, r.last_location_at,
      r.completed_deliveries_count, r.total_earnings_ngn, r.rating,
      (SELECT COUNT(*) FROM delivery_requests dr WHERE dr.assigned_rider_id = r.id AND dr.status IN ('assigned','accepted','heading_to_pickup','parcel_picked_up','in_transit','arrived_at_destination')) as active_count
    FROM riders r
    JOIN profiles p ON p.id = r.profile_id
    ORDER BY r.is_online DESC, p.full_name ASC
  `).all() as any[];

  return rows.map((row) => ({
    id: row.id,
    riderId: row.rider_id,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    role: 'rider',
    accountStatus: row.account_status as AccountStatus,
    createdAt: row.created_at,
    vehicleType: row.vehicle_type,
    plateNumber: row.plate_number,
    homeState: row.home_state,
    verificationStatus: row.verification_status as VerificationStatus,
    isOnline: Boolean(row.is_online),
    currentLat: row.current_lat,
    currentLng: row.current_lng,
    lastLocationAt: row.last_location_at,
    activeParcelsCount: Number(row.active_count || 0),
    completedDeliveriesCount: row.completed_deliveries_count,
    totalEarningsNgn: row.total_earnings_ngn,
    rating: row.rating,
  }));
}

export async function getRiderByProfileId(profileId: string): Promise<RiderProfile | null> {
  return (await getAllRiders()).find((r) => r.id === profileId) || null;
}

export async function getAllCustomers(): Promise<CustomerSummary[]> {
  const rows = await db.prepare(`
    SELECT p.*, c.id as customer_id, c.default_state,
      (SELECT COUNT(*) FROM delivery_requests dr WHERE dr.customer_id = c.id) as total_requests,
      (SELECT COUNT(*) FROM delivery_requests dr WHERE dr.customer_id = c.id AND dr.status = 'delivered') as completed_requests
    FROM customers c
    JOIN profiles p ON p.id = c.profile_id
    ORDER BY p.created_at DESC
  `).all() as any[];

  return rows.map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    role: 'client',
    accountStatus: row.account_status as AccountStatus,
    createdAt: row.created_at,
    defaultState: row.default_state,
    totalRequests: Number(row.total_requests || 0),
    completedRequests: Number(row.completed_requests || 0),
  }));
}

export async function getDeliveryById(deliveryId: string): Promise<DeliveryRequest | null> {
  const row = await db.prepare(`
    SELECT dr.*,
      pa.category as parcel_category, pa.description as parcel_description, pa.weight_kg,
      cp.full_name as customer_name, cp.phone as customer_phone,
      rp.full_name as rider_name, rp.phone as rider_phone,
      r.vehicle_type as rider_vehicle, r.verification_status as rider_verification_status, r.rating as rider_rating_avg,
      CASE WHEN EXISTS (SELECT 1 FROM rider_locations loc WHERE loc.rider_id = r.id) THEN r.current_lat END as rider_lat,
      CASE WHEN EXISTS (SELECT 1 FROM rider_locations loc WHERE loc.rider_id = r.id) THEN r.current_lng END as rider_lng
    FROM delivery_requests dr
    JOIN parcels pa ON pa.delivery_id = dr.id
    JOIN customers c ON c.id = dr.customer_id
    JOIN profiles cp ON cp.id = c.profile_id
    LEFT JOIN riders r ON r.id = dr.assigned_rider_id
    LEFT JOIN profiles rp ON rp.id = r.profile_id
    WHERE dr.id = ?
  `).get(deliveryId) as any;

  if (!row) return null;
  return mapDeliveryRow(row);
}

export function publicTrackingDelivery(delivery: DeliveryRequest) {
  const {
    id, trackingCode, pickupState, pickupAddress, pickupLat, pickupLng,
    destinationState, destinationAddress, destinationLat, destinationLng,
    parcelCategory, weightKg, serviceTier, distanceKm, estimatedMinutes, deliveryFeeNgn,
    status, otpVerified, assignedRiderId, assignedRiderName, assignedRiderVehicle,
    assignedRiderVerified, assignedRiderLat, assignedRiderLng, assignedRiderRating, riderRating, updatedAt,
  } = delivery;
  return {
    id, trackingCode, pickupState, pickupAddress, pickupLat, pickupLng,
    destinationState, destinationAddress, destinationLat, destinationLng,
    parcelCategory, weightKg, serviceTier, distanceKm, estimatedMinutes, deliveryFeeNgn,
    status, otpVerified, assignedRiderId, assignedRiderName, assignedRiderVehicle,
    assignedRiderVerified, assignedRiderLat, assignedRiderLng, assignedRiderRating, riderRating, updatedAt,
  };
}

export async function publicTrackingHistory(deliveryId: string) {
  return (await getDeliveryHistory(deliveryId)).map(({ id, status, createdAt }) => ({ id, status, createdAt }));
}

export async function getDeliveryByTrackingCode(trackingCode: string): Promise<DeliveryRequest | null> {
  const row = await db.prepare(`
    SELECT dr.*,
      pa.category as parcel_category, pa.description as parcel_description, pa.weight_kg,
      cp.full_name as customer_name, cp.phone as customer_phone,
      rp.full_name as rider_name, rp.phone as rider_phone,
      r.vehicle_type as rider_vehicle, r.verification_status as rider_verification_status, r.rating as rider_rating_avg,
      CASE WHEN EXISTS (SELECT 1 FROM rider_locations loc WHERE loc.rider_id = r.id) THEN r.current_lat END as rider_lat,
      CASE WHEN EXISTS (SELECT 1 FROM rider_locations loc WHERE loc.rider_id = r.id) THEN r.current_lng END as rider_lng
    FROM delivery_requests dr
    JOIN parcels pa ON pa.delivery_id = dr.id
    JOIN customers c ON c.id = dr.customer_id
    JOIN profiles cp ON cp.id = c.profile_id
    LEFT JOIN riders r ON r.id = dr.assigned_rider_id
    LEFT JOIN profiles rp ON rp.id = r.profile_id
    WHERE UPPER(dr.tracking_code) = UPPER(?)
  `).get(trackingCode.trim()) as any;

  if (!row) return null;
  return mapDeliveryRow(row);
}

export async function listDeliveries(filter?: { customerId?: string; riderId?: string }): Promise<DeliveryRequest[]> {
  let sql = `
    SELECT dr.*,
      pa.category as parcel_category, pa.description as parcel_description, pa.weight_kg,
      cp.full_name as customer_name, cp.phone as customer_phone,
      rp.full_name as rider_name, rp.phone as rider_phone,
      r.vehicle_type as rider_vehicle, r.verification_status as rider_verification_status, r.rating as rider_rating_avg,
      CASE WHEN EXISTS (SELECT 1 FROM rider_locations loc WHERE loc.rider_id = r.id) THEN r.current_lat END as rider_lat,
      CASE WHEN EXISTS (SELECT 1 FROM rider_locations loc WHERE loc.rider_id = r.id) THEN r.current_lng END as rider_lng
    FROM delivery_requests dr
    JOIN parcels pa ON pa.delivery_id = dr.id
    JOIN customers c ON c.id = dr.customer_id
    JOIN profiles cp ON cp.id = c.profile_id
    LEFT JOIN riders r ON r.id = dr.assigned_rider_id
    LEFT JOIN profiles rp ON rp.id = r.profile_id
  `;
  const params: any[] = [];
  if (filter?.customerId) {
    sql += ' WHERE dr.customer_id = ?';
    params.push(filter.customerId);
  } else if (filter?.riderId) {
    sql += ' WHERE dr.assigned_rider_id = ?';
    params.push(filter.riderId);
  }
  sql += ' ORDER BY dr.created_at DESC';
  const rows = await db.prepare(sql).all(...params) as any[];
  return rows.map(mapDeliveryRow);
}

function mapDeliveryRow(row: any): DeliveryRequest {
  return {
    id: row.id,
    trackingCode: row.tracking_code,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    pickupState: row.pickup_state,
    pickupAddress: row.pickup_address,
    pickupLat: row.pickup_lat,
    pickupLng: row.pickup_lng,
    destinationState: row.destination_state,
    destinationAddress: row.destination_address,
    destinationLat: row.destination_lat,
    destinationLng: row.destination_lng,
    recipientName: row.recipient_name,
    recipientPhone: row.recipient_phone,
    parcelCategory: row.parcel_category as ParcelCategory,
    parcelDescription: row.parcel_description,
    weightKg: row.weight_kg,
    serviceTier: row.service_tier,
    distanceKm: row.distance_km,
    estimatedMinutes: row.estimated_minutes,
    deliveryFeeNgn: row.delivery_fee_ngn,
    paymentMethod: (row.payment_method || 'cash') as PaymentMethodCode,
    paymentStatus: (row.payment_status || 'pending') as DeliveryPaymentStatus,
    paymentReference: row.payment_reference || null,
    deliveryOtp: row.delivery_otp,
    otpVerified: Boolean(row.otp_verified),
    status: row.status as DeliveryStatus,
    assignedRiderId: row.assigned_rider_id,
    assignedRiderName: row.rider_name || null,
    assignedRiderPhone: row.rider_phone || null,
    assignedRiderVehicle: row.rider_vehicle || null,
    assignedRiderVerified: row.rider_verification_status === 'verified',
    assignedRiderLat: row.rider_lat ?? null,
    assignedRiderLng: row.rider_lng ?? null,
    assignedRiderRating: row.rider_rating_avg ?? null,
    riderRating: row.rider_rating ?? null,
    riderRatingComment: row.rider_rating_comment || null,
    ratedAt: row.rated_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getDeliveryHistory(deliveryId: string): Promise<DeliveryStatusHistoryItem[]> {
  const rows = await db
    .prepare('SELECT * FROM delivery_status_history WHERE delivery_id = ? ORDER BY created_at ASC')
    .all(deliveryId) as any[];
  return rows.map((r) => ({
    id: r.id,
    deliveryId: r.delivery_id,
    status: r.status,
    note: r.note,
    actorRole: r.actor_role,
    createdAt: r.created_at,
  }));
}

export function riderDelivery(delivery: DeliveryRequest | null): DeliveryRequest | undefined {
  if (!delivery) return undefined;
  return { ...delivery, deliveryOtp: '' };
}

export async function getAssignmentsForRider(riderId: string): Promise<DeliveryAssignment[]> {
  const rows = await db.prepare(`
    SELECT da.*, dr.tracking_code, rp.full_name as rider_name
    FROM delivery_assignments da
    JOIN delivery_requests dr ON dr.id = da.delivery_id
    JOIN riders r ON r.id = da.rider_id
    JOIN profiles rp ON rp.id = r.profile_id
    WHERE da.rider_id = ?
    ORDER BY da.offered_at DESC
  `).all(riderId) as any[];

  return Promise.all(rows.map(async (row) => ({
    id: row.id,
    deliveryId: row.delivery_id,
    trackingCode: row.tracking_code,
    riderId: row.rider_id,
    riderName: row.rider_name,
    status: row.status,
    score: row.score,
    distanceToPickupKm: row.distance_to_pickup_km,
    routeCompatibilityScore: row.route_compatibility_score,
    offeredAt: row.offered_at,
    expiresAt: row.expires_at,
    respondedAt: row.responded_at,
    delivery: riderDelivery(await getDeliveryById(row.delivery_id)),
  })));
}

export async function getAllPayments(): Promise<PaymentRecord[]> {
  const rows = await db.prepare(`
    SELECT py.*, dr.tracking_code, dr.payment_method, cp.full_name as customer_name
    FROM payments py
    JOIN delivery_requests dr ON dr.id = py.delivery_id
    JOIN customers c ON c.id = dr.customer_id
    JOIN profiles cp ON cp.id = c.profile_id
    ORDER BY py.created_at DESC
  `).all() as any[];

  return rows.map((r) => ({
    id: r.id,
    deliveryId: r.delivery_id,
    trackingCode: r.tracking_code,
    customerName: r.customer_name,
    amountNgn: r.amount_ngn,
    riderPayoutNgn: r.rider_payout_ngn,
    platformFeeNgn: r.platform_fee_ngn,
    paymentMethod: (r.payment_method || 'cash') as PaymentMethodCode,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export async function getAllComplaints(): Promise<ComplaintRecord[]> {
  const rows = await db.prepare(`
    SELECT co.*, dr.tracking_code, p.full_name as reporter_name, p.email as reporter_email, p.phone as reporter_phone
    FROM complaints co
    LEFT JOIN delivery_requests dr ON dr.id = co.delivery_id
    JOIN profiles p ON p.id = co.reporter_id
    ORDER BY co.created_at DESC
  `).all() as any[];

  return rows.map((r) => ({
    id: r.id,
    ticketType: (r.ticket_type || 'complaint') as 'complaint' | 'suggestion',
    deliveryId: r.delivery_id || null,
    trackingCode: r.tracking_code || null,
    reporterId: r.reporter_id,
    reporterName: r.reporter_name,
    reporterEmail: r.reporter_email,
    reporterPhone: r.reporter_phone,
    subject: r.subject,
    details: r.details,
    status: r.status,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at,
  }));
}

export async function getTicketsForReporter(reporterId: string): Promise<ComplaintRecord[]> {
  return (await getAllComplaints()).filter((c) => c.reporterId === reporterId);
}

export async function getNotificationsForUser(userId: string): Promise<NotificationItem[]> {
  const rows = await db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30')
    .all(userId) as any[];
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    title: r.title,
    message: r.message,
    deliveryId: r.delivery_id,
    isRead: Boolean(r.is_read),
    createdAt: r.created_at,
  }));
}

export async function createNotification(
  userId: string,
  title: string,
  message: string,
  deliveryId: string | null = null
): Promise<NotificationItem> {
  const id = `notif-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO notifications (id, user_id, title, message, delivery_id, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(id, userId, title, message, deliveryId, now);
  return {
    id,
    userId,
    title,
    message,
    deliveryId,
    isRead: false,
    createdAt: now,
  };
}

function mapSupportConversationRow(r: any): SupportConversation {
  return {
    id: r.id,
    visitorToken: r.visitor_token,
    userId: r.user_id || null,
    visitorName: r.visitor_name,
    visitorEmail: r.visitor_email || null,
    visitorPhone: r.visitor_phone || null,
    trackingCode: r.tracking_code || null,
    status: r.status as SupportConversationStatus,
    assignedAdminId: r.assigned_admin_id || null,
    unreadByAdmin: Number(r.unread_by_admin || 0),
    unreadByVisitor: Number(r.unread_by_visitor || 0),
    lastMessagePreview: r.last_message_preview || null,
    lastMessageAt: r.last_message_at,
    createdAt: r.created_at,
  };
}

export async function getSupportConversationById(id: string): Promise<SupportConversation | null> {
  const row = await db.prepare('SELECT * FROM support_conversations WHERE id = ?').get(id) as any;
  return row ? mapSupportConversationRow(row) : null;
}

export async function getAllSupportConversations(): Promise<SupportConversation[]> {
  const rows = await db
    .prepare('SELECT * FROM support_conversations ORDER BY last_message_at DESC')
    .all() as any[];
  return rows.map(mapSupportConversationRow);
}

export async function getSupportConversationsForVisitor(params: {
  visitorToken?: string | null;
  userId?: string | null;
}): Promise<SupportConversation[]> {
  const { visitorToken, userId } = params;
  if (userId && visitorToken) {
    // Associate any anonymous conversations started in the same browser with this signed-in user
    await db.prepare(
      `UPDATE support_conversations SET user_id = ? WHERE visitor_token = ? AND user_id IS NULL`
    ).run(userId, visitorToken);
    const rows = await db
      .prepare(
        `SELECT * FROM support_conversations WHERE user_id = ? OR visitor_token = ? ORDER BY last_message_at DESC`
      )
      .all(userId, visitorToken) as any[];
    return rows.map(mapSupportConversationRow);
  }
  if (userId) {
    const rows = await db
      .prepare(`SELECT * FROM support_conversations WHERE user_id = ? ORDER BY last_message_at DESC`)
      .all(userId) as any[];
    return rows.map(mapSupportConversationRow);
  }
  if (visitorToken) {
    const rows = await db
      .prepare(
        `SELECT * FROM support_conversations WHERE visitor_token = ? ORDER BY last_message_at DESC`
      )
      .all(visitorToken) as any[];
    return rows.map(mapSupportConversationRow);
  }
  return [];
}

export async function getSupportMessages(conversationId: string): Promise<SupportMessage[]> {
  const rows = await db
    .prepare('SELECT * FROM support_messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as any[];
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    senderRole: r.sender_role as SupportSenderRole,
    senderName: r.sender_name,
    body: r.body,
    createdAt: r.created_at,
  }));
}

export async function createSupportConversation(input: {
  visitorToken: string;
  userId: string | null;
  visitorName: string;
  visitorEmail: string | null;
  visitorPhone: string | null;
  trackingCode: string | null;
  initialMessage: string;
  senderRole: SupportSenderRole;
}): Promise<{ conversation: SupportConversation; message: SupportMessage }> {
  const convId = `chat-${crypto.randomUUID().slice(0, 8)}`;
  const msgId = `cmsg-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const cleanPreview = input.initialMessage.trim().slice(0, 140);

  await db.prepare(`
    INSERT INTO support_conversations (
      id, visitor_token, user_id, visitor_name, visitor_email, visitor_phone,
      tracking_code, status, assigned_admin_id, unread_by_admin, unread_by_visitor,
      last_message_preview, last_message_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, 1, 0, ?, ?, ?)
  `).run(
    convId,
    input.visitorToken,
    input.userId,
    input.visitorName.trim(),
    input.visitorEmail ? input.visitorEmail.trim() : null,
    input.visitorPhone ? input.visitorPhone.trim() : null,
    input.trackingCode ? input.trackingCode.trim().toUpperCase() : null,
    cleanPreview,
    now,
    now
  );

  await db.prepare(`
    INSERT INTO support_messages (id, conversation_id, sender_role, sender_name, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(msgId, convId, input.senderRole, input.visitorName.trim(), input.initialMessage.trim(), now);

  return {
    conversation: (await getSupportConversationById(convId))!,
    message: {
      id: msgId,
      conversationId: convId,
      senderRole: input.senderRole,
      senderName: input.visitorName.trim(),
      body: input.initialMessage.trim(),
      createdAt: now,
    },
  };
}

export async function addSupportMessage(input: {
  conversationId: string;
  senderRole: SupportSenderRole;
  senderName: string;
  body: string;
  assignedAdminId?: string | null;
}): Promise<{ conversation: SupportConversation; message: SupportMessage }> {
  const msgId = `cmsg-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const cleanBody = input.body.trim();
  const preview = cleanBody.slice(0, 140);

  await db.prepare(`
    INSERT INTO support_messages (id, conversation_id, sender_role, sender_name, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(msgId, input.conversationId, input.senderRole, input.senderName, cleanBody, now);

  if (input.senderRole === 'admin') {
    await db.prepare(`
      UPDATE support_conversations
      SET unread_by_visitor = unread_by_visitor + 1,
          unread_by_admin = 0,
          status = CASE WHEN status IN ('resolved', 'closed') THEN 'open' ELSE status END,
          assigned_admin_id = COALESCE(?, assigned_admin_id),
          last_message_preview = ?,
          last_message_at = ?
      WHERE id = ?
    `).run(input.assignedAdminId || null, preview, now, input.conversationId);
  } else if (input.senderRole === 'system') {
    await db.prepare(`
      UPDATE support_conversations
      SET last_message_preview = ?, last_message_at = ?
      WHERE id = ?
    `).run(preview, now, input.conversationId);
  } else {
    await db.prepare(`
      UPDATE support_conversations
      SET unread_by_admin = unread_by_admin + 1,
          unread_by_visitor = 0,
          status = CASE WHEN status IN ('resolved', 'closed') THEN 'open' ELSE status END,
          last_message_preview = ?,
          last_message_at = ?
      WHERE id = ?
    `).run(preview, now, input.conversationId);
  }

  return {
    conversation: (await getSupportConversationById(input.conversationId))!,
    message: {
      id: msgId,
      conversationId: input.conversationId,
      senderRole: input.senderRole,
      senderName: input.senderName,
      body: cleanBody,
      createdAt: now,
    },
  };
}

export async function markSupportConversationRead(
  conversationId: string,
  reader: 'admin' | 'visitor'
): Promise<SupportConversation | null> {
  if (reader === 'admin') {
    await db.prepare('UPDATE support_conversations SET unread_by_admin = 0 WHERE id = ?').run(
      conversationId
    );
  } else {
    await db.prepare('UPDATE support_conversations SET unread_by_visitor = 0 WHERE id = ?').run(
      conversationId
    );
  }
  return await getSupportConversationById(conversationId);
}

export async function updateSupportConversationStatus(
  conversationId: string,
  status: SupportConversationStatus,
  actorName: string
): Promise<{ conversation: SupportConversation; systemMessage: SupportMessage } | null> {
  const existing = await getSupportConversationById(conversationId);
  if (!existing) return null;
  await db.prepare('UPDATE support_conversations SET status = ? WHERE id = ?').run(
    status,
    conversationId
  );
  const labelMap: Record<SupportConversationStatus, string> = {
    open: 'reopened',
    pending: 'marked as awaiting response',
    resolved: 'marked as resolved',
    closed: 'closed',
  };
  const { conversation, message } = await addSupportMessage({
    conversationId,
    senderRole: 'system',
    senderName: 'SAQO Support',
    body: `Conversation ${labelMap[status]} by ${actorName}.`,
  });
  return { conversation, systemMessage: message };
}
