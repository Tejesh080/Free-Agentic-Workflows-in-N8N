/**
 * Runs the real service layer (src/lib/**) against the real policies.
 *
 * `withOrgContext` in production opens a pooled `pg` transaction; here the same
 * sequence runs against PGlite. The point is that ingest, completion and
 * approval logic are exercised as the non-owning application role with only
 * session-scoped context, so a test cannot pass because it happened to run as
 * an owner.
 */
import type { Tx, Principal as AppPrincipal } from '../../src/lib/db/client';
import type { TestDb } from './pg';

export function appPrincipal(
  kind: 'api_key' | 'user' | 'system',
  orgId: string,
  extra: { userId?: string; apiKeyId?: string; scopes?: string[] } = {},
): AppPrincipal {
  if (kind === 'api_key') {
    return {
      kind: 'api_key',
      orgId,
      apiKeyId: extra.apiKeyId ?? '00000000-0000-0000-0000-0000000000aa',
      scopes: extra.scopes ?? ['leads:read', 'leads:write'],
    };
  }
  if (kind === 'user') {
    return { kind: 'user', orgId, userId: extra.userId!, role: 'owner' };
  }
  return { kind: 'system', orgId, reason: 'test' };
}

/** Mirrors withOrgContext(): transaction, app role, transaction-local context. */
export async function withTestOrgContext<T>(
  db: TestDb,
  principal: AppPrincipal,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const pg = db.raw;
  await pg.exec('begin');
  try {
    await pg.query('select set_config($1, $2, true)', ['app.org_id', principal.orgId]);
    await pg.query('select set_config($1, $2, true)', [
      'app.user_id',
      principal.kind === 'user' ? principal.userId : '',
    ]);
    await pg.exec('set local role revenue_swarm_app');
    const tx: Tx = {
      async query<R>(sql: string, params: unknown[] = []) {
        const res = await pg.query<R>(sql, params);
        return res.rows;
      },
      async one<R>(sql: string, params: unknown[] = []) {
        const res = await pg.query<R>(sql, params);
        return res.rows[0] as R | undefined;
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
