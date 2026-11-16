// Shared SAQO API route registration for Node Express and Supabase Edge Functions.
import { createBookingRows } from './deliveryBooking';
import { checkLoginThrottle } from './loginThrottle';
import { sendOpsAlert } from './opsAlerts';
import { getWhatsAppOrderNumber, registerTwilioWhatsAppWebhook, sendWhatsAppSupportReply } from './whatsapp';
import crypto from 'node:crypto';
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
  publicTrackingDelivery,
  publicTrackingHistory,
  getDeliveryHistory,
  riderDelivery,
  getNotificationsForUser,
  getPlatformSettings,
  getProfileById,
  getRiderByProfileId,
  getSupportConversationById,
  getSupportConversationsForVisitor,
  getSupportMessages,
  getTicketsForReporter,
  hashPassword,
  listDeliveries,
  markSupportConversationRead,
  persistDispatchChange,
  signSessionToken,
  updateSupportConversationStatus,
  verifyPassword,
  verifySessionToken,
} from './db';
import {
  broadcastWsEvent,
  clearOfferTimer,
  canDispatch,
  dispatchWaitingDeliveries,
  dispatchNextRiderForDelivery,
  expireTimedOutOffers,
  getSupportPresenceAsync,
  isAdminChatAvailableFlagAsync,
  setAdminChatAvailability,
} from './dispatchEngine';
import { findStateHub, resolveAddressCoordinates } from '../shared/nigeria';
import {
  calculateDeliveryQuote,
  isValidNigerianPhone,
  matchesDeliveryOtp,
} from '../shared/pricing';
import type { DeliveryStatus, PaymentMethodCode, SupportConversationStatus, UserRole } from '../shared/types';
import type { NextFn, RouteHandler, SaqoApp, SaqoRequest, SaqoResponse } from './webApp';
import {
  adjustWalletAtomic,
  cancelDeliveryPayments,
  confirmFlutterwaveTransaction,
  confirmRiderCashCollection,
  createDeliveryPaymentRecords,
  ensureWallet,
  exportPaymentsCsv,
  getAdminPaymentsOverview,
  getCustomerWalletSummary,
  getGatewayAdminView,
  getGatewayPublicConfig,
  getPaymentTransactionByKey,
  reuseFlutterwaveCheckout,
  getWalletAuditLogs,
  initializeDeliveryFlutterwavePayment,
  initializeWalletFunding,
  InsufficientWalletBalanceError,
  payDeliveryWithWallet,
  PaymentConfigError,
  PaymentVerificationError,
  processAdminRefund,
  refreshFlutterwaveRefund,
  processFlutterwaveWebhook,
  reconcileCashOrBankCollection,
  submitBankTransferProof,
  updateGatewaySettings,
} from './paymentService';

interface AuthedRequest extends SaqoRequest {
  auth?: { userId: string; role: UserRole };
}

const authenticate = asyncRoute(async (req: AuthedRequest, res: SaqoResponse, next: NextFn): Promise<void> => {
  const header = req.get('authorization');
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
  const profile = await getProfileById(payload.userId);
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
});

function requireRole(...roles: UserRole[]) {
  return (req: AuthedRequest, res: SaqoResponse, next: NextFn): void => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      res.status(403).json({ error: 'Insufficient permissions for this action.' });
      return;
    }
    next();
  };
}

async function tryAuthenticate(req: SaqoRequest): Promise<{ userId: string; role: UserRole } | null> {
  const header = req.get('authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  const payload = verifySessionToken(token);
  if (!payload) return null;
  const profile = await getProfileById(payload.userId);
  if (!profile || profile.accountStatus === 'suspended') return null;
  return { userId: profile.id, role: profile.role };
}

function isValidNigeriaCoordPair(lat: unknown, lng: unknown): boolean {
  const nLat = Number(lat);
  const nLng = Number(lng);
  return (
    Number.isFinite(nLat) &&
    Number.isFinite(nLng) &&
    nLat >= 4.0 &&
    nLat <= 14.5 &&
    nLng >= 2.0 &&
    nLng <= 15.0
  );
}

type OtpAttemptScope =
  | { type: 'rider'; actorId: string }
  | { type: 'public'; ip: string };

async function verifyHandoffOtp(
  res: SaqoResponse,
  delivery: { id: string; deliveryOtp: string },
  otp: unknown,
  scope: OtpAttemptScope = { type: 'rider', actorId: 'legacy' }
): Promise<boolean> {
  const cleanOtp = typeof otp === 'string' ? otp.trim() : '';
  if (!/^\d{4}$/.test(cleanOtp)) {
    res.status(400).json({
      error: 'Enter the exact 4-digit delivery OTP from the recipient before completing delivery.',
      code: 'OTP_INVALID_FORMAT',
    });
    return false;
  }

  const now = Date.now();
  const resetAt = now + 15 * 60 * 1000;
  const publicBucket =
    scope.type === 'public'
      ? `otp:public:${crypto.createHash('sha256').update(`${delivery.id}\0${scope.ip || 'unknown'}`).digest('hex').slice(0, 32)}`
      : null;

  const attempt = publicBucket
    ? ((await db.prepare(`
        INSERT INTO login_attempts (bucket, attempts, reset_at) VALUES (?, 1, ?)
        ON CONFLICT(bucket) DO UPDATE SET
          attempts = CASE WHEN login_attempts.reset_at <= ? THEN 1 ELSE login_attempts.attempts + 1 END,
          reset_at = CASE WHEN login_attempts.reset_at <= ? THEN excluded.reset_at ELSE login_attempts.reset_at END
        RETURNING attempts, reset_at
      `).get(publicBucket, resetAt, now, now)) as { attempts: number; reset_at: number })
    : ((await db.prepare(`
        INSERT INTO delivery_otp_attempts (delivery_id, attempts, reset_at) VALUES (?, 1, ?)
        ON CONFLICT(delivery_id) DO UPDATE SET
          attempts = CASE WHEN delivery_otp_attempts.reset_at <= ? THEN 1 ELSE delivery_otp_attempts.attempts + 1 END,
          reset_at = CASE WHEN delivery_otp_attempts.reset_at <= ? THEN excluded.reset_at ELSE delivery_otp_attempts.reset_at END
        RETURNING attempts, reset_at
      `).get(delivery.id, resetAt, now, now)) as { attempts: number; reset_at: number });

  if (attempt.attempts > 5) {
    const waitMinutes = Math.max(1, Math.ceil((attempt.reset_at - now) / 60000));
    res.set('Retry-After', String(Math.ceil((attempt.reset_at - now) / 1000)))
      .status(429).json({
        error: `Too many incorrect OTP attempts. For security, OTP confirmation is temporarily locked for ${waitMinutes} minute(s).`,
        code: 'OTP_LOCKED',
      });
    return false;
  }
  if (!matchesDeliveryOtp(cleanOtp, delivery.deliveryOtp)) {
    const remaining = Math.max(0, 5 - attempt.attempts);
    res.status(400).json({
      error: remaining > 0
        ? `Incorrect 4-digit delivery OTP. Ask the recipient or check your tracking card for the exact 4-digit code (${remaining} attempt${remaining === 1 ? '' : 's'} remaining).`
        : 'Incorrect 4-digit delivery OTP. You have reached the maximum attempts and must wait before trying again.',
      code: 'OTP_MISMATCH',
      remainingAttempts: remaining,
    });
    return false;
  }
  if (publicBucket) {
    await db.prepare('DELETE FROM login_attempts WHERE bucket = ?').run(publicBucket);
  } else {
    await db.prepare('DELETE FROM delivery_otp_attempts WHERE delivery_id = ?').run(delivery.id);
  }
  return true;
}

/** Releases unaccepted 'offered' assignments held by a rider going offline, unverified, or suspended. */
async function releaseOpenOffersForRider(riderId: string, now: string): Promise<{
  clearedOfferIds: string[];
  releasedCount: number;
}> {
  const offered = await db.prepare(`
    UPDATE delivery_assignments
    SET status = 'reassigned', responded_at = ?
    WHERE rider_id = ? AND status = 'offered'
    RETURNING id
  `).all(now, riderId) as Array<{ id: string }>;

  const released = await db.prepare(`
    UPDATE delivery_requests
    SET assigned_rider_id = NULL, status = 'pending_dispatch', updated_at = ?
    WHERE assigned_rider_id = ? AND status = 'assigned'
  `).run(now, riderId);

  return {
    clearedOfferIds: offered.map((a) => a.id),
    releasedCount: released.changes,
  };
}

function asyncRoute(handler: (req: AuthedRequest, res: SaqoResponse, next: NextFn) => Promise<unknown>) {
  return (req: AuthedRequest, res: SaqoResponse, next: NextFn) => {
    return handler(req, res, next).catch(next);
  };
}

function getRequestOrigin(req: SaqoRequest): string {
  const configured = process.env.APP_URL;
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && url.protocol === 'http:')) {
        return url.origin;
      }
    } catch {
      // Development can run without a public origin.
    }
  }
  if (process.env.NODE_ENV === 'production') {
    throw new PaymentConfigError('Set APP_URL to the public HTTPS URL before enabling payment checkout.');
  }
  return `${req.protocol}://${req.get('host') || `localhost:${process.env.PORT || 3000}`}`;
}

export function isAllowedBrowserOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    const site = new URL(origin);
    if (site.origin !== origin || !['https:', 'http:'].includes(site.protocol)) return false;
    if (site.host === host) return true;
    const allowedOrigins = [process.env.APP_URL, ...(process.env.SAQO_FRONTEND_ORIGIN || '').split(',')];
    return allowedOrigins.some((entry) => {
      const trimmed = entry?.trim();
      if (!trimmed) return false;
      try {
        return new URL(trimmed).origin === origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function getWebhookOrigin(req: SaqoRequest): string {
  const configured = process.env.SAQO_API_ORIGIN?.trim();
  if (!configured) return getRequestOrigin(req);
  try {
    const url = new URL(configured);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) {
      const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
      return `${url.origin}${path}`;
    }
  } catch {
    // Report the configuration error below.
  }
  throw new PaymentConfigError('Set SAQO_API_ORIGIN to the HTTPS origin that receives webhooks.');
}

function sendPaymentError(res: SaqoResponse, err: unknown): void {
  if (err instanceof InsufficientWalletBalanceError) {
    res.status(400).json({
      error: err.message,
      code: err.code,
      requiredAmountNgn: err.requiredAmountNgn,
      availableBalanceNgn: err.availableBalanceNgn,
    });
    return;
  }
  if (err instanceof PaymentConfigError || err instanceof PaymentVerificationError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  const message = err instanceof Error ? err.message : 'Payment operation failed.';
  res.status(400).json({ error: message });
}

export interface RegisterRoutesOptions {
  twilioUrlencodedMiddleware?: RouteHandler;
}

export function registerSaqoRoutes(app: SaqoApp, options?: RegisterRoutesOptions): void {
  app.use('/api', (req: SaqoRequest, res: SaqoResponse, next: NextFn) => {
    res.set('Cache-Control', 'no-store');
    res.vary('Origin');
    const origin = req.get('Origin');
    if (origin) {
      if (!isAllowedBrowserOrigin(origin, req.get('host'))) {
        res.status(403).json({ error: 'This origin cannot access the SAQO API.' });
        return;
      }
      res.set('Access-Control-Allow-Origin', origin);
      if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE');
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.sendStatus(204);
        return;
      }
    }
    next();
  });

  // Healthcheck
  app.get('/api/health', (_req: SaqoRequest, res: SaqoResponse) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, service: 'saqo-dispatch' });
  });

  // Public settings
  app.get('/api/settings/public', asyncRoute(async (_req: SaqoRequest, res: SaqoResponse) => {
    const s = await getPlatformSettings();
    res.json({
      whatsappSupportNumber: s.whatsappSupportNumber,
      showDeliveryStateSelectors: s.showDeliveryStateSelectors,
      whatsAppOrderNumber: getWhatsAppOrderNumber(),
      maxActiveParcelsPerRider: s.maxActiveParcelsPerRider,
      offerTimeoutSeconds: s.offerTimeoutSeconds,
      payments: await getGatewayPublicConfig(),
    });
  }));

  app.get('/api/payments/config', asyncRoute(async (_req: SaqoRequest, res: SaqoResponse) => {
    res.set('Cache-Control', 'no-store').json(await getGatewayPublicConfig());
  }));

  registerTwilioWhatsAppWebhook(app, options?.twilioUrlencodedMiddleware);

  // Quote endpoint
  app.post('/api/quote', asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const settings = await getPlatformSettings();
    const {
      pickupState = 'Katsina',
      pickupAddress,
      pickupLat,
      pickupLng,
      destinationState = 'Katsina',
      destinationAddress,
      destinationLat,
      destinationLng,
      weightKg,
    } = req.body || {};
    if (!settings.showDeliveryStateSelectors && (pickupState !== 'Katsina' || destinationState !== 'Katsina')) {
      res.status(400).json({ error: 'SAQO currently accepts pickup and destination locations within Katsina State.' });
      return;
    }

    if (!pickupState || !destinationState) {
      res.status(400).json({ error: 'Pickup and destination states are required.' });
      return;
    }
    const pCoords = isValidNigeriaCoordPair(pickupLat, pickupLng)
      ? { lat: Number(Number(pickupLat).toFixed(5)), lng: Number(Number(pickupLng).toFixed(5)) }
      : resolveAddressCoordinates(pickupState, pickupAddress || pickupState);
    const dCoords = isValidNigeriaCoordPair(destinationLat, destinationLng)
      ? {
          lat: Number(Number(destinationLat).toFixed(5)),
          lng: Number(Number(destinationLng).toFixed(5)),
        }
      : resolveAddressCoordinates(destinationState, destinationAddress || destinationState);
    if (!pCoords || !dCoords) {
      res.status(400).json({ error: 'Select a recognized pickup and destination location.' });
      return;
    }
    if (pCoords.lat === dCoords.lat && pCoords.lng === dCoords.lng) {
      res.status(400).json({ error: 'Choose different pickup and destination locations.' });
      return;
    }
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
  }));

  // Auth: Login
  app.post('/api/auth/login', asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || !email.trim() || email.length > 254 ||
        typeof password !== 'string' || !password || password.length > 1024) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }
    const throttle = await checkLoginThrottle(req.ip || req.socket.remoteAddress || 'unknown', email);
    if (throttle.retryAfter) {
      res.set('Retry-After', String(throttle.retryAfter)).status(429)
        .json({ error: 'Too many sign-in attempts. Please try again later.' });
      return;
    }
    const row = await db
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
    await throttle.clearAccount();
    const token = signSessionToken({ userId: row.id, role: row.role });
    const profile = (await getProfileById(row.id))!;
    const rider = profile.role === 'rider' ? await getRiderByProfileId(profile.id) : null;
    res.json({ token, profile, rider });
  }));

  // Auth: Register (Public registration is strictly for Customers; riders are issued by Admin)
  app.post('/api/auth/register', asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
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
    const existing = await db
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

    await db.prepare(`
      INSERT INTO profiles (id, email, password_hash, full_name, phone, role, account_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(profileId, String(email).trim().toLowerCase(), passHash, String(fullName).trim(), String(phone).trim(), targetRole, now);

    await db.prepare(`INSERT INTO customers (id, profile_id, default_state) VALUES (?, ?, ?)`).run(
      `cust-${crypto.randomUUID().slice(0, 8)}`,
      profileId,
      state
    );

    const token = signSessionToken({ userId: profileId, role: targetRole });
    const profile = (await getProfileById(profileId))!;
    res.status(201).json({ token, profile, rider: null });
  }));

  // Auth: Me
  app.get('/api/auth/me', authenticate, asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    const profile = (await getProfileById(req.auth!.userId))!;
    const rider = profile.role === 'rider' ? await getRiderByProfileId(profile.id) : null;
    res.json({ profile, rider });
  }));

  // Auth: Update Own Profile (Client, Rider, Admin)
  app.patch('/api/auth/profile', authenticate, asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    const profile = await getProfileById(req.auth!.userId);
    if (!profile) {
      res.status(404).json({ error: 'Account profile not found.' });
      return;
    }
    const { fullName, phone, homeState, vehicleType, plateNumber, defaultState } = req.body || {};
    const nextName = typeof fullName === 'string' && fullName.trim() ? fullName.trim() : profile.fullName;
    if (nextName.length < 2 || nextName.length > 80) {
      res.status(400).json({ error: 'Full name must be between 2 and 80 characters.' });
      return;
    }
    const nextPhone = typeof phone === 'string' && phone.trim() ? phone.trim() : profile.phone;
    if (!isValidNigerianPhone(nextPhone)) {
      res.status(400).json({ error: 'Please enter a valid phone number (at least 10 digits).' });
      return;
    }

    const { updatedProfile, updatedRider } = await persistDispatchChange(async () => {
      await db.prepare('UPDATE profiles SET full_name = ?, phone = ? WHERE id = ?').run(
        nextName,
        nextPhone,
        profile.id
      );

      if (profile.role === 'client' && typeof defaultState === 'string' && defaultState.trim()) {
        await db.prepare('UPDATE customers SET default_state = ? WHERE profile_id = ?').run(
          defaultState.trim(),
          profile.id
        );
      }

      if (profile.role === 'rider') {
        const existingRider = await getRiderByProfileId(profile.id);
        if (existingRider) {
          const validVehicles = ['Motorcycle', 'Van', 'Inter-State Sprinter'];
          const nextVehicle = validVehicles.includes(vehicleType) ? vehicleType : existingRider.vehicleType;
          const nextState = typeof homeState === 'string' && homeState.trim() ? homeState.trim() : existingRider.homeState;
          const nextPlate = typeof plateNumber === 'string' && plateNumber.trim()
            ? plateNumber.trim().toUpperCase()
            : existingRider.plateNumber;
          await db.prepare('UPDATE riders SET vehicle_type = ?, plate_number = ?, home_state = ? WHERE id = ?').run(
            nextVehicle,
            nextPlate,
            nextState,
            existingRider.riderId
          );
        }
      }

      const freshProfile = (await getProfileById(profile.id))!;
      const freshRider = freshProfile.role === 'rider' ? await getRiderByProfileId(profile.id) : null;
      return { updatedProfile: freshProfile, updatedRider: freshRider };
    });

    if (updatedRider) {
      await broadcastWsEvent('rider:availability', updatedRider);
    }
    res.json({ profile: updatedProfile, rider: updatedRider });
  }));

  // Public tracking lookup
  app.get('/api/track/:trackingCode', asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    await expireTimedOutOffers().catch(() => {});
    const delivery = await getDeliveryByTrackingCode(req.params.trackingCode);
    if (!delivery) {
      res.status(404).json({ error: 'Tracking code not found.' });
      return;
    }
    res.json({ delivery: publicTrackingDelivery(delivery), history: await publicTrackingHistory(delivery.id) });
  }));

  // Confirm OTP (public recipient or client)
  app.post('/api/track/:trackingCode/confirm-otp', asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const { otp } = req.body || {};
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const outcome = await persistDispatchChange(async () => {
      const delivery = await getDeliveryByTrackingCode(req.params.trackingCode);
      if (!delivery) {
        return { errorStatus: 404, errorBody: { error: 'Parcel not found.' } } as const;
      }
      if (delivery.status === 'delivered') {
        return { errorStatus: 400, errorBody: { error: 'This parcel has already been marked as delivered.' } } as const;
      }
      if (delivery.status === 'cancelled') {
        return { errorStatus: 400, errorBody: { error: 'Cancelled deliveries cannot be confirmed.' } } as const;
      }
      if (delivery.status !== 'arrived_at_destination') {
        return { errorStatus: 409, errorBody: { error: 'The rider must arrive at the destination before handoff.' } } as const;
      }
      if (!await verifyHandoffOtp(res, delivery, otp, { type: 'public', ip: clientIp })) {
        return { responded: true } as const;
      }

      const now = new Date().toISOString();
      const transition = await db.prepare(`
        UPDATE delivery_requests
        SET otp_verified = 1, status = 'delivered', updated_at = ?
        WHERE id = ? AND status = 'arrived_at_destination'
      `).run(now, delivery.id);
      if (transition.changes === 0) {
        return { errorStatus: 409, errorBody: { error: 'This parcel is no longer awaiting OTP handoff.' } } as const;
      }

      await db.prepare(`
        INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
        VALUES (?, ?, 'delivered', ?, 'client', ?)
      `).run(
        `hist-${crypto.randomUUID().slice(0, 8)}`,
        delivery.id,
        `Parcel receipt confirmed with a verified recipient OTP.`,
        now
      );

      // Settle payment & credit rider once
      await db.prepare(`UPDATE payments SET status = 'settled' WHERE delivery_id = ?`).run(delivery.id);
      if (delivery.assignedRiderId) {
        const payment = await db
          .prepare('SELECT rider_payout_ngn FROM payments WHERE delivery_id = ?')
          .get(delivery.id) as { rider_payout_ngn: number } | undefined;
        await db.prepare(`
          UPDATE riders
          SET completed_deliveries_count = completed_deliveries_count + 1,
              total_earnings_ngn = total_earnings_ngn + ?
          WHERE id = ?
        `).run(payment?.rider_payout_ngn || 0, delivery.assignedRiderId);
      }

      const updated = (await getDeliveryById(delivery.id))!;
      const history = await publicTrackingHistory(delivery.id);
      return { updated, history } as const;
    });

    if ('responded' in outcome) return;
    if ('errorStatus' in outcome && outcome.errorStatus !== undefined) {
      res.status(outcome.errorStatus).json(outcome.errorBody);
      return;
    }

    await broadcastWsEvent('delivery:updated', outcome.updated);
    await dispatchWaitingDeliveries();
    res.json({ delivery: publicTrackingDelivery(outcome.updated), history: outcome.history });
  }));

  // Notifications
  app.get('/api/notifications', authenticate, asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    res.json({ notifications: await getNotificationsForUser(req.auth!.userId) });
  }));

  app.post('/api/notifications/read', authenticate, asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    await db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.auth!.userId);
    res.json({ ok: true });
  }));

  // Client: List deliveries
  app.get('/api/client/deliveries', authenticate, requireRole('client'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    await expireTimedOutOffers(req.query?.checkExpiry === '1').catch(() => {});
    const cust = await db
      .prepare('SELECT id FROM customers WHERE profile_id = ?')
      .get(req.auth!.userId) as { id: string } | undefined;
    if (!cust) {
      res.json({ deliveries: [] });
      return;
    }
    const deliveries = await listDeliveries({ customerId: cust.id });
    const withHistory = await Promise.all(deliveries.map(async (d) => ({
      ...d,
      history: await getDeliveryHistory(d.id),
    })));
    res.json({ deliveries: withHistory });
  }));

  // Client: Create delivery request + process payment method + trigger Smart Dispatch
  app.post('/api/deliveries', authenticate, requireRole('client'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    const settings = await getPlatformSettings();
    const {
      pickupState = 'Katsina',
      pickupAddress,
      pickupLat,
      pickupLng,
      destinationState = 'Katsina',
      destinationAddress,
      destinationLat,
      destinationLng,
      recipientName,
      recipientPhone,
      parcelCategory,
      parcelDescription,
      weightKg,
      paymentMethod,
      idempotencyKey,
      transferReference,
      transferProofNote,
    } = req.body || {};
    if (!settings.showDeliveryStateSelectors && (pickupState !== 'Katsina' || destinationState !== 'Katsina')) {
      res.status(400).json({ error: 'SAQO currently accepts pickup and destination locations within Katsina State.' });
      return;
    }


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

    const chosenMethod: PaymentMethodCode = ['wallet', 'flutterwave', 'cash', 'bank_transfer'].includes(
      paymentMethod
    )
      ? (paymentMethod as PaymentMethodCode)
      : 'cash';

    const cleanIdempotencyKey =
      typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim() : null;
    if (cleanIdempotencyKey) {
      const existingPayment = await db
        .prepare('SELECT delivery_id, user_id FROM payment_transactions WHERE idempotency_key = ? AND delivery_id IS NOT NULL')
        .get(cleanIdempotencyKey) as { delivery_id: string; user_id: string } | undefined;
      if (existingPayment?.delivery_id) {
        if (existingPayment.user_id !== req.auth!.userId) {
          res.status(409).json({ error: 'This request key is already in use.' });
          return;
        }
        const existingDelivery = await getDeliveryById(existingPayment.delivery_id);
        if (existingDelivery) {
          let replayPaymentTx = await getPaymentTransactionByKey(cleanIdempotencyKey);
          if (replayPaymentTx?.provider === 'flutterwave') {
            try {
              replayPaymentTx = await reuseFlutterwaveCheckout(replayPaymentTx);
            } catch (error) {
              sendPaymentError(res, error);
              return;
            }
          }
          res.status(200).json({
            delivery: await getDeliveryById(existingDelivery.id) ?? existingDelivery,
            history: await getDeliveryHistory(existingDelivery.id),
            paymentTransaction: replayPaymentTx,
            checkoutUrl: replayPaymentTx?.checkoutUrl || null,
            idempotentReplay: true,
          });
          return;
        }
      }
    }

    const methodRow = await db
      .prepare('SELECT is_enabled FROM payment_methods WHERE code = ?')
      .get(chosenMethod) as { is_enabled: number } | undefined;
    if (methodRow && !methodRow.is_enabled) {
      res.status(400).json({ error: `${chosenMethod.replace('_', ' ')} payment method is currently disabled.` });
      return;
    }

    const cust = await db
      .prepare('SELECT id FROM customers WHERE profile_id = ?')
      .get(req.auth!.userId) as { id: string } | undefined;
    const customerProfile = await getProfileById(req.auth!.userId);
    if (!cust || !customerProfile) {
      res.status(400).json({ error: 'Customer profile not initialized.' });
      return;
    }

    const publicPayConfig = await getGatewayPublicConfig();
    const methodConfig = publicPayConfig.methods.find((m) => m.code === chosenMethod);
    if (methodConfig && !methodConfig.isEnabled) {
      res.status(400).json({ error: `${methodConfig.name} is currently disabled.` });
      return;
    }
    if (chosenMethod === 'flutterwave' && !publicPayConfig.isEnabled) {
      res.status(400).json({
        error: 'Online payment via Flutterwave is not currently enabled. Choose Wallet or Cash / Bank Transfer.',
        code: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
      });
      return;
    }

    const pCoords = isValidNigeriaCoordPair(pickupLat, pickupLng)
      ? { lat: Number(Number(pickupLat).toFixed(5)), lng: Number(Number(pickupLng).toFixed(5)) }
      : resolveAddressCoordinates(pickupState, pickupAddress);
    const dCoords = isValidNigeriaCoordPair(destinationLat, destinationLng)
      ? {
          lat: Number(Number(destinationLat).toFixed(5)),
          lng: Number(Number(destinationLng).toFixed(5)),
        }
      : resolveAddressCoordinates(destinationState, destinationAddress);
    if (!pCoords || !dCoords) {
      res.status(400).json({ error: 'Select a recognized pickup and destination location.' });
      return;
    }
    if (pCoords.lat === dCoords.lat && pCoords.lng === dCoords.lng) {
      res.status(400).json({ error: 'Choose different pickup and destination locations.' });
      return;
    }
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

    let deliveryId = '';
    let trackingCode = '';
    let paymentTransaction: any = null;

    if (chosenMethod === 'flutterwave') {
      const booking = await createBookingRows({
        customerId: cust.id, pickupState, pickupAddress, pCoords, destinationState, destinationAddress, dCoords,
        recipientName, recipientPhone, parcelCategory, parcelDescription, weightKg: parsedWeight,
        paymentMethod: chosenMethod, quote, riderCommissionPercent: settings.riderCommissionPercent,
      });
      deliveryId = booking.deliveryId;
      trackingCode = booking.trackingCode;
      try {
        const origin = getRequestOrigin(req);
        paymentTransaction = await initializeDeliveryFlutterwavePayment({
          deliveryId,
          userId: req.auth!.userId,
          customerName: customerProfile.fullName,
          customerEmail: customerProfile.email,
          customerPhone: customerProfile.phone,
          idempotencyKey: cleanIdempotencyKey,
          redirectUrl: `${origin}/?flw_callback=1`,
        });
      } catch (payErr) {
        if (await db.prepare('SELECT 1 FROM payment_transactions WHERE delivery_id = ?').get(deliveryId)) {
          // Preserve the reference in case the provider accepted a request whose response was lost.
          sendPaymentError(res, payErr);
          return;
        }
        await db.prepare('DELETE FROM delivery_status_history WHERE delivery_id = ?').run(deliveryId);
        await db.prepare('DELETE FROM payments WHERE delivery_id = ?').run(deliveryId);
        await db.prepare('DELETE FROM parcels WHERE delivery_id = ?').run(deliveryId);
        await db.prepare('DELETE FROM delivery_requests WHERE id = ?').run(deliveryId);
        sendPaymentError(res, payErr);
        return;
      }
    } else {
      try {
        const txOutcome = await persistDispatchChange(async () => {
          if (chosenMethod === 'wallet') {
            const wallet = await ensureWallet(req.auth!.userId);
            if (wallet.balanceNgn < quote.deliveryFeeNgn) {
              return {
                insufficientWallet: true,
                availableBalanceNgn: wallet.balanceNgn,
              } as const;
            }
          }

          const booking = await createBookingRows({
            customerId: cust.id, pickupState, pickupAddress, pCoords, destinationState, destinationAddress, dCoords,
            recipientName, recipientPhone, parcelCategory, parcelDescription, weightKg: parsedWeight,
            paymentMethod: chosenMethod, quote, riderCommissionPercent: settings.riderCommissionPercent,
          });

          const payRes = await createDeliveryPaymentRecords({
            deliveryId: booking.deliveryId,
            trackingCode: booking.trackingCode,
            customerProfileId: req.auth!.userId,
            customerName: customerProfile.fullName,
            customerEmail: customerProfile.email,
            customerPhone: customerProfile.phone,
            amountNgn: quote.deliveryFeeNgn,
            paymentMethod: chosenMethod,
            idempotencyKey: cleanIdempotencyKey,
            transferReference: typeof transferReference === 'string' ? transferReference : null,
            transferProofNote: typeof transferProofNote === 'string' ? transferProofNote : null,
          });
          await db.prepare('UPDATE delivery_requests SET payment_reference = ? WHERE id = ?').run(
            payRes.paymentReference,
            booking.deliveryId
          );
          return {
            insufficientWallet: false,
            deliveryId: booking.deliveryId,
            trackingCode: booking.trackingCode,
            paymentTransaction: payRes.paymentTransaction,
          } as const;
        });

        if (txOutcome.insufficientWallet) {
          res.status(400).json({
            error: `Insufficient wallet balance. Delivery fee is ₦${quote.deliveryFeeNgn.toLocaleString()}, available balance is ₦${txOutcome.availableBalanceNgn.toLocaleString()}. Fund your wallet to proceed.`,
            code: 'INSUFFICIENT_WALLET_BALANCE',
            requiredAmountNgn: quote.deliveryFeeNgn,
            availableBalanceNgn: txOutcome.availableBalanceNgn,
          });
          return;
        }
        deliveryId = txOutcome.deliveryId;
        trackingCode = txOutcome.trackingCode;
        paymentTransaction = txOutcome.paymentTransaction;
      } catch (payErr) {
        sendPaymentError(res, payErr);
        return;
      }
    }

    const created = (await getDeliveryById(deliveryId))!;
    await broadcastWsEvent('delivery:created', created);

    // Run Smart Rider Assignment Algorithm immediately
    await dispatchWaitingDeliveries();
    const assigned = await getDeliveryById(deliveryId);
    const dispatchResult = assigned?.status === 'assigned'
      ? { offered: true, riderId: assigned.assignedRiderId, riderName: assigned.assignedRiderName }
      : { offered: false };
    const finalDelivery = (await getDeliveryById(deliveryId))!;

    res.status(201).json({
      delivery: finalDelivery,
      history: await getDeliveryHistory(deliveryId),
      dispatchResult,
      paymentTransaction,
      checkoutUrl: paymentTransaction?.checkoutUrl || null,
    });
  }));

  // Client or Admin: Retry smart dispatch
  app.post('/api/deliveries/:id/retry-dispatch', authenticate, requireRole('client', 'admin'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    const check = await persistDispatchChange(async () => {
      const delivery = await getDeliveryById(req.params.id);
      if (!delivery) {
        return { errorStatus: 404, errorBody: { error: 'Delivery not found.' } } as const;
      }
      if (req.auth!.role === 'client') {
        const cust = await db
          .prepare('SELECT id FROM customers WHERE profile_id = ?')
          .get(req.auth!.userId) as { id: string } | undefined;
        if (!cust || delivery.customerId !== cust.id) {
          return { errorStatus: 403, errorBody: { error: 'You can only manage your own parcel requests.' } } as const;
        }
      }
      if (!['pending_dispatch', 'no_rider_available'].includes(delivery.status) || delivery.assignedRiderId) {
        return { errorStatus: 409, errorBody: { error: 'Only waiting parcels can be retried.' } } as const;
      }
      await db.prepare(
        `DELETE FROM delivery_assignments WHERE delivery_id = ? AND status IN ('rejected', 'timed_out')`
      ).run(delivery.id);
      return { deliveryId: delivery.id } as const;
    });

    if ('errorStatus' in check && check.errorStatus !== undefined) {
      res.status(check.errorStatus).json(check.errorBody);
      return;
    }

    const dispatchResult = await dispatchNextRiderForDelivery(check.deliveryId);
    const updated = (await getDeliveryById(check.deliveryId))!;
    res.json({ delivery: updated, dispatchResult });
  }));

  // Client or Admin: Cancel delivery
  app.post('/api/deliveries/:id/cancel', authenticate, requireRole('client', 'admin'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    const now = new Date().toISOString();
    const outcome = await persistDispatchChange(async () => {
      const delivery = await getDeliveryById(req.params.id);
      if (!delivery) {
        return { errorStatus: 404, errorBody: { error: 'Delivery not found.' } } as const;
      }
      if (req.auth!.role === 'client') {
        const cust = await db
          .prepare('SELECT id FROM customers WHERE profile_id = ?')
          .get(req.auth!.userId) as { id: string } | undefined;
        if (!cust || delivery.customerId !== cust.id) {
          return { errorStatus: 403, errorBody: { error: 'You can only cancel your own parcel requests.' } } as const;
        }
      }
      if (['delivered', 'cancelled'].includes(delivery.status)) {
        return { errorStatus: 400, errorBody: { error: 'Cannot cancel a completed or already cancelled delivery.' } } as const;
      }
      const offeredAssignments = await db
        .prepare(`SELECT id FROM delivery_assignments WHERE delivery_id = ? AND status = 'offered'`)
        .all(delivery.id) as Array<{ id: string }>;

      const cancelUpdate = await db.prepare(
        `UPDATE delivery_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND status NOT IN ('delivered', 'cancelled')`
      ).run(now, delivery.id);
      if (cancelUpdate.changes === 0) {
        return { errorStatus: 400, errorBody: { error: 'Cannot cancel a completed or already cancelled delivery.' } } as const;
      }

      await db.prepare(
        `UPDATE delivery_assignments SET status = 'reassigned', responded_at = ? WHERE delivery_id = ? AND status = 'offered'`
      ).run(now, delivery.id);

      if (delivery.paymentMethod === 'wallet' && delivery.paymentStatus === 'paid') {
        try {
          await processAdminRefund({
            deliveryId: delivery.id,
            amountNgn: delivery.deliveryFeeNgn,
            destination: 'wallet',
            reason: `Automatic wallet refund on delivery cancellation (${delivery.trackingCode})`,
            adminId: req.auth!.userId,
          });
        } catch {
          // Non-fatal fallback: keep delivery cancelled if refund fails
        }
      } else if (delivery.paymentStatus !== 'paid' && delivery.paymentStatus !== 'collected_by_rider') {
        await cancelDeliveryPayments(delivery.id, {
          reason:
            req.auth!.role === 'admin'
              ? `Delivery cancelled by operations (${delivery.trackingCode})`
              : `Delivery cancelled by sender (${delivery.trackingCode})`,
        });
      }

      await db.prepare(`
        INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
        VALUES (?, ?, 'cancelled', ?, ?, ?)
      `).run(
        `hist-${crypto.randomUUID().slice(0, 8)}`,
        delivery.id,
        req.auth!.role === 'admin' ? 'Delivery cancelled by SAQO Operations.' : 'Delivery cancelled by sender.',
        req.auth!.role,
        now
      );

      const updated = (await getDeliveryById(delivery.id))!;
      return { offeredAssignments, updated } as const;
    });

    if ('errorStatus' in outcome && outcome.errorStatus !== undefined) {
      res.status(outcome.errorStatus).json(outcome.errorBody);
      return;
    }

    for (const asg of outcome.offeredAssignments) {
      clearOfferTimer(asg.id);
    }
    await broadcastWsEvent('delivery:updated', outcome.updated);
    await dispatchWaitingDeliveries();
    res.json({ delivery: outcome.updated });
  }));

  // Customer Wallet & Payment Endpoints
  app.get('/api/wallet', authenticate, requireRole('client'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    try {
      res.json(await getCustomerWalletSummary(req.auth!.userId));
    } catch (err) {
      sendPaymentError(res, err);
    }
  }));

  app.post('/api/wallet/fund/initialize', authenticate, requireRole('client'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    try {
      const profile = await getProfileById(req.auth!.userId);
      if (!profile) {
        res.status(401).json({ error: 'Account not found.' });
        return;
      }
      const amountNgn = Number(req.body?.amountNgn);
      const idempotencyKey =
        typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.trim() : null;
      const origin = getRequestOrigin(req);
      const tx = await initializeWalletFunding({
        userId: profile.id,
        customerName: profile.fullName,
        customerEmail: profile.email,
        customerPhone: profile.phone,
        amountNgn,
        idempotencyKey,
        redirectUrl: `${origin}/?flw_callback=1`,
      });
      res.status(201).json({ paymentTransaction: tx, checkoutUrl: tx.checkoutUrl });
    } catch (err) {
      sendPaymentError(res, err);
    }
  }));

  app.post('/api/wallet/verify', authenticate, asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    try {
      const { transactionId, txRef } = req.body || {};
      if (!transactionId && !txRef) {
        res.status(400).json({ error: 'transactionId or txRef is required.' });
        return;
      }

      const cleanTxRef = txRef ? String(txRef).trim() : '';
      const cleanTxId = transactionId ? String(transactionId).trim() : '';
      const txRow = (cleanTxRef
        ? await db.prepare('SELECT user_id FROM payment_transactions WHERE reference = ?').get(cleanTxRef)
        : await db.prepare('SELECT user_id FROM payment_transactions WHERE provider_tx_id = ?').get(cleanTxId)) as
        | { user_id: string }
        | undefined;

      if (txRow && req.auth!.role !== 'admin' && txRow.user_id !== req.auth!.userId) {
        res.status(403).json({ error: 'You cannot verify another user transaction.' });
        return;
      }
      if (!txRow && req.auth!.role !== 'admin' && !cleanTxRef) {
        res.status(400).json({ error: 'Transaction reference (txRef) is required for verification.' });
        return;
      }

      const result = await confirmFlutterwaveTransaction({
        transactionId: cleanTxId || null,
        txRef: cleanTxRef || null,
        verifiedByUserId: req.auth!.userId,
        source: 'callback',
      });
      res.json(result);
    } catch (err) {
      sendPaymentError(res, err);
    }
  }));

  app.post('/api/deliveries/:id/pay', authenticate, requireRole('client'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    try {
      const { paymentMethod, idempotencyKey, transferReference, transferProofNote } = req.body || {};
      const profile = await getProfileById(req.auth!.userId);
      if (!profile) {
        res.status(401).json({ error: 'Account not found.' });
        return;
      }
      if (!['wallet', 'flutterwave', 'bank_transfer'].includes(String(paymentMethod))) {
        res.status(400).json({ error: 'Select wallet, flutterwave, or bank_transfer to complete payment.' });
        return;
      }
      const methodRow = await db
        .prepare('SELECT is_enabled FROM payment_methods WHERE code = ?')
        .get(String(paymentMethod)) as { is_enabled: number } | undefined;
      if (methodRow && !methodRow.is_enabled) {
        res.status(400).json({ error: `${String(paymentMethod).replace('_', ' ')} payment is currently disabled.` });
        return;
      }
      if (paymentMethod === 'wallet') {
        const result = await payDeliveryWithWallet({
          deliveryId: req.params.id,
          userId: profile.id,
          customerName: profile.fullName,
          customerEmail: profile.email,
          customerPhone: profile.phone,
          idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : null,
        });
        res.json(result);
        return;
      }
      if (paymentMethod === 'flutterwave') {
        const origin = getRequestOrigin(req);
        const tx = await initializeDeliveryFlutterwavePayment({
          deliveryId: req.params.id,
          userId: profile.id,
          customerName: profile.fullName,
          customerEmail: profile.email,
          customerPhone: profile.phone,
          idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : null,
          redirectUrl: `${origin}/?flw_callback=1`,
        });
        res.json({ paymentTransaction: tx, checkoutUrl: tx.checkoutUrl });
        return;
      }
      if (paymentMethod === 'bank_transfer') {
        const updated = await submitBankTransferProof({
          deliveryId: req.params.id,
          userId: profile.id,
          transferReference: String(transferReference || ''),
          transferProofNote: typeof transferProofNote === 'string' ? transferProofNote : undefined,
        });
        res.json({ delivery: updated });
        return;
      }
      res.status(400).json({ error: 'Select wallet, flutterwave, or bank_transfer to complete payment.' });
    } catch (err) {
      sendPaymentError(res, err);
    }
  }));

  // Flutterwave Server-Verified Webhook Endpoint
  app.post('/api/webhooks/flutterwave', asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    try {
      const result = await processFlutterwaveWebhook({
        headers: req.headers,
        rawBody: req.rawBody || JSON.stringify(req.body || {}),
        payload: req.body,
      });
      if (!result.accepted) {
        res.status(401).json({ received: false, error: result.message || 'Invalid webhook signature.' });
        return;
      }
      if (result.status === 'failed') {
        void sendOpsAlert('payment_failure', { reason: 'flutterwave_webhook_processing' });
        res.status(503).json({ received: true, status: 'retry' });
        return;
      }
      res.status(200).json({ received: true, ...result });
    } catch (err) {
      void sendOpsAlert('payment_failure', { reason: 'flutterwave_webhook_exception' });
      res.status(500).json({ received: false, error: err instanceof Error ? err.message : 'Webhook error' });
    }
  }));

  // Client: Rate rider after completed delivery
  app.post('/api/deliveries/:id/rate', authenticate, requireRole('client'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    const rawRating = Number(req.body?.rating);
    if (!Number.isFinite(rawRating) || rawRating < 1 || rawRating > 5) {
      res.status(400).json({ error: 'Choose a star rating from 1 to 5.' });
      return;
    }
    const cleanRating = Math.round(rawRating);
    const cleanComment = typeof req.body?.comment === 'string'
      ? req.body.comment.trim().slice(0, 500)
      : '';
    const now = new Date().toISOString();

    const outcome = await persistDispatchChange(async () => {
      const cust = await db
        .prepare('SELECT id FROM customers WHERE profile_id = ?')
        .get(req.auth!.userId) as { id: string } | undefined;
      const delivery = await getDeliveryById(req.params.id);
      if (!delivery || !cust || delivery.customerId !== cust.id) {
        return { errorStatus: 404, errorBody: { error: 'Delivery request not found.' } } as const;
      }
      if (delivery.status !== 'delivered') {
        return { errorStatus: 400, errorBody: { error: 'You can rate your rider after the parcel has been delivered.' } } as const;
      }
      if (!delivery.assignedRiderId) {
        return { errorStatus: 400, errorBody: { error: 'No rider was assigned to this delivery.' } } as const;
      }

      await db.prepare(`
        UPDATE delivery_requests
        SET rider_rating = ?, rider_rating_comment = ?, rated_at = ?, updated_at = ?
        WHERE id = ? AND status = 'delivered'
      `).run(cleanRating, cleanComment || null, now, now, delivery.id);

      const avgRow = await db.prepare(`
        SELECT AVG(rider_rating) as avg_rating, COUNT(rider_rating) as rating_count
        FROM delivery_requests
        WHERE assigned_rider_id = ? AND rider_rating IS NOT NULL
      `).get(delivery.assignedRiderId) as { avg_rating: number | null; rating_count: number } | undefined;

      if (avgRow && avgRow.avg_rating !== null) {
        const nextRating = Number(Number(avgRow.avg_rating).toFixed(2));
        await db.prepare('UPDATE riders SET rating = ? WHERE id = ?').run(nextRating, delivery.assignedRiderId);
      }

      const riderRow = await db
        .prepare('SELECT profile_id FROM riders WHERE id = ?')
        .get(delivery.assignedRiderId) as { profile_id: string } | undefined;
      const notif = riderRow
        ? await createNotification(
            riderRow.profile_id,
            `New ${cleanRating}★ Delivery Rating`,
            cleanComment
              ? `${delivery.trackingCode}: Client rated ${cleanRating}/5 — "${cleanComment}"`
              : `${delivery.trackingCode}: Client rated your delivery ${cleanRating}/5 stars.`,
            delivery.id
          )
        : null;

      const updated = (await getDeliveryById(delivery.id))!;
      const history = await getDeliveryHistory(delivery.id);
      const riderProfile = riderRow ? await getRiderByProfileId(riderRow.profile_id) : null;
      return { notif, updated, history, riderProfile } as const;
    });

    if ('errorStatus' in outcome && outcome.errorStatus !== undefined) {
      res.status(outcome.errorStatus).json(outcome.errorBody);
      return;
    }

    if (outcome.notif) await broadcastWsEvent('notification:created', outcome.notif);
    await broadcastWsEvent('delivery:updated', outcome.updated);
    if (outcome.riderProfile) await broadcastWsEvent('rider:availability', outcome.riderProfile);
    res.json({ delivery: outcome.updated, history: outcome.history });
  }));

  // Client: List submitted support tickets (suggestions & complaints)
  app.get('/api/client/tickets', authenticate, asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    res.json({ tickets: await getTicketsForReporter(req.auth!.userId) });
  }));

  // Client: File complaint or suggestion ticket (deliveryId optional)
  const handleCreateTicket = async (req: AuthedRequest, res: SaqoResponse) => {
    const { ticketType, deliveryId, subject, details } = req.body || {};
    if (!subject || !details) {
      res.status(400).json({ error: 'Subject and details are required.' });
      return;
    }
    const normalizedType = ticketType === 'suggestion' ? 'suggestion' : 'complaint';
    const cleanDeliveryId =
      typeof deliveryId === 'string' && deliveryId.trim() ? deliveryId.trim() : null;
    if (cleanDeliveryId && !await getDeliveryById(cleanDeliveryId)) {
      res.status(404).json({ error: 'Referenced delivery was not found.' });
      return;
    }
    const id = `comp-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    await db.prepare(`
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
    await broadcastWsEvent('complaint:updated', {
      id,
      ticketType: normalizedType,
      deliveryId: cleanDeliveryId,
      status: 'open',
    });
    res.status(201).json({ ok: true, id, tickets: await getTicketsForReporter(req.auth!.userId) });
  };
  app.post('/api/complaints', authenticate, handleCreateTicket);
  app.post('/api/tickets', authenticate, handleCreateTicket);

  // Rider: Dashboard state
  app.get('/api/rider/dashboard', authenticate, requireRole('rider'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    await expireTimedOutOffers(req.query?.checkExpiry === '1').catch(() => {});
    const rider = await getRiderByProfileId(req.auth!.userId);
    if (!rider) {
      res.status(404).json({ error: 'Rider profile not found.' });
      return;
    }
    const assignments = await getAssignmentsForRider(rider.riderId);
    const deliveries = await Promise.all((await listDeliveries({ riderId: rider.riderId })).map(async (d) => ({
      ...riderDelivery(d),
      history: await getDeliveryHistory(d.id),
    })));
    const settings = await getPlatformSettings();
    const notifications = await getNotificationsForUser(req.auth!.userId);
    res.json({ rider, assignments, deliveries, settings, notifications });
  }));

  // Rider: Toggle Online/Offline (must have verification tick enabled by Admin to go online)
  app.patch('/api/rider/availability', authenticate, requireRole('rider'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    const isOnline = Boolean(req.body?.isOnline);
    const now = new Date().toISOString();
    const outcome = await persistDispatchChange(async () => {
      const rider = await getRiderByProfileId(req.auth!.userId);
      if (!rider) {
        return { errorStatus: 404, errorBody: { error: 'Rider not found.' } } as const;
      }
      if (isOnline && rider.verificationStatus !== 'verified') {
        return {
          errorStatus: 403,
          errorBody: { error: 'Your rider verification tick has not been enabled by SAQO Admin yet.' },
        } as const;
      }
      await db.prepare('UPDATE riders SET is_online = ? WHERE id = ?').run(isOnline ? 1 : 0, rider.riderId);
      const released = !isOnline
        ? await releaseOpenOffersForRider(rider.riderId, now)
        : { clearedOfferIds: [], releasedCount: 0 };
      const updated = (await getRiderByProfileId(req.auth!.userId))!;
      return { updated, ...released } as const;
    });

    if ('errorStatus' in outcome && outcome.errorStatus !== undefined) {
      res.status(outcome.errorStatus).json(outcome.errorBody);
      return;
    }

    for (const id of outcome.clearedOfferIds) clearOfferTimer(id);
    await broadcastWsEvent('rider:availability', outcome.updated);
    if (isOnline || outcome.releasedCount > 0) await dispatchWaitingDeliveries();
    res.json({ rider: outcome.updated });
  }));

  // Rider: Update live GPS location
  app.post('/api/rider/location', authenticate, requireRole('rider'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    const rider = await getRiderByProfileId(req.auth!.userId);
    if (!rider) {
      res.status(404).json({ error: 'Rider not found.' });
      return;
    }
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!isValidNigeriaCoordPair(lat, lng)) {
      res.status(400).json({ error: 'Valid Nigerian GPS coordinates are required.' });
      return;
    }
    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE riders SET current_lat = ?, current_lng = ?, last_location_at = ? WHERE id = ?'
    ).run(lat, lng, now, rider.riderId);
    await db.prepare(
      'INSERT INTO rider_locations (id, rider_id, lat, lng, recorded_at) VALUES (?, ?, ?, ?, ?)'
    ).run(`loc-${crypto.randomUUID().slice(0, 8)}`, rider.riderId, lat, lng, now);

    const updated = (await getRiderByProfileId(req.auth!.userId))!;
    await broadcastWsEvent('rider:location', {
      riderId: updated.riderId,
      lat: updated.currentLat,
      lng: updated.currentLng,
      lastLocationAt: now,
    });
    if (updated.isOnline && updated.verificationStatus === 'verified') {
      await dispatchWaitingDeliveries();
    }
    res.json({ rider: updated });
  }));

  // Rider: Accept or Reject an assignment offer
  app.post('/api/rider/assignments/:id/respond', authenticate, requireRole('rider'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    const action = req.body?.action;
    if (action !== 'accept' && action !== 'reject') {
      res.status(400).json({ error: 'Choose accept or reject.' });
      return;
    }

    const now = new Date().toISOString();
    const outcome = await persistDispatchChange(async () => {
      const rider = await getRiderByProfileId(req.auth!.userId);
      if (!rider) {
        return { errorStatus: 404, errorBody: { error: 'Rider not found.' } } as const;
      }
      const assignment = await db
        .prepare('SELECT * FROM delivery_assignments WHERE id = ? AND rider_id = ?')
        .get(req.params.id, rider.riderId) as any;

      if (!assignment) {
        return { errorStatus: 404, errorBody: { error: 'Assignment offer not found.' } } as const;
      }
      if (assignment.status !== 'offered') {
        return { errorStatus: 400, errorBody: { error: `Offer is already ${assignment.status}.` } } as const;
      }

      const delivery = await getDeliveryById(assignment.delivery_id);
      if (Date.parse(assignment.expires_at) <= Date.now() || delivery?.status !== 'assigned' || delivery.assignedRiderId !== rider.riderId) {
        return { expired: true } as const;
      }

      if (action === 'accept') {
        if (!rider.isOnline || rider.verificationStatus !== 'verified') {
          return {
            errorStatus: 403,
            errorBody: { error: 'Your rider verification tick must be active to accept deliveries.' },
          } as const;
        }
        const settings = await getPlatformSettings();
        if (Math.max(0, rider.activeParcelsCount - 1) >= settings.maxActiveParcelsPerRider) {
          return {
            errorStatus: 409,
            errorBody: { error: 'You have reached the maximum active parcel limit.' },
          } as const;
        }

        const delUpd = await db.prepare(
          `UPDATE delivery_requests SET status = 'accepted', assigned_rider_id = ?, updated_at = ? WHERE id = ? AND status = 'assigned' AND assigned_rider_id = ?`
        ).run(rider.riderId, now, assignment.delivery_id, rider.riderId);
        if (delUpd.changes === 0) {
          return { expired: true } as const;
        }
        await db.prepare(
          `UPDATE delivery_assignments SET status = 'accepted', responded_at = ? WHERE id = ? AND status = 'offered'`
        ).run(now, assignment.id);
        await db.prepare(`
          INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
          VALUES (?, ?, 'accepted', ?, 'rider', ?)
        `).run(
          `hist-${crypto.randomUUID().slice(0, 8)}`,
          assignment.delivery_id,
          `${rider.fullName} accepted the delivery request.`,
          now
        );

        const updated = (await getDeliveryById(assignment.delivery_id))!;
        const custRow = await db
          .prepare('SELECT profile_id FROM customers WHERE id = ?')
          .get(updated.customerId) as { profile_id: string } | undefined;
        const notif = custRow
          ? await createNotification(
              custRow.profile_id,
              'Rider Assigned',
              `${rider.fullName} (${rider.vehicleType}) accepted parcel ${updated.trackingCode} and is heading for pickup.`,
              updated.id
            )
          : null;

        return { accepted: true, assignmentId: assignment.id, updated, notif } as const;
      }

      // Rejected -> atomically mark rejected and release delivery back to pending_dispatch
      const asgUpd = await db.prepare(
        `UPDATE delivery_assignments SET status = 'rejected', responded_at = ? WHERE id = ? AND status = 'offered'`
      ).run(now, assignment.id);
      if (asgUpd.changes === 0) {
        return { expired: true } as const;
      }
      await db.prepare(`
        UPDATE delivery_requests
        SET assigned_rider_id = NULL, status = 'pending_dispatch', updated_at = ?
        WHERE id = ? AND assigned_rider_id = ? AND status = 'assigned'
      `).run(now, assignment.delivery_id, rider.riderId);
      await db.prepare(`
        INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
        VALUES (?, ?, 'pending_dispatch', ?, 'rider', ?)
      `).run(
        `hist-${crypto.randomUUID().slice(0, 8)}`,
        assignment.delivery_id,
        `${rider.fullName} declined the offer. Re-running smart dispatch for next rider.`,
        now
      );
      const released = (await getDeliveryById(assignment.delivery_id))!;
      return { accepted: false, assignmentId: assignment.id, deliveryId: assignment.delivery_id, released } as const;
    });

    if ('expired' in outcome) {
      await expireTimedOutOffers(true).catch(() => {});
      res.status(409).json({ error: 'This offer has expired and has been reassigned to the next available rider.' });
      return;
    }
    if ('errorStatus' in outcome && outcome.errorStatus !== undefined) {
      res.status(outcome.errorStatus).json(outcome.errorBody);
      return;
    }

    clearOfferTimer(outcome.assignmentId);
    if (outcome.accepted) {
      if (outcome.notif) await broadcastWsEvent('notification:created', outcome.notif);
      await broadcastWsEvent('assignment:updated', { id: outcome.assignmentId, status: 'accepted' });
      await broadcastWsEvent('delivery:updated', outcome.updated);
      res.json({ ok: true, delivery: riderDelivery(outcome.updated) });
      return;
    }

    await broadcastWsEvent('assignment:updated', { id: outcome.assignmentId, status: 'rejected' });
    await broadcastWsEvent('delivery:updated', outcome.released);
    await dispatchWaitingDeliveries();
    res.json({ ok: true, nextDispatch: { offered: (await getDeliveryById(outcome.deliveryId))?.status === 'assigned' } });
  }));

  // Rider: Advance delivery status
  app.patch('/api/rider/deliveries/:id/status', authenticate, requireRole('rider'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    const transitions: Partial<Record<DeliveryStatus, DeliveryStatus>> = {
      accepted: 'heading_to_pickup',
      heading_to_pickup: 'parcel_picked_up',
      parcel_picked_up: 'in_transit',
      in_transit: 'arrived_at_destination',
      arrived_at_destination: 'delivered',
    };
    const nextStatus = req.body?.status as DeliveryStatus;

    const outcome = await persistDispatchChange(async () => {
      const rider = await getRiderByProfileId(req.auth!.userId);
      const delivery = await getDeliveryById(req.params.id);
      if (!rider || !delivery || delivery.assignedRiderId !== rider.riderId) {
        return { errorStatus: 404, errorBody: { error: 'Assigned delivery not found.' } } as const;
      }

      if (['delivered', 'cancelled'].includes(delivery.status)) {
        return { errorStatus: 400, errorBody: { error: 'This parcel is already finalized and cannot be updated.' } } as const;
      }

      if (!nextStatus || transitions[delivery.status] !== nextStatus) {
        return { errorStatus: 400, errorBody: { error: 'Invalid delivery status transition.' } } as const;
      }

      if (nextStatus === 'delivered' && !await verifyHandoffOtp(res, delivery, req.body?.otp, { type: 'rider', actorId: rider.riderId })) {
        return { responded: true } as const;
      }

      const now = new Date().toISOString();
      const note =
        req.body?.note ||
        (nextStatus === 'delivered'
          ? `Parcel delivered and verified with a verified recipient OTP.`
          : `Rider updated parcel status to ${nextStatus.replace(/_/g, ' ')}.`);

      const transition = nextStatus === 'delivered'
        ? await db.prepare(
            'UPDATE delivery_requests SET status = ?, otp_verified = 1, updated_at = ? WHERE id = ? AND status = ? AND assigned_rider_id = ?'
          ).run(nextStatus, now, delivery.id, delivery.status, rider.riderId)
        : await db.prepare(
            'UPDATE delivery_requests SET status = ?, updated_at = ? WHERE id = ? AND status = ? AND assigned_rider_id = ?'
          ).run(nextStatus, now, delivery.id, delivery.status, rider.riderId);

      if (transition.changes === 0) {
        return { errorStatus: 409, errorBody: { error: 'Delivery status changed concurrently. Refresh and retry.' } } as const;
      }

      await db.prepare(`
        INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
        VALUES (?, ?, ?, ?, 'rider', ?)
      `).run(`hist-${crypto.randomUUID().slice(0, 8)}`, delivery.id, nextStatus, note, now);

      if (nextStatus === 'delivered') {
        await db.prepare(`UPDATE payments SET status = 'settled' WHERE delivery_id = ?`).run(delivery.id);
        const payment = await db
          .prepare('SELECT rider_payout_ngn FROM payments WHERE delivery_id = ?')
          .get(delivery.id) as { rider_payout_ngn: number } | undefined;
        await db.prepare(`
          UPDATE riders
          SET completed_deliveries_count = completed_deliveries_count + 1,
              total_earnings_ngn = total_earnings_ngn + ?
          WHERE id = ?
        `).run(payment?.rider_payout_ngn || 0, rider.riderId);
      }

      const custRow = await db
        .prepare('SELECT profile_id FROM customers WHERE id = ?')
        .get(delivery.customerId) as { profile_id: string } | undefined;
      let notif: any = null;
      if (custRow) {
        let notifTitle = `${delivery.trackingCode}: ${nextStatus.replace(/_/g, ' ')}`;
        if (nextStatus === 'parcel_picked_up') {
          notifTitle = 'Parcel Picked Up';
        } else if (nextStatus === 'in_transit' || nextStatus === 'arrived_at_destination') {
          notifTitle = 'Out for Delivery';
        } else if (nextStatus === 'delivered') {
          notifTitle = 'Parcel Delivered';
        }
        notif = await createNotification(
          custRow.profile_id,
          notifTitle,
          `${delivery.trackingCode}: ${note}`,
          delivery.id
        );
      }

      const updated = (await getDeliveryById(delivery.id))!;
      const history = await getDeliveryHistory(delivery.id);
      return { updated, history, notif } as const;
    });

    if ('responded' in outcome) return;
    if ('errorStatus' in outcome && outcome.errorStatus !== undefined) {
      res.status(outcome.errorStatus).json(outcome.errorBody);
      return;
    }

    if (outcome.notif) await broadcastWsEvent('notification:created', outcome.notif);
    await broadcastWsEvent('delivery:updated', outcome.updated);
    if (nextStatus === 'delivered') await dispatchWaitingDeliveries();
    res.json({ delivery: riderDelivery(outcome.updated), history: outcome.history });
  }));

  // Rider: Confirm Cash on Delivery collection
  app.post('/api/rider/deliveries/:id/collect-cash', authenticate, requireRole('rider'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    try {
      const rider = await getRiderByProfileId(req.auth!.userId);
      if (!rider) {
        res.status(404).json({ error: 'Rider profile not found.' });
        return;
      }
      const updated = await confirmRiderCashCollection({
        deliveryId: req.params.id,
        riderId: rider.riderId,
        collectedAmountNgn:
          req.body?.collectedAmountNgn !== undefined ? Number(req.body.collectedAmountNgn) : undefined,
        notes: typeof req.body?.notes === 'string' ? req.body.notes : undefined,
      });
      res.json({ delivery: updated });
    } catch (err) {
      sendPaymentError(res, err);
    }
  }));

  // Admin: Full operational overview
  app.get('/api/admin/overview', authenticate, requireRole('admin'), asyncRoute(async (_req: SaqoRequest, res: SaqoResponse) => {
    await expireTimedOutOffers().catch(() => {});
    const deliveries = await Promise.all((await listDeliveries()).map(async (d) => ({
      ...d,
      history: await getDeliveryHistory(d.id),
    })));
    const riders = await getAllRiders();
    const customers = await getAllCustomers();
    const payments = await getAllPayments();
    const complaints = await getAllComplaints();
    const settings = await getPlatformSettings();

    res.json({
      deliveries,
      riders,
      customers,
      payments,
      complaints,
      settings,
    });
  }));

  // Admin: Manually assign or reassign rider
  app.post('/api/admin/deliveries/:id/assign', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const { riderId } = req.body || {};
    const now = new Date().toISOString();
    const outcome = await persistDispatchChange(async () => {
      const delivery = await getDeliveryById(req.params.id);
      if (!delivery) {
        return { errorStatus: 404, errorBody: { error: 'Delivery not found.' } } as const;
      }
      const rider = (await getAllRiders()).find((r) => r.riderId === riderId);
      if (!rider) {
        return { errorStatus: 404, errorBody: { error: 'Rider not found.' } } as const;
      }
      if (rider.accountStatus === 'suspended' || rider.verificationStatus !== 'verified') {
        return { errorStatus: 400, errorBody: { error: 'Cannot assign a suspended or unverified rider.' } } as const;
      }

      if (!['pending_dispatch', 'no_rider_available', 'assigned'].includes(delivery.status) || !canDispatch(delivery)) {
        return {
          errorStatus: 409,
          errorBody: { error: 'Only dispatchable parcels awaiting rider acceptance can be assigned.' },
        } as const;
      }
      const alreadyReserved = delivery.assignedRiderId === rider.riderId ? 1 : 0;
      if (rider.activeParcelsCount - alreadyReserved >= (await getPlatformSettings()).maxActiveParcelsPerRider) {
        return { errorStatus: 409, errorBody: { error: 'This rider has reached the active parcel limit.' } } as const;
      }

      const delUpd = await db.prepare(`
        UPDATE delivery_requests
        SET assigned_rider_id = ?, status = 'accepted', updated_at = ?
        WHERE id = ? AND status IN ('pending_dispatch', 'no_rider_available', 'assigned')
      `).run(rider.riderId, now, delivery.id);
      if (delUpd.changes === 0) {
        return {
          errorStatus: 409,
          errorBody: { error: 'Parcel state changed concurrently. Refresh and retry.' },
        } as const;
      }

      const replacedOffers = await db.prepare(
        `UPDATE delivery_assignments SET status = 'reassigned', responded_at = ? WHERE delivery_id = ? AND status = 'offered' RETURNING id`
      ).all(now, delivery.id) as Array<{ id: string }>;

      await db.prepare(`
        INSERT INTO delivery_assignments (
          id, delivery_id, rider_id, status, score, distance_to_pickup_km,
          route_compatibility_score, offered_at, expires_at, responded_at
        ) VALUES (?, ?, ?, 'accepted', 0, 0, 1.0, ?, ?, ?)
      `).run(`asg-${crypto.randomUUID().slice(0, 8)}`, delivery.id, rider.riderId, now, now, now);

      await db.prepare(`
        INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
        VALUES (?, ?, 'accepted', ?, 'admin', ?)
      `).run(
        `hist-${crypto.randomUUID().slice(0, 8)}`,
        delivery.id,
        `Admin manually assigned delivery to ${rider.fullName}.`,
        now
      );

      const custRow = await db
        .prepare('SELECT profile_id FROM customers WHERE id = ?')
        .get(delivery.customerId) as { profile_id: string } | undefined;
      const cNotif = custRow
        ? await createNotification(
            custRow.profile_id,
            'Rider Assigned',
            `${rider.fullName} (${rider.vehicleType}) has been assigned to parcel ${delivery.trackingCode}.`,
            delivery.id
          )
        : null;

      const rNotif = await createNotification(
        rider.id,
        'New Delivery Request Available',
        `Admin assigned ${delivery.trackingCode}: ${delivery.pickupAddress}, ${delivery.pickupState} → ${delivery.destinationAddress}, ${delivery.destinationState}.`,
        delivery.id
      );

      const updated = (await getDeliveryById(delivery.id))!;
      return { replacedOffers, cNotif, rNotif, updated } as const;
    });

    if ('errorStatus' in outcome && outcome.errorStatus !== undefined) {
      res.status(outcome.errorStatus).json(outcome.errorBody);
      return;
    }

    for (const offer of outcome.replacedOffers) clearOfferTimer(offer.id);
    if (outcome.cNotif) await broadcastWsEvent('notification:created', outcome.cNotif);
    await broadcastWsEvent('notification:created', outcome.rNotif);
    await broadcastWsEvent('delivery:updated', outcome.updated);
    await dispatchWaitingDeliveries();
    res.json({ delivery: outcome.updated });
  }));

  // Admin: Override or update delivery status for operational resolution
  app.patch('/api/admin/deliveries/:id/status', authenticate, requireRole('admin'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
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
    const requeue = nextStatus === 'pending_dispatch' || nextStatus === 'no_rider_available';
    const now = new Date().toISOString();

    const outcome = await persistDispatchChange(async () => {
      const delivery = await getDeliveryById(req.params.id);
      if (!delivery) {
        return { errorStatus: 404, errorBody: { error: 'Delivery not found.' } } as const;
      }
      if (['delivered', 'cancelled'].includes(delivery.status)) {
        return { errorStatus: 409, errorBody: { error: 'A finalized parcel cannot be moved to another status.' } } as const;
      }
      if (nextStatus === 'assigned' || (!requeue && nextStatus !== 'cancelled' && !delivery.assignedRiderId)) {
        return { errorStatus: 409, errorBody: { error: 'Use rider assignment before advancing the parcel.' } } as const;
      }

      const note =
        typeof req.body?.note === 'string' && req.body.note.trim()
          ? req.body.note.trim()
          : `SAQO Operations updated status to ${nextStatus.replace(/_/g, ' ')}.`;

      const statusUpdate = await db.prepare(`UPDATE delivery_requests
        SET status = ?, updated_at = ?, assigned_rider_id = CASE WHEN ? = 1 THEN NULL ELSE assigned_rider_id END
        WHERE id = ? AND status = ? AND status NOT IN ('delivered', 'cancelled')`).run(
        nextStatus,
        now,
        requeue ? 1 : 0,
        delivery.id,
        delivery.status
      );
      if (statusUpdate.changes === 0) {
        return { errorStatus: 409, errorBody: { error: 'Delivery status changed concurrently. Refresh and retry.' } } as const;
      }

      let clearedAssignmentIds: string[] = [];
      if (requeue || nextStatus !== 'cancelled') {
        const replaced = await db.prepare(`
          UPDATE delivery_assignments SET status = ?, responded_at = ?
          WHERE delivery_id = ? AND (status = 'offered' OR (? = 1 AND status = 'accepted'))
          RETURNING id
        `).all(requeue ? 'reassigned' : 'accepted', now, delivery.id, requeue ? 1 : 0) as Array<{ id: string }>;
        clearedAssignmentIds = replaced.map((a) => a.id);
      }
      await db.prepare(`
        INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
        VALUES (?, ?, ?, ?, 'admin', ?)
      `).run(`hist-${crypto.randomUUID().slice(0, 8)}`, delivery.id, nextStatus, note, now);

      if (nextStatus === 'delivered') {
        await db.prepare(`UPDATE payments SET status = 'settled' WHERE delivery_id = ?`).run(delivery.id);
        if (delivery.assignedRiderId) {
          const payment = await db
            .prepare('SELECT rider_payout_ngn FROM payments WHERE delivery_id = ?')
            .get(delivery.id) as { rider_payout_ngn: number } | undefined;
          await db.prepare(`
            UPDATE riders
            SET completed_deliveries_count = completed_deliveries_count + 1,
                total_earnings_ngn = total_earnings_ngn + ?
            WHERE id = ?
          `).run(payment?.rider_payout_ngn || 0, delivery.assignedRiderId);
        }
      } else if (nextStatus === 'cancelled') {
        const offered = await db
          .prepare(`SELECT id FROM delivery_assignments WHERE delivery_id = ? AND status = 'offered'`)
          .all(delivery.id) as Array<{ id: string }>;
        clearedAssignmentIds = clearedAssignmentIds.concat(offered.map((a) => a.id));
        await db.prepare(
          `UPDATE delivery_assignments SET status = 'reassigned', responded_at = ? WHERE delivery_id = ? AND status = 'offered'`
        ).run(now, delivery.id);
        if (delivery.paymentMethod === 'wallet' && delivery.paymentStatus === 'paid') {
          try {
            await processAdminRefund({
              deliveryId: delivery.id,
              amountNgn: delivery.deliveryFeeNgn,
              destination: 'wallet',
              reason: `Automatic wallet refund on admin delivery cancellation (${delivery.trackingCode})`,
              adminId: req.auth!.userId,
            });
          } catch {
            // Non-fatal fallback
          }
        } else if (delivery.paymentStatus !== 'paid' && delivery.paymentStatus !== 'collected_by_rider') {
          await cancelDeliveryPayments(delivery.id, {
            reason: `Delivery cancelled by operations (${delivery.trackingCode})`,
          });
        }
      }

      const custRow = await db
        .prepare('SELECT profile_id FROM customers WHERE id = ?')
        .get(delivery.customerId) as { profile_id: string } | undefined;
      const notif = custRow
        ? await createNotification(
            custRow.profile_id,
            `${delivery.trackingCode}: Status Updated`,
            note,
            delivery.id
          )
        : null;

      const updated = { ...(await getDeliveryById(delivery.id))!, history: await getDeliveryHistory(delivery.id) };
      return { clearedAssignmentIds, notif, updated } as const;
    });

    if ('errorStatus' in outcome && outcome.errorStatus !== undefined) {
      res.status(outcome.errorStatus).json(outcome.errorBody);
      return;
    }

    for (const assignmentId of outcome.clearedAssignmentIds) clearOfferTimer(assignmentId);
    if (outcome.notif) await broadcastWsEvent('notification:created', outcome.notif);
    await broadcastWsEvent('delivery:updated', outcome.updated);
    if (requeue || nextStatus === 'delivered' || nextStatus === 'cancelled') await dispatchWaitingDeliveries();
    res.json({ delivery: outcome.updated });
  }));

  // Admin: Issue a new Rider account
  app.post('/api/admin/riders', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
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
    const existing = await db.prepare('SELECT id FROM profiles WHERE LOWER(email) = ?').get(cleanEmail);
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

    await db.prepare(`
      INSERT INTO profiles (id, email, password_hash, full_name, phone, role, account_status, created_at)
      VALUES (?, ?, ?, ?, ?, 'rider', 'active', ?)
    `).run(profileId, cleanEmail, passHash, String(fullName).trim(), String(phone).trim(), now);

    const initialOnline = cleanVerify === 'verified' ? 1 : 0;
    await db.prepare(`
      INSERT INTO riders (
        id, profile_id, vehicle_type, plate_number, home_state, verification_status,
        is_online, current_lat, current_lng, last_location_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      riderId,
      profileId,
      cleanVehicle,
      String(plateNumber).trim().toUpperCase(),
      cleanState,
      cleanVerify,
      initialOnline,
      hub.lat,
      hub.lng,
      now
    );

    const created = (await getRiderByProfileId(profileId))!;
    await broadcastWsEvent('rider:availability', created);
    if (initialOnline === 1) await dispatchWaitingDeliveries();
    res.status(201).json({ rider: created, riders: await getAllRiders() });
  }));

  // Admin: Update rider vehicle/state/contact info
  app.patch('/api/admin/riders/:id', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const { fullName, phone, homeState, vehicleType, plateNumber } = req.body || {};
    if (phone && String(phone).replace(/\D/g, '').length < 10) {
      res.status(400).json({ error: 'Please enter a valid phone number (at least 10 digits).' });
      return;
    }

    const outcome = await persistDispatchChange(async () => {
      const existing = (await getAllRiders()).find((r) => r.riderId === req.params.id);
      if (!existing) {
        return { errorStatus: 404, errorBody: { error: 'Rider not found.' } } as const;
      }
      const validVehicles = ['Motorcycle', 'Van', 'Inter-State Sprinter'];
      const nextVehicle = validVehicles.includes(vehicleType) ? vehicleType : existing.vehicleType;
      const nextState = homeState || existing.homeState;
      const nextPlate = plateNumber ? String(plateNumber).trim().toUpperCase() : existing.plateNumber;
      const nextName = fullName ? String(fullName).trim() : existing.fullName;
      const nextPhone = phone ? String(phone).trim() : existing.phone;

      await db.prepare(`UPDATE profiles SET full_name = ?, phone = ? WHERE id = ?`).run(
        nextName,
        nextPhone,
        existing.id
      );
      await db.prepare(
        `UPDATE riders SET vehicle_type = ?, plate_number = ?, home_state = ? WHERE id = ?`
      ).run(nextVehicle, nextPlate, nextState, existing.riderId);

      const updated = (await getRiderByProfileId(existing.id))!;
      const riders = await getAllRiders();
      return { updated, riders } as const;
    });

    if ('errorStatus' in outcome && outcome.errorStatus !== undefined) {
      res.status(outcome.errorStatus).json(outcome.errorBody);
      return;
    }

    await broadcastWsEvent('rider:availability', outcome.updated);
    res.json({ rider: outcome.updated, riders: outcome.riders });
  }));

  // Admin: Enable or revoke rider verification tick
  app.patch('/api/admin/riders/:id/verify', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const status = req.body?.verificationStatus;
    if (!['verified', 'pending', 'rejected'].includes(status)) {
      res.status(400).json({ error: 'Invalid verification status.' });
      return;
    }
    const now = new Date().toISOString();
    const outcome = await persistDispatchChange(async () => {
      const rider = (await getAllRiders()).find((r) => r.riderId === req.params.id);
      if (!rider) {
        return { errorStatus: 404, errorBody: { error: 'Rider not found.' } } as const;
      }
      await db.prepare('UPDATE riders SET verification_status = ?, is_online = ? WHERE id = ?').run(
        status,
        status === 'verified' ? 1 : 0,
        req.params.id
      );
      const released = status !== 'verified'
        ? await releaseOpenOffersForRider(rider.riderId, now)
        : { clearedOfferIds: [], releasedCount: 0 };

      const updatedRider = (await getRiderByProfileId(rider.id))!;
      const notif = await createNotification(
        rider.id,
        status === 'verified' ? 'Verification Tick Enabled' : 'Verification Status Updated',
        status === 'verified'
          ? 'Your SAQO rider verification tick is now active and you are online to accept deliveries.'
          : `Your rider verification status is now set to ${status}. Contact SAQO Operations for details.`,
        null
      );
      const riders = await getAllRiders();
      return { updatedRider, notif, riders, ...released } as const;
    });

    if ('errorStatus' in outcome && outcome.errorStatus !== undefined) {
      res.status(outcome.errorStatus).json(outcome.errorBody);
      return;
    }

    for (const id of outcome.clearedOfferIds) clearOfferTimer(id);
    await broadcastWsEvent('notification:created', outcome.notif);
    await broadcastWsEvent('rider:availability', outcome.updatedRider);
    if (status === 'verified' || outcome.releasedCount > 0) await dispatchWaitingDeliveries();
    res.json({ rider: outcome.updatedRider, riders: outcome.riders });
  }));

  // Admin: Suspend or activate account (customer or rider)
  app.patch('/api/admin/profiles/:id/status', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const status = req.body?.accountStatus;
    if (!['active', 'suspended'].includes(status)) {
      res.status(400).json({ error: 'Invalid account status.' });
      return;
    }

    const now = new Date().toISOString();
    const outcome = await persistDispatchChange(async () => {
      await db.prepare('UPDATE profiles SET account_status = ? WHERE id = ?').run(status, req.params.id);
      let clearedOfferIds: string[] = [];
      let releasedCount = 0;

      if (status === 'suspended') {
        const riderRow = await db
          .prepare('SELECT id FROM riders WHERE profile_id = ?')
          .get(req.params.id) as { id: string } | undefined;
        await db.prepare('UPDATE riders SET is_online = 0 WHERE profile_id = ?').run(req.params.id);
        if (riderRow) {
          const released = await releaseOpenOffersForRider(riderRow.id, now);
          clearedOfferIds = released.clearedOfferIds;
          releasedCount = released.releasedCount;
        }
      }

      const riderProfile = await getRiderByProfileId(req.params.id);
      return { clearedOfferIds, releasedCount, riderProfile } as const;
    });

    for (const id of outcome.clearedOfferIds) clearOfferTimer(id);
    if (outcome.riderProfile) await broadcastWsEvent('rider:availability', outcome.riderProfile);
    if (outcome.releasedCount > 0) await dispatchWaitingDeliveries();
    res.json({ ok: true });
  }));

  // Admin: Reset password for a rider or customer account
  app.patch('/api/admin/profiles/:id/reset-password', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (newPassword.length < 6) {
      res.status(400).json({ error: 'New password must be at least 6 characters.' });
      return;
    }
    const target = await getProfileById(req.params.id);
    if (!target) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    if (target.role === 'admin') {
      res.status(403).json({ error: 'Admin password cannot be reset via this endpoint.' });
      return;
    }
    await db.prepare('UPDATE profiles SET password_hash = ? WHERE id = ?').run(
      hashPassword(newPassword),
      target.id
    );
    res.json({ ok: true });
  }));

  // Admin: Update platform settings
  app.patch('/api/admin/settings', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const current = await getPlatformSettings();
    const b = req.body || {};
    const maxActiveParcelsPerRider = Number(b.maxActiveParcelsPerRider ?? current.maxActiveParcelsPerRider);
    if (!Number.isSafeInteger(maxActiveParcelsPerRider) || maxActiveParcelsPerRider < 1) {
      res.status(400).json({ error: 'The active parcel limit must be a positive whole number.' });
      return;
    }
    const next = {
      maxActiveParcelsPerRider,
      showDeliveryStateSelectors: typeof b.showDeliveryStateSelectors === 'boolean'
        ? b.showDeliveryStateSelectors : current.showDeliveryStateSelectors,
      searchRadiusKm: Math.max(5, Number(b.searchRadiusKm ?? current.searchRadiusKm)),
      offerTimeoutSeconds: Math.max(10, Number(b.offerTimeoutSeconds ?? current.offerTimeoutSeconds)),
      baseLocalFeeNgn: Math.max(300, Number(b.baseLocalFeeNgn ?? current.baseLocalFeeNgn)),
      perKmRateNgn: Math.max(10, Number(b.perKmRateNgn ?? current.perKmRateNgn)),
      interStateSurchargeNgn: Math.max(0, Number(b.interStateSurchargeNgn ?? current.interStateSurchargeNgn)),
      riderCommissionPercent: Math.min(95, Math.max(40, Number(b.riderCommissionPercent ?? current.riderCommissionPercent))),
      whatsappSupportNumber: String(b.whatsappSupportNumber ?? current.whatsappSupportNumber).replace(/[^\d]/g, ''),
    };

    await db.prepare(`
      UPDATE platform_settings SET
        max_active_parcels_per_rider = ?,
        search_radius_km = ?,
        offer_timeout_seconds = ?,
        base_local_fee_ngn = ?,
        per_km_rate_ngn = ?,
        inter_state_surcharge_ngn = ?,
        rider_commission_percent = ?,
        whatsapp_support_number = ?,
        show_delivery_state_selectors = ?
      WHERE id = 1
    `).run(
      next.maxActiveParcelsPerRider,
      next.searchRadiusKm,
      next.offerTimeoutSeconds,
      next.baseLocalFeeNgn,
      next.perKmRateNgn,
      next.interStateSurchargeNgn,
      next.riderCommissionPercent,
      next.whatsappSupportNumber,
      Number(next.showDeliveryStateSelectors)
    );

    await broadcastWsEvent('settings:updated', next);
    await dispatchWaitingDeliveries();
    res.json({ settings: next });
  }));

  // Admin: Payments & Wallet Management Overview (metrics + paginated transactions + wallets + cash collections + refunds + webhooks + audit logs)
  app.get('/api/admin/payments/overview', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const overview = await getAdminPaymentsOverview({
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      method: typeof req.query.method === 'string' ? req.query.method : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      purpose: typeof req.query.purpose === 'string' ? req.query.purpose : undefined,
      dateFrom: typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
      dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 15,
    });
    res.json({ ...overview, auditLogs: await getWalletAuditLogs(60) });
  }));

  // Admin: Export filtered payment transactions as CSV
  app.get('/api/admin/payments/export', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const csv = await exportPaymentsCsv({
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      method: typeof req.query.method === 'string' ? req.query.method : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      purpose: typeof req.query.purpose === 'string' ? req.query.purpose : undefined,
      dateFrom: typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
      dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="saqo-payments-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }));

  // Admin: Inspect individual customer's wallet balance & ledger
  app.get('/api/admin/customers/:profileId/wallet', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    try {
      const profile = await getProfileById(req.params.profileId);
      if (!profile) {
        res.status(404).json({ error: 'Customer profile not found.' });
        return;
      }
      const summary = await getCustomerWalletSummary(profile.id);
      const auditLogs = (await getWalletAuditLogs(100)).filter((l) => l.userId === profile.id);
      res.json({ profile, ...summary, auditLogs });
    } catch (err) {
      sendPaymentError(res, err);
    }
  }));

  // Admin: Adjust wallet balance with mandatory reason & audit trail
  app.post('/api/admin/wallets/:walletId/adjust', authenticate, requireRole('admin'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    try {
      const { direction, amountNgn, reason, idempotencyKey } = req.body || {};
      if (!['credit', 'debit'].includes(direction)) {
        res.status(400).json({ error: 'Direction must be credit or debit.' });
        return;
      }
      const actor = await getProfileById(req.auth!.userId);
      const result = await adjustWalletAtomic({
        walletId: req.params.walletId,
        direction,
        amountNgn: Number(amountNgn),
        reason: String(reason || ''),
        actorId: req.auth!.userId,
        actorName: actor?.fullName || 'SAQO Admin',
        idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : null,
      });
      res.json(result);
    } catch (err) {
      sendPaymentError(res, err);
    }
  }));

  // Admin: Reconcile or dispute cash on delivery / bank transfer collection
  app.post('/api/admin/cash-collections/:id/reconcile', authenticate, requireRole('admin'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    try {
      const { action, collectedAmountNgn, notes } = req.body || {};
      if (!['reconcile', 'dispute'].includes(action)) {
        res.status(400).json({ error: 'Action must be reconcile or dispute.' });
        return;
      }
      const updated = await reconcileCashOrBankCollection({
        collectionId: req.params.id,
        action,
        adminId: req.auth!.userId,
        collectedAmountNgn: collectedAmountNgn !== undefined ? Number(collectedAmountNgn) : undefined,
        notes: typeof notes === 'string' ? notes : undefined,
      });
      res.json({ cashCollection: updated });
    } catch (err) {
      sendPaymentError(res, err);
    }
  }));

  // Admin: Manually trigger server-side Flutterwave verification for a pending payment
  app.post('/api/admin/payments/:id/verify', authenticate, requireRole('admin'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    try {
      const row = await db
        .prepare('SELECT id, reference, provider_tx_id FROM payment_transactions WHERE id = ? OR reference = ?')
        .get(req.params.id, req.params.id) as { id: string; reference: string; provider_tx_id: string | null } | undefined;
      if (!row) {
        res.status(404).json({ error: 'Payment transaction not found.' });
        return;
      }
      const result = await confirmFlutterwaveTransaction({
        transactionId: row.provider_tx_id,
        txRef: row.reference,
        verifiedByUserId: req.auth!.userId,
        source: 'admin_verify',
      });
      res.json(result);
    } catch (err) {
      sendPaymentError(res, err);
    }
  }));

  // Admin: Issue refund (to customer wallet, Flutterwave, or manual)
  app.post('/api/admin/refunds', authenticate, requireRole('admin'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    try {
      const { paymentTransactionId, deliveryId, amountNgn, destination, reason } = req.body || {};
      if (!['wallet', 'flutterwave', 'manual'].includes(destination)) {
        res.status(400).json({ error: 'Refund destination must be wallet, flutterwave, or manual.' });
        return;
      }
      const refund = await processAdminRefund({
        paymentTransactionId: typeof paymentTransactionId === 'string' ? paymentTransactionId : undefined,
        deliveryId: typeof deliveryId === 'string' ? deliveryId : undefined,
        amountNgn: Number(amountNgn),
        destination,
        reason: String(reason || ''),
        adminId: req.auth!.userId,
      });
      res.status(201).json({ refund });
    } catch (err) {
      sendPaymentError(res, err);
    }
  }));

  app.post('/api/admin/refunds/:id/verify', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    try {
      res.json({ status: await refreshFlutterwaveRefund(req.params.id) });
    } catch (err) {
      sendPaymentError(res, err);
    }
  }));

  // Admin: View Payment Gateway (Flutterwave & Bank Account) Settings (secrets strictly masked!)
  app.get('/api/admin/gateway-settings', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    try {
      res.set('Cache-Control', 'no-store').json(await getGatewayAdminView(getWebhookOrigin(req)));
    } catch (error) {
      sendPaymentError(res, error);
    }
  }));

  // Admin: Update Payment Gateway Settings (secrets encrypted at rest, never logged or returned)
  app.patch('/api/admin/gateway-settings', authenticate, requireRole('admin'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    try {
      const updated = await updateGatewaySettings(
        req.body || {},
        req.auth!.userId,
        getWebhookOrigin(req)
      );
      res.json(updated);
    } catch (err) {
      sendPaymentError(res, err);
    }
  }));

  // Admin: Resolve / update complaint or suggestion ticket & notify reporter
  app.patch('/api/admin/complaints/:id', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const { status, resolutionNote } = req.body || {};
    if (!['open', 'investigating', 'resolved'].includes(status)) {
      res.status(400).json({ error: 'Invalid ticket status.' });
      return;
    }
    const existing = (await getAllComplaints()).find((c) => c.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Ticket not found.' });
      return;
    }
    await db.prepare('UPDATE complaints SET status = ?, resolution_note = ? WHERE id = ?').run(
      status,
      resolutionNote || null,
      req.params.id
    );
    const notif = await createNotification(
      existing.reporterId,
      `Ticket ${status === 'resolved' ? 'Resolved' : 'Updated'}`,
      `${existing.subject}: ${resolutionNote || `Status updated to ${status}.`}`,
      existing.deliveryId
    );
    await broadcastWsEvent('notification:created', notif);
    await broadcastWsEvent('complaint:updated', { id: req.params.id, status });
    res.json({ complaints: await getAllComplaints() });
  }));

  // --- Live Persistent Support Chat API ---

  // Public: Admin online presence
  app.get('/api/support/presence', asyncRoute(async (_req: SaqoRequest, res: SaqoResponse) => {
    res.set('Cache-Control', 'no-store').json(await getSupportPresenceAsync());
  }));

  // Visitor / Client: List persistent conversations
  app.get('/api/support/conversations', asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const auth = await tryAuthenticate(req);
    const visitorToken =
      typeof req.query.visitorToken === 'string' ? req.query.visitorToken.trim() : null;
    if (!auth && !visitorToken) {
      res.json({ conversations: [], presence: await getSupportPresenceAsync() });
      return;
    }
    const conversations = await getSupportConversationsForVisitor({
      visitorToken,
      userId: auth?.userId || null,
    });
    res.json({ conversations, presence: await getSupportPresenceAsync() });
  }));

  // Visitor / Client: Start new persistent support conversation
  app.post('/api/support/conversations', asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const auth = await tryAuthenticate(req);
    const profile = auth ? await getProfileById(auth.userId) : null;
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

    const created = await createSupportConversation({
      visitorToken: cleanToken,
      userId: profile?.id || null,
      visitorName: cleanName,
      visitorEmail: profile?.email || visitorEmail || null,
      visitorPhone: profile?.phone || visitorPhone || null,
      trackingCode: trackingCode || null,
      initialMessage: cleanMsg,
      senderRole: profile ? 'client' : 'visitor',
    });

    await broadcastWsEvent('support:conversation', created.conversation);
    await broadcastWsEvent('support:message', created.message);
    res.status(201).json({
      conversation: created.conversation,
      message: created.message,
      messages: [created.message],
      presence: await getSupportPresenceAsync(),
    });
  }));

  // Visitor / Client: Load conversation messages (never auto-deleted)
  app.get('/api/support/conversations/:id/messages', asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const auth = await tryAuthenticate(req);
    const visitorToken =
      typeof req.query.visitorToken === 'string' ? req.query.visitorToken.trim() : '';
    const conv = await getSupportConversationById(req.params.id);
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
        : await markSupportConversationRead(conv.id, 'visitor') || conv;
    res.json({
      conversation: updatedConv,
      messages: await getSupportMessages(conv.id),
      presence: await getSupportPresenceAsync(),
    });
  }));

  // Visitor / Client: Send message in existing conversation
  app.post('/api/support/conversations/:id/messages', asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const auth = await tryAuthenticate(req);
    const profile = auth ? await getProfileById(auth.userId) : null;
    const { visitorToken, body } = req.body || {};
    const conv = await getSupportConversationById(req.params.id);
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

    const result = await addSupportMessage({
      conversationId: conv.id,
      senderRole: profile ? 'client' : 'visitor',
      senderName: profile?.fullName || conv.visitorName,
      body: cleanBody,
    });
    await broadcastWsEvent('support:message', result.message);
    await broadcastWsEvent('support:conversation', result.conversation);
    res.status(201).json({
      conversation: result.conversation,
      message: result.message,
    });
  }));

  // Visitor / Client: Mark conversation read
  app.post('/api/support/conversations/:id/read', asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const auth = await tryAuthenticate(req);
    const visitorToken =
      typeof req.body?.visitorToken === 'string' ? req.body.visitorToken.trim() : '';
    const conv = await getSupportConversationById(req.params.id);
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
    const updated = await markSupportConversationRead(conv.id, 'visitor');
    if (updated) {
      await broadcastWsEvent('support:conversation', updated);
    }
    res.json({ conversation: updated });
  }));

  // Visitor / Client: Resolve or reopen own conversation
  app.patch('/api/support/conversations/:id/status', asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const auth = await tryAuthenticate(req);
    const profile = auth ? await getProfileById(auth.userId) : null;
    const { visitorToken, status } = req.body || {};
    if (!['open', 'resolved'].includes(status)) {
      res.status(400).json({ error: 'Invalid status.' });
      return;
    }
    const conv = await getSupportConversationById(req.params.id);
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
    const updated = await updateSupportConversationStatus(
      conv.id,
      status as SupportConversationStatus,
      profile?.fullName || conv.visitorName
    );
    if (updated) {
      await broadcastWsEvent('support:message', updated.systemMessage);
      await broadcastWsEvent('support:conversation', updated.conversation);
    }
    res.json(updated);
  }));

  // Admin: List all support conversations + presence state
  app.get('/api/admin/support/conversations', authenticate, requireRole('admin'), asyncRoute(async (_req: SaqoRequest, res: SaqoResponse) => {
    const [accepting, presence, conversations] = await Promise.all([
      isAdminChatAvailableFlagAsync(),
      getSupportPresenceAsync(),
      getAllSupportConversations(),
    ]);
    res.json({
      conversations,
      presence,
      adminAcceptingChats: accepting,
    });
  }));

  // Admin: Toggle online/away availability for live support chat
  app.post('/api/admin/support/presence', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const available = Boolean(req.body?.available);
    const presence = await setAdminChatAvailability(available);
    res.json({ presence, adminAcceptingChats: await isAdminChatAvailableFlagAsync() });
  }));

  // Admin: Load messages for a conversation & mark read
  app.get('/api/admin/support/conversations/:id/messages', authenticate, requireRole('admin'), asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const conv = await getSupportConversationById(req.params.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    const updatedConv = await markSupportConversationRead(conv.id, 'admin') || conv;
    await broadcastWsEvent('support:conversation', updatedConv);
    res.json({
      conversation: updatedConv,
      messages: await getSupportMessages(conv.id),
    });
  }));

  // Admin: Send reply message in a support conversation
  app.post('/api/admin/support/conversations/:id/messages', authenticate, requireRole('admin'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    const adminProfile = await getProfileById(req.auth!.userId);
    const conv = await getSupportConversationById(req.params.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    const cleanBody = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!cleanBody) {
      res.status(400).json({ error: 'Reply message cannot be empty.' });
      return;
    }
    try {
      await sendWhatsAppSupportReply(conv.id, cleanBody);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : 'WhatsApp reply could not be sent.' });
      return;
    }
    const result = await addSupportMessage({
      conversationId: conv.id,
      senderRole: 'admin',
      senderName: adminProfile?.fullName || 'SAQO Support Agent',
      body: cleanBody,
      assignedAdminId: req.auth!.userId,
    });
    if (conv.userId) {
      const notif = await createNotification(
        conv.userId,
        'New Support Reply',
        `SAQO Support: ${cleanBody.slice(0, 120)}`,
        null
      );
      await broadcastWsEvent('notification:created', notif);
    }
    await broadcastWsEvent('support:message', result.message);
    await broadcastWsEvent('support:conversation', result.conversation);
    res.status(201).json(result);
  }));

  // Admin: Update support conversation status (open | pending | resolved | closed)
  app.patch('/api/admin/support/conversations/:id', authenticate, requireRole('admin'), asyncRoute(async (req: AuthedRequest, res: SaqoResponse) => {
    const { status } = req.body || {};
    if (!['open', 'pending', 'resolved', 'closed'].includes(status)) {
      res.status(400).json({ error: 'Invalid conversation status.' });
      return;
    }
    const adminProfile = await getProfileById(req.auth!.userId);
    const result = await updateSupportConversationStatus(
      req.params.id,
      status as SupportConversationStatus,
      adminProfile?.fullName || 'SAQO Support'
    );
    if (!result) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    await broadcastWsEvent('support:message', result.systemMessage);
    await broadcastWsEvent('support:conversation', result.conversation);
    res.json(result);
  }));

  // Internal scheduled dispatch sweep (called by pg_cron + pg_net with HMAC-derived secret)
  app.post('/api/internal/dispatch-tick', asyncRoute(async (req: SaqoRequest, res: SaqoResponse) => {
    const key = process.env.SAQO_CRON_SECRET?.trim() || process.env.SAQO_SESSION_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    const expected = key ? crypto.createHmac('sha256', key).update('saqo-dispatch-tick').digest('hex') : '';
    const provided = (req.get('X-Saqo-Cron-Secret') || '').trim();
    if (!expected || !provided || provided.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      res.status(403).json({ error: 'Invalid cron authorization.' });
      return;
    }
    const expiredCount = await expireTimedOutOffers(true);
    await dispatchWaitingDeliveries();
    res.json({ ok: true, expiredCount });
  }));

  app.use('/api', (_req: SaqoRequest, res: SaqoResponse) => { res.status(404).json({ error: 'API route not found.' }); });
  app.use((error: unknown, _req: SaqoRequest, res: SaqoResponse, next: NextFn) => {
    if (res.headersSent) { next(error); return; }
    const status = (error as { status?: number } | null)?.status;
    if (status === 400 || status === 413) {
      res.status(status).json({ error: status === 413 ? 'Request body is too large.' : 'Invalid request body.' });
      return;
    }
    console.error('API request failed:', error);
    res.status(500).json({ error: 'Unexpected server error.' });
  });
}
