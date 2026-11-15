import { spawn } from 'node:child_process';
import { randomBytes, createHmac } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { parse } from 'dotenv';
import express from 'express';

// This process has no access to the application's database or external integrations.
process.env.NODE_ENV = 'test';
process.env.SAQO_DB_PATH = ':memory:';
for (const key of Object.keys(process.env)) {
  if (/^(?:VITE_)?(?:SUPABASE|FLUTTERWAVE)_|^SAQO_(?:ALERT_|ADMIN_)/.test(key)) delete process.env[key];
}

const { db, initDatabase } = await import('../src/server/db');
const { registerTwilioWhatsAppWebhook, TWILIO_WHATSAPP_PATH } = await import('../src/server/whatsapp');
initDatabase();
const credentialKeys = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM'] as const;
const envCredentials = Object.fromEntries(credentialKeys.map((key) => [key, process.env[key]]));
let smokeTest = true;
let origin: string | undefined;

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (req.method !== 'POST' || req.originalUrl !== TWILIO_WHATSAPP_PATH) {
    res.sendStatus(404);
    return;
  }
  if (!origin) {
    res.sendStatus(503);
    return;
  }
  if (!smokeTest) {
    let local: Record<string, string> = {};
    try { local = parse(readFileSync('.env')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        res.sendStatus(503);
        return;
      }
    }
    for (const key of credentialKeys) process.env[key] = envCredentials[key] ?? local[key] ?? '';
  }
  next();
});
registerTwilioWhatsAppWebhook(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Sandbox failed to bind to loopback.');
const tunnel = spawn('cloudflared', ['tunnel', '--protocol', 'http2', '--url', `http://127.0.0.1:${address.port}`], {
  stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TWILIO_'))),
});
function stop() {
  tunnel.kill();
  server.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
tunnel.once('error', (error) => {
  console.error('Could not start cloudflared:', error.message);
  server.close();
  process.exitCode = 1;
});
tunnel.once('exit', (code) => {
  server.close();
  if (code) process.exitCode = code;
});

async function verify(url: string) {
  const accountSid = 'AC' + randomBytes(16).toString('hex');
  const authToken = randomBytes(32).toString('hex');
  const sender = 'whatsapp:+2348000000000';
  process.env.TWILIO_ACCOUNT_SID = accountSid;
  process.env.TWILIO_AUTH_TOKEN = authToken;
  process.env.TWILIO_WHATSAPP_FROM = sender;
  const fields = new URLSearchParams({ AccountSid: accountSid, To: sender, From: 'whatsapp:+2348111111111', MessageSid: 'SM' + randomBytes(16).toString('hex'), Body: 'MENU' });
  fields.sort();
  const fingerprint = url + Array.from(fields, ([key, value]) => key + value).join('');
  const signature = createHmac('sha1', authToken).update(fingerprint).digest('base64');
  const { hostname, pathname } = new URL(url);
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  let ip: string | undefined;
  const request = (sig?: string) => new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = httpsRequest({
      hostname: ip, servername: hostname, path: sig ? pathname : '/api/settings/public',
      method: sig ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
      headers: sig ? { Host: hostname, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig } : { Host: hostname },
    }, (res) => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(sig ? fields.toString() : undefined);
  });
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        if (!ip) {
          try { [ip] = await resolver.resolve4(hostname); }
          catch {
            resolver.setServers(['1.1.1.1']);
            [ip] = await resolver.resolve4(hostname);
          }
        }
        if (!ip) throw new Error('Tunnel DNS record is not available.');
        const unsigned = await request('invalid');
        if (unsigned.status === 403) {
          const signed = await request(signature);
          const blocked = await request();
          if (signed.status === 200 && signed.body.includes('Welcome to SAQO Logistics') && blocked.status === 404) {
            console.log('HTTPS verified: signed request returned TwiML, invalid signature was rejected, and app routes were blocked.');
            return;
          }
        }
      } catch { /* The public hostname can take a few seconds to come online. */ }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    console.error('Could not verify the public webhook from this machine.');
  } finally {
    smokeTest = false;
    for (const key of credentialKeys) delete process.env[key];
    db.prepare('DELETE FROM whatsapp_sessions WHERE phone = ?').run('+2348111111111');
    db.prepare('DELETE FROM whatsapp_inbound_messages WHERE message_sid = ?').run(fields.get('MessageSid'));
    console.log('Sandbox now reads Twilio credentials from the shell or git-ignored .env. Stop with Ctrl+C.');
  }
}

createInterface({ input: tunnel.stderr }).on('line', (line) => {
  const match = line.match(/\|\s+(https:\/\/[\w-]+\.trycloudflare\.com)\s+\|/);
  if (!match || origin) {
    if (/\bERR\b|failed|error|Registered tunnel connection/i.test(line)) console.log(line);
    return;
  }
  origin = match[1];
  process.env.APP_URL = origin;
  process.env.TWILIO_WEBHOOK_ORIGIN = origin;
  const url = origin + TWILIO_WHATSAPP_PATH;
  console.log(`Twilio Sandbox webhook (POST): ${url}`);
  void verify(url).catch((error) => console.error('Sandbox check failed:', error.message));
});
