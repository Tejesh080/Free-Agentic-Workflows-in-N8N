/**
 * Database access.
 *
 * There is exactly one way for application code to reach tenant data:
 * `withOrgContext`. It opens a transaction, drops to the non-owning
 * `revenue_swarm_app` role, installs the principal as transaction-local session
 * state, and runs the caller's queries inside that. Row level security then
 * enforces the boundary a second time, independently of anything this file
 * gets right.
 *
 * Two properties are deliberate:
 *
 *   1. The organization is a function argument, never a request field. There is
 *      no code path here that reads `org_id` out of a body.
 *   2. Context is installed with `set_config(..., is_local => true)`, so it is
 *      scoped to the transaction and cannot survive on a pooled connection into
 *      somebody else's request.
 */
import { Pool, type PoolClient } from 'pg';
import { isLocalDatabase, withLocalOrgContext, withLocalResolver } from './local';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Supabase and most managed Postgres terminate plaintext; refusing to
      // silently fall back is the point.
      ssl: process.env.DATABASE_SSL === 'disable' ? undefined : { rejectUnauthorized: true },
    });
  }
  return pool;
}

/** Who is making this request. Resolved by the auth layer, never by a caller. */
export type Principal =
  | { kind: 'api_key'; orgId: string; apiKeyId: string; scopes: string[] }
  | { kind: 'user'; userId: string; orgId: string; role: OrgRole }
  | { kind: 'system'; orgId: string; reason: string };

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Tx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
}

function wrap(client: PoolClient): Tx {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return res.rows as T[];
    },
    async one<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return res.rows[0] as T | undefined;
    },
  };
}

export async function withOrgContext<T>(
  principal: Principal,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (isLocalDatabase()) {
    return withLocalOrgContext(
      principal.orgId,
      principal.kind === 'user' ? principal.userId : '',
      fn,
    );
  }
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const orgId = principal.orgId;
    const userId = principal.kind === 'user' ? principal.userId : '';
    // Bound parameters, not interpolation: SET LOCAL takes no parameters, which
    // is exactly how tenant context becomes an injection point in most designs.
    await client.query('select set_config($1, $2, true)', ['app.org_id', orgId]);
    await client.query('select set_config($1, $2, true)', ['app.user_id', userId]);
    await client.query('set local role revenue_swarm_app');
    const out = await fn(wrap(client));
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The narrow, privileged path used only where there is not yet a principal to
 * authorize against: API key authentication, and resolving the organization
 * that owns an execution named by a callback. Both go through security-definer
 * functions that constrain what can be asked.
 */
export async function withResolver<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (isLocalDatabase()) return withLocalResolver(fn);
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('set local role revenue_swarm_app');
    const out = await fn(wrap(client));
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
