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
  ...process.env, NODE_ENV: 'production', PORT: String(port),
  APP_URL: 'https://saqo.test', SAQO_SESSION_SECRET: 'local-smoke-test-secret-at-least-32-characters',
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

  await start(source);
  await api('POST', '/api/auth/login', badLogin, undefined, 429);
  assert.equal((await api('GET', '/api/track/' + second.trackingCode)).delivery.status, 'no_rider_available');
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
  assert.ok(checked.assignments.some((offer) => offer.deliveryId === second.id && offer.status === 'offered'));

  const ws = new WebSocket(origin.replace('http', 'ws') + '/ws');
  try {
    const [raw] = await once(ws, 'message');
    assert.equal(JSON.parse(raw).type, 'connected');
  } finally {
    ws.close();
  }
  console.log('PASS live SQLite backup, verified restore, queued delivery and offer recovery, WebSocket connection and persisted login throttling.');
} finally {
  await stop();
  for (const file of await readdir(dir)) await rm(path.join(dir, file));
  await rmdir(dir);
}
