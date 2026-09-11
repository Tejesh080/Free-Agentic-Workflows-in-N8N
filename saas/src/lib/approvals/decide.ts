/**
 * The approval domain.
 *
 * Approval state lives in Postgres and nowhere else. A notification transport
 * may carry the request and collect the click, but it never holds the decision:
 * if Slack, Telegram or the mail provider is down or replaced, the authorization
 * record is unaffected, and an old transport cannot re-authorize anything.
 *
 * Three properties the database enforces alongside this code (see the
 * guard_approval_transition trigger):
 *   - only a pending request can be decided, and a decision is terminal
 *   - the payload is frozen at request time, so an approval cannot be harvested
 *     and then applied to different content
 *   - execution can be recorded at most once, and only against an approved
 *     request
 */
import type { Principal, Tx } from '../db/client';

export type DecisionKind = 'approved' | 'rejected';

export type DecideOutcome =
  | { kind: 'decided'; approval: ApprovalRow }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'already_decided'; status: string };

export interface ApprovalRow {
  id: string;
  action: string;
  status: string;
  risk_level: string;
  policy_reason: string;
  payload: Record<string, unknown>;
  lead_id: string | null;
  execution_id: string | null;
  trace_id: string | null;
  expires_at: Date;
}

export async function decideApproval(
  tx: Tx,
  principal: Principal,
  approvalId: string,
  decision: DecisionKind,
  note: string | undefined,
): Promise<DecideOutcome> {
  // `for update` so two clicks on the same request serialise rather than both
  // reading 'pending' and both proceeding.
  const current = await tx.one<ApprovalRow>(
    `select id, action, status, risk_level, policy_reason, payload, lead_id, execution_id, trace_id, expires_at
       from approval_requests where id = $1 for update`,
    [approvalId],
  );
  if (!current) return { kind: 'not_found' };

  if (current.status !== 'pending') {
    return { kind: 'already_decided', status: current.status };
  }

  // Expiry is evaluated on read, not by a background job: an approval that has
  // aged out must not become usable just because nothing swept it yet.
  if (new Date(current.expires_at).getTime() <= Date.now()) {
    await tx.query(`update approval_requests set status = 'expired' where id = $1`, [approvalId]);
    await writeAudit(tx, principal, current, 'approval.expired', { reason: 'expired on read' });
    return { kind: 'expired' };
  }

  const updated = await tx.one<ApprovalRow>(
    `update approval_requests
        set status = $2::approval_status, decided_by = $3, decision_note = $4, decided_at = now()
      where id = $1 and status = 'pending'
      returning id, action, status, risk_level, policy_reason, payload, lead_id, execution_id, trace_id, expires_at`,
    [
      approvalId,
      decision,
      principal.kind === 'user' ? principal.userId : null,
      note ?? null,
    ],
  );
  // The policy forbids a machine principal from updating an approval, so a
  // no-row result here means an API key tried to approve its own request.
  if (!updated) return { kind: 'not_found' };

  await writeAudit(tx, principal, updated, `approval.${decision}`, { note: note ?? null });

  return { kind: 'decided', approval: updated };
}

/**
 * Record that the authorized action ran. Separate from the decision on purpose:
 * "a human said yes" and "the thing happened" are different facts, and an
 * irreversible external action needs to point at the authorization that
 * permitted it.
 */
export async function recordApprovalExecution(
  tx: Tx,
  approvalId: string,
  result: Record<string, unknown>,
): Promise<boolean> {
  const row = await tx.one<{ id: string }>(
    `update approval_requests
        set executed_at = now(), execution_result = $2::jsonb
      where id = $1 and status = 'approved' and executed_at is null
      returning id`,
    [approvalId, JSON.stringify(result)],
  );
  return Boolean(row);
}

async function writeAudit(
  tx: Tx,
  principal: Principal,
  approval: ApprovalRow,
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `insert into audit_events (org_id, actor_type, actor_user_id, actor_api_key_id, action, target_type, target_id, trace_id, after)
     values ($1,$2,$3,$4,$5,'approval_request',$6,$7,$8::jsonb)`,
    [
      principal.orgId,
      principal.kind === 'api_key' ? 'api_key' : principal.kind === 'user' ? 'user' : 'system',
      principal.kind === 'user' ? principal.userId : null,
      principal.kind === 'api_key' ? principal.apiKeyId : null,
      action,
      approval.id,
      approval.trace_id,
      JSON.stringify({ action: approval.action, risk_level: approval.risk_level, ...after }),
    ],
  );
}
