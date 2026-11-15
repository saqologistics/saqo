import { createHash } from 'node:crypto';
import { db } from './db';

const windowMs = 15 * 60 * 1000;
let lastCleanup = 0;

export async function checkLoginThrottle(ip: string, email: string, now = Date.now()) {
  const address = createHash('sha256').update(ip).digest('hex');
  const account = createHash('sha256').update(ip + '\0' + email.trim().toLowerCase()).digest('hex');
  if (now - lastCleanup >= 60_000) {
    await db.prepare('DELETE FROM login_attempts WHERE reset_at <= ?').run(now);
    lastCleanup = now;
  }
  const record = db.prepare(`
    INSERT INTO login_attempts (bucket, attempts, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET
      attempts = CASE WHEN login_attempts.reset_at <= ? THEN 1 ELSE CASE WHEN login_attempts.attempts >= 31 THEN 31 ELSE login_attempts.attempts + 1 END END,
      reset_at = CASE WHEN login_attempts.reset_at <= ? THEN excluded.reset_at ELSE login_attempts.reset_at END
    RETURNING attempts, reset_at
  `);
  const increment = async (key: string) => await record.get(key, now + windowMs, now, now) as {
    attempts: number; reset_at: number;
  };
  const source = await increment('ip:' + address);
  const pair = source.attempts <= 30 ? await increment('account:' + account) : undefined;
  const blockedUntil = source.attempts > 30 ? source.reset_at : pair && pair.attempts > 5 ? pair.reset_at : 0;
  return {
    retryAfter: blockedUntil ? Math.ceil((blockedUntil - now) / 1000) : 0,
    async clearAccount() { await db.prepare('DELETE FROM login_attempts WHERE bucket = ?').run('account:' + account); },
  };
}
