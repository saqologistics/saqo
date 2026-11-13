import { computeRouteCompatibility, haversineKm } from './geo';
import type { DeliveryRequest, PlatformSettings, RiderProfile } from './types';

export interface CandidateRiderInput {
  rider: RiderProfile;
  activeDeliveries: DeliveryRequest[];
}

export interface RankedRiderCandidate {
  rider: RiderProfile;
  distanceToPickupKm: number;
  workloadRatio: number;
  routeCompatibilityScore: number;
  compositeScore: number; // Lower is better
}

/**
 * Smart Rider Assignment Algorithm:
 * 1. Excludes suspended, unverified, offline, or at-capacity riders.
 * 2. Excludes riders who already rejected or timed out on this delivery.
 * 3. Evaluates proximity (Haversine km to pickup), current workload, and route compatibility.
 * 4. Ranks candidates by composite score so workload & route alignment matter alongside distance.
 */
export function rankEligibleRiders(params: {
  delivery: Pick<
    DeliveryRequest,
    'pickupLat' | 'pickupLng' | 'pickupState' | 'destinationLat' | 'destinationLng' | 'destinationState' | 'serviceTier'
  >;
  candidates: CandidateRiderInput[];
  settings: PlatformSettings;
  excludedRiderIds?: string[];
}): RankedRiderCandidate[] {
  const excluded = new Set(params.excludedRiderIds ?? []);
  // Inter-state parcels allow a wider regional hub search radius when local search radius has no riders
  const effectiveRadiusKm =
    params.delivery.serviceTier === 'inter_state'
      ? Math.max(params.settings.searchRadiusKm, 180)
      : params.settings.searchRadiusKm;

  const eligible: RankedRiderCandidate[] = [];

  for (const entry of params.candidates) {
    const { rider, activeDeliveries } = entry;

    if (excluded.has(rider.riderId) || excluded.has(rider.id)) continue;
    if (rider.accountStatus !== 'active') continue;
    if (rider.verificationStatus !== 'verified') continue;
    if (!rider.isOnline) continue;

    const currentWorkload = activeDeliveries.length;
    if (currentWorkload >= params.settings.maxActiveParcelsPerRider) continue;

    const distanceToPickupKm = haversineKm(
      rider.currentLat,
      rider.currentLng,
      params.delivery.pickupLat,
      params.delivery.pickupLng
    );

    if (distanceToPickupKm > effectiveRadiusKm) continue;

    const workloadRatio = Number(
      (currentWorkload / Math.max(1, params.settings.maxActiveParcelsPerRider)).toFixed(2)
    );

    const routeCompatibilityScore = computeRouteCompatibility(
      {
        lat: params.delivery.pickupLat,
        lng: params.delivery.pickupLng,
        state: params.delivery.pickupState,
      },
      {
        lat: params.delivery.destinationLat,
        lng: params.delivery.destinationLng,
        state: params.delivery.destinationState,
      },
      activeDeliveries.map((d) => ({
        pickupLat: d.pickupLat,
        pickupLng: d.pickupLng,
        destinationLat: d.destinationLat,
        destinationLng: d.destinationLng,
        destinationState: d.destinationState,
      }))
    );

    // Composite score (lower is better):
    // - Distance weight: normalized by radius (0..100)
    // - Workload penalty: up to +38 points when heavily loaded
    // - Route compatibility bonus: up to -28 points when carrying aligned parcels
    const distanceComponent = (distanceToPickupKm / effectiveRadiusKm) * 100;
    const workloadPenalty = workloadRatio * 38;
    const routeBonus = routeCompatibilityScore * 28;
    const compositeScore = Number(
      (distanceComponent + workloadPenalty - routeBonus).toFixed(2)
    );

    eligible.push({
      rider,
      distanceToPickupKm,
      workloadRatio,
      routeCompatibilityScore,
      compositeScore,
    });
  }

  return eligible.sort((a, b) => a.compositeScore - b.compositeScore);
}
