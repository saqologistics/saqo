export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(2));
}

export function bearingDegrees(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const y = Math.sin(toRadians(lng2 - lng1)) * Math.cos(toRadians(lat2));
  const x =
    Math.cos(toRadians(lat1)) * Math.sin(toRadians(lat2)) -
    Math.sin(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.cos(toRadians(lng2 - lng1));
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

export function angularDifference(degA: number, degB: number): number {
  const diff = Math.abs(degA - degB) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Computes a 0..1 route compatibility score for a rider carrying existing active parcels
 * relative to a candidate new delivery corridor.
 */
export function computeRouteCompatibility(
  candidatePickup: { lat: number; lng: number; state: string },
  candidateDest: { lat: number; lng: number; state: string },
  activeRoutes: Array<{
    pickupLat: number;
    pickupLng: number;
    destinationLat: number;
    destinationLng: number;
    destinationState: string;
  }>
): number {
  if (activeRoutes.length === 0) {
    return 0.75; // Idle rider is neutral-favorable
  }

  const candidateBearing = bearingDegrees(
    candidatePickup.lat,
    candidatePickup.lng,
    candidateDest.lat,
    candidateDest.lng
  );

  let bestScore = 0.2;
  for (const route of activeRoutes) {
    if (route.destinationState.toLowerCase() === candidateDest.state.toLowerCase()) {
      return 1.0; // Same destination state corridor
    }
    const routeBearing = bearingDegrees(
      route.pickupLat,
      route.pickupLng,
      route.destinationLat,
      route.destinationLng
    );
    const diff = angularDifference(candidateBearing, routeBearing);
    if (diff <= 30) {
      bestScore = Math.max(bestScore, 0.92);
    } else if (diff <= 65) {
      bestScore = Math.max(bestScore, 0.68);
    } else if (diff >= 135) {
      bestScore = Math.max(bestScore, 0.12); // Opposite direction penalty
    }
  }
  return Number(bestScore.toFixed(2));
}
