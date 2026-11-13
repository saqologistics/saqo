import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { DEFAULT_PLATFORM_SETTINGS } from '../shared/pricing';
import type {
  AccountStatus,
  ComplaintRecord,
  CustomerSummary,
  DeliveryAssignment,
  DeliveryRequest,
  DeliveryStatus,
  DeliveryStatusHistoryItem,
  NotificationItem,
  ParcelCategory,
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

const DB_PATH = process.env.SAQO_DB_PATH || path.resolve(process.cwd(), 'saqo.db');
const SESSION_SECRET = process.env.SAQO_SESSION_SECRET || 'saqo-dev-hmac-secret-2026';

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

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

export function verifySessionToken(token: string): { userId: string; role: UserRole } | null {
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
    if (parsed.userId && parsed.role) {
      return { userId: parsed.userId, role: parsed.role };
    }
    return null;
  } catch {
    return null;
  }
}

export function initDatabase(): void {
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
      is_online INTEGER NOT NULL DEFAULT 0,
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
      whatsapp_support_number TEXT NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_support_conv_visitor ON support_conversations(visitor_token);
    CREATE INDEX IF NOT EXISTS idx_support_conv_user ON support_conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_support_msg_conv ON support_messages(conversation_id);
  `);

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

  bootstrapAdminAccount();
}

function bootstrapAdminAccount(): void {
  const adminCount = db
    .prepare("SELECT COUNT(*) as c FROM profiles WHERE role = 'admin'")
    .get() as { c: number };
  if (adminCount.c > 0) return;

  const now = new Date().toISOString();
  const adminEmail = (process.env.SAQO_ADMIN_EMAIL || 'admin@saqo.ng').trim().toLowerCase();
  const adminPass = hashPassword(process.env.SAQO_ADMIN_PASSWORD || 'saqo1234');
  const adminName = process.env.SAQO_ADMIN_NAME || 'SAQO Operations Admin';
  const adminPhone = process.env.SAQO_ADMIN_PHONE || '+2348007276000';

  db.prepare(`
    INSERT INTO profiles (id, email, password_hash, full_name, phone, role, account_status, created_at)
    VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?)
  `).run(`prof-admin-${crypto.randomUUID().slice(0, 8)}`, adminEmail, adminPass, adminName, adminPhone, now);
}

// Query helpers
export function getPlatformSettings(): PlatformSettings {
  const row = db.prepare('SELECT * FROM platform_settings WHERE id = 1').get() as any;
  return {
    maxActiveParcelsPerRider: row.max_active_parcels_per_rider,
    searchRadiusKm: row.search_radius_km,
    offerTimeoutSeconds: row.offer_timeout_seconds,
    baseLocalFeeNgn: row.base_local_fee_ngn,
    perKmRateNgn: row.per_km_rate_ngn,
    interStateSurchargeNgn: row.inter_state_surcharge_ngn,
    riderCommissionPercent: row.rider_commission_percent,
    whatsappSupportNumber: row.whatsapp_support_number,
  };
}

export function getProfileById(id: string): Profile | null {
  const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as any;
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

export function getAllRiders(): RiderProfile[] {
  const rows = db.prepare(`
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

export function getRiderByProfileId(profileId: string): RiderProfile | null {
  return getAllRiders().find((r) => r.id === profileId) || null;
}

export function getAllCustomers(): CustomerSummary[] {
  const rows = db.prepare(`
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

export function getDeliveryById(deliveryId: string): DeliveryRequest | null {
  const row = db.prepare(`
    SELECT dr.*,
      pa.category as parcel_category, pa.description as parcel_description, pa.weight_kg,
      cp.full_name as customer_name, cp.phone as customer_phone,
      rp.full_name as rider_name, rp.phone as rider_phone,
      r.vehicle_type as rider_vehicle, r.verification_status as rider_verification_status,
      r.current_lat as rider_lat, r.current_lng as rider_lng
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

export function getDeliveryByTrackingCode(trackingCode: string): DeliveryRequest | null {
  const row = db.prepare(`
    SELECT dr.*,
      pa.category as parcel_category, pa.description as parcel_description, pa.weight_kg,
      cp.full_name as customer_name, cp.phone as customer_phone,
      rp.full_name as rider_name, rp.phone as rider_phone,
      r.vehicle_type as rider_vehicle, r.verification_status as rider_verification_status,
      r.current_lat as rider_lat, r.current_lng as rider_lng
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

export function listDeliveries(filter?: { customerId?: string; riderId?: string }): DeliveryRequest[] {
  let sql = `
    SELECT dr.*,
      pa.category as parcel_category, pa.description as parcel_description, pa.weight_kg,
      cp.full_name as customer_name, cp.phone as customer_phone,
      rp.full_name as rider_name, rp.phone as rider_phone,
      r.vehicle_type as rider_vehicle, r.verification_status as rider_verification_status,
      r.current_lat as rider_lat, r.current_lng as rider_lng
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
  const rows = db.prepare(sql).all(...params) as any[];
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getDeliveryHistory(deliveryId: string): DeliveryStatusHistoryItem[] {
  const rows = db
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

export function getAssignmentsForRider(riderId: string): DeliveryAssignment[] {
  const rows = db.prepare(`
    SELECT da.*, dr.tracking_code, rp.full_name as rider_name
    FROM delivery_assignments da
    JOIN delivery_requests dr ON dr.id = da.delivery_id
    JOIN riders r ON r.id = da.rider_id
    JOIN profiles rp ON rp.id = r.profile_id
    WHERE da.rider_id = ?
    ORDER BY da.offered_at DESC
  `).all(riderId) as any[];

  return rows.map((row) => ({
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
    delivery: getDeliveryById(row.delivery_id) || undefined,
  }));
}

export function getAllPayments(): PaymentRecord[] {
  const rows = db.prepare(`
    SELECT py.*, dr.tracking_code, cp.full_name as customer_name
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
    status: r.status,
    createdAt: r.created_at,
  }));
}

export function getAllComplaints(): ComplaintRecord[] {
  const rows = db.prepare(`
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

export function getTicketsForReporter(reporterId: string): ComplaintRecord[] {
  return getAllComplaints().filter((c) => c.reporterId === reporterId);
}

export function getNotificationsForUser(userId: string): NotificationItem[] {
  const rows = db
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

export function createNotification(
  userId: string,
  title: string,
  message: string,
  deliveryId: string | null = null
): NotificationItem {
  const id = `notif-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  db.prepare(`
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

export function getSupportConversationById(id: string): SupportConversation | null {
  const row = db.prepare('SELECT * FROM support_conversations WHERE id = ?').get(id) as any;
  return row ? mapSupportConversationRow(row) : null;
}

export function getAllSupportConversations(): SupportConversation[] {
  const rows = db
    .prepare('SELECT * FROM support_conversations ORDER BY last_message_at DESC')
    .all() as any[];
  return rows.map(mapSupportConversationRow);
}

export function getSupportConversationsForVisitor(params: {
  visitorToken?: string | null;
  userId?: string | null;
}): SupportConversation[] {
  const { visitorToken, userId } = params;
  if (userId && visitorToken) {
    // Associate any anonymous conversations started in the same browser with this signed-in user
    db.prepare(
      `UPDATE support_conversations SET user_id = ? WHERE visitor_token = ? AND user_id IS NULL`
    ).run(userId, visitorToken);
    const rows = db
      .prepare(
        `SELECT * FROM support_conversations WHERE user_id = ? OR visitor_token = ? ORDER BY last_message_at DESC`
      )
      .all(userId, visitorToken) as any[];
    return rows.map(mapSupportConversationRow);
  }
  if (userId) {
    const rows = db
      .prepare(`SELECT * FROM support_conversations WHERE user_id = ? ORDER BY last_message_at DESC`)
      .all(userId) as any[];
    return rows.map(mapSupportConversationRow);
  }
  if (visitorToken) {
    const rows = db
      .prepare(
        `SELECT * FROM support_conversations WHERE visitor_token = ? ORDER BY last_message_at DESC`
      )
      .all(visitorToken) as any[];
    return rows.map(mapSupportConversationRow);
  }
  return [];
}

export function getSupportMessages(conversationId: string): SupportMessage[] {
  const rows = db
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

export function createSupportConversation(input: {
  visitorToken: string;
  userId: string | null;
  visitorName: string;
  visitorEmail: string | null;
  visitorPhone: string | null;
  trackingCode: string | null;
  initialMessage: string;
  senderRole: SupportSenderRole;
}): { conversation: SupportConversation; message: SupportMessage } {
  const convId = `chat-${crypto.randomUUID().slice(0, 8)}`;
  const msgId = `cmsg-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const cleanPreview = input.initialMessage.trim().slice(0, 140);

  db.prepare(`
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

  db.prepare(`
    INSERT INTO support_messages (id, conversation_id, sender_role, sender_name, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(msgId, convId, input.senderRole, input.visitorName.trim(), input.initialMessage.trim(), now);

  return {
    conversation: getSupportConversationById(convId)!,
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

export function addSupportMessage(input: {
  conversationId: string;
  senderRole: SupportSenderRole;
  senderName: string;
  body: string;
  assignedAdminId?: string | null;
}): { conversation: SupportConversation; message: SupportMessage } {
  const msgId = `cmsg-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const cleanBody = input.body.trim();
  const preview = cleanBody.slice(0, 140);

  db.prepare(`
    INSERT INTO support_messages (id, conversation_id, sender_role, sender_name, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(msgId, input.conversationId, input.senderRole, input.senderName, cleanBody, now);

  if (input.senderRole === 'admin') {
    db.prepare(`
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
    db.prepare(`
      UPDATE support_conversations
      SET last_message_preview = ?, last_message_at = ?
      WHERE id = ?
    `).run(preview, now, input.conversationId);
  } else {
    db.prepare(`
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
    conversation: getSupportConversationById(input.conversationId)!,
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

export function markSupportConversationRead(
  conversationId: string,
  reader: 'admin' | 'visitor'
): SupportConversation | null {
  if (reader === 'admin') {
    db.prepare('UPDATE support_conversations SET unread_by_admin = 0 WHERE id = ?').run(
      conversationId
    );
  } else {
    db.prepare('UPDATE support_conversations SET unread_by_visitor = 0 WHERE id = ?').run(
      conversationId
    );
  }
  return getSupportConversationById(conversationId);
}

export function updateSupportConversationStatus(
  conversationId: string,
  status: SupportConversationStatus,
  actorName: string
): { conversation: SupportConversation; systemMessage: SupportMessage } | null {
  const existing = getSupportConversationById(conversationId);
  if (!existing) return null;
  db.prepare('UPDATE support_conversations SET status = ? WHERE id = ?').run(
    status,
    conversationId
  );
  const labelMap: Record<SupportConversationStatus, string> = {
    open: 'reopened',
    pending: 'marked as awaiting response',
    resolved: 'marked as resolved',
    closed: 'closed',
  };
  const { conversation, message } = addSupportMessage({
    conversationId,
    senderRole: 'system',
    senderName: 'SAQO Support',
    body: `Conversation ${labelMap[status]} by ${actorName}.`,
  });
  return { conversation, systemMessage: message };
}
