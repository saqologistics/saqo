import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDbPath = path.join(os.tmpdir(), `saqo-webapp-test-${crypto.randomUUID()}.db`);
process.env.SAQO_DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.SAQO_SESSION_SECRET = 'a'.repeat(64);
process.env.APP_URL = 'https://saqo.vercel.app';
process.env.SAQO_FRONTEND_ORIGIN = 'https://saqo.vercel.app,https://www.saqo.ng';

const { db, initDatabase } = await import('./db');
const { dispatchNextRiderForDelivery } = await import('./dispatchEngine');
const { creditWalletAtomic } = await import('./paymentService');
const { WebApp } = await import('./webApp');
const { registerSaqoRoutes } = await import('./appRoutes');

await initDatabase();
const app = new WebApp();
registerSaqoRoutes(app);

test('Concurrent registration returns a conflict and creates one complete customer', async () => {
  const email = `race-${crypto.randomUUID()}@saqo.test`;
  const register = (address: string) => app.handle(new Request('https://example.test/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: address, password: 'test-password', fullName: 'Test Customer', phone: '08011112222' }),
  }));
  const replies = await Promise.all([register(email), register(email.toUpperCase())]);
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 409]);
  const result = await db.prepare(`
    SELECT COUNT(*) AS total FROM profiles JOIN customers ON customers.profile_id = profiles.id WHERE email = ?
  `).get(email);
  assert.equal(result?.total, 1);
});

test('A linked support conversation is inaccessible using its old guest token', async () => {
  const call = (route: string, body?: object, bearer?: string, method = body ? 'POST' : 'GET') =>
    app.handle(new Request(`https://example.test${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }));
  const register = async () => {
    const response = await call('/api/auth/register', {
      email: `support-${crypto.randomUUID()}@saqo.test`,
      password: 'test-password', fullName: 'Test Customer', phone: '08011112222',
    });
    assert.equal(response.status, 201);
    return (await response.json()).token as string;
  };
  const token = await register();
  const otherUser = await register();
  const visitorToken = crypto.randomUUID();
  const base = '/api/support/conversations';
  const created = await call(base, { visitorToken, visitorName: 'Guest', message: 'First message' });
  assert.equal(created.status, 201);
  const id = (await created.json()).conversation.id;
  const thread = `${base}/${id}`;
  assert.equal((await call(`${thread}/messages?visitorToken=${visitorToken}`)).status, 200);
  const claimed = await call(`${base}?visitorToken=${visitorToken}`, undefined, token);
  assert.equal((await claimed.json()).conversations[0].id, id);
  for (const bearer of [undefined, otherUser]) {
    const list = await call(`${base}?visitorToken=${visitorToken}`, undefined, bearer);
    assert.deepEqual((await list.json()).conversations, []);
    assert.equal((await call(`${thread}/messages?visitorToken=${visitorToken}`, undefined, bearer)).status, 403);
    assert.equal((await call(`${thread}/messages`, { visitorToken, body: 'Unauthorized' }, bearer)).status, 403);
    assert.equal((await call(`${thread}/read`, { visitorToken }, bearer)).status, 403);
    assert.equal((await call(`${thread}/status`, { visitorToken, status: 'resolved' }, bearer, 'PATCH')).status, 403);
  }
  assert.equal((await call(`${thread}/messages`, { body: 'Owner reply' }, token)).status, 201);
});

test('Invalid encoded route parameters produce a JSON 400', async () => {
  const response = await app.handle(new Request('https://example.test/api/track/%E0%A4%A'));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid URL parameter.' });
});

test('WebApp serves /api/health, CORS preflight, and rejects unauthorized origins', async () => {
  const health = await app.handle(
    new Request('https://example.supabase.co/functions/v1/saqo-api/api/health', {
      headers: { Origin: 'https://saqo.vercel.app' },
    }),
    '/functions/v1/saqo-api'
  );
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), 'https://saqo.vercel.app');
  assert.deepEqual(await health.json(), { ok: true, service: 'saqo-dispatch' });

  const preflight = await app.handle(
    new Request('https://example.supabase.co/saqo-api/api/auth/login', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://www.saqo.ng',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    }),
    '/saqo-api'
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://www.saqo.ng');

  const blocked = await app.handle(
    new Request('https://example.supabase.co/saqo-api/api/health', {
      headers: { Origin: 'https://evil.example' },
    }),
    '/saqo-api'
  );
  assert.equal(blocked.status, 403);
});

test('WebApp enforces JSON error handling and internal cron HMAC secret', async () => {
  const badJson = await app.handle(
    new Request('https://example.supabase.co/saqo-api/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    }),
    '/saqo-api'
  );
  assert.equal(badJson.status, 400);

  for (const invalid of ['wrong', 'é'.repeat(64)]) {
    const deniedTick = await app.handle(
      new Request('https://example.supabase.co/saqo-api/api/internal/dispatch-tick', {
        method: 'POST',
        headers: { 'X-Saqo-Cron-Secret': invalid },
      }),
      '/saqo-api'
    );
    assert.equal(deniedTick.status, 403);
  }

  const expected = crypto
    .createHmac('sha256', process.env.SAQO_SESSION_SECRET!)
    .update('saqo-dispatch-tick')
    .digest('hex');
  const okTick = await app.handle(
    new Request('https://example.supabase.co/saqo-api/api/internal/dispatch-tick', {
      method: 'POST',
      headers: { 'X-Saqo-Cron-Secret': expected },
    }),
    '/saqo-api'
  );
  assert.equal(okTick.status, 200);
  const tickJson = (await okTick.json()) as { ok: boolean; expiredCount: number };
  assert.equal(tickJson.ok, true);
  assert.equal(typeof tickJson.expiredCount, 'number');
});

test('End-to-end dispatch, default online riders, auto-reassignment, OTP popup error, rating, and profile editing', async () => {
  const api = async (pathUrl: string, options: RequestInit = {}, token?: string) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return app.handle(
      new Request(`https://example.supabase.co/saqo-api${pathUrl}`, { ...options, headers }),
      '/saqo-api'
    );
  };

  // Admin login (bootstrapped test admin)
  const adminLogin = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@saqo.ng', password: process.env.SAQO_ADMIN_PASSWORD || 'saqo1234' }),
  });
  assert.equal(adminLogin.status, 200);
  const { token: adminToken } = (await adminLogin.json()) as { token: string };

  // Create two verified riders -> both MUST default to online!
  const r1Res = await api(
    '/api/admin/riders',
    {
      method: 'POST',
      body: JSON.stringify({
        fullName: 'Rider One',
        email: 'r1-flow@saqo.ng',
        phone: '+2348010001001',
        password: 'password123',
        homeState: 'Katsina',
        vehicleType: 'Motorcycle',
        plateNumber: 'KTS-001',
        verificationStatus: 'verified',
      }),
    },
    adminToken
  );
  assert.equal(r1Res.status, 201);
  const r1Json = (await r1Res.json()) as { rider: { riderId: string; isOnline: boolean } };
  assert.equal(r1Json.rider.isOnline, true);

  const r2Res = await api(
    '/api/admin/riders',
    {
      method: 'POST',
      body: JSON.stringify({
        fullName: 'Rider Two',
        email: 'r2-flow@saqo.ng',
        phone: '+2348010001002',
        password: 'password123',
        homeState: 'Katsina',
        vehicleType: 'Van',
        plateNumber: 'KTS-002',
        verificationStatus: 'verified',
      }),
    },
    adminToken
  );
  assert.equal(r2Res.status, 201);
  const r2Json = (await r2Res.json()) as { rider: { riderId: string; isOnline: boolean } };
  assert.equal(r2Json.rider.isOnline, true);

  const r1Token = ((await (await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'r1-flow@saqo.ng', password: 'password123' }),
  })).json()) as { token: string }).token;
  const r2Token = ((await (await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'r2-flow@saqo.ng', password: 'password123' }),
  })).json()) as { token: string }).token;

  // Register client and update profile
  const cliReg = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      fullName: 'Amina Client',
      email: 'client-flow@saqo.ng',
      phone: '+2348091112222',
      password: 'password123',
    }),
  });
  assert.equal(cliReg.status, 201);
  const { token: clientToken } = (await cliReg.json()) as { token: string };

  const profEdit = await api(
    '/api/auth/profile',
    {
      method: 'PATCH',
      body: JSON.stringify({ fullName: 'Amina Bello', phone: '+2348091119999' }),
    },
    clientToken
  );
  assert.equal(profEdit.status, 200);
  const profJson = (await profEdit.json()) as { profile: { fullName: string; phone: string } };
  assert.equal(profJson.profile.fullName, 'Amina Bello');
  assert.equal(profJson.profile.phone, '+2348091119999');

  // Rider edits profile too
  const r2ProfEdit = await api(
    '/api/auth/profile',
    {
      method: 'PATCH',
      body: JSON.stringify({ fullName: 'Rider Two Updated', plateNumber: 'KTS-202' }),
    },
    r2Token
  );
  assert.equal(r2ProfEdit.status, 200);
  const r2ProfJson = (await r2ProfEdit.json()) as { rider: { fullName: string; plateNumber: string } };
  assert.equal(r2ProfJson.rider.fullName, 'Rider Two Updated');
  assert.equal(r2ProfJson.rider.plateNumber, 'KTS-202');

  // Client creates delivery -> offered individually to one rider
  const createDel = await api(
    '/api/deliveries',
    {
      method: 'POST',
      body: JSON.stringify({
        pickupState: 'Katsina',
        pickupAddress: 'GRA Roundabout, Katsina',
        pickupLat: 12.9908,
        pickupLng: 7.6018,
        destinationState: 'Katsina',
        destinationAddress: 'Kofar Kaura, Katsina',
        destinationLat: 12.979,
        destinationLng: 7.619,
        recipientName: 'Musa Receiver',
        recipientPhone: '+2348080009999',
        parcelCategory: 'Documents',
        parcelDescription: 'Signed deed',
        weightKg: 1,
        paymentMethod: 'cash',
      }),
    },
    clientToken
  );
  assert.equal(createDel.status, 201);
  const delJson = (await createDel.json()) as { delivery: { id: string; trackingCode: string; deliveryOtp: string; assignedRiderId: string } };
  const deliveryId = delJson.delivery.id;
  const firstRiderId = delJson.delivery.assignedRiderId;
  const firstToken = firstRiderId === r1Json.rider.riderId ? r1Token : r2Token;
  const secondRiderId = firstRiderId === r1Json.rider.riderId ? r2Json.rider.riderId : r1Json.rider.riderId;
  const secondToken = firstRiderId === r1Json.rider.riderId ? r2Token : r1Token;

  // Verify only one rider holds an offered assignment
  const firstDash = (await (await api('/api/rider/dashboard', {}, firstToken)).json()) as { assignments: Array<{ id: string; status: string }> };
  const secondDash0 = (await (await api('/api/rider/dashboard', {}, secondToken)).json()) as { assignments: Array<{ id: string; status: string }> };
  assert.equal(firstDash.assignments.filter((a) => a.status === 'offered').length, 1);
  assert.equal(secondDash0.assignments.filter((a) => a.status === 'offered').length, 0);

  // Simulate offer expiry -> ?checkExpiry=1 auto-reassigns in real time to second rider!
  const firstOfferId = firstDash.assignments[0].id;
  await db.prepare('UPDATE delivery_assignments SET expires_at = ? WHERE id = ?').run(
    new Date(Date.now() - 2000).toISOString(),
    firstOfferId
  );
  const secondDash1 = (await (await api('/api/rider/dashboard?checkExpiry=1', {}, secondToken)).json()) as {
    assignments: Array<{ id: string; status: string }>;
  };
  const activeSecondOffer = secondDash1.assignments.find((a) => a.status === 'offered');
  assert.ok(activeSecondOffer, 'Expired offer should auto-reassign to the second rider immediately');

  // Second rider accepts and advances to arrived_at_destination
  const acceptRes = await api(
    `/api/rider/assignments/${activeSecondOffer.id}/respond`,
    { method: 'POST', body: JSON.stringify({ action: 'accept' }) },
    secondToken
  );
  assert.equal(acceptRes.status, 200);

  for (const status of ['heading_to_pickup', 'parcel_picked_up', 'in_transit', 'arrived_at_destination']) {
    const stepRes = await api(
      `/api/rider/deliveries/${deliveryId}/status`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
      secondToken
    );
    assert.equal(stepRes.status, 200);
  }

  // Wrong OTP returns detailed error with remainingAttempts
  const wrongOtp = await api(
    `/api/rider/deliveries/${deliveryId}/status`,
    { method: 'PATCH', body: JSON.stringify({ status: 'delivered', otp: '0000' === delJson.delivery.deliveryOtp ? '1111' : '0000' }) },
    secondToken
  );
  assert.equal(wrongOtp.status, 400);
  const wrongOtpJson = (await wrongOtp.json()) as { error: string; remainingAttempts: number };
  assert.ok(wrongOtpJson.error.includes('attempt'));
  assert.equal(wrongOtpJson.remainingAttempts, 4);

  // Correct OTP completes delivery
  const completeRes = await api(
    `/api/rider/deliveries/${deliveryId}/status`,
    { method: 'PATCH', body: JSON.stringify({ status: 'delivered', otp: delJson.delivery.deliveryOtp }) },
    secondToken
  );
  assert.equal(completeRes.status, 200);

  // Client rates the rider 4 stars with comment -> persists & updates rider average rating
  const rateRes = await api(
    `/api/deliveries/${deliveryId}/rate`,
    { method: 'POST', body: JSON.stringify({ rating: 4, comment: 'Smooth pickup and polite!' }) },
    clientToken
  );
  assert.equal(rateRes.status, 200);
  const rateJson = (await rateRes.json()) as { delivery: { riderRating: number; riderRatingComment: string } };
  assert.equal(rateJson.delivery.riderRating, 4);
  assert.equal(rateJson.delivery.riderRatingComment, 'Smooth pickup and polite!');

  const secondDashAfter = (await (await api('/api/rider/dashboard', {}, secondToken)).json()) as {
    rider: { riderId: string; rating: number };
  };
  assert.equal(secondDashAfter.rider.riderId, secondRiderId);
  assert.equal(secondDashAfter.rider.rating, 4);
});

test('Concurrency, race conditions, OTP isolation, wallet atomicity, and DB support presence', async () => {
  const api = async (pathUrl: string, options: RequestInit = {}, token?: string) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return app.handle(
      new Request(`https://example.supabase.co/saqo-api${pathUrl}`, { ...options, headers }),
      '/saqo-api'
    );
  };

  const adminLogin = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@saqo.ng', password: process.env.SAQO_ADMIN_PASSWORD || 'saqo1234' }),
  });
  assert.equal(adminLogin.status, 200);
  const { token: adminToken } = (await adminLogin.json()) as { token: string };

  // Check admin support presence persistence in DB
  const setAway = await api(
    '/api/admin/support/presence',
    { method: 'POST', body: JSON.stringify({ available: false }) },
    adminToken
  );
  assert.equal(setAway.status, 200);
  const awayRow = (await db.prepare('SELECT admin_accepting_chats FROM platform_settings WHERE id = 1').get()) as {
    admin_accepting_chats: number;
  };
  assert.equal(awayRow.admin_accepting_chats, 0);
  const pubPresence = (await (await api('/api/support/presence')).json()) as { adminOnline: boolean };
  assert.equal(pubPresence.adminOnline, false);
  const adminConvsAway = (await (await api('/api/admin/support/conversations', {}, adminToken)).json()) as {
    adminAcceptingChats: boolean;
  };
  assert.equal(adminConvsAway.adminAcceptingChats, false);

  const setBack = await api(
    '/api/admin/support/presence',
    { method: 'POST', body: JSON.stringify({ available: true }) },
    adminToken
  );
  assert.equal(setBack.status, 200);

  const originalEdgeRuntime = process.env.SAQO_EDGE_RUNTIME;
  process.env.SAQO_EDGE_RUNTIME = '1';
  try {
    const heartbeat = '/api/admin/support/heartbeat';
    const heartbeatRequest = { method: 'POST' };
    assert.equal((await api(heartbeat, heartbeatRequest)).status, 401);
    await db.prepare('UPDATE support_agent_heartbeats SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    assert.deepEqual(await (await api('/api/support/presence')).json(), { adminOnline: false, onlineAdminCount: 0 });
    const heartbeats = await Promise.all([api(heartbeat, heartbeatRequest, adminToken), api(heartbeat, heartbeatRequest, adminToken)]);
    for (const reply of heartbeats) {
      assert.equal(reply.status, 200);
      assert.deepEqual((await reply.json()).presence, { adminOnline: true, onlineAdminCount: 1 });
    }
    assert.deepEqual(await (await api('/api/support/presence')).json(), { adminOnline: true, onlineAdminCount: 1 });
  } finally {
    if (originalEdgeRuntime === undefined) delete process.env.SAQO_EDGE_RUNTIME;
    else process.env.SAQO_EDGE_RUNTIME = originalEdgeRuntime;
  }

  // Create fresh verified rider + client for concurrency tests
  const rcEmail = `race-rider-${crypto.randomUUID().slice(0, 6)}@saqo.ng`;
  const rcRes = await api(
    '/api/admin/riders',
    {
      method: 'POST',
      body: JSON.stringify({
        fullName: 'Race Rider',
        email: rcEmail,
        phone: '+2348050001001',
        password: 'password123',
        homeState: 'Katsina',
        vehicleType: 'Motorcycle',
        plateNumber: `KTS-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
        verificationStatus: 'verified',
      }),
    },
    adminToken
  );
  assert.equal(rcRes.status, 201);
  const { rider: rcRider } = (await rcRes.json()) as { rider: { riderId: string } };
  const rcToken = ((await (await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: rcEmail, password: 'password123' }),
  })).json()) as { token: string }).token;

  const cliEmail = `race-client-${crypto.randomUUID().slice(0, 6)}@saqo.ng`;
  const cliReg = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      fullName: 'Race Client',
      email: cliEmail,
      phone: '+2348050002002',
      password: 'password123',
    }),
  });
  assert.equal(cliReg.status, 201);
  const { token: cliToken, profile: cliProfile } = (await cliReg.json()) as {
    token: string;
    profile: { id: string };
  };

  // Credit client wallet enough for 2 deliveries so only delivery payment guard can stop double debit
  await creditWalletAtomic({
    userId: cliProfile.id,
    amountNgn: 50000,
    reference: `TST-FUND-${crypto.randomUUID().slice(0, 8)}`,
    category: 'admin_adjustment',
    description: 'Test funding',
    actorUserId: cliProfile.id,
    actorRole: 'admin',
  });

  // 1. Concurrent wallet payment with distinct idempotency keys must only debit once
  const cashDelRes = await api(
    '/api/deliveries',
    {
      method: 'POST',
      body: JSON.stringify({
        pickupState: 'Katsina',
        pickupAddress: 'Kofar Kaura, Katsina',
        pickupLat: 12.979,
        pickupLng: 7.619,
        destinationState: 'Katsina',
        destinationAddress: 'GRA Roundabout, Katsina',
        destinationLat: 12.9908,
        destinationLng: 7.6018,
        recipientName: 'Wallet Test Receiver',
        recipientPhone: '+2348081112233',
        parcelCategory: 'Documents',
        parcelDescription: 'Double spend guard test',
        weightKg: 1,
        paymentMethod: 'cash',
      }),
    },
    cliToken
  );
  assert.equal(cashDelRes.status, 201);
  const { delivery: walletTestDel } = (await cashDelRes.json()) as {
    delivery: { id: string; deliveryFeeNgn: number; trackingCode: string; deliveryOtp: string };
  };

  // 1a. Concurrent dispatchNextRiderForDelivery cannot double-offer same delivery
  await db.prepare('UPDATE delivery_requests SET status = ?, assigned_rider_id = NULL WHERE id = ?').run(
    'pending_dispatch',
    walletTestDel.id
  );
  await db.prepare("DELETE FROM delivery_assignments WHERE delivery_id = ?").run(walletTestDel.id);
  await Promise.all([
    dispatchNextRiderForDelivery(walletTestDel.id),
    dispatchNextRiderForDelivery(walletTestDel.id),
    dispatchNextRiderForDelivery(walletTestDel.id),
  ]);
  const offeredRows = (await db
    .prepare("SELECT id FROM delivery_assignments WHERE delivery_id = ? AND status = 'offered'")
    .all(walletTestDel.id)) as Array<{ id: string }>;
  assert.equal(offeredRows.length, 1, 'Concurrent dispatches must create only 1 offered assignment');

  const [pay1, pay2] = await Promise.all([
    api(
      `/api/deliveries/${walletTestDel.id}/pay`,
      { method: 'POST', body: JSON.stringify({ paymentMethod: 'wallet', idempotencyKey: `key-a-${crypto.randomUUID()}` }) },
      cliToken
    ),
    api(
      `/api/deliveries/${walletTestDel.id}/pay`,
      { method: 'POST', body: JSON.stringify({ paymentMethod: 'wallet', idempotencyKey: `key-b-${crypto.randomUUID()}` }) },
      cliToken
    ),
  ]);
  const payStatuses = [pay1.status, pay2.status].sort();
  assert.deepEqual(payStatuses, [200, 400], 'Concurrent pay-wallet with distinct keys must succeed once and reject once');
  const walletRow = (await db.prepare('SELECT balance_ngn FROM wallets WHERE user_id = ?').get(cliProfile.id)) as {
    balance_ngn: number;
  };
  assert.equal(walletRow.balance_ngn, 50000 - walletTestDel.deliveryFeeNgn, 'Wallet must be debited exactly once');

  // 2. Assign to race rider cleanly and test double completion guard (rider PATCH vs public OTP confirm)
  const forceAssign = await api(
    `/api/admin/deliveries/${walletTestDel.id}/assign`,
    { method: 'POST', body: JSON.stringify({ riderId: rcRider.riderId }) },
    adminToken
  );
  assert.equal(forceAssign.status, 200);
  for (const status of ['heading_to_pickup', 'parcel_picked_up', 'in_transit', 'arrived_at_destination']) {
    const sRes = await api(
      `/api/rider/deliveries/${walletTestDel.id}/status`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
      rcToken
    );
    assert.equal(sRes.status, 200);
  }

  // Public OTP brute-force lockout (6 wrong guesses from attacker IP) must NOT lock out authenticated rider
  for (let i = 0; i < 6; i++) {
    const wrongPub = await api(`/api/track/${walletTestDel.trackingCode}/confirm-otp`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ otp: walletTestDel.deliveryOtp === '0000' ? '1111' : '0000' }),
    });
    assert.ok([400, 429].includes(wrongPub.status));
  }
  const lockedPub = await api(`/api/track/${walletTestDel.trackingCode}/confirm-otp`, {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify({ otp: walletTestDel.deliveryOtp }),
  });
  assert.equal(lockedPub.status, 429, 'Public brute-forcer IP bucket should be locked');

  // Race rider completion (even sharing the locked IP) against a clean recipient public confirmation!
  const beforeRiderRow = (await db
    .prepare('SELECT completed_deliveries_count, total_earnings_ngn FROM riders WHERE id = ?')
    .get(rcRider.riderId)) as { completed_deliveries_count: number; total_earnings_ngn: number };
  const payRec = (await db
    .prepare('SELECT rider_payout_ngn FROM payments WHERE delivery_id = ?')
    .get(walletTestDel.id)) as { rider_payout_ngn: number };

  const [compRider, compPublic] = await Promise.all([
    api(
      `/api/rider/deliveries/${walletTestDel.id}/status`,
      {
        method: 'PATCH',
        headers: { 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ status: 'delivered', otp: walletTestDel.deliveryOtp }),
      },
      rcToken
    ),
    api(`/api/track/${walletTestDel.trackingCode}/confirm-otp`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.4' },
      body: JSON.stringify({ otp: walletTestDel.deliveryOtp }),
    }),
  ]);
  const compStatuses = [compRider.status, compPublic.status].sort();
  assert.deepEqual(compStatuses, [200, 400], 'Concurrent rider + public completion must complete once and reject duplicate');

  const afterRiderRow = (await db
    .prepare('SELECT completed_deliveries_count, total_earnings_ngn FROM riders WHERE id = ?')
    .get(rcRider.riderId)) as { completed_deliveries_count: number; total_earnings_ngn: number };
  assert.equal(afterRiderRow.completed_deliveries_count, beforeRiderRow.completed_deliveries_count + 1);
  assert.equal(afterRiderRow.total_earnings_ngn, beforeRiderRow.total_earnings_ngn + payRec.rider_payout_ngn);

  // 3. Test concurrent rider PATCH + cancel or concurrent accept vs cancel
  const raceDelRes = await api(
    '/api/deliveries',
    {
      method: 'POST',
      body: JSON.stringify({
        pickupState: 'Katsina',
        pickupAddress: 'Batagarawa Road, Katsina',
        pickupLat: 12.95,
        pickupLng: 7.60,
        destinationState: 'Katsina',
        destinationAddress: 'Central Market, Katsina',
        destinationLat: 12.989,
        destinationLng: 7.601,
        recipientName: 'Accept vs Cancel Receiver',
        recipientPhone: '+2348089998877',
        parcelCategory: 'Documents',
        parcelDescription: 'Race test parcel',
        weightKg: 1,
        paymentMethod: 'cash',
      }),
    },
    cliToken
  );
  assert.equal(raceDelRes.status, 201);
  const { delivery: raceDel } = (await raceDelRes.json()) as { delivery: { id: string } };
  const raceDash = (await (await api('/api/rider/dashboard', {}, rcToken)).json()) as {
    assignments: Array<{ id: string; deliveryId: string; status: string }>;
  };
  const raceOffer = raceDash.assignments.find((a) => a.deliveryId === raceDel.id && a.status === 'offered');
  assert.ok(raceOffer);

  const [acceptRace, cancelRace] = await Promise.all([
    api(
      `/api/rider/assignments/${raceOffer.id}/respond`,
      { method: 'POST', body: JSON.stringify({ action: 'accept' }) },
      rcToken
    ),
    api(`/api/deliveries/${raceDel.id}/cancel`, { method: 'POST' }, cliToken),
  ]);
  const finalRaceDel = (await (await api(`/api/client/deliveries`, {}, cliToken)).json()) as {
    deliveries: Array<{ id: string; status: string }>;
  };
  const matched = finalRaceDel.deliveries.find((d) => d.id === raceDel.id)!;
  assert.ok(
    (acceptRace.status === 200 && cancelRace.status === 200 && matched.status === 'cancelled') ||
      (acceptRace.status !== 200 && cancelRace.status === 200 && matched.status === 'cancelled'),
    'Accept vs cancel race must resolve deterministically cleanly'
  );

  // 4. Going offline while holding an unaccepted offer immediately releases the offer
  const offDelRes = await api(
    '/api/deliveries',
    {
      method: 'POST',
      body: JSON.stringify({
        pickupState: 'Katsina',
        pickupAddress: 'Batagarawa Road, Katsina',
        pickupLat: 12.95,
        pickupLng: 7.60,
        destinationState: 'Katsina',
        destinationAddress: 'Central Market, Katsina',
        destinationLat: 12.989,
        destinationLng: 7.601,
        recipientName: 'Offline Release Receiver',
        recipientPhone: '+2348087776655',
        parcelCategory: 'Documents',
        parcelDescription: 'Offline offer release test',
        weightKg: 1,
        paymentMethod: 'cash',
      }),
    },
    cliToken
  );
  assert.equal(offDelRes.status, 201);
  const { delivery: offDel } = (await offDelRes.json()) as { delivery: { id: string; assignedRiderId: string } };
  assert.equal(offDel.assignedRiderId, rcRider.riderId);

  const goOffline = await api(
    '/api/rider/availability',
    { method: 'PATCH', body: JSON.stringify({ isOnline: false }) },
    rcToken
  );
  assert.equal(goOffline.status, 200);
  const stillOfferedForOffline = (await db
    .prepare("SELECT id FROM delivery_assignments WHERE delivery_id = ? AND rider_id = ? AND status = 'offered'")
    .all(offDel.id, rcRider.riderId)) as Array<{ id: string }>;
  assert.equal(stillOfferedForOffline.length, 0, 'Offline rider must no longer hold an open offered assignment');
});

test.after(() => {
  try {
    fs.rmSync(tempDbPath, { force: true });
    fs.rmSync(`${tempDbPath}-wal`, { force: true });
    fs.rmSync(`${tempDbPath}-shm`, { force: true });
  } catch {
    // ignore cleanup failures on Windows handles
  }
});
