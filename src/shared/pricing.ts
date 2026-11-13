import { haversineKm } from './geo';
import type { PlatformSettings, PriceQuote, ServiceTier } from './types';

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  maxActiveParcelsPerRider: 3,
  searchRadiusKm: 85,
  offerTimeoutSeconds: 45,
  baseLocalFeeNgn: 350,
  perKmRateNgn: 22,
  interStateSurchargeNgn: 3500,
  riderCommissionPercent: 75,
  whatsappSupportNumber: '2348007276000',
};

export function classifyServiceTier(
  pickupState: string,
  destinationState: string,
  distanceKm: number
): ServiceTier {
  const sameState = pickupState.trim().toLowerCase() === destinationState.trim().toLowerCase();
  if (!sameState || distanceKm > 120) {
    return 'inter_state';
  }
  if (distanceKm <= 25) {
    return 'local';
  }
  return 'inter_city';
}

export function estimateDeliveryMinutes(serviceTier: ServiceTier, distanceKm: number): number {
  if (serviceTier === 'local') {
    // 15-minute service target for eligible local short-distance deliveries (not artificially applied to long-haul)
    return Math.max(12, Math.min(24, Math.round(10 + distanceKm * 0.55)));
  }
  if (serviceTier === 'inter_city') {
    return Math.max(35, Math.round(25 + distanceKm * 1.15));
  }
  // Inter-state realistic transit time based on highway distance (~62 km/h average + hub handoff buffer)
  return Math.max(90, Math.round(45 + (distanceKm / 62) * 60));
}

export function calculateDeliveryQuote(params: {
  pickupState: string;
  pickupLat: number;
  pickupLng: number;
  destinationState: string;
  destinationLat: number;
  destinationLng: number;
  weightKg: number;
  settings?: PlatformSettings;
}): PriceQuote {
  const settings = params.settings ?? DEFAULT_PLATFORM_SETTINGS;
  const rawDistance = haversineKm(
    params.pickupLat,
    params.pickupLng,
    params.destinationLat,
    params.destinationLng
  );
  // Road factor 1.24x over straight-line distance, minimum 2.5km
  const distanceKm = Number(Math.max(2.5, rawDistance * 1.24).toFixed(1));
  const serviceTier = classifyServiceTier(
    params.pickupState,
    params.destinationState,
    distanceKm
  );
  const estimatedMinutes = estimateDeliveryMinutes(serviceTier, distanceKm);

  const weightSurcharge = Math.max(0, params.weightKg - 2) * 350;
  let fee = settings.baseLocalFeeNgn + distanceKm * settings.perKmRateNgn + weightSurcharge;
  if (serviceTier === 'inter_state') {
    fee += settings.interStateSurchargeNgn;
  } else if (serviceTier === 'inter_city') {
    fee += Math.round(settings.interStateSurchargeNgn * 0.35);
  }

  // Round to nearest 100 Naira, minimum 600 Naira for local express
  const deliveryFeeNgn = Math.max(600, Math.round(fee / 100) * 100);

  let targetLabel = 'Inter-State Express Corridor';
  if (serviceTier === 'local') {
    targetLabel = '15-Min Target Local Dispatch';
  } else if (serviceTier === 'inter_city') {
    targetLabel = 'Same-Day Inter-City Dispatch';
  }

  return {
    serviceTier,
    distanceKm,
    estimatedMinutes,
    deliveryFeeNgn,
    targetLabel,
  };
}

export function formatNaira(amount: number): string {
  return `₦${Math.round(amount).toLocaleString('en-NG')}`;
}

export function formatEta(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hrs = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hrs} hr` : `${hrs} hr ${rem} min`;
}

export function calculateRiderPayoutNgn(
  deliveryFeeNgn: number,
  commissionPercent: number = DEFAULT_PLATFORM_SETTINGS.riderCommissionPercent
): number {
  const clampedPercent = Math.min(95, Math.max(10, Number(commissionPercent) || 75));
  return Math.round((Math.max(0, deliveryFeeNgn) * clampedPercent) / 100);
}

export function isValidNigerianPhone(phone: string): boolean {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

export function matchesDeliveryOtp(enteredOtp: string, expectedOtp: string): boolean {
  const cleanEntered = String(enteredOtp || '').trim();
  const cleanExpected = String(expectedOtp || '').trim();
  return /^\d{4}$/.test(cleanEntered) && cleanEntered === cleanExpected;
}

