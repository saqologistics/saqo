import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import {
  addSupportMessage,
  createNotification,
  createSupportConversation,
  db,
  getAllComplaints,
  getAllCustomers,
  getAllPayments,
  getAllRiders,
  getAllSupportConversations,
  getAssignmentsForRider,
  getDeliveryById,
  getDeliveryByTrackingCode,
  getDeliveryHistory,
  getNotificationsForUser,
  getPlatformSettings,
  getProfileById,
  getRiderByProfileId,
  getSupportConversationById,
  getSupportConversationsForVisitor,
  getSupportMessages,
  getTicketsForReporter,
  hashPassword,
  initDatabase,
  listDeliveries,
  markSupportConversationRead,
  signSessionToken,
  updateSupportConversationStatus,
  verifyPassword,
  verifySessionToken,
} from './src/server/db';
import {
  broadcastWsEvent,
  clearOfferTimer,
  dispatchNextRiderForDelivery,
  getSupportPresence,
  isAdminChatAvailableFlag,
  registerWsClient,
  setAdminChatAvailability,
  setWsClientAuth,
} from './src/server/dispatchEngine';
import { findStateHub, resolveAddressCoordinates } from './src/shared/nigeria';
import {
  calculateDeliveryQuote,
  calculateRiderPayoutNgn,
  isValidNigerianPhone,
  matchesDeliveryOtp,
} from './src/shared/pricing';
import type { DeliveryStatus, SupportConversationStatus, UserRole } from './src/shared/types';

initDatabase();

interface AuthedRequest extends Request {
  auth?: { userId: string; role: UserRole };
}

function authenticate(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  const payload = verifySessionToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired session token.' });
    return;
  }
  const profile = getProfileById(payload.userId);
  if (!profile) {
    res.status(401).json({ error: 'Account not found.' });
    return;
  }
  if (profile.accountStatus === 'suspended') {
    res.status(403).json({ error: 'Your account has been suspended. Contact SAQO support.' });
    return;
  }
  req.auth = { userId: profile.id, role: profile.role };
  next();
}

function requireRole(...roles: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      res.status(403).json({ error: 'Insufficient permissions for this action.' });
      return;
    }
    next();
  };
}

function tryAuthenticate(req: Request): { userId: string; role: UserRole } | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  const payload = verifySessionToken(token);
  if (!payload) return null;
  const profile = getProfileById(payload.userId);
  if (!profile || profile.accountStatus === 'suspended') return null;
  return { userId: profile.id, role: profile.role };
}

async function startServer() {
  const app = express();
  app.use(express.json());

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', (ws) => {
    registerWsClient(ws);
    ws.send(
      JSON.stringify({
        type: 'connected',
        payload: { message: 'SAQO real-time stream connected' },
        timestamp: new Date().toISOString(),
      })
    );
    ws.send(
      JSON.stringify({
        type: 'support:presence',
        payload: getSupportPresence(),
        timestamp: new Date().toISOString(),
      })
    );

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'auth' && typeof msg.token === 'string') {
          const payload = verifySessionToken(msg.token);
          if (payload) {
            const prof = getProfileById(payload.userId);
            if (prof && prof.accountStatus === 'active') {
              setWsClientAuth(ws, prof.id, prof.role);
            }
          }
        } else if (msg?.type === 'support:typing' && typeof msg.conversationId === 'string') {
          broadcastWsEvent('support:typing', {
            conversationId: msg.conversationId,
            senderRole: msg.senderRole === 'admin' ? 'admin' : 'visitor',
            senderName: typeof msg.senderName === 'string' ? msg.senderName : 'Support',
            isTyping: Boolean(msg.isTyping),
          });
        }
      } catch {
        // ignore malformed frames
      }
    });
  });

  // Healthcheck
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'saqo-dispatch' });
  });

  // Public settings
  app.get('/api/settings/public', (_req, res) => {
    const s = getPlatformSettings();
    res.json({
      whatsappSupportNumber: s.whatsappSupportNumber,
      maxActiveParcelsPerRider: s.maxActiveParcelsPerRider,
      offerTimeoutSeconds: s.offerTimeoutSeconds,
    });
  });

  // Quote endpoint
  app.post('/api/quote', (req, res) => {
    const { pickupState, pickupAddress, destinationState, destinationAddress, weightKg } =
      req.body || {};
    if (!pickupState || !destinationState) {
      res.status(400).json({ error: 'Pickup and destination states are required.' });
      return;
    }
    const pCoords = resolveAddressCoordinates(pickupState, pickupAddress || pickupState);
    const dCoords = resolveAddressCoordinates(
      destinationState,
      destinationAddress || destinationState
    );
    const settings = getPlatformSettings();
    const quote = calculateDeliveryQuote({
      pickupState,
      pickupLat: pCoords.lat,
      pickupLng: pCoords.lng,
      destinationState,
      destinationLat: dCoords.lat,
      destinationLng: dCoords.lng,
      weightKg: Number(weightKg) > 0 ? Number(weightKg) : 1,
      settings,
    });
    res.json({
      ...quote,
      pickupCoords: pCoords,
      destinationCoords: dCoords,
    });
  });

  // Auth: Login
  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }
    const row = db
      .prepare('SELECT * FROM profiles WHERE LOWER(email) = LOWER(?)')
      .get(String(email).trim()) as any;
    if (!row || !verifyPassword(String(password), row.password_hash)) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    if (row.account_status === 'suspended') {
      res.status(403).json({ error: 'Account is suspended. Please contact SAQO support.' });
      return;
    }
    const token = signSessionToken({ userId: row.id, role: row.role });
    const profile = getProfileById(row.id)!;
    const rider = profile.role === 'rider' ? getRiderByProfileId(profile.id) : null;
    res.json({ token, profile, rider });
  });

  // Auth: Register (Public registration is strictly for Customers; riders are issued by Admin)
  app.post('/api/auth/register', (req, res) => {
    const {
      email,
      password,
      fullName,
      phone,
      role,
      homeState,
    } = req.body || {};

    if (role && role !== 'client') {
      res.status(403).json({ error: 'Rider accounts are issued directly by SAQO Operations Admin.' });
      return;
    }

    if (!email || !password || !fullName || !phone) {
      res.status(400).json({ error: 'Full name, phone number, email, and password are required.' });
      return;
    }
    const phoneDigits = String(phone).replace(/\D/g, '');
    if (phoneDigits.length < 10) {
      res.status(400).json({ error: 'Please enter a valid phone number (at least 10 digits).' });
      return;
    }
    if (String(password).length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters.' });
      return;
    }
    const targetRole: UserRole = 'client';
    const existing = db
      .prepare('SELECT id FROM profiles WHERE LOWER(email) = LOWER(?)')
      .get(String(email).trim());
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const profileId = `prof-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const passHash = hashPassword(String(password));
    const state = homeState || 'Katsina';

    db.prepare(`
      INSERT INTO profiles (id, email, password_hash, full_name, phone, role, account_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(profileId, String(email).trim().toLowerCase(), passHash, String(fullName).trim(), String(phone).trim(), targetRole, now);

    db.prepare(`INSERT INTO customers (id, profile_id, default_state) VALUES (?, ?, ?)`).run(
      `cust-${crypto.randomUUID().slice(0, 8)}`,
      profileId,
      state
    );

    const token = signSessionToken({ userId: profileId, role: targetRole });
    const profile = getProfileById(profileId)!;
    res.status(201).json({ token, profile, rider: null });
  });

  // Auth: Me
  app.get('/api/auth/me', authenticate, (req: AuthedRequest, res) => {
    const profile = getProfileById(req.auth!.userId)!;
    const rider = profile.role === 'rider' ? getRiderByProfileId(profile.id) : null;
    res.json({ profile, rider });
  });

  // Public tracking lookup
  app.get('/api/track/:trackingCode', (req, res) => {
    const delivery = getDeliveryByTrackingCode(req.params.trackingCode);
    if (!delivery) {
      res.status(404).json({ error: 'Tracking code not found.' });
      return;
    }
    const history = getDeliveryHistory(delivery.id);
    // Redact raw OTP on unauthenticated public lookup while exposing verification status
    const { deliveryOtp: _otp, ...publicDelivery } = delivery;
    res.json({ delivery: publicDelivery, history });
  });

  // Confirm OTP (public recipient or client)
  app.post('/api/track/:trackingCode/confirm-otp', (req, res) => {
    const { otp } = req.body || {};
    const delivery = getDeliveryByTrackingCode(req.params.trackingCode);
    if (!delivery) {
      res.status(404).json({ error: 'Parcel not found.' });
      return;
    }
    if (delivery.status === 'delivered') {
      res.status(400).json({ error: 'This parcel has already been marked as delivered.' });
      return;
    }
    if (delivery.status === 'cancelled') {
      res.status(400).json({ error: 'Cancelled deliveries cannot be confirmed.' });
      return;
    }
    if (!otp || !matchesDeliveryOtp(String(otp), delivery.deliveryOtp)) {
      res.status(400).json({ error: 'Invalid delivery OTP. Please check the 4-digit code.' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE delivery_requests
      SET otp_verified = 1, status = 'delivered', updated_at = ?
      WHERE id = ?
    `).run(now, delivery.id);

    db.prepare(`
      INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
      VALUES (?, ?, 'delivered', ?, 'client', ?)
    `).run(
      `hist-${crypto.randomUUID().slice(0, 8)}`,
      delivery.id,
      `Parcel receipt confirmed via 4-digit delivery OTP (${delivery.deliveryOtp}).`,
      now
    );

    // Settle payment & credit rider
    db.prepare(`UPDATE payments SET status = 'settled' WHERE delivery_id = ?`).run(delivery.id);
    if (delivery.assignedRiderId) {
      const payment = db
        .prepare('SELECT rider_payout_ngn FROM payments WHERE delivery_id = ?')
        .get(delivery.id) as { rider_payout_ngn: number } | undefined;
      db.prepare(`
        UPDATE riders
        SET completed_deliveries_count = completed_deliveries_count + 1,
            total_earnings_ngn = total_earnings_ngn + ?
        WHERE id = ?
      `).run(payment?.rider_payout_ngn || 0, delivery.assignedRiderId);
    }

    const updated = getDeliveryById(delivery.id)!;
    broadcastWsEvent('delivery:updated', updated);
    const { deliveryOtp: _otp, ...publicDelivery } = updated;
    res.json({ delivery: publicDelivery, history: getDeliveryHistory(delivery.id) });
  });

  // Notifications
  app.get('/api/notifications', authenticate, (req: AuthedRequest, res) => {
    res.json({ notifications: getNotificationsForUser(req.auth!.userId) });
  });

  app.post('/api/notifications/read', authenticate, (req: AuthedRequest, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.auth!.userId);
    res.json({ ok: true });
  });

  // Client: List deliveries
  app.get('/api/client/deliveries', authenticate, requireRole('client'), (req: AuthedRequest, res) => {
    const cust = db
      .prepare('SELECT id FROM customers WHERE profile_id = ?')
      .get(req.auth!.userId) as { id: string } | undefined;
    if (!cust) {
      res.json({ deliveries: [] });
      return;
    }
    const deliveries = listDeliveries({ customerId: cust.id });
    const withHistory = deliveries.map((d) => ({
      ...d,
      history: getDeliveryHistory(d.id),
    }));
    res.json({ deliveries: withHistory });
  });

  // Client: Create delivery request + trigger Smart Dispatch
  app.post('/api/deliveries', authenticate, requireRole('client'), (req: AuthedRequest, res) => {
    const {
      pickupState,
      pickupAddress,
      destinationState,
      destinationAddress,
      recipientName,
      recipientPhone,
      parcelCategory,
      parcelDescription,
      weightKg,
    } = req.body || {};

    if (
      !pickupState ||
      !pickupAddress ||
      !destinationState ||
      !destinationAddress ||
      !recipientName ||
      !recipientPhone ||
      !parcelDescription
    ) {
      res.status(400).json({ error: 'Please complete all pickup, destination, recipient, and parcel fields.' });
      return;
    }
    if (!isValidNigerianPhone(String(recipientPhone))) {
      res.status(400).json({ error: 'Please enter a valid recipient phone number (at least 10 digits).' });
      return;
    }

    const cust = db
      .prepare('SELECT id FROM customers WHERE profile_id = ?')
      .get(req.auth!.userId) as { id: string } | undefined;
    if (!cust) {
      res.status(400).json({ error: 'Customer profile not initialized.' });
      return;
    }

    const settings = getPlatformSettings();
    const pCoords = resolveAddressCoordinates(pickupState, pickupAddress);
    const dCoords = resolveAddressCoordinates(destinationState, destinationAddress);
    const parsedWeight = Math.max(0.5, Number(weightKg) || 1);

    const quote = calculateDeliveryQuote({
      pickupState,
      pickupLat: pCoords.lat,
      pickupLng: pCoords.lng,
      destinationState,
      destinationLat: dCoords.lat,
      destinationLng: dCoords.lng,
      weightKg: parsedWeight,
      settings,
    });

    const deliveryId = `del-${crypto.randomUUID().slice(0, 8)}`;
    const trackingCode = `SQ-2026-${Math.floor(1000 + Math.random() * 9000)}`;
    const otp = String(Math.floor(1000 + Math.random() * 9000));
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO delivery_requests (
        id, tracking_code, customer_id, pickup_state, pickup_address, pickup_lat, pickup_lng,
        destination_state, destination_address, destination_lat, destination_lng,
        recipient_name, recipient_phone, service_tier, distance_km, estimated_minutes,
        delivery_fee_ngn, delivery_otp, otp_verified, status, assigned_rider_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending_dispatch', NULL, ?, ?)
    `).run(
      deliveryId,
      trackingCode,
      cust.id,
      pickupState,
      String(pickupAddress).trim(),
      pCoords.lat,
      pCoords.lng,
      destinationState,
      String(destinationAddress).trim(),
      dCoords.lat,
      dCoords.lng,
      String(recipientName).trim(),
      String(recipientPhone).trim(),
      quote.serviceTier,
      quote.distanceKm,
      quote.estimatedMinutes,
      quote.deliveryFeeNgn,
      otp,
      now,
      now
    );

    db.prepare(`
      INSERT INTO parcels (id, delivery_id, category, description, weight_kg)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      `parc-${crypto.randomUUID().slice(0, 8)}`,
      deliveryId,
      parcelCategory || 'General Cargo',
      String(parcelDescription).trim(),
      parsedWeight
    );

    const riderPayout = calculateRiderPayoutNgn(
      quote.deliveryFeeNgn,
      settings.riderCommissionPercent
    );
    const platformFee = quote.deliveryFeeNgn - riderPayout;
    db.prepare(`
      INSERT INTO payments (id, delivery_id, amount_ngn, rider_payout_ngn, platform_fee_ngn, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(`pay-${crypto.randomUUID().slice(0, 8)}`, deliveryId, quote.deliveryFeeNgn, riderPayout, platformFee, now);

    db.prepare(`
      INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
      VALUES (?, ?, 'pending_dispatch', ?, 'client', ?)
    `).run(
      `hist-${crypto.randomUUID().slice(0, 8)}`,
      deliveryId,
      `Parcel request created (${quote.serviceTier.replace('_', ' ')} · ${quote.distanceKm} km).`,
      now
    );

    const created = getDeliveryById(deliveryId)!;
    broadcastWsEvent('delivery:created', created);

    // Run Smart Rider Assignment Algorithm immediately
    const dispatchResult = dispatchNextRiderForDelivery(deliveryId);
    const finalDelivery = getDeliveryById(deliveryId)!;

    res.status(201).json({
      delivery: finalDelivery,
      history: getDeliveryHistory(deliveryId),
      dispatchResult,
    });
  });

  // Client or Admin: Retry smart dispatch
  app.post('/api/deliveries/:id/retry-dispatch', authenticate, requireRole('client', 'admin'), (req: AuthedRequest, res) => {
    const delivery = getDeliveryById(req.params.id);
    if (!delivery) {
      res.status(404).json({ error: 'Delivery not found.' });
      return;
    }
    if (req.auth!.role === 'client') {
      const cust = db
        .prepare('SELECT id FROM customers WHERE profile_id = ?')
        .get(req.auth!.userId) as { id: string } | undefined;
      if (!cust || delivery.customerId !== cust.id) {
        res.status(403).json({ error: 'You can only manage your own parcel requests.' });
        return;
      }
    }
    db.prepare(
      `DELETE FROM delivery_assignments WHERE delivery_id = ? AND status IN ('rejected', 'timed_out')`
    ).run(delivery.id);
    const dispatchResult = dispatchNextRiderForDelivery(delivery.id);
    const updated = getDeliveryById(delivery.id)!;
    res.json({ delivery: updated, dispatchResult });
  });

  // Client or Admin: Cancel delivery
  app.post('/api/deliveries/:id/cancel', authenticate, requireRole('client', 'admin'), (req: AuthedRequest, res) => {
    const delivery = getDeliveryById(req.params.id);
    if (!delivery) {
      res.status(404).json({ error: 'Delivery not found.' });
      return;
    }
    if (req.auth!.role === 'client') {
      const cust = db
        .prepare('SELECT id FROM customers WHERE profile_id = ?')
        .get(req.auth!.userId) as { id: string } | undefined;
      if (!cust || delivery.customerId !== cust.id) {
        res.status(403).json({ error: 'You can only cancel your own parcel requests.' });
        return;
      }
    }
    if (['delivered', 'cancelled'].includes(delivery.status)) {
      res.status(400).json({ error: 'Cannot cancel a completed or already cancelled delivery.' });
      return;
    }
    const now = new Date().toISOString();
    const offeredAssignments = db
      .prepare(`SELECT id FROM delivery_assignments WHERE delivery_id = ? AND status = 'offered'`)
      .all(delivery.id) as Array<{ id: string }>;
    for (const asg of offeredAssignments) {
      clearOfferTimer(asg.id);
    }
    db.prepare(
      `UPDATE delivery_assignments SET status = 'reassigned', responded_at = ? WHERE delivery_id = ? AND status = 'offered'`
    ).run(now, delivery.id);
    db.prepare(`UPDATE delivery_requests SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(
      now,
      delivery.id
    );
    db.prepare(`UPDATE payments SET status = 'refunded' WHERE delivery_id = ?`).run(delivery.id);
    db.prepare(`
      INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
      VALUES (?, ?, 'cancelled', ?, ?, ?)
    `).run(
      `hist-${crypto.randomUUID().slice(0, 8)}`,
      delivery.id,
      req.auth!.role === 'admin' ? 'Delivery cancelled by SAQO Operations.' : 'Delivery cancelled by sender.',
      req.auth!.role,
      now
    );

    const updated = getDeliveryById(delivery.id)!;
    broadcastWsEvent('delivery:updated', updated);
    res.json({ delivery: updated });
  });

  // Client: List submitted support tickets (suggestions & complaints)
  app.get('/api/client/tickets', authenticate, (req: AuthedRequest, res) => {
    res.json({ tickets: getTicketsForReporter(req.auth!.userId) });
  });

  // Client: File complaint or suggestion ticket (deliveryId optional)
  const handleCreateTicket = (req: AuthedRequest, res: Response) => {
    const { ticketType, deliveryId, subject, details } = req.body || {};
    if (!subject || !details) {
      res.status(400).json({ error: 'Subject and details are required.' });
      return;
    }
    const normalizedType = ticketType === 'suggestion' ? 'suggestion' : 'complaint';
    const cleanDeliveryId =
      typeof deliveryId === 'string' && deliveryId.trim() ? deliveryId.trim() : null;
    if (cleanDeliveryId && !getDeliveryById(cleanDeliveryId)) {
      res.status(404).json({ error: 'Referenced delivery was not found.' });
      return;
    }
    const id = `comp-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO complaints (id, ticket_type, delivery_id, reporter_id, subject, details, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
    `).run(
      id,
      normalizedType,
      cleanDeliveryId,
      req.auth!.userId,
      String(subject).trim(),
      String(details).trim(),
      now
    );
    broadcastWsEvent('complaint:updated', {
      id,
      ticketType: normalizedType,
      deliveryId: cleanDeliveryId,
      status: 'open',
    });
    res.status(201).json({ ok: true, id, tickets: getTicketsForReporter(req.auth!.userId) });
  };
  app.post('/api/complaints', authenticate, handleCreateTicket);
  app.post('/api/tickets', authenticate, handleCreateTicket);

  // Rider: Dashboard state
  app.get('/api/rider/dashboard', authenticate, requireRole('rider'), (req: AuthedRequest, res) => {
    const rider = getRiderByProfileId(req.auth!.userId);
    if (!rider) {
      res.status(404).json({ error: 'Rider profile not found.' });
      return;
    }
    const assignments = getAssignmentsForRider(rider.riderId);
    const deliveries = listDeliveries({ riderId: rider.riderId }).map((d) => ({
      ...d,
      history: getDeliveryHistory(d.id),
    }));
    const settings = getPlatformSettings();
    const notifications = getNotificationsForUser(req.auth!.userId);
    res.json({ rider, assignments, deliveries, settings, notifications });
  });

  // Rider: Toggle Online/Offline (must have verification tick enabled by Admin to go online)
  app.patch('/api/rider/availability', authenticate, requireRole('rider'), (req: AuthedRequest, res) => {
    const rider = getRiderByProfileId(req.auth!.userId);
    if (!rider) {
      res.status(404).json({ error: 'Rider not found.' });
      return;
    }
    const isOnline = Boolean(req.body?.isOnline);
    if (isOnline && rider.verificationStatus !== 'verified') {
      res.status(403).json({
        error: 'Your rider verification tick has not been enabled by SAQO Admin yet.',
      });
      return;
    }
    db.prepare('UPDATE riders SET is_online = ? WHERE id = ?').run(isOnline ? 1 : 0, rider.riderId);
    const updated = getRiderByProfileId(req.auth!.userId)!;
    broadcastWsEvent('rider:availability', updated);
    res.json({ rider: updated });
  });

  // Rider: Update live GPS location
  app.post('/api/rider/location', authenticate, requireRole('rider'), (req: AuthedRequest, res) => {
    const rider = getRiderByProfileId(req.auth!.userId);
    if (!rider) {
      res.status(404).json({ error: 'Rider not found.' });
      return;
    }
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400).json({ error: 'Valid lat/lng coordinates are required.' });
      return;
    }
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE riders SET current_lat = ?, current_lng = ?, last_location_at = ? WHERE id = ?'
    ).run(lat, lng, now, rider.riderId);
    db.prepare(
      'INSERT INTO rider_locations (id, rider_id, lat, lng, recorded_at) VALUES (?, ?, ?, ?, ?)'
    ).run(`loc-${crypto.randomUUID().slice(0, 8)}`, rider.riderId, lat, lng, now);

    const updated = getRiderByProfileId(req.auth!.userId)!;
    broadcastWsEvent('rider:location', {
      riderId: updated.riderId,
      lat: updated.currentLat,
      lng: updated.currentLng,
      lastLocationAt: now,
    });
    res.json({ rider: updated });
  });

  // Rider: Accept or Reject an assignment offer
  app.post('/api/rider/assignments/:id/respond', authenticate, requireRole('rider'), (req: AuthedRequest, res) => {
    const rider = getRiderByProfileId(req.auth!.userId);
    if (!rider) {
      res.status(404).json({ error: 'Rider not found.' });
      return;
    }
    const assignment = db
      .prepare('SELECT * FROM delivery_assignments WHERE id = ? AND rider_id = ?')
      .get(req.params.id, rider.riderId) as any;

    if (!assignment) {
      res.status(404).json({ error: 'Assignment offer not found.' });
      return;
    }
    if (assignment.status !== 'offered') {
      res.status(400).json({ error: `Offer is already ${assignment.status}.` });
      return;
    }

    clearOfferTimer(assignment.id);
    const action = req.body?.action === 'accept' ? 'accept' : 'reject';
    if (action === 'accept' && rider.verificationStatus !== 'verified') {
      res.status(403).json({
        error: 'Your rider verification tick must be active to accept deliveries.',
      });
      return;
    }
    const now = new Date().toISOString();

    if (action === 'accept') {
      db.prepare(
        `UPDATE delivery_assignments SET status = 'accepted', responded_at = ? WHERE id = ?`
      ).run(now, assignment.id);
      db.prepare(
        `UPDATE delivery_requests SET status = 'accepted', assigned_rider_id = ?, updated_at = ? WHERE id = ?`
      ).run(rider.riderId, now, assignment.delivery_id);
      db.prepare(`
        INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
        VALUES (?, ?, 'accepted', ?, 'rider', ?)
      `).run(
        `hist-${crypto.randomUUID().slice(0, 8)}`,
        assignment.delivery_id,
        `${rider.fullName} accepted the delivery request.`,
        now
      );

      const updated = getDeliveryById(assignment.delivery_id)!;
      const custRow = db
        .prepare('SELECT profile_id FROM customers WHERE id = ?')
        .get(updated.customerId) as { profile_id: string } | undefined;
      if (custRow) {
        const notif = createNotification(
          custRow.profile_id,
          'Rider Assigned',
          `${rider.fullName} (${rider.vehicleType}) accepted parcel ${updated.trackingCode} and is heading for pickup.`,
          updated.id
        );
        broadcastWsEvent('notification:created', notif);
      }

      broadcastWsEvent('assignment:updated', { id: assignment.id, status: 'accepted' });
      broadcastWsEvent('delivery:updated', updated);
      res.json({ ok: true, delivery: updated });
      return;
    }

    // Rejected -> automatically cascade to next eligible rider!
    db.prepare(
      `UPDATE delivery_assignments SET status = 'rejected', responded_at = ? WHERE id = ?`
    ).run(now, assignment.id);
    db.prepare(`
      INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
      VALUES (?, ?, 'pending_dispatch', ?, 'rider', ?)
    `).run(
      `hist-${crypto.randomUUID().slice(0, 8)}`,
      assignment.delivery_id,
      `${rider.fullName} declined the offer. Re-running smart dispatch for next rider.`,
      now
    );
    broadcastWsEvent('assignment:updated', { id: assignment.id, status: 'rejected' });
    const nextResult = dispatchNextRiderForDelivery(assignment.delivery_id);
    res.json({ ok: true, nextDispatch: nextResult });
  });

  // Rider: Advance delivery status
  app.patch('/api/rider/deliveries/:id/status', authenticate, requireRole('rider'), (req: AuthedRequest, res) => {
    const rider = getRiderByProfileId(req.auth!.userId);
    const delivery = getDeliveryById(req.params.id);
    if (!rider || !delivery || delivery.assignedRiderId !== rider.riderId) {
      res.status(404).json({ error: 'Assigned delivery not found.' });
      return;
    }

    if (['delivered', 'cancelled'].includes(delivery.status)) {
      res.status(400).json({ error: 'This parcel is already finalized and cannot be updated.' });
      return;
    }

    const allowedStatuses: DeliveryStatus[] = [
      'accepted',
      'heading_to_pickup',
      'parcel_picked_up',
      'in_transit',
      'arrived_at_destination',
      'delivered',
    ];
    const nextStatus = req.body?.status as DeliveryStatus;
    if (!allowedStatuses.includes(nextStatus)) {
      res.status(400).json({ error: 'Invalid delivery status transition.' });
      return;
    }

    if (nextStatus === 'delivered') {
      const providedOtp = String(req.body?.otp || '').trim();
      if (!matchesDeliveryOtp(providedOtp, delivery.deliveryOtp)) {
        res.status(400).json({
          error: 'Invalid recipient OTP. Enter the 4-digit delivery code from the customer or recipient.',
        });
        return;
      }
    }

    const now = new Date().toISOString();
    const note =
      req.body?.note ||
      (nextStatus === 'delivered'
        ? `Parcel delivered and verified with 4-digit OTP (${delivery.deliveryOtp}).`
        : `Rider updated parcel status to ${nextStatus.replace(/_/g, ' ')}.`);

    if (nextStatus === 'delivered') {
      db.prepare(
        'UPDATE delivery_requests SET status = ?, otp_verified = 1, updated_at = ? WHERE id = ?'
      ).run(nextStatus, now, delivery.id);
    } else {
      db.prepare('UPDATE delivery_requests SET status = ?, updated_at = ? WHERE id = ?').run(
        nextStatus,
        now,
        delivery.id
      );
    }
    db.prepare(`
      INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
      VALUES (?, ?, ?, ?, 'rider', ?)
    `).run(`hist-${crypto.randomUUID().slice(0, 8)}`, delivery.id, nextStatus, note, now);

    // Move rider marker closer to destination as delivery progresses
    if (nextStatus === 'heading_to_pickup') {
      db.prepare('UPDATE riders SET current_lat = ?, current_lng = ?, last_location_at = ? WHERE id = ?').run(
        Number(((rider.currentLat + delivery.pickupLat) / 2).toFixed(5)),
        Number(((rider.currentLng + delivery.pickupLng) / 2).toFixed(5)),
        now,
        rider.riderId
      );
    } else if (nextStatus === 'parcel_picked_up') {
      db.prepare('UPDATE riders SET current_lat = ?, current_lng = ?, last_location_at = ? WHERE id = ?').run(
        delivery.pickupLat,
        delivery.pickupLng,
        now,
        rider.riderId
      );
    } else if (nextStatus === 'in_transit') {
      db.prepare('UPDATE riders SET current_lat = ?, current_lng = ?, last_location_at = ? WHERE id = ?').run(
        Number(((delivery.pickupLat + delivery.destinationLat) / 2).toFixed(5)),
        Number(((delivery.pickupLng + delivery.destinationLng) / 2).toFixed(5)),
        now,
        rider.riderId
      );
    } else if (nextStatus === 'arrived_at_destination' || nextStatus === 'delivered') {
      db.prepare('UPDATE riders SET current_lat = ?, current_lng = ?, last_location_at = ? WHERE id = ?').run(
        delivery.destinationLat,
        delivery.destinationLng,
        now,
        rider.riderId
      );
    }

    if (nextStatus === 'delivered') {
      db.prepare(`UPDATE payments SET status = 'settled' WHERE delivery_id = ?`).run(delivery.id);
      const payment = db
        .prepare('SELECT rider_payout_ngn FROM payments WHERE delivery_id = ?')
        .get(delivery.id) as { rider_payout_ngn: number } | undefined;
      db.prepare(`
        UPDATE riders
        SET completed_deliveries_count = completed_deliveries_count + 1,
            total_earnings_ngn = total_earnings_ngn + ?
        WHERE id = ?
      `).run(payment?.rider_payout_ngn || 0, rider.riderId);
    }

    const custRow = db
      .prepare('SELECT profile_id FROM customers WHERE id = ?')
      .get(delivery.customerId) as { profile_id: string } | undefined;
    if (custRow) {
      let notifTitle = `${delivery.trackingCode}: ${nextStatus.replace(/_/g, ' ')}`;
      if (nextStatus === 'parcel_picked_up') {
        notifTitle = 'Parcel Picked Up';
      } else if (nextStatus === 'in_transit' || nextStatus === 'arrived_at_destination') {
        notifTitle = 'Out for Delivery';
      } else if (nextStatus === 'delivered') {
        notifTitle = 'Parcel Delivered';
      }
      const notif = createNotification(
        custRow.profile_id,
        notifTitle,
        `${delivery.trackingCode}: ${note}`,
        delivery.id
      );
      broadcastWsEvent('notification:created', notif);
    }

    const updated = getDeliveryById(delivery.id)!;
    broadcastWsEvent('delivery:updated', updated);
    res.json({ delivery: updated, history: getDeliveryHistory(delivery.id) });
  });

  // Admin: Full operational overview
  app.get('/api/admin/overview', authenticate, requireRole('admin'), (_req, res) => {
    const deliveries = listDeliveries().map((d) => ({
      ...d,
      history: getDeliveryHistory(d.id),
    }));
    const riders = getAllRiders();
    const customers = getAllCustomers();
    const payments = getAllPayments();
    const complaints = getAllComplaints();
    const settings = getPlatformSettings();

    res.json({
      deliveries,
      riders,
      customers,
      payments,
      complaints,
      settings,
    });
  });

  // Admin: Manually assign or reassign rider
  app.post('/api/admin/deliveries/:id/assign', authenticate, requireRole('admin'), (req, res) => {
    const { riderId } = req.body || {};
    const delivery = getDeliveryById(req.params.id);
    if (!delivery) {
      res.status(404).json({ error: 'Delivery not found.' });
      return;
    }
    const rider = getAllRiders().find((r) => r.riderId === riderId);
    if (!rider) {
      res.status(404).json({ error: 'Rider not found.' });
      return;
    }
    if (rider.accountStatus === 'suspended' || rider.verificationStatus !== 'verified') {
      res.status(400).json({ error: 'Cannot assign a suspended or unverified rider.' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE delivery_assignments SET status = 'reassigned', responded_at = ? WHERE delivery_id = ? AND status = 'offered'`
    ).run(now, delivery.id);

    db.prepare(`
      INSERT INTO delivery_assignments (
        id, delivery_id, rider_id, status, score, distance_to_pickup_km,
        route_compatibility_score, offered_at, expires_at, responded_at
      ) VALUES (?, ?, ?, 'accepted', 0, 0, 1.0, ?, ?, ?)
    `).run(`asg-${crypto.randomUUID().slice(0, 8)}`, delivery.id, rider.riderId, now, now, now);

    db.prepare(`
      UPDATE delivery_requests
      SET assigned_rider_id = ?, status = CASE WHEN status IN ('pending_dispatch', 'no_rider_available') THEN 'assigned' ELSE status END, updated_at = ?
      WHERE id = ?
    `).run(rider.riderId, now, delivery.id);

    db.prepare(`
      INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
      VALUES (?, ?, 'assigned', ?, 'admin', ?)
    `).run(
      `hist-${crypto.randomUUID().slice(0, 8)}`,
      delivery.id,
      `Admin manually assigned delivery to ${rider.fullName}.`,
      now
    );

    const custRow = db
      .prepare('SELECT profile_id FROM customers WHERE id = ?')
      .get(delivery.customerId) as { profile_id: string } | undefined;
    if (custRow) {
      const cNotif = createNotification(
        custRow.profile_id,
        'Rider Assigned',
        `${rider.fullName} (${rider.vehicleType}) has been assigned to parcel ${delivery.trackingCode}.`,
        delivery.id
      );
      broadcastWsEvent('notification:created', cNotif);
    }

    const rNotif = createNotification(
      rider.id,
      'New Delivery Request Available',
      `Admin assigned ${delivery.trackingCode}: ${delivery.pickupAddress}, ${delivery.pickupState} → ${delivery.destinationAddress}, ${delivery.destinationState}.`,
      delivery.id
    );
    broadcastWsEvent('notification:created', rNotif);

    const updated = getDeliveryById(delivery.id)!;
    broadcastWsEvent('delivery:updated', updated);
    res.json({ delivery: updated });
  });

  // Admin: Override or update delivery status for operational resolution
  app.patch('/api/admin/deliveries/:id/status', authenticate, requireRole('admin'), (req, res) => {
    const delivery = getDeliveryById(req.params.id);
    if (!delivery) {
      res.status(404).json({ error: 'Delivery not found.' });
      return;
    }
    const allowed: DeliveryStatus[] = [
      'pending_dispatch',
      'no_rider_available',
      'assigned',
      'accepted',
      'heading_to_pickup',
      'parcel_picked_up',
      'in_transit',
      'arrived_at_destination',
      'delivered',
      'cancelled',
    ];
    const nextStatus = req.body?.status as DeliveryStatus;
    if (!allowed.includes(nextStatus)) {
      res.status(400).json({ error: 'Invalid delivery status.' });
      return;
    }

    const now = new Date().toISOString();
    const note =
      typeof req.body?.note === 'string' && req.body.note.trim()
        ? req.body.note.trim()
        : `SAQO Operations updated status to ${nextStatus.replace(/_/g, ' ')}.`;

    const wasDelivered = delivery.status === 'delivered';
    db.prepare('UPDATE delivery_requests SET status = ?, updated_at = ? WHERE id = ?').run(
      nextStatus,
      now,
      delivery.id
    );
    db.prepare(`
      INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
      VALUES (?, ?, ?, ?, 'admin', ?)
    `).run(`hist-${crypto.randomUUID().slice(0, 8)}`, delivery.id, nextStatus, note, now);

    if (nextStatus === 'delivered' && !wasDelivered) {
      db.prepare(`UPDATE payments SET status = 'settled' WHERE delivery_id = ?`).run(delivery.id);
      if (delivery.assignedRiderId) {
        const payment = db
          .prepare('SELECT rider_payout_ngn FROM payments WHERE delivery_id = ?')
          .get(delivery.id) as { rider_payout_ngn: number } | undefined;
        db.prepare(`
          UPDATE riders
          SET completed_deliveries_count = completed_deliveries_count + 1,
              total_earnings_ngn = total_earnings_ngn + ?
          WHERE id = ?
        `).run(payment?.rider_payout_ngn || 0, delivery.assignedRiderId);
      }
    } else if (nextStatus === 'cancelled') {
      const offered = db
        .prepare(`SELECT id FROM delivery_assignments WHERE delivery_id = ? AND status = 'offered'`)
        .all(delivery.id) as Array<{ id: string }>;
      offered.forEach((asg) => clearOfferTimer(asg.id));
      db.prepare(
        `UPDATE delivery_assignments SET status = 'reassigned', responded_at = ? WHERE delivery_id = ? AND status = 'offered'`
      ).run(now, delivery.id);
      db.prepare(`UPDATE payments SET status = 'refunded' WHERE delivery_id = ?`).run(delivery.id);
    }

    const custRow = db
      .prepare('SELECT profile_id FROM customers WHERE id = ?')
      .get(delivery.customerId) as { profile_id: string } | undefined;
    if (custRow) {
      const notif = createNotification(
        custRow.profile_id,
        `${delivery.trackingCode}: Status Updated`,
        note,
        delivery.id
      );
      broadcastWsEvent('notification:created', notif);
    }

    const updated = { ...getDeliveryById(delivery.id)!, history: getDeliveryHistory(delivery.id) };
    broadcastWsEvent('delivery:updated', updated);
    res.json({ delivery: updated });
  });

  // Admin: Issue a new Rider account
  app.post('/api/admin/riders', authenticate, requireRole('admin'), (req, res) => {
    const {
      fullName,
      phone,
      email,
      password,
      homeState,
      vehicleType,
      plateNumber,
      verificationStatus,
    } = req.body || {};

    if (!fullName || !phone || !email || !password || !plateNumber) {
      res.status(400).json({
        error: 'Full name, phone, email, password, and plate number are required.',
      });
      return;
    }
    const phoneDigits = String(phone).replace(/\D/g, '');
    if (phoneDigits.length < 10) {
      res.status(400).json({ error: 'Please enter a valid phone number (at least 10 digits).' });
      return;
    }
    if (String(password).length < 6) {
      res.status(400).json({ error: 'Initial password must be at least 6 characters.' });
      return;
    }
    const cleanEmail = String(email).trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM profiles WHERE LOWER(email) = ?').get(cleanEmail);
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const validVehicles = ['Motorcycle', 'Van', 'Inter-State Sprinter'];
    const cleanVehicle = validVehicles.includes(vehicleType) ? vehicleType : 'Motorcycle';
    const cleanState = homeState || 'Katsina';
    const cleanVerify = verificationStatus === 'verified' ? 'verified' : 'pending';
    const hub = findStateHub(cleanState);
    const now = new Date().toISOString();
    const profileId = `prof-${crypto.randomUUID().slice(0, 8)}`;
    const riderId = `rider-${crypto.randomUUID().slice(0, 8)}`;
    const passHash = hashPassword(String(password));

    db.prepare(`
      INSERT INTO profiles (id, email, password_hash, full_name, phone, role, account_status, created_at)
      VALUES (?, ?, ?, ?, ?, 'rider', 'active', ?)
    `).run(profileId, cleanEmail, passHash, String(fullName).trim(), String(phone).trim(), now);

    db.prepare(`
      INSERT INTO riders (
        id, profile_id, vehicle_type, plate_number, home_state, verification_status,
        is_online, current_lat, current_lng, last_location_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      riderId,
      profileId,
      cleanVehicle,
      String(plateNumber).trim().toUpperCase(),
      cleanState,
      cleanVerify,
      hub.lat,
      hub.lng,
      now
    );

    const created = getRiderByProfileId(profileId)!;
    broadcastWsEvent('rider:availability', created);
    res.status(201).json({ rider: created, riders: getAllRiders() });
  });

  // Admin: Update rider vehicle/state/contact info
  app.patch('/api/admin/riders/:id', authenticate, requireRole('admin'), (req, res) => {
    const existing = getAllRiders().find((r) => r.riderId === req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Rider not found.' });
      return;
    }
    const { fullName, phone, homeState, vehicleType, plateNumber } = req.body || {};
    if (phone && String(phone).replace(/\D/g, '').length < 10) {
      res.status(400).json({ error: 'Please enter a valid phone number (at least 10 digits).' });
      return;
    }
    const validVehicles = ['Motorcycle', 'Van', 'Inter-State Sprinter'];
    const nextVehicle = validVehicles.includes(vehicleType) ? vehicleType : existing.vehicleType;
    const nextState = homeState || existing.homeState;
    const nextPlate = plateNumber ? String(plateNumber).trim().toUpperCase() : existing.plateNumber;
    const nextName = fullName ? String(fullName).trim() : existing.fullName;
    const nextPhone = phone ? String(phone).trim() : existing.phone;

    db.prepare(`UPDATE profiles SET full_name = ?, phone = ? WHERE id = ?`).run(
      nextName,
      nextPhone,
      existing.id
    );
    db.prepare(
      `UPDATE riders SET vehicle_type = ?, plate_number = ?, home_state = ? WHERE id = ?`
    ).run(nextVehicle, nextPlate, nextState, existing.riderId);

    const updated = getRiderByProfileId(existing.id)!;
    broadcastWsEvent('rider:availability', updated);
    res.json({ rider: updated, riders: getAllRiders() });
  });

  // Admin: Enable or revoke rider verification tick
  app.patch('/api/admin/riders/:id/verify', authenticate, requireRole('admin'), (req, res) => {
    const status = req.body?.verificationStatus;
    if (!['verified', 'pending', 'rejected'].includes(status)) {
      res.status(400).json({ error: 'Invalid verification status.' });
      return;
    }
    const rider = getAllRiders().find((r) => r.riderId === req.params.id);
    if (!rider) {
      res.status(404).json({ error: 'Rider not found.' });
      return;
    }
    if (status === 'verified') {
      db.prepare('UPDATE riders SET verification_status = ? WHERE id = ?').run(status, req.params.id);
    } else {
      db.prepare('UPDATE riders SET verification_status = ?, is_online = 0 WHERE id = ?').run(
        status,
        req.params.id
      );
    }

    const updatedRider = getRiderByProfileId(rider.id)!;
    const notif = createNotification(
      rider.id,
      status === 'verified' ? 'Verification Tick Enabled' : 'Verification Status Updated',
      status === 'verified'
        ? 'Your SAQO rider verification tick is now active. You can go online and accept deliveries.'
        : `Your rider verification status is now set to ${status}. Contact SAQO Operations for details.`,
      null
    );
    broadcastWsEvent('notification:created', notif);
    broadcastWsEvent('rider:availability', updatedRider);
    res.json({ rider: updatedRider, riders: getAllRiders() });
  });

  // Admin: Suspend or activate account (customer or rider)
  app.patch('/api/admin/profiles/:id/status', authenticate, requireRole('admin'), (req, res) => {
    const status = req.body?.accountStatus;
    if (!['active', 'suspended'].includes(status)) {
      res.status(400).json({ error: 'Invalid account status.' });
      return;
    }
    db.prepare('UPDATE profiles SET account_status = ? WHERE id = ?').run(status, req.params.id);
    if (status === 'suspended') {
      db.prepare('UPDATE riders SET is_online = 0 WHERE profile_id = ?').run(req.params.id);
    }
    res.json({ ok: true });
  });

  // Admin: Reset password for a rider or customer account
  app.patch('/api/admin/profiles/:id/reset-password', authenticate, requireRole('admin'), (req, res) => {
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (newPassword.length < 6) {
      res.status(400).json({ error: 'New password must be at least 6 characters.' });
      return;
    }
    const target = getProfileById(req.params.id);
    if (!target) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    if (target.role === 'admin') {
      res.status(403).json({ error: 'Admin password cannot be reset via this endpoint.' });
      return;
    }
    db.prepare('UPDATE profiles SET password_hash = ? WHERE id = ?').run(
      hashPassword(newPassword),
      target.id
    );
    res.json({ ok: true });
  });

  // Admin: Update platform settings
  app.patch('/api/admin/settings', authenticate, requireRole('admin'), (req, res) => {
    const current = getPlatformSettings();
    const b = req.body || {};
    const next = {
      maxActiveParcelsPerRider: Math.max(1, Number(b.maxActiveParcelsPerRider ?? current.maxActiveParcelsPerRider)),
      searchRadiusKm: Math.max(5, Number(b.searchRadiusKm ?? current.searchRadiusKm)),
      offerTimeoutSeconds: Math.max(10, Number(b.offerTimeoutSeconds ?? current.offerTimeoutSeconds)),
      baseLocalFeeNgn: Math.max(300, Number(b.baseLocalFeeNgn ?? current.baseLocalFeeNgn)),
      perKmRateNgn: Math.max(10, Number(b.perKmRateNgn ?? current.perKmRateNgn)),
      interStateSurchargeNgn: Math.max(0, Number(b.interStateSurchargeNgn ?? current.interStateSurchargeNgn)),
      riderCommissionPercent: Math.min(95, Math.max(40, Number(b.riderCommissionPercent ?? current.riderCommissionPercent))),
      whatsappSupportNumber: String(b.whatsappSupportNumber ?? current.whatsappSupportNumber).replace(/[^\d]/g, ''),
    };

    db.prepare(`
      UPDATE platform_settings SET
        max_active_parcels_per_rider = ?,
        search_radius_km = ?,
        offer_timeout_seconds = ?,
        base_local_fee_ngn = ?,
        per_km_rate_ngn = ?,
        inter_state_surcharge_ngn = ?,
        rider_commission_percent = ?,
        whatsapp_support_number = ?
      WHERE id = 1
    `).run(
      next.maxActiveParcelsPerRider,
      next.searchRadiusKm,
      next.offerTimeoutSeconds,
      next.baseLocalFeeNgn,
      next.perKmRateNgn,
      next.interStateSurchargeNgn,
      next.riderCommissionPercent,
      next.whatsappSupportNumber
    );

    broadcastWsEvent('settings:updated', next);
    res.json({ settings: next });
  });

  // Admin: Resolve / update complaint or suggestion ticket & notify reporter
  app.patch('/api/admin/complaints/:id', authenticate, requireRole('admin'), (req, res) => {
    const { status, resolutionNote } = req.body || {};
    if (!['open', 'investigating', 'resolved'].includes(status)) {
      res.status(400).json({ error: 'Invalid ticket status.' });
      return;
    }
    const existing = getAllComplaints().find((c) => c.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Ticket not found.' });
      return;
    }
    db.prepare('UPDATE complaints SET status = ?, resolution_note = ? WHERE id = ?').run(
      status,
      resolutionNote || null,
      req.params.id
    );
    const notif = createNotification(
      existing.reporterId,
      `Ticket ${status === 'resolved' ? 'Resolved' : 'Updated'}`,
      `${existing.subject}: ${resolutionNote || `Status updated to ${status}.`}`,
      existing.deliveryId
    );
    broadcastWsEvent('notification:created', notif);
    broadcastWsEvent('complaint:updated', { id: req.params.id, status });
    res.json({ complaints: getAllComplaints() });
  });

  // --- Live Persistent Support Chat API ---

  // Public: Admin online presence
  app.get('/api/support/presence', (_req, res) => {
    res.json(getSupportPresence());
  });

  // Visitor / Client: List persistent conversations
  app.get('/api/support/conversations', (req, res) => {
    const auth = tryAuthenticate(req);
    const visitorToken =
      typeof req.query.visitorToken === 'string' ? req.query.visitorToken.trim() : null;
    if (!auth && !visitorToken) {
      res.json({ conversations: [], presence: getSupportPresence() });
      return;
    }
    const conversations = getSupportConversationsForVisitor({
      visitorToken,
      userId: auth?.userId || null,
    });
    res.json({ conversations, presence: getSupportPresence() });
  });

  // Visitor / Client: Start new persistent support conversation
  app.post('/api/support/conversations', (req, res) => {
    const auth = tryAuthenticate(req);
    const profile = auth ? getProfileById(auth.userId) : null;
    const {
      visitorToken,
      visitorName,
      visitorEmail,
      visitorPhone,
      trackingCode,
      message,
    } = req.body || {};

    const cleanToken = typeof visitorToken === 'string' ? visitorToken.trim() : '';
    const cleanName = (profile?.fullName || visitorName || '').trim();
    const cleanMsg = typeof message === 'string' ? message.trim() : '';

    if (!cleanToken) {
      res.status(400).json({ error: 'Chat session token is required.' });
      return;
    }
    if (!cleanName) {
      res.status(400).json({ error: 'Please enter your name to start chatting.' });
      return;
    }
    if (!cleanMsg) {
      res.status(400).json({ error: 'Please enter a message.' });
      return;
    }

    const created = createSupportConversation({
      visitorToken: cleanToken,
      userId: profile?.id || null,
      visitorName: cleanName,
      visitorEmail: profile?.email || visitorEmail || null,
      visitorPhone: profile?.phone || visitorPhone || null,
      trackingCode: trackingCode || null,
      initialMessage: cleanMsg,
      senderRole: profile ? 'client' : 'visitor',
    });

    broadcastWsEvent('support:conversation', created.conversation);
    broadcastWsEvent('support:message', created.message);
    res.status(201).json({
      conversation: created.conversation,
      message: created.message,
      messages: [created.message],
      presence: getSupportPresence(),
    });
  });

  // Visitor / Client: Load conversation messages (never auto-deleted)
  app.get('/api/support/conversations/:id/messages', (req, res) => {
    const auth = tryAuthenticate(req);
    const visitorToken =
      typeof req.query.visitorToken === 'string' ? req.query.visitorToken.trim() : '';
    const conv = getSupportConversationById(req.params.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    const isOwner =
      (auth && (auth.role === 'admin' || conv.userId === auth.userId)) ||
      (visitorToken && conv.visitorToken === visitorToken);
    if (!isOwner) {
      res.status(403).json({ error: 'Access denied for this conversation.' });
      return;
    }
    const updatedConv =
      auth?.role === 'admin'
        ? conv
        : markSupportConversationRead(conv.id, 'visitor') || conv;
    res.json({
      conversation: updatedConv,
      messages: getSupportMessages(conv.id),
      presence: getSupportPresence(),
    });
  });

  // Visitor / Client: Send message in existing conversation
  app.post('/api/support/conversations/:id/messages', (req, res) => {
    const auth = tryAuthenticate(req);
    const profile = auth ? getProfileById(auth.userId) : null;
    const { visitorToken, body } = req.body || {};
    const conv = getSupportConversationById(req.params.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    const isOwner =
      (auth && conv.userId === auth.userId) ||
      (typeof visitorToken === 'string' && visitorToken.trim() === conv.visitorToken);
    if (!isOwner) {
      res.status(403).json({ error: 'Access denied for this conversation.' });
      return;
    }
    const cleanBody = typeof body === 'string' ? body.trim() : '';
    if (!cleanBody) {
      res.status(400).json({ error: 'Message cannot be empty.' });
      return;
    }

    const result = addSupportMessage({
      conversationId: conv.id,
      senderRole: profile ? 'client' : 'visitor',
      senderName: profile?.fullName || conv.visitorName,
      body: cleanBody,
    });
    broadcastWsEvent('support:message', result.message);
    broadcastWsEvent('support:conversation', result.conversation);
    res.status(201).json({
      conversation: result.conversation,
      message: result.message,
    });
  });

  // Visitor / Client: Mark conversation read
  app.post('/api/support/conversations/:id/read', (req, res) => {
    const auth = tryAuthenticate(req);
    const visitorToken =
      typeof req.body?.visitorToken === 'string' ? req.body.visitorToken.trim() : '';
    const conv = getSupportConversationById(req.params.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    const isOwner =
      (auth && conv.userId === auth.userId) ||
      (visitorToken && visitorToken === conv.visitorToken);
    if (!isOwner) {
      res.status(403).json({ error: 'Access denied.' });
      return;
    }
    const updated = markSupportConversationRead(conv.id, 'visitor');
    if (updated) {
      broadcastWsEvent('support:conversation', updated);
    }
    res.json({ conversation: updated });
  });

  // Visitor / Client: Resolve or reopen own conversation
  app.patch('/api/support/conversations/:id/status', (req, res) => {
    const auth = tryAuthenticate(req);
    const profile = auth ? getProfileById(auth.userId) : null;
    const { visitorToken, status } = req.body || {};
    if (!['open', 'resolved'].includes(status)) {
      res.status(400).json({ error: 'Invalid status.' });
      return;
    }
    const conv = getSupportConversationById(req.params.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    const isOwner =
      (auth && conv.userId === auth.userId) ||
      (typeof visitorToken === 'string' && visitorToken.trim() === conv.visitorToken);
    if (!isOwner) {
      res.status(403).json({ error: 'Access denied.' });
      return;
    }
    const updated = updateSupportConversationStatus(
      conv.id,
      status as SupportConversationStatus,
      profile?.fullName || conv.visitorName
    );
    if (updated) {
      broadcastWsEvent('support:message', updated.systemMessage);
      broadcastWsEvent('support:conversation', updated.conversation);
    }
    res.json(updated);
  });

  // Admin: List all support conversations + presence state
  app.get('/api/admin/support/conversations', authenticate, requireRole('admin'), (_req, res) => {
    res.json({
      conversations: getAllSupportConversations(),
      presence: getSupportPresence(),
      adminAcceptingChats: isAdminChatAvailableFlag(),
    });
  });

  // Admin: Toggle online/away availability for live support chat
  app.post('/api/admin/support/presence', authenticate, requireRole('admin'), (req, res) => {
    const available = Boolean(req.body?.available);
    const presence = setAdminChatAvailability(available);
    res.json({ presence, adminAcceptingChats: isAdminChatAvailableFlag() });
  });

  // Admin: Load messages for a conversation & mark read
  app.get('/api/admin/support/conversations/:id/messages', authenticate, requireRole('admin'), (req, res) => {
    const conv = getSupportConversationById(req.params.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    const updatedConv = markSupportConversationRead(conv.id, 'admin') || conv;
    broadcastWsEvent('support:conversation', updatedConv);
    res.json({
      conversation: updatedConv,
      messages: getSupportMessages(conv.id),
    });
  });

  // Admin: Send reply message in a support conversation
  app.post('/api/admin/support/conversations/:id/messages', authenticate, requireRole('admin'), (req: AuthedRequest, res) => {
    const adminProfile = getProfileById(req.auth!.userId);
    const conv = getSupportConversationById(req.params.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    const cleanBody = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!cleanBody) {
      res.status(400).json({ error: 'Reply message cannot be empty.' });
      return;
    }
    const result = addSupportMessage({
      conversationId: conv.id,
      senderRole: 'admin',
      senderName: adminProfile?.fullName || 'SAQO Support Agent',
      body: cleanBody,
      assignedAdminId: req.auth!.userId,
    });
    if (conv.userId) {
      const notif = createNotification(
        conv.userId,
        'New Support Reply',
        `SAQO Support: ${cleanBody.slice(0, 120)}`,
        null
      );
      broadcastWsEvent('notification:created', notif);
    }
    broadcastWsEvent('support:message', result.message);
    broadcastWsEvent('support:conversation', result.conversation);
    res.status(201).json(result);
  });

  // Admin: Update support conversation status (open | pending | resolved | closed)
  app.patch('/api/admin/support/conversations/:id', authenticate, requireRole('admin'), (req: AuthedRequest, res) => {
    const { status } = req.body || {};
    if (!['open', 'pending', 'resolved', 'closed'].includes(status)) {
      res.status(400).json({ error: 'Invalid conversation status.' });
      return;
    }
    const adminProfile = getProfileById(req.auth!.userId);
    const result = updateSupportConversationStatus(
      req.params.id,
      status as SupportConversationStatus,
      adminProfile?.fullName || 'SAQO Support'
    );
    if (!result) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    broadcastWsEvent('support:message', result.systemMessage);
    broadcastWsEvent('support:conversation', result.conversation);
    res.json(result);
  });

  // Vite / Static Middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        allowedHosts: true,
        ws: { server, path: '/vite-hmr' },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SAQO Logistics server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start SAQO server:', err);
  process.exit(1);
});
