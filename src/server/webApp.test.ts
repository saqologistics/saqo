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
const { WebApp } = await import('./webApp');
const { registerSaqoRoutes } = await import('./appRoutes');

await initDatabase();
const app = new WebApp();
registerSaqoRoutes(app);

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

  const deniedTick = await app.handle(
    new Request('https://example.supabase.co/saqo-api/api/internal/dispatch-tick', {
      method: 'POST',
      headers: { 'X-Saqo-Cron-Secret': 'wrong' },
    }),
    '/saqo-api'
  );
  assert.equal(deniedTick.status, 403);

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

test.after(() => {
  try {
    fs.rmSync(tempDbPath, { force: true });
    fs.rmSync(`${tempDbPath}-wal`, { force: true });
    fs.rmSync(`${tempDbPath}-shm`, { force: true });
  } catch {
    // ignore cleanup failures on Windows handles
  }
});
