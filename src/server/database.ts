import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import pg, { type PoolClient, type QueryResultRow } from 'pg';

pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));

// Supabase Postgres is the default backend whenever SAQO_DATABASE_URL is set. SQLite is only a
// local-development/test fallback and is refused in production so data is never silently lost.
const isProduction = process.env.NODE_ENV === 'production';
const connectionString = process.env.SAQO_DATABASE_URL?.trim() || undefined;
if (isProduction && !connectionString) {
  throw new Error('SAQO_DATABASE_URL (Supabase Postgres connection string) is required in production.');
}
const schema = process.env.SAQO_PG_SCHEMA?.trim() || 'saqo';
if (!/^[a-z][a-z0-9_]{0,51}$/.test(schema)) throw new Error('Invalid SAQO Postgres schema name.');

export const sqlite = connectionString ? null : new DatabaseSync(process.env.SAQO_DB_PATH || path.resolve('saqo.db'));
sqlite?.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

export const pool = connectionString ? new pg.Pool({
  connectionString,
  max: 4,
  connectionTimeoutMillis: 8000,
  idleTimeoutMillis: 10000,
  options: `-c search_path=pg_catalog,${schema} -c timezone=UTC -c statement_timeout=12000`,
  types: {
    getTypeParser(oid, format) {
      if (format !== 'binary') {
        if (oid === 20 || oid === 1700) return (value: string) => Number(value);
        if (oid === 1184 || oid === 1114) return (value: string) => new Date(value).toISOString();
      }
      return pg.types.getTypeParser(oid, format);
    },
  },
}) : null;
pool?.on('error', () => console.error('An idle Postgres connection closed.'));

type Transaction = { client?: PoolClient; effects: Array<() => void>; open: boolean };
const transactionContext = new AsyncLocalStorage<Transaction>();
let sqliteQueue = Promise.resolve();

async function withSqliteLock<T>(work: () => T | Promise<T>): Promise<T> {
  const previous = sqliteQueue;
  let release!: () => void;
  sqliteQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await work(); }
  finally { release(); }
}

export function deferDatabaseEffect(effect: () => void): boolean {
  const transaction = transactionContext.getStore();
  if (!transaction?.open) return false;
  transaction.effects.push(effect);
  return true;
}

export function afterDatabaseCommit(effect: () => void): void {
  if (!deferDatabaseEffect(effect)) effect();
}

export async function databaseTransaction<T>(work: () => T | Promise<T>): Promise<T> {
  if (transactionContext.getStore()?.open) return await work();
  if (pool) {
    const client = await pool.connect();
    const state: Transaction = { client, open: true, effects: [] };
    try {
      await client.query('BEGIN');
      // The SQLite implementation used one writer. Serialize critical sections across API instances.
      await client.query('SELECT pg_advisory_xact_lock(1629784, 53298)');
      const result = await transactionContext.run(state, work);
      await client.query('COMMIT');
      state.open = false;
      for (const effect of state.effects) effect();
      return result;
    } catch (error) {
      if (state.open) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      state.open = false;
      client.release();
    }
  }
  return withSqliteLock(async () => {
    const state: Transaction = { open: true, effects: [] };
    sqlite!.exec('BEGIN IMMEDIATE');
    try {
      const result = await transactionContext.run(state, work);
      sqlite!.exec('COMMIT');
      state.open = false;
      for (const effect of state.effects) effect();
      return result;
    } catch (error) {
      if (state.open) sqlite!.exec('ROLLBACK');
      throw error;
    } finally {
      state.open = false;
    }
  });
}

function postgresStatement(sql: string): string {
  let index = 0;
  // Queries are fixed server SQL. The token scan skips SQL string literals when numbering binds.
  let statement = sql.replace(/'(?:''|[^'])*'|\?/g, (token) => token === '?' ? `$${++index}` : token);
  if (/^\s*INSERT OR IGNORE INTO\b/i.test(statement)) {
    statement = statement.replace(/INSERT OR IGNORE INTO/i, 'INSERT INTO').trimEnd() + ' ON CONFLICT DO NOTHING';
  }
  return statement.replace(/\browid\b/g, 'queue_order');
}

function execute(sql: string, params: SQLInputValue[], kind: 'all' | 'get' | 'run') {
  const state = transactionContext.getStore();
  if (pool) {
    const connection = state?.open ? state.client! : pool;
    return connection.query(postgresStatement(sql), params).then((result) => {
      if (kind === 'run') return { changes: result.rowCount ?? 0 };
      return kind === 'all' ? result.rows : result.rows[0];
    });
  }
  const query = () => {
    const statement = sqlite!.prepare(sql);
    if (kind === 'run') return { changes: Number(statement.run(...params).changes) };
    return kind === 'all' ? statement.all(...params) : statement.get(...params);
  };
  return state?.open ? Promise.resolve(query()) : withSqliteLock(query);
}

export const db = {
  prepare(sql: string) {
    return {
      get: (...params: SQLInputValue[]) => execute(sql, params, 'get') as Promise<QueryResultRow | undefined>,
      all: (...params: SQLInputValue[]) => execute(sql, params, 'all') as Promise<QueryResultRow[]>,
      run: (...params: SQLInputValue[]) => execute(sql, params, 'run') as Promise<{ changes: number }>,
    };
  },
  async close() {
    if (pool) await pool.end();
    else sqlite!.close();
  },
};
