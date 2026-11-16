import crypto from 'node:crypto';
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import type { WebSocket } from 'ws';
import { rankEligibleRiders } from '../shared/dispatch';
import { sendOpsAlert } from './opsAlerts';
import type { DeliveryRequest, LiveWsEvent, SupportPresence, UserRole } from '../shared/types';
import {
  createNotification,
  db,
  getAdminAcceptingChats,
  persistDispatchChange,
  getAllRiders,
  getDeliveryById,
  publicTrackingDelivery,
  getPlatformSettings,
  getProfileById,
  getSupportConversationById,
  listDeliveries,
  setAdminAcceptingChatsDb,
} from './db';

const wsClients = new Set<WebSocket>();
const wsSupportVisitors = new Map<WebSocket, string>();
const wsTracking = new Map<WebSocket, string>();
const wsAuthMeta = new Map<WebSocket, { userId: string; role: UserRole; expiresAt: number }>();
let adminAcceptingChats = true;
const offerTimers = new Map<string, NodeJS.Timeout>();
let adminOfflineGraceTimer: NodeJS.Timeout | null = null;
let lastBroadcastPresence: SupportPresence | null = null;

const isEdgeRuntime = () => process.env.SAQO_EDGE_RUNTIME === '1';

let supabaseClient: ReturnType<typeof createClient> | null = null;
let supabaseChannel: RealtimeChannel | null = null;

function getSupabaseBroadcastChannel(): RealtimeChannel | null {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  if (!supabaseClient) {
    try {
      supabaseClient = createClient(url, key);
    } catch {
      return null;
    }
  }
  if (!supabaseChannel) {
    supabaseChannel = supabaseClient.channel('saqo-notifications');
    if (!isEdgeRuntime()) {
      supabaseChannel.subscribe();
    }
  }
  return supabaseChannel;
}

function getConnectedAdminPresence(): SupportPresence {
  if (isEdgeRuntime()) {
    const onlineAdminCount = adminAcceptingChats ? 1 : 0;
    return { adminOnline: onlineAdminCount > 0, onlineAdminCount };
  }
  const uniqueAdminIds = new Set<string>();
  for (const [client, meta] of wsAuthMeta.entries()) {
    if (meta.role === 'admin' && meta.expiresAt > Date.now() && client.readyState === 1) {
      uniqueAdminIds.add(meta.userId);
    }
  }
  const onlineAdminCount = adminAcceptingChats ? uniqueAdminIds.size : 0;
  return {
    adminOnline: onlineAdminCount > 0,
    onlineAdminCount,
  };
}

export function getSupportPresence(): SupportPresence {
  const connected = getConnectedAdminPresence();
  if (adminAcceptingChats && adminOfflineGraceTimer && !connected.adminOnline && lastBroadcastPresence) {
    return lastBroadcastPresence;
  }
  return connected;
}

export async function getSupportPresenceAsync(): Promise<SupportPresence> {
  adminAcceptingChats = await getAdminAcceptingChats().catch(() => adminAcceptingChats);
  return getSupportPresence();
}

function cancelOfflineGrace(): void {
  if (adminOfflineGraceTimer) clearTimeout(adminOfflineGraceTimer);
  adminOfflineGraceTimer = null;
}

async function broadcastPresenceIfChanged(): Promise<SupportPresence> {
  const presence = await getSupportPresenceAsync();
  if (
    !lastBroadcastPresence ||
    lastBroadcastPresence.adminOnline !== presence.adminOnline ||
    lastBroadcastPresence.onlineAdminCount !== presence.onlineAdminCount
  ) {
    lastBroadcastPresence = presence;
    await broadcastWsEvent('support:presence', presence);
  }
  return presence;
}

export async function setAdminChatAvailability(available: boolean): Promise<SupportPresence> {
  adminAcceptingChats = available;
  await setAdminAcceptingChatsDb(available);
  cancelOfflineGrace();
  return await broadcastPresenceIfChanged();
}

export async function isAdminChatAvailableFlagAsync(): Promise<boolean> {
  adminAcceptingChats = await getAdminAcceptingChats().catch(() => adminAcceptingChats);
  return adminAcceptingChats;
}

export function isAdminChatAvailableFlag(): boolean {
  return adminAcceptingChats;
}

export async function setWsClientAuth(ws: WebSocket, userId: string, role: UserRole, expiresAt: number): Promise<void> {
  const prev = wsAuthMeta.get(ws);
  wsAuthMeta.set(ws, { userId, role, expiresAt });
  if (role === 'admin') {
    cancelOfflineGrace();
    await broadcastPresenceIfChanged();
  } else if (prev?.role === 'admin') {
    await broadcastPresenceIfChanged();
  }
}

export async function clearWsClientAuth(ws: WebSocket): Promise<void> {
  const prev = wsAuthMeta.get(ws);
  wsAuthMeta.delete(ws);
  if (prev?.role === 'admin') {
    cancelOfflineGrace();
    await broadcastPresenceIfChanged();
  }
}

export function setWsTracking(ws: WebSocket, trackingCode: string): void {
  if (trackingCode) wsTracking.set(ws, trackingCode);
  else wsTracking.delete(ws);
}

export function setWsSupportVisitor(ws: WebSocket, token: string): void {
  if (token && token.length <= 128) wsSupportVisitors.set(ws, token);
  else wsSupportVisitors.delete(ws);
}

function canReadSupport(ws: WebSocket, conversation: Awaited<ReturnType<typeof getSupportConversationById>>): boolean {
  if (!conversation) return false;
  const auth = wsAuthMeta.get(ws);
  if (auth && auth.expiresAt > Date.now()) {
    if (auth.role === 'admin' || auth.userId === conversation.userId) return true;
  }
  return Boolean(conversation.visitorToken && wsSupportVisitors.get(ws) === conversation.visitorToken);
}

export async function sendSupportTyping(ws: WebSocket, conversationId: string, isTyping: boolean): Promise<void> {
  const conversation = await getSupportConversationById(conversationId);
  if (!conversation || !canReadSupport(ws, conversation)) return;
  const auth = wsAuthMeta.get(ws);
  const profile = auth && auth.expiresAt > Date.now() ? await getProfileById(auth.userId) : null;
  const admin = profile?.role === 'admin' && profile.accountStatus === 'active';
  await broadcastWsEvent('support:typing', {
    conversationId,
    senderRole: admin ? 'admin' : 'visitor',
    senderName: admin ? profile.fullName : conversation.visitorName,
    isTyping,
  });
}

export function registerWsClient(ws: WebSocket): void {
  wsClients.add(ws);
  ws.on('close', async () => {
    const meta = wsAuthMeta.get(ws);
    wsAuthMeta.delete(ws);
    wsClients.delete(ws);
    wsTracking.delete(ws);
    wsSupportVisitors.delete(ws);
    if (meta?.role !== 'admin') return;

    if (getConnectedAdminPresence().adminOnline || !lastBroadcastPresence?.adminOnline) {
      await broadcastPresenceIfChanged();
      return;
    }
    // Keep API reads and WebSocket events consistent during short reconnects.
    if (!adminOfflineGraceTimer) {
      adminOfflineGraceTimer = setTimeout(async () => {
        adminOfflineGraceTimer = null;
        await broadcastPresenceIfChanged();
      }, 5000);
    }
  });
}

export async function broadcastWsEvent(type: LiveWsEvent['type'], payload: unknown): Promise<void> {
  const eventObj: LiveWsEvent = {
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
  const data = payload as Record<string, unknown> | null;
  const isDelivery = type === 'delivery:created' || type === 'delivery:updated';
  if (isDelivery && data) {
    const { deliveryOtp: _otp, ...delivery } = data;
    eventObj.payload = delivery;
  }
  const supportId = type === 'support:conversation' ? data?.id :
    type === 'support:message' || type === 'support:typing' ? data?.conversationId : undefined;
  const conversation = typeof supportId === 'string' ? await getSupportConversationById(supportId) : null;
  const message = JSON.stringify(eventObj);

  for (const client of wsClients) {
    if (client.readyState !== 1) continue;
    const session = wsAuthMeta.get(client);
    const auth = session && session.expiresAt > Date.now() ? session : undefined;
    const tracked = wsTracking.get(client);
    let allowed = Boolean(auth);
    if (type === 'notification:created' || type === 'wallet:updated') {
      allowed = Boolean(auth && data?.userId === auth.userId);
    } else if (type === 'assignment:offered') {
      allowed = Boolean(auth && (auth.role === 'admin' || data?.riderProfileId === auth.userId));
    } else if (isDelivery) {
      allowed = auth?.role === 'admin';
      if (!allowed && tracked && tracked === data?.trackingCode) {
        client.send(JSON.stringify({ ...eventObj, payload: publicTrackingDelivery(payload as DeliveryRequest) }));
        continue;
      }
      if (auth && !allowed) {
        // Other authenticated clients refresh from their role-scoped endpoint.
        client.send(JSON.stringify({ ...eventObj, payload: { id: data?.id } }));
      }
    } else if (type === 'rider:location') {
      allowed = Boolean(auth?.role === 'admin');
      if (!allowed && tracked) {
        const current = await db.prepare(`
          SELECT 1 FROM delivery_requests
          WHERE tracking_code = ? AND assigned_rider_id = ? AND status NOT IN ('delivered','cancelled')
        `).get(tracked, String(data?.riderId ?? ''));
        allowed = Boolean(current);
      }
      if (!allowed && auth) client.send(JSON.stringify({ ...eventObj, payload: { riderId: data?.riderId } }));
    } else if (type === 'settings:updated' && !auth) {
      client.send(JSON.stringify({ ...eventObj, payload: { showDeliveryStateSelectors: data?.showDeliveryStateSelectors } }));
      continue;
    } else if (type === 'support:presence') {
      allowed = true;
    } else if (type.startsWith('support:')) {
      allowed = canReadSupport(client, conversation);
    } else if (type === 'payment:updated' || type === 'cash_collection:updated') {
      allowed = auth?.role === 'admin';
    }
    if (allowed) client.send(message);
  }

  const channel = getSupabaseBroadcastChannel();
  if (channel) {
    // Only send non-sensitive public/refresh signals over shared Supabase Realtime channels.
    let publicEvt: LiveWsEvent | null = null;
    if (type === 'settings:updated') {
      publicEvt = {
        type: 'settings:updated',
        payload: { showDeliveryStateSelectors: Boolean(data?.showDeliveryStateSelectors) },
        timestamp: eventObj.timestamp,
      };
    } else if (type === 'support:presence') {
      publicEvt = { type: 'support:presence', payload, timestamp: eventObj.timestamp };
    } else if (isDelivery) {
      publicEvt = {
        type,
        payload: { id: data?.id, trackingCode: data?.trackingCode },
        timestamp: eventObj.timestamp,
      };
    } else if (type !== 'support:typing') {
      publicEvt = { type: 'notifications:refresh', payload: null, timestamp: eventObj.timestamp };
    }
    if (publicEvt) {
      const sendViaChannel = async () => {
        if (typeof channel.httpSend === 'function' && (isEdgeRuntime() || channel.state !== 'joined')) {
          await channel.httpSend('saqo-event', publicEvt);
        } else {
          await channel.send({ type: 'broadcast', event: 'saqo-event', payload: publicEvt });
        }
      };
      if (isEdgeRuntime()) {
        await sendViaChannel().catch(() => {});
      } else {
        void sendViaChannel().catch(() => {});
      }
    }
  }
}

export function clearOfferTimer(assignmentId: string): void {
  const timer = offerTimers.get(assignmentId);
  if (timer) {
    clearTimeout(timer);
    offerTimers.delete(assignmentId);
  }
}

const queuedStatuses = ['pending_dispatch', 'no_rider_available'];
const activeStatuses = ['assigned', 'accepted', 'heading_to_pickup', 'parcel_picked_up', 'in_transit', 'arrived_at_destination'];

export function canDispatch(delivery: { paymentMethod: string; paymentStatus: string }): boolean {
  return delivery.paymentMethod === 'cash' || delivery.paymentStatus === 'paid';
}

let lastSweepAt = 0;

export async function expireTimedOutOffers(force = false): Promise<number> {
  const nowMs = Date.now();
  if (!force && nowMs - lastSweepAt < 1500) return 0;
  lastSweepAt = nowMs;
  const nowIso = new Date(nowMs).toISOString();
  const expired = await persistDispatchChange(async () => {
    const rows = await db.prepare(`
      UPDATE delivery_assignments SET status = 'timed_out', responded_at = ?
      WHERE status = 'offered' AND expires_at <= ?
      RETURNING id, delivery_id, rider_id
    `).all(nowIso, nowIso) as Array<{ id: string; delivery_id: string; rider_id: string }>;
    for (const row of rows) {
      clearOfferTimer(row.id);
      await releaseOffer(row.delivery_id, row.rider_id);
    }
    return rows;
  });
  for (const row of expired) {
    await broadcastWsEvent('assignment:updated', { id: row.id, status: 'timed_out' });
  }
  if (expired.length > 0) {
    await dispatchWaitingDeliveries();
  }
  return expired.length;
}

export async function dispatchWaitingDeliveries(): Promise<void> {
  const waiting = await db.prepare(`
    SELECT id FROM delivery_requests
    WHERE status IN ('pending_dispatch', 'no_rider_available') AND assigned_rider_id IS NULL
    ORDER BY created_at, rowid
  `).all() as Array<{ id: string }>;
  for (const { id } of waiting) await dispatchNextRiderForDelivery(id);
}

function scheduleOfferExpiry(assignmentId: string, expiresAt: string): void {
  clearOfferTimer(assignmentId);
  if (isEdgeRuntime()) return;
  const timer = setTimeout(async () => {
    offerTimers.delete(assignmentId);
    const now = new Date().toISOString();
    const expired = await persistDispatchChange(async () => {
      const assignment = await db.prepare(`
        UPDATE delivery_assignments SET status = 'timed_out', responded_at = ?
        WHERE id = ? AND status = 'offered'
        RETURNING delivery_id, rider_id
      `).get(now, assignmentId) as { delivery_id: string; rider_id: string } | undefined;
      if (assignment) await releaseOffer(assignment.delivery_id, assignment.rider_id);
      return assignment;
    });
    if (!expired) return;
    await broadcastWsEvent('assignment:updated', { id: assignmentId, status: 'timed_out' });
    await dispatchWaitingDeliveries();
  }, Math.max(0, Date.parse(expiresAt) - Date.now()));
  timer.unref();
  offerTimers.set(assignmentId, timer);
}

export async function releaseOffer(deliveryId: string, riderId: string): Promise<void> {
  await db.prepare(`
    UPDATE delivery_requests SET status = 'pending_dispatch', assigned_rider_id = NULL, updated_at = ?
    WHERE id = ? AND assigned_rider_id = ? AND status = 'assigned'
  `).run(new Date().toISOString(), deliveryId, riderId);
}

export async function resumeDispatch(): Promise<() => void> {
  await db.prepare(`
    UPDATE delivery_requests SET status = 'pending_dispatch', assigned_rider_id = NULL, updated_at = ?
    WHERE status = 'assigned' AND NOT EXISTS (
      SELECT 1 FROM delivery_assignments a WHERE a.delivery_id = delivery_requests.id
        AND a.rider_id = delivery_requests.assigned_rider_id AND a.status IN ('offered', 'accepted')
    )
  `).run(new Date().toISOString());
  const offers = await db.prepare(`SELECT id, expires_at FROM delivery_assignments WHERE status = 'offered'`)
    .all() as Array<{ id: string; expires_at: string }>;
  for (const offer of offers) scheduleOfferExpiry(offer.id, offer.expires_at);
  await dispatchWaitingDeliveries();
  const configuredDelay = Number(process.env.SAQO_DISPATCH_ALERT_SECONDS);
  const delaySeconds = configuredDelay > 0 && Number.isFinite(configuredDelay) ? configuredDelay : 300;
  const checkQueue = async () => {
    const cutoff = new Date(Date.now() - delaySeconds * 1000).toISOString();
    const { total } = await db.prepare(`
      SELECT COUNT(*) AS total FROM delivery_requests
      WHERE status IN ('pending_dispatch', 'no_rider_available')
        AND (payment_method = 'cash' OR payment_status = 'paid') AND created_at <= ?
    `).get(cutoff) as { total: number };
    if (Number(total) > 0) void sendOpsAlert('dispatch_delay', { waitingDeliveries: Number(total), delaySeconds });
  };
  await checkQueue();
  const poll = setInterval(async () => {
    await dispatchWaitingDeliveries();
    await checkQueue();
  }, 10_000).unref();
  return () => {
    clearInterval(poll);
    for (const timer of offerTimers.values()) clearTimeout(timer);
    offerTimers.clear();
  };
}

export async function dispatchNextRiderForDelivery(deliveryId: string): Promise<{
  offered: boolean;
  riderId?: string;
  riderName?: string;
}> {
  const committed = await persistDispatchChange(async () => {
    const delivery = await getDeliveryById(deliveryId);
    if (!delivery || !queuedStatuses.includes(delivery.status) || delivery.assignedRiderId || !canDispatch(delivery)) {
      return null;
    }

    const settings = await getPlatformSettings();
    const riders = await getAllRiders();
    const allDeliveries = await listDeliveries();

    const previousAttempts = await db
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
          activeStatuses.includes(d.status)
      ),
    }));

    const ranked = rankEligibleRiders({
      delivery,
      candidates,
      settings,
      excludedRiderIds,
    });

    if (ranked.length === 0) {
      if (delivery.status === 'no_rider_available') return { kind: 'noop' as const };
      const nowIso = new Date().toISOString();
      const locked = await db.prepare(`
        UPDATE delivery_requests
        SET status = 'no_rider_available', assigned_rider_id = NULL, updated_at = ?
        WHERE id = ? AND status IN ('pending_dispatch', 'no_rider_available') AND assigned_rider_id IS NULL
      `).run(nowIso, deliveryId);
      if (locked.changes === 0) return { kind: 'noop' as const };

      await db.prepare(`
        INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
        VALUES (?, ?, 'no_rider_available', ?, 'system', ?)
      `).run(
        `hist-${crypto.randomUUID().slice(0, 8)}`,
        deliveryId,
        'Queued until an eligible rider has capacity.',
        nowIso
      );

      const custRow = await db.prepare(`SELECT profile_id FROM customers WHERE id = ?`).get(delivery.customerId) as {
        profile_id: string;
      } | undefined;
      const custNotif = custRow
        ? await createNotification(
            custRow.profile_id,
            'No rider available right now',
            `Parcel ${delivery.trackingCode} is queued until an eligible rider has capacity.`,
            deliveryId
          )
        : null;
      const updated = await getDeliveryById(deliveryId);
      return { kind: 'no_rider' as const, custNotif, updated };
    }

    const topCandidate = ranked[0];
    const now = new Date();
    const nowIso = now.toISOString();
    const locked = await db.prepare(`
      UPDATE delivery_requests
      SET status = 'assigned', assigned_rider_id = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending_dispatch', 'no_rider_available') AND assigned_rider_id IS NULL
    `).run(topCandidate.rider.riderId, nowIso, deliveryId);
    if (locked.changes === 0) return { kind: 'noop' as const };

    const assignmentId = `asg-${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = new Date(now.getTime() + settings.offerTimeoutSeconds * 1000);

    await db.prepare(`
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
      nowIso,
      expiresAt.toISOString()
    );

    await db.prepare(`
      INSERT INTO delivery_status_history (id, delivery_id, status, note, actor_role, created_at)
      VALUES (?, ?, 'assigned', ?, 'system', ?)
    `).run(
      `hist-${crypto.randomUUID().slice(0, 8)}`,
      deliveryId,
      `Smart dispatch offered parcel to ${topCandidate.rider.fullName} (${topCandidate.distanceToPickupKm} km away, route fit ${Math.round(
        topCandidate.routeCompatibilityScore * 100
      )}%).`,
      nowIso
    );

    const riderNotif = await createNotification(
      topCandidate.rider.id,
      'New Delivery Request Available',
      `${delivery.trackingCode}: ${delivery.pickupAddress}, ${delivery.pickupState} → ${delivery.destinationAddress}, ${delivery.destinationState} (${topCandidate.distanceToPickupKm} km away).`,
      deliveryId
    );
    const custRow = await db
      .prepare('SELECT profile_id FROM customers WHERE id = ?')
      .get(delivery.customerId) as { profile_id: string } | undefined;
    const custNotif = custRow
      ? await createNotification(
          custRow.profile_id,
          'Rider Assigned',
          `${topCandidate.rider.fullName} (${topCandidate.rider.vehicleType}) has been matched to parcel ${delivery.trackingCode}.`,
          deliveryId
        )
      : null;

    const updatedDelivery = await getDeliveryById(deliveryId);
    return {
      kind: 'offered' as const,
      assignmentId,
      delivery,
      topCandidate,
      nowIso,
      expiresAtIso: expiresAt.toISOString(),
      riderNotif,
      custNotif,
      updatedDelivery,
    };
  });

  if (!committed || committed.kind === 'noop') return { offered: false };

  if (committed.kind === 'no_rider') {
    if (committed.custNotif) await broadcastWsEvent('notification:created', committed.custNotif);
    await broadcastWsEvent('delivery:updated', committed.updated);
    return { offered: false };
  }

  await broadcastWsEvent('notification:created', committed.riderNotif);
  if (committed.custNotif) await broadcastWsEvent('notification:created', committed.custNotif);
  await broadcastWsEvent('delivery:updated', committed.updatedDelivery);
  await broadcastWsEvent('assignment:offered', {
    id: committed.assignmentId,
    deliveryId,
    trackingCode: committed.delivery.trackingCode,
    riderId: committed.topCandidate.rider.riderId,
    riderProfileId: committed.topCandidate.rider.id,
    riderName: committed.topCandidate.rider.fullName,
    status: 'offered',
    score: committed.topCandidate.compositeScore,
    distanceToPickupKm: committed.topCandidate.distanceToPickupKm,
    routeCompatibilityScore: committed.topCandidate.routeCompatibilityScore,
    offeredAt: committed.nowIso,
    expiresAt: committed.expiresAtIso,
    delivery: committed.updatedDelivery && { ...committed.updatedDelivery, deliveryOtp: undefined },
  });

  scheduleOfferExpiry(committed.assignmentId, committed.expiresAtIso);

  return {
    offered: true,
    riderId: committed.topCandidate.rider.riderId,
    riderName: committed.topCandidate.rider.fullName,
  };
}
