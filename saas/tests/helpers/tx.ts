/**
 * Runs the real service layer (src/lib/**) against the real policies.
 *
 * `withOrgContext` in production opens a pooled `pg` transaction, drops to the
 * application role and installs the principal as transaction-local context.
 * `db.withAppTx` does exactly that on whichever backend is in use, so ingest,
 * completion and approval logic are exercised as an unprivileged principal
 * rather than passing because the test happened to run as an owner.
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
export function withTestOrgContext<T>(
  db: TestDb,
  principal: AppPrincipal,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.withAppTx(
    principal.orgId,
    principal.kind === 'user' ? principal.userId : '',
    fn,
  );
}
