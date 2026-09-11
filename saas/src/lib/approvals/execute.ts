/**
 * Performing the action a human authorised.
 *
 * The invariant this exists to protect is that **approval and execution are two
 * separate facts**. A human saying yes is recorded when they say it; the action
 * running is recorded when it runs; and the second can fail, be retried, or
 * never happen at all without rewriting the first.
 *
 * Exactly one attempt is permitted. `recordApprovalExecution` updates only
 * where `status = 'approved' and executed_at is null`, so a double-click, a
 * retry and a concurrent request all converge on one execution — enforced by
 * the database, not by a flag in this file.
 */
import type { Principal, Tx } from '../db/client';
import { recordApprovalExecution } from './decide';

export type ChannelResult =
  | { delivered: true; simulated: boolean; detail: Record<string, unknown> }
  | { delivered: false; reason: string };

export type ExecuteOutcome =
  | { kind: 'executed'; simulated: boolean; result: Record<string, unknown> }
  | { kind: 'already_executed' }
  | { kind: 'not_approved'; status: string }
  | { kind: 'not_found' };

/**
 * Whether a real outbound channel is configured.
 *
 * There is deliberately no default. With nothing configured the action is
 * simulated and says so; it does not quietly succeed, and it does not quietly
 * pretend to have sent anything.
 */
export function outboundChannelConfigured(): boolean {
  return Boolean(process.env.OUTREACH_CHANNEL_URL && process.env.OUTREACH_CHANNEL_TOKEN);
}

/**
 * Perform the authorised action.
 *
 * No outbound provider is implemented on purpose: sending real email or SMS
 * needs credentials that have not been configured and an explicit decision that
 * has not been made. When one exists it plugs in here, and the only thing that
 * changes is `simulated`.
 */
async function performAction(
  action: string,
  payload: Record<string, unknown>,
): Promise<ChannelResult> {
  if (!outboundChannelConfigured()) {
    return {
      delivered: true,
      simulated: true,
      detail: {
        action,
        simulated: true,
        reason:
          'no outbound channel is configured (OUTREACH_CHANNEL_URL / OUTREACH_CHANNEL_TOKEN); ' +
          'the authorised action was recorded but nothing left the building',
        payload_keys: Object.keys(payload).sort(),
      },
    };
  }
  // Intentionally unreachable until a provider is configured and authorised.
  return { delivered: false, reason: 'an outbound channel is configured but no provider is implemented' };
}

export async function executeApprovedAction(
  tx: Tx,
  principal: Principal,
  approvalId: string,
): Promise<ExecuteOutcome> {
  const approval = await tx.one<{
    id: string;
    status: string;
    action: string;
    payload: Record<string, unknown>;
    executed_at: Date | null;
    trace_id: string | null;
  }>(
    `select id, status::text as status, action::text as action, payload, executed_at, trace_id
       from approval_requests where id = $1`,
    [approvalId],
  );
  if (!approval) return { kind: 'not_found' };
  if (approval.executed_at) return { kind: 'already_executed' };
  if (approval.status !== 'approved') return { kind: 'not_approved', status: approval.status };

  // The payload is the one frozen at request time — the database refuses any
  // change to it — so what runs is what the human saw when they approved.
  const outcome = await performAction(approval.action, approval.payload);

  const result: Record<string, unknown> = outcome.delivered
    ? { ...outcome.detail, delivered: true }
    : { delivered: false, reason: outcome.reason };

  const recorded = await recordApprovalExecution(tx, approvalId, result);
  if (!recorded) {
    // Lost a race with a concurrent attempt. The other one won; this is not an
    // error, and it must not run the action again.
    return { kind: 'already_executed' };
  }

  await tx.query(
    `insert into audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, trace_id, after)
     values ($1,$2,$3,'approval.action_executed','approval_request',$4,$5,$6::jsonb)`,
    [
      principal.orgId,
      principal.kind === 'user' ? 'user' : 'system',
      principal.kind === 'user' ? principal.userId : null,
      approvalId,
      approval.trace_id,
      JSON.stringify({ action: approval.action, ...result }),
    ],
  );

  return {
    kind: 'executed',
    simulated: outcome.delivered ? outcome.simulated : false,
    result,
  };
}
