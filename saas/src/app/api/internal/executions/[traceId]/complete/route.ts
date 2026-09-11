/**
 * POST /api/internal/executions/{traceId}/complete
 *
 * The engine's only way to write back. The order of the checks below is the
 * security design, not an implementation detail:
 *
 *   1. Resolve the execution, and take the organization from the row we stored
 *      when we dispatched it. The payload's opinion about which organization it
 *      belongs to is not consulted, and the schema rejects it for carrying one.
 *   2. Verify the signature, using the key derived from that execution's id.
 *      An unknown trace and a bad signature produce the *same* 401 with the
 *      same body, so resolving first does not turn this endpoint into an oracle
 *      for which traces exist.
 *   3. Record the nonce, then apply. Both inside one transaction under that
 *      organization's context — so a replay cannot interleave with the state
 *      change it is trying to duplicate, and every write is still checked by
 *      row level security.
 *
 * Step 2 needs step 1 because the signing key is per-execution: see
 * callbackTokenFor() for why that is worth the ordering constraint.
 */
import { callbackTokenFor, verifyRequest } from '@/lib/hmac';
import { withOrgContext, withResolver } from '@/lib/db/client';
import { applyCompletion, systemPrincipal, type CallbackTarget } from '@/lib/executions/complete';
import { CallbackPayload } from '@/lib/schemas';
import { fail, internal, invalid, ok } from '@/lib/http';

/** One response for every authentication failure, whatever the cause. */
const REJECT = () => fail(401, 'unauthenticated', 'the callback could not be authenticated');

export async function POST(
  req: Request,
  ctx: { params: Promise<{ traceId: string }> },
): Promise<Response> {
  const { traceId } = await ctx.params;
  const url = new URL(req.url);

  const master = process.env.N8N_CALLBACK_SECRET;
  if (!master) {
    // Fail closed. A deployment with no callback secret accepts nothing.
    console.error('callback rejected: N8N_CALLBACK_SECRET is not configured');
    return REJECT();
  }

  // Raw bytes. The digest must be taken over exactly what was signed; parsing
  // and re-serialising first is how a signature check passes while the handler
  // acts on something else.
  const raw = await req.text();

  try {
    const rows = await withResolver((tx) =>
      tx.query<{
        execution_id: string;
        org_id: string;
        lead_id: string | null;
        status: string;
        completed_at: Date | null;
        dry_run: boolean;
      }>(
        `select execution_id, org_id, lead_id, status, completed_at, dry_run
           from app.resolve_callback_target($1)`,
        [traceId],
      ),
    );
    const row = rows[0];
    if (!row) return REJECT();

    const verified = verifyRequest({
      secret: callbackTokenFor(master, row.execution_id),
      method: 'POST',
      path: url.pathname,
      body: raw,
      headers: req.headers,
    });
    if (!verified.ok) return REJECT();

    // Only now is the caller known to hold this execution's key.
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(raw);
    } catch {
      return invalid('body must be JSON');
    }
    const payload = CallbackPayload.safeParse(parsedBody);
    if (!payload.success) {
      return invalid('the callback payload is not valid', payload.error.issues);
    }

    const target: CallbackTarget = {
      executionId: row.execution_id,
      orgId: row.org_id,
      leadId: row.lead_id,
      status: row.status,
      completedAt: row.completed_at,
      dryRun: row.dry_run,
    };

    // Everything from here runs under the organization resolved from the
    // execution, so every write is still checked by row level security.
    const outcome = await withOrgContext(systemPrincipal(target.orgId, 'engine_callback'), (tx) =>
      applyCompletion(tx, target, payload.data, {
        nonce: verified.nonce,
        signedAt: verified.signedAt,
        bodyDigest: verified.digest,
      }),
    );

    switch (outcome.kind) {
      case 'replayed':
        // 409 rather than 200: the caller should know its retry was not applied.
        return fail(409, 'replayed', 'this callback has already been delivered');
      case 'already_complete':
        return ok({ status: 'already_complete', trace_id: traceId }, 200);
      case 'applied':
        return ok(
          {
            status: 'recorded',
            trace_id: traceId,
            receipt_id: outcome.receiptId,
            approval_id: outcome.approvalId,
          },
          200,
        );
    }
  } catch (err) {
    return internal(err, `POST /api/internal/executions/${traceId}/complete`);
  }
}
