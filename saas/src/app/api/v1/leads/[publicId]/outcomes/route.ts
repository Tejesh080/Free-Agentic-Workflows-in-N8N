/**
 * POST /v1/leads/{publicId}/outcomes — record what actually happened.
 *
 * This is the closed loop's input, and it is deliberately dumb: an outcome is
 * recorded, and nothing about production behaviour changes as a result.
 * Outcomes feed evaluation, evaluation recommends, promotion stays governed.
 */
import { authenticate, requireScope } from '@/lib/auth/request';
import { withOrgContext } from '@/lib/db/client';
import { fail, internal, invalid, notFound, ok } from '@/lib/http';
import { z } from 'zod';

const Body = z
  .object({
    state: z.enum([
      'no_reply', 'replied', 'positive_reply', 'meeting_booked',
      'opportunity_created', 'won', 'lost', 'disqualified',
    ]),
    source: z.enum(['manual', 'crm_sync', 'reply_ingest', 'api']).default('api'),
    value_usd: z.number().nonnegative().max(1_000_000_000).optional(),
    occurred_at: z.string().datetime().optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();

export async function POST(
  req: Request,
  ctx: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return fail(auth.status, auth.error, auth.detail);
  const scopeError = requireScope(auth.principal, 'leads:write');
  if (scopeError) return fail(scopeError.status, scopeError.error, scopeError.detail);

  const { publicId } = await ctx.params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return invalid('body must be JSON');
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return invalid('invalid outcome', parsed.error.issues);

  try {
    const result = await withOrgContext(auth.principal, async (tx) => {
      const lead = await tx.one<{ id: string; latest_execution_id: string | null }>(
        `select id, latest_execution_id from leads where public_id = $1`,
        [publicId],
      );
      if (!lead) return undefined;
      return tx.one<{ id: string }>(
        `insert into lead_outcomes (org_id, lead_id, execution_id, state, source, value_usd, occurred_at, recorded_by, note)
         values ($1,$2,$3,$4::outcome_state,$5,$6,coalesce($7::timestamptz, now()),$8,$9)
         returning id`,
        [
          auth.principal.orgId,
          lead.id,
          lead.latest_execution_id,
          parsed.data.state,
          parsed.data.source,
          parsed.data.value_usd ?? null,
          parsed.data.occurred_at ?? null,
          auth.principal.kind === 'user' ? auth.principal.userId : null,
          parsed.data.note ?? null,
        ],
      );
    });
    if (!result) return notFound();
    return ok({ status: 'recorded', outcome_id: result.id }, 201);
  } catch (err) {
    return internal(err, `POST /v1/leads/${publicId}/outcomes`);
  }
}
