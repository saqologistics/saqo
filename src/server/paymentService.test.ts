import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDbPath = path.join(os.tmpdir(), `saqo-pay-test-${crypto.randomUUID()}.db`);
process.env.SAQO_DB_PATH = tempDbPath;
process.env.VITE_SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const { db, initDatabase, hashPassword, signSessionToken, verifySessionToken, getDeliveryById, publicTrackingDelivery } = await import('./db');
const pay = await import('./paymentService');
const whatsapp = await import('./whatsapp');
const { sendOpsAlert } = await import('./opsAlerts');

initDatabase();

test('operations alerts deliver structured JSON and coalesce a repeated event', async (t) => {
  const previousUrl = process.env.SAQO_ALERT_WEBHOOK_URL;
  const previousToken = process.env.SAQO_ALERT_WEBHOOK_TOKEN;
  process.env.SAQO_ALERT_WEBHOOK_URL = 'https://monitor.saqo.test/events';
  process.env.SAQO_ALERT_WEBHOOK_TOKEN = 'test-token';
  t.after(() => {
    if (previousUrl === undefined) delete process.env.SAQO_ALERT_WEBHOOK_URL;
    else process.env.SAQO_ALERT_WEBHOOK_URL = previousUrl;
    if (previousToken === undefined) delete process.env.SAQO_ALERT_WEBHOOK_TOKEN;
    else process.env.SAQO_ALERT_WEBHOOK_TOKEN = previousToken;
  });
  t.mock.method(console, 'warn', () => {});
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  const details = { reason: 'verified_gateway_decline', reference: 'test-payment' };
  await sendOpsAlert('payment_failure', details);
  await sendOpsAlert('payment_failure', details);
  assert.equal(request.mock.callCount(), 1);
  const [url, options] = request.mock.calls[0].arguments as unknown as [URL, RequestInit];
  assert.equal(url.href, 'https://monitor.saqo.test/events');
  assert.equal(new Headers(options.headers).get('authorization'), 'Bearer test-token');
  assert.equal(options.redirect, 'error');
  const payload = JSON.parse(options.body as string);
  assert.equal(payload.type, 'payment_failure');
  assert.deepEqual(payload.details, details);
});

test('Twilio WhatsApp orders require a signed request and confirmation and persist only once', async (t) => {
  const config = {
    APP_URL: 'https://saqo.test',
    TWILIO_ACCOUNT_SID: 'AC' + '1'.repeat(32),
    TWILIO_AUTH_TOKEN: 'test-whatsapp-secret',
    TWILIO_WHATSAPP_FROM: 'whatsapp:+2348000000000',
  };
  for (const [key, value] of Object.entries(config)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const path = whatsapp.TWILIO_WHATSAPP_PATH;
  const send = (body: string, sid = 'SM' + crypto.randomBytes(16).toString('hex'), signed = true) => {
    const fields = {
      AccountSid: config.TWILIO_ACCOUNT_SID, To: config.TWILIO_WHATSAPP_FROM,
      From: 'whatsapp:+2348111111111', ProfileName: 'WhatsApp Test', MessageSid: sid, Body: body,
    };
    const input = config.APP_URL + path + Object.entries(fields).sort(([a], [b]) => a < b ? -1 : 1)
      .map(([key, value]) => key + value).join('');
    const signature = signed ? crypto.createHmac('sha1', config.TWILIO_AUTH_TOKEN).update(input).digest('base64') : 'invalid';
    return whatsapp.handleTwilioWhatsApp(fields, signature, path);
  };
  assert.equal(whatsapp.getWhatsAppOrderNumber(), '2348000000000');
  assert.equal(send('ORDER', undefined, false).status, 403);
  assert.match(send('APP').text, /https:\/\/saqo\.test\/\?order=1/);
  assert.match(send('ORDER').text, /collect your parcel/);
  assert.match(send('Kofar Kaura').text, /1\. Kofar Kaura/);
  assert.match(send('1').text, /Pickup set to Kofar Kaura/);
  assert.match(send('Daura').text, /1\. Daura Town/);
  for (const message of ['1', 'Parcel Recipient', '08015555555', 'Documents & photos']) {
    assert.equal(send(message).status, 200);
  }
  const quote = send('1.5');
  assert.match(quote.text, /Documents &amp; photos/);
  assert.match(quote.text, /Reply CONFIRM/);
  assert.equal(db.prepare("SELECT id FROM profiles WHERE phone = '+2348111111111'").get(), undefined);
  const sid = 'SM' + crypto.randomBytes(16).toString('hex');
  const confirmation = send('CONFIRM', sid);
  assert.match(confirmation.text, /Booked.*SQ-\d{4}-[A-F\d]{18}/);
  assert.match(confirmation.text, /Handoff code: \d{4}/);
  assert.doesNotMatch(send('CONFIRM', sid).text, /<Message>/);
  const latest = send('STATUS').text;
  assert.match(latest, /Latest booking/);
  assert.equal(latest.match(/Handoff code: \d{4}/)?.[0], confirmation.text.match(/Handoff code: \d{4}/)?.[0]);
  const rows = db.prepare(`
    SELECT d.pickup_state, d.destination_state, d.payment_method, d.payment_reference
    FROM delivery_requests d JOIN customers c ON d.customer_id = c.id
    JOIN profiles p ON p.id = c.profile_id WHERE p.phone = '+2348111111111'
  `).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pickup_state, 'Katsina');
  assert.equal(rows[0].destination_state, 'Katsina');
  assert.equal(rows[0].payment_method, 'cash');
  assert.ok(rows[0].payment_reference);

  assert.match(send('SUPPORT').text, /Type your message/);
  const supportSid = 'SM' + crypto.randomBytes(16).toString('hex');
  assert.match(send('Can you assist?', supportSid).text, /message is with/);
  send('Can you assist?', supportSid);
  const conversation = db.prepare("SELECT id FROM support_conversations WHERE visitor_phone = '+2348111111111'").get() as { id: string };
  assert.equal(db.prepare('SELECT id FROM support_messages WHERE conversation_id = ?').all(conversation.id).length, 1);
  const twilioRequest = t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'queued' }, { status: 201 }));
  await whatsapp.sendWhatsAppSupportReply(conversation.id, 'How can we help?');
  assert.equal(twilioRequest.mock.callCount(), 1);
  db.prepare("UPDATE whatsapp_sessions SET last_inbound_at = '2000-01-01T00:00:00Z' WHERE phone = '+2348111111111'").run();
  await assert.rejects(whatsapp.sendWhatsAppSupportReply(conversation.id, 'Another reply'), /reply window has closed/);
  assert.equal(twilioRequest.mock.callCount(), 1);
});

test('sessions expire after twelve hours', (t) => {
  const issuedAt = Date.UTC(2026, 10, 15);
  const clock = t.mock.method(Date, 'now', () => issuedAt);
  const token = signSessionToken({ userId: 'test-client', role: 'client' });
  assert.equal(verifySessionToken(token)?.userId, 'test-client');
  clock.mock.mockImplementation(() => issuedAt + 12 * 60 * 60 * 1000);
  assert.equal(verifySessionToken(token), null);
});

test('public tracking excludes customer contacts, payment references, and the handoff OTP', () => {
  const customer = createTestUser();
  const { deliveryId } = createTestDelivery(customer.roleId, customer.profileId);
  const delivery = getDeliveryById(deliveryId);
  assert.ok(delivery);
  const tracking = publicTrackingDelivery(delivery);
  assert.equal(tracking.trackingCode, delivery.trackingCode);
  assert.equal(tracking.destinationLat, delivery.destinationLat);
  for (const key of ['customerName', 'customerPhone', 'recipientName', 'recipientPhone', 'deliveryOtp', 'paymentReference', 'assignedRiderPhone', 'parcelDescription']) {
    assert.equal(Object.hasOwn(tracking, key), false);
  }
});

test('concurrent checkout requests reuse the same link and enforce customer ownership', async (t) => {
  const owner = createTestUser();
  const stranger = createTestUser();
  const { deliveryId } = createTestDelivery(owner.roleId, owner.profileId, 1500, 'flutterwave');
  const secret = process.env.FLUTTERWAVE_SECRET_KEY;
  process.env.FLUTTERWAVE_SECRET_KEY = 'mock-secret';
  db.prepare("UPDATE payment_gateway_settings SET is_enabled = 1 WHERE id = 'default'").run();
  t.after(() => {
    if (secret === undefined) delete process.env.FLUTTERWAVE_SECRET_KEY;
    else process.env.FLUTTERWAVE_SECRET_KEY = secret;
    db.prepare("UPDATE payment_gateway_settings SET is_enabled = 0 WHERE id = 'default'").run();
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = t.mock.method(globalThis, 'fetch', async () => {
    await gate;
    return Response.json({ status: 'success', data: { link: 'https://checkout.flutterwave.com/mock' } });
  });
  const request = {
    deliveryId, userId: owner.profileId, customerName: 'Test Client',
    customerEmail: owner.email, customerPhone: '08000000000', redirectUrl: 'https://saqo.test/',
    idempotencyKey: crypto.randomUUID(),
  };
  const first = pay.initializeDeliveryFlutterwavePayment(request);
  const second = pay.initializeDeliveryFlutterwavePayment({ ...request, idempotencyKey: crypto.randomUUID() });
  const unauthorized = assert.rejects(pay.initializeDeliveryFlutterwavePayment({ ...request, userId: stranger.profileId }), /not authorized/);
  release();
  const [a, b] = await Promise.all([first, second]);
  await unauthorized;
  assert.equal(a.id, b.id);
  assert.equal(a.checkoutUrl, b.checkoutUrl);
  assert.equal(provider.mock.callCount(), 1);
});

test('wallet credit failure rolls back paid status and a later verification credits once', () => {
  const { profileId } = createTestUser();
  const wallet = pay.ensureWallet(profileId);
  const reference = pay.generateReference('WLT');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO payment_transactions (id, reference, user_id, wallet_id, purpose, payment_method,
      provider, amount_ngn, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'wallet_funding', 'flutterwave', 'flutterwave', 1000, 'pending', ?, ?)
  `).run(crypto.randomUUID(), reference, profileId, wallet.id, now, now);
  const [tx] = pay.getCustomerWalletSummary(profileId).paymentTransactions;
  const flw = {
    flwTxId: '7779501', txRef: reference, amount: 1000, currency: 'NGN',
    status: 'successful', paymentType: 'card', processorResponse: 'Approved', raw: {},
  };
  db.prepare("UPDATE wallets SET status = 'frozen' WHERE id = ?").run(wallet.id);
  assert.throws(() => pay.settleVerifiedPaymentTransaction({ tx, flw, verifiedBy: 'webhook' }), /frozen/);
  assert.equal(pay.getCustomerWalletSummary(profileId).paymentTransactions[0].status, 'pending');
  db.prepare("UPDATE wallets SET status = 'active' WHERE id = ?").run(wallet.id);
  assert.throws(() => pay.settleVerifiedPaymentTransaction({
    tx, flw: { ...flw, amount: 999.99 }, verifiedBy: 'webhook',
  }), /less than expected/);
  pay.settleVerifiedPaymentTransaction({ tx, flw, verifiedBy: 'webhook' });
  assert.equal(pay.settleVerifiedPaymentTransaction({ tx, flw, verifiedBy: 'callback' }).alreadyProcessed, true);
  assert.equal(pay.ensureWallet(profileId).balanceNgn, 1000);
});

test('a failed webhook can retry while a concurrent callback settles the same payment', async (t) => {
  const { profileId } = createTestUser();
  const wallet = pay.ensureWallet(profileId);
  const reference = pay.generateReference('WLT');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO payment_transactions (id, reference, user_id, wallet_id, purpose, payment_method,
      provider, amount_ngn, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'wallet_funding', 'flutterwave', 'flutterwave', 1000, 'pending', ?, ?)
  `).run(crypto.randomUUID(), reference, profileId, wallet.id, now, now);
  const previousSecret = process.env.FLUTTERWAVE_SECRET_KEY;
  const previousHash = process.env.FLUTTERWAVE_WEBHOOK_HASH;
  process.env.FLUTTERWAVE_SECRET_KEY = 'mock-secret';
  process.env.FLUTTERWAVE_WEBHOOK_HASH = 'mock-webhook-hash';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.FLUTTERWAVE_SECRET_KEY;
    else process.env.FLUTTERWAVE_SECRET_KEY = previousSecret;
    if (previousHash === undefined) delete process.env.FLUTTERWAVE_WEBHOOK_HASH;
    else process.env.FLUTTERWAVE_WEBHOOK_HASH = previousHash;
  });
  const data = { id: 7779504, tx_ref: reference, amount: 1000, currency: 'NGN', status: 'successful' };
  const payload = { event: 'charge.completed', data };
  const webhook = {
    headers: { 'verif-hash': 'mock-webhook-hash' },
    rawBody: JSON.stringify(payload),
    payload,
  };
  let fail = true;
  t.mock.method(globalThis, 'fetch', async () =>
    fail ? Response.json({ status: 'error' }, { status: 503 }) : Response.json({ status: 'success', data })
  );
  assert.equal((await pay.processFlutterwaveWebhook(webhook)).status, 'failed');
  assert.equal(pay.ensureWallet(profileId).balanceNgn, 0);
  fail = false;
  const [retry] = await Promise.all([
    pay.processFlutterwaveWebhook(webhook),
    pay.confirmFlutterwaveTransaction({ txRef: reference, verifiedByUserId: profileId, source: 'callback' }),
  ]);
  assert.equal(retry.status, 'processed');
  assert.equal((await pay.processFlutterwaveWebhook(webhook)).duplicate, true);
  assert.equal(pay.ensureWallet(profileId).balanceNgn, 1000);
});

test('an in-flight Flutterwave refund reserves the balance until provider verification', async (t) => {
  const { profileId } = createTestUser();
  const admin = createTestUser('admin');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO payment_transactions (id, reference, user_id, purpose, payment_method, provider,
      provider_tx_id, amount_ngn, status, created_at, updated_at)
    VALUES (?, ?, ?, 'wallet_funding', 'flutterwave', 'flutterwave', '7779502', 1000, 'paid', ?, ?)
  `).run(id, pay.generateReference('WLT'), profileId, now, now);
  const secret = process.env.FLUTTERWAVE_SECRET_KEY;
  process.env.FLUTTERWAVE_SECRET_KEY = 'mock-secret';
  t.after(() => {
    if (secret === undefined) delete process.env.FLUTTERWAVE_SECRET_KEY;
    else process.env.FLUTTERWAVE_SECRET_KEY = secret;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = t.mock.method(globalThis, 'fetch', async (url: string) => {
    await gate;
    return Response.json({
      status: 'success', data: { id: 7779503, status: url.includes('/v3/refunds/') ? 'completed-mpgs' : 'completed' },
    });
  });
  const request = {
    paymentTransactionId: id, amountNgn: 1000, destination: 'flutterwave' as const,
    reason: 'Customer request', adminId: admin.profileId,
  };
  const first = pay.processAdminRefund(request);
  const duplicate = assert.rejects(pay.processAdminRefund(request), /refund is already pending/);
  release();
  const pending = await first;
  await duplicate;
  assert.equal(pending.status, 'pending');
  assert.equal(provider.mock.callCount(), 1);
  assert.equal(await pay.refreshFlutterwaveRefund(pending.id), 'completed');
  assert.equal(pay.getCustomerWalletSummary(profileId).paymentTransactions[0].status, 'refunded');
});

function createTestUser(role: 'client' | 'rider' | 'admin' = 'client') {
  const now = new Date().toISOString();
  const profileId = `prof-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${role}-${profileId}@test.saqo.ng`;
  db.prepare(`
    INSERT INTO profiles (id, email, password_hash, full_name, phone, role, account_status, created_at)
    VALUES (?, ?, ?, ?, '+2348011112222', ?, 'active', ?)
  `).run(profileId, email, hashPassword('pass1234'), `Test ${role}`, role, now);

  if (role === 'client') {
    const custId = `cust-${crypto.randomUUID().slice(0, 8)}`;
    db.prepare('INSERT INTO customers (id, profile_id, default_state) VALUES (?, ?, ?)').run(
      custId,
      profileId,
      'Katsina'
    );
    return { profileId, roleId: custId, email };
  }
  if (role === 'rider') {
    const riderId = `rider-${crypto.randomUUID().slice(0, 8)}`;
    db.prepare(`
      INSERT INTO riders (id, profile_id, vehicle_type, plate_number, home_state, verification_status, is_online, current_lat, current_lng, last_location_at)
      VALUES (?, ?, 'Motorcycle', 'KTS-TEST', 'Katsina', 'verified', 1, 12.9908, 7.6018, ?)
    `).run(riderId, profileId, now);
    return { profileId, roleId: riderId, email };
  }
  return { profileId, roleId: profileId, email };
}

function createTestDelivery(customerId: string, customerProfileId: string, fee = 1500, method: 'wallet' | 'flutterwave' | 'cash' | 'bank_transfer' = 'cash') {
  const deliveryId = `del-${crypto.randomUUID().slice(0, 8)}`;
  const trackingCode = `SQ-TEST-${Math.floor(1000 + Math.random() * 9000)}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO delivery_requests (
      id, tracking_code, customer_id, pickup_state, pickup_address, pickup_lat, pickup_lng,
      destination_state, destination_address, destination_lat, destination_lng,
      recipient_name, recipient_phone, service_tier, distance_km, estimated_minutes,
      delivery_fee_ngn, payment_method, payment_status, delivery_otp, otp_verified, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'Katsina', 'GRA Roundabout', 12.99, 7.60, 'Katsina', 'Kofar Kaura', 12.98, 7.61, 'Aliyu Musa', '+2348099998888', 'local', 4.5, 16, ?, ?, 'pending', '1234', 0, 'pending_dispatch', ?, ?)
  `).run(deliveryId, trackingCode, customerId, fee, method, now, now);

  db.prepare(
    'INSERT INTO parcels (id, delivery_id, category, description, weight_kg) VALUES (?, ?, ?, ?, ?)'
  ).run(`parc-${crypto.randomUUID().slice(0, 8)}`, deliveryId, 'Documents', 'Sealed Contract', 1.2);

  db.prepare(
    "INSERT INTO payments (id, delivery_id, amount_ngn, rider_payout_ngn, platform_fee_ngn, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
  ).run(`pay-${crypto.randomUUID().slice(0, 8)}`, deliveryId, fee, fee * 0.8, fee * 0.2, now);

  return { deliveryId, trackingCode, customerProfileId };
}

test('Secret encryption, decryption, and masking never expose plaintext secrets', () => {
  const raw = 'FLWSECK_TEST-1234567890abcdef9999';
  const encrypted = pay.encryptSecret(raw);
  assert.ok(encrypted.startsWith('enc:v1:'));
  assert.notEqual(encrypted, raw);
  assert.equal(pay.decryptSecret(encrypted), raw);

  const masked = pay.maskSecret(raw);
  assert.ok(masked.startsWith('FLWSECK_TEST-'));
  assert.ok(masked.endsWith('9999'));
  assert.ok(!masked.includes('1234567890'));
});

test('Wallet credit, debit, insufficient balance protection, idempotency & immutable ledger', () => {
  const client = createTestUser('client');
  const w0 = pay.ensureWallet(client.profileId);
  assert.equal(w0.balanceNgn, 0);

  // Atomic credit
  const c1 = pay.creditWalletAtomic({
    userId: client.profileId,
    amountNgn: 5000,
    reference: 'SAQO-WLT-TEST-001',
    idempotencyKey: 'idem-credit-001',
    description: 'Initial deposit',
  });
  assert.equal(c1.alreadyProcessed, false);
  assert.equal(c1.wallet.balanceNgn, 5000);
  assert.equal(c1.transaction.balanceBeforeNgn, 0);
  assert.equal(c1.transaction.balanceAfterNgn, 5000);

  // Duplicate credit with same idempotency key does NOT credit twice
  const cDup = pay.creditWalletAtomic({
    userId: client.profileId,
    amountNgn: 5000,
    reference: 'SAQO-WLT-TEST-001',
    idempotencyKey: 'idem-credit-001',
  });
  assert.equal(cDup.alreadyProcessed, true);
  assert.equal(cDup.wallet.balanceNgn, 5000);

  // Insufficient balance error rejects cleanly without mutating balance
  assert.throws(
    () =>
      pay.debitWalletAtomic({
        userId: client.profileId,
        amountNgn: 8500,
        reference: 'SAQO-PAY-FAIL-001',
      }),
    pay.InsufficientWalletBalanceError
  );
  assert.equal(pay.ensureWallet(client.profileId).balanceNgn, 5000);

  // Debit sufficient amount + idempotent retry
  const d1 = pay.debitWalletAtomic({
    userId: client.profileId,
    amountNgn: 1800,
    reference: 'SAQO-PAY-TEST-001',
    idempotencyKey: 'idem-debit-001',
  });
  assert.equal(d1.wallet.balanceNgn, 3200);
  const dDup = pay.debitWalletAtomic({
    userId: client.profileId,
    amountNgn: 1800,
    reference: 'SAQO-PAY-TEST-001',
    idempotencyKey: 'idem-debit-001',
  });
  assert.equal(dDup.alreadyProcessed, true);
  assert.equal(pay.ensureWallet(client.profileId).balanceNgn, 3200);

  // Ledger immutability enforced by SQLite triggers
  assert.throws(() => {
    db.prepare('UPDATE wallet_transactions SET amount_ngn = 999999 WHERE id = ?').run(c1.transaction.id);
  });
  assert.throws(() => {
    db.prepare('DELETE FROM wallet_transactions WHERE id = ?').run(c1.transaction.id);
  });
});

test('Admin wallet adjustment requires mandatory reason and writes audit log', () => {
  const admin = createTestUser('admin');
  const client = createTestUser('client');
  const wallet = pay.ensureWallet(client.profileId);

  assert.throws(() =>
    pay.adjustWalletAtomic({
      walletId: wallet.id,
      direction: 'credit',
      amountNgn: 1000,
      reason: 'ok',
      actorId: admin.profileId,
      actorName: 'Admin',
    })
  );

  const res = pay.adjustWalletAtomic({
    walletId: wallet.id,
    direction: 'credit',
    amountNgn: 2500,
    reason: 'Goodwill credit for delayed dispatch',
    actorId: admin.profileId,
    actorName: 'Operations Lead',
  });
  assert.equal(res.wallet.balanceNgn, 2500);

  const logs = pay.getWalletAuditLogs(20);
  assert.ok(logs.some((l) => l.userId === client.profileId && l.amountNgn === 2500 && l.direction === 'credit'));
});

test('Flutterwave settlement handles success, tampered amount, pending, failed, reversed, and duplicate protection', () => {
  const client = createTestUser('client');
  const now = new Date().toISOString();
  const wallet = pay.ensureWallet(client.profileId);
  const ref = pay.generateReference('WLT');
  const txId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO payment_transactions (
      id, reference, user_id, wallet_id, purpose, payment_method, provider, amount_ngn, currency, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'wallet_funding', 'flutterwave', 'flutterwave', 4000, 'NGN', 'pending', ?, ?)
  `).run(txId, ref, client.profileId, wallet.id, now, now);

  const tx = pay.getCustomerWalletSummary(client.profileId).paymentTransactions[0];

  // Tampered underpayment must fail
  assert.throws(
    () =>
      pay.settleVerifiedPaymentTransaction({
        tx,
        flw: {
          flwTxId: '990011',
          txRef: ref,
          amount: 100,
          currency: 'NGN',
          status: 'successful',
          paymentType: 'card',
          processorResponse: 'Approved',
          raw: {},
        },
        verifiedBy: 'test',
      }),
    pay.PaymentVerificationError
  );

  // Pending remains pending
  const pRes = pay.settleVerifiedPaymentTransaction({
    tx,
    flw: {
      flwTxId: '990011',
      txRef: ref,
      amount: 4000,
      currency: 'NGN',
      status: 'pending',
      paymentType: 'banktransfer',
      processorResponse: 'Pending bank clearance',
      raw: {},
    },
    verifiedBy: 'test',
  });
  assert.equal(pRes.paymentTransaction.status, 'pending');
  assert.equal(pay.ensureWallet(client.profileId).balanceNgn, 0);

  // Successful verifies and credits wallet exactly once
  const ok1 = pay.settleVerifiedPaymentTransaction({
    tx: pRes.paymentTransaction,
    flw: {
      flwTxId: '990011',
      txRef: ref,
      amount: 4000,
      currency: 'NGN',
      status: 'successful',
      paymentType: 'card',
      processorResponse: 'Approved',
      raw: {},
    },
    verifiedBy: 'webhook',
  });
  assert.equal(ok1.alreadyProcessed, false);
  assert.equal(ok1.paymentTransaction.status, 'paid');
  assert.equal(ok1.wallet?.balanceNgn, 4000);

  // Duplicate settlement does NOT double-credit wallet
  const ok2 = pay.settleVerifiedPaymentTransaction({
    tx: ok1.paymentTransaction,
    flw: {
      flwTxId: '990011',
      txRef: ref,
      amount: 4000,
      currency: 'NGN',
      status: 'successful',
      paymentType: 'card',
      processorResponse: 'Approved',
      raw: {},
    },
    verifiedBy: 'callback',
  });
  assert.equal(ok2.alreadyProcessed, true);
  assert.equal(pay.ensureWallet(client.profileId).balanceNgn, 4000);

  // Reversed status on another tx marks tx reversed
  const revRef = pay.generateReference('WLT');
  const revId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO payment_transactions (
      id, reference, user_id, wallet_id, purpose, payment_method, provider, amount_ngn, currency, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'wallet_funding', 'flutterwave', 'flutterwave', 2000, 'NGN', 'pending', ?, ?)
  `).run(revId, revRef, client.profileId, wallet.id, now, now);
  const revTx = pay
    .getCustomerWalletSummary(client.profileId)
    .paymentTransactions.find((t) => t.id === revId)!;

  const revRes = pay.settleVerifiedPaymentTransaction({
    tx: revTx,
    flw: {
      flwTxId: '990022',
      txRef: revRef,
      amount: 2000,
      currency: 'NGN',
      status: 'reversed',
      paymentType: 'card',
      processorResponse: 'Reversed',
      raw: {},
    },
    verifiedBy: 'webhook',
  });
  assert.equal(revRes.paymentTransaction.status, 'reversed');
  assert.equal(pay.ensureWallet(client.profileId).balanceNgn, 4000);
});

test('Gateway settings preserve secrets on blank update, mask secrets in admin view, and validate webhook signatures', async () => {
  const admin = createTestUser('admin');
  const view1 = pay.updateGatewaySettings(
    {
      publicKey: 'FLWPUBK_TEST-abc123',
      secretKey: 'FLWSECK_TEST-secretvalue9876',
      webhookSecretHash: 'saqo-webhook-hash-2026',
      mode: 'test',
      isEnabled: true,
    },
    admin.profileId,
    'https://saqo.ng'
  );
  assert.equal(view1.hasSecretKey, true);
  assert.ok(view1.secretKeyMasked.endsWith('9876'));
  assert.ok(!JSON.stringify(view1).includes('secretvalue9876'));
  assert.ok(!JSON.stringify(view1).includes('saqo-webhook-hash-2026'));

  // Updating other field with blank secret retains previously saved secret
  const view2 = pay.updateGatewaySettings(
    { mode: 'live', secretKey: '', webhookUrl: 'https://saqo.ng/api/webhooks/flutterwave' },
    admin.profileId
  );
  assert.equal(view2.mode, 'live');
  assert.equal(view2.hasSecretKey, true);
  assert.equal(pay.getDecryptedGatewaySecrets().secretKey, 'FLWSECK_TEST-secretvalue9876');

  // Public config never reveals secrets
  const pubCfg = pay.getGatewayPublicConfig();
  assert.equal(pubCfg.publicKey, 'FLWPUBK_TEST-abc123');
  assert.ok(!JSON.stringify(pubCfg).includes('secretvalue9876'));

  // Invalid webhook signature fails 401 cleanly
  const badWh = await pay.processFlutterwaveWebhook({
    headers: { 'verif-hash': 'wrong-hash' },
    rawBody: '{}',
    payload: { event: 'charge.completed', data: { id: 1, tx_ref: 'X' } },
  });
  assert.equal(badWh.accepted, false);

  // Valid signature succeeds & duplicate is ignored
  assert.equal(
    pay.verifyFlutterwaveWebhookSignature({ 'verif-hash': 'saqo-webhook-hash-2026' }, '{}'),
    true
  );
  const okWh1 = await pay.processFlutterwaveWebhook({
    headers: { 'verif-hash': 'saqo-webhook-hash-2026' },
    rawBody: '{}',
    payload: { event: 'ping.test', data: { id: 'evt1', tx_ref: 'REF1', status: 'ok' } },
  });
  assert.equal(okWh1.accepted, true);
  assert.equal(okWh1.status, 'processed');

  const okWhDup = await pay.processFlutterwaveWebhook({
    headers: { 'verif-hash': 'saqo-webhook-hash-2026' },
    rawBody: '{}',
    payload: { event: 'ping.test', data: { id: 'evt1', tx_ref: 'REF1', status: 'ok' } },
  });
  assert.equal(okWhDup.duplicate, true);
  assert.equal(okWhDup.status, 'ignored');
});

test('Cash collection, bank transfer reconciliation, and delivery wallet refund work end-to-end', async () => {
  const admin = createTestUser('admin');
  const client = createTestUser('client');
  const rider = createTestUser('rider');

  // Cash collection + rider confirmation + admin reconciliation
  const cashDel = createTestDelivery(client.roleId, client.profileId, 2000, 'cash');
  db.prepare('UPDATE delivery_requests SET assigned_rider_id = ? WHERE id = ?').run(
    rider.roleId,
    cashDel.deliveryId
  );
  pay.createDeliveryPaymentRecords({
    deliveryId: cashDel.deliveryId,
    trackingCode: cashDel.trackingCode,
    customerProfileId: client.profileId,
    customerName: 'Cash Sender',
    customerEmail: client.email,
    customerPhone: '+2348011112222',
    amountNgn: 2000,
    paymentMethod: 'cash',
  });

  const collected = pay.confirmRiderCashCollection({
    deliveryId: cashDel.deliveryId,
    riderId: rider.roleId,
    collectedAmountNgn: 2000,
  });
  assert.equal(collected.paymentStatus, 'collected_by_rider');

  const overview = pay.getAdminPaymentsOverview();
  const ccRow = overview.cashCollections.find((c) => c.deliveryId === cashDel.deliveryId)!;
  assert.equal(ccRow.status, 'collected_by_rider');

  const reconciled = pay.reconcileCashOrBankCollection({
    collectionId: ccRow.id,
    action: 'reconcile',
    adminId: admin.profileId,
  });
  assert.equal(reconciled.status, 'reconciled');

  // Bank transfer proof submission & dispute flow
  const bankDel = createTestDelivery(client.roleId, client.profileId, 2500, 'bank_transfer');
  const bankSubmitted = pay.submitBankTransferProof({
    deliveryId: bankDel.deliveryId,
    userId: client.profileId,
    transferReference: 'NIP-123456789',
    transferProofNote: 'Access Bank transfer',
  });
  assert.equal(bankSubmitted.paymentStatus, 'pending_verification');
  const bankCc = pay
    .getAdminPaymentsOverview()
    .cashCollections.find((c) => c.deliveryId === bankDel.deliveryId)!;
  const disputed = pay.reconcileCashOrBankCollection({
    collectionId: bankCc.id,
    action: 'dispute',
    adminId: admin.profileId,
    notes: 'Session ID not received yet',
  });
  assert.equal(disputed.status, 'disputed');

  const csv = pay.exportPaymentsCsv({ method: 'cash' });
  assert.ok(csv.includes('Reference,Date,Customer'));

  // Wallet delivery payment + refund back to wallet
  pay.creditWalletAtomic({
    userId: client.profileId,
    amountNgn: 5000,
    reference: 'SAQO-PRE-REFUND-TEST',
  });
  const wDel = createTestDelivery(client.roleId, client.profileId, 1500, 'wallet');
  const wPay = pay.payDeliveryWithWallet({
    deliveryId: wDel.deliveryId,
    userId: client.profileId,
    customerName: 'Wallet Sender',
    customerEmail: client.email,
    customerPhone: '+2348011112222',
  });
  assert.equal(wPay.delivery.paymentStatus, 'paid');
  assert.equal(wPay.wallet.balanceNgn, 3500);

  const refund = await pay.processAdminRefund({
    paymentTransactionId: wPay.paymentTransaction.id,
    amountNgn: 1500,
    destination: 'wallet',
    reason: 'Sender cancelled before dispatch',
    adminId: admin.profileId,
  });
  assert.equal(refund.status, 'completed');
  assert.equal(pay.ensureWallet(client.profileId).balanceNgn, 5000);

  // Double refund blocked cleanly
  await assert.rejects(() =>
    pay.processAdminRefund({
      paymentTransactionId: wPay.paymentTransaction.id,
      amountNgn: 1500,
      destination: 'wallet',
      reason: 'Duplicate attempt',
      adminId: admin.profileId,
    })
  );
});

test('Gateway settings preserve encryptionKey and webhookSecretHash on blank update', () => {
  const admin = createTestUser('admin');
  const saved = pay.updateGatewaySettings(
    {
      publicKey: 'FLWPUBK_TEST-preserve',
      secretKey: 'FLWSECK_TEST-secret1234',
      encryptionKey: 'FLWSECK_TEST-enc5678',
      webhookSecretHash: 'my-secret-webhook-hash-99',
      mode: 'test',
      isEnabled: true,
    },
    admin.profileId,
    'https://saqo.ng'
  );
  assert.equal(saved.hasEncryptionKey, true);
  assert.equal(saved.hasWebhookSecretHash, true);

  const afterBlankUpdate = pay.updateGatewaySettings(
    {
      publicKey: 'FLWPUBK_TEST-preserve-2',
      secretKey: '',
      encryptionKey: '',
      webhookSecretHash: '',
      mode: 'test',
      isEnabled: true,
    },
    admin.profileId,
    'https://saqo.ng'
  );
  assert.equal(afterBlankUpdate.hasSecretKey, true);
  assert.equal(afterBlankUpdate.hasEncryptionKey, true);
  assert.equal(afterBlankUpdate.hasWebhookSecretHash, true);
});

test('Partial refunds support multiple installments up to paid total and mark refunded when complete', async () => {
  const admin = createTestUser('admin');
  const client = createTestUser('client');
  pay.creditWalletAtomic({
    userId: client.profileId,
    amountNgn: 10000,
    reference: `SAQO-PRE-PART-${crypto.randomUUID().slice(0, 6)}`,
  });
  const del = createTestDelivery(client.roleId, client.profileId, 2000, 'wallet');
  const paidRes = pay.payDeliveryWithWallet({
    deliveryId: del.deliveryId,
    userId: client.profileId,
    customerName: 'Partial Sender',
    customerEmail: client.email,
    customerPhone: '+2348011112222',
  });

  // First partial refund of ₦800
  const r1 = await pay.processAdminRefund({
    paymentTransactionId: paidRes.paymentTransaction.id,
    amountNgn: 800,
    destination: 'wallet',
    reason: 'Partial fee adjustment 1',
    adminId: admin.profileId,
  });
  assert.equal(r1.amountNgn, 800);
  const txAfterR1 = db
    .prepare('SELECT status FROM payment_transactions WHERE id = ?')
    .get(paidRes.paymentTransaction.id) as { status: string };
  assert.equal(txAfterR1.status, 'paid');

  // Over-refund above remaining ₦1200 must fail
  await assert.rejects(() =>
    pay.processAdminRefund({
      paymentTransactionId: paidRes.paymentTransaction.id,
      amountNgn: 1300,
      destination: 'wallet',
      reason: 'Too much',
      adminId: admin.profileId,
    })
  );

  // Second partial refund of remaining ₦1200 completes full refund
  await pay.processAdminRefund({
    paymentTransactionId: paidRes.paymentTransaction.id,
    amountNgn: 1200,
    destination: 'wallet',
    reason: 'Partial fee adjustment 2',
    adminId: admin.profileId,
  });
  const txAfterR2 = db
    .prepare('SELECT status FROM payment_transactions WHERE id = ?')
    .get(paidRes.paymentTransaction.id) as { status: string };
  assert.equal(txAfterR2.status, 'refunded');
});

test('Cancelled deliveries reject payments and cancelDeliveryPayments cleans unpaid collections', async () => {
  const client = createTestUser('client');
  pay.creditWalletAtomic({
    userId: client.profileId,
    amountNgn: 5000,
    reference: `SAQO-CANCEL-${crypto.randomUUID().slice(0, 6)}`,
  });
  const del = createTestDelivery(client.roleId, client.profileId, 1800, 'cash');
  pay.createDeliveryPaymentRecords({
    deliveryId: del.deliveryId,
    trackingCode: del.trackingCode,
    customerProfileId: client.profileId,
    customerName: 'Cancel Sender',
    customerEmail: client.email,
    customerPhone: '+2348011112222',
    amountNgn: 1800,
    paymentMethod: 'cash',
  });

  db.prepare("UPDATE delivery_requests SET status = 'cancelled' WHERE id = ?").run(del.deliveryId);
  pay.cancelDeliveryPayments(del.deliveryId);

  const staleCc = db.prepare('SELECT id FROM cash_collections WHERE delivery_id = ?').get(del.deliveryId);
  assert.equal(staleCc, undefined);
  const canceledTx = db
    .prepare('SELECT status FROM payment_transactions WHERE delivery_id = ?')
    .get(del.deliveryId) as { status: string };
  assert.equal(canceledTx.status, 'failed');

  assert.throws(() =>
    pay.payDeliveryWithWallet({
      deliveryId: del.deliveryId,
      userId: client.profileId,
      customerName: 'Cancel Sender',
      customerEmail: client.email,
      customerPhone: '+2348011112222',
    })
  );
  assert.throws(() =>
    pay.submitBankTransferProof({
      deliveryId: del.deliveryId,
      userId: client.profileId,
      transferReference: 'NIP-000',
    })
  );
  await assert.rejects(() =>
    pay.initializeDeliveryFlutterwavePayment({
      deliveryId: del.deliveryId,
      userId: client.profileId,
      customerName: 'Cancel Sender',
      customerEmail: client.email,
      customerPhone: '+2348011112222',
      redirectUrl: 'https://saqo.ng/?flw_callback=1',
    })
  );
});

test('payDeliveryWithWallet removes stale cash_collections and syncs existing payment transaction', () => {
  const client = createTestUser('client');
  pay.creditWalletAtomic({
    userId: client.profileId,
    amountNgn: 4000,
    reference: `SAQO-SWITCH-${crypto.randomUUID().slice(0, 6)}`,
  });
  const del = createTestDelivery(client.roleId, client.profileId, 1600, 'cash');
  pay.createDeliveryPaymentRecords({
    deliveryId: del.deliveryId,
    trackingCode: del.trackingCode,
    customerProfileId: client.profileId,
    customerName: 'Switch Sender',
    customerEmail: client.email,
    customerPhone: '+2348011112222',
    amountNgn: 1600,
    paymentMethod: 'cash',
  });
  assert.ok(db.prepare('SELECT id FROM cash_collections WHERE delivery_id = ?').get(del.deliveryId));

  const res = pay.payDeliveryWithWallet({
    deliveryId: del.deliveryId,
    userId: client.profileId,
    customerName: 'Switch Sender',
    customerEmail: client.email,
    customerPhone: '+2348011112222',
  });
  assert.equal(res.delivery.paymentStatus, 'paid');
  assert.equal(res.delivery.paymentMethod, 'wallet');
  assert.equal(db.prepare('SELECT id FROM cash_collections WHERE delivery_id = ?').get(del.deliveryId), undefined);
});

test('Webhook charge.reversed debits wallet funding when sufficient and freezes wallet when spent', async () => {
  const admin = createTestUser('admin');
  pay.updateGatewaySettings(
    {
      webhookSecretHash: 'rev-webhook-secret',
      mode: 'test',
      isEnabled: true,
    },
    admin.profileId,
    'https://saqo.ng'
  );

  // Case 1: Customer still has funds -> debited cleanly
  const c1 = createTestUser('client');
  const w1 = pay.ensureWallet(c1.profileId);
  const now = new Date().toISOString();
  const ref1 = pay.generateReference('WLT');
  db.prepare(`
    INSERT INTO payment_transactions (
      id, reference, user_id, wallet_id, purpose, payment_method, provider, amount_ngn, currency, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'wallet_funding', 'flutterwave', 'flutterwave', 3000, 'NGN', 'pending', ?, ?)
  `).run(crypto.randomUUID(), ref1, c1.profileId, w1.id, now, now);
  const tx1 = pay.getCustomerWalletSummary(c1.profileId).paymentTransactions[0];
  pay.settleVerifiedPaymentTransaction({
    tx: tx1,
    flw: {
      flwTxId: '777101',
      txRef: ref1,
      amount: 3000,
      currency: 'NGN',
      status: 'successful',
      paymentType: 'card',
      processorResponse: 'Approved',
      raw: {},
    },
    verifiedBy: 'webhook',
  });
  assert.equal(pay.ensureWallet(c1.profileId).balanceNgn, 3000);

  await pay.processFlutterwaveWebhook({
    headers: { 'verif-hash': 'rev-webhook-secret' },
    rawBody: '{}',
    payload: { event: 'charge.reversed', data: { id: '777101', tx_ref: ref1 } },
  });
  assert.equal(pay.ensureWallet(c1.profileId).balanceNgn, 0);
  assert.equal(pay.ensureWallet(c1.profileId).status, 'active');

  // Case 2: Customer already spent funds -> wallet frozen instead of negative balance
  const c2 = createTestUser('client');
  const w2 = pay.ensureWallet(c2.profileId);
  const ref2 = pay.generateReference('WLT');
  db.prepare(`
    INSERT INTO payment_transactions (
      id, reference, user_id, wallet_id, purpose, payment_method, provider, amount_ngn, currency, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'wallet_funding', 'flutterwave', 'flutterwave', 3000, 'NGN', 'pending', ?, ?)
  `).run(crypto.randomUUID(), ref2, c2.profileId, w2.id, now, now);
  const tx2 = pay.getCustomerWalletSummary(c2.profileId).paymentTransactions[0];
  pay.settleVerifiedPaymentTransaction({
    tx: tx2,
    flw: {
      flwTxId: '777102',
      txRef: ref2,
      amount: 3000,
      currency: 'NGN',
      status: 'successful',
      paymentType: 'card',
      processorResponse: 'Approved',
      raw: {},
    },
    verifiedBy: 'webhook',
  });
  pay.debitWalletAtomic({
    userId: c2.profileId,
    amountNgn: 1500,
    reference: 'SAQO-SPENT-1',
  });
  await pay.processFlutterwaveWebhook({
    headers: { 'verif-hash': 'rev-webhook-secret' },
    rawBody: '{}',
    payload: { event: 'charge.reversed', data: { id: '777102', tx_ref: ref2 } },
  });
  assert.equal(pay.ensureWallet(c2.profileId).status, 'frozen');
});

test('Admin wallet overview ignores non-client wallets and CSV export prevents formula injection', () => {
  const admin = createTestUser('admin');
  const rider = createTestUser('rider');
  const client = createTestUser('client');
  pay.ensureWallet(admin.profileId);
  pay.ensureWallet(rider.profileId);
  pay.creditWalletAtomic({
    userId: client.profileId,
    amountNgn: 2200,
    reference: `SAQO-CLI-ONLY-${crypto.randomUUID().slice(0, 6)}`,
  });

  const overview = pay.getAdminPaymentsOverview();
  assert.ok(!overview.wallets.some((w) => w.userId === admin.profileId || w.userId === rider.profileId));

  const del = createTestDelivery(client.roleId, client.profileId, 900, 'bank_transfer');
  pay.submitBankTransferProof({
    deliveryId: del.deliveryId,
    userId: client.profileId,
    transferReference: '=CMD("calc")',
    transferProofNote: 'Formula probe',
  });
  const csv = pay.exportPaymentsCsv({ method: 'bank_transfer' });
  assert.ok(csv.includes("'=CMD"));
});

test.after(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      if (fs.existsSync(`${tempDbPath}${suffix}`)) {
        fs.unlinkSync(`${tempDbPath}${suffix}`);
      }
    } catch {
      // ignore cleanup error on Windows handle
    }
  }
});
