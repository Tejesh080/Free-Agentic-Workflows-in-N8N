/**
 * GET /v1/leads/{publicId}
 *
 * Returns the whole decision trace in one call. A lead in another organization
 * and a lead that never existed both return 404: the API must not be usable to
 * confirm that somebody else's record exists.
 */
import { authenticate, requireScope } from '@/lib/auth/request';
import { withOrgContext } from '@/lib/db/client';
import { loadLeadDetail } from '@/lib/leads/detail';
import { fail, internal, notFound, ok } from '@/lib/http';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return fail(auth.status, auth.error, auth.detail);
  const scopeError = requireScope(auth.principal, 'leads:read');
  if (scopeError) return fail(scopeError.status, scopeError.error, scopeError.detail);

  const { publicId } = await ctx.params;
  try {
    const detail = await withOrgContext(auth.principal, (tx) => loadLeadDetail(tx, publicId));
    if (!detail) return notFound();
    const { lead, ...rest } = detail;
    // The internal primary key stays internal.
    const { id: _internalId, latest_execution_id: _latest, ...publicLead } = lead as Record<string, unknown>;
    return ok({ lead: publicLead, ...rest });
  } catch (err) {
    return internal(err, `GET /v1/leads/${publicId}`);
  }
}
