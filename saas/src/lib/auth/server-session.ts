/**
 * The principal for a server-rendered page.
 *
 * In production this comes from a verified Supabase access token in a cookie.
 *
 * In local development there is no identity provider, so a demo principal is
 * used instead — and it is gated on the database being the local PGlite one.
 * That gate is the important part: the same build deployed against a real
 * Postgres cannot fall back to a demo user, because `isLocalDatabase()` is
 * false there and this function returns undefined rather than a session.
 */
import { cookies } from 'next/headers';
import { isLocalDatabase } from '../db/local';
import { withResolver, type OrgRole, type Principal } from '../db/client';
import { verifySupabaseJwt } from './request';

export interface Session {
  principal: Principal & { kind: 'user' };
  orgName: string;
  orgSlug: string;
  automationLevel: string;
  email: string;
}

async function organizationsFor(userId: string) {
  return withResolver(async (tx) => {
    await tx.query('select set_config($1, $2, true)', ['app.user_id', userId]);
    return tx.query<{
      org_id: string;
      slug: string;
      name: string;
      role: OrgRole;
      automation_level: string;
    }>('select org_id, slug, name, role, automation_level from app.my_organizations()');
  });
}

export async function getSession(): Promise<Session | undefined> {
  let userId: string | undefined;

  const jar = await cookies();
  const token = jar.get('sb-access-token')?.value;
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (token && secret) {
    userId = verifySupabaseJwt(token, secret)?.sub;
  }

  if (!userId && isLocalDatabase()) {
    // Local only. Never reachable against a hosted database.
    userId = process.env.DEMO_USER_ID;
  }
  if (!userId) return undefined;

  const orgs = await organizationsFor(userId);
  const org = orgs[0];
  if (!org) return undefined;

  const email = await withResolver(async (tx) => {
    await tx.query('select set_config($1, $2, true)', ['app.user_id', userId!]);
    const row = await tx.one<{ email: string }>('select email from users where id = $1', [userId]);
    return row?.email ?? '';
  });

  return {
    principal: { kind: 'user', userId, orgId: org.org_id, role: org.role },
    orgName: org.name,
    orgSlug: org.slug,
    automationLevel: org.automation_level,
    email,
  };
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    throw new Error(
      'no session: sign in, or set DEMO_USER_ID with DATABASE_URL=pglite://.pglite for local development',
    );
  }
  return session;
}
