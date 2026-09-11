/**
 * Organization-scoped API keys.
 *
 * Format:  rsk_<env>_<prefix16hex>_<secret43>
 *
 * The prefix is a non-secret lookup handle. It is stored in the clear and
 * indexed, so presenting a key costs one indexed read rather than a scan over
 * every hash, and a key that turns up in a log or a support ticket can be
 * identified and revoked without anybody learning the secret.
 *
 * The secret is 32 bytes of CSPRNG output, base64url encoded. Only its SHA-256
 * digest reaches the database. There is no code path in this repository that
 * writes a raw key anywhere except the single HTTP response that creates it.
 *
 * The prefix is hex, not base64url, for a specific reason: base64url's alphabet
 * includes the `_` we use as a field delimiter, so a base64url prefix would
 * occasionally contain one and make the token ambiguous to parse. The secret may
 * still contain `_`, which is why parsing takes the first three segments and
 * rejoins the remainder rather than requiring exactly four.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withResolver, type Principal } from '../db/client';

const PREFIX_BYTES = 8; // 16 hex characters; uniqueness is enforced by an index
const SECRET_BYTES = 32; // 43 base64url characters, 256 bits

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export interface GeneratedApiKey {
  /** Shown to the user exactly once. Never persisted. */
  token: string;
  prefix: string;
  secretHash: string;
}

export function generateApiKey(env: 'live' | 'test' = 'live'): GeneratedApiKey {
  const prefix = `rsk_${env}_${randomBytes(PREFIX_BYTES).toString('hex')}`;
  const secret = b64url(randomBytes(SECRET_BYTES));
  return {
    token: `${prefix}_${secret}`,
    prefix,
    secretHash: hashSecret(secret),
  };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Split a presented token into its lookup handle and its secret.
 * Returns undefined for anything that is not shaped like one of our keys, so a
 * malformed credential never reaches the database.
 */
export function parseApiKey(token: string): { prefix: string; secret: string } | undefined {
  const parts = token.split('_');
  // rsk / env / prefix / secret...  — the secret may itself contain `_`.
  if (parts.length < 4) return undefined;
  const [scheme, env, handle] = parts as [string, string, string];
  const secret = parts.slice(3).join('_');
  if (scheme !== 'rsk') return undefined;
  if (env !== 'live' && env !== 'test') return undefined;
  if (!/^[0-9a-f]{16}$/.test(handle)) return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return undefined;
  return { prefix: `${scheme}_${env}_${handle}`, secret };
}

/** Constant-time comparison for equal-length hex digests. */
export function digestsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface AuthenticatedKey {
  apiKeyId: string;
  orgId: string;
  scopes: string[];
}

/**
 * Resolve a presented key to an organization.
 *
 * The database function is given a *hash*, never the secret, so the raw key
 * does not appear in the query text, the parameter log, or pg_stat_statements.
 * It returns no rows for an unknown prefix, a wrong secret, a revoked key and
 * an expired key alike, so the caller cannot distinguish those cases.
 */
export async function authenticateApiKey(token: string): Promise<AuthenticatedKey | undefined> {
  const parsed = parseApiKey(token);
  if (!parsed) return undefined;
  const rows = await withResolver((tx) =>
    tx.query<{ api_key_id: string; org_id: string; scopes: string[] }>(
      'select api_key_id, org_id, scopes from app.authenticate_api_key($1, $2)',
      [parsed.prefix, hashSecret(parsed.secret)],
    ),
  );
  const row = rows[0];
  if (!row) return undefined;
  return { apiKeyId: row.api_key_id, orgId: row.org_id, scopes: row.scopes ?? [] };
}

export function apiKeyPrincipal(key: AuthenticatedKey): Principal {
  return { kind: 'api_key', orgId: key.orgId, apiKeyId: key.apiKeyId, scopes: key.scopes };
}

export function hasScope(principal: Principal, scope: string): boolean {
  if (principal.kind !== 'api_key') return true;
  return principal.scopes.includes(scope);
}

/**
 * Extract a bearer token. Accepts `Authorization: Bearer <token>` only —
 * deliberately not a query parameter, because a credential in a URL ends up in
 * access logs, browser history and referrer headers.
 */
export function bearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}
