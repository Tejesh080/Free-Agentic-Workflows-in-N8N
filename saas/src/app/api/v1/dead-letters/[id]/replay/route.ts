/**
 * POST /v1/dead-letters/{id}/replay
 *
 * Creates a replay execution for a failed run. Requires a signed-in human: a
 * replay spends money and may touch a customer's CRM a second time, and the
 * policy on dead_letters refuses a machine principal outright.
 *
 * The original failure is not edited. A new execution row is created pointing
 * back at the one it replaces, and the dead letter points forward to it.
 */
import { authenticate, requireRole } from '@/lib/auth/request';
import { withOrgContext } from '@/lib/db/client';
import { replayDeadLetter } from '@/lib/executions/dead-letter';
import { fail, internal, notFound, ok } from '@/lib/http';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound();

  const auth = await authenticate(req);
  if (!auth.ok) return fail(auth.status, auth.error, auth.detail);
  const roleError = requireRole(auth.principal, ['owner', 'admin', 'member']);
  if (roleError) return fail(roleError.status, roleError.error, roleError.detail);

  try {
    const outcome = await withOrgContext(auth.principal, (tx) =>
      replayDeadLetter(tx, auth.principal, id),
    );
    switch (outcome.kind) {
      case 'not_found':
        return notFound();
      case 'already_replayed':
        return fail(409, 'conflict', `this dead letter is already ${outcome.status}`);
      case 'replayed':
        // Queued, not dispatched. Dispatching it is the next step and is
        // reported honestly rather than implied.
        return ok(
          {
            status: 'replay_queued',
            dead_letter_id: outcome.deadLetterId,
            trace_id: outcome.traceId,
            dispatched: false,
          },
          202,
        );
    }
  } catch (err) {
    return internal(err, `POST /v1/dead-letters/${id}/replay`);
  }
}
