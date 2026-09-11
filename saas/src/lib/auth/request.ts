/**
 * Turning an HTTP request into a principal.
 *
 * This is the only place in the codebase that decides who someone is. Two
 * credential types are accepted and they resolve differently, but they share
 * one rule: the organization is derived from the credential, and the request
 * body is not consulted.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { withResolver, type OrgRole, type Principal } from '../db/client';
import { authenticateApiKey, bearerToken } from './api-key';

export type AuthFailure =
  | { status: 401; error: 'unauthenticated'; detail: string }
  | { status: 403; error: 'forbidden'; detail: string };

export type AuthResult = { ok: true; principal: Principal } | { ok: false } & AuthFailure;

// ---------------------------------------------------------------------------
// Human sessions: Supabase access tokens
// ---------------------------------------------------------------------------

interface JwtClaims {
  sub?: string;
  exp?: number;
  iat?: number;
  email?: string;
  aud?: string | string[];
}

/**
 * Verify a Supabase HS256 access token.
 *
 * Scope note, stated plainly because it matters operationally: this verifies
 * the symmetric (HS256) tokens issued against a project's JWT secret. Projects
 * using asymmetric signing keys publish a JWKS and need an ES256/RS256 path;
 * that is not implemented here, and `verifySupabaseJwt` returns undefined for
 * any other algorithm rather than skipping verification.
 */
export function verifySupabaseJwt(token: string, secret: string, now = Date.now()): JwtClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (header.alg !== 'HS256') return undefined;

  const expected = createHmac('sha256', secret)
    .update(`${rawHeader}.${rawPayload}`)
    .digest('base64url');
  const a = Buffer.from(rawSignature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;

  let claims: JwtClaims;
  try {
    claims = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return undefined;
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) return undefined;
  return claims;
}

/**
 * Resolve the organization a signed-in user is acting in.
 *
 * The organization may be named in a header or path segment — that is
 * navigation, not authorization. Membership is then proven against the database
 * before any context is opened, and a user who names an organization they do
 * not belong to gets 403, not a session in it.
 */
async function resolveUserOrg(
  userId: string,
  requestedOrg: string | undefined,
): Promise<{ orgId: string; role: OrgRole } | undefined> {
  const rows = await withResolver(async (tx) => {
    await tx.query('select set_config($1, $2, true)', ['app.user_id', userId]);
    return tx.query<{ org_id: string; role: OrgRole }>(
      'select org_id, role from app.my_organizations()',
    );
  });
  if (rows.length === 0) return undefined;
  if (requestedOrg) {
    const match = rows.find((r) => r.org_id === requestedOrg);
    return match ? { orgId: match.org_id, role: match.role } : undefined;
  }
  const first = rows[0]!;
  return { orgId: first.org_id, role: first.role };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function authenticate(req: Request): Promise<AuthResult> {
  const token = bearerToken(req.headers.get('authorization'));
  if (!token) {
    return { ok: false, status: 401, error: 'unauthenticated', detail: 'a bearer credential is required' };
  }

  // Machine principal.
  if (token.startsWith('rsk_')) {
    const key = await authenticateApiKey(token);
    if (!key) {
      // One message for unknown, wrong, revoked and expired alike.
      return { ok: false, status: 401, error: 'unauthenticated', detail: 'the credential is not valid' };
    }
    return {
      ok: true,
      principal: { kind: 'api_key', orgId: key.orgId, apiKeyId: key.apiKeyId, scopes: key.scopes },
    };
  }

  // Human principal.
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    return { ok: false, status: 401, error: 'unauthenticated', detail: 'session verification is not configured' };
  }
  const claims = verifySupabaseJwt(token, secret);
  if (!claims?.sub) {
    return { ok: false, status: 401, error: 'unauthenticated', detail: 'the session token is not valid' };
  }

  const requested = req.headers.get('x-swarm-organization') ?? undefined;
  const org = await resolveUserOrg(claims.sub, requested);
  if (!org) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      detail: requested
        ? 'you are not a member of that organization'
        : 'this account has no organization membership',
    };
  }
  return { ok: true, principal: { kind: 'user', userId: claims.sub, orgId: org.orgId, role: org.role } };
}

export function requireScope(principal: Principal, scope: string): AuthFailure | undefined {
  if (principal.kind !== 'api_key') return undefined;
  if (principal.scopes.includes(scope)) return undefined;
  return { status: 403, error: 'forbidden', detail: `this key lacks the ${scope} scope` };
}

export function requireRole(principal: Principal, roles: OrgRole[]): AuthFailure | undefined {
  if (principal.kind !== 'user') {
    return { status: 403, error: 'forbidden', detail: 'this action requires a signed-in user' };
  }
  if (roles.includes(principal.role)) return undefined;
  return { status: 403, error: 'forbidden', detail: `this action requires one of: ${roles.join(', ')}` };
}
