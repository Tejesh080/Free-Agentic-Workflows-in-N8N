/**
 * POST /v1/approvals/{id}/approve
 * POST /v1/approvals/{id}/reject
 *
 * Deciding requires a signed-in human member. The row level security policy on
 * approval_requests denies a machine principal outright, so an API key cannot
 * approve the action its own run asked for.
 */
import { authenticate, requireRole } from '@/lib/auth/request';
import { withOrgContext } from '@/lib/db/client';
import { decideApproval } from '@/lib/approvals/decide';
import { executeApprovedAction } from '@/lib/approvals/execute';
import { ApprovalDecision } from '@/lib/schemas';
import { fail, internal, invalid, notFound, ok } from '@/lib/http';

const DECISIONS = { approve: 'approved', reject: 'rejected' } as const;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; decision: string }> },
): Promise<Response> {
  const { id, decision } = await ctx.params;
  const kind = DECISIONS[decision as keyof typeof DECISIONS];
  if (!kind) return notFound();

  const auth = await authenticate(req);
  if (!auth.ok) return fail(auth.status, auth.error, auth.detail);
  const roleError = requireRole(auth.principal, ['owner', 'admin', 'member']);
  if (roleError) return fail(roleError.status, roleError.error, roleError.detail);

  let body: unknown = {};
  const text = await req.text();
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      return invalid('body must be JSON');
    }
  }
  const parsed = ApprovalDecision.safeParse(body);
  if (!parsed.success) return invalid('invalid decision body', parsed.error.issues);

  try {
    const { outcome, execution } = await withOrgContext(auth.principal, async (tx) => {
      const decided = await decideApproval(tx, auth.principal, id, kind, parsed.data.note);
      // A rejection performs nothing, by construction: executeApprovedAction
      // refuses any status other than 'approved'. The two facts stay separate —
      // the decision is already committed above whether or not this succeeds.
      if (decided.kind !== 'decided' || kind !== 'approved') {
        return { outcome: decided, execution: null };
      }
      return {
        outcome: decided,
        execution: await executeApprovedAction(tx, auth.principal, id),
      };
    });

    switch (outcome.kind) {
      case 'not_found':
        return notFound();
      case 'expired':
        return fail(409, 'conflict', 'this approval request has expired');
      case 'already_decided':
        // Replaying an approval click must not produce a second authorization.
        return fail(409, 'conflict', `this request was already ${outcome.status}`);
      case 'decided':
        return ok({
          status: outcome.approval.status,
          approval_id: outcome.approval.id,
          action: outcome.approval.action,
          trace_id: outcome.approval.trace_id,
          // Reported as it actually is, never assumed. A rejection executes
          // nothing; an approval runs the action exactly once; and with no
          // outbound channel configured the action is simulated and says so
          // rather than quietly claiming to have sent something.
          action_executed: execution?.kind === 'executed',
          action_simulated: execution?.kind === 'executed' ? execution.simulated : null,
          action_result: execution?.kind === 'executed' ? execution.result : null,
        });
    }
  } catch (err) {
    return internal(err, `POST /v1/approvals/${id}/${decision}`);
  }
}
