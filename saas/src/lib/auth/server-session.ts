/**
 * The principal for a server-rendered page.
 *
 * In production this comes from a verified Supabase access token in a cookie.
 *
 * In local development there is no identity provider, so a demo principal can
 * be used instead. It requires TWO independent opt-ins, neither of which is
 * implied by anything else:
 *
 *   NODE_ENV !== 'production'   and   ALLOW_DEMO_SESSION === 'true'
 *
 * That combination is the important part. An earlier version keyed this off the
 * database being PGlite, which was safe but wrong in shape: pointing local
 * development at a real Postgres then silently removed the ability to sign in,
 * and — worse — the gate would have been one connection-string change away from
 * meaning nothing. A production build cannot enable this by changing a database
 * URL; it has to set a variable that exists for no other purpose.
 */
import { cookies } from 'next/headers';
import { withResolver, type OrgRole, type Principal } from '../db/client';
import { verifySupabaseJwt } from './request';

/**
 * Both conditions, evaluated together and never cached, so flipping either one
 * takes effect without a rebuild.
 */
export function demoSessionAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEMO_SESSION === 'true';
}

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

  if (!userId && demoSessionAllowed()) {
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
      'no session: sign in, or for local development set ALLOW_DEMO_SESSION=true and DEMO_USER_ID',
    );
  }
  return session;
}
