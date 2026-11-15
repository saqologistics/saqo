import 'dotenv/config';
import { access, link, mkdir, mkdtemp, readdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { sendOpsAlert } from '../src/server/opsAlerts';

const snapshotPattern = /^saqo-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.sqlite$/;

function verifySnapshot(filename: string): void {
  const database = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
  try {
    const checks = database.prepare('PRAGMA integrity_check').all();
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok') throw new Error('SQLite integrity check failed.');
    if (database.prepare('PRAGMA foreign_key_check').get()) throw new Error('SQLite foreign key check failed.');
    if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'delivery_requests'").get()) {
      throw new Error('This file does not contain a SAQO database.');
    }
  } finally {
    database.close();
  }
}

async function copySnapshot(source: string, destination: string): Promise<void> {
  const output = path.resolve(destination);
  if (path.resolve(source) === output) throw new Error('Source and destination must be different.');
  if (!(await stat(source)).isFile()) throw new Error('Source must be a SQLite file.');
  for (const candidate of [output, output + '-wal', output + '-shm']) {
    const exists = await access(candidate).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    if (exists) throw new Error('Destination already exists or has SQLite sidecar files.');
  }
  await mkdir(path.dirname(output), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(output), '.sqlite-copy-'));
  const temporary = path.join(staging, 'snapshot.sqlite');
  try {
    const database = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
    try {
      await backup(database, temporary);
    } finally {
      database.close();
    }
    verifySnapshot(temporary);
    await link(temporary, output);
  } finally {
    await Promise.all([temporary, temporary + '-wal', temporary + '-shm'].map((file) => rm(file, { force: true })));
    await rmdir(staging);
  }
  console.log('Verified SQLite snapshot: ' + output);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const configured = Number(value);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : fallback;
}

const [command, source, destination] = process.argv.slice(2);
const dbPath = process.env.SAQO_DB_PATH || 'saqo.db';
const backupDir = process.env.SAQO_BACKUP_DIR || 'backups';
const intervalMs = positiveInteger(process.env.SAQO_BACKUP_INTERVAL_SECONDS, 21_600) * 1000;

async function backupsNewestFirst() {
  const entries = await readdir(backupDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && snapshotPattern.test(entry.name))
    .map((entry) => entry.name).sort().reverse();
}

async function run() {
  if ((command === 'backup' || command === 'restore') && source && destination) {
    if (command === 'restore') verifySnapshot(source);
    await copySnapshot(source, destination);
  } else if (command === 'verify' && source) {
    verifySnapshot(source);
    console.log('SQLite snapshot passed integrity and foreign key checks.');
  } else if (command === 'health') {
    const [latest] = await backupsNewestFirst();
    if (!latest || Date.now() - (await stat(path.join(backupDir, latest))).mtimeMs > intervalMs + 10 * 60_000) {
      throw new Error('No recent verified backup.');
    }
    verifySnapshot(path.join(backupDir, latest));
  } else if (command === 'schedule') {
    const retain = positiveInteger(process.env.SAQO_BACKUP_RETAIN, 28);
    for (;;) {
      let next = intervalMs;
      try {
        const name = 'saqo-' + new Date().toISOString().replace(/:/g, '-') + '.sqlite';
        await copySnapshot(dbPath, path.join(backupDir, name));
        for (const old of (await backupsNewestFirst()).slice(retain)) {
          await rm(path.join(backupDir, old));
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'SQLite backup failed.');
        await sendOpsAlert('backup_failure', { reason: 'scheduled_sqlite_backup' });
        next = Math.min(intervalMs, 60_000);
      }
      await sleep(next);
    }
  } else {
    throw new Error('Usage: sqliteBackup.ts backup|restore <source> <destination>, verify <source>, schedule, or health.');
  }
}

run().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : 'SQLite operation failed.');
  if (command === 'backup') await sendOpsAlert('backup_failure', { reason: 'manual_sqlite_backup' });
  process.exitCode = 1;
});
