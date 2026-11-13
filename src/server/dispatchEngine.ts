import crypto from 'node:crypto';
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import type { WebSocket } from 'ws';
import { rankEligibleRiders } from '../shared/dispatch';
import type { LiveWsEvent, SupportPresence, UserRole } from '../shared/types';
import {
  createNotification,
  db,
  getAllRiders,
  getDeliveryById,
  getPlatformSettings,
  listDeliveries,
} from './db';

const wsClients = new Set<WebSocket>();
const wsAuthMeta = new Map<WebSocket, { userId: string; role: UserRole }>();
let adminAcceptingChats = true;
const offerTimers = new Map<string, NodeJS.Timeout>();

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;

let supabaseChannel: RealtimeChannel | null = null;
if (supabaseUrl && supabaseKey) {
  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    supabaseChannel = supabase.channel('saqo-notifications');
    supabaseChannel.subscribe();
  } catch {
    supabaseChannel = null;
  }
}

export function getSupportPresence(): SupportPresence {
  const uniqueAdminIds = new Set<string>();
  for (const [client, meta] of wsAuthMeta.entries()) {
    if (meta.role === 'admin' && client.readyState === 1) {
      uniqueAdminIds.add(meta.userId);
    }
  }
  const onlineAdminCount = adminAcceptingChats ? uniqueAdminIds.size : 0;
  return {
    adminOnline: onlineAdminCount > 0,
    onlineAdminCount,
  };
}

export function setAdminChatAvailability(available: boolean): SupportPresence {
  adminAcceptingChats = available;
  const presence = getSupportPresence();
  broadcastWsEvent('support:presence', presence);
  return presence;
}

export function isAdminChatAvailableFlag(): boolean {
  return adminAcceptingChats;
}

export function setWsClientAuth(ws: WebSocket, userId: string, role: UserRole): void {
  const prev = wsAuthMeta.get(ws);
  wsAuthMeta.set(ws, { userId, role });
  if (role === 'admin' || prev?.role === 'admin') {
    broadcastWsEvent('support:presence', getSupportPresence());
  }
}

export function registerWsClient(ws: WebSocket): void {
  wsClients.add(ws);
  ws.on('close', () => {
    const meta = wsAuthMeta.get(ws);
    wsAuthMeta.delete(ws);
    wsClients.delete(ws);
    if (meta?.role === 'admin') {
      broadcastWsEvent('support:presence', getSupportPresence());
    }
  });
}

export function broadcastWsEvent(type: LiveWsEvent['type'], payload: unknown): void {
  const eventObj: LiveWsEvent = {
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
  const msg = JSON.stringify(eventObj);

  for (const client of wsClients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }

  if (supabaseChannel) {
    supabaseChannel
      .send({
        type: 'broadcast',
        event: 'saqo-event',
        payload: eventObj,
      })
      .catch(() => {
        // Non-blocking fallback when Supabase Realtime is unreachable
      });
  }
}

export function clearOfferTimer(assignmentId: string): void {
  const timer = offerTimers.get(assignmentId);
  if (timer) {
    clearTimeout(timer);
    offerTimers.delete(assignmentId);
  }
}

export function dispatchNextRiderForDelivery(deliveryId: string): {
  offered: boolean;
  riderId?: string;
  riderName?: string;
} {
  const delivery = getDeliveryById(deliveryId);
  if (!delivery) return { offered: false };
  if (delivery.status === 'cancelled' || delivery.status === 'delivered') {
    return { offered: false };
  }

  const settings = getPlatformSettings();
  const riders = getAllRiders();
  const allDeliveries = listDeliveries();

  const previousAttempts = db
    .prepare(
      `SELECT rider_id FROM delivery_assignments WHERE delivery_id = ? AND status IN ('rejected', 'timed_out', 'offered')`
    )
    .all(deliveryId) as Array<{ rider_id: string }>;
  const excludedRiderIds = previousAttempts.map((a) => a.rider_id);

  const candidates = riders.map((rider) => ({
    rider,
    activeDeliveries: allDeliveries.filter(
      (d) =>
        d.assignedRiderId === rider.riderId &&
        [
          'assigned',
          'accepted',
          'heading_to_pickup',
          'parcel_picked_up',
          'in_transit',
          'arrived_at_destination',
        ].includes(d.status)
    ),
  }));

  const ranked = rankEligibleRiders({
    delivery,
    candidates,
    settings,
    excludedRiderIds,
  });

  if (ranked.length === 0) {
    const now = new Date().toISOString();
    db.prepare(`UPDATE delivery_requests SET status = 'no_rider_available', assigned_rider_id = NULL, updated_at = ? WHERE id = ?`).run(
      now,
      deliveryId
    );
    db.prepare(`
      INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
      VALUES (?, ?, 'no_rider_available', ?, 'system', ?)
    `).run(
      `hist-${crypto.randomUUID().slice(0, 8)}`,
      deliveryId,
      'No eligible riders currently available within dispatch radius. You can retry dispatch or contact support.',
      now
    );

    const custRow = db.prepare(`SELECT profile_id FROM customers WHERE id = ?`).get(delivery.customerId) as {
      profile_id: string;
    } | undefined;
    if (custRow) {
      const notif = createNotification(
        custRow.profile_id,
        'No rider available right now',
        `Parcel ${delivery.trackingCode} is awaiting an eligible rider. Tap Retry Dispatch anytime.`,
        deliveryId
      );
      broadcastWsEvent('notification:created', notif);
    }

    const updated = getDeliveryById(deliveryId);
    broadcastWsEvent('delivery:updated', updated);
    return { offered: false };
  }

  const topCandidate = ranked[0];
  const assignmentId = `asg-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + settings.offerTimeoutSeconds * 1000);

  db.prepare(`
    INSERT INTO delivery_assignments (
      id, delivery_id, rider_id, status, score, distance_to_pickup_km,
      route_compatibility_score, offered_at, expires_at
    ) VALUES (?, ?, ?, 'offered', ?, ?, ?, ?, ?)
  `).run(
    assignmentId,
    deliveryId,
    topCandidate.rider.riderId,
    topCandidate.compositeScore,
    topCandidate.distanceToPickupKm,
    topCandidate.routeCompatibilityScore,
    now.toISOString(),
    expiresAt.toISOString()
  );

  db.prepare(`
    UPDATE delivery_requests
    SET status = 'assigned', assigned_rider_id = ?, updated_at = ?
    WHERE id = ?
  `).run(topCandidate.rider.riderId, now.toISOString(), deliveryId);

  db.prepare(`
    INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
    VALUES (?, ?, 'assigned', ?, 'system', ?)
  `).run(
    `hist-${crypto.randomUUID().slice(0, 8)}`,
    deliveryId,
    `Smart dispatch offered parcel to ${topCandidate.rider.fullName} (${topCandidate.distanceToPickupKm} km away, route fit ${Math.round(
      topCandidate.routeCompatibilityScore * 100
    )}%).`,
    now.toISOString()
  );

  const riderNotif = createNotification(
    topCandidate.rider.id,
    'New Delivery Request Available',
    `${delivery.trackingCode}: ${delivery.pickupAddress}, ${delivery.pickupState} → ${delivery.destinationAddress}, ${delivery.destinationState} (${topCandidate.distanceToPickupKm} km away).`,
    deliveryId
  );
  broadcastWsEvent('notification:created', riderNotif);

  const custRow = db
    .prepare('SELECT profile_id FROM customers WHERE id = ?')
    .get(delivery.customerId) as { profile_id: string } | undefined;
  if (custRow) {
    const custNotif = createNotification(
      custRow.profile_id,
      'Rider Assigned',
      `${topCandidate.rider.fullName} (${topCandidate.rider.vehicleType}) has been matched to parcel ${delivery.trackingCode}.`,
      deliveryId
    );
    broadcastWsEvent('notification:created', custNotif);
  }

  const updatedDelivery = getDeliveryById(deliveryId);
  broadcastWsEvent('delivery:updated', updatedDelivery);
  broadcastWsEvent('assignment:offered', {
    id: assignmentId,
    deliveryId,
    trackingCode: delivery.trackingCode,
    riderId: topCandidate.rider.riderId,
    riderProfileId: topCandidate.rider.id,
    riderName: topCandidate.rider.fullName,
    status: 'offered',
    score: topCandidate.compositeScore,
    distanceToPickupKm: topCandidate.distanceToPickupKm,
    routeCompatibilityScore: topCandidate.routeCompatibilityScore,
    offeredAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    delivery: updatedDelivery,
  });

  // Configurable timeout fallback to next eligible rider
  const timer = setTimeout(() => {
    offerTimers.delete(assignmentId);
    const current = db
      .prepare('SELECT status FROM delivery_assignments WHERE id = ?')
      .get(assignmentId) as { status: string } | undefined;
    if (current && current.status === 'offered') {
      const tNow = new Date().toISOString();
      db.prepare(
        `UPDATE delivery_assignments SET status = 'timed_out', responded_at = ? WHERE id = ?`
      ).run(tNow, assignmentId);
      db.prepare(`
        INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
        VALUES (?, ?, 'pending_dispatch', ?, 'system', ?)
      `).run(
        `hist-${crypto.randomUUID().slice(0, 8)}`,
        deliveryId,
        `${topCandidate.rider.fullName} did not respond within ${settings.offerTimeoutSeconds}s. Trying next eligible rider.`,
        tNow
      );
      dispatchNextRiderForDelivery(deliveryId);
    }
  }, settings.offerTimeoutSeconds * 1000);

  offerTimers.set(assignmentId, timer);

  return {
    offered: true,
    riderId: topCandidate.rider.riderId,
    riderName: topCandidate.rider.fullName,
  };
}
