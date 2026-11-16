import crypto from 'node:crypto';
import { sendOpsAlert } from './opsAlerts';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { db, createNotification, getDeliveryById, getProfileById } from './db';
import { afterDatabaseCommit, deferDatabaseEffect, pool, databaseTransaction as withImmediateTransaction } from './database';
export { databaseTransaction as withImmediateTransaction } from './database';
import { broadcastWsEvent, dispatchWaitingDeliveries } from './dispatchEngine';
import type {
  AdminPaymentsOverview,
  CashCollectionRecord,
  DeliveryPaymentStatus,
  PaymentGatewayAdminView,
  PaymentGatewayPublicConfig,
  PaymentMethodCode,
  PaymentMethodConfig,
  PaymentPurpose,
  PaymentTransaction,
  PaymentWebhookEventRecord,
  RefundRecord,
  WalletAccount,
  WalletTransaction,
} from '../shared/types';

export class InsufficientWalletBalanceError extends Error {
  requiredAmountNgn: number;
  availableBalanceNgn: number;
  code = 'INSUFFICIENT_WALLET_BALANCE';

  constructor(requiredAmountNgn: number, availableBalanceNgn: number) {
    super(
      `Insufficient wallet balance. Required ₦${requiredAmountNgn.toLocaleString()}, available ₦${availableBalanceNgn.toLocaleString()}.`
    );
    this.requiredAmountNgn = requiredAmountNgn;
    this.availableBalanceNgn = availableBalanceNgn;
  }
}

export class PaymentConfigError extends Error {
  statusCode = 400;
  code = 'PAYMENT_GATEWAY_NOT_CONFIGURED';
}

export class PaymentVerificationError extends Error {
  statusCode = 400;
  code = 'PAYMENT_VERIFICATION_FAILED';
}

class GatewayRefundRejected extends PaymentVerificationError {}

let cachedSupabase: SupabaseClient | null = null;
function getSupabaseAdminClient(): SupabaseClient | null {
  if (pool) return null;
  if (cachedSupabase) return cachedSupabase;
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  cachedSupabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedSupabase;
}

function syncAsync(task: (sb: SupabaseClient) => Promise<unknown>): void {
  afterDatabaseCommit(() => {
    const sb = getSupabaseAdminClient();
    if (!sb) return;
    void task(sb).catch(() => {
      // Non-fatal mirror to Supabase so offline/unit-test SQLite runs keep working.
    });
  });
}

async function notifyUser(userId: string, title: string, message: string, deliveryId: string | null = null): Promise<void> {
  const notif = await createNotification(userId, title, message, deliveryId);
  await broadcastWsEvent('notification:created', notif);
}

function roundCurrency(amount: number): number {
  return Math.round(Number(amount) * 100) / 100;
}

export function generateReference(prefix: string): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `SAQO-${prefix}-${ts}-${rand}`;
}

function deriveEncryptionKey(): Buffer {
  const rawSecret =
    process.env.SAQO_CREDENTIAL_KEY ||
    process.env.SAQO_SESSION_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    'saqo-dev-hmac-secret-2026';
  return crypto.createHash('sha256').update(rawSecret).digest();
}

export function encryptSecret(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (!trimmed) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(stored: string): string {
  const value = (stored || '').trim();
  if (!value) return '';
  if (!value.startsWith('enc:v1:')) return value;
  const parts = value.split(':');
  if (parts.length !== 5) return '';
  try {
    const [, , ivHex, tagHex, cipherHex] = parts;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      deriveEncryptionKey(),
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(cipherHex, 'hex')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch {
    return '';
  }
}

export function maskSecret(secret: string): string {
  const clean = (secret || '').trim();
  if (!clean) return '';
  if (clean.length <= 8) return '••••••••';
  const dashIdx = clean.indexOf('-');
  const prefixLen = dashIdx > 0 && dashIdx <= 16 ? dashIdx + 1 : 4;
  const prefix = clean.slice(0, prefixLen);
  const suffix = clean.slice(-4);
  return `${prefix}••••••••${suffix}`;
}

function isMaskedPlaceholder(value: string | undefined | null): boolean {
  return Boolean(value && value.includes('••••'));
}

function parseJsonSafe(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mapWalletRow(row: any): WalletAccount {
  return {
    id: row.id,
    userId: row.user_id,
    customerName: row.customer_name || undefined,
    customerEmail: row.customer_email || undefined,
    customerPhone: row.customer_phone || undefined,
    balanceNgn: roundCurrency(row.balance_ngn),
    lockedBalanceNgn: roundCurrency(row.locked_balance_ngn),
    currency: row.currency || 'NGN',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWalletTxRow(row: any): WalletTransaction {
  return {
    id: row.id,
    walletId: row.wallet_id,
    userId: row.user_id,
    type: row.type,
    category: row.category,
    amountNgn: roundCurrency(row.amount_ngn),
    balanceBeforeNgn: roundCurrency(row.balance_before_ngn),
    balanceAfterNgn: roundCurrency(row.balance_after_ngn),
    currency: row.currency || 'NGN',
    reference: row.reference,
    idempotencyKey: row.idempotency_key || null,
    deliveryId: row.delivery_id || null,
    trackingCode: row.tracking_code || null,
    paymentTransactionId: row.payment_transaction_id || null,
    status: row.status,
    description: row.description || '',
    actorUserId: row.actor_user_id || null,
    actorRole: row.actor_role || null,
    metadata: parseJsonSafe(row.metadata),
    createdAt: row.created_at,
  };
}

function mapPaymentTxRow(row: any): PaymentTransaction {
  return {
    id: row.id,
    reference: row.reference,
    idempotencyKey: row.idempotency_key || null,
    providerTxId: row.provider_tx_id || null,
    providerTxRef: row.provider_tx_ref || null,
    userId: row.user_id,
    customerName: row.customer_name || row.profile_name || null,
    customerEmail: row.customer_email || row.profile_email || null,
    customerPhone: row.customer_phone || row.profile_phone || null,
    walletId: row.wallet_id || null,
    deliveryId: row.delivery_id || null,
    trackingCode: row.tracking_code || row.delivery_tracking_code || null,
    purpose: row.purpose,
    paymentMethod: row.payment_method,
    provider: row.provider,
    amountNgn: roundCurrency(row.amount_ngn),
    feeNgn: roundCurrency(row.fee_ngn || 0),
    currency: row.currency || 'NGN',
    status: row.status,
    checkoutUrl: row.checkout_url || null,
    transferReference: row.transfer_reference || null,
    transferProofNote: row.transfer_proof_note || null,
    failureReason: row.failure_reason || null,
    verifiedAt: row.verified_at || null,
    verifiedBy: row.verified_by || null,
    metadata: parseJsonSafe(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCashCollectionRow(row: any): CashCollectionRecord {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    trackingCode: row.tracking_code,
    paymentTransactionId: row.payment_transaction_id || null,
    customerId: row.customer_id,
    customerName: row.customer_name || undefined,
    customerPhone: row.customer_phone || undefined,
    riderId: row.rider_id || null,
    riderName: row.rider_name || null,
    paymentMethod: row.payment_method,
    expectedAmountNgn: roundCurrency(row.expected_amount_ngn),
    collectedAmountNgn: roundCurrency(row.collected_amount_ngn),
    status: row.status,
    transferReference: row.transfer_reference || null,
    transferProofNote: row.transfer_proof_note || null,
    riderConfirmedAt: row.rider_confirmed_at || null,
    reconciledBy: row.reconciled_by || null,
    reconciledAt: row.reconciled_at || null,
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRefundRow(row: any): RefundRecord {
  return {
    id: row.id,
    reference: row.reference,
    paymentTransactionId: row.payment_transaction_id || null,
    paymentReference: row.payment_reference || null,
    deliveryId: row.delivery_id || null,
    trackingCode: row.tracking_code || null,
    userId: row.user_id,
    customerName: row.customer_name || undefined,
    amountNgn: roundCurrency(row.amount_ngn),
    destination: row.destination,
    reason: row.reason,
    status: row.status,
    providerRefundId: row.provider_refund_id || null,
    initiatedBy: row.initiated_by,
    processedAt: row.processed_at || null,
    createdAt: row.created_at,
  };
}

export async function ensureWallet(userId: string): Promise<WalletAccount> {
  const existing = await db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId) as any;
  if (existing) return mapWalletRow(existing);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT OR IGNORE INTO wallets (id, user_id, balance_ngn, locked_balance_ngn, currency, status, created_at, updated_at)
    VALUES (?, ?, 0, 0, 'NGN', 'active', ?, ?)
  `).run(id, userId, now, now);

  const row = await db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId) as any;
  syncAsync((sb) => Promise.resolve(sb.rpc('saqo_ensure_wallet', { p_user_id: userId })));
  return mapWalletRow(row);
}

export async function getPaymentMethods(): Promise<PaymentMethodConfig[]> {
  const rows = await db
    .prepare('SELECT * FROM payment_methods ORDER BY sort_order ASC')
    .all() as any[];
  return rows.map((r) => ({
    code: r.code as PaymentMethodCode,
    name: r.name,
    description: r.description,
    isEnabled: Boolean(r.is_enabled),
    sortOrder: r.sort_order,
  }));
}

export async function getDecryptedGatewaySecrets(): Promise<{
  publicKey: string;
  secretKey: string;
  encryptionKey: string;
  webhookSecretHash: string;
  mode: 'test' | 'live';
  isEnabled: boolean;
  configured: boolean;
}> {
  const row = await db.prepare("SELECT * FROM payment_gateway_settings WHERE id = 'default'").get() as any;
  const publicKey = (row?.public_key || process.env.FLUTTERWAVE_PUBLIC_KEY || '').trim();
  const secretKey =
    decryptSecret(row?.secret_key_encrypted || '') ||
    (process.env.FLUTTERWAVE_SECRET_KEY || '').trim();
  const encryptionKey =
    decryptSecret(row?.encryption_key_encrypted || '') ||
    (process.env.FLUTTERWAVE_ENCRYPTION_KEY || '').trim();
  const webhookSecretHash =
    decryptSecret(row?.webhook_secret_hash_encrypted || '') ||
    (process.env.FLUTTERWAVE_WEBHOOK_HASH || '').trim();

  const configured = Boolean(publicKey && secretKey);
  return {
    publicKey,
    secretKey,
    encryptionKey,
    webhookSecretHash,
    mode: row?.mode === 'live' ? 'live' : 'test',
    isEnabled: Boolean(row?.is_enabled),
    configured,
  };
}

export async function getGatewayPublicConfig(): Promise<PaymentGatewayPublicConfig> {
  const row = await db.prepare("SELECT * FROM payment_gateway_settings WHERE id = 'default'").get() as any;
  const secrets = await getDecryptedGatewaySecrets();
  const methods = await getPaymentMethods();

  return {
    provider: 'flutterwave',
    configured: secrets.configured,
    isEnabled: secrets.isEnabled && secrets.configured,
    mode: secrets.mode,
    publicKey: secrets.publicKey,
    bankDetails: {
      bankName: row?.bank_name || 'Access Bank',
      accountName: row?.bank_account_name || 'SAQO Logistics Ltd',
      accountNumber: row?.bank_account_number || '0000000000',
      instructions:
        row?.bank_instructions || 'Use your tracking code or payment reference as transfer narration.',
    },
    methods,
  };
}

export async function getGatewayAdminView(baseOrigin = ''): Promise<PaymentGatewayAdminView> {
  const row = await db.prepare("SELECT * FROM payment_gateway_settings WHERE id = 'default'").get() as any;
  const secrets = await getDecryptedGatewaySecrets();
  const defaultWebhook = baseOrigin ? `${baseOrigin.replace(/\/$/, '')}/api/webhooks/flutterwave` : '/api/webhooks/flutterwave';

  return {
    provider: 'flutterwave',
    publicKey: secrets.publicKey,
    secretKeyMasked: maskSecret(secrets.secretKey),
    encryptionKeyMasked: maskSecret(secrets.encryptionKey),
    webhookSecretHashMasked: maskSecret(secrets.webhookSecretHash),
    hasSecretKey: Boolean(secrets.secretKey),
    hasEncryptionKey: Boolean(secrets.encryptionKey),
    hasWebhookSecretHash: Boolean(secrets.webhookSecretHash),
    webhookUrl: (row?.webhook_url || '').trim() || defaultWebhook,
    mode: secrets.mode,
    isEnabled: secrets.isEnabled,
    configured: secrets.configured,
    bankName: row?.bank_name || '',
    bankAccountName: row?.bank_account_name || '',
    bankAccountNumber: row?.bank_account_number || '',
    bankInstructions: row?.bank_instructions || '',
    methods: await getPaymentMethods(),
    updatedBy: row?.updated_by || null,
    updatedAt: row?.updated_at || new Date().toISOString(),
  };
}

export async function updateGatewaySettings(
  input: {
    publicKey?: string;
    secretKey?: string;
    encryptionKey?: string;
    webhookSecretHash?: string;
    webhookUrl?: string;
    mode?: 'test' | 'live';
    isEnabled?: boolean;
    bankName?: string;
    bankAccountName?: string;
    bankAccountNumber?: string;
    bankInstructions?: string;
    methods?: Array<{ code: PaymentMethodCode; isEnabled: boolean }>;
  },
  adminId: string,
  baseOrigin = ''
): Promise<PaymentGatewayAdminView> {
  const current = await db.prepare("SELECT * FROM payment_gateway_settings WHERE id = 'default'").get() as any;
  const now = new Date().toISOString();

  const nextPublicKey =
    input.publicKey !== undefined ? input.publicKey.trim() : (current?.public_key || '');

  const nextSecretEncrypted =
    input.secretKey !== undefined && input.secretKey.trim() !== '' && !isMaskedPlaceholder(input.secretKey)
      ? encryptSecret(input.secretKey)
      : (current?.secret_key_encrypted || '');

  const nextEncryptionEncrypted =
    input.encryptionKey !== undefined &&
    input.encryptionKey.trim() !== '' &&
    !isMaskedPlaceholder(input.encryptionKey)
      ? encryptSecret(input.encryptionKey)
      : (current?.encryption_key_encrypted || '');

  const nextWebhookHashEncrypted =
    input.webhookSecretHash !== undefined &&
    input.webhookSecretHash.trim() !== '' &&
    !isMaskedPlaceholder(input.webhookSecretHash)
      ? encryptSecret(input.webhookSecretHash)
      : (current?.webhook_secret_hash_encrypted || '');

  const nextMode: 'test' | 'live' =
    input.mode === 'live' ? 'live' : input.mode === 'test' ? 'test' : current?.mode === 'live' ? 'live' : 'test';

  const nextEnabled =
    input.isEnabled !== undefined ? (input.isEnabled ? 1 : 0) : (current?.is_enabled ?? 0);

  const nextWebhookUrl =
    input.webhookUrl !== undefined ? input.webhookUrl.trim() : (current?.webhook_url || '');

  const nextBankName =
    input.bankName !== undefined ? input.bankName.trim() : (current?.bank_name || '');
  const nextBankAccountName =
    input.bankAccountName !== undefined
      ? input.bankAccountName.trim()
      : (current?.bank_account_name || '');
  const nextBankAccountNumber =
    input.bankAccountNumber !== undefined
      ? input.bankAccountNumber.trim()
      : (current?.bank_account_number || '');
  const nextBankInstructions =
    input.bankInstructions !== undefined
      ? input.bankInstructions.trim()
      : (current?.bank_instructions || '');

  await withImmediateTransaction(async () => {
    await db.prepare(`
      UPDATE payment_gateway_settings
      SET public_key = ?,
          secret_key_encrypted = ?,
          encryption_key_encrypted = ?,
          webhook_secret_hash_encrypted = ?,
          webhook_url = ?,
          mode = ?,
          is_enabled = ?,
          bank_name = ?,
          bank_account_name = ?,
          bank_account_number = ?,
          bank_instructions = ?,
          updated_by = ?,
          updated_at = ?
      WHERE id = 'default'
    `).run(
      nextPublicKey,
      nextSecretEncrypted,
      nextEncryptionEncrypted,
      nextWebhookHashEncrypted,
      nextWebhookUrl,
      nextMode,
      nextEnabled,
      nextBankName,
      nextBankAccountName,
      nextBankAccountNumber,
      nextBankInstructions,
      adminId,
      now
    );

    if (Array.isArray(input.methods)) {
      const updateMethod = db.prepare(
        'UPDATE payment_methods SET is_enabled = ?, updated_at = ? WHERE code = ?'
      );
      for (const m of input.methods) {
        await updateMethod.run(m.isEnabled ? 1 : 0, now, m.code);
      }
    }
  });

  syncAsync(async (sb) => {
    await sb.from('payment_gateway_settings').upsert({
      id: 'default',
      provider: 'flutterwave',
      public_key: nextPublicKey,
      secret_key_encrypted: nextSecretEncrypted,
      encryption_key_encrypted: nextEncryptionEncrypted,
      webhook_secret_hash_encrypted: nextWebhookHashEncrypted,
      webhook_url: nextWebhookUrl,
      mode: nextMode,
      is_enabled: Boolean(nextEnabled),
      bank_name: nextBankName,
      bank_account_name: nextBankAccountName,
      bank_account_number: nextBankAccountNumber,
      bank_instructions: nextBankInstructions,
      updated_by: adminId,
      updated_at: now,
    });
    if (Array.isArray(input.methods)) {
      for (const m of input.methods) {
        await sb
          .from('payment_methods')
          .update({ is_enabled: m.isEnabled, updated_at: now })
          .eq('code', m.code);
      }
    }
  });

  await broadcastWsEvent('gateway:updated', await getGatewayPublicConfig());
  return await getGatewayAdminView(baseOrigin);
}

export async function creditWalletAtomic(params: {
  userId: string;
  amountNgn: number;
  reference: string;
  idempotencyKey?: string | null;
  category?: WalletTransaction['category'];
  description?: string;
  deliveryId?: string | null;
  paymentTransactionId?: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<{ wallet: WalletAccount; transaction: WalletTransaction; alreadyProcessed: boolean }> {
  const amount = roundCurrency(params.amountNgn);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Wallet credit amount must be greater than zero.');
  }

  const outcome = await withImmediateTransaction(async () => {
    if (params.idempotencyKey) {
      const existingByKey = await db
        .prepare('SELECT * FROM wallet_transactions WHERE idempotency_key = ?')
        .get(params.idempotencyKey) as any;
      if (existingByKey) {
        const w = await db.prepare('SELECT * FROM wallets WHERE id = ?').get(existingByKey.wallet_id) as any;
        return { wallet: mapWalletRow(w), transaction: mapWalletTxRow(existingByKey), alreadyProcessed: true };
      }
    }

    const existingByRef = await db
      .prepare('SELECT * FROM wallet_transactions WHERE reference = ?')
      .get(params.reference) as any;
    if (existingByRef) {
      const w = await db.prepare('SELECT * FROM wallets WHERE id = ?').get(existingByRef.wallet_id) as any;
      return { wallet: mapWalletRow(w), transaction: mapWalletTxRow(existingByRef), alreadyProcessed: true };
    }

    const wallet = await ensureWallet(params.userId);
    if (wallet.status !== 'active') {
      throw new Error(`Wallet is ${wallet.status} and cannot be credited.`);
    }

    const now = new Date().toISOString();
    const before = roundCurrency(wallet.balanceNgn);
    const after = roundCurrency(before + amount);
    const txId = crypto.randomUUID();

    await db.prepare('UPDATE wallets SET balance_ngn = ?, updated_at = ? WHERE id = ?').run(
      after,
      now,
      wallet.id
    );

    await db.prepare(`
      INSERT INTO wallet_transactions (
        id, wallet_id, user_id, type, category, amount_ngn,
        balance_before_ngn, balance_after_ngn, currency,
        reference, idempotency_key, delivery_id, payment_transaction_id,
        status, description, actor_user_id, actor_role, metadata, created_at
      ) VALUES (?, ?, ?, 'credit', ?, ?, ?, ?, 'NGN', ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
    `).run(
      txId,
      wallet.id,
      params.userId,
      params.category || 'funding',
      amount,
      before,
      after,
      params.reference,
      params.idempotencyKey || null,
      params.deliveryId || null,
      params.paymentTransactionId || null,
      params.description || 'Wallet funded',
      params.actorUserId || params.userId,
      params.actorRole || 'system',
      JSON.stringify(params.metadata || {}),
      now
    );

    const updatedWallet = mapWalletRow(
      await db.prepare('SELECT * FROM wallets WHERE id = ?').get(wallet.id)
    );
    const insertedTx = mapWalletTxRow(
      await db.prepare('SELECT * FROM wallet_transactions WHERE id = ?').get(txId)
    );
    return { wallet: updatedWallet, transaction: insertedTx, alreadyProcessed: false };
  });

  const publish = async () => {
    await notifyUser(
      params.userId,
      'Wallet Credited',
      `₦${amount.toLocaleString()} credited (${params.reference}). New balance: ₦${outcome.wallet.balanceNgn.toLocaleString()}.`,
      params.deliveryId || null
    );
    await broadcastWsEvent('wallet:updated', {
      userId: params.userId,
      wallet: outcome.wallet,
      transaction: outcome.transaction,
    });
    syncAsync((sb) =>
      Promise.resolve(
        sb.rpc('saqo_credit_wallet', {
          p_user_id: params.userId,
          p_amount_ngn: amount,
          p_reference: params.reference,
          p_idempotency_key: params.idempotencyKey || null,
          p_category: params.category || 'funding',
          p_description: params.description || 'Wallet funded',
          p_delivery_id: params.deliveryId || null,
          p_payment_transaction_id: params.paymentTransactionId || null,
          p_actor_user_id: params.actorUserId || params.userId,
          p_actor_role: params.actorRole || 'system',
          p_metadata: params.metadata || {},
        })
      )
    );
  };
  if (!outcome.alreadyProcessed) {
    if (!deferDatabaseEffect(() => void publish().catch(console.error))) await publish();
  }

  return outcome;
}

export async function debitWalletAtomic(params: {
  userId: string;
  amountNgn: number;
  reference: string;
  idempotencyKey?: string | null;
  category?: WalletTransaction['category'];
  description?: string;
  deliveryId?: string | null;
  paymentTransactionId?: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<{ wallet: WalletAccount; transaction: WalletTransaction; alreadyProcessed: boolean }> {
  const amount = roundCurrency(params.amountNgn);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Wallet debit amount must be greater than zero.');
  }

  const outcome = await withImmediateTransaction(async () => {
    if (params.idempotencyKey) {
      const existingByKey = await db
        .prepare('SELECT * FROM wallet_transactions WHERE idempotency_key = ?')
        .get(params.idempotencyKey) as any;
      if (existingByKey) {
        const w = await db.prepare('SELECT * FROM wallets WHERE id = ?').get(existingByKey.wallet_id) as any;
        return { wallet: mapWalletRow(w), transaction: mapWalletTxRow(existingByKey), alreadyProcessed: true };
      }
    }

    const existingByRef = await db
      .prepare('SELECT * FROM wallet_transactions WHERE reference = ?')
      .get(params.reference) as any;
    if (existingByRef) {
      const w = await db.prepare('SELECT * FROM wallets WHERE id = ?').get(existingByRef.wallet_id) as any;
      return { wallet: mapWalletRow(w), transaction: mapWalletTxRow(existingByRef), alreadyProcessed: true };
    }

    const wallet = await ensureWallet(params.userId);
    if (wallet.status !== 'active') {
      throw new Error(`Wallet is ${wallet.status} and cannot be debited.`);
    }

    const before = roundCurrency(wallet.balanceNgn);
    if (before < amount) {
      throw new InsufficientWalletBalanceError(amount, before);
    }

    const now = new Date().toISOString();
    const after = roundCurrency(before - amount);
    const txId = crypto.randomUUID();

    await db.prepare('UPDATE wallets SET balance_ngn = ?, updated_at = ? WHERE id = ?').run(
      after,
      now,
      wallet.id
    );

    await db.prepare(`
      INSERT INTO wallet_transactions (
        id, wallet_id, user_id, type, category, amount_ngn,
        balance_before_ngn, balance_after_ngn, currency,
        reference, idempotency_key, delivery_id, payment_transaction_id,
        status, description, actor_user_id, actor_role, metadata, created_at
      ) VALUES (?, ?, ?, 'debit', ?, ?, ?, ?, 'NGN', ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
    `).run(
      txId,
      wallet.id,
      params.userId,
      params.category || 'delivery_payment',
      amount,
      before,
      after,
      params.reference,
      params.idempotencyKey || null,
      params.deliveryId || null,
      params.paymentTransactionId || null,
      params.description || 'Delivery payment',
      params.actorUserId || params.userId,
      params.actorRole || 'client',
      JSON.stringify(params.metadata || {}),
      now
    );

    const updatedWallet = mapWalletRow(
      await db.prepare('SELECT * FROM wallets WHERE id = ?').get(wallet.id)
    );
    const insertedTx = mapWalletTxRow(
      await db.prepare('SELECT * FROM wallet_transactions WHERE id = ?').get(txId)
    );
    return { wallet: updatedWallet, transaction: insertedTx, alreadyProcessed: false };
  });

  if (!outcome.alreadyProcessed) {
    const publish = async () => {
      await notifyUser(
        params.userId,
        'Wallet Debited',
        `₦${amount.toLocaleString()} debited (${params.description || params.reference}). Remaining balance: ₦${outcome.wallet.balanceNgn.toLocaleString()}.`,
        params.deliveryId || null
      );
      await broadcastWsEvent('wallet:updated', {
        userId: params.userId,
        wallet: outcome.wallet,
        transaction: outcome.transaction,
      });
      syncAsync((sb) =>
        Promise.resolve(
          sb.rpc('saqo_debit_wallet', {
            p_user_id: params.userId,
            p_amount_ngn: amount,
            p_reference: params.reference,
            p_idempotency_key: params.idempotencyKey || null,
            p_category: params.category || 'delivery_payment',
            p_description: params.description || 'Delivery payment',
            p_delivery_id: params.deliveryId || null,
            p_payment_transaction_id: params.paymentTransactionId || null,
            p_actor_user_id: params.actorUserId || params.userId,
            p_actor_role: params.actorRole || 'client',
            p_metadata: params.metadata || {},
          })
        )
      );
    };
    if (!deferDatabaseEffect(() => void publish().catch(console.error))) {
      await publish();
    }
  }

  return outcome;
}

export async function adjustWalletAtomic(params: {
  walletId: string;
  direction: 'credit' | 'debit';
  amountNgn: number;
  reason: string;
  actorId: string;
  actorName: string;
  idempotencyKey?: string | null;
}): Promise<{ wallet: WalletAccount; transaction: WalletTransaction; alreadyProcessed: boolean }> {
  const cleanReason = (params.reason || '').trim();
  if (cleanReason.length < 3) {
    throw new Error('Mandatory reason (at least 3 characters) is required for wallet adjustments.');
  }
  const amount = roundCurrency(params.amountNgn);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Adjustment amount must be positive.');
  }

  const reference = generateReference('ADJ');
  const outcome = await withImmediateTransaction(async () => {
    if (params.idempotencyKey) {
      const existing = await db
        .prepare('SELECT * FROM wallet_transactions WHERE idempotency_key = ?')
        .get(params.idempotencyKey) as any;
      if (existing) {
        const w = await db.prepare('SELECT * FROM wallets WHERE id = ?').get(existing.wallet_id) as any;
        return { wallet: mapWalletRow(w), transaction: mapWalletTxRow(existing), alreadyProcessed: true };
      }
    }

    const row = await db.prepare('SELECT * FROM wallets WHERE id = ?').get(params.walletId) as any;
    if (!row) {
      throw new Error('Wallet not found.');
    }

    const before = roundCurrency(row.balance_ngn);
    if (params.direction === 'debit' && before < amount) {
      throw new InsufficientWalletBalanceError(amount, before);
    }

    const after =
      params.direction === 'debit' ? roundCurrency(before - amount) : roundCurrency(before + amount);
    const now = new Date().toISOString();
    const txId = crypto.randomUUID();

    await db.prepare('UPDATE wallets SET balance_ngn = ?, updated_at = ? WHERE id = ?').run(
      after,
      now,
      row.id
    );

    await db.prepare(`
      INSERT INTO wallet_transactions (
        id, wallet_id, user_id, type, category, amount_ngn,
        balance_before_ngn, balance_after_ngn, currency,
        reference, idempotency_key, status, description,
        actor_user_id, actor_role, metadata, created_at
      ) VALUES (?, ?, ?, 'adjustment', 'admin_adjustment', ?, ?, ?, 'NGN', ?, ?, 'completed', ?, ?, 'admin', ?, ?)
    `).run(
      txId,
      row.id,
      row.user_id,
      amount,
      before,
      after,
      reference,
      params.idempotencyKey || null,
      cleanReason,
      params.actorId,
      JSON.stringify({ direction: params.direction, reason: cleanReason, actorName: params.actorName }),
      now
    );

    await db.prepare(`
      INSERT INTO wallet_audit_logs (
        id, wallet_id, user_id, action, amount_ngn, direction, reason, actor_id, actor_name, created_at
      ) VALUES (?, ?, ?, 'admin_wallet_adjustment', ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      row.id,
      row.user_id,
      amount,
      params.direction,
      cleanReason,
      params.actorId,
      params.actorName,
      now
    );

    const updatedWallet = mapWalletRow(await db.prepare('SELECT * FROM wallets WHERE id = ?').get(row.id));
    const insertedTx = mapWalletTxRow(
      await db.prepare('SELECT * FROM wallet_transactions WHERE id = ?').get(txId)
    );
    return { wallet: updatedWallet, transaction: insertedTx, alreadyProcessed: false };
  });

  if (!outcome.alreadyProcessed) {
    const verb = params.direction === 'credit' ? 'credited with' : 'debited by';
    await notifyUser(
      outcome.wallet.userId,
      'Wallet Adjusted by Admin',
      `Your wallet was ${verb} ₦${amount.toLocaleString()}. Reason: ${cleanReason}. Balance: ₦${outcome.wallet.balanceNgn.toLocaleString()}.`
    );
    await broadcastWsEvent('wallet:updated', {
      userId: outcome.wallet.userId,
      wallet: outcome.wallet,
      transaction: outcome.transaction,
    });
    syncAsync((sb) =>
      Promise.resolve(
        sb.rpc('saqo_adjust_wallet', {
          p_user_id: outcome.wallet.userId,
          p_direction: params.direction,
          p_amount_ngn: amount,
          p_reference: outcome.transaction.reference,
          p_reason: cleanReason,
          p_actor_user_id: params.actorId,
          p_idempotency_key: params.idempotencyKey || null,
        })
      )
    );
  }

  return outcome;
}

export async function initializeFlutterwaveCheckout(params: {
  txRef: string;
  amountNgn: number;
  redirectUrl: string;
  customerEmail: string;
  customerPhone: string;
  customerName: string;
  title?: string;
  description: string;
  meta: Record<string, unknown>;
}): Promise<{ checkoutUrl: string }> {
  const secrets = await getDecryptedGatewaySecrets();
  if (!secrets.isEnabled || !secrets.secretKey) {
    throw new PaymentConfigError(
      'Flutterwave payment gateway is currently not enabled or configured by an administrator.'
    );
  }

  const response = await fetch('https://api.flutterwave.com/v3/payments', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${secrets.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tx_ref: params.txRef,
      amount: roundCurrency(params.amountNgn),
      currency: 'NGN',
      redirect_url: params.redirectUrl,
      customer: {
        email: params.customerEmail || 'customer@saqo.ng',
        phonenumber: params.customerPhone || '',
        name: params.customerName || 'SAQO Customer',
      },
      customizations: {
        title: params.title || 'SAQO Logistics',
        description: params.description,
      },
      meta: params.meta,
    }),
  });

  const payload = (await response.json().catch(() => null)) as any;
  if (!response.ok || payload?.status !== 'success' || !payload?.data?.link) {
    throw new PaymentVerificationError(
      payload?.message || 'Unable to initialize Flutterwave checkout. Please check gateway configuration.'
    );
  }

  return { checkoutUrl: String(payload.data.link) };
}

export interface FlutterwaveVerifiedData {
  flwTxId: string;
  txRef: string;
  amount: number;
  currency: string;
  status: string;
  paymentType: string;
  processorResponse: string;
  raw: Record<string, unknown>;
}

export async function verifyFlutterwaveWithApi(params: {
  transactionId?: string | null;
  txRef?: string | null;
}): Promise<FlutterwaveVerifiedData> {
  const secrets = await getDecryptedGatewaySecrets();
  if (!secrets.secretKey) {
    throw new PaymentConfigError('Flutterwave secret key is not configured.');
  }

  let endpoint = '';
  if (params.transactionId && /^\d+$/.test(String(params.transactionId).trim())) {
    endpoint = `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(
      String(params.transactionId).trim()
    )}/verify`;
  } else if (params.txRef) {
    endpoint = `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(
      params.txRef.trim()
    )}`;
  } else {
    throw new PaymentVerificationError('Transaction ID or transaction reference is required.');
  }

  const response = await fetch(endpoint, {
    method: 'GET',
    signal: AbortSignal.timeout(12000),
    headers: {
      Authorization: `Bearer ${secrets.secretKey}`,
      'Content-Type': 'application/json',
    },
  });

  const payload = (await response.json().catch(() => null)) as any;
  if (!response.ok || payload?.status !== 'success' || !payload?.data) {
    throw new PaymentVerificationError(
      payload?.message || 'Flutterwave verification failed for this transaction.'
    );
  }

  const d = payload.data;
  return {
    flwTxId: String(d.id ?? ''),
    txRef: String(d.tx_ref ?? ''),
    amount: Number(d.amount ?? 0),
    currency: String(d.currency ?? '').toUpperCase(),
    status: String(d.status ?? '').toLowerCase(),
    paymentType: String(d.payment_type ?? 'card'),
    processorResponse: String(d.processor_response ?? ''),
    raw: d,
  };
}

export async function refundFlutterwaveWithApi(
  flwTxId: string,
  amountNgn: number
): Promise<{ providerRefundId: string; completed: boolean }> {
  const secrets = await getDecryptedGatewaySecrets();
  if (!secrets.secretKey) {
    throw new PaymentConfigError('Flutterwave secret key is not configured.');
  }

  const response = await fetch(
    `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(flwTxId)}/refund`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${secrets.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount: roundCurrency(amountNgn) }),
    }
  );

  const payload = (await response.json().catch(() => null)) as any;
  if (!response.ok || payload?.status !== 'success') {
    const Failure = payload?.status === 'error' && response.status < 500
      ? GatewayRefundRejected : PaymentVerificationError;
    throw new Failure(
      payload?.message || 'Flutterwave refund request was declined.'
    );
  }

  return {
    providerRefundId: String(payload?.data?.id ?? ''),
    completed: isCompletedGatewayRefund(payload?.data?.status),
  };
}

function isCompletedGatewayRefund(status: unknown): boolean {
  return ['completed-bank-transfer', 'completed-momo', 'completed-mpgs', 'completed-offline', 'completed-preauth']
    .includes(String(status || '').toLowerCase());
}

export async function refreshFlutterwaveRefund(refundId: string): Promise<'pending' | 'completed' | 'failed'> {
  const refund = await db.prepare(`
    SELECT * FROM refunds WHERE id = ? AND destination = 'flutterwave'
  `).get(refundId) as any;
  if (!refund) throw new PaymentVerificationError('Flutterwave refund not found.');
  if (refund.status !== 'pending') return refund.status;
  if (!refund.provider_refund_id) {
    throw new PaymentVerificationError('Flutterwave did not return a refund ID. Check the gateway dashboard before retrying.');
  }
  const { secretKey } = await getDecryptedGatewaySecrets();
  if (!secretKey) throw new PaymentConfigError('Flutterwave secret key is not configured.');
  const response = await fetch(`https://api.flutterwave.com/v3/refunds/${encodeURIComponent(refund.provider_refund_id)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(12000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status !== 'success' ||
      String(payload.data?.id ?? '') !== refund.provider_refund_id) {
    throw new PaymentVerificationError('Unable to verify this Flutterwave refund.');
  }
  const providerStatus = String(payload.data.status).toLowerCase();
  const status = isCompletedGatewayRefund(providerStatus)
    ? 'completed'
    : providerStatus === 'failed' ? 'failed' : 'pending';
  if (status === 'pending') return status;

  const now = new Date().toISOString();
  let fullyRefunded = false;
  const changed = await withImmediateTransaction(async () => {
    const result = await db.prepare("UPDATE refunds SET status = ?, processed_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, now, refundId);
    if (result.changes && status === 'completed') {
      fullyRefunded = await applyCompletedRefund(refund.payment_transaction_id, now);
    }
    return result.changes;
  });
  if (changed) {
    await notifyUser(refund.user_id, status === 'completed' ? 'Refund Completed' : 'Refund Failed',
      `Flutterwave refund ${refund.reference} is ${status}.`, refund.delivery_id);
    const tx = await db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(refund.payment_transaction_id);
    if (tx) await broadcastWsEvent('payment:updated', mapPaymentTxRow(tx));
    if (refund.delivery_id) await broadcastWsEvent('delivery:updated', await getDeliveryById(refund.delivery_id));
    syncAsync(async (sb) => {
      await sb.from('refunds').update({ status, processed_at: now }).eq('id', refundId);
      if (fullyRefunded && tx) {
        const payment = mapPaymentTxRow(tx);
        await sb.from('payment_transactions').update({ status: 'refunded', updated_at: now })
          .eq('reference', payment.reference);
        if (payment.deliveryId) {
          await sb.from('delivery_requests').update({ payment_status: 'refunded', updated_at: now })
            .eq('id', payment.deliveryId).eq('payment_reference', payment.reference);
        }
      }
    });
  }
  return (await db.prepare('SELECT status FROM refunds WHERE id = ?').get(refundId) as { status: typeof status }).status;
}

async function insertPaymentTxRow(params: {
  id?: string;
  reference: string;
  idempotencyKey?: string | null;
  providerTxId?: string | null;
  providerTxRef?: string | null;
  userId: string;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  walletId?: string | null;
  deliveryId?: string | null;
  trackingCode?: string | null;
  purpose: PaymentPurpose;
  paymentMethod: PaymentMethodCode;
  provider: 'internal' | 'flutterwave' | 'cash' | 'bank_transfer';
  amountNgn: number;
  feeNgn?: number;
  status: DeliveryPaymentStatus;
  checkoutUrl?: string | null;
  transferReference?: string | null;
  transferProofNote?: string | null;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<PaymentTransaction> {
  const id = params.id || crypto.randomUUID();
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO payment_transactions (
      id, reference, idempotency_key, provider_tx_id, provider_tx_ref,
      user_id, customer_name, customer_email, customer_phone,
      wallet_id, delivery_id, tracking_code, purpose, payment_method, provider,
      amount_ngn, fee_ngn, currency, status, checkout_url,
      transfer_reference, transfer_proof_note, verified_at, verified_by,
      metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NGN', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.reference,
    params.idempotencyKey || null,
    params.providerTxId || null,
    params.providerTxRef || null,
    params.userId,
    params.customerName || null,
    params.customerEmail || null,
    params.customerPhone || null,
    params.walletId || null,
    params.deliveryId || null,
    params.trackingCode || null,
    params.purpose,
    params.paymentMethod,
    params.provider,
    roundCurrency(params.amountNgn),
    roundCurrency(params.feeNgn || 0),
    params.status,
    params.checkoutUrl || null,
    params.transferReference || null,
    params.transferProofNote || null,
    params.verifiedAt || null,
    params.verifiedBy || null,
    JSON.stringify(params.metadata || {}),
    now,
    now
  );

  const row = await db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(id);
  const mapped = mapPaymentTxRow(row);
  syncAsync((sb) =>
    Promise.resolve(
      sb.from('payment_transactions').upsert({
        id: mapped.id,
        reference: mapped.reference,
        idempotency_key: mapped.idempotencyKey,
        provider_tx_id: mapped.providerTxId,
        provider_tx_ref: mapped.providerTxRef,
        user_id: mapped.userId,
        customer_name: mapped.customerName,
        customer_email: mapped.customerEmail,
        customer_phone: mapped.customerPhone,
        wallet_id: mapped.walletId,
        delivery_id: mapped.deliveryId,
        tracking_code: mapped.trackingCode,
        purpose: mapped.purpose,
        payment_method: mapped.paymentMethod,
        provider: mapped.provider,
        amount_ngn: mapped.amountNgn,
        fee_ngn: mapped.feeNgn,
        currency: mapped.currency,
        status: mapped.status,
        checkout_url: mapped.checkoutUrl,
        transfer_reference: mapped.transferReference,
        transfer_proof_note: mapped.transferProofNote,
        verified_at: mapped.verifiedAt,
        verified_by: mapped.verifiedBy,
        metadata: mapped.metadata,
        created_at: mapped.createdAt,
        updated_at: mapped.updatedAt,
      })
    )
  );
  return mapped;
}

const checkoutRequests = new Map<string, Promise<PaymentTransaction>>();

export function reuseFlutterwaveCheckout(tx: PaymentTransaction): Promise<PaymentTransaction> {
  const inFlight = checkoutRequests.get(tx.id);
  if (inFlight) return inFlight;
  if ((tx.status === 'pending' && tx.checkoutUrl) || tx.status === 'paid') return Promise.resolve(tx);
  throw new PaymentVerificationError('This checkout has no usable link. Start a new payment attempt.');
}

function publishCheckout(
  tx: PaymentTransaction,
  request: Parameters<typeof initializeFlutterwaveCheckout>[0]
): Promise<PaymentTransaction> {
  const checkout = (async () => {
    let checkoutUrl: string;
    try {
      ({ checkoutUrl } = await initializeFlutterwaveCheckout(request));
    } catch (error) {
      const now = new Date().toISOString();
      const reason = error instanceof Error ? error.message : 'Gateway initialization error';
      await db.prepare(`
        UPDATE payment_transactions SET status = 'failed', failure_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'pending' AND checkout_url IS NULL
      `).run(reason, now, tx.id);
      void sendOpsAlert('payment_failure', { reason: 'flutterwave_checkout', reference: tx.reference });
      throw error;
    }
    const now = new Date().toISOString();
    await db.prepare(`
      UPDATE payment_transactions SET checkout_url = ?, updated_at = ? WHERE id = ? AND status = 'pending'
    `).run(checkoutUrl, now, tx.id);
    const updated = mapPaymentTxRow(await db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(tx.id));
    await broadcastWsEvent('payment:updated', updated);
    syncAsync(async (sb) => {
      await sb.from('payment_transactions')
        .update({ checkout_url: updated.checkoutUrl, updated_at: now }).eq('reference', tx.reference);
    });
    if (updated.status !== 'pending' && updated.status !== 'paid') {
      throw new PaymentVerificationError('This checkout is no longer available.');
    }
    return updated;
  })().finally(() => checkoutRequests.delete(tx.id));
  checkoutRequests.set(tx.id, checkout);
  return checkout;
}

export async function initializeWalletFunding(params: {
  userId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  amountNgn: number;
  idempotencyKey?: string | null;
  redirectUrl: string;
}): Promise<PaymentTransaction> {
  const amount = roundCurrency(params.amountNgn);
  if (!Number.isFinite(amount) || amount < 100) {
    throw new Error('Minimum wallet funding amount is ₦100.');
  }

  if (params.idempotencyKey) {
    const existing = await db
      .prepare('SELECT * FROM payment_transactions WHERE idempotency_key = ?')
      .get(params.idempotencyKey) as any;
    if (existing) {
      if (existing.user_id !== params.userId || existing.purpose !== 'wallet_funding' || existing.amount_ngn !== amount) {
        throw new PaymentVerificationError('This payment request key belongs to a different operation.');
      }
      return reuseFlutterwaveCheckout(mapPaymentTxRow(existing));
    }
  }

  const wallet = await ensureWallet(params.userId);
  const reference = generateReference('WLT');
  const tx = await insertPaymentTxRow({
    reference,
    idempotencyKey: params.idempotencyKey || null,
    userId: params.userId,
    customerName: params.customerName,
    customerEmail: params.customerEmail,
    customerPhone: params.customerPhone,
    walletId: wallet.id,
    purpose: 'wallet_funding',
    paymentMethod: 'flutterwave',
    provider: 'flutterwave',
    amountNgn: amount,
    status: 'pending',
    metadata: { source: 'customer_wallet_funding' },
  });

  return publishCheckout(tx, {
    txRef: reference,
    amountNgn: amount,
    redirectUrl: params.redirectUrl,
    customerEmail: params.customerEmail,
    customerPhone: params.customerPhone,
    customerName: params.customerName,
    description: `SAQO Wallet Funding (${reference})`,
    meta: {
      purpose: 'wallet_funding',
      userId: params.userId,
      walletId: wallet.id,
      paymentTransactionId: tx.id,
    },
  });
}

export async function initializeDeliveryFlutterwavePayment(params: {
  deliveryId: string;
  userId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  idempotencyKey?: string | null;
  redirectUrl: string;
}): Promise<PaymentTransaction> {
  const reservation = await withImmediateTransaction(async () => {
    const delivery = await getDeliveryById(params.deliveryId);
    if (!delivery) {
      throw new Error('Delivery not found.');
    }
    const customer = await db.prepare('SELECT id FROM customers WHERE profile_id = ?').get(params.userId) as { id: string } | undefined;
    if (!customer || delivery.customerId !== customer.id) {
      throw new PaymentVerificationError('You are not authorized to pay for this delivery.');
    }
    if (delivery.status === 'cancelled') {
      throw new Error('Cannot initialize payment for a cancelled delivery.');
    }
    if (delivery.paymentStatus === 'paid') {
      throw new Error('This delivery has already been paid.');
    }
    if (delivery.paymentStatus === 'collected_by_rider') {
      throw new Error('Cash for this delivery has already been collected by the rider.');
    }
  
    if (params.idempotencyKey) {
      const existing = await db
        .prepare('SELECT * FROM payment_transactions WHERE idempotency_key = ?')
        .get(params.idempotencyKey) as any;
      if (existing) {
        if (existing.user_id !== params.userId || existing.delivery_id !== delivery.id || existing.provider !== 'flutterwave') {
          throw new PaymentVerificationError('This payment request key belongs to a different operation.');
        }
        return { existing: mapPaymentTxRow(existing) } as const;
      }
    }
  
    const existingPending = await db
      .prepare(
        "SELECT * FROM payment_transactions WHERE delivery_id = ? AND payment_method = 'flutterwave' AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
      )
      .get(delivery.id) as any;
    if (existingPending) {
      if (existingPending.checkout_url || checkoutRequests.has(existingPending.id) ||
        Date.now() - Date.parse(existingPending.updated_at) < 30000) {
        return { existing: mapPaymentTxRow(existingPending) } as const;
      }
      await db.prepare(`
        UPDATE payment_transactions SET status = 'failed', failure_reason = 'Checkout initialization interrupted'
        WHERE id = ? AND status = 'pending' AND checkout_url IS NULL
      `).run(existingPending.id);
    }
  
    const wallet = await ensureWallet(params.userId);
    const reference = generateReference('PAY');
    const tx = await insertPaymentTxRow({
      reference,
      idempotencyKey: params.idempotencyKey || null,
      userId: params.userId,
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      customerPhone: params.customerPhone,
      walletId: wallet.id,
      deliveryId: delivery.id,
      trackingCode: delivery.trackingCode,
      purpose: 'delivery_payment',
      paymentMethod: 'flutterwave',
      provider: 'flutterwave',
      amountNgn: delivery.deliveryFeeNgn,
      status: 'pending',
      metadata: { trackingCode: delivery.trackingCode },
    });
  
    const methodUpdatedAt = new Date().toISOString();
    await db.prepare(
      "UPDATE delivery_requests SET payment_method = 'flutterwave', payment_status = 'pending', payment_reference = ?, updated_at = ? WHERE id = ?"
    ).run(reference, methodUpdatedAt, delivery.id);
    syncAsync((sb) =>
      Promise.resolve(
        sb
          .from('delivery_requests')
          .update({ payment_method: 'flutterwave', payment_status: 'pending', payment_reference: reference, updated_at: methodUpdatedAt })
          .eq('id', delivery.id)
      )
    );
  
    return { tx, delivery, reference } as const;
  });
  if (reservation.existing) return reuseFlutterwaveCheckout(reservation.existing);
  const { tx, delivery, reference } = reservation;

  return publishCheckout(tx, {
    txRef: reference,
    amountNgn: delivery.deliveryFeeNgn,
    redirectUrl: params.redirectUrl,
    customerEmail: params.customerEmail,
    customerPhone: params.customerPhone,
    customerName: params.customerName,
    description: `SAQO Delivery ${delivery.trackingCode}`,
    meta: {
      purpose: 'delivery_payment',
      userId: params.userId,
      deliveryId: delivery.id,
      trackingCode: delivery.trackingCode,
      paymentTransactionId: tx.id,
    },
  });
}

export async function createDeliveryPaymentRecords(params: {
  deliveryId: string;
  trackingCode: string;
  customerProfileId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  amountNgn: number;
  paymentMethod: PaymentMethodCode;
  idempotencyKey?: string | null;
  transferReference?: string | null;
  transferProofNote?: string | null;
}): Promise<{
  paymentStatus: DeliveryPaymentStatus;
  paymentReference: string;
  paymentTransaction: PaymentTransaction;
}> {
  const wallet = await ensureWallet(params.customerProfileId);
  const reference = generateReference('PAY');
  const now = new Date().toISOString();

  if (params.paymentMethod === 'wallet') {
    const paymentTxId = crypto.randomUUID();
    const debit = await debitWalletAtomic({
      userId: params.customerProfileId,
      amountNgn: params.amountNgn,
      reference: `WLT-${reference}`,
      idempotencyKey: params.idempotencyKey ? `wallet-debit:${params.idempotencyKey}` : `delivery:${params.deliveryId}`,
      category: 'delivery_payment',
      description: `Delivery payment for ${params.trackingCode}`,
      deliveryId: params.deliveryId,
      paymentTransactionId: paymentTxId,
      actorUserId: params.customerProfileId,
      actorRole: 'client',
      metadata: { trackingCode: params.trackingCode },
    });

    const tx = await insertPaymentTxRow({
      id: paymentTxId,
      reference,
      idempotencyKey: params.idempotencyKey || null,
      userId: params.customerProfileId,
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      customerPhone: params.customerPhone,
      walletId: debit.wallet.id,
      deliveryId: params.deliveryId,
      trackingCode: params.trackingCode,
      purpose: 'delivery_payment',
      paymentMethod: 'wallet',
      provider: 'internal',
      amountNgn: params.amountNgn,
      status: 'paid',
      verifiedAt: now,
      verifiedBy: params.customerProfileId,
      metadata: { walletTransactionId: debit.transaction.id },
    });

    return { paymentStatus: 'paid', paymentReference: reference, paymentTransaction: tx };
  }

  if (params.paymentMethod === 'cash' || params.paymentMethod === 'bank_transfer') {
    const initialStatus: DeliveryPaymentStatus =
      params.paymentMethod === 'bank_transfer' ? 'pending_verification' : 'pending';

    const tx = await insertPaymentTxRow({
      reference,
      idempotencyKey: params.idempotencyKey || null,
      userId: params.customerProfileId,
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      customerPhone: params.customerPhone,
      walletId: wallet.id,
      deliveryId: params.deliveryId,
      trackingCode: params.trackingCode,
      purpose: 'delivery_payment',
      paymentMethod: params.paymentMethod,
      provider: params.paymentMethod,
      amountNgn: params.amountNgn,
      status: initialStatus,
      transferReference: params.transferReference?.trim() || null,
      transferProofNote: params.transferProofNote?.trim() || null,
    });

    const ccId = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO cash_collections (
        id, delivery_id, tracking_code, payment_transaction_id,
        customer_id, payment_method, expected_amount_ngn, collected_amount_ngn,
        status, transfer_reference, transfer_proof_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      ccId,
      params.deliveryId,
      params.trackingCode,
      tx.id,
      params.customerProfileId,
      params.paymentMethod,
      roundCurrency(params.amountNgn),
      initialStatus,
      params.transferReference?.trim() || null,
      params.transferProofNote?.trim() || null,
      now,
      now
    );

    syncAsync((sb) =>
      Promise.resolve(
        sb.from('cash_collections').upsert({
          id: ccId,
          delivery_id: params.deliveryId,
          tracking_code: params.trackingCode,
          payment_transaction_id: tx.id,
          customer_id: params.customerProfileId,
          payment_method: params.paymentMethod,
          expected_amount_ngn: roundCurrency(params.amountNgn),
          collected_amount_ngn: 0,
          status: initialStatus,
          transfer_reference: params.transferReference?.trim() || null,
          transfer_proof_note: params.transferProofNote?.trim() || null,
          created_at: now,
          updated_at: now,
        })
      )
    );

    const publish = async () => await broadcastWsEvent('cash_collection:updated', { deliveryId: params.deliveryId, status: initialStatus });
    if (!deferDatabaseEffect(() => void publish().catch(console.error))) await publish();
    return { paymentStatus: initialStatus, paymentReference: reference, paymentTransaction: tx };
  }

  // Flutterwave direct payment starts as pending until verified server-side
  const tx = await insertPaymentTxRow({
    reference,
    idempotencyKey: params.idempotencyKey || null,
    userId: params.customerProfileId,
    customerName: params.customerName,
    customerEmail: params.customerEmail,
    customerPhone: params.customerPhone,
    walletId: wallet.id,
    deliveryId: params.deliveryId,
    trackingCode: params.trackingCode,
    purpose: 'delivery_payment',
    paymentMethod: 'flutterwave',
    provider: 'flutterwave',
    amountNgn: params.amountNgn,
    status: 'pending',
  });

  return { paymentStatus: 'pending', paymentReference: reference, paymentTransaction: tx };
}

export async function settleVerifiedPaymentTransaction(params: {
  tx: PaymentTransaction;
  flw: FlutterwaveVerifiedData;
  verifiedBy: string;
}): Promise<{
  paymentTransaction: PaymentTransaction;
  wallet?: WalletAccount;
  walletTransaction?: WalletTransaction;
  alreadyProcessed: boolean;
}> {
  if (params.tx.provider !== 'flutterwave' || !params.flw.flwTxId || params.flw.txRef !== params.tx.reference) {
    throw new PaymentVerificationError('Transaction reference mismatch during verification.');
  }
  if (params.flw.currency !== 'NGN') {
    throw new PaymentVerificationError(`Unexpected currency ${params.flw.currency}. Expected NGN.`);
  }
  if (params.flw.status === 'successful' &&
      (!Number.isFinite(params.flw.amount) || roundCurrency(params.flw.amount) < roundCurrency(params.tx.amountNgn))) {
    throw new PaymentVerificationError(
      `Paid amount (₦${params.flw.amount}) is less than expected amount (₦${params.tx.amountNgn}).`
    );
  }

  const now = new Date().toISOString();

  if (params.flw.status !== 'successful') {
    const mappedStatus: DeliveryPaymentStatus =
      params.flw.status === 'pending'
        ? 'pending'
        : params.flw.status === 'reversed'
          ? 'reversed'
          : 'failed';

    await withImmediateTransaction(async () => {
      const current = await db.prepare('SELECT status FROM payment_transactions WHERE id = ?').get(params.tx.id) as any;
      if (current && !['paid', 'refunded', 'reversed'].includes(current.status)) {
        await db.prepare(`
          UPDATE payment_transactions
          SET status = ?, provider_tx_id = ?, provider_tx_ref = ?, failure_reason = ?, updated_at = ?
          WHERE id = ?
        `).run(
          mappedStatus,
          params.flw.flwTxId || null,
          params.flw.txRef || null,
          params.flw.processorResponse || `Flutterwave status: ${params.flw.status}`,
          now,
          params.tx.id
        );

        if (params.tx.deliveryId && mappedStatus !== 'pending') {
          await db.prepare(`
            UPDATE delivery_requests SET payment_status = ?, updated_at = ?
            WHERE id = ? AND payment_reference = ? AND payment_status NOT IN ('paid','refunded','collected_by_rider')
          `).run(mappedStatus, now, params.tx.deliveryId, params.tx.reference);
        }
      }
    });

    const updated = mapPaymentTxRow(
      await db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(params.tx.id)
    );
    if (updated.status === 'failed' || updated.status === 'reversed') {
      void sendOpsAlert('payment_failure', { reason: updated.status, reference: updated.reference });
    }
    await broadcastWsEvent('payment:updated', updated);
    if (params.tx.deliveryId) {
      const delivery = await getDeliveryById(params.tx.deliveryId);
      if (delivery) await broadcastWsEvent('delivery:updated', delivery);
    }
    syncAsync(async (sb) => {
      await sb
        .from('payment_transactions')
        .update({
          status: updated.status,
          provider_tx_id: updated.providerTxId || null,
          provider_tx_ref: updated.providerTxRef || null,
          failure_reason: updated.failureReason || null,
          updated_at: now,
        })
        .eq('reference', updated.reference);
      if (params.tx.deliveryId && updated.status === mappedStatus && mappedStatus !== 'pending') {
        await sb
          .from('delivery_requests')
          .update({ payment_status: mappedStatus, updated_at: now })
          .eq('id', params.tx.deliveryId).eq('payment_reference', params.tx.reference);
      }
    });
    return { paymentTransaction: updated, alreadyProcessed: false };
  }

  let walletResult: { wallet: WalletAccount; transaction: WalletTransaction } | undefined;
  let appliedToDelivery = false;
  const markedNow = await withImmediateTransaction(async () => {
    const current = await db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(params.tx.id) as any;
    if (!current || ['paid', 'refunded', 'reversed'].includes(current.status)) return false;

    const used = await db.prepare(`
      SELECT id FROM payment_transactions WHERE provider = 'flutterwave' AND provider_tx_id = ? AND id <> ?
    `).get(params.flw.flwTxId, params.tx.id);
    if (used) throw new PaymentVerificationError('Flutterwave transaction was already recorded.');

    await db.prepare(`
      UPDATE payment_transactions SET status = 'paid', provider_tx_id = ?, provider_tx_ref = ?,
        verified_at = ?, verified_by = ?, failure_reason = NULL, updated_at = ? WHERE id = ?
    `).run(params.flw.flwTxId, params.flw.txRef, now, params.verifiedBy, now, params.tx.id);

    if (params.tx.purpose === 'wallet_funding') {
      const credit = await creditWalletAtomic({
        userId: params.tx.userId,
        amountNgn: params.tx.amountNgn,
        reference: `WLT-${params.tx.reference}`,
        idempotencyKey: `flw-fund:${params.tx.reference}`,
        category: 'funding',
        description: `Wallet funded via Flutterwave (${params.flw.paymentType})`,
        paymentTransactionId: params.tx.id,
        actorUserId: params.verifiedBy,
        actorRole: 'system',
        metadata: {
          flwTxId: params.flw.flwTxId,
          paymentType: params.flw.paymentType,
          paymentReference: params.tx.reference,
        },
      });
      walletResult = { wallet: credit.wallet, transaction: credit.transaction };
    } else if (params.tx.deliveryId) {
      const result = await db.prepare(`
        UPDATE delivery_requests SET payment_status = 'paid', payment_method = 'flutterwave',
          payment_reference = ?, updated_at = ?
        WHERE id = ? AND status <> 'cancelled'
          AND payment_status NOT IN ('paid','refunded','collected_by_rider')
          AND payment_reference = ?
      `).run(params.tx.reference, now, params.tx.deliveryId, params.tx.reference);
      appliedToDelivery = result.changes === 1;
      if (appliedToDelivery) {
        await db.prepare("DELETE FROM cash_collections WHERE delivery_id = ? AND status IN ('pending','pending_verification','disputed')")
          .run(params.tx.deliveryId);
      }
    }
    return true;
  });

  if (!markedNow) {
    const existing = await db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(params.tx.id);
    return { paymentTransaction: mapPaymentTxRow(existing), alreadyProcessed: true };
  }

  if (params.tx.purpose === 'delivery_payment' && params.tx.deliveryId) {
    const delivery = await getDeliveryById(params.tx.deliveryId);
    if (delivery) {
      if (appliedToDelivery && delivery.status === 'delivered') {
        await db.prepare("UPDATE payments SET status = 'settled' WHERE delivery_id = ? AND status = 'pending'").run(
          delivery.id
        );
      }
      if (!appliedToDelivery) {
        await notifyUser(
          params.tx.userId,
          'Payment Needs Refund',
          `Your payment of ₦${params.tx.amountNgn.toLocaleString()} for delivery ${delivery.trackingCode} (${params.tx.reference}) was confirmed. Please contact support or wait for admin refund.`,
          delivery.id
        );
        const admins = await db.prepare("SELECT id FROM profiles WHERE role = 'admin'").all() as Array<{ id: string }>;
        for (const adm of admins) {
          await notifyUser(
            adm.id,
            'Flutterwave Payment Needs Refund',
            `Flutterwave payment ${params.tx.reference} (₦${params.tx.amountNgn.toLocaleString()}) could not be applied to ${delivery.trackingCode}.`,
            delivery.id
          );
        }
      } else {
        await notifyUser(
          params.tx.userId,
          'Delivery Payment Confirmed',
          `Payment of ₦${params.tx.amountNgn.toLocaleString()} for ${delivery.trackingCode} was confirmed (${params.tx.reference}).`,
          delivery.id
        );
      }
      await broadcastWsEvent('delivery:updated', delivery);
      if (appliedToDelivery) await dispatchWaitingDeliveries();
    }
    if (appliedToDelivery) syncAsync(async (sb) => {
      await sb
        .from('delivery_requests')
        .update({
          payment_status: 'paid',
          payment_method: 'flutterwave',
          payment_reference: params.tx.reference,
          updated_at: now,
        })
        .eq('id', params.tx.deliveryId);
      await sb
        .from('cash_collections')
        .delete()
        .eq('delivery_id', params.tx.deliveryId)
        .in('status', ['pending', 'pending_verification', 'disputed']);
    });
  }

  const updatedTx = mapPaymentTxRow(
    await db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(params.tx.id)
  );
  await broadcastWsEvent('payment:updated', updatedTx);

  syncAsync((sb) =>
    Promise.resolve(
      sb
        .from('payment_transactions')
        .update({
          status: 'paid',
          provider_tx_id: params.flw.flwTxId || null,
          provider_tx_ref: params.flw.txRef || null,
          verified_at: now,
          verified_by: params.verifiedBy,
          updated_at: now,
        })
        .eq('reference', updatedTx.reference)
    )
  );

  return {
    paymentTransaction: updatedTx,
    wallet: walletResult?.wallet,
    walletTransaction: walletResult?.transaction,
    alreadyProcessed: false,
  };
}

export async function confirmFlutterwaveTransaction(params: {
  transactionId?: string | null;
  txRef?: string | null;
  verifiedByUserId?: string;
  source: 'callback' | 'webhook' | 'admin_verify';
}) {
  let row: any = null;
  if (params.txRef) {
    row = await db.prepare('SELECT * FROM payment_transactions WHERE reference = ?').get(params.txRef.trim());
  }
  if (!row && params.transactionId) {
    row = await db
      .prepare('SELECT * FROM payment_transactions WHERE provider_tx_id = ?')
      .get(String(params.transactionId).trim());
  }

  if (!row) {
    throw new PaymentVerificationError('Payment transaction record not found.');
  }

  const tx = mapPaymentTxRow(row);
  if (tx.provider !== 'flutterwave' || (params.txRef && params.txRef.trim() !== tx.reference)) {
    throw new PaymentVerificationError('Flutterwave payment reference does not match.');
  }
  if (params.source === 'callback' && params.verifiedByUserId !== tx.userId) {
    const actor = params.verifiedByUserId && await getProfileById(params.verifiedByUserId);
    if (!actor || actor.role !== 'admin') {
      throw new PaymentVerificationError('You cannot verify another user transaction.');
    }
  }
  if (['paid', 'refunded', 'reversed'].includes(tx.status)) {
    const wallet = await ensureWallet(tx.userId);
    return { paymentTransaction: tx, wallet, alreadyProcessed: true };
  }

  const flw = await verifyFlutterwaveWithApi({
    transactionId: params.transactionId || tx.providerTxId,
    txRef: tx.reference,
  });
  if (params.transactionId && /^\d+$/.test(params.transactionId) && flw.flwTxId !== params.transactionId) {
    throw new PaymentVerificationError('Flutterwave transaction ID does not match.');
  }

  return await settleVerifiedPaymentTransaction({
    tx,
    flw,
    verifiedBy: params.verifiedByUserId || params.source,
  });
}

export async function verifyFlutterwaveWebhookSignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string
): Promise<boolean> {
  const secrets = await getDecryptedGatewaySecrets();
  const configuredHash = secrets.webhookSecretHash;
  if (!configuredHash) return false;

  const verifHashRaw = headers['verif-hash'] ?? headers['Verif-Hash'];
  const verifHash = Array.isArray(verifHashRaw) ? verifHashRaw[0] : verifHashRaw;
  if (verifHash) {
    const a = Buffer.from(verifHash.trim(), 'utf8');
    const b = Buffer.from(configuredHash.trim(), 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }

  const hmacRaw = headers['flutterwave-signature'];
  const hmacHeader = Array.isArray(hmacRaw) ? hmacRaw[0] : hmacRaw;
  if (hmacHeader && rawBody) {
    const digest = crypto
      .createHmac('sha256', configuredHash.trim())
      .update(rawBody)
      .digest('base64');
    const a = Buffer.from(hmacHeader.trim(), 'utf8');
    const b = Buffer.from(digest, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }

  return false;
}

export async function processFlutterwaveWebhook(params: {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  payload: any;
}): Promise<{ accepted: boolean; duplicate?: boolean; status: string; message?: string }> {
  const validSig = await verifyFlutterwaveWebhookSignature(params.headers, params.rawBody);
  const eventType = String(params.payload?.event || 'unknown');
  const data = params.payload?.data || {};
  const txRef = data?.tx_ref ? String(data.tx_ref) : null;
  const flwTxId = data?.id ? String(data.id) : null;
  const dataStatus = String(data?.status || '');
  const idempotencyKey = `flw:${eventType}:${flwTxId || 'none'}:${txRef || 'none'}:${dataStatus || 'none'}`;
  const now = new Date().toISOString();

  if (!validSig) {
    const failedEventId = crypto.randomUUID();
    await db.prepare(`
      INSERT OR IGNORE INTO payment_webhook_events (
        id, provider, event_type, event_id, tx_ref, flw_tx_id,
        idempotency_key, signature_valid, status, processing_error,
        payload, received_at, processed_at
      ) VALUES (?, 'flutterwave', ?, ?, ?, ?, ?, 0, 'failed', 'Invalid webhook signature', ?, ?, ?)
    `).run(
      failedEventId,
      eventType,
      flwTxId,
      txRef,
      flwTxId,
      `${idempotencyKey}:invalidsig:${Date.now()}`,
      JSON.stringify(params.payload || {}),
      now,
      now
    );
    return { accepted: false, status: 'failed', message: 'Invalid webhook signature.' };
  }

  const existing = await db
    .prepare('SELECT id, status FROM payment_webhook_events WHERE idempotency_key = ?')
    .get(idempotencyKey) as any;
  if (existing && (existing.status === 'processed' || existing.status === 'ignored')) {
    return { accepted: true, duplicate: true, status: 'ignored', message: 'Duplicate webhook ignored.' };
  }

  const webhookRowId = existing?.id || crypto.randomUUID();
  if (!existing) {
    await db.prepare(`
      INSERT INTO payment_webhook_events (
        id, provider, event_type, event_id, tx_ref, flw_tx_id,
        idempotency_key, signature_valid, status, payload, received_at
      ) VALUES (?, 'flutterwave', ?, ?, ?, ?, ?, 1, 'received', ?, ?)
    `).run(
      webhookRowId,
      eventType,
      flwTxId,
      txRef,
      flwTxId,
      idempotencyKey,
      JSON.stringify(params.payload || {}),
      now
    );
  }

  try {
    if ((eventType === 'charge.completed' || eventType === 'charge.failed') && (txRef || flwTxId)) {
      await confirmFlutterwaveTransaction({
        transactionId: flwTxId,
        txRef,
        source: 'webhook',
      });
    } else if (eventType === 'charge.reversed' && (txRef || flwTxId)) {
      const txRow = await db.prepare(`
        SELECT * FROM payment_transactions WHERE provider = 'flutterwave'
          AND ((? IS NOT NULL AND reference = ?) OR (? IS NULL AND provider_tx_id = ?))
      `).get(txRef, txRef, txRef, flwTxId) as any;
      if (txRow?.provider_tx_id && flwTxId && txRow.provider_tx_id !== flwTxId) {
        throw new PaymentVerificationError('Flutterwave reversal reference does not match.');
      }
      if (txRow && txRow.status !== 'reversed') {
        const wasPaid = txRow.status === 'paid';
        let walletFrozenOnReversal = false;
        let walletDebitedOnReversal = false;
        const reversalNote = 'Payment reversed / chargeback reported by Flutterwave';

        await withImmediateTransaction(async () => {
          await db.prepare(
            "UPDATE payment_transactions SET status = 'reversed', failure_reason = COALESCE(failure_reason, ?), updated_at = ? WHERE id = ?"
          ).run(reversalNote, now, txRow.id);

          if (txRow.delivery_id) {
            await db.prepare("UPDATE delivery_requests SET payment_status = 'reversed', updated_at = ? WHERE id = ? AND payment_reference = ?").run(
              now,
              txRow.delivery_id,
              txRow.reference
            );
          }

          if (txRow.purpose === 'wallet_funding' && wasPaid) {
            const wallet = await ensureWallet(txRow.user_id);
            const revAmount = roundCurrency(txRow.amount_ngn);
            const existingRev = await db
              .prepare('SELECT id FROM wallet_transactions WHERE idempotency_key = ?')
              .get(`flw-rev:${txRow.reference}`) as { id: string } | undefined;

            if (!existingRev && revAmount > 0) {
              const before = roundCurrency(wallet.balanceNgn);
              if (before >= revAmount) {
                const after = roundCurrency(before - revAmount);
                const revWtId = crypto.randomUUID();
                await db.prepare('UPDATE wallets SET balance_ngn = ?, updated_at = ? WHERE id = ?').run(
                  after,
                  now,
                  wallet.id
                );
                await db.prepare(`
                  INSERT INTO wallet_transactions (
                    id, wallet_id, user_id, type, category, amount_ngn,
                    balance_before_ngn, balance_after_ngn, currency,
                    reference, idempotency_key, payment_transaction_id,
                    status, description, actor_user_id, actor_role, metadata, created_at
                  ) VALUES (?, ?, ?, 'debit', 'reversal', ?, ?, ?, 'NGN', ?, ?, ?, 'completed', ?, 'system', 'system', ?, ?)
                `).run(
                  revWtId,
                  wallet.id,
                  txRow.user_id,
                  revAmount,
                  before,
                  after,
                  `REV-${txRow.reference}`,
                  `flw-rev:${txRow.reference}`,
                  txRow.id,
                  `Flutterwave chargeback / reversal (${txRow.reference})`,
                  JSON.stringify({ flwTxId, txRef: txRow.reference }),
                  now
                );
                walletDebitedOnReversal = true;
              } else {
                await db.prepare("UPDATE wallets SET status = 'frozen', updated_at = ? WHERE id = ?").run(
                  now,
                  wallet.id
                );
                walletFrozenOnReversal = true;
              }
            }
          }
        });

        const updatedTx = mapPaymentTxRow(
          await db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(txRow.id)
        );
        await broadcastWsEvent('payment:updated', updatedTx);
        if (txRow.delivery_id) {
          const updatedDelivery = await getDeliveryById(txRow.delivery_id);
          if (updatedDelivery) await broadcastWsEvent('delivery:updated', updatedDelivery);
        }

        if (walletDebitedOnReversal || walletFrozenOnReversal) {
          const refreshedWallet = await ensureWallet(txRow.user_id);
          await broadcastWsEvent('wallet:updated', { userId: txRow.user_id, wallet: refreshedWallet });
          if (walletDebitedOnReversal) {
            await notifyUser(
              txRow.user_id,
              'Wallet Funding Reversed',
              `₦${roundCurrency(txRow.amount_ngn).toLocaleString()} from transaction ${txRow.reference} was reversed due to a chargeback. Updated balance: ₦${refreshedWallet.balanceNgn.toLocaleString()}.`
            );
            syncAsync((sb) =>
              Promise.resolve(
                sb.rpc('saqo_debit_wallet', {
                  p_user_id: txRow.user_id,
                  p_amount_ngn: roundCurrency(txRow.amount_ngn),
                  p_reference: `REV-${txRow.reference}`,
                  p_idempotency_key: `flw-rev:${txRow.reference}`,
                  p_category: 'reversal',
                  p_description: `Flutterwave chargeback / reversal (${txRow.reference})`,
                  p_delivery_id: null,
                  p_payment_transaction_id: txRow.id,
                  p_actor_user_id: 'system',
                  p_actor_role: 'system',
                  p_metadata: { flwTxId, txRef: txRow.reference },
                })
              )
            );
          } else {
            await notifyUser(
              txRow.user_id,
              'Wallet Frozen Due to Chargeback',
              `A funding payment (${txRow.reference}) of ₦${roundCurrency(txRow.amount_ngn).toLocaleString()} was reversed, and your wallet has been temporarily frozen pending support review.`
            );
            const admins = await db.prepare("SELECT id FROM profiles WHERE role = 'admin'").all() as Array<{ id: string }>;
            for (const adm of admins) {
              await notifyUser(
                adm.id,
                'Chargeback Alert: Wallet Frozen',
                `Transaction ${txRow.reference} (₦${roundCurrency(txRow.amount_ngn).toLocaleString()}) reversed with insufficient balance; wallet ${refreshedWallet.id} frozen.`
              );
            }
            syncAsync((sb) =>
              Promise.resolve(
                sb.from('wallets').update({ status: 'frozen', updated_at: now }).eq('user_id', txRow.user_id)
              )
            );
          }
        } else if (txRow.delivery_id) {
          await notifyUser(
            txRow.user_id,
            'Delivery Payment Reversed',
            `Payment ${txRow.reference} for ${txRow.tracking_code || 'your delivery'} was reversed by the payment provider.`,
            txRow.delivery_id
          );
        }

        syncAsync(async (sb) => {
          await sb
            .from('payment_transactions')
            .update({
              status: 'reversed',
              failure_reason: updatedTx.failureReason || reversalNote,
              updated_at: now,
            })
            .eq('reference', updatedTx.reference);
          if (txRow.delivery_id) {
            await sb
              .from('delivery_requests')
              .update({ payment_status: 'reversed', updated_at: now })
              .eq('id', txRow.delivery_id);
          }
        });
      }
    }

    const doneAt = new Date().toISOString();
    await db.prepare("UPDATE payment_webhook_events SET status = 'processed', processing_error = NULL, processed_at = ? WHERE id = ?").run(
      doneAt,
      webhookRowId
    );
    syncAsync((sb) =>
      Promise.resolve(
        sb.from('payment_webhook_events').upsert({
          id: webhookRowId,
          provider: 'flutterwave',
          event_type: eventType,
          event_id: flwTxId,
          tx_ref: txRef,
          flw_tx_id: flwTxId,
          idempotency_key: idempotencyKey,
          signature_valid: true,
          status: 'processed',
          payload: params.payload || {},
          received_at: now,
          processed_at: doneAt,
        })
      )
    );

    return { accepted: true, status: 'processed' };
  } catch (err: any) {
    const doneAt = new Date().toISOString();
    await db.prepare(
      "UPDATE payment_webhook_events SET status = 'failed', processing_error = ?, processed_at = ? WHERE id = ? AND status <> 'processed'"
    ).run(err?.message || 'Webhook processing error', doneAt, webhookRowId);
    return { accepted: true, status: 'failed', message: err?.message };
  }
}

export async function confirmRiderCashCollection(params: {
  deliveryId: string;
  riderId: string;
  collectedAmountNgn?: number;
  notes?: string;
}) {
  const delivery = await getDeliveryById(params.deliveryId);
  if (!delivery) {
    throw new Error('Delivery not found.');
  }
  if (delivery.assignedRiderId !== params.riderId) {
    throw new Error('Only the assigned rider can confirm cash collection.');
  }
  if (delivery.paymentMethod !== 'cash') {
    throw new Error('Only Cash on Delivery orders can be marked collected by rider.');
  }
  if (delivery.status === 'cancelled') {
    throw new Error('Cannot collect cash for a cancelled delivery.');
  }
  if (delivery.paymentStatus === 'paid' || delivery.paymentStatus === 'refunded') {
    throw new Error(`Delivery payment is already marked as ${delivery.paymentStatus}.`);
  }
  if (delivery.paymentStatus === 'collected_by_rider') {
    throw new Error('Cash collection has already been confirmed for this delivery.');
  }

  const now = new Date().toISOString();
  const amount = roundCurrency(params.collectedAmountNgn ?? delivery.deliveryFeeNgn);
  const cleanNote = params.notes?.trim() || '';

  await withImmediateTransaction(async () => {
    const cc = await db.prepare('SELECT * FROM cash_collections WHERE delivery_id = ?').get(delivery.id) as any;
    if (cc) {
      await db.prepare(`
        UPDATE cash_collections
        SET rider_id = ?,
            collected_amount_ngn = ?,
            status = 'collected_by_rider',
            rider_confirmed_at = ?,
            notes = CASE WHEN ? <> '' THEN ? ELSE notes END,
            updated_at = ?
        WHERE id = ?
      `).run(
        params.riderId,
        amount,
        now,
        cleanNote,
        cleanNote,
        now,
        cc.id
      );
    }

    await db.prepare(
      "UPDATE delivery_requests SET payment_status = 'collected_by_rider', updated_at = ? WHERE id = ?"
    ).run(now, delivery.id);

    await db.prepare(
      "UPDATE payment_transactions SET status = 'collected_by_rider', updated_at = ? WHERE delivery_id = ? AND payment_method = 'cash'"
    ).run(now, delivery.id);
  });

  const updatedDelivery = (await getDeliveryById(delivery.id))!;
  const customerRow = await db
    .prepare('SELECT profile_id FROM customers WHERE id = ?')
    .get(delivery.customerId) as { profile_id: string } | undefined;
  if (customerRow) {
    await notifyUser(
      customerRow.profile_id,
      'Cash Payment Collected',
      `Rider confirmed cash collection of ₦${amount.toLocaleString()} for ${delivery.trackingCode}.`,
      delivery.id
    );
  }
  await broadcastWsEvent('delivery:updated', updatedDelivery);
  await broadcastWsEvent('cash_collection:updated', {
    deliveryId: delivery.id,
    status: 'collected_by_rider',
  });
  syncAsync(async (sb) => {
    const ccUpdate: Record<string, unknown> = {
      rider_id: params.riderId,
      collected_amount_ngn: amount,
      status: 'collected_by_rider',
      rider_confirmed_at: now,
      updated_at: now,
    };
    if (cleanNote) ccUpdate.notes = cleanNote;
    await sb.from('cash_collections').update(ccUpdate).eq('delivery_id', delivery.id);
    await sb
      .from('delivery_requests')
      .update({ payment_status: 'collected_by_rider', updated_at: now })
      .eq('id', delivery.id);
    await sb
      .from('payment_transactions')
      .update({ status: 'collected_by_rider', updated_at: now })
      .eq('delivery_id', delivery.id)
      .eq('payment_method', 'cash');
  });
  return updatedDelivery;
}

async function requireNoPendingFlutterwaveCheckout(deliveryId: string): Promise<void> {
  const pending = await db.prepare(`
    SELECT 1 FROM payment_transactions
    WHERE delivery_id = ? AND provider = 'flutterwave' AND status = 'pending'
  `).get(deliveryId);
  if (pending) {
    throw new PaymentVerificationError('A Flutterwave checkout is pending. Verify its status before switching payment methods.');
  }
}

export async function submitBankTransferProof(params: {
  deliveryId: string;
  userId: string;
  transferReference: string;
  transferProofNote?: string;
}) {
  const delivery = await getDeliveryById(params.deliveryId);
  if (!delivery) throw new Error('Delivery not found.');
  const customerRow = await db
    .prepare('SELECT id FROM customers WHERE profile_id = ?')
    .get(params.userId) as { id: string } | undefined;
  if (!customerRow || delivery.customerId !== customerRow.id) {
    throw new Error('You are not authorized for this delivery.');
  }
  if (delivery.status === 'cancelled') {
    throw new Error('Cannot submit bank transfer proof for a cancelled delivery.');
  }
  await requireNoPendingFlutterwaveCheckout(delivery.id);
  if (delivery.paymentStatus === 'paid') {
    throw new Error('This delivery has already been paid.');
  }
  if (delivery.paymentStatus === 'collected_by_rider') {
    throw new Error('Cash for this delivery has already been collected by the rider.');
  }

  const ref = params.transferReference.trim();
  if (!ref) throw new Error('Bank transfer reference is required.');
  const proofNote = params.transferProofNote?.trim() || null;
  const now = new Date().toISOString();
  let syncedTxId = '';
  let syncedCcId = '';

  await withImmediateTransaction(async () => {
    await db.prepare(
      "UPDATE delivery_requests SET payment_method = 'bank_transfer', payment_status = 'pending_verification', payment_reference = ?, updated_at = ? WHERE id = ?"
    ).run(ref, now, delivery.id);

    const existingTx = await db
      .prepare("SELECT * FROM payment_transactions WHERE delivery_id = ? AND purpose = 'delivery_payment' ORDER BY created_at DESC LIMIT 1")
      .get(delivery.id) as any;

    let txId = existingTx?.id;
    if (existingTx) {
      await db.prepare(`
        UPDATE payment_transactions
        SET payment_method = 'bank_transfer',
            provider = 'bank_transfer',
            status = 'pending_verification',
            transfer_reference = ?,
            transfer_proof_note = ?,
            updated_at = ?
        WHERE id = ?
      `).run(ref, proofNote, now, existingTx.id);
    } else {
      const tx = await insertPaymentTxRow({
        reference: generateReference('BNK'),
        userId: params.userId,
        customerName: delivery.customerName,
        customerPhone: delivery.customerPhone,
        deliveryId: delivery.id,
        trackingCode: delivery.trackingCode,
        purpose: 'delivery_payment',
        paymentMethod: 'bank_transfer',
        provider: 'bank_transfer',
        amountNgn: delivery.deliveryFeeNgn,
        status: 'pending_verification',
        transferReference: ref,
        transferProofNote: proofNote,
      });
      txId = tx.id;
    }
    syncedTxId = txId;

    const existingCc = await db
      .prepare('SELECT id FROM cash_collections WHERE delivery_id = ?')
      .get(delivery.id) as any;
    if (existingCc) {
      syncedCcId = existingCc.id;
      await db.prepare(`
        UPDATE cash_collections
        SET payment_method = 'bank_transfer',
            status = 'pending_verification',
            transfer_reference = ?,
            transfer_proof_note = ?,
            updated_at = ?
        WHERE id = ?
      `).run(ref, proofNote, now, existingCc.id);
    } else {
      syncedCcId = crypto.randomUUID();
      await db.prepare(`
        INSERT INTO cash_collections (
          id, delivery_id, tracking_code, payment_transaction_id, customer_id,
          payment_method, expected_amount_ngn, collected_amount_ngn,
          status, transfer_reference, transfer_proof_note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'bank_transfer', ?, 0, 'pending_verification', ?, ?, ?, ?)
      `).run(
        syncedCcId,
        delivery.id,
        delivery.trackingCode,
        txId,
        params.userId,
        delivery.deliveryFeeNgn,
        ref,
        proofNote,
        now,
        now
      );
    }
  });

  const updated = (await getDeliveryById(delivery.id))!;
  const refreshedTx = await db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(syncedTxId);
  if (refreshedTx) {
    await broadcastWsEvent('payment:updated', mapPaymentTxRow(refreshedTx));
  }
  await broadcastWsEvent('delivery:updated', updated);
  await broadcastWsEvent('cash_collection:updated', {
    deliveryId: delivery.id,
    status: 'pending_verification',
  });
  syncAsync(async (sb) => {
    await sb
      .from('delivery_requests')
      .update({
        payment_method: 'bank_transfer',
        payment_status: 'pending_verification',
        payment_reference: ref,
        updated_at: now,
      })
      .eq('id', delivery.id);
    if (syncedTxId) {
      await sb
        .from('payment_transactions')
        .update({
          payment_method: 'bank_transfer',
          provider: 'bank_transfer',
          status: 'pending_verification',
          transfer_reference: ref,
          transfer_proof_note: proofNote,
          updated_at: now,
        })
        .eq('id', syncedTxId);
    }
    if (syncedCcId) {
      await sb.from('cash_collections').upsert({
        id: syncedCcId,
        delivery_id: delivery.id,
        tracking_code: delivery.trackingCode,
        payment_transaction_id: syncedTxId,
        customer_id: params.userId,
        payment_method: 'bank_transfer',
        expected_amount_ngn: delivery.deliveryFeeNgn,
        collected_amount_ngn: 0,
        status: 'pending_verification',
        transfer_reference: ref,
        transfer_proof_note: proofNote,
        updated_at: now,
      });
    }
  });
  return updated;
}

export async function reconcileCashOrBankCollection(params: {
  collectionId: string;
  action: 'reconcile' | 'dispute';
  adminId: string;
  collectedAmountNgn?: number;
  notes?: string;
}): Promise<CashCollectionRecord> {
  const row = await db.prepare('SELECT * FROM cash_collections WHERE id = ?').get(params.collectionId) as any;
  if (!row) throw new Error('Collection record not found.');
  if (row.status === 'reconciled' && params.action === 'reconcile') {
    throw new Error('Collection record is already reconciled.');
  }

  const now = new Date().toISOString();
  const nextStatus = params.action === 'reconcile' ? 'reconciled' : 'disputed';
  const nextDeliveryPaymentStatus: DeliveryPaymentStatus =
    params.action === 'reconcile' ? 'paid' : 'failed';
  const collected =
    params.action === 'reconcile'
      ? roundCurrency(params.collectedAmountNgn ?? row.expected_amount_ngn)
      : roundCurrency(row.collected_amount_ngn);
  const cleanNotes = params.notes?.trim() || '';

  await withImmediateTransaction(async () => {
    await db.prepare(`
      UPDATE cash_collections
      SET status = ?,
          collected_amount_ngn = ?,
          reconciled_by = ?,
          reconciled_at = ?,
          notes = CASE WHEN ? <> '' THEN ? ELSE notes END,
          updated_at = ?
      WHERE id = ?
    `).run(
      nextStatus,
      collected,
      params.adminId,
      now,
      cleanNotes,
      cleanNotes,
      now,
      row.id
    );

    await db.prepare('UPDATE delivery_requests SET payment_status = ?, updated_at = ? WHERE id = ?').run(
      nextDeliveryPaymentStatus,
      now,
      row.delivery_id
    );

    if (row.payment_transaction_id) {
      await db.prepare(
        'UPDATE payment_transactions SET status = ?, verified_by = ?, verified_at = ?, updated_at = ? WHERE id = ?'
      ).run(nextDeliveryPaymentStatus, params.adminId, now, now, row.payment_transaction_id);
    }

    if (params.action === 'reconcile') {
      const delivery = await getDeliveryById(row.delivery_id);
      if (delivery?.status === 'delivered') {
        await db.prepare("UPDATE payments SET status = 'settled' WHERE delivery_id = ? AND status = 'pending'").run(
          row.delivery_id
        );
      }
    }
  });

  const updatedDelivery = await getDeliveryById(row.delivery_id);
  if (updatedDelivery) {
    await broadcastWsEvent('delivery:updated', updatedDelivery);
  }
  if (row.payment_transaction_id) {
    const updatedTx = await db
      .prepare('SELECT * FROM payment_transactions WHERE id = ?')
      .get(row.payment_transaction_id);
    if (updatedTx) await broadcastWsEvent('payment:updated', mapPaymentTxRow(updatedTx));
  }
  await notifyUser(
    row.customer_id,
    params.action === 'reconcile' ? 'Payment Verified & Reconciled' : 'Payment Verification Issue',
    params.action === 'reconcile'
      ? `Your ${row.payment_method === 'bank_transfer' ? 'bank transfer' : 'cash payment'} of ₦${collected.toLocaleString()} for ${row.tracking_code} has been reconciled.`
      : `There is a verification dispute on your payment for ${row.tracking_code}. ${cleanNotes}`,
    row.delivery_id
  );
  await broadcastWsEvent('cash_collection:updated', { id: row.id, status: nextStatus });

  syncAsync(async (sb) => {
    const ccUpdate: Record<string, unknown> = {
      status: nextStatus,
      collected_amount_ngn: collected,
      reconciled_by: params.adminId,
      reconciled_at: now,
      updated_at: now,
    };
    if (cleanNotes) ccUpdate.notes = cleanNotes;
    await sb.from('cash_collections').update(ccUpdate).eq('id', row.id);
    await sb
      .from('delivery_requests')
      .update({ payment_status: nextDeliveryPaymentStatus, updated_at: now })
      .eq('id', row.delivery_id);
    if (row.payment_transaction_id) {
      await sb
        .from('payment_transactions')
        .update({
          status: nextDeliveryPaymentStatus,
          verified_by: params.adminId,
          verified_at: now,
          updated_at: now,
        })
        .eq('id', row.payment_transaction_id);
    }
  });

  const refreshed = await db.prepare(`
    SELECT cc.*, cp.full_name as customer_name, cp.phone as customer_phone, rp.full_name as rider_name
    FROM cash_collections cc
    LEFT JOIN profiles cp ON cp.id = cc.customer_id
    LEFT JOIN riders r ON r.id = cc.rider_id
    LEFT JOIN profiles rp ON rp.id = r.profile_id
    WHERE cc.id = ?
  `).get(row.id);

  return mapCashCollectionRow(refreshed);
}

async function applyCompletedRefund(paymentId: string, now: string): Promise<boolean> {
  const payment = await db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(paymentId) as any;
  const completed = await db.prepare(`
    SELECT COALESCE(SUM(amount_ngn), 0) AS total FROM refunds
    WHERE payment_transaction_id = ? AND status = 'completed'
  `).get(paymentId) as { total: number };
  if (!payment || roundCurrency(completed.total) < roundCurrency(payment.amount_ngn)) return false;

  await db.prepare("UPDATE payment_transactions SET status = 'refunded', updated_at = ? WHERE id = ?")
    .run(now, paymentId);
  if (payment.delivery_id && (await getDeliveryById(payment.delivery_id))?.paymentReference === payment.reference) {
    await db.prepare("UPDATE delivery_requests SET payment_status = 'refunded', updated_at = ? WHERE id = ?")
      .run(now, payment.delivery_id);
    await db.prepare("UPDATE payments SET status = 'refunded' WHERE delivery_id = ?").run(payment.delivery_id);
  }
  return true;
}

export async function processAdminRefund(params: {
  paymentTransactionId?: string;
  deliveryId?: string;
  amountNgn: number;
  destination: 'wallet' | 'flutterwave' | 'manual';
  reason: string;
  adminId: string;
}): Promise<RefundRecord> {
  const cleanReason = (params.reason || '').trim();
  if (cleanReason.length < 3) {
    throw new Error('A refund reason (at least 3 characters) is mandatory.');
  }

  let txRow: any = null;
  if (params.paymentTransactionId) {
    txRow = await db
      .prepare('SELECT * FROM payment_transactions WHERE id = ?')
      .get(params.paymentTransactionId);
  } else if (params.deliveryId) {
    txRow = await db
      .prepare("SELECT * FROM payment_transactions WHERE delivery_id = ? AND status IN ('paid','collected_by_rider') ORDER BY created_at DESC LIMIT 1")
      .get(params.deliveryId);
  }

  if (!txRow) {
    throw new Error('No eligible paid transaction found to refund.');
  }
  if (txRow.status !== 'paid' && txRow.status !== 'refunded') {
    throw new Error(`Cannot refund a transaction in '${txRow.status}' status.`);
  }

  const tx = mapPaymentTxRow(txRow);
  const amount = roundCurrency(params.amountNgn || tx.amountNgn);
  if (!Number.isFinite(amount) || amount <= 0 || amount > tx.amountNgn) {
    throw new Error(`Refund amount must be between ₦1 and ₦${tx.amountNgn.toLocaleString()}.`);
  }

  const refundRef = generateReference('RFD');
  const refundId = crypto.randomUUID();
  const now = new Date().toISOString();
  let providerRefundId: string | null = null;
  let refundStatus: 'pending' | 'completed' = 'completed';
  let isFullyRefunded = false;

  await withImmediateTransaction(async () => {
    const pending = await db.prepare("SELECT 1 FROM refunds WHERE payment_transaction_id = ? AND status = 'pending'")
      .get(tx.id);
    if (pending) {
      throw new PaymentVerificationError('A refund is already pending for this transaction. Verify it before issuing another.');
    }
    const reserved = await db.prepare(`
      SELECT COALESCE(SUM(amount_ngn), 0) AS total
      FROM refunds WHERE payment_transaction_id = ? AND status IN ('pending','completed')
    `).get(tx.id) as { total: number };
    if (roundCurrency(reserved.total + amount) > roundCurrency(tx.amountNgn)) {
      throw new Error('Refund amount exceeds remaining refundable balance for this transaction.');
    }
    if (params.destination === 'flutterwave') {
      if (tx.provider !== 'flutterwave' || !tx.providerTxId) {
        throw new Error('Flutterwave provider transaction ID is required for gateway refund.');
      }
      await db.prepare(`
        INSERT INTO refunds (
          id, reference, payment_transaction_id, delivery_id, user_id,
          amount_ngn, destination, reason, status, initiated_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'flutterwave', ?, 'pending', ?, ?)
      `).run(refundId, refundRef, tx.id, tx.deliveryId, tx.userId, amount, cleanReason, params.adminId, now);
    }
  });

  if (params.destination === 'flutterwave') {
    try {
      const outcome = await refundFlutterwaveWithApi(tx.providerTxId!, amount);
      providerRefundId = outcome.providerRefundId || null;
      refundStatus = outcome.completed && providerRefundId ? 'completed' : 'pending';
    } catch (error) {
      if (error instanceof GatewayRefundRejected || error instanceof PaymentConfigError) {
        await db.prepare("UPDATE refunds SET status = 'failed', processed_at = ? WHERE id = ?").run(now, refundId);
      }
      // An ambiguous response keeps the reservation until the refund can be checked.
      throw error;
    }
  }

  await withImmediateTransaction(async () => {
    if (params.destination === 'wallet') {
      await creditWalletAtomic({
        userId: tx.userId,
        amountNgn: amount,
        reference: `WLT-${refundRef}`,
        idempotencyKey: `refund:${refundRef}`,
        category: 'refund',
        description: `Refund for ${tx.trackingCode || tx.reference}: ${cleanReason}`,
        deliveryId: tx.deliveryId,
        paymentTransactionId: tx.id,
        actorUserId: params.adminId,
        actorRole: 'admin',
        metadata: { refundReference: refundRef, reason: cleanReason },
      });
    }

    if (params.destination === 'flutterwave') {
      await db.prepare('UPDATE refunds SET status = ?, provider_refund_id = ?, processed_at = ? WHERE id = ?')
        .run(refundStatus, providerRefundId, refundStatus === 'completed' ? now : null, refundId);
    } else {
      await db.prepare(`
        INSERT INTO refunds (
          id, reference, payment_transaction_id, delivery_id, user_id,
          amount_ngn, destination, reason, status, provider_refund_id,
          initiated_by, processed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)
      `).run(
        refundId,
        refundRef,
        tx.id,
        tx.deliveryId,
        tx.userId,
        amount,
        params.destination,
        cleanReason,
        providerRefundId,
        params.adminId,
        now,
        now
      );
    }
    if (refundStatus === 'completed') isFullyRefunded = await applyCompletedRefund(tx.id, now);
  });

  if (refundStatus === 'pending') {
    await notifyUser(tx.userId, 'Refund Initiated', `Flutterwave is processing refund ${refundRef}.`, tx.deliveryId);
  } else await notifyUser(
    tx.userId,
    isFullyRefunded ? 'Payment Refunded' : 'Partial Payment Refunded',
    `₦${amount.toLocaleString()} refunded (${params.destination}) for ${tx.trackingCode || tx.reference}. Reason: ${cleanReason}`,
    tx.deliveryId
  );
  await broadcastWsEvent('payment:updated', mapPaymentTxRow(await db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(tx.id)));
  if (tx.deliveryId) {
    const d = await getDeliveryById(tx.deliveryId);
    if (d) await broadcastWsEvent('delivery:updated', d);
  }

  syncAsync(async (sb) => {
    await sb.from('refunds').upsert({
      id: refundId,
      reference: refundRef,
      payment_transaction_id: tx.id,
      delivery_id: tx.deliveryId,
      user_id: tx.userId,
      amount_ngn: amount,
      destination: params.destination,
      reason: cleanReason,
      status: refundStatus,
      provider_refund_id: providerRefundId,
      initiated_by: params.adminId,
      processed_at: refundStatus === 'completed' ? now : null,
      created_at: now,
    });
    if (isFullyRefunded) {
      await sb
        .from('payment_transactions')
        .update({ status: 'refunded', updated_at: now })
        .eq('reference', tx.reference);
      if (tx.deliveryId && (await getDeliveryById(tx.deliveryId))?.paymentReference === tx.reference) {
        await sb
          .from('delivery_requests')
          .update({ payment_status: 'refunded', updated_at: now })
          .eq('id', tx.deliveryId);
      }
    }
  });

  const inserted = await db.prepare(`
    SELECT rf.*, pt.reference as payment_reference, dr.tracking_code, p.full_name as customer_name
    FROM refunds rf
    LEFT JOIN payment_transactions pt ON pt.id = rf.payment_transaction_id
    LEFT JOIN delivery_requests dr ON dr.id = rf.delivery_id
    LEFT JOIN profiles p ON p.id = rf.user_id
    WHERE rf.id = ?
  `).get(refundId);
  return mapRefundRow(inserted);
}

export async function getCustomerWalletSummary(userId: string): Promise<{
  wallet: WalletAccount;
  walletTransactions: WalletTransaction[];
  paymentTransactions: PaymentTransaction[];
}> {
  const wallet = await ensureWallet(userId);
  const wRows = await db
    .prepare(`
      SELECT wt.*, dr.tracking_code
      FROM wallet_transactions wt
      LEFT JOIN delivery_requests dr ON dr.id = wt.delivery_id
      WHERE wt.user_id = ?
      ORDER BY wt.created_at DESC
      LIMIT 100
    `)
    .all(userId) as any[];

  const pRows = await db
    .prepare(`
      SELECT pt.*, dr.tracking_code as delivery_tracking_code
      FROM payment_transactions pt
      LEFT JOIN delivery_requests dr ON dr.id = pt.delivery_id
      WHERE pt.user_id = ?
      ORDER BY pt.created_at DESC
      LIMIT 100
    `)
    .all(userId) as any[];

  return {
    wallet,
    walletTransactions: wRows.map(mapWalletTxRow),
    paymentTransactions: pRows.map(mapPaymentTxRow),
  };
}

function buildPaymentFilterWhere(filters?: {
  search?: string;
  method?: string;
  status?: string;
  purpose?: string;
  dateFrom?: string;
  dateTo?: string;
}): { whereSql: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters?.search?.trim()) {
    const q = `%${filters.search.trim()}%`;
    conditions.push(
      '(pt.reference LIKE ? OR pt.provider_tx_id LIKE ? OR pt.tracking_code LIKE ? OR pt.transfer_reference LIKE ? OR p.full_name LIKE ? OR p.email LIKE ?)'
    );
    params.push(q, q, q, q, q, q);
  }
  if (filters?.method && filters.method !== 'all') {
    conditions.push('pt.payment_method = ?');
    params.push(filters.method);
  }
  if (filters?.status && filters.status !== 'all') {
    conditions.push('pt.status = ?');
    params.push(filters.status);
  }
  if (filters?.purpose && filters.purpose !== 'all') {
    conditions.push('pt.purpose = ?');
    params.push(filters.purpose);
  }
  if (filters?.dateFrom?.trim()) {
    conditions.push('pt.created_at >= ?');
    params.push(filters.dateFrom.trim());
  }
  if (filters?.dateTo?.trim()) {
    conditions.push('pt.created_at <= ?');
    params.push(`${filters.dateTo.trim()}T23:59:59.999Z`);
  }

  return {
    whereSql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export async function getAdminPaymentsOverview(filters?: {
  search?: string;
  method?: string;
  status?: string;
  purpose?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}): Promise<AdminPaymentsOverview> {
  const totalWalletBalancesRow = await db
    .prepare(
      "SELECT COALESCE(SUM(w.balance_ngn), 0) as total FROM wallets w JOIN profiles p ON p.id = w.user_id WHERE p.role = 'client'"
    )
    .get() as { total: number };
  const totalWalletFundingRow = await db
    .prepare("SELECT COALESCE(SUM(amount_ngn), 0) as total FROM payment_transactions WHERE purpose = 'wallet_funding' AND status = 'paid'")
    .get() as { total: number };
  const totalDeliveryPaymentsRow = await db
    .prepare("SELECT COALESCE(SUM(amount_ngn), 0) as total FROM payment_transactions WHERE purpose = 'delivery_payment' AND status = 'paid'")
    .get() as { total: number };
  const totalCashRow = await db
    .prepare("SELECT COALESCE(SUM(amount_ngn), 0) as total FROM payment_transactions WHERE payment_method = 'cash' AND status IN ('collected_by_rider', 'paid')")
    .get() as { total: number };
  const totalBankRow = await db
    .prepare("SELECT COALESCE(SUM(amount_ngn), 0) as total FROM payment_transactions WHERE payment_method = 'bank_transfer' AND status = 'paid'")
    .get() as { total: number };
  const pendingRow = await db
    .prepare("SELECT COUNT(*) as c, COALESCE(SUM(amount_ngn), 0) as total FROM payment_transactions WHERE status IN ('pending', 'pending_verification', 'collected_by_rider')")
    .get() as { c: number; total: number };
  const failedRow = await db
    .prepare("SELECT COUNT(*) as c FROM payment_transactions WHERE status = 'failed'")
    .get() as { c: number };
  const refundsRow = await db
    .prepare("SELECT COUNT(*) as c, COALESCE(SUM(amount_ngn), 0) as total FROM refunds WHERE status = 'completed'")
    .get() as { c: number; total: number };

  const { whereSql, params } = buildPaymentFilterWhere(filters);
  const pageSize = Math.min(100, Math.max(1, Number(filters?.pageSize || 15)));
  const page = Math.max(1, Number(filters?.page || 1));

  const countRow = await db
    .prepare(
      `SELECT COUNT(*) as c FROM payment_transactions pt LEFT JOIN profiles p ON p.id = pt.user_id ${whereSql}`
    )
    .get(...params) as { c: number };
  const total = countRow.c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  const txRows = await db
    .prepare(`
      SELECT pt.*, p.full_name as profile_name, p.email as profile_email, p.phone as profile_phone,
             dr.tracking_code as delivery_tracking_code
      FROM payment_transactions pt
      LEFT JOIN profiles p ON p.id = pt.user_id
      LEFT JOIN delivery_requests dr ON dr.id = pt.delivery_id
      ${whereSql}
      ORDER BY pt.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, pageSize, offset) as any[];

  const walletRows = await db
    .prepare(`
      SELECT w.*, p.full_name as customer_name, p.email as customer_email, p.phone as customer_phone
      FROM wallets w
      JOIN profiles p ON p.id = w.user_id
      WHERE p.role = 'client'
      ORDER BY w.balance_ngn DESC, p.full_name ASC
    `)
    .all() as any[];

  const ccRows = await db
    .prepare(`
      SELECT cc.*, cp.full_name as customer_name, cp.phone as customer_phone, rp.full_name as rider_name
      FROM cash_collections cc
      LEFT JOIN profiles cp ON cp.id = cc.customer_id
      LEFT JOIN riders r ON r.id = cc.rider_id
      LEFT JOIN profiles rp ON rp.id = r.profile_id
      ORDER BY cc.created_at DESC
      LIMIT 100
    `)
    .all() as any[];

  const refundRows = await db
    .prepare(`
      SELECT rf.*, pt.reference as payment_reference, dr.tracking_code, p.full_name as customer_name
      FROM refunds rf
      LEFT JOIN payment_transactions pt ON pt.id = rf.payment_transaction_id
      LEFT JOIN delivery_requests dr ON dr.id = rf.delivery_id
      LEFT JOIN profiles p ON p.id = rf.user_id
      ORDER BY rf.created_at DESC
      LIMIT 100
    `)
    .all() as any[];

  const webhookRows = await db
    .prepare('SELECT * FROM payment_webhook_events ORDER BY received_at DESC LIMIT 60')
    .all() as any[];

  return {
    metrics: {
      totalWalletBalancesNgn: roundCurrency(totalWalletBalancesRow.total),
      totalWalletFundingNgn: roundCurrency(totalWalletFundingRow.total),
      totalDeliveryPaymentsNgn: roundCurrency(totalDeliveryPaymentsRow.total),
      totalCashCollectionsNgn: roundCurrency(totalCashRow.total),
      totalBankTransfersNgn: roundCurrency(totalBankRow.total),
      pendingTransactionsCount: pendingRow.c,
      pendingTransactionsAmountNgn: roundCurrency(pendingRow.total),
      failedTransactionsCount: failedRow.c,
      refundsCount: refundsRow.c,
      refundsTotalNgn: roundCurrency(refundsRow.total),
    },
    transactions: {
      items: txRows.map(mapPaymentTxRow),
      total,
      page: safePage,
      pageSize,
      totalPages,
    },
    wallets: walletRows.map(mapWalletRow),
    cashCollections: ccRows.map(mapCashCollectionRow),
    refunds: refundRows.map(mapRefundRow),
    webhookEvents: webhookRows.map(
      (r): PaymentWebhookEventRecord => ({
        id: r.id,
        provider: r.provider,
        eventType: r.event_type,
        eventId: r.event_id || null,
        txRef: r.tx_ref || null,
        flwTxId: r.flw_tx_id || null,
        idempotencyKey: r.idempotency_key,
        signatureValid: Boolean(r.signature_valid),
        status: r.status,
        processingError: r.processing_error || null,
        receivedAt: r.received_at,
        processedAt: r.processed_at || null,
      })
    ),
  };
}

export async function payDeliveryWithWallet(params: {
  deliveryId: string;
  userId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  idempotencyKey?: string | null;
}): Promise<{ delivery: NonNullable<Awaited<ReturnType<typeof getDeliveryById>>>; wallet: WalletAccount; paymentTransaction: PaymentTransaction }> {
  const now = new Date().toISOString();

  const { delivery, debit, tx, existingTx } = await withImmediateTransaction(async () => {
    const currentDelivery = await getDeliveryById(params.deliveryId);
    if (!currentDelivery) throw new Error('Delivery not found.');
    const customerRow = await db
      .prepare('SELECT id FROM customers WHERE profile_id = ?')
      .get(params.userId) as { id: string } | undefined;
    if (!customerRow || currentDelivery.customerId !== customerRow.id) {
      throw new Error('You are not authorized to pay for this delivery.');
    }
    if (currentDelivery.status === 'cancelled') {
      throw new Error('Cannot pay for a cancelled delivery.');
    }
    await requireNoPendingFlutterwaveCheckout(currentDelivery.id);
    if (currentDelivery.paymentStatus === 'paid') {
      throw new Error('This delivery is already paid.');
    }
    if (currentDelivery.paymentStatus === 'collected_by_rider') {
      throw new Error('Cash for this delivery has already been collected by the rider.');
    }

    const foundExistingTx = await db
      .prepare(
        "SELECT * FROM payment_transactions WHERE delivery_id = ? AND purpose = 'delivery_payment' AND status <> 'paid' AND provider <> 'flutterwave' ORDER BY created_at DESC LIMIT 1"
      )
      .get(currentDelivery.id) as any;

    const reference = generateReference('PAY');
    const paymentTxId = foundExistingTx?.id || crypto.randomUUID();

    const debitOutcome = await debitWalletAtomic({
      userId: params.userId,
      amountNgn: currentDelivery.deliveryFeeNgn,
      reference: `WLT-${reference}`,
      idempotencyKey: params.idempotencyKey ? `pay-del:${params.idempotencyKey}` : `pay-del:${currentDelivery.id}`,
      category: 'delivery_payment',
      description: `Wallet payment for delivery ${currentDelivery.trackingCode}`,
      deliveryId: currentDelivery.id,
      paymentTransactionId: paymentTxId,
      actorUserId: params.userId,
      actorRole: 'client',
      metadata: { trackingCode: currentDelivery.trackingCode },
    });

    let settledTx: PaymentTransaction;
    if (foundExistingTx) {
      let existingMeta: Record<string, unknown> = {};
      try {
        existingMeta = foundExistingTx.metadata ? JSON.parse(foundExistingTx.metadata) : {};
      } catch {
        existingMeta = {};
      }
      await db.prepare(`
        UPDATE payment_transactions
        SET payment_method = 'wallet',
            provider = 'internal',
            status = 'paid',
            failure_reason = NULL,
            verified_at = ?,
            verified_by = ?,
            metadata = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        now,
        params.userId,
        JSON.stringify({ ...existingMeta, walletTransactionId: debitOutcome.transaction.id }),
        now,
        foundExistingTx.id
      );
      settledTx = mapPaymentTxRow(
        await db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(foundExistingTx.id)
      );
    } else {
      settledTx = await insertPaymentTxRow({
        id: paymentTxId,
        reference,
        idempotencyKey: params.idempotencyKey || null,
        userId: params.userId,
        customerName: params.customerName,
        customerEmail: params.customerEmail,
        customerPhone: params.customerPhone,
        walletId: debitOutcome.wallet.id,
        deliveryId: currentDelivery.id,
        trackingCode: currentDelivery.trackingCode,
        purpose: 'delivery_payment',
        paymentMethod: 'wallet',
        provider: 'internal',
        amountNgn: currentDelivery.deliveryFeeNgn,
        status: 'paid',
        verifiedAt: now,
        verifiedBy: params.userId,
        metadata: { walletTransactionId: debitOutcome.transaction.id },
      });
    }

    const deliveryUpdate = await db.prepare(
      "UPDATE delivery_requests SET payment_method = 'wallet', payment_status = 'paid', payment_reference = ?, updated_at = ? WHERE id = ? AND payment_status NOT IN ('paid', 'collected_by_rider') AND status <> 'cancelled'"
    ).run(settledTx.reference, now, currentDelivery.id);
    if (deliveryUpdate.changes === 0) {
      throw new Error('This delivery is no longer eligible for wallet payment.');
    }

    await db.prepare(
      "DELETE FROM cash_collections WHERE delivery_id = ? AND status IN ('pending', 'pending_verification', 'disputed')"
    ).run(currentDelivery.id);

    if (currentDelivery.status === 'delivered') {
      await db.prepare("UPDATE payments SET status = 'settled' WHERE delivery_id = ? AND status = 'pending'").run(
        currentDelivery.id
      );
    }

    return {
      delivery: currentDelivery,
      debit: debitOutcome,
      tx: settledTx,
      existingTx: foundExistingTx,
    };
  });

  const updatedDelivery = (await getDeliveryById(delivery.id))!;
  await broadcastWsEvent('delivery:updated', updatedDelivery);
  await broadcastWsEvent('payment:updated', tx);

  syncAsync(async (sb) => {
    if (existingTx) {
      await sb
        .from('payment_transactions')
        .update({
          payment_method: 'wallet',
          provider: 'internal',
          status: 'paid',
          failure_reason: null,
          verified_at: now,
          verified_by: params.userId,
          updated_at: now,
        })
        .eq('reference', tx.reference);
    }
    await sb
      .from('delivery_requests')
      .update({
        payment_method: 'wallet',
        payment_status: 'paid',
        payment_reference: tx.reference,
        updated_at: now,
      })
      .eq('id', delivery.id);
    await sb
      .from('cash_collections')
      .delete()
      .eq('delivery_id', delivery.id)
      .in('status', ['pending', 'pending_verification', 'disputed']);
  });

  return { delivery: updatedDelivery, wallet: debit.wallet, paymentTransaction: tx };
}

export async function exportPaymentsCsv(filters?: {
  search?: string;
  method?: string;
  status?: string;
  purpose?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<string> {
  const { whereSql, params } = buildPaymentFilterWhere(filters);
  const rows = await db
    .prepare(`
      SELECT pt.*, p.full_name as profile_name, p.email as profile_email, p.phone as profile_phone,
             dr.tracking_code as delivery_tracking_code
      FROM payment_transactions pt
      LEFT JOIN profiles p ON p.id = pt.user_id
      LEFT JOIN delivery_requests dr ON dr.id = pt.delivery_id
      ${whereSql}
      ORDER BY pt.created_at DESC
      LIMIT 10000
    `)
    .all(...params) as any[];
  const items = rows.map(mapPaymentTxRow);

  const escape = (val: unknown) => {
    let s = String(val ?? '');
    if (/^[=+\-@\t\r]/.test(s)) {
      s = `'${s}`;
    }
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    'Reference',
    'Date',
    'Customer',
    'Email',
    'Phone',
    'Purpose',
    'Method',
    'Amount (NGN)',
    'Status',
    'Tracking Code',
    'Provider Tx ID',
    'Transfer Ref',
  ].join(',');

  const lines = items.map((t) =>
    [
      escape(t.reference),
      escape(t.createdAt),
      escape(t.customerName || ''),
      escape(t.customerEmail || ''),
      escape(t.customerPhone || ''),
      escape(t.purpose),
      escape(t.paymentMethod),
      t.amountNgn,
      escape(t.status),
      escape(t.trackingCode || ''),
      escape(t.providerTxId || ''),
      escape(t.transferReference || ''),
    ].join(',')
  );

  return [header, ...lines].join('\n');
}

export async function getWalletAuditLogs(limit = 50): Promise<Array<{
  id: string;
  walletId: string;
  userId: string;
  customerName: string;
  action: string;
  amountNgn: number;
  direction: string | null;
  reason: string;
  actorId: string;
  actorName: string | null;
  createdAt: string;
}>> {
  const rows = await db
    .prepare(`
      SELECT wal.*, p.full_name as customer_name
      FROM wallet_audit_logs wal
      LEFT JOIN profiles p ON p.id = wal.user_id
      ORDER BY wal.created_at DESC
      LIMIT ?
    `)
    .all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    walletId: r.wallet_id,
    userId: r.user_id,
    customerName: r.customer_name || r.user_id,
    action: r.action,
    amountNgn: roundCurrency(r.amount_ngn),
    direction: r.direction || null,
    reason: r.reason,
    actorId: r.actor_id,
    actorName: r.actor_name || null,
    createdAt: r.created_at,
  }));
}

export async function getPaymentTransactionByKey(idempotencyKey: string): Promise<PaymentTransaction | null> {
  const row = await db
    .prepare('SELECT * FROM payment_transactions WHERE idempotency_key = ?')
    .get(idempotencyKey);
  return row ? mapPaymentTxRow(row) : null;
}

export async function cancelDeliveryPayments(deliveryId: string, opts?: { reason?: string }): Promise<void> {
  const now = new Date().toISOString();
  const reason = opts?.reason?.trim() || 'Delivery cancelled before payment completed';
  const updatedIds: string[] = [];

  await withImmediateTransaction(async () => {
    const unpaidRows = await db
      .prepare(
        "SELECT id FROM payment_transactions WHERE delivery_id = ? AND status IN ('pending', 'pending_verification')"
      )
      .all(deliveryId) as Array<{ id: string }>;
    for (const r of unpaidRows) {
      updatedIds.push(r.id);
    }

    if (updatedIds.length > 0) {
      await db.prepare(
        "UPDATE payment_transactions SET status = 'failed', failure_reason = ?, updated_at = ? WHERE delivery_id = ? AND status IN ('pending', 'pending_verification')"
      ).run(reason, now, deliveryId);
    }

    await db.prepare(
      "DELETE FROM cash_collections WHERE delivery_id = ? AND status IN ('pending', 'pending_verification', 'disputed')"
    ).run(deliveryId);
  });

  for (const id of updatedIds) {
    const row = await db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(id);
    if (row) await broadcastWsEvent('payment:updated', mapPaymentTxRow(row));
  }

  syncAsync(async (sb) => {
    await sb
      .from('payment_transactions')
      .update({ status: 'failed', failure_reason: reason, updated_at: now })
      .eq('delivery_id', deliveryId)
      .in('status', ['pending', 'pending_verification']);
    await sb
      .from('cash_collections')
      .delete()
      .eq('delivery_id', deliveryId)
      .in('status', ['pending', 'pending_verification', 'disputed']);
  });
}
