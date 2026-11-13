import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, computeRouteCompatibility } from './geo';
import {
  calculateDeliveryQuote,
  calculateRiderPayoutNgn,
  classifyServiceTier,
  DEFAULT_PLATFORM_SETTINGS,
  isValidNigerianPhone,
  matchesDeliveryOtp,
} from './pricing';
import { rankEligibleRiders } from './dispatch';
import { formatDeliveryStatusLabel, getTrackingProgress } from './tracking';
import type { DeliveryRequest, RiderProfile } from './types';

function makeRider(overrides: Partial<RiderProfile> = {}): RiderProfile {
  return {
    id: 'u-1',
    riderId: 'r-1',
    email: 'rider@saqo.ng',
    fullName: 'Tunde Bakare',
    phone: '+2348011112222',
    role: 'rider',
    accountStatus: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    vehicleType: 'Motorcycle',
    plateNumber: 'LAG-412-XY',
    homeState: 'Lagos',
    verificationStatus: 'verified',
    isOnline: true,
    currentLat: 6.5244,
    currentLng: 3.3792,
    lastLocationAt: '2026-01-01T00:00:00Z',
    activeParcelsCount: 0,
    completedDeliveriesCount: 12,
    totalEarningsNgn: 48000,
    rating: 4.9,
    ...overrides,
  };
}

function makeDelivery(overrides: Partial<DeliveryRequest> = {}): DeliveryRequest {
  return {
    id: 'd-1',
    trackingCode: 'SQ-2026-1001',
    customerId: 'c-1',
    customerName: 'Amaka Okafor',
    customerPhone: '+2348099990000',
    pickupState: 'Lagos',
    pickupAddress: '12 Admiralty Way, Lekki Phase 1',
    pickupLat: 6.4474,
    pickupLng: 3.4723,
    destinationState: 'Oyo',
    destinationAddress: '45 Ring Road, Ibadan',
    destinationLat: 7.3775,
    destinationLng: 3.9470,
    recipientName: 'Chidi Obi',
    recipientPhone: '+2348088887777',
    parcelCategory: 'Documents',
    parcelDescription: 'Legal contract envelope',
    weightKg: 1,
    serviceTier: 'inter_state',
    distanceKm: 132,
    estimatedMinutes: 170,
    deliveryFeeNgn: 13900,
    deliveryOtp: '4821',
    otpVerified: false,
    status: 'pending_dispatch',
    assignedRiderId: null,
    assignedRiderName: null,
    assignedRiderPhone: null,
    assignedRiderVehicle: null,
    assignedRiderLat: null,
    assignedRiderLng: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

test('geo: haversine distance Lagos to Ibadan is realistic (~100-130km)', () => {
  const km = haversineKm(6.5244, 3.3792, 7.3775, 3.9470);
  assert.ok(km > 105 && km < 130, `Expected 105..130km, got ${km}`);
});

test('pricing: distinguishes local 15-min target vs inter-state without applying 15-min target to long-haul', () => {
  assert.equal(classifyServiceTier('Lagos', 'Lagos', 8), 'local');
  assert.equal(classifyServiceTier('Lagos', 'Lagos', 42), 'inter_city');
  assert.equal(classifyServiceTier('Lagos', 'FCT Abuja', 540), 'inter_state');

  const localQuote = calculateDeliveryQuote({
    pickupState: 'Katsina',
    pickupLat: 12.9818,
    pickupLng: 7.6122,
    destinationState: 'Katsina',
    destinationLat: 12.9056,
    destinationLng: 7.6011,
    weightKg: 1.5,
  });
  assert.equal(localQuote.serviceTier, 'local');
  assert.equal(localQuote.deliveryFeeNgn, 600);
  assert.ok(localQuote.estimatedMinutes <= 24);

  const interStateQuote = calculateDeliveryQuote({
    pickupState: 'Lagos',
    pickupLat: 6.5244,
    pickupLng: 3.3792,
    destinationState: 'FCT Abuja',
    destinationLat: 9.0765,
    destinationLng: 7.3986,
    weightKg: 3,
  });
  assert.equal(interStateQuote.serviceTier, 'inter_state');
  assert.ok(interStateQuote.estimatedMinutes > 180);
  assert.ok(interStateQuote.deliveryFeeNgn > localQuote.deliveryFeeNgn);
});

test('dispatch: excludes offline, unverified, suspended, at-capacity, and rejected riders', () => {
  const delivery = makeDelivery({
    pickupLat: 6.5244,
    pickupLng: 3.3792,
    pickupState: 'Lagos',
    destinationLat: 7.3775,
    destinationLng: 3.9470,
    destinationState: 'Oyo',
  });

  const offline = makeRider({ riderId: 'r-offline', isOnline: false });
  const unverified = makeRider({ riderId: 'r-unverified', verificationStatus: 'pending' });
  const suspended = makeRider({ riderId: 'r-suspended', accountStatus: 'suspended' });
  const fullCapacity = makeRider({ riderId: 'r-full' });
  const rejected = makeRider({ riderId: 'r-rejected' });
  const eligible = makeRider({ riderId: 'r-ok' });

  const ranked = rankEligibleRiders({
    delivery,
    settings: { ...DEFAULT_PLATFORM_SETTINGS, maxActiveParcelsPerRider: 2 },
    excludedRiderIds: ['r-rejected'],
    candidates: [
      { rider: offline, activeDeliveries: [] },
      { rider: unverified, activeDeliveries: [] },
      { rider: suspended, activeDeliveries: [] },
      { rider: fullCapacity, activeDeliveries: [makeDelivery(), makeDelivery({ id: 'd-2' })] },
      { rider: rejected, activeDeliveries: [] },
      { rider: eligible, activeDeliveries: [] },
    ],
  });

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].rider.riderId, 'r-ok');
});

test('dispatch: balances proximity against workload and route compatibility', () => {
  const delivery = makeDelivery({
    pickupLat: 6.5244,
    pickupLng: 3.3792,
    pickupState: 'Lagos',
    destinationLat: 7.3775,
    destinationLng: 3.9470,
    destinationState: 'Oyo',
    serviceTier: 'inter_state',
  });

  // Rider A is slightly closer (0km) but heavily loaded (2/3) heading opposite direction (to Rivers/SE)
  const riderBusyOpposite = makeRider({
    riderId: 'r-busy-opp',
    currentLat: 6.5244,
    currentLng: 3.3792,
  });

  // Rider B is 4km away, has 1 parcel already heading to Oyo (route compatibility = 1.0)
  const riderAligned = makeRider({
    riderId: 'r-aligned',
    currentLat: 6.555,
    currentLng: 3.395,
  });

  const compatAligned = computeRouteCompatibility(
    { lat: 6.5244, lng: 3.3792, state: 'Lagos' },
    { lat: 7.3775, lng: 3.9470, state: 'Oyo' },
    [
      {
        pickupLat: 6.50,
        pickupLng: 3.35,
        destinationLat: 7.3775,
        destinationLng: 3.9470,
        destinationState: 'Oyo',
      },
    ]
  );
  assert.equal(compatAligned, 1.0);

  const ranked = rankEligibleRiders({
    delivery,
    settings: { ...DEFAULT_PLATFORM_SETTINGS, maxActiveParcelsPerRider: 3 },
    candidates: [
      {
        rider: riderBusyOpposite,
        activeDeliveries: [
          makeDelivery({
            id: 'opp-1',
            pickupLat: 6.52,
            pickupLng: 3.38,
            destinationLat: 4.8156,
            destinationLng: 7.0498,
            destinationState: 'Rivers',
          }),
          makeDelivery({
            id: 'opp-2',
            pickupLat: 6.52,
            pickupLng: 3.38,
            destinationLat: 4.8156,
            destinationLng: 7.0498,
            destinationState: 'Rivers',
          }),
        ],
      },
      {
        rider: riderAligned,
        activeDeliveries: [
          makeDelivery({
            id: 'aln-1',
            pickupLat: 6.50,
            pickupLng: 3.35,
            destinationLat: 7.3775,
            destinationLng: 3.9470,
            destinationState: 'Oyo',
          }),
        ],
      },
    ],
  });

  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].rider.riderId, 'r-aligned');
});

test('tracking: computes 5-stage milestone progress and exception states accurately', () => {
  const inTransit = getTrackingProgress('in_transit');
  assert.equal(inTransit.steps.length, 5);
  assert.equal(inTransit.isException, false);
  assert.equal(inTransit.steps[0].state, 'completed');
  assert.equal(inTransit.steps[2].state, 'completed');
  assert.equal(inTransit.steps[3].state, 'current');
  assert.equal(inTransit.steps[4].state, 'upcoming');
  assert.equal(inTransit.percent, 82);

  const delivered = getTrackingProgress('delivered');
  assert.equal(delivered.percent, 100);
  assert.ok(delivered.steps.every((s) => s.state === 'completed'));

  const cancelled = getTrackingProgress('cancelled');
  assert.equal(cancelled.isException, true);
  assert.equal(cancelled.exceptionLabel, 'Delivery Cancelled');

  assert.equal(formatDeliveryStatusLabel('parcel_picked_up'), 'Parcel Picked Up');
  assert.equal(formatDeliveryStatusLabel('no_rider_available'), 'Awaiting Rider');
});

test('pricing & handoff helpers: validates rider payout, Nigerian phones, and 4-digit OTPs', () => {
  assert.equal(calculateRiderPayoutNgn(600, 75), 450);
  assert.equal(calculateRiderPayoutNgn(1200, 80), 960);

  assert.equal(isValidNigerianPhone('+234 803 123 4567'), true);
  assert.equal(isValidNigerianPhone('08031234567'), true);
  assert.equal(isValidNigerianPhone('12345'), false);

  assert.equal(matchesDeliveryOtp('4821', '4821'), true);
  assert.equal(matchesDeliveryOtp(' 4821 ', '4821'), true);
  assert.equal(matchesDeliveryOtp('9999', '4821'), false);
  assert.equal(matchesDeliveryOtp('482', '4821'), false);
  assert.equal(matchesDeliveryOtp('abcd', 'abcd'), false);
});

