/**
 * GET /v1/executions/{traceId}
 *
 * The system trace for one run, plus its receipt. Engine-specific fields
 * (engine_execution_id, the n8n URL) are deliberately not returned: the public
 * API does not leak which engine runs the work or how to address it.
 */
import { authenticate, requireScope } from '@/lib/auth/request';
import { withOrgContext } from '@/lib/db/client';
import { fail, internal, notFound, ok } from '@/lib/http';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ traceId: string }> },
): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return fail(auth.status, auth.error, auth.detail);
  const scopeError = requireScope(auth.principal, 'leads:read');
  if (scopeError) return fail(scopeError.status, scopeError.error, scopeError.detail);

  const { traceId } = await ctx.params;
  try {
    const result = await withOrgContext(auth.principal, async (tx) => {
      const execution = await tx.one<Record<string, unknown>>(
        `select e.trace_id, e.status, e.dry_run, e.attempt, e.queued_at, e.dispatched_at,
                e.started_at, e.completed_at, e.latency_ms, e.cost_usd, e.error,
                e.prompt_versions, e.model_metadata, rv.version as rubric_version,
                l.public_id as lead_id
           from executions e
           left join rubric_versions rv on rv.id = e.rubric_version_id
           left join leads l on l.id = e.lead_id
          where e.trace_id = $1`,
        [traceId],
      );
      if (!execution) return undefined;
      const receipt = await tx.one<Record<string, unknown>>(
        `select decision, score, tier, rubric_version, prompt_versions, model_metadata,
                score_components, verification, governance, actions_taken, actions_skipped,
                crm_result, created_at
           from decision_receipts where trace_id = $1`,
        [traceId],
      );
      return { execution, receipt: receipt ?? null };
    });
    if (!result) return notFound();
    return ok(result);
  } catch (err) {
    return internal(err, `GET /v1/executions/${traceId}`);
  }
}
