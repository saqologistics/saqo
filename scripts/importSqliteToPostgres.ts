import 'dotenv/config';
import { backup, DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const dataTables = [
  'profiles', 'customers', 'riders', 'rider_locations', 'delivery_requests', 'parcels',
  'delivery_assignments', 'delivery_status_history', 'delivery_otp_attempts', 'login_attempts',
  'payments', 'notifications', 'complaints', 'support_conversations', 'support_messages',
  'whatsapp_sessions', 'whatsapp_inbound_messages', 'wallets', 'payment_transactions',
  'wallet_transactions', 'payment_webhook_events', 'refunds', 'cash_collections', 'wallet_audit_logs',
];
const settings = new Map([
  ['platform_settings', 'id'], ['payment_methods', 'code'], ['payment_gateway_settings', 'id'],
]);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

async function main() {
  const args = process.argv.slice(2);
  const source = args.find((arg) => !arg.startsWith('--'));
  const commit = args.includes('--commit');
  if (!source || args.some((arg) => arg.startsWith('--') && arg !== '--commit')) {
    throw new Error('Usage: node --import tsx scripts/importSqliteToPostgres.ts /path/to/saqo.db [--commit]');
  }
  const connectionString = process.env.SAQO_DATABASE_URL;
  const schema = process.env.SAQO_PG_SCHEMA || 'saqo';
  if (!connectionString) throw new Error('Set SAQO_DATABASE_URL to the destination database.');
  if (!/^[a-z][a-z0-9_]{0,51}$/.test(schema)) throw new Error('Invalid SAQO_PG_SCHEMA.');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'saqo-migrate-'));
  const snapshot = path.join(dir, 'copy.sqlite');
  const target = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
  let connectionOpened = false;
  let closeSnapshot: (() => Promise<void>) | undefined;
  try {
    const original = new DatabaseSync(path.resolve(source), { readOnly: true });
    try { await backup(original, snapshot); }
    finally { original.close(); }

    // Run legacy SQLite upgrades on the copy so every source uses the latest column layout.
    delete process.env.SAQO_DATABASE_URL;
    process.env.SAQO_DB_PATH = snapshot;
    process.env.NODE_ENV = 'test';
    const { hashPassword, initDatabase, verifyPassword } = await import('../src/server/db');
    const { db, sqlite } = await import('../src/server/database');
    closeSnapshot = () => db.close();
    await initDatabase();
    const admins = sqlite!.prepare("SELECT id, password_hash FROM profiles WHERE role = 'admin' AND account_status = 'active'").all() as { id: string; password_hash: string }[];
    const defaults = admins.filter((admin) => verifyPassword('saqo1234', admin.password_hash));
    if (defaults.length) {
      const password = process.env.SAQO_ADMIN_PASSWORD;
      if (!password || password.length < 16 || password === 'saqo1234') {
        throw new Error('Set a new SAQO_ADMIN_PASSWORD of at least 16 characters before importing the default admin.');
      }
      for (const admin of defaults) sqlite!.prepare('UPDATE profiles SET password_hash = ? WHERE id = ?').run(hashPassword(password), admin.id);
    }
    if (sqlite!.prepare('PRAGMA foreign_key_check').all().length) throw new Error('The SQLite snapshot has broken references.');

    await target.connect();
    connectionOpened = true;
    await target.query('BEGIN');
    await target.query('SET LOCAL lock_timeout = \'5s\'');
    const qualified = (table: string) => `${quote(schema)}.${quote(table)}`;
    const tables = [...dataTables, ...settings.keys()];
    await target.query(`LOCK TABLE ${tables.map(qualified).join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
    for (const table of dataTables) {
      const occupied = await target.query(`SELECT EXISTS(SELECT 1 FROM ${qualified(table)}) AS occupied`);
      if (occupied.rows[0].occupied) throw new Error(`Target ${table} already contains data. Import stopped.`);
    }
    let imported = 0;
    for (const table of tables) {
      const rows = sqlite!.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all();
      const key = settings.get(table);
      for (const row of rows) {
        const columns = Object.keys(row);
        const names = columns.map(quote);
        const placeholders = columns.map((_column, index) => `$${index + 1}`);
        const update = key
          ? ` ON CONFLICT (${quote(key)}) DO UPDATE SET ${columns.filter((name) => name !== key).map((name) => `${quote(name)}=EXCLUDED.${quote(name)}`).join(', ')}`
          : '';
        await target.query(`INSERT INTO ${qualified(table)} (${names.join(', ')}) VALUES (${placeholders.join(', ')})${update}`, columns.map((name) => row[name]));
        imported += 1;
      }
    }
    await target.query(commit ? 'COMMIT' : 'ROLLBACK');
    console.log(`${commit ? 'Imported' : 'Validated without saving'} ${imported} records across ${tables.length} tables.`);
  } catch (error) {
    if (connectionOpened) await target.query('ROLLBACK').catch(() => {});
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)) {
      throw new Error(`Import failed (Postgres ${error.code}). No records were imported.`);
    }
    throw error;
  } finally {
    if (connectionOpened) await target.end();
    await closeSnapshot?.();
    const files = [snapshot, `${snapshot}-wal`, `${snapshot}-shm`];
    for (const file of files) await rm(file, { force: true });
    await import('node:fs/promises').then(({ rmdir }) => rmdir(dir));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
