/**
 * The two test backends, behind one interface.
 *
 *   TEST_DATABASE_URL set  ->  a real Postgres server, reached through the same
 *                              `pg` driver and pool the application uses in
 *                              production, connecting as the real
 *                              `revenue_swarm_app` role with its own password.
 *   otherwise              ->  PGlite (Postgres compiled to WebAssembly)
 *
 * The suites themselves are identical in both. That is the point: the same
 * assertions either hold on a server or they do not, and the PGlite path exists
 * so the suite still runs in CI and on a laptop with no database.
 *
 * What the real backend adds, which PGlite cannot show:
 *   - the production `pg` code path and a genuine connection pool
 *   - a genuine second login role, rather than SET ROLE from a superuser
 *   - transaction-scoped context surviving (or not) across pooled connections
 *   - server-side privilege and role behaviour, including database-level GRANTs
 */
import type { Tx } from '../../src/lib/db/client';

export type Principal =
  | { kind: 'api_key'; orgId: string }
  | { kind: 'user'; userId: string; orgId?: string }
  | { kind: 'anonymous' };

export interface TestDb {
  backend: 'pglite' | 'postgres';
  /** Owner/superuser connection. Fixture setup and out-of-band assertions only. */
  admin<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** As the application role, with the principal expressed only as session context. */
  as<T = Record<string, unknown>>(
    principal: Principal,
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  /**
   * As the application role, with the context values passed through verbatim —
   * including values that are not valid uuids. Used to prove that a malformed
   * context fails closed rather than acting as a wildcard.
   */
  asRawContext<T = Record<string, unknown>>(
    orgId: string,
    userId: string,
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** Run real service-layer code (src/lib/**) inside one application transaction. */
  withAppTx<T>(orgId: string, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function realDatabaseUrl(): string | undefined {
  const url = process.env.TEST_DATABASE_URL;
  return url && !url.startsWith('pglite://') ? url : undefined;
}
