import crypto from 'node:crypto';
import { calculateRiderPayoutNgn } from '../shared/pricing';
import type { PaymentMethodCode, PriceQuote } from '../shared/types';
import { db } from './db';

interface BookingDetails {
  customerId: string;
  pickupState: string;
  pickupAddress: string;
  pCoords: { lat: number; lng: number };
  destinationState: string;
  destinationAddress: string;
  dCoords: { lat: number; lng: number };
  recipientName: string;
  recipientPhone: string;
  parcelCategory?: string;
  parcelDescription: string;
  weightKg: number;
  paymentMethod: PaymentMethodCode;
  quote: PriceQuote;
  riderCommissionPercent: number;
}

export function createBookingRows(details: BookingDetails) {
  const {
    customerId, pickupState, pickupAddress, pCoords, destinationState, destinationAddress, dCoords,
    recipientName, recipientPhone, parcelCategory, parcelDescription, weightKg,
    paymentMethod, quote, riderCommissionPercent,
  } = details;
  const deliveryId = `del-${crypto.randomUUID().slice(0, 8)}`;
  const trackingCode = `SQ-${new Date().getUTCFullYear()}-${crypto.randomBytes(9).toString('hex').toUpperCase()}`;
  const otp = String(crypto.randomInt(1000, 10000));
  const now = new Date().toISOString();
  const initialPayStatus =
    paymentMethod === 'wallet'
      ? 'paid'
      : paymentMethod === 'bank_transfer'
        ? 'pending_verification'
        : 'pending';

  db.prepare(`
    INSERT INTO delivery_requests (
      id, tracking_code, customer_id, pickup_state, pickup_address, pickup_lat, pickup_lng,
      destination_state, destination_address, destination_lat, destination_lng,
      recipient_name, recipient_phone, service_tier, distance_km, estimated_minutes,
      delivery_fee_ngn, payment_method, payment_status, delivery_otp, otp_verified, status, assigned_rider_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending_dispatch', NULL, ?, ?)
  `).run(
    deliveryId,
    trackingCode,
    customerId,
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
    paymentMethod,
    initialPayStatus,
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
    weightKg
  );

  const riderPayout = calculateRiderPayoutNgn(
    quote.deliveryFeeNgn,
    riderCommissionPercent
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
    `Parcel request created (${quote.serviceTier.replace('_', ' ')} · ${quote.distanceKm} km · ${paymentMethod.replace('_', ' ')}).`,
    now
  );
  return { deliveryId, trackingCode, otp };
}
