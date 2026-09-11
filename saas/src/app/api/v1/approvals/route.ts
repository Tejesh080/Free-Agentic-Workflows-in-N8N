/**
 * GET /v1/approvals?status=pending
 *
 * The approvals queue. Expiry is reported as computed rather than stored, so a
 * request that has aged out is never presented as actionable just because no
 * sweeper has run.
 */
import { authenticate } from '@/lib/auth/request';
import { withOrgContext } from '@/lib/db/client';
import { fail, internal, invalid, ok } from '@/lib/http';
import { z } from 'zod';

const Query = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected', 'expired']).default('pending'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return fail(auth.status, auth.error, auth.detail);

  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return invalid('invalid query', parsed.error.issues);

  try {
    const rows = await withOrgContext(auth.principal, (tx) =>
      tx.query<Record<string, unknown>>(
        `select a.id, a.action, a.status, a.risk_level, a.policy_reason, a.payload,
                a.requested_at, a.expires_at, a.decided_at, a.decision_note, a.executed_at,
                a.expires_at <= now() as is_expired,
                l.public_id as lead_id, l.email as lead_email, l.company_name,
                l.latest_tier, l.latest_score, a.trace_id
           from approval_requests a
           left join leads l on l.id = a.lead_id
          where a.status = $1::approval_status
          order by a.requested_at desc
          limit $2`,
        [parsed.data.status, parsed.data.limit],
      ),
    );
    return ok({ data: rows });
  } catch (err) {
    return internal(err, 'GET /v1/approvals');
  }
}
