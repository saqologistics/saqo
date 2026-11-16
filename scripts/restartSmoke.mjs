import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, rmdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';

const dir = await mkdtemp(path.join(os.tmpdir(), 'saqo-restart-'));
const source = path.join(dir, 'live.sqlite');
const snapshot = path.join(dir, 'backup.sqlite');
const restored = path.join(dir, 'restored.sqlite');
const portProbe = net.createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const origin = 'http://127.0.0.1:' + port;
const credentials = { email: 'admin@saqo.test', password: 'SmokeTestAdminPassword1' };
const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(port),
  SAQO_DATABASE_URL: '', SUPABASE_DB_URL: '',
  APP_URL: 'https://saqo.test', SAQO_SESSION_SECRET: 'local-smoke-test-secret-at-least-32-characters',
  SAQO_API_ORIGIN: 'https://api.saqo.test',
  SAQO_ADMIN_EMAIL: credentials.email, SAQO_ADMIN_PASSWORD: credentials.password,
  SAQO_TRUST_PROXY: '0', SAQO_DISPATCH_ALERT_SECONDS: '1', SAQO_ALERT_WEBHOOK_URL: '',
  SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '',
  VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '',
};

let server;
let alerts = '';
async function start(database) {
  server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    env: { ...env, SAQO_DB_PATH: database }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (chunk) => { alerts += chunk.toString(); process.stderr.write(chunk); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start.')), 15_000);
    server.once('exit', (code) => { clearTimeout(timeout); reject(new Error('Server exited: ' + code)); });
    server.stdout.on('data', (data) => {
      if (data.toString().includes('server listening')) { clearTimeout(timeout); resolve(); }
    });
  });
}

async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, 'exit');
  server.kill();
  await exited;
}

async function api(method, url, body, token, expected = 200) {
  const result = await fetch(origin + url, {
    method, signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await result.json();
  assert.equal(result.status, expected, method + ' ' + url + ' ' + JSON.stringify(payload));
  if (expected === 429) assert.ok(Number(result.headers.get('retry-after')) > 0);
  return payload;
}

async function backupCommand(args, expected = 0) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/sqliteBackup.ts', ...args], {
    env, stdio: ['ignore', 'inherit', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk.toString(); process.stderr.write(chunk); });
  assert.equal((await once(child, 'close'))[0], expected);
  return output;
}

try {
  await start(source);
  const preflight = await fetch(origin + '/api/auth/me', {
    method: 'OPTIONS', signal: AbortSignal.timeout(5000),
    headers: {
      Origin: env.APP_URL, 'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), env.APP_URL);
  const denied = await fetch(origin + '/api/settings/public', {
    headers: { Origin: 'https://unrelated.test' }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const admin = await api('POST', '/api/auth/login', credentials);
  const riderLogin = { email: 'rider@saqo.test', password: 'SmokeTestRiderPassword1' };
  await api('POST', '/api/admin/riders', {
    ...riderLogin, fullName: 'Smoke Rider', phone: '08012345678',
    plateNumber: 'QA-RIDER', homeState: 'Katsina', vehicleType: 'Motorcycle', verificationStatus: 'verified',
  }, admin.token, 201);
  const rider = await api('POST', '/api/auth/login', riderLogin);
  await api('PATCH', '/api/rider/availability', { isOnline: true }, rider.token);
  await api('PATCH', '/api/admin/settings', { maxActiveParcelsPerRider: 1, offerTimeoutSeconds: 120 }, admin.token);
  const customer = await api('POST', '/api/auth/register', {
    email: 'customer@saqo.test', password: 'SmokeCustomerPassword1', fullName: 'Smoke Customer', phone: '08012345679',
  }, undefined, 201);
  for (const route of ['/api/admin/overview', '/api/admin/payments/overview', '/api/admin/gateway-settings']) {
    await api('GET', route, null, admin.token);
    await api('GET', route, null, rider.token, 403);
    await api('GET', route, null, customer.token, 403);
  }
  const booking = {
    pickupAddress: 'Kofar Kaura, Katsina', destinationAddress: 'Daura Town, Katsina',
    recipientName: 'Smoke Recipient', recipientPhone: '08012345680', parcelDescription: 'Smoke Parcel', paymentMethod: 'cash',
  };
  const first = (await api('POST', '/api/deliveries', booking, customer.token, 201)).delivery;
  const second = (await api('POST', '/api/deliveries', booking, customer.token, 201)).delivery;
  assert.equal(first.status, 'assigned');
  assert.equal(second.status, 'no_rider_available');
  const originalOffer = (await api('GET', '/api/rider/dashboard', null, rider.token)).assignments.find((offer) => offer.deliveryId === first.id);
  assert.ok(originalOffer);

  const badLogin = { email: 'unknown@saqo.test', password: 'incorrect' };
  for (let i = 0; i < 5; i++) await api('POST', '/api/auth/login', badLogin, undefined, 401);
  await api('POST', '/api/auth/login', { ...badLogin, email: badLogin.email.toUpperCase() }, undefined, 429);
  await backupCommand(['backup', source, snapshot]);
  await backupCommand(['verify', snapshot]);
  const failed = await backupCommand(['backup', path.join(dir, 'missing.sqlite'), path.join(dir, 'invalid.sqlite')], 1);
  assert.match(failed, /"type":"backup_failure"/);
  await stop();

  // Make the queued parcel past the alert threshold even on fast CI runners.
  const liveDb = new DatabaseSync(source);
  liveDb.prepare('UPDATE delivery_requests SET created_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 2000).toISOString(), second.id);
  liveDb.close();
  await start(source);
  await api('POST', '/api/auth/login', badLogin, undefined, 429);
  assert.equal((await api('GET', '/api/track/' + second.trackingCode)).delivery.status, 'no_rider_available');
  for (let attempt = 0; attempt < 20 && !alerts.includes('"type":"dispatch_delay"'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(alerts, /"type":"dispatch_delay"/);
  const offers = (await api('GET', '/api/rider/dashboard', null, rider.token)).assignments;
  assert.ok(offers.some((offer) => offer.id === originalOffer.id && offer.status === 'offered'));
  await stop();

  await backupCommand(['restore', snapshot, restored]);
  await backupCommand(['restore', snapshot, restored], 1);
  const db = new DatabaseSync(restored);
  db.prepare("UPDATE delivery_assignments SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(originalOffer.id);
  db.close();
  await start(restored);
  let checked = await api('GET', '/api/rider/dashboard', null, rider.token);
  for (let attempt = 0; attempt < 20 &&
    !checked.assignments.some((offer) => offer.deliveryId === second.id && offer.status === 'offered'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    checked = await api('GET', '/api/rider/dashboard', null, rider.token);
  }
  assert.ok(checked.assignments.some((offer) => offer.id === originalOffer.id && offer.status === 'timed_out'));
  const queuedOffer = checked.assignments.find((offer) => offer.deliveryId === second.id && offer.status === 'offered');
  assert.ok(queuedOffer);

  const wsUrl = origin.replace('http', 'ws') + '/ws';
  const deniedSocket = new WebSocket(wsUrl, { origin: 'https://unrelated.test', handshakeTimeout: 5000 });
  const [deniedError] = await once(deniedSocket, 'error');
  assert.match(deniedError.message, /403/);
  const ws = new WebSocket(wsUrl, { origin: env.APP_URL, handshakeTimeout: 5000 });
  try {
    const [raw] = await once(ws, 'message');
    assert.equal(JSON.parse(raw).type, 'connected');
    const events = [];
    ws.on('message', (message) => events.push(JSON.parse(message)));
    ws.send(JSON.stringify({ type: 'auth', token: customer.token }));
    const pong = once(ws, 'pong', { signal: AbortSignal.timeout(5000) });
    ws.ping();
    await pong;

    const accepted = await api('POST', '/api/rider/assignments/' + queuedOffer.id + '/respond', { action: 'accept' }, rider.token);
    assert.equal(accepted.delivery.status, 'accepted');
    assert.ok(Number.isFinite(accepted.delivery.pickupLat));
    assert.ok(Number.isFinite(accepted.delivery.destinationLng));
    assert.ok(!accepted.delivery.deliveryOtp);
    const statusUrl = '/api/rider/deliveries/' + second.id + '/status';
    for (const status of ['heading_to_pickup', 'parcel_picked_up', 'in_transit', 'arrived_at_destination']) {
      assert.equal((await api('PATCH', statusUrl, { status }, rider.token)).delivery.status, status);
    }
    const delivered = await api('PATCH', statusUrl, { status: 'delivered', otp: second.deliveryOtp }, rider.token);
    assert.equal(delivered.delivery.status, 'delivered');
    const tracked = await api('GET', '/api/track/' + second.trackingCode);
    assert.equal(tracked.delivery.status, 'delivered');
    assert.ok(!tracked.delivery.deliveryOtp);
    const isDeliveredNotice = (event) => event.type === 'notification:created' && event.payload?.title === 'Parcel Delivered';
    for (let attempt = 0; attempt < 20 && !events.some(isDeliveredNotice); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(events.some(isDeliveredNotice));
  } finally {
    ws.close();
  }
  console.log('PASS SQLite backup and restore, queue recovery, rider acceptance, verified delivery, customer notification, and login throttling.');
} finally {
  await stop();
  for (const file of await readdir(dir)) await rm(path.join(dir, file));
  await rmdir(dir);
}
