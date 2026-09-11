/**
 * Local development driver.
 *
 * When DATABASE_URL is `pglite://<dir>` the application talks to PGlite — the
 * same real Postgres the test suite uses — instead of a server. That means
 * `npm run dev` needs no Docker, no Supabase project and no connection string,
 * while running exactly the same SQL, the same migrations, the same
 * `revenue_swarm_app` role and the same policies.
 *
 * This is a convenience, not a second implementation: there is no branch here
 * that changes a query or relaxes a policy. Production uses `pg` against
 * Postgres; see client.ts.
 */
import type { Tx } from './client';

type PGliteLike = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
};

let instance: Promise<PGliteLike> | undefined;

/**
 * PGlite is one process and one connection, so two overlapping requests would
 * interleave their BEGIN/COMMIT and corrupt each other's transaction-local
 * context. Server-rendered pages issue several queries per render, so this is
 * not hypothetical. Transactions are therefore serialised through one chain.
 *
 * Production has a real connection pool and needs none of this.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  // Keep the chain alive even when a caller's promise rejects.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function isLocalDatabase(): boolean {
  return (process.env.DATABASE_URL ?? '').startsWith('pglite://');
}

export function localDataDir(): string {
  const url = process.env.DATABASE_URL ?? 'pglite://.pglite';
  return url.slice('pglite://'.length) || '.pglite';
}

export async function getLocal(): Promise<PGliteLike> {
  if (!instance) {
    instance = (async () => {
      // Dynamic import so a production build never needs the dev dependency.
      const mod = (await import('@electric-sql/pglite')) as unknown as {
        PGlite: { create(dir?: string): Promise<PGliteLike> };
      };
      return mod.PGlite.create(localDataDir());
    })();
  }
  return instance;
}

export function withLocalOrgContext<T>(
  orgId: string,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return serialize(() => runLocalOrgContext(orgId, userId, fn));
}

async function runLocalOrgContext<T>(
  orgId: string,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const pg = await getLocal();
  await pg.exec('begin');
  try {
    await pg.query('select set_config($1, $2, true)', ['app.org_id', orgId]);
    await pg.query('select set_config($1, $2, true)', ['app.user_id', userId]);
    await pg.exec('set local role revenue_swarm_app');
    const tx: Tx = {
      async query<R>(sql: string, params: unknown[] = []) {
        return (await pg.query<R>(sql, params)).rows;
      },
      async one<R>(sql: string, params: unknown[] = []) {
        return (await pg.query<R>(sql, params)).rows[0] as R | undefined;
      },
    };
    const out = await fn(tx);
    await pg.exec('commit');
    return out;
  } catch (err) {
    await pg.exec('rollback').catch(() => undefined);
    throw err;
  }
}

export function withLocalResolver<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return serialize(() => runLocalResolver(fn));
}

async function runLocalResolver<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const pg = await getLocal();
  await pg.exec('begin');
  try {
    await pg.exec('set local role revenue_swarm_app');
    const tx: Tx = {
      async query<R>(sql: string, params: unknown[] = []) {
        return (await pg.query<R>(sql, params)).rows;
      },
      async one<R>(sql: string, params: unknown[] = []) {
        return (await pg.query<R>(sql, params)).rows[0] as R | undefined;
      },
    };
    const out = await fn(tx);
    await pg.exec('commit');
    return out;
  } catch (err) {
    await pg.exec('rollback').catch(() => undefined);
    throw err;
  }
}
