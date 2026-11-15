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

const { initDatabase } = await import('./db');
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

test.after(() => {
  try {
    fs.rmSync(tempDbPath, { force: true });
    fs.rmSync(`${tempDbPath}-wal`, { force: true });
    fs.rmSync(`${tempDbPath}-shm`, { force: true });
  } catch {
    // ignore cleanup failures on Windows handles
  }
});
