/**
 * GET /v1/dead-letters — what failed, and what happened next.
 *
 * Reads the dead_letter_timeline view, which joins the original execution, the
 * replay if there was one, and the lead, so a single row answers "is this lead
 * stuck, and what did we do about it".
 */
import { authenticate } from '@/lib/auth/request';
import { withOrgContext } from '@/lib/db/client';
import { fail, internal, invalid, ok } from '@/lib/http';
import { z } from 'zod';

const Query = z
  .object({
    status: z.enum(['open', 'replayed', 'recovered', 'abandoned']).optional(),
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
        `select dead_letter_id, original_trace_id, stage::text as stage, error, status::text as status,
                failed_at, lead_id, lead_email, original_execution_status::text as original_execution_status,
                original_attempt, replay_trace_id, replay_execution_status::text as replay_execution_status,
                replayed_at, resolved_at, resolution
           from dead_letter_timeline
          where ($1::dead_letter_status is null or status = $1::dead_letter_status)
          order by failed_at desc
          limit $2`,
        [parsed.data.status ?? null, parsed.data.limit],
      ),
    );
    return ok({ data: rows });
  } catch (err) {
    return internal(err, 'GET /v1/dead-letters');
  }
}
